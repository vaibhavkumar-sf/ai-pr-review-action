import { AIProvider } from '../providers/ai-provider';
import { Finding } from '../types';
import { completeTruncatedJson, extractJsonObject, sanitizeJsonText } from '../utils/json';
import { loadPrompt } from '../prompts/loader';
import { coerceCategory, coerceFinding } from '../config/taxonomy';
import {
  CONSOLIDATION_MAX_TOKENS,
  CONSOLIDATION_SKIP_THRESHOLD,
  CONSOLIDATION_TEMPERATURE,
  OUTPUT_TOKENS_CEILING,
} from '../config/limits';
import * as core from '@actions/core';

/**
 * Uses an AI call to semantically consolidate findings from all agents,
 * catching duplicates that programmatic string matching misses.
 * Falls back to the original findings if the AI call fails.
 *
 * `configuredMaxTokens` mirrors the max_tokens input: 0 = auto (the model's
 * full capacity — a truncated consolidation JSON would lose EVERY finding),
 * positive = manual cap floored at CONSOLIDATION_MAX_TOKENS.
 */
export async function consolidateFindings(
  findings: Finding[],
  provider: AIProvider,
  timeout: number,
  configuredMaxTokens = 0,
): Promise<Finding[]> {
  // Skip consolidation if too few findings to have duplicates
  if (findings.length <= CONSOLIDATION_SKIP_THRESHOLD) {
    core.debug(`Skipping consolidation: ${CONSOLIDATION_SKIP_THRESHOLD} or fewer findings`);
    return findings;
  }

  const userPrompt = buildUserPrompt(findings);

  try {
    core.info(`Running consolidation agent on ${findings.length} findings...`);
    const response = await provider.chat(
      [
        { role: 'system' as const, content: loadPrompt('system/consolidation') },
        { role: 'user' as const, content: userPrompt },
      ],
      {
        maxTokens: configuredMaxTokens > 0
          ? Math.max(configuredMaxTokens, CONSOLIDATION_MAX_TOKENS)
          : OUTPUT_TOKENS_CEILING,
        maxTokensAuto: configuredMaxTokens === 0,
        temperature: CONSOLIDATION_TEMPERATURE,
        timeout,
      },
    );

    const consolidated = parseResponse(response.content, findings);
    const removed = findings.length - consolidated.length;
    if (removed > 0) {
      core.info(`Consolidation agent merged ${removed} duplicate finding(s): ${findings.length} → ${consolidated.length}`);
    } else {
      core.info('Consolidation agent found no duplicates to merge');
    }
    return consolidated;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    core.warning(`Consolidation agent failed, using pre-consolidated findings: ${msg}`);
    return findings;
  }
}

function buildUserPrompt(findings: Finding[]): string {
  let prompt = `## Findings to consolidate (${findings.length} total)\n\n`;
  prompt += `Review each finding and merge any that describe the SAME issue at the SAME location.\n\n`;
  prompt += '```json\n';
  prompt += JSON.stringify(
    findings.map((f, i) => ({
      index: i,
      severity: f.severity,
      category: f.category,
      file: f.file,
      line: f.line,
      endLine: f.endLine,
      title: f.title,
      description: f.description,
      suggestion: f.suggestion || null,
      codeSuggestion: f.codeSuggestion || null,
    })),
    null,
    2,
  );
  prompt += '\n```\n';
  return prompt;
}

function parseResponse(content: string, originalFindings: Finding[]): Finding[] {
  try {
    const jsonStr = extractJsonObject(content) ?? completeTruncatedJson(content);
    if (!jsonStr) {
      throw new Error('No JSON object found in consolidation response');
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Same healing as agent parsing: control chars / bad escapes / commas.
      parsed = JSON.parse(sanitizeJsonText(jsonStr));
    }
    const consolidated = parsed.consolidated;

    if (!Array.isArray(consolidated) || consolidated.length === 0) {
      throw new Error('Empty or invalid consolidated array');
    }

    // Log merge decisions if available
    if (Array.isArray(parsed.mergeLog)) {
      for (const entry of parsed.mergeLog) {
        core.debug(`Consolidation: ${entry}`);
      }
    }

    // Map back to validated Finding objects
    return consolidated.map(
      (f: Record<string, unknown>) => coerceFinding(f, raw => coerceCategory(raw)),
    );
  } catch (error) {
    core.warning(
      `Failed to parse consolidation response: ${error instanceof Error ? error.message : String(error)}`,
    );
    return originalFindings;
  }
}
