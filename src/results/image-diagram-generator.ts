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

/**
 * Modern prompt — rich styled diagrams with %%{init}%% theming, style directives,
 * subgraph backgrounds, and Material Design colors. GitHub supports these features
 * (Mermaid 11.4.1). NO emojis, NO HTML, NO colons in labels.
 */
const MODERN_PROMPT = `You are a world-class diagram designer. Generate BEAUTIFUL, production-quality Mermaid diagrams for GitHub.

GitHub uses Mermaid v11.4.1. Use ONLY features supported in this version.

You MUST output EXACTLY this JSON format:
\`\`\`json
{
  "flowchart": "mermaid code here",
  "sequence": "mermaid code here or null"
}
\`\`\`

## FLOWCHART — Use rich styling with theme config and style directives:

\`\`\`mermaid
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#e3f2fd', 'primaryTextColor': '#0d47a1', 'primaryBorderColor': '#1565c0', 'lineColor': '#1565c0', 'secondaryColor': '#f3e5f5', 'tertiaryColor': '#e8f5e9'}}}%%
flowchart TD
    A["PR Opened"] --> B{"Bot Check"}
    B -->|"Skip"| C["End"]
    B -->|"Valid"| D["Load Context"]
    D --> E["Fetch JIRA"]
    D --> F["Read Files"]
    E & F --> G["Run Agents"]

    subgraph agents ["AI Review Agents"]
        direction LR
        G1["Security"]
        G2["Code Quality"]
        G3["Performance"]
        G4["Type Safety"]
        G5["Architecture"]
    end

    G --> agents
    agents --> H["Consolidate"]
    H --> I["Post Comments"]
    H --> J["Update Description"]

    style agents fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#4a148c
    style A fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style B fill:#fff3e0,stroke:#e65100,stroke-width:2px
    style C fill:#fce4ec,stroke:#c62828,stroke-width:2px
    style H fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
\`\`\`

## SEQUENCE DIAGRAM — Use rich styling with theme config:

\`\`\`mermaid
%%{init: {'theme': 'base', 'themeVariables': {'actorBkg': '#e3f2fd', 'actorBorder': '#1565c0', 'actorTextColor': '#0d47a1', 'signalColor': '#1565c0', 'signalTextColor': '#333', 'noteBkgColor': '#fff3e0', 'noteBorderColor': '#e65100'}}}%%
sequenceDiagram
    actor Dev as Developer
    participant GH as GitHub
    participant AI as AI Action
    participant LLM as Anthropic API
    participant JIRA as JIRA

    Dev->>GH: Open Pull Request
    activate GH
    GH->>AI: Trigger workflow
    activate AI
    AI->>GH: Fetch PR diff and files
    GH-->>AI: Return code context

    par Parallel Context
        AI->>JIRA: Fetch ticket details
        JIRA-->>AI: Return context
    and
        AI->>GH: Read CLAUDE.md
        GH-->>AI: Return repo rules
    end

    AI->>LLM: Send code and rules
    activate LLM
    Note over LLM: Extended thinking enabled
    LLM-->>AI: Return findings
    deactivate LLM

    AI->>AI: Consolidate and deduplicate
    AI->>GH: Post inline comments
    AI->>GH: Update PR description
    deactivate AI
    deactivate GH
\`\`\`

## CRITICAL SYNTAX RULES (Mermaid v11.4.1 for GitHub):

1. **Theme config on first line** — use %%{init}%% with Material Design hex colors
2. **NO emojis in labels** — Plain text only. Never use emoji characters.
3. **NO HTML tags** — no <br/>, <b>, etc.
4. **NO colons in labels** — Use dashes: A["Step - Details"] not A["Step: Details"]
5. **Quote ALL labels** with double quotes: A["Label"], B{"Decision?"}
6. **Edge labels use pipe syntax**: -->|"label"| — NEVER use commas
7. **Node IDs are single letters or short words**: A, B, C, D
8. **par/and blocks ONLY in sequenceDiagram** — NEVER in flowcharts
9. **Use style directives** for custom colors: style nodeId fill:#color,stroke:#color,stroke-width:2px
10. **Use subgraph** to group related components with styled backgrounds
11. **Use activate/deactivate** in sequence diagrams for lifecycle
12. **Use Note over** for important callouts in sequence diagrams
13. **Keep labels SHORT** — max 4-5 words per node
14. **subgraph labels must be quoted**: subgraph name ["Label"]

## Rules for different PR types:
- **Angular PRs**: Show components, services, modules, guards, routing, state management
- **LoopBack4 PRs**: Show controllers, services, repositories, models, datasources
- **Workflow/Config PRs**: Show CI/CD pipeline, triggers, steps, outputs
- **API PRs**: Show request flow, validation, service layer, database, response

Make diagrams SPECIFIC to THIS PR — not generic.
Output ONLY valid JSON. If sequence diagram doesn't apply, set "sequence" to null.`;

