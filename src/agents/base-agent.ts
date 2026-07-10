import { AIProvider, ChatMessage } from '../providers/ai-provider';
import { ActionConfig, AgentResult, Finding, ReviewCategory, ReviewContext } from '../types';
import { extractJsonObject } from '../utils/json';
import { addLineNumbers } from '../utils/text';
import { loadPrompt, loadPromptOrEmpty } from '../prompts/loader';
import { coerceFinding } from '../config/taxonomy';
import {
  CHARS_PER_TOKEN,
  COMPACT_INPUT_TOKENS,
  CONTEXT_SAFETY_MARGIN_TOKENS,
  ERROR_SNIPPET_CHARS,
  PROMPT_CLAMP_FLOOR_TOKENS,
  PROMPT_MAX_FILE_CHARS,
  PROMPT_TRIM_STAGES,
} from '../config/limits';
import * as core from '@actions/core';

/** Rough char→token estimate used only for prompt budgeting. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * True when a stop_reason indicates the request overflowed the model's context
 * window (e.g. GLM's `model_context_window_exceeded`). Deliberately does NOT
 * match a plain `max_tokens` stop (that means the OUTPUT was truncated, which is
 * handled by the JSON-repair path instead).
 */
function isContextOverflow(stopReason?: string | null): boolean {
  if (!stopReason) return false;
  const s = stopReason.toLowerCase();
  return s.includes('context_window') || s.includes('context_length')
    || s.includes('prompt_too_long') || s.includes('too_long') || s.includes('context_exceeded');
}

