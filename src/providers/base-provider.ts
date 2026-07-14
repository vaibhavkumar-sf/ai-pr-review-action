import * as core from '@actions/core';
import { AIProvider, ChatMessage, ChatOptions, ChatResponse, ConnectionCheckResult, ModelUsage, ToolCall, ToolDefinition } from './ai-provider';
import {
  CHARS_PER_TOKEN,
  HEARTBEAT_INTERVAL_MS,
  OUTPUT_CAP_CLAMP_RETRIES,
  OUTPUT_TOKENS_CEILING,
  PREFLIGHT_HANG_MAX_RETRIES,
  PREFLIGHT_TIMEOUT_MS,
  RATE_LIMIT_DELAY_GROWTH,
  RATE_LIMIT_MAX_ATTEMPTS,
  RATE_LIMIT_MAX_TOTAL_WAIT_MS,
  RATE_LIMIT_RETRY_DELAY_MAX_MS,
  RATE_LIMIT_RETRY_DELAY_MS,
  THINKING_FLOOR_TOKENS,
  THINKING_SNIPPET_CHARS,
  TRANSIENT_BACKOFF_BASE_MS,
} from '../config/limits';

/** Streaming callbacks a provider implementation reports deltas through. */
export interface StreamObservers {
  onThinking(delta: string): void;
  onText(delta: string): void;
  /** A tool call started streaming (keeps the heartbeat honest on tool turns). */
  onToolUse?(name: string): void;
}

/**
 * Extracts the advertised output-token maximum from a "max_tokens too large"
 * rejection message. Handles the phrasings used by Anthropic-style endpoints
 * ("max_tokens: 131072 > 64000, which is the maximum allowed number of output
 * tokens...") and OpenAI-style ones ("This model supports at most 16384
 * completion tokens"). Returns null when the message is not about the output
 * cap (context-length errors are deliberately NOT matched).
 */
/**
 * Escalating wait before 429 retry number `retryCount` (0-based): starts at
 * RATE_LIMIT_RETRY_DELAY_MS and grows by RATE_LIMIT_DELAY_GROWTH per
 * consecutive 429, capped at RATE_LIMIT_RETRY_DELAY_MAX_MS. Fair-usage
 * limiters punish request frequency — retrying on a fixed short cadence can
 * keep re-tripping the very limit being waited out.
 */
export function rateLimitBackoffMs(retryCount: number): number {
  return Math.min(
    Math.round(RATE_LIMIT_RETRY_DELAY_MS * Math.pow(RATE_LIMIT_DELAY_GROWTH, retryCount)),
    RATE_LIMIT_RETRY_DELAY_MAX_MS,
  );
}

/**
 * One model's retry budget is spent (or its failure was terminal for that
 * model). `fallbackWorthy` is true when the failure was capacity/transient/
 * timeout — conditions another model in the chain may not share — and false
 * for request-shaped errors (bad request, auth) that would fail everywhere.
 */
export class ModelExhaustedError extends Error {
  constructor(message: string, readonly fallbackWorthy: boolean) {
    super(message);
    this.name = 'ModelExhaustedError';
  }
}

export function extractAdvertisedOutputCap(message: string): number | null {
  if (!/max_tokens|output tokens|completion tokens/i.test(message)) return null;
  const patterns = [
    /max_tokens[^\d]*[\d,]+\s*>\s*([\d,]+)/i,
    /less than or equal to\s*([\d,]+)/i,
    /at most\s*([\d,]+)/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      const cap = parseInt(match[1].replace(/,/g, ''), 10);
      if (!isNaN(cap) && cap > 0) return cap;
    }
  }
  return null;
}

/**
 * Shared provider machinery — every hard-won reliability behavior lives here,
 * once, for all API dialects:
 *
 * - Model fallback chain: candidates tried in order, advancing on "unknown
 *   model" rejections AND on exhausted capacity/transient/timeout failures
 *   (a run must not die on an overloaded primary while fallbacks sit untried);
 *   the model that works is latched first-in-line for all later calls, with
 *   the rest of the chain still behind it.
 * - Pre-flight probe: a tiny request that resolves the working model and
 *   fails fast (and loudly) on a hung/unreachable endpoint.
 * - Retry with backoff: Retry-After header respected; capacity errors (429
 *   rate limit, 529 overloaded) get their own patient budget (up to
 *   RATE_LIMIT_MAX_ATTEMPTS retries with an ESCALATING wait, independent of
 *   max_retries — polite polling, not hammering), other transient errors back
 *   off exponentially; timeouts are terminal for the model (a retry would just
 *   burn another full timeout window on the same slow call) but still fall
 *   back to the next model in the chain.
 * - Streaming heartbeat: periodic "thinking — N chars" log lines so a long
 *   call is visibly alive instead of silent.
 * - Thinking fallback: if the endpoint rejects the thinking param, it is
 *   disabled once and the call retried without it.
 *
 * Subclasses implement only the API dialect: how to send one streamed request
 * and how to classify that dialect's errors.
 */