/**
 * Simple fallback prompt — plain diagrams with no theming or styling.
 * Guaranteed to render on any Mermaid version.
 */
const SIMPLE_PROMPT = `You are a diagram designer. Generate simple, clean Mermaid diagrams.

You MUST output EXACTLY this JSON format:
\`\`\`json
{
  "flowchart": "mermaid code here",
  "sequence": "mermaid code here or null"
}
\`\`\`

## FLOWCHART — Simple pattern:

\`\`\`mermaid
flowchart TD
    A["PR Opened"] --> B{"Bot Check"}
    B -->|"Skip"| C["End"]
    B -->|"Valid"| D["Load Context"]
    D --> E["Fetch JIRA"]
    D --> F["Read Files"]
    E --> G["Run Agents"]
    F --> G
    G --> H["Consolidate"]
    H --> I["Post Comments"]
\`\`\`

## SEQUENCE DIAGRAM — Simple pattern:

\`\`\`mermaid
sequenceDiagram
    participant Dev as Developer
    participant GH as GitHub
    participant AI as AI Action
    participant LLM as Anthropic API

    Dev->>GH: Open Pull Request
    GH->>AI: Trigger workflow
    AI->>GH: Fetch PR diff
    GH-->>AI: Return context
    AI->>LLM: Send code for review
    LLM-->>AI: Return findings
    AI->>GH: Post inline comments
    AI->>GH: Update PR description
\`\`\`

## STRICT RULES:

1. **NO %%{init}%% theming** — No theme configuration at all
2. **NO emojis** — Plain text only
3. **NO style or classDef directives**
4. **NO HTML tags**
5. **NO colons in labels** — Use dashes instead
6. **Quote ALL labels**: A["Label"], B{"Decision?"}
7. **Edge labels**: -->|"label"| — NEVER commas
8. **par/and ONLY in sequenceDiagram** — NEVER in flowcharts
9. **Simple node IDs**: A, B, C, D
10. **Short labels** — max 30 characters

Make diagrams SPECIFIC to THIS PR — not generic.
Output ONLY valid JSON. If sequence diagram doesn't apply, set "sequence" to null.`;

async function generateMermaidDiagrams(
  context: ReviewContext,
  provider: AIProvider,
): Promise<MermaidDiagrams> {
  let userPrompt = `Generate beautiful Mermaid diagrams for this PR:\n\n`;
  userPrompt += `**Title:** ${context.prTitle}\n`;
  userPrompt += `**Branch:** ${context.headBranch} → ${context.baseBranch}\n`;
  userPrompt += `**Framework:** ${context.framework}\n`;
  userPrompt += `**Files changed:** ${context.changedFiles.map(f => `${f.filename} (${f.status})`).join(', ')}\n\n`;
  userPrompt += `**Diff:**\n\`\`\`diff\n${context.diff.substring(0, 4000)}\n\`\`\`\n`;

  // Try modern (rich) diagrams first
  core.info('Generating modern styled Mermaid diagrams...');
  const modern = await tryGenerateDiagrams(MODERN_PROMPT, userPrompt, provider, 3);
  if (modern.flowchart || modern.sequence) {
    return modern;
  }

  // Fall back to simple diagrams if modern fails
  core.info('Modern diagrams failed, falling back to simple version...');
  return tryGenerateDiagrams(SIMPLE_PROMPT, userPrompt, provider, 2);
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
      { maxTokens: 4096, temperature: 0.3, timeout: 300000 },
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
    let fixPrompt = `The Mermaid diagrams have syntax errors. Fix them and return valid JSON.\n\n`;
    if (flowchartError) {
      fixPrompt += `**Flowchart error:**\n\`\`\`\n${flowchartError}\n\`\`\`\n\nBroken code:\n\`\`\`mermaid\n${diagrams.flowchart}\n\`\`\`\n\n`;
    }
    if (sequenceError) {
      fixPrompt += `**Sequence error:**\n\`\`\`\n${sequenceError}\n\`\`\`\n\nBroken code:\n\`\`\`mermaid\n${diagrams.sequence}\n\`\`\`\n\n`;
    }
    fixPrompt += `Common fixes: Remove emojis from labels. Quote ALL labels. Use -->|"label"| not commas. No par in flowcharts. No colons in labels.\n`;

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: fixPrompt });

    core.info(`Mermaid validation failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying: ${(flowchartError || '').substring(0, 100)} ${(sequenceError || '').substring(0, 100)}`);
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