interface PromptTrimOptions {
  maxFileChars: number;
  maxDepFiles: number;
  maxDiffChars: number;
  includeFileContents: boolean;
}

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly category: ReviewCategory;

  constructor(
    protected provider: AIProvider,
    protected config: ActionConfig,
  ) {}

  async review(context: ReviewContext): Promise<AgentResult> {
    const startTime = Date.now();
    try {
      const maxTokens = this.getMaxTokens();
      const chatOpts = {
        maxTokens,
        temperature: this.config.temperature,
        timeout: this.config.agentTimeout * 1000,
      };

      // Pre-flight: trim the prompt to fit the model's context window so the
      // request is not rejected with model_context_window_exceeded.
      const messages = this.buildBudgetedMessages(context);
      let response = await this.provider.chat(messages, chatOpts);

      // Auto-heal, branched by failure mode:
      if (isContextOverflow(response.stopReason)) {
        // The trimmed prompt still overflowed (the real window is smaller than
        // configured, or the estimate was optimistic). Retry with an aggressively
        // compact prompt — diff-only, no file bodies, no dependency files.
        core.warning(
          `Agent ${this.name}: context window exceeded `
          + `(stop_reason=${response.stopReason}); retrying with a compact diff-only prompt`,
        );
        response = await this.provider.chat(this.buildCompactMessages(context), chatOpts);
      } else if (!this.tryParseResponse(response.content)) {
        // Response had no parseable JSON (prose, wrapped/trailing text, or truncated
        // JSON). Feed the broken output back and ask once more for JSON only.
        // Extended thinking stays enabled — its budget is on top of maxTokens.
        core.warning(
          `Agent ${this.name}: first response had no parseable JSON `
          + `(stop_reason=${response.stopReason ?? 'unknown'}, `
          + `text_len=${response.content.length}); auto-healing with a JSON-only retry`,
        );
        response = await this.provider.chat(
          this.buildRepairMessages(messages, response.content),
          chatOpts,
        );
      }

      const parsed = this.tryParseResponse(response.content);

      if (!parsed) {
        const snippet = response.content.slice(0, ERROR_SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
        core.warning(
          `Agent ${this.name}: no parseable JSON after repair retry `
          + `(stop_reason=${response.stopReason ?? 'unknown'}, `
          + `text_len=${response.content.length}). First ${ERROR_SNIPPET_CHARS} chars: ${snippet || '(empty)'}`,
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

  /**
   * Builds messages trimmed to fit the target model's context window. The prompt
   * is assembled at progressively smaller sizes (full → drop dependency files →
   * shrink per-file content) until the estimated input tokens fit within
   * `contextWindow - reserved output - system prompt - safety margin`, with a
   * final hard clamp as a guaranteed backstop.
   */
  protected buildBudgetedMessages(context: ReviewContext): ChatMessage[] {
    const systemPrompt = this.buildSystemPrompt(context);
    // Reserve the real output budget: max_tokens plus the configured thinking
    // budget the provider adds on top of it.
    const outputReservation = this.getMaxTokens() + this.config.thinkingBudget;
    const inputBudget = this.config.contextWindow
      - outputReservation
      - estimateTokens(systemPrompt)
      - CONTEXT_SAFETY_MARGIN_TOKENS;

    let userPrompt = this.buildUserPrompt(context, PROMPT_TRIM_STAGES[0]);
    let stageUsed = 0;
    for (let i = 0; i < PROMPT_TRIM_STAGES.length; i++) {
      userPrompt = this.buildUserPrompt(context, PROMPT_TRIM_STAGES[i]);
      stageUsed = i;
      if (estimateTokens(userPrompt) <= inputBudget) break;
    }

    // Guaranteed backstop: clamp the assembled prompt to the char budget even if
    // a single huge diff still exceeds the smallest staged build.
    const maxUserChars = Math.max(inputBudget, PROMPT_CLAMP_FLOOR_TOKENS) * CHARS_PER_TOKEN;
    let clamped = false;
    if (userPrompt.length > maxUserChars) {
      userPrompt = userPrompt.substring(0, maxUserChars)
        + '\n\n... (prompt truncated to fit the model context window)';
      clamped = true;
    }

    if (stageUsed > 0 || clamped) {
      core.warning(
        `Agent ${this.name}: prompt trimmed to fit context window `
        + `(${this.config.contextWindow} tok): input≈${estimateTokens(userPrompt)} tok, `
        + `budget≈${inputBudget} tok, trim stage ${stageUsed}${clamped ? ' + hard clamp' : ''}. `
        + 'Increase context_window for a larger-context model, or split the PR.',
      );
    }

    return [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];
  }

  /**
   * Minimal prompt for the fallback retry after a context-window rejection:
   * the diff only (capped), no full file bodies, no dependency files.
   */
  protected buildCompactMessages(context: ReviewContext): ChatMessage[] {
    const systemPrompt = this.buildSystemPrompt(context);
    const budgetChars = COMPACT_INPUT_TOKENS * CHARS_PER_TOKEN;
    let userPrompt = this.buildUserPrompt(context, {
      includeFileContents: false,
      maxDepFiles: 0,
      maxDiffChars: budgetChars,
    });
    if (userPrompt.length > budgetChars) {
      userPrompt = userPrompt.substring(0, budgetChars)
        + '\n\n... (prompt truncated to fit the model context window)';
    }
    return [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];
  }

  protected buildSystemPrompt(context: ReviewContext): string {
    // Load the agent's markdown prompt file (review criteria)
    let prompt = this.loadPromptFile(this.name);

    // Append framework-specific prompt if applicable
    if (context.framework === 'angular' || context.framework === 'both') {
      const angularPrompt = this.loadPromptFile('angular-additions');
      if (angularPrompt) prompt += '\n\n' + angularPrompt;
      if (this.config.angularPromptAppend) {
        prompt += '\n\n## Additional Angular Instructions (from user)\n' + this.config.angularPromptAppend;
      }
    }
    if (context.framework === 'loopback4' || context.framework === 'both') {
      const lb4Prompt = this.loadPromptFile('loopback4-additions');
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
    prompt += '\n\n' + loadPrompt('system/global-rules') + '\n';

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

  protected buildUserPrompt(context: ReviewContext, trim?: Partial<PromptTrimOptions>): string {
    const opts: PromptTrimOptions = {
      maxFileChars: trim?.maxFileChars ?? PROMPT_MAX_FILE_CHARS,
      maxDepFiles: trim?.maxDepFiles ?? Number.POSITIVE_INFINITY,
      maxDiffChars: trim?.maxDiffChars ?? Number.POSITIVE_INFINITY,
      includeFileContents: trim?.includeFileContents ?? true,
    };

    let userPrompt = `## Pull Request Information\n`;
    userPrompt += `- **Title:** ${context.prTitle}\n`;
    userPrompt += `- **Author:** ${context.prAuthor}\n`;
    userPrompt += `- **Base Branch:** ${context.baseBranch}\n`;
    userPrompt += `- **Head Branch:** ${context.headBranch}\n`;
    userPrompt += `- **Framework:** ${context.framework}\n\n`;

    if (context.prBody) {
      userPrompt += `## PR Description\n${context.prBody}\n\n`;
    }

    const diff = context.diff.length > opts.maxDiffChars
      ? context.diff.substring(0, opts.maxDiffChars) + '\n... (diff truncated to fit context window)'
      : context.diff;
    userPrompt += `## Diff\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;

    // Include full file contents WITH LINE NUMBERS for accurate line references
    const filesToInclude = opts.includeFileContents
      ? context.changedFiles.filter(f => f.content && f.status !== 'removed')
      : [];
    if (filesToInclude.length > 0) {
      userPrompt += `## Full File Contents (with line numbers)\n\n`;
      userPrompt += `> Line numbers are shown at the start of each line. Use these EXACT line numbers in your findings.\n\n`;
      for (const file of filesToInclude) {
        const content = file.content || '';
        const truncated = content.length > opts.maxFileChars
          ? content.substring(0, opts.maxFileChars) + '\n... (truncated)'
          : content;
        const numbered = addLineNumbers(truncated);
        userPrompt += `### ${file.filename}\n\`\`\`\n${numbered}\n\`\`\`\n\n`;
      }
    }

    // Include dependency files (imported by changed files, not changed themselves)
    const depFiles = context.dependencyFiles
      ? context.dependencyFiles.slice(0, opts.maxDepFiles)
      : [];
    if (depFiles.length > 0) {
      userPrompt += `## Referenced Dependency Files (not changed, for context only)\n\n`;
      userPrompt += `> These files are imported by the changed files. Review them for context `;
      userPrompt += `(e.g., interfaces, models, types) but do NOT flag issues in these files — `;
      userPrompt += `only flag issues in the changed files shown in the diff above.\n\n`;
      for (const dep of depFiles) {
        userPrompt += `### ${dep.filename}\n`;
        userPrompt += `*Referenced by: ${dep.referencedBy.join(', ')}*\n`;
        userPrompt += `\`\`\`\n${addLineNumbers(dep.content)}\n\`\`\`\n\n`;
      }
    }

    // The review contract: line-number rules, changed-lines-only scope,
    // code-suggestion rules, workflow-file rules.
    userPrompt += `\n` + loadPrompt('system/user-contract');

    return userPrompt;
  }

  protected loadPromptFile(name: string): string {
    return loadPromptOrEmpty(name);
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
    repair.push({ role: 'user', content: loadPrompt('system/json-repair') });
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

    const findings = (parsed.findings || []).map(
      (f: Record<string, unknown>) => coerceFinding(f, raw => this.resolveCategory(raw)),
    );

    return {
      findings,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      score: typeof parsed.score === 'number' ? parsed.score : 5,
    };
  }
}
