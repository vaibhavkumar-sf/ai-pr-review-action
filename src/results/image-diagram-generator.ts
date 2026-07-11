import { AIProvider } from '../providers/ai-provider';
import { ReviewContext, MergedReviewResult } from '../types';
import { extractJsonObject } from '../utils/json';
import { sanitizeMermaidCode, validateMermaid } from '../utils/mermaid';
import { loadPrompt } from '../prompts/loader';
import {
  COSMETIC_CALL_TIMEOUT_MS,
  COSMETIC_TEMPERATURE,
  DIAGRAM_DIFF_CHARS,
  DIAGRAM_MAX_RETRIES,
  DIAGRAM_MAX_TOKENS,
} from '../config/limits';
import * as core from '@actions/core';

/**
 * Generates Mermaid diagrams (flowchart + sequence) via AI and returns
 * them as native ```mermaid code blocks for GitHub's server-side rendering.
 *
 * Validates diagrams locally using the same mermaid.js parser that GitHub uses,
 * with Kroki.io as a fallback validator. Diagrams are cosmetic: the simple,
 * reliable prompt with a single retry is used (rich %%{init}%% theming is
 * exactly what GitHub's parser rejects), and any failure is non-fatal.
 */
export async function generateDiagramImages(
  context: ReviewContext,
  _merged: MergedReviewResult,
  provider: AIProvider,
): Promise<string> {
  const parts: string[] = [];

  try {
    const diagrams = await generateMermaidDiagrams(context, provider);

    if (diagrams.flowchart) {
      parts.push('### Flow Diagram');
      parts.push('');
      parts.push('```mermaid');
      parts.push(diagrams.flowchart);
      parts.push('```');
      parts.push('');
    }

    if (diagrams.sequence) {
      parts.push('### Sequence Diagram');
      parts.push('');
      parts.push('```mermaid');
      parts.push(diagrams.sequence);
      parts.push('```');
      parts.push('');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Failed to generate diagrams: ${msg}`);
  }

  return parts.join('\n');
}

interface MermaidDiagrams {
  flowchart: string | null;
  sequence: string | null;
}

async function generateMermaidDiagrams(
  context: ReviewContext,
  provider: AIProvider,
): Promise<MermaidDiagrams> {
  let userPrompt = `Generate beautiful Mermaid diagrams for this PR:\n\n`;
  userPrompt += `**Title:** ${context.prTitle}\n`;
  userPrompt += `**Branch:** ${context.headBranch} → ${context.baseBranch}\n`;
  userPrompt += `**Framework:** ${context.framework}\n`;
  userPrompt += `**Files changed:** ${context.changedFiles.map(f => `${f.filename} (${f.status})`).join(', ')}\n\n`;
  userPrompt += `**Diff:**\n\`\`\`diff\n${context.diff.substring(0, DIAGRAM_DIFF_CHARS)}\n\`\`\`\n`;

  core.info('Generating Mermaid diagrams...');
  return tryGenerateDiagrams(loadPrompt('system/mermaid-diagrams'), userPrompt, provider, DIAGRAM_MAX_RETRIES);
}

async function tryGenerateDiagrams(
  systemPrompt: string,
  userPrompt: string,
  provider: AIProvider,
  maxRetries: number,
): Promise<MermaidDiagrams> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await provider.chat(
      messages,
      // Cosmetic diagram generation — no extended thinking (faster; each retry
      // was a full ~40s thinking call). Bounded timeout so diagrams never
      // dominate the run.
      {
        maxTokens: DIAGRAM_MAX_TOKENS,
        temperature: COSMETIC_TEMPERATURE,
        timeout: COSMETIC_CALL_TIMEOUT_MS,
        thinkingBudget: 0,
      },
    );

    const diagrams = parseDiagramResponse(response.content);

    // Sanitize before validation
    if (diagrams.flowchart) diagrams.flowchart = sanitizeMermaidCode(diagrams.flowchart);
    if (diagrams.sequence) diagrams.sequence = sanitizeMermaidCode(diagrams.sequence);

    // Validate using local mermaid.parse() (same parser as GitHub v11.4.1)
    const flowchartError = diagrams.flowchart ? await validateMermaid(diagrams.flowchart) : null;
    const sequenceError = diagrams.sequence ? await validateMermaid(diagrams.sequence) : null;

    if (!flowchartError && !sequenceError) {
      if (attempt > 0) {
        core.info(`Mermaid diagrams fixed after ${attempt} retry(s)`);
      }
      return diagrams;
    }

    // If last attempt, return what we have (strip broken ones)
    if (attempt === maxRetries) {
      core.warning(`Mermaid validation failed after ${maxRetries + 1} attempts`);
      return {
        flowchart: flowchartError ? null : diagrams.flowchart,
        sequence: sequenceError ? null : diagrams.sequence,
      };
    }

    // Build fix request with error details
    let errorSections = '';
    if (flowchartError) {
      errorSections += `**Flowchart error:**\n\`\`\`\n${flowchartError}\n\`\`\`\n\nBroken code:\n\`\`\`mermaid\n${diagrams.flowchart}\n\`\`\`\n\n`;
    }
    if (sequenceError) {
      errorSections += `**Sequence error:**\n\`\`\`\n${sequenceError}\n\`\`\`\n\nBroken code:\n\`\`\`mermaid\n${diagrams.sequence}\n\`\`\`\n\n`;
    }
    // The template file ends with a newline (loadPrompt strips only one of two),
    // matching the original fix-prompt string exactly.
    const fixPrompt = loadPrompt('system/mermaid-fix', { error_sections: errorSections });

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: fixPrompt });

    core.info(`Mermaid validation failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying: ${(flowchartError || '').substring(0, 100)} ${(sequenceError || '').substring(0, 100)}`);
  }

  return { flowchart: null, sequence: null };
}

function parseDiagramResponse(content: string): MermaidDiagrams {
  try {
    const jsonStr = extractJsonObject(content);
    if (!jsonStr) {
      throw new Error('No JSON object found');
    }

    const parsed = JSON.parse(jsonStr);

    return {
      flowchart: typeof parsed.flowchart === 'string' ? parsed.flowchart : null,
      sequence: typeof parsed.sequence === 'string' ? parsed.sequence : null,
    };
  } catch (err) {
    core.warning(`Failed to parse diagram response: ${err instanceof Error ? err.message : String(err)}`);
    return { flowchart: null, sequence: null };
  }
}
