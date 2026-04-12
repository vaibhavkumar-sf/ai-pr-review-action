import { AIProvider } from '../providers/ai-provider';
import { Finding } from '../types';
import * as core from '@actions/core';

const CONSOLIDATION_SYSTEM_PROMPT = `You are a code review consolidation agent. Your job is to take a list of findings from multiple specialist review agents and consolidate them into a clean, non-redundant list.

## Rules

1. **Identify duplicates**: Two findings about the SAME issue at the SAME location (same file, within 3 lines) are duplicates — even if worded differently by different agents.
   - Example: "Missing JSDoc comment" (type-safety agent) and "Function lacks documentation" (code-quality agent) on the same function → merge into ONE finding.
   - Example: "Missing input validation" (security agent) and "No parameter type check" (code-quality agent) on the same line → merge into ONE finding.

2. **Merge duplicates**:
   - Keep the **highest severity** among the duplicates
   - Use the **most descriptive title** (prefer specific over generic)
   - **Combine descriptions** — include unique insights from each agent, separated by paragraphs. Do NOT repeat the same point.
   - Keep the **best suggestion** and **best code suggestion** (prefer the most actionable one)
   - Use the **most specific category** for the issue (e.g., "security" over "code-quality" for a validation issue)

3. **DO NOT remove findings that are genuinely different issues**, even if on the same line. A line can have both a security issue AND a performance issue — those are separate.

4. **DO NOT modify findings that have no duplicates** — pass them through unchanged.

5. **DO NOT change line numbers, file paths, or invent new issues.**

## Output Format

Return a JSON object:
\`\`\`json
{
  "consolidated": [
    {
      "severity": "high",
      "category": "security",
      "file": "src/example.ts",
      "line": 42,
      "endLine": 45,
      "title": "Consolidated title here",
      "description": "Combined description here",
      "suggestion": "Best suggestion here",
      "codeSuggestion": "best code fix here"
    }
  ],
  "mergeLog": [
    "Merged findings #2 and #5: both flag missing JSDoc on processData()",
    "Merged findings #1, #3, #7: all flag missing validation on line 26"
  ]
}
\`\`\`

The \`mergeLog\` is for debugging — briefly note which findings were merged and why.
Only output JSON. No other text.`;

/**
 * Uses an AI call to semantically consolidate findings from all agents,
 * catching duplicates that programmatic string matching misses.
 * Falls back to the original findings if the AI call fails.
 */
export async function consolidateFindings(
  findings: Finding[],
  provider: AIProvider,
  timeout: number,
): Promise<Finding[]> {
  // Skip consolidation if too few findings to have duplicates
  if (findings.length <= 3) {
    core.debug('Skipping consolidation: 3 or fewer findings');
    return findings;
  }

  const userPrompt = buildUserPrompt(findings);

  try {
    core.info(`Running consolidation agent on ${findings.length} findings...`);
    const response = await provider.chat(
      [
        { role: 'system' as const, content: CONSOLIDATION_SYSTEM_PROMPT },
        { role: 'user' as const, content: userPrompt },
      ],
      { maxTokens: 8192, temperature: 0.1, timeout },
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
    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, content];
    const jsonStr = jsonMatch[1] || content;

    const startIdx = jsonStr.indexOf('{');
    const endIdx = jsonStr.lastIndexOf('}');
    if (startIdx === -1 || endIdx === -1) {
      throw new Error('No JSON object found in consolidation response');
    }

    const parsed = JSON.parse(jsonStr.substring(startIdx, endIdx + 1));
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

    // Map back to Finding objects, validating each
    return consolidated.map((f: Record<string, unknown>): Finding => ({
      severity: validateSeverity(f.severity as string) || 'medium',
      category: (f.category as Finding['category']) || 'code-quality',
      file: (f.file as string) || '',
      line: (f.line as number) || 0,
      endLine: f.endLine as number | undefined,
      title: (f.title as string) || 'Untitled finding',
      description: (f.description as string) || '',
      suggestion: f.suggestion as string | undefined,
      codeSuggestion: (f.codeSuggestion || f.code_suggestion) as string | undefined,
    }));
  } catch (error) {
    core.warning(
      `Failed to parse consolidation response: ${error instanceof Error ? error.message : String(error)}`,
    );
    return originalFindings;
  }
}

function validateSeverity(severity: string): Finding['severity'] | null {
  const valid = ['critical', 'high', 'medium', 'low', 'nit'];
  return valid.includes(severity) ? (severity as Finding['severity']) : null;
}
