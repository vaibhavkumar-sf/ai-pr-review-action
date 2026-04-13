import { AIProvider } from '../providers/ai-provider';
import { ReviewContext, MergedReviewResult } from '../types';
import * as core from '@actions/core';

/**
 * Generates Mermaid diagrams (flowchart + sequence) via AI and returns
 * them as native ```mermaid code blocks for GitHub's server-side rendering.
 *
 * Validates diagrams locally using the same mermaid.js parser that GitHub uses,
 * with Kroki.io as a fallback validator.
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

/**
 * Converts a Mermaid code block to a mermaid.ink rendered PNG image URL.
 * Used as a fallback for contexts where native rendering isn't available.
 */
export function mermaidToImageUrl(mermaidCode: string): string {
  const encoded = Buffer.from(mermaidCode, 'utf-8').toString('base64');
  return `https://mermaid.ink/img/${encoded}`;
}

interface MermaidDiagrams {
  flowchart: string | null;
  sequence: string | null;
}

const MERMAID_SYSTEM_PROMPT = `You are a diagram designer. Generate clean Mermaid diagrams that render on GitHub.

You MUST output EXACTLY this JSON format:
\`\`\`json
{
  "flowchart": "mermaid code here",
  "sequence": "mermaid code here or null"
}
\`\`\`

## FLOWCHART EXAMPLE — Copy this pattern:

\`\`\`mermaid
flowchart TD
    A["PR Opened"] --> B{"Bot Check"}
    B -->|"Skip"| C["End"]
    B -->|"Valid"| D["Load Context"]
    D --> E["Fetch JIRA"]
    D --> F["Read Files"]
    E --> G["Run Agents"]
    F --> G

    subgraph agents ["AI Review Agents"]
        direction LR
        G1["Security"]
        G2["Code Quality"]
        G3["Performance"]
    end

    G --> agents
    agents --> H["Consolidate"]
    H --> I["Post Comments"]
\`\`\`

## SEQUENCE DIAGRAM EXAMPLE — Copy this pattern:

\`\`\`mermaid
sequenceDiagram
    participant Dev as Developer
    participant GH as GitHub
    participant AI as AI Action
    participant LLM as Anthropic API

    Dev->>GH: Open Pull Request
    activate GH
    GH->>AI: Trigger workflow
    activate AI
    AI->>GH: Fetch PR diff
    GH-->>AI: Return context

    par Parallel Context
        AI->>GH: Read CLAUDE.md
        GH-->>AI: Return rules
    and
        AI->>LLM: Send code for review
        LLM-->>AI: Return findings
    end

    AI->>GH: Post inline comments
    AI->>GH: Update PR description
    deactivate AI
    deactivate GH
\`\`\`

## CRITICAL RULES — GitHub will BREAK if you violate these:

1. **NO %%{init}%% theming** — GitHub ignores most of it and it often causes parse errors. Do NOT include any theme configuration.
2. **NO emojis in node labels** — Use plain text only: \`A["Load Context"]\` not \`A["📥 Load Context"]\`
3. **Quote ALL labels** with double quotes: \`A["My Label"]\`, \`B{"Decision?"}\`
4. **Edge labels use pipe syntax**: \`-->|"Yes"|\` — NEVER use commas
5. **Node IDs are single letters or short words**: A, B, C, D or act1, svc1
6. **NO colons in labels** — Use dashes instead: \`A["Step - Details"]\` not \`A["Step: Details"]\`
7. **NO special characters** in labels: no \`:\`, \`::\`, \`<\`, \`>\`, \`&\`, \`|\`
8. **par/and blocks ONLY in sequenceDiagram** — NEVER use \`par\` in flowcharts
9. **Keep labels under 30 characters**
10. **NO style directives** — Keep it simple, no \`style\` or \`classDef\`
11. **subgraph labels must be quoted**: \`subgraph name ["Label"]\`

## Rules for different PR types:
- **Angular PRs**: Show components, services, modules, routing
- **LoopBack4 PRs**: Show controllers, services, repositories, models
- **Workflow/Config PRs**: Show CI/CD pipeline, triggers, steps
- **API PRs**: Show request flow, validation, service layer, response

Make diagrams SPECIFIC to THIS PR — not generic.
Output ONLY valid JSON. If sequence diagram doesn't apply, set "sequence" to null.`;

