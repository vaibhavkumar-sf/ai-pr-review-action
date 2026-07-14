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
 * Dual fidelity, ONE AI call: the model returns a STYLED variant (theme
 * directive, classDef colors, emojis) and a SIMPLE plain variant of each
 * diagram together. Each variant is validated with the same mermaid.js parser
 * GitHub uses (Kroki as fallback); the styled one is posted when it parses,
 * the simple twin is the fallback, and only when BOTH variants of a diagram
 * are broken is the single fix retry spent. Diagrams are cosmetic: any
 * failure is non-fatal.
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

/** Styled + simple twins of one diagram, as returned by the model. */
interface DiagramVariants {
  styled: string | null;
  simple: string | null;
}

interface DiagramVariantsResponse {
  flowchart: DiagramVariants;
  sequence: DiagramVariants;
}

/** Outcome of picking the best valid variant of one diagram. */
interface PickedDiagram {
  code: string | null;
  // Per-variant validation errors, present only when NO variant validated —
  // exactly what the fix prompt needs.
  errors: Array<{ variant: 'styled' | 'simple'; error: string; code: string }>;
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

  core.info('Generating Mermaid diagrams (styled + simple fallback)...');
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

    const variants = parseDiagramResponse(response.content);
    const flowchart = await pickBestVariant('flowchart', variants.flowchart);
    const sequence = await pickBestVariant('sequence', variants.sequence);

    if (flowchart.errors.length === 0 && sequence.errors.length === 0) {
      if (attempt > 0) {
        core.info(`Mermaid diagrams fixed after ${attempt} retry(s)`);
      }
      return { flowchart: flowchart.code, sequence: sequence.code };
    }

    // If last attempt, return whatever validated (broken kinds are dropped).
    if (attempt === maxRetries) {
      core.warning(`Mermaid validation failed after ${maxRetries + 1} attempts`);
      return { flowchart: flowchart.code, sequence: sequence.code };
    }

    // Only the kinds where BOTH variants failed reach the fix retry.
    let errorSections = '';
    for (const [kind, picked] of [['Flowchart', flowchart], ['Sequence', sequence]] as const) {
      for (const failure of picked.errors) {
        errorSections += `**${kind} (${failure.variant}) error:**\n\`\`\`\n${failure.error}\n\`\`\`\n\nBroken code:\n\`\`\`mermaid\n${failure.code}\n\`\`\`\n\n`;
      }
    }
    // The template file ends with a newline (loadPrompt strips only one of two),
    // matching the original fix-prompt string exactly.
    const fixPrompt = loadPrompt('system/mermaid-fix', { error_sections: errorSections });

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: fixPrompt });

    core.info(`Mermaid validation failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying`);
  }

  return { flowchart: null, sequence: null };
}

/**
 * Sanitizes and validates the styled variant first, falling back to the simple
 * twin — errors are only surfaced when neither variant parses (that kind then
 * goes to the fix retry).
 */
async function pickBestVariant(kind: string, variants: DiagramVariants): Promise<PickedDiagram> {
  const errors: PickedDiagram['errors'] = [];

  for (const variant of ['styled', 'simple'] as const) {
    const raw = variants[variant];
    if (!raw) continue;
    const code = sanitizeMermaidCode(raw);
    const error = await validateMermaid(code);
    if (!error) {
      if (variant === 'simple' && variants.styled) {
        core.info(`${kind}: styled variant failed validation — using the simple fallback`);
      } else if (variant === 'styled') {
        core.info(`${kind}: styled variant validated`);
      }
      return { code, errors: [] };
    }
    errors.push({ variant, error, code });
    core.debug(`${kind} ${variant} variant invalid: ${error.substring(0, 200)}`);
  }

  // No variant provided at all is a legitimate "not applicable" (e.g. sequence
  // set to null), not a failure.
  return { code: null, errors };
}

function parseDiagramResponse(content: string): DiagramVariantsResponse {
  const empty: DiagramVariantsResponse = {
    flowchart: { styled: null, simple: null },
    sequence: { styled: null, simple: null },
  };

  try {
    const jsonStr = extractJsonObject(content);
    if (!jsonStr) {
      throw new Error('No JSON object found');
    }

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

    return {
      flowchart: {
        styled: str(parsed.flowchart_styled),
        // Legacy single-variant key counts as the simple fallback.
        simple: str(parsed.flowchart_simple) ?? str(parsed.flowchart),
      },
      sequence: {
        styled: str(parsed.sequence_styled),
        simple: str(parsed.sequence_simple) ?? str(parsed.sequence),
      },
    };
  } catch (err) {
    core.warning(`Failed to parse diagram response: ${err instanceof Error ? err.message : String(err)}`);
    return empty;
  }
}
