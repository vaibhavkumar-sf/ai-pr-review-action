import { AIProvider, ChatMessage } from '../providers/ai-provider';
import { ActionConfig, AgentResult, DependencyReason, Finding, ReviewCategory, ReviewContext } from '../types';
import { extractJsonObject } from '../utils/json';
import { addLineNumbers } from '../utils/text';
import { loadPrompt, loadPromptOrEmpty } from '../prompts/loader';
import { coerceFinding } from '../config/taxonomy';
import {
  AUTO_OUTPUT_RESERVATION_DIVISOR,
  CHARS_PER_TOKEN,
  COMBINED_MAX_TOKENS_FLOOR,
  COMPACT_INPUT_TOKENS,
  CONTEXT_SAFETY_MARGIN_TOKENS,
  ERROR_SNIPPET_CHARS,
  MAX_REVIEW_BATCHES,
  OUTPUT_TOKENS_CEILING,
  PROMPT_CLAMP_FLOOR_TOKENS,
  PROMPT_MAX_FILE_CHARS,
  PROMPT_TRIM_STAGES,
  TRUNCATION_RETRY_MAX_ESCALATIONS,
  TRUNCATION_RETRY_TOKENS_MULTIPLIER,
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

/**
 * Splits a unified diff into per-file chunks keyed by the new-side path, so a
 * batched review context carries only its own files' diffs.
 */
function splitDiffByFile(diff: string): Map<string, string> {
  const byFile = new Map<string, string>();
  for (const part of diff.split(/^(?=diff --git )/m)) {
    if (!part.startsWith('diff --git ')) continue;
    const header = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (header) byFile.set(header[2].trim(), part.trimEnd());
  }
  return byFile;
}

/** Human phrasing for why a related file is in the prompt (presentation only). */
const REASON_LABEL: Record<DependencyReason, string> = {
  imported: 'imported by',
  template: 'template of',
  stylesheet: 'stylesheet of',
  'di-binding': 'DI binding injected by',
  'barrel-reexport': 're-exported through a barrel imported by',
  'declaring-module': 'declaring NgModule of',
  caller: 'calls code changed in',
};

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly category: ReviewCategory;

  constructor(
    protected provider: AIProvider,
    protected config: ActionConfig,
  ) {}

  async review(context: ReviewContext): Promise<AgentResult> {
    const startTime = Date.now();

    // Auto-batching: when even the FULL-fidelity prompt cannot fit the input
    // budget, split the changed files into batches and review every one of
    // them completely, instead of silently degrading through the trim stages.
    let batches: ReviewContext[];
    try {
      batches = this.planBatches(context);
    } catch (error) {
      core.warning(
        `Agent ${this.name}: batch planning failed `
        + `(${error instanceof Error ? error.message : String(error)}) — reviewing in one call`,
      );
      batches = [context];
    }

    if (batches.length === 1) {
      return this.reviewBatch(batches[0], startTime);
    }

    core.warning(
      `Agent ${this.name}: PR too large for one full-fidelity call — `
      + `reviewing in ${batches.length} batches so every file is fully reviewed`,
    );
    const results: AgentResult[] = [];
    for (let i = 0; i < batches.length; i++) {
      core.info(
        `Agent ${this.name}: reviewing batch ${i + 1}/${batches.length} `
        + `(${batches[i].changedFiles.length} files)…`,
      );
      results.push(await this.reviewBatch(batches[i], Date.now()));
    }
    return this.mergeBatchResults(results, startTime);
  }

  /** Reviews ONE (possibly batched) context. Never throws — failures come back as an error result. */
  private async reviewBatch(context: ReviewContext, startTime: number): Promise<AgentResult> {
    try {
      // Pre-flight: trim the prompt to fit the model's context window so the
      // request is not rejected with model_context_window_exceeded.
      const messages = this.buildBudgetedMessages(context);
      // Output budget: the user's manual cap, or (auto mode, the default) the
      // model's full remaining capacity so the review is never truncated by a
      // self-imposed limit. The provider clamps to the model's real cap.
      const maxTokens = this.resolveMaxTokens(messages);
      const chatOpts = {
        maxTokens,
        maxTokensAuto: this.getMaxTokens() === 0,
        temperature: this.config.temperature,
        timeout: this.config.agentTimeout * 1000,
      };
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
      }

      // Output-budget escalation: the response hit max_tokens without parseable
      // findings JSON. Two causes, one cure — runaway thinking that ate the whole
      // budget (GLM can ignore budget_tokens; text is then EMPTY), or a big PR
      // whose findings genuinely need more room (text is truncated JSON). Retry
      // with thinking disabled and an escalating output budget, so a user's
      // review never fails because our cap was too small.
      // At the ceiling the first retry still runs (thinking off frees the whole
      // budget for findings text); further escalations need headroom to matter.
      let escalatedTokens = maxTokens;
      for (
        let escalation = 0;
        response.stopReason === 'max_tokens'
          && !this.tryParseResponse(response.content)
          && escalation < TRUNCATION_RETRY_MAX_ESCALATIONS
          && (escalatedTokens < OUTPUT_TOKENS_CEILING || escalation === 0);
        escalation++
      ) {
        escalatedTokens = Math.min(escalatedTokens * TRUNCATION_RETRY_TOKENS_MULTIPLIER, OUTPUT_TOKENS_CEILING);
        core.warning(
          `Agent ${this.name}: response hit max_tokens with `
          + `${response.content.length === 0 ? 'NO text (thinking consumed the whole output budget)' : `truncated JSON (text_len=${response.content.length})`}; `
          + `retrying with thinking disabled and max_tokens=${escalatedTokens} `
          + `(escalation ${escalation + 1}/${TRUNCATION_RETRY_MAX_ESCALATIONS})`,
        );
        response = await this.provider.chat(messages, {
          ...chatOpts,
          maxTokens: escalatedTokens,
          thinkingBudget: 0,
        });
      }

      if (!this.tryParseResponse(response.content)) {
        // Response had no parseable JSON (prose, wrapped/trailing text, or truncated
        // JSON). Feed the broken output back and ask once more for JSON only.
        core.warning(
          `Agent ${this.name}: response had no parseable JSON `
          + `(stop_reason=${response.stopReason ?? 'unknown'}, `
          + `text_len=${response.content.length}); auto-healing with a JSON-only retry`,
        );
        response = await this.provider.chat(
          this.buildRepairMessages(messages, response.content),
          { ...chatOpts, maxTokens: escalatedTokens },
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
   * The output budget for one call: the user's manual cap, or in auto mode
   * (max_tokens: 0, the default) the model's full remaining capacity —
   * min(native ceiling, what the context window still has room for after the
   * input). Floored so a huge input never leaves a uselessly small budget
   * (the endpoint's own capacity check is authoritative; the provider clamps
   * to any smaller cap the endpoint advertises).
   */
  protected resolveMaxTokens(messages: ChatMessage[]): number {
    const configured = this.getMaxTokens();
    if (configured > 0) return configured;
    const inputTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    return Math.max(
      Math.min(
        OUTPUT_TOKENS_CEILING,
        this.config.contextWindow - inputTokens - CONTEXT_SAFETY_MARGIN_TOKENS,
      ),
      COMBINED_MAX_TOKENS_FLOOR,
    );
  }

  /**
   * Input-token budget for the user prompt: the context window minus the
   * output reservation, the system prompt, and a safety margin. In auto mode
   * the reservation is a window fraction (not the full ceiling) so
   * small-window models keep most of their window for input.
   */
  private inputBudgetTokens(systemPrompt: string): number {
    const configuredMax = this.getMaxTokens();
    const outputReservation = (configuredMax > 0
      ? configuredMax
      : Math.min(OUTPUT_TOKENS_CEILING, Math.floor(this.config.contextWindow / AUTO_OUTPUT_RESERVATION_DIVISOR)))
      + this.config.thinkingBudget;
    return this.config.contextWindow
      - outputReservation
      - estimateTokens(systemPrompt)
      - CONTEXT_SAFETY_MARGIN_TOKENS;
  }

  /**
   * Splits an oversized review into per-file batches that EACH fit the input
   * budget at full fidelity, so every file is completely reviewed instead of
   * silently truncated. Normal-sized PRs return a single batch (no change).
   */
  protected planBatches(context: ReviewContext): ReviewContext[] {
    if (context.changedFiles.length <= 1) return [context];
    const systemPrompt = this.buildSystemPrompt(context);
    const inputBudget = this.inputBudgetTokens(systemPrompt);
    const fullPrompt = this.buildUserPrompt(context, PROMPT_TRIM_STAGES[0]);
    if (estimateTokens(fullPrompt) <= inputBudget) return [context];

    const diffByFile = splitDiffByFile(context.diff);
    const deps = context.dependencyFiles ?? [];
    const depsFor = (filename: string): typeof deps =>
      deps.filter(d => d.referencedBy.includes(filename));

    // Estimated prompt cost per changed file: its content + its diff chunk +
    // the related files it pulls in.
    const costs = context.changedFiles.map(f =>
      (f.content?.length ?? 0)
      + (diffByFile.get(f.filename)?.length ?? 0)
      + depsFor(f.filename).reduce((sum, d) => sum + d.content.length, 0),
    );
    const overheadChars = this.buildUserPrompt(
      { ...context, changedFiles: [], dependencyFiles: [], diff: '' },
      PROMPT_TRIM_STAGES[0],
    ).length;
    const totalCost = costs.reduce((a, b) => a + b, 0);
    const fittingBudget = Math.max(
      inputBudget * CHARS_PER_TOKEN - overheadChars,
      PROMPT_CLAMP_FLOOR_TOKENS * CHARS_PER_TOKEN,
    );
    // Cost backstop: never more than MAX_REVIEW_BATCHES calls. Beyond that,
    // batches exceed the budget and fall back to the trim stages (warned).
    const perBatchBudget = Math.max(fittingBudget, Math.ceil(totalCost / MAX_REVIEW_BATCHES));
    if (perBatchBudget > fittingBudget) {
      core.warning(
        `Agent ${this.name}: PR needs more than ${MAX_REVIEW_BATCHES} full-fidelity batches — `
        + `capping at ${MAX_REVIEW_BATCHES}; oversized batches will be trimmed to fit`,
      );
    }

    // Greedy pack in order; every batch gets at least one file.
    const groups: Array<typeof context.changedFiles> = [];
    let current: typeof context.changedFiles = [];
    let currentCost = 0;
    for (let i = 0; i < context.changedFiles.length; i++) {
      if (current.length > 0 && currentCost + costs[i] > perBatchBudget) {
        groups.push(current);
        current = [];
        currentCost = 0;
      }
      current.push(context.changedFiles[i]);
      currentCost += costs[i];
    }
    if (current.length > 0) groups.push(current);
    if (groups.length <= 1) return [context];

    return groups.map(files => {
      const names = new Set(files.map(f => f.filename));
      const batchDeps = deps.filter(d => d.referencedBy.some(ref => names.has(ref)));
      const batchDiff = files
        .map(f => diffByFile.get(f.filename))
        .filter((chunk): chunk is string => Boolean(chunk))
        .join('\n');
      return { ...context, changedFiles: files, dependencyFiles: batchDeps, diff: batchDiff || context.diff };
    });
  }

  /** Combines per-batch results into one AgentResult (dedup happens downstream). */
  private mergeBatchResults(results: AgentResult[], startTime: number): AgentResult {
    const succeeded = results.filter(r => !r.error);
    const failed = results.filter(r => r.error);
    let summary = succeeded.map(r => r.summary).filter(Boolean).join('\n\n');
    if (failed.length > 0 && succeeded.length > 0) {
      summary += `\n\n⚠️ ${failed.length}/${results.length} review batches failed — `
        + 'findings may be incomplete for some files. Re-run the workflow to retry.';
    }
    return {
      agentName: this.name,
      category: this.category,
      findings: results.flatMap(r => r.findings),
      summary: summary || 'Failed to parse response',
      score: succeeded.length
        ? Math.round((succeeded.reduce((sum, r) => sum + r.score, 0) / succeeded.length) * 10) / 10
        : 0,
      durationMs: Date.now() - startTime,
      ...(succeeded.length === 0
        ? { error: `all ${results.length} review batches failed: ${failed[0]?.error ?? 'unknown error'}` }
        : {}),
    };
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
    const inputBudget = this.inputBudgetTokens(systemPrompt);

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

    // Include related files (imported by / implied by changed files, not changed themselves)
    const depFiles = context.dependencyFiles
      ? context.dependencyFiles.slice(0, opts.maxDepFiles)
      : [];
    if (depFiles.length > 0) {
      userPrompt += `## Related Files (not changed, for context only)\n\n`;
      userPrompt += `> These unchanged files give context for the changed code: imported `;
      userPrompt += `interfaces/models/services, Angular sibling templates and declaring modules, `;
      userPrompt += `and LoopBack DI binding targets. Use them to judge the changed code, but do `;
      userPrompt += `NOT flag issues in these files — only flag issues in the changed files shown `;
      userPrompt += `in the diff above.\n\n`;
      for (const dep of depFiles) {
        userPrompt += `### ${dep.filename}\n`;
        userPrompt += `*Included because: ${REASON_LABEL[dep.reason ?? 'imported']} ${dep.referencedBy.join(', ')}*\n`;
        if (dep.skeleton) {
          userPrompt += `*(signatures only — implementation bodies omitted; line numbers approximate)*\n`;
        }
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
