import { AIProvider, ChatMessage } from '../providers/ai-provider';
import { ActionConfig, AgentResult, Finding, ReviewCategory, ReviewContext } from '../types';
import { extractJsonObject } from '../utils/json';
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

const JSON_REPAIR_INSTRUCTION =
  'Your previous response did not contain a valid JSON object. Respond now with '
  + 'ONLY the JSON object described in the system prompt — start with `{`, end with '
  + '`}`, no prose before or after, and no markdown code fences. Keep descriptions '
  + 'concise so the entire findings array fits within the response.';

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly category: ReviewCategory;
  abstract readonly displayName: string;
  abstract readonly icon: string;

  constructor(
    protected provider: AIProvider,
    protected config: ActionConfig,
  ) {}

  async review(context: ReviewContext): Promise<AgentResult> {
    const startTime = Date.now();
    try {
      const messages = this.buildMessages(context);
      const maxTokens = this.getMaxTokens();
      let response = await this.provider.chat(messages, {
        maxTokens,
        temperature: this.config.temperature,
        timeout: this.config.agentTimeout * 1000,
      });

      let parsed = this.tryParseResponse(response.content);

      // Auto-heal: the first response had no parseable JSON (the model returned
      // prose, wrapped/trailing text, or truncated JSON). Feed the broken output
      // back and ask once more for a clean JSON-only object. Extended thinking
      // stays enabled — its budget is allocated on top of maxTokens, so it never
      // starves the text output.
      if (!parsed) {
        core.warning(
          `Agent ${this.name}: first response had no parseable JSON `
          + `(stop_reason=${response.stopReason ?? 'unknown'}, `
          + `text_len=${response.content.length}); auto-healing with a JSON-only retry`,
        );
        response = await this.provider.chat(
          this.buildRepairMessages(messages, response.content),
          {
            maxTokens,
            temperature: this.config.temperature,
            timeout: this.config.agentTimeout * 1000,
          },
        );
        parsed = this.tryParseResponse(response.content);
      }

      if (!parsed) {
        const snippet = response.content.slice(0, 300).replace(/\s+/g, ' ').trim();
        core.warning(
          `Agent ${this.name}: no parseable JSON after repair retry `
          + `(stop_reason=${response.stopReason ?? 'unknown'}, `
          + `text_len=${response.content.length}). First 300 chars: ${snippet || '(empty)'}`,
        );
        return {
          agentName: this.name,
          category: this.category,
          findings: [],
          summary: 'Failed to parse response',
          score: 0,
          durationMs: Date.now() - startTime,
          error: 'unparseable response (no JSON object)',
        };
      }

      return {
        agentName: this.name,
        category: this.category,
        findings: parsed.findings,
        summary: parsed.summary,
        score: parsed.score,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      core.warning(`Agent ${this.name} failed: ${errMsg}`);
      return {
        agentName: this.name,
        category: this.category,
        findings: [],
        summary: `Agent failed: ${errMsg}`,
        score: 0,
        durationMs: Date.now() - startTime,
        error: errMsg,
      };
    }
  }

  protected getMaxTokens(): number {
    return this.config.maxTokens;
  }

  protected buildMessages(context: ReviewContext): ChatMessage[] {
    const systemPrompt = this.buildSystemPrompt(context);
    const userPrompt = this.buildUserPrompt(context);

    return [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];
  }

  protected buildSystemPrompt(context: ReviewContext): string {
    // Load the agent's markdown prompt file
    let prompt = this.loadPromptFile(`${this.name}.md`);

    // Append framework-specific prompt if applicable
    if (context.framework === 'angular' || context.framework === 'both') {
      const angularPrompt = this.loadPromptFile('angular-additions.md');
      if (angularPrompt) prompt += '\n\n' + angularPrompt;
      if (this.config.angularPromptAppend) {
        prompt += '\n\n## Additional Angular Instructions (from user)\n' + this.config.angularPromptAppend;
      }
    }
    if (context.framework === 'loopback4' || context.framework === 'both') {
      const lb4Prompt = this.loadPromptFile('loopback4-additions.md');
      if (lb4Prompt) prompt += '\n\n' + lb4Prompt;
      if (this.config.loopback4PromptAppend) {
        prompt += '\n\n## Additional LoopBack4 Instructions (from user)\n' + this.config.loopback4PromptAppend;
      }
    }

    // Apply system prompt override or append
    if (this.config.systemPromptOverride) {
      prompt = this.config.systemPromptOverride;
    } else if (this.config.systemPromptAppend) {
      prompt += '\n\n## Additional Instructions (from user)\n' + this.config.systemPromptAppend;
    }

    // Global rules applied to every agent, regardless of category or prompt file
    prompt += '\n\n## Global Review Rules (apply to ALL findings)\n';
    prompt += '- Be exhaustive: walk your full checklist for every changed file; do not skim or stop early. When in doubt, flag the issue with severity `low` or `nit` rather than staying silent.\n';
    prompt += '- ONE finding per distinct issue. Never collapse multiple distinct issues at the same location into one finding.\n';
    prompt += '- DO NOT flag missing JSDoc/TSDoc/doc comments. Missing return types, missing parameter types, and loose `any` types ARE still in scope — only the doc-comment subset is suppressed. Only flag an EXISTING comment if it actively contradicts the code.\n';
    prompt += '- DO NOT create findings located inside unit test files (`*.unit.ts`, `*.spec.ts`, `*.test.ts`, files under `__tests__/unit/`). Read them to verify coverage, but place missing-coverage findings on the production file they should cover.\n';

    // Add CLAUDE.md context if available
    if (context.repoContext.claudeMdContent) {
      prompt += '\n\n## Project-Specific Context (from CLAUDE.md)\n' + context.repoContext.claudeMdContent;
    }

    // Add JIRA context if available
    if (context.jiraContext) {
      prompt += '\n\n## JIRA Ticket Context\n';
      prompt += `Ticket: ${context.jiraContext.ticketId}\n`;
      prompt += `Summary: ${context.jiraContext.summary}\n`;
      prompt += `Status: ${context.jiraContext.status}\n`;
      prompt += `Type: ${context.jiraContext.type}\n`;
      if (context.jiraContext.description) {
        prompt += `Description: ${context.jiraContext.description}\n`;
      }
      if (context.jiraContext.acceptanceCriteria) {
        prompt += `Acceptance Criteria: ${context.jiraContext.acceptanceCriteria}\n`;
      }
    }

    return prompt;
  }

  protected buildUserPrompt(context: ReviewContext): string {
    let userPrompt = `## Pull Request Information\n`;
    userPrompt += `- **Title:** ${context.prTitle}\n`;
    userPrompt += `- **Author:** ${context.prAuthor}\n`;
    userPrompt += `- **Base Branch:** ${context.baseBranch}\n`;
    userPrompt += `- **Head Branch:** ${context.headBranch}\n`;
    userPrompt += `- **Framework:** ${context.framework}\n\n`;

    if (context.prBody) {
      userPrompt += `## PR Description\n${context.prBody}\n\n`;
    }

    userPrompt += `## Diff\n\`\`\`diff\n${context.diff}\n\`\`\`\n\n`;

    // Include full file contents WITH LINE NUMBERS for accurate line references
    const filesToInclude = context.changedFiles.filter(f => f.content && f.status !== 'removed');
    if (filesToInclude.length > 0) {
      userPrompt += `## Full File Contents (with line numbers)\n\n`;
      userPrompt += `> Line numbers are shown at the start of each line. Use these EXACT line numbers in your findings.\n\n`;
      for (const file of filesToInclude) {
        const content = file.content || '';
        const truncated = content.length > 10000
          ? content.substring(0, 10000) + '\n... (truncated)'
          : content;
        const numbered = addLineNumbers(truncated);
        userPrompt += `### ${file.filename}\n\`\`\`\n${numbered}\n\`\`\`\n\n`;
      }
    }

    // Include dependency files (imported by changed files, not changed themselves)
    if (context.dependencyFiles && context.dependencyFiles.length > 0) {
      userPrompt += `## Referenced Dependency Files (not changed, for context only)\n\n`;
      userPrompt += `> These files are imported by the changed files. Review them for context `;
      userPrompt += `(e.g., interfaces, models, types) but do NOT flag issues in these files — `;
      userPrompt += `only flag issues in the changed files shown in the diff above.\n\n`;
      for (const dep of context.dependencyFiles) {
        userPrompt += `### ${dep.filename}\n`;
        userPrompt += `*Referenced by: ${dep.referencedBy.join(', ')}*\n`;
        userPrompt += `\`\`\`\n${addLineNumbers(dep.content)}\n\`\`\`\n\n`;
      }
    }

    userPrompt += `\nPlease review the code changes and provide your findings in the specified JSON format.`;
    userPrompt += `\n\nCRITICAL LINE NUMBER RULES:`;
    userPrompt += `\n- Each file above has line numbers at the start of each line (e.g., "  26 | uses: ...")`;
    userPrompt += `\n- You MUST use these EXACT line numbers in your findings' "line" field`;
    userPrompt += `\n- Do NOT guess or estimate line numbers — read them from the numbered file content`;
    userPrompt += `\n- The "line" field must match the line number shown in the file, not the diff position`;
    userPrompt += `\n- ONLY flag issues on lines that appear as ADDED (+) lines in the diff — NOT pre-existing code`;
    userPrompt += `\n- Do NOT flag issues in dependency files — they are provided for context only`;
    userPrompt += `\n\nCRITICAL: ONLY FLAG LINES THAT WERE CHANGED IN THIS PR:`;
    userPrompt += `\n- You are given both the DIFF and the full file contents. The diff shows EXACTLY which lines were added (+) or modified.`;
    userPrompt += `\n- ONLY create findings for lines that appear as ADDED (+) lines in the diff. These are lines the PR author wrote or changed.`;
    userPrompt += `\n- Context lines (lines with a space prefix in the diff, or lines not in any diff hunk) are PRE-EXISTING code — do NOT flag them unless the PR change directly breaks their correctness.`;
    userPrompt += `\n- If you see an issue on a line that was NOT changed in this PR, do NOT create a finding for it. It is out of scope.`;
    userPrompt += `\n- Before creating any finding, verify: "Is this line number inside a diff hunk as an added (+) line?" If no, skip it.`;
    userPrompt += `\n- The full file content is provided for CONTEXT (understanding types, imports, class structure) — not for you to audit every line.`;
    userPrompt += `\n\nIMPORT AND CONFIGURATION RULES:`;
    userPrompt += `\n- Do NOT flag missing type-only imports that do not affect runtime behavior. If the code compiles and works without the import, it is not required.`;
    userPrompt += `\n- Do NOT flag missing imports for types used only in decorator metadata or type positions (e.g., LoopBack4 @model() settings types).`;
    userPrompt += `\n- Only flag a missing import if it would cause a runtime error or compilation failure.`;
    userPrompt += `\n\nCRITICAL CODE SUGGESTION RULES:`;
    userPrompt += `\n- The "code_suggestion" field is used in GitHub's \`\`\`suggestion\`\`\` blocks, which REPLACE the original line(s)`;
    userPrompt += `\n- A code_suggestion REPLACES the line at the given line number. It does NOT insert before or after.`;
    userPrompt += `\n- ONLY provide code_suggestion when you are changing the EXISTING code at that exact line`;
    userPrompt += `\n- Do NOT provide code_suggestion for "add missing X" findings (e.g., add a checkout step, add a new function). Use the "suggestion" text field to explain what to add instead`;
    userPrompt += `\n- Do NOT provide code_suggestion that is IDENTICAL to the original code — that is a no-op and wastes the reviewer's time`;
    userPrompt += `\n- The code_suggestion must be a valid replacement for the line(s) at the specified line number. Read the file content to verify what is actually at that line before writing a suggestion`;
    userPrompt += `\n- You MUST preserve the EXACT indentation (leading spaces/tabs) of the original line`;
    userPrompt += `\n- Example: if the original line is "          debug: 'false'" (10 spaces), your suggestion must also start with 10 spaces`;
    userPrompt += `\n- NEVER strip or change indentation — GitHub will render it as a replacement, so wrong indentation breaks the file`;
    userPrompt += `\n- If unsure whether your code_suggestion is correct, OMIT it and use the "suggestion" text field instead`;
    userPrompt += `\n\nCONFIGURATION & WORKFLOW FILE RULES:`;
    userPrompt += `\n- In GitHub Actions workflow YAML files, all \`with:\` input values are STRINGS. Using quotes around 'false' or 'true' is CORRECT syntax — do NOT suggest removing quotes`;
    userPrompt += `\n- Do NOT flag intentional configuration choices (e.g., fail_on_critical: 'false', debug: 'false', review_profile: 'standard') — these are deliberate settings chosen by the developer`;
    userPrompt += `\n- Do NOT suggest changing config values like review_profile, fail_on_critical, or debug — the developer chose these values intentionally`;
    userPrompt += `\n- Do NOT flag standard GitHub Actions boilerplate as issues: permissions blocks, concurrency groups, cancel-in-progress, if-guards for bot PRs, branch name filters — these are standard patterns`;
    userPrompt += `\n- Do NOT suggest "optimization" changes to workflow files like adding \`paths:\` filters, adding checkout steps, changing trigger types, or other structural workflow improvements — these are architectural choices, not code quality issues`;
    userPrompt += `\n- For .yml/.yaml workflow files, ONLY flag: hardcoded secrets, unpinned action versions (@main vs SHA), script injection ($\{\{ }} in run: steps), overly broad permissions (write-all)`;
    userPrompt += `\n- For workflow files, OMIT code_suggestion entirely for most findings — workflow YAML structure is too complex for single-line replacements. Use the "suggestion" text field to explain what to do instead`;
    userPrompt += `\n- NEVER place a code_suggestion on a line that doesn't contain the code you're fixing. If your finding is about a missing feature (e.g., "add a checkout step"), do NOT provide code_suggestion — it would replace an unrelated line`;

    return userPrompt;
  }

  protected loadPromptFile(filename: string): string {
    // Try multiple locations: /app/prompts (Docker), ./prompts (local), relative to this file
    const locations = [
      path.join('/app/prompts', filename),
      path.join(process.cwd(), 'prompts', filename),
      path.join(__dirname, '../../prompts', filename),
    ];

    for (const loc of locations) {
      try {
        return fs.readFileSync(loc, 'utf-8');
      } catch {
        continue;
      }
    }

    core.warning(`Prompt file ${filename} not found in any location`);
    return '';
  }

  /**
   * Maps a finding's raw category from the model response to a ReviewCategory.
   * Specialist agents own a single category; the comprehensive agent overrides
   * this to preserve the per-finding category the model assigned.
   */
  protected resolveCategory(_raw: unknown): ReviewCategory {
    return this.category;
  }

  /**
   * Builds the follow-up conversation for the auto-healing JSON-only retry.
   * When the model returned some (unparseable) text we feed it back so it can
   * correct its own output; when it returned nothing we just re-issue the ask.
   */
  protected buildRepairMessages(original: ChatMessage[], brokenContent: string): ChatMessage[] {
    const repair: ChatMessage[] = [...original];
    if (brokenContent.trim()) {
      repair.push({ role: 'assistant', content: brokenContent });
    }
    repair.push({ role: 'user', content: JSON_REPAIR_INSTRUCTION });
    return repair;
  }

  /**
   * Parses an agent response into findings. Returns null (rather than an empty
   * result) when no JSON object can be recovered, so the caller can trigger the
   * auto-healing retry and only give up after that also fails.
   */
  protected tryParseResponse(
    content: string,
  ): { findings: Finding[]; summary: string; score: number } | null {
    const jsonStr = extractJsonObject(content);
    if (!jsonStr) return null;

    let parsed: { findings?: Record<string, unknown>[]; summary?: unknown; score?: unknown };
    try {
      parsed = JSON.parse(jsonStr);
    } catch (error) {
      core.debug(
        `Agent ${this.name}: JSON.parse failed on extracted object: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    const validSeverities = new Set(['critical', 'high', 'medium', 'low', 'nit']);

    const findings: Finding[] = (parsed.findings || []).map((f: Record<string, unknown>) => ({
      severity: validSeverities.has(f.severity as string) ? f.severity as Finding['severity'] : 'medium',
      category: this.resolveCategory(f.category),
      file: f.file || '',
      line: f.line || 0,
      endLine: f.endLine || f.end_line,
      title: f.title || 'Untitled finding',
      description: f.description || '',
      suggestion: f.suggestion,
      codeSuggestion: f.code_suggestion || f.codeSuggestion,
    })) as Finding[];

    return {
      findings,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      score: typeof parsed.score === 'number' ? parsed.score : 5,
    };
  }
}

/**
 * Prepends line numbers to each line of content (1-indexed, right-aligned).
 * Example output: "   1 | const x = 1;\n   2 | const y = 2;"
 */
function addLineNumbers(content: string): string {
  const lines = content.split('\n');
  const padding = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(padding)} | ${line}`)
    .join('\n');
}