async function generateMermaidDiagrams(
  context: ReviewContext,
  provider: AIProvider,
): Promise<MermaidDiagrams> {
  let userPrompt = `Generate clean Mermaid diagrams for this PR:\n\n`;
  userPrompt += `**Title:** ${context.prTitle}\n`;
  userPrompt += `**Branch:** ${context.headBranch} → ${context.baseBranch}\n`;
  userPrompt += `**Framework:** ${context.framework}\n`;
  userPrompt += `**Files changed:** ${context.changedFiles.map(f => `${f.filename} (${f.status})`).join(', ')}\n\n`;
  userPrompt += `**Diff:**\n\`\`\`diff\n${context.diff.substring(0, 4000)}\n\`\`\`\n`;

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: MERMAID_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await provider.chat(
      messages,
      { maxTokens: 4096, temperature: 0.3, timeout: 300000 },
    );

    const diagrams = parseDiagramResponse(response.content);

    // Sanitize before validation
    if (diagrams.flowchart) diagrams.flowchart = sanitizeMermaidCode(diagrams.flowchart);
    if (diagrams.sequence) diagrams.sequence = sanitizeMermaidCode(diagrams.sequence);

    // Validate using local mermaid.parse() (same parser as GitHub)
    const flowchartError = diagrams.flowchart ? await validateMermaid(diagrams.flowchart) : null;
    const sequenceError = diagrams.sequence ? await validateMermaid(diagrams.sequence) : null;

    if (!flowchartError && !sequenceError) {
      if (attempt > 0) {
        core.info(`Mermaid diagrams fixed after ${attempt} retry(s)`);
      }
      return diagrams;
    }

    // If last attempt, return what we have (strip broken ones)
    if (attempt === MAX_RETRIES) {
      core.warning(`Mermaid validation failed after ${MAX_RETRIES} retries, stripping broken diagrams`);
      return {
        flowchart: flowchartError ? null : diagrams.flowchart,
        sequence: sequenceError ? null : diagrams.sequence,
      };
    }

    // Build fix request with error details
    let fixPrompt = `The Mermaid diagrams you generated have syntax errors. Fix them and return valid JSON again.\n\n`;
    if (flowchartError) {
      fixPrompt += `**Flowchart error:**\n\`\`\`\n${flowchartError}\n\`\`\`\n\nBroken flowchart code:\n\`\`\`mermaid\n${diagrams.flowchart}\n\`\`\`\n\n`;
    }
    if (sequenceError) {
      fixPrompt += `**Sequence diagram error:**\n\`\`\`\n${sequenceError}\n\`\`\`\n\nBroken sequence code:\n\`\`\`mermaid\n${diagrams.sequence}\n\`\`\`\n\n`;
    }
    fixPrompt += `Fix the syntax errors. Common fixes:\n`;
    fixPrompt += `- Remove ALL %%{init}%% theme lines\n`;
    fixPrompt += `- Remove emojis from labels\n`;
    fixPrompt += `- Quote ALL labels: A["Label"] not A[Label]\n`;
    fixPrompt += `- Edge labels: -->|"label"| not -->|"label",\n`;
    fixPrompt += `- Do NOT use par/and blocks in flowcharts — only in sequenceDiagram\n`;
    fixPrompt += `- No colons in labels — use dashes\n`;

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: fixPrompt });

    core.info(`Mermaid validation failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), asking AI to fix: ${flowchartError || ''} ${sequenceError || ''}`);
  }

  return { flowchart: null, sequence: null };
}

/**
 * Sanitizes Mermaid code by fixing common AI-generated syntax issues.
 */