export abstract class BaseProvider implements AIProvider {
  // Ordered fallback chain: tried in order, advancing on "unknown model"
  // rejections and exhausted capacity/transient/timeout failures. The working
  // model is latched into `resolvedModel` and tried first on later calls, with
  // the chain models behind it still available as fallbacks.
  protected models: string[];
  protected resolvedModel?: string;
  protected maxRetries: number;
  protected baseUrl: string;
  protected thinkingBudget: number;
  // Presence only — the key value is a secret and is never stored/logged.
  protected apiKeyProvided: boolean;
  private thinkingDisabled = false;
  // Output-token caps discovered from endpoint rejections ("max_tokens: X >
  // <max> ..."), latched per model so later calls are clamped up front.
  private outputCapByModel = new Map<string, number>();
  // Cumulative token usage per model across every successful chat call —
  // the basis for the run's usage/cost report.
  private usageByModel = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();

  constructor(baseUrl: string, apiKey: string, models: string[], maxRetries: number, thinkingBudget: number) {
    this.models = models.length ? models : [];
    this.maxRetries = maxRetries;
    this.baseUrl = baseUrl;
    this.thinkingBudget = thinkingBudget;
    this.apiKeyProvided = Boolean(apiKey && apiKey.trim().length > 0);
  }

  // ─── Dialect hooks ─────────────────────────────────────────────────────────

  /** Sends ONE streamed request and returns the final response. */
  protected abstract streamOnce(
    model: string,
    messages: ChatMessage[],
    options: ChatOptions,
    useThinking: boolean,
    thinkingBudget: number,
    observers: StreamObservers,
    signal: AbortSignal,
  ): Promise<ChatResponse>;

  /** Sends the tiny pre-flight probe request. */
  protected abstract probe(model: string, signal: AbortSignal): Promise<{ outputTokens: number }>;

  /** Best-effort list of model ids the endpoint advertises (diagnostics only). */
  protected abstract listModels(): Promise<string[]>;

  /** A copy-pasteable curl command for probing the endpoint locally (no secrets). */
  protected abstract curlHint(): string;

  /** True when the endpoint rejected the model id as unknown → try the next candidate. */
  protected abstract isUnknownModelError(error: unknown): boolean;

  /** True for transient failures worth retrying (rate limit, 5xx, network). */
  protected abstract isRetryableError(error: unknown): boolean;

  /** True when the endpoint rejected the thinking param → retry once without it. */
  protected abstract isThinkingUnsupportedError(error: unknown): boolean;

  /** Retry-After delay in ms if the error carries one, else 0. */
  protected abstract getRetryAfterMs(error: unknown): number;

  // ─── Shared behavior ───────────────────────────────────────────────────────

  /** The model already confirmed to work, or the first candidate if none tried yet. */
  getResolvedModel(): string {
    return this.resolvedModel ?? this.models[0];
  }

  /** Per-model token usage accumulated across every successful chat call. */
  getModelUsage(): ModelUsage[] {
    return [...this.usageByModel.entries()]
      .map(([model, u]) => ({ model, ...u }))
      .sort((a, b) => b.calls - a.calls);
  }

