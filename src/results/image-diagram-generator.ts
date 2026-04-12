import { AIProvider } from '../providers/ai-provider';
import { ReviewContext, MergedReviewResult } from '../types';
import * as core from '@actions/core';

/**
 * Generates rich Mermaid diagrams (flowchart + sequence) via AI and returns
 * them as native ```mermaid code blocks for GitHub's server-side rendering.
 *
 * GitHub renders ```mermaid blocks natively — works in both public AND private
 * repos with zero external dependencies or image hosting.
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

const MERMAID_SYSTEM_PROMPT = `You are a world-class diagram designer. Generate BEAUTIFUL, production-quality Mermaid diagrams.

You MUST output EXACTLY this JSON format:
\`\`\`json
{
  "flowchart": "mermaid code here",
  "sequence": "mermaid code here or null"
}
\`\`\`

## FLOWCHART — Use rich styling with %%{init}%% theme config:

\`\`\`mermaid
%%{init: {'theme': 'base', 'themeVariables': {'primaryColor': '#e3f2fd', 'primaryTextColor': '#0d47a1', 'primaryBorderColor': '#1565c0', 'lineColor': '#1565c0', 'secondaryColor': '#f3e5f5', 'tertiaryColor': '#e8f5e9', 'fontFamily': 'arial', 'fontSize': '14px'}}}%%
flowchart TD
    A["\uD83D\uDCE5 PR Opened"] --> B{"\uD83E\uDD16 Bot Check"}
    B -->|"Skip"| C["\u26D4 End"]
    B -->|"Valid"| D["\uD83D\uDD0D Load Context"]
    D --> E["\uD83D\uDDC2\uFE0F Fetch JIRA"]
    D --> F["\uD83D\uDCC4 Read Files"]
    E & F --> G["\u2699\uFE0F Run Agents"]

    subgraph agents ["\uD83E\uDDE0 AI Review Agents"]
        direction LR
        G1["\uD83D\uDD12 Security"]
        G2["\uD83D\uDCDD Code Quality"]
        G3["\u26A1 Performance"]
        G4["\uD83D\uDD0D Type Safety"]
        G5["\uD83C\uDFD7\uFE0F Architecture"]
    end

    G --> agents
    agents --> H["\uD83E\uDDE9 Consolidate"]
    H --> I["\uD83D\uDCAC Post Comments"]
    H --> J["\uD83D\uDCC8 Update Description"]

    style agents fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px,color:#4a148c
    style A fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style B fill:#fff3e0,stroke:#e65100,stroke-width:2px
    style C fill:#fce4ec,stroke:#c62828,stroke-width:2px
    style H fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px
    style I fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
    style J fill:#e3f2fd,stroke:#1565c0,stroke-width:2px
\`\`\`

## SEQUENCE DIAGRAM — Use rich styling:

\`\`\`mermaid
%%{init: {'theme': 'base', 'themeVariables': {'actorBkg': '#e3f2fd', 'actorBorder': '#1565c0', 'actorTextColor': '#0d47a1', 'signalColor': '#1565c0', 'signalTextColor': '#333', 'noteBkgColor': '#fff3e0', 'noteBorderColor': '#e65100', 'noteTextColor': '#333', 'activationBkgColor': '#e8f5e9', 'activationBorderColor': '#2e7d32', 'fontFamily': 'arial'}}}%%
sequenceDiagram
    actor Dev as \uD83D\uDC69\u200D\uD83D\uDCBB Developer
    participant GH as \uD83D\uDC19 GitHub
    participant AI as \uD83E\uDD16 AI Action
    participant LLM as \uD83E\uDDE0 Anthropic API
    participant JIRA as \uD83D\uDCCB JIRA

    Dev->>GH: Open Pull Request
    activate GH
    GH->>AI: Trigger workflow
    activate AI
    AI->>GH: Fetch PR diff + files
    GH-->>AI: Return code context

    par Parallel Context
        AI->>JIRA: Fetch ticket details
        JIRA-->>AI: Return context
    and
        AI->>GH: Read CLAUDE.md
        GH-->>AI: Return repo rules
    end

    AI->>LLM: Send code + rules
    activate LLM
    Note over LLM: Extended thinking enabled
    LLM-->>AI: Return findings
    deactivate LLM

    AI->>AI: Consolidate + deduplicate
    AI->>GH: Post inline comments
    AI->>GH: Update PR description
    AI->>GH: Add diagrams
    deactivate AI
    deactivate GH
\`\`\`

## CRITICAL SYNTAX RULES:

1. **Theme config MUST be on first line** — use %%{init}%% with Material Design colors
2. **Use emoji icons** in node labels for visual richness: \uD83D\uDD12 \uD83D\uDCDD \u26A1 \uD83D\uDD0D \uD83C\uDFD7\uFE0F \uD83E\uDDEA \uD83D\uDD0C \uD83E\uDD16 \uD83D\uDCE5 \u2699\uFE0F \uD83D\uDCC4 \uD83D\uDDC2\uFE0F \uD83D\uDCAC \uD83D\uDCC8 \uD83D\uDC19 \uD83E\uDDE0 \uD83D\uDCCB \u26D4 \uD83D\uDE80 \uD83D\uDEE1\uFE0F \uD83D\uDCCA
3. **Use subgraph** to group related components with styled backgrounds
4. **Use style directives** for custom colors: \`style nodeId fill:#color,stroke:#color,stroke-width:2px\`
5. **Use par/and blocks** in sequence diagrams for parallel operations
6. **Use activate/deactivate** in sequence diagrams for lifecycle
7. **Use Note over** for important callouts in sequence diagrams
8. **Quote ALL labels** that contain special characters or spaces
9. **Edge labels use pipe syntax**: \`-->|"label"|\` — NEVER use commas
10. **Keep labels SHORT** — max 3-5 words + emoji per node
11. Make diagrams SPECIFIC to THIS PR — not generic

## Rules for different PR types:
- **Angular PRs**: Show components, services, modules, guards, routing, state management
- **LoopBack4 PRs**: Show controllers, services, repositories, models, datasources, middleware
- **Workflow/Config PRs**: Show CI/CD pipeline, triggers, steps, outputs
- **API PRs**: Show request flow, validation, service layer, database, response

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

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: MERMAID_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await provider.chat(
      messages,
      { maxTokens: 4096, temperature: 0.3, timeout: 60000 },
    );

    const diagrams = parseDiagramResponse(response.content);

    // Validate each diagram via Kroki
    const flowchartError = diagrams.flowchart ? await validateMermaidViaKroki(diagrams.flowchart) : null;
    const sequenceError = diagrams.sequence ? await validateMermaidViaKroki(diagrams.sequence) : null;

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
    fixPrompt += `Fix the syntax errors and return the corrected diagrams in the same JSON format. Common fixes:\n`;
    fixPrompt += `- Remove special characters from labels (use simple text + emoji)\n`;
    fixPrompt += `- Quote labels with square brackets: use A["\uD83D\uDD12 Label"] not A[\uD83D\uDD12 Label]\n`;
    fixPrompt += `- Use -->|"label"| for edge labels, never commas\n`;
    fixPrompt += `- Ensure subgraph blocks are properly closed with 'end'\n`;
    fixPrompt += `- Check par/and/end blocks are properly nested\n`;

    // Add assistant response + fix request to conversation for context
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: fixPrompt });

    core.info(`Mermaid validation failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), asking AI to fix: ${flowchartError || ''} ${sequenceError || ''}`);
  }

  return { flowchart: null, sequence: null };
}

/**
 * Validates Mermaid syntax by sending it to Kroki.io's Mermaid renderer.
 * Returns null if valid, or the error message string if invalid.
 * Zero npm dependencies — just an HTTP POST.
 */
async function validateMermaidViaKroki(mermaidCode: string): Promise<string | null> {
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

    // Extract FULL error from Kroki response and send to AI for fixing
    const errorBody = await response.text();
    // Strip HTML/SVG tags to get plain error text
    const plainError = errorBody
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 500); // Cap at 500 chars to keep prompt manageable
    return plainError || `Kroki validation failed with HTTP ${response.status}`;
  } catch (err) {
    // If Kroki is unreachable, skip validation (don't block the review)
    core.debug(`Kroki validation skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
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