function sanitizeMermaidCode(code: string): string {
  const lines = code.split('\n');
  const fixedLines = lines.map(line => {
    // Remove HTML tags
    line = line.replace(/<[^>]+>/g, ' ');

    // Fix double colons in labels
    line = line.replace(/::/g, ' - ');

    // Fix edge labels: -->, "Yes", → -->|"Yes"|
    line = line.replace(/-->\s*,\s*"([^"]*)"\s*[,|]?\s*/g, '-->|"$1"| ');

    // Fix edge labels: -->|"Yes", → -->|"Yes"|
    line = line.replace(/-->\|"([^"]*)"\s*,/g, '-->|"$1"|');

    // Fix unquoted edge labels with comma: -->|Yes, → -->|"Yes"|
    line = line.replace(/-->\|([^"|,\]]+)\s*,/g, '-->|"$1"|');

    // Fix unquoted edge labels: -->|Yes| → -->|"Yes"|
    line = line.replace(/-->\|([^"|]+)\|/g, '-->|"$1"|');

    // Remove pipe chars inside quoted labels
    line = line.replace(/"([^"]*)\|([^"]*)"/g, (_, a, b) => `"${a}, ${b}"`);

    return line;
  });

  return fixedLines.join('\n');
}

/**
 * Validates Mermaid syntax using the local mermaid.js parser (same as GitHub).
 * Falls back to Kroki.io if local validation is unavailable.
 * Returns null if valid, or the error message string if invalid.
 */
export async function validateMermaid(mermaidCode: string): Promise<string | null> {
  // Try local validation first (same parser as GitHub)
  const localResult = await validateMermaidLocally(mermaidCode);
  if (localResult !== undefined) {
    return localResult; // null = valid, string = error
  }

  // Fall back to Kroki if local validation unavailable
  return validateMermaidViaKroki(mermaidCode);
}

/**
 * Validates Mermaid syntax using the local mermaid.js parser.
 * Returns null if valid, error string if invalid, undefined if parser unavailable.
 */
async function validateMermaidLocally(mermaidCode: string): Promise<string | null | undefined> {
  try {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    (globalThis as Record<string, unknown>).window = dom.window;
    (globalThis as Record<string, unknown>).document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      writable: true,
      configurable: true,
    });
    (globalThis as Record<string, unknown>).DOMParser = dom.window.DOMParser;

    const DOMPurifyModule = await import('dompurify');
    const DOMPurify = (DOMPurifyModule.default as (window: unknown) => unknown)(dom.window);
    (globalThis as Record<string, unknown>).DOMPurify = DOMPurify;

    const mermaidModule = await import('mermaid');
    const mermaid = mermaidModule.default;

    await mermaid.parse(mermaidCode);
    return null; // Valid
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // If it's a module loading error, local validation is unavailable
    if (msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')) {
      core.debug('Local mermaid validation unavailable, falling back to Kroki');
      return undefined;
    }

    // Parse error — diagram is invalid
    return msg.substring(0, 500);
  }
}

/**
 * Validates Mermaid syntax by sending it to Kroki.io's Mermaid renderer.
 * Returns null if valid, or the error message string if invalid.
 * When Kroki is unreachable, returns an error (does NOT silently pass).
 */
export async function validateMermaidViaKroki(mermaidCode: string): Promise<string | null> {
  try {
    const response = await fetch('https://kroki.io/mermaid/svg', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: mermaidCode,
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      return null; // Valid!
    }

    const errorBody = await response.text();
    const plainError = errorBody
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 500);
    return plainError || `Kroki validation failed with HTTP ${response.status}`;
  } catch (err) {
    // Kroki unreachable — return error instead of silently passing
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Kroki validation unavailable: ${msg}`);
    return `Kroki unreachable: ${msg}`;
  }
}

function parseDiagramResponse(content: string): MermaidDiagrams {
  try {
    const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, content];
    const jsonStr = jsonMatch[1] || content;

    const startIdx = jsonStr.indexOf('{');
    const endIdx = jsonStr.lastIndexOf('}');
    if (startIdx === -1 || endIdx === -1) {
      throw new Error('No JSON object found');
    }

    const parsed = JSON.parse(jsonStr.substring(startIdx, endIdx + 1));

    return {
      flowchart: typeof parsed.flowchart === 'string' ? parsed.flowchart : null,
      sequence: typeof parsed.sequence === 'string' ? parsed.sequence : null,
    };
  } catch (err) {
    core.warning(`Failed to parse diagram response: ${err instanceof Error ? err.message : String(err)}`);
    return { flowchart: null, sequence: null };
  }
}