  /**
   * Logs which model and endpoint are actually in use, and best-effort lists
   * the models the endpoint advertises. Fault-tolerant: never throws.
   */
  async logDiagnostics(): Promise<void> {
    core.info('════════════════ AI CONNECTIVITY ════════════════');
    core.info(
      this.models.length > 1
        ? `AI model fallback chain: ${this.models.join(' → ')}`
        : `AI model requested: ${this.models[0]}`,
    );
    let host = this.baseUrl;
    try {
      host = new URL(this.baseUrl).host;
    } catch {
      // keep the raw value if it is not a parseable URL
    }
    core.info(`AI endpoint: ${host}`);
    // Presence check only — catches an empty/misconfigured secret early. The key
    // value is never printed (it is a secret; GitHub masks it regardless).
    core.info(
      this.apiKeyProvided
        ? 'AI auth token: present'
        : 'AI auth token: MISSING — set the ANTHROPIC_AUTH_TOKEN secret',
    );

    try {
      const ids = await this.listModels();
      core.info(
        ids.length
          ? `Endpoint advertises ${ids.length} model(s): ${ids.join(', ')}`
          : 'Endpoint returned an empty model list',
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      core.info(`Model list unavailable from this endpoint (non-critical): ${msg}`);
    }

    // Reproduce locally to probe the endpoint. Supply the key from YOUR shell —
    // it is a secret and is intentionally NOT printed here (GitHub masks it anyway).
    core.info(
      'Debug locally (export your key first, e.g. `export ANTHROPIC_AUTH_TOKEN=...`):\n'
      + `  ${this.curlHint()}`,
    );
  }

  /**
   * Pre-flight connectivity probe. Sends a minimal request so we learn —
   * cheaply and quickly — whether the endpoint answers and which candidate
   * model works, BEFORE gathering PR/JIRA context. Advances through the
   * fallback chain on "unknown model" and latches the winner so the real
   * review call skips re-probing. Throws a clear error if none respond.
   */
  async verifyConnection(timeoutMs: number = PREFLIGHT_TIMEOUT_MS): Promise<ConnectionCheckResult> {
    const candidates = this.resolvedModel ? [this.resolvedModel] : this.models;
    let lastError: Error | undefined;
    // A 429 on the pre-flight probe is quota churn, not a broken endpoint —
    // wait it out with the same patient budget the review calls use, instead
    // of killing the run before it even starts.
    let rateLimitRetries = 0;
    let rateLimitWaitedMs = 0;
    // A hung probe (no first token within the timeout) is retried too, on its
    // own small budget: fair-usage limiters sometimes stall connections
    // instead of returning a clean 429 (observed on z.ai right after a run of
    // 429s — the endpoint was alive). Each hang already costs a full probe
    // timeout, so this budget stays small to keep a truly dead endpoint
    // failing in minutes, not hours.
    let hangRetries = 0;

    for (let i = 0; i < candidates.length; i++) {
      const model = candidates[i];
      const t0 = Date.now();
      let timedOut = false;
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs);

      try {
        core.info(`Pre-flight: probing ${model} (timeout ${Math.round(timeoutMs / 1000)}s)…`);
        const result = await this.probe(model, abortController.signal);
        clearTimeout(timeoutId);

        const latencyMs = Date.now() - t0;
        if (!this.resolvedModel) {
          this.resolvedModel = model;
        }
        core.info(
          `Pre-flight OK: ${model} answered in ${(latencyMs / 1000).toFixed(1)}s `
          + `(${result.outputTokens} out tok). Proceeding.`,
        );
        return { model, latencyMs, outputTokens: result.outputTokens };
      } catch (error) {
        clearTimeout(timeoutId);
        if (this.isUnknownModelError(error)) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const next = candidates[i + 1];
          core.warning(
            `Pre-flight: model "${model}" rejected as unknown`
            + (next ? `; trying "${next}"` : ' — no more fallbacks'),
          );
          continue;
        }
        // Rate limited: wait and re-probe the SAME candidate — the whole point
        // of pre-flight is to fail fast on a broken endpoint, and a 429 is a
        // healthy endpoint telling us to slow down.
        const retryAfterMs = this.getRetryAfterMs(error);
        const isRateLimit = retryAfterMs > 0 || this.isRateLimitError(error);
        if (
          !timedOut && isRateLimit
          && rateLimitRetries < RATE_LIMIT_MAX_ATTEMPTS
          && rateLimitWaitedMs < RATE_LIMIT_MAX_TOTAL_WAIT_MS
        ) {
          const delayMs = retryAfterMs > 0 ? retryAfterMs : rateLimitBackoffMs(rateLimitRetries);
          rateLimitRetries += 1;
          rateLimitWaitedMs += delayMs;
          core.warning(
            `Pre-flight: ${model} rate limited — waiting ${Math.round(delayMs / 1000)}s before `
            + `retry ${rateLimitRetries}/${RATE_LIMIT_MAX_ATTEMPTS} `
            + `(${Math.round(rateLimitWaitedMs / 1000)}s waited in total): `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
          await this.delay(delayMs);
          i -= 1; // re-run this candidate
          continue;
        }
        // Hung probe: back off and re-probe the same candidate a few times —
        // during a throttled spell the limiter may stall connections rather
        // than answer 429, and one 45s hang should not kill the whole run.
        if (
          timedOut
          && hangRetries < PREFLIGHT_HANG_MAX_RETRIES
          && rateLimitWaitedMs < RATE_LIMIT_MAX_TOTAL_WAIT_MS
        ) {
          const delayMs = rateLimitBackoffMs(hangRetries);
          hangRetries += 1;
          rateLimitWaitedMs += delayMs;
          core.warning(
            `Pre-flight: ${model} hung (no first token within ${Math.round(timeoutMs / 1000)}s) — `
            + `endpoint may be overloaded or throttling; waiting ${Math.round(delayMs / 1000)}s before `
            + `retry ${hangRetries}/${PREFLIGHT_HANG_MAX_RETRIES}`,
          );
          await this.delay(delayMs);
          i -= 1; // re-run this candidate
          continue;
        }
        // Connectivity/auth failure, or hang budget exhausted — record a clear
        // message and try the next chain candidate (probes are tiny, and the
        // retry budgets above are shared across candidates, so a dead endpoint
        // still fails fast; a per-model outage is exactly what the chain is for).
        lastError = timedOut
          ? new Error(
              `${model} did not respond within ${Math.round(timeoutMs / 1000)}s `
              + `(endpoint hung — no first token) on ${hangRetries + 1} attempts. `
              + 'The AI endpoint is unreachable or overloaded.',
            )
          : error instanceof Error ? error : new Error(String(error));
        const nextCandidate = candidates[i + 1];
        if (nextCandidate) {
          core.warning(`Pre-flight: ${model} failed (${lastError.message}); trying "${nextCandidate}"`);
          continue;
        }
        break;
      }
    }

    throw new Error(
      `AI pre-flight check failed (${candidates.join(', ')}): ${lastError?.message ?? 'Unknown error'}`,
    );
  }

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    // Log the input size up front so a later failure (timeout, overflow) has the
    // request shape in the record without needing a re-run.
    const inputChars = messages.reduce(
      (sum, m) => sum + m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0),
      0,
    );
    core.info(
      `Preparing request: ~${inputChars.toLocaleString()} input chars `
      + `(~${Math.ceil(inputChars / CHARS_PER_TOKEN).toLocaleString()} tok est), `
      + `max_output=${options.maxTokens}${options.maxTokensAuto ? ' (auto)' : ''} tok, `
      + `timeout=${Math.round(options.timeout / 1000)}s`,
    );

    // Try each candidate model in order, advancing when one is rejected as
    // unknown/unsupported OR when it exhausts its retries on a capacity/
    // transient/timeout failure the next model may not share (an overloaded
    // glm-5.2 must cascade to the rest of the chain, not fail the run). The
    // latched model goes first, but the chain BEHIND it stays reachable so a
    // mid-run overload storm can still fall back.
    const latchedIdx = this.resolvedModel ? this.models.indexOf(this.resolvedModel) : 0;
    const candidates = latchedIdx >= 0 ? this.models.slice(latchedIdx) : this.models;
    let lastError: Error | undefined;

    for (let mi = 0; mi < candidates.length; mi++) {
      const model = candidates[mi];
      try {
        const result = await this.chatWithModel(model, messages, options);
        if (this.resolvedModel !== model) {
          this.resolvedModel = model;
          core.info(`Using model: ${model}`);
        }
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const next = candidates[mi + 1];
        if (this.isUnknownModelError(error)) {
          core.warning(
            `Model "${model}" was rejected as unknown/unsupported`
            + (next ? `; falling back to "${next}"` : ' — no more fallbacks'),
          );
          continue;
        }
        if (error instanceof ModelExhaustedError && error.fallbackWorthy && next) {
          core.warning(
            `Model "${model}" exhausted its retries on a transient failure; `
            + `falling back to "${next}"`,
          );
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `All candidate models failed (${candidates.join(', ')}): `
      + `${lastError?.message ?? 'Unknown error'}`,
    );
  }

  async chatWithTools(
    messages: ChatMessage[],
    options: ChatOptions,
    tools: ToolDefinition[],
    execute: (call: ToolCall) => Promise<string>,
    bounds: { maxRounds: number; maxCalls: number },
  ): Promise<{ response: ChatResponse; transcript: ChatMessage[] }> {
    const transcript: ChatMessage[] = [...messages];
    let callsUsed = 0;

    for (let round = 0; round <= bounds.maxRounds; round++) {
      // The last permitted round goes out WITHOUT tools: the model must answer
      // from what it has, so the review's JSON contract is always honored.
      const toolsThisTurn = round < bounds.maxRounds && callsUsed < bounds.maxCalls;
      const response = await this.chat(
        transcript,
        toolsThisTurn ? { ...options, tools } : { ...options, tools: undefined },
      );

      const requested = response.toolCalls ?? [];
      if (!toolsThisTurn || requested.length === 0) {
        return { response, transcript };
      }

      // Execute this round's calls in parallel (they are independent reads),
      // honoring the remaining per-review budget.
      const granted = requested.slice(0, Math.max(0, bounds.maxCalls - callsUsed));
      callsUsed += granted.length;
      core.info(
        `Context tools: round ${round + 1}/${bounds.maxRounds} — `
        + `${granted.map((c) => c.name).join(', ')} (${callsUsed}/${bounds.maxCalls} calls)`,
      );
      const results = await Promise.all(
        granted.map((call) =>
          execute(call).catch((err: unknown) =>
            `tool error: ${err instanceof Error ? err.message : String(err)}`),
        ),
      );

      transcript.push({ role: 'assistant', content: response.content, toolCalls: granted });
      granted.forEach((call, i) => {
        transcript.push({ role: 'tool', content: results[i], toolCallId: call.id });
      });
      for (const denied of requested.slice(granted.length)) {
        transcript.push({
          role: 'tool',
          content: 'tool budget exhausted — answer from the provided context',
          toolCallId: denied.id,
        });
      }
    }

    // Unreachable: the final round is always tool-less and returns above.
    throw new Error('chatWithTools exhausted its rounds without a final answer');
  }

  private async chatWithModel(
    model: string,
    messages: ChatMessage[],
    options: ChatOptions,
  ): Promise<ChatResponse> {
    // Extended thinking for deeper reasoning. The budget stays >= the API's
    // floor. A per-call override of 0 (or any value < the floor) disables
    // thinking for that call — used for cosmetic calls (PR description, diagrams).
    const requestedBudget = options.thinkingBudget ?? this.thinkingBudget;
    const thinkingBudget = Math.max(requestedBudget, THINKING_FLOOR_TOKENS);
    let useThinking = this.supportsThinking(model) && requestedBudget >= THINKING_FLOOR_TOKENS;
    const timeoutSec = Math.round(options.timeout / 1000);

    let lastError: Error | undefined;
    let attemptsMade = 0;
    // Whether giving up on THIS model justifies trying the next one in the
    // chain (capacity/transient/timeout failures do; request-shaped errors
    // like bad-request/auth would fail on every model and must not).
    let fallbackWorthy = false;
    // Two independent retry budgets: capacity errors (429 rate limit, 529
    // overloaded) are quota churn that clears with patience (many escalating
    // waits), everything else transient gets the small user-configured
    // max_retries with exponential backoff.
    let rateLimitRetries = 0;
    let rateLimitWaitedMs = 0;
    let transientRetries = 0;
    // Bounded retries after the endpoint rejects max_tokens as above the
    // model's real capacity (the rejection states the real maximum).
    let capClampRetries = 0;

    while (true) {
      attemptsMade += 1;
      const attemptStart = Date.now();
      // Streaming progress trackers, so the log shows the call is alive and we can
      // tell a slow-to-start call (no output) from a slow thinking/generation one.
      let thinkingChars = 0;
      let textChars = 0;
      // Head of the thinking stream, kept so a "no findings text" failure can log
      // WHAT the model was doing instead of writing findings.
      let thinkingSnippet = '';
      let timedOut = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, options.timeout);
      const elapsedSec = (): number => Math.round((Date.now() - attemptStart) / 1000);

      try {
        core.info(
          `Calling ${model} (attempt ${attemptsMade}, `
          + `thinking=${useThinking ? `on/${thinkingBudget}tok` : 'off'})…`,
        );

        heartbeat = setInterval(() => {
          if (textChars > 0) {
            core.info(
              `  ⏳ ${model}: writing findings — ${textChars} chars`
              + `${thinkingChars > 0 ? ` (after ${thinkingChars} thinking chars)` : ''} `
              + `[${elapsedSec()}s/${timeoutSec}s]`,
            );
          } else if (thinkingChars > 0) {
            core.info(`  ⏳ ${model}: thinking — ${thinkingChars} chars so far [${elapsedSec()}s/${timeoutSec}s]`);
          } else {
            core.info(`  ⏳ ${model}: awaiting first token, none yet [${elapsedSec()}s/${timeoutSec}s]`);
          }
        }, HEARTBEAT_INTERVAL_MS);

        // Single enforcement point for the output budget actually sent: the
        // requested budget plus the thinking allowance on top, clamped to the
        // model's real capacity (assumed ceiling, or the cap the endpoint
        // advertised in an earlier rejection).
        const modelCap = this.outputCapByModel.get(model) ?? OUTPUT_TOKENS_CEILING;
        const sentMaxTokens = Math.min(
          options.maxTokens + (useThinking ? thinkingBudget : 0),
          modelCap,
        );

        const response = await this.streamOnce(
          model,
          messages,
          { ...options, maxTokens: sentMaxTokens },
          useThinking,
          thinkingBudget,
          {
            onThinking: (delta) => {
              thinkingChars += delta.length;
              if (thinkingSnippet.length < THINKING_SNIPPET_CHARS) {
                thinkingSnippet += delta.slice(0, THINKING_SNIPPET_CHARS - thinkingSnippet.length);
              }
            },
            onText: (delta) => { textChars += delta.length; },
            onToolUse: (name) => { core.info(`  ⏳ ${model}: requesting tool ${name} [${elapsedSec()}s/${timeoutSec}s]`); },
          },
          abortController.signal,
        );

        core.info(
          `${model} responded in ${elapsedSec()}s `
          + `(${response.inputTokens} in / ${response.outputTokens} out tok, `
          + `stop_reason=${response.stopReason ?? 'n/a'}`
          + `${response.toolCalls?.length ? `, tool_calls=${response.toolCalls.length}` : ''})`,
        );

        const usage = this.usageByModel.get(model) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
        usage.calls += 1;
        usage.inputTokens += response.inputTokens;
        usage.outputTokens += response.outputTokens;
        this.usageByModel.set(model, usage);

        // Thinking-starvation diagnostic: the call "succeeded" but every output
        // token went to thinking and none to findings text (endpoints like GLM
        // can ignore budget_tokens). Log the head of the thinking stream so the
        // failure is debuggable from the Action log alone.
        if (response.content.trim().length === 0 && thinkingChars > 0) {
          core.warning(
            `${model}: response has NO text — all ${response.outputTokens} output tokens went to `
            + `thinking (${thinkingChars} chars, stop_reason=${response.stopReason ?? 'n/a'}). `
            + `First ${Math.min(thinkingSnippet.length, THINKING_SNIPPET_CHARS)} thinking chars: `
            + `${thinkingSnippet.replace(/\s+/g, ' ').trim() || '(empty)'}`,
          );
        }

        return response;
      } catch (error: unknown) {
        const attemptSec = elapsedSec();
        if (timedOut) {
          // Our own AbortController fired at options.timeout — surface that plainly
          // instead of an opaque "Request was aborted", with what we did get.
          const got = textChars > 0
            ? `${textChars} chars of output (+${thinkingChars} thinking) then stalled`
            : thinkingChars > 0
              ? `${thinkingChars} thinking chars but no findings text`
              : 'no output at all';
          lastError = new Error(
            `timed out after ${timeoutSec}s — ${model} produced ${got}. `
            + `The model/endpoint is too slow for this input: raise agent_timeout, `
            + `shrink the PR, or lower thinking_budget/max_tokens.`,
          );
        } else {
          lastError = error instanceof Error ? error : new Error(String(error));
        }

        // If thinking fails (unsupported model/provider), retry without it
        if (useThinking && attemptsMade === 1 && !timedOut && this.isThinkingUnsupportedError(error)) {
          core.info('Extended thinking not supported, falling back to standard mode');
          this.thinkingDisabled = true;
          useThinking = false;
          continue;
        }

        // A timeout is terminal FOR THIS MODEL: a retry just burns another full
        // timeout window on the same slow call. But a different model in the
        // chain may be faster, so the failure is still fallback-worthy.
        if (timedOut) {
          fallbackWorthy = true;
          core.warning(`${model} attempt ${attemptsMade}: ${lastError.message}`);
          break;
        }

        // The endpoint rejected max_tokens as above the model's real capacity
        // and told us the real maximum — latch it and retry clamped, so a run
        // never fails because our assumed ceiling was too optimistic.
        const advertisedCap = this.parseOutputCapError(error);
        if (advertisedCap !== null && advertisedCap > 0 && capClampRetries < OUTPUT_CAP_CLAMP_RETRIES) {
          capClampRetries += 1;
          this.outputCapByModel.set(model, advertisedCap);
          core.warning(
            `${model} rejected the requested output budget as above its capacity — `
            + `clamping to the advertised maximum ${advertisedCap} tokens and retrying`,
          );
          continue;
        }

        const retryAfterMs = this.getRetryAfterMs(error);
        const isRateLimit = retryAfterMs > 0 || this.isRateLimitError(error);

        // Capacity errors (429 rate limit, 529 overloaded): wait and try again,
        // up to RATE_LIMIT_MAX_ATTEMPTS and RATE_LIMIT_MAX_TOTAL_WAIT_MS —
        // independent of the max_retries budget, because capacity errors clear
        // with patience, not with speed. The wait ESCALATES while they persist
        // (Retry-After takes precedence): a fair-usage limiter punishes request
        // frequency, so polling politely beats hammering on a fixed short cadence.
        if (
          isRateLimit
          && rateLimitRetries < RATE_LIMIT_MAX_ATTEMPTS
          && rateLimitWaitedMs < RATE_LIMIT_MAX_TOTAL_WAIT_MS
        ) {
          const delayMs = retryAfterMs > 0 ? retryAfterMs : rateLimitBackoffMs(rateLimitRetries);
          rateLimitRetries += 1;
          rateLimitWaitedMs += delayMs;
          core.warning(
            `${model} attempt ${attemptsMade} failed after ${attemptSec}s: ${lastError.message}. `
            + `Rate limited/overloaded — waiting ${Math.round(delayMs / 1000)}s before retry `
            + `${rateLimitRetries}/${RATE_LIMIT_MAX_ATTEMPTS} `
            + `(${Math.round(rateLimitWaitedMs / 1000)}s waited in total)`,
          );
          await this.delay(delayMs);
          continue;
        }

        // Other transient errors: exponential backoff (2s, 4s, 8s, …) within max_retries.
        if (!isRateLimit && this.isRetryableError(error) && transientRetries < this.maxRetries) {
          transientRetries += 1;
          const delayMs = Math.pow(2, transientRetries) * TRANSIENT_BACKOFF_BASE_MS;
          core.warning(
            `${model} attempt ${attemptsMade} failed after ${attemptSec}s: ${lastError.message}. `
            + `Retrying in ${delayMs / 1000}s (${transientRetries}/${this.maxRetries})`,
          );
          await this.delay(delayMs);
          continue;
        }

        fallbackWorthy = isRateLimit || this.isRetryableError(error);
        core.warning(
          `${model} attempt ${attemptsMade} failed after ${attemptSec}s `
          + `(${fallbackWorthy ? 'retries exhausted' : 'not retryable'}): ${lastError.message}`,
        );
        break;
      } finally {
        clearTimeout(timeoutId);
        if (heartbeat) clearInterval(heartbeat);
      }
    }

    throw new ModelExhaustedError(
      `${model} call failed after ${attemptsMade} attempt(s): ${lastError?.message ?? 'Unknown error'}`,
      fallbackWorthy,
    );
  }

  /** True for HTTP 429-style rate limits (used to pick the slower backoff schedule). */
  protected abstract isRateLimitError(error: unknown): boolean;

  /**
   * When the endpoint rejected max_tokens as above the model's real output
   * capacity, returns the maximum it advertised in the error message; null for
   * every other error. Lets auto mode assume a generous ceiling and discover
   * each model's true cap by rejection instead of hardcoding a catalog.
   */
  protected abstract parseOutputCapError(error: unknown): number | null;

  protected supportsThinking(modelName: string): boolean {
    if (this.thinkingDisabled) return false;
    // Extended thinking is supported on Claude 3.5+/4+ and GLM-4.5+/5.x. If a
    // provider rejects the thinking param, isThinkingUnsupportedError() above
    // triggers a one-time retry without it.
    const model = modelName.toLowerCase();
    return model.includes('claude-3') || model.includes('claude-opus')
      || model.includes('claude-sonnet') || model.includes('claude-haiku')
      || model.includes('glm');
  }

  /** Overridable in tests so backoff schedules run instantly. */
  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
