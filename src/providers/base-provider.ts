import * as core from '@actions/core';
import { AIProvider, ChatMessage, ChatOptions, ChatResponse, ConnectionCheckResult } from './ai-provider';
import {
  CHARS_PER_TOKEN,
  HEARTBEAT_INTERVAL_MS,
  PREFLIGHT_TIMEOUT_MS,
  RATE_LIMIT_BACKOFF_STEP_MS,
  THINKING_FLOOR_TOKENS,
  TRANSIENT_BACKOFF_BASE_MS,
} from '../config/limits';

/** Streaming callbacks a provider implementation reports deltas through. */
export interface StreamObservers {
  onThinking(delta: string): void;
  onText(delta: string): void;
}

/**
 * Shared provider machinery — every hard-won reliability behavior lives here,
 * once, for all API dialects:
 *
 * - Model fallback chain: candidates tried in order, advancing ONLY on
 *   "unknown model" rejections; the first that works is latched for all
 *   later calls.
 * - Pre-flight probe: a tiny request that resolves the working model and
 *   fails fast (and loudly) on a hung/unreachable endpoint.
 * - Retry with backoff: Retry-After header respected, rate limits back off in
 *   30s steps, transient errors exponentially; timeouts are TERMINAL (a retry
 *   would just burn another full timeout window on the same slow call).
 * - Streaming heartbeat: periodic "thinking — N chars" log lines so a long
 *   call is visibly alive instead of silent.
 * - Thinking fallback: if the endpoint rejects the thinking param, it is
 *   disabled once and the call retried without it.
 *
 * Subclasses implement only the API dialect: how to send one streamed request
 * and how to classify that dialect's errors.
 */
export abstract class BaseProvider implements AIProvider {
  // Ordered fallback chain: tried in order, advancing only on "unknown model"
  // errors. Once one works it is latched into `resolvedModel` for all later calls.
  protected models: string[];
  protected resolvedModel?: string;
  protected maxRetries: number;
  protected baseUrl: string;
  protected thinkingBudget: number;
  // Presence only — the key value is a secret and is never stored/logged.
  protected apiKeyProvided: boolean;
  private thinkingDisabled = false;

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
        // Connectivity/timeout/auth failure — record a clear message and stop.
        lastError = timedOut
          ? new Error(
              `${model} did not respond within ${Math.round(timeoutMs / 1000)}s `
              + '(endpoint hung — no first token). The AI endpoint is unreachable or overloaded.',
            )
          : error instanceof Error ? error : new Error(String(error));
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
    const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    core.info(
      `Preparing request: ~${inputChars.toLocaleString()} input chars `
      + `(~${Math.ceil(inputChars / CHARS_PER_TOKEN).toLocaleString()} tok est), `
      + `max_output=${options.maxTokens} tok, timeout=${Math.round(options.timeout / 1000)}s`,
    );

    // Try each candidate model in order; advance only when a model is rejected as
    // unknown/unsupported. Once resolved, later calls use just that model.
    const candidates = this.resolvedModel ? [this.resolvedModel] : this.models;
    let lastUnknownModelError: Error | undefined;

    for (let mi = 0; mi < candidates.length; mi++) {
      const model = candidates[mi];
      try {
        const result = await this.chatWithModel(model, messages, options);
        if (!this.resolvedModel) {
          this.resolvedModel = model;
          core.info(`Using model: ${model}`);
        }
        return result;
      } catch (error) {
        if (this.isUnknownModelError(error)) {
          lastUnknownModelError = error instanceof Error ? error : new Error(String(error));
          const next = candidates[mi + 1];
          core.warning(
            `Model "${model}" was rejected as unknown/unsupported`
            + (next ? `; falling back to "${next}"` : ' — no more fallbacks'),
          );
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `All candidate models were rejected as unknown (${candidates.join(', ')}): `
      + `${lastUnknownModelError?.message ?? 'Unknown error'}`,
    );
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

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      attemptsMade = attempt + 1;
      const attemptStart = Date.now();
      // Streaming progress trackers, so the log shows the call is alive and we can
      // tell a slow-to-start call (no output) from a slow thinking/generation one.
      let thinkingChars = 0;
      let textChars = 0;
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
          `Calling ${model} (attempt ${attempt + 1}/${this.maxRetries + 1}, `
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

        const response = await this.streamOnce(
          model,
          messages,
          options,
          useThinking,
          thinkingBudget,
          {
            onThinking: (delta) => { thinkingChars += delta.length; },
            onText: (delta) => { textChars += delta.length; },
          },
          abortController.signal,
        );

        core.info(
          `${model} responded in ${elapsedSec()}s `
          + `(${response.inputTokens} in / ${response.outputTokens} out tok, `
          + `stop_reason=${response.stopReason ?? 'n/a'})`,
        );

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
        if (useThinking && attempt === 0 && !timedOut && this.isThinkingUnsupportedError(error)) {
          core.info('Extended thinking not supported, falling back to standard mode');
          this.thinkingDisabled = true;
          useThinking = false;
          continue;
        }

        // A timeout is terminal: a retry just burns another full timeout window on
        // the same slow call. Report it clearly and stop trying this model.
        if (timedOut) {
          core.warning(`${model} attempt ${attempt + 1}: ${lastError.message}`);
          break;
        }

        if (this.isRetryableError(error) && attempt < this.maxRetries) {
          const retryAfterMs = this.getRetryAfterMs(error);
          const isRateLimit = retryAfterMs > 0 || this.isRateLimitError(error);

          // Rate limit: use Retry-After header, or 30s, 60s, 90s, 120s
          // Other transient errors: 2s, 4s, 8s
          const delayMs = retryAfterMs > 0
            ? retryAfterMs
            : isRateLimit
              ? (attempt + 1) * RATE_LIMIT_BACKOFF_STEP_MS
              : Math.pow(2, attempt + 1) * TRANSIENT_BACKOFF_BASE_MS;
          core.warning(
            `${model} attempt ${attempt + 1} failed after ${attemptSec}s: ${lastError.message}. `
            + `Retrying in ${delayMs / 1000}s${isRateLimit ? ' — rate limited' : ''}`,
          );
          await this.delay(delayMs);
          continue;
        }

        if (!this.isRetryableError(error)) {
          core.warning(
            `${model} attempt ${attempt + 1} failed after ${attemptSec}s (not retryable): ${lastError.message}`,
          );
          break;
        }
      } finally {
        clearTimeout(timeoutId);
        if (heartbeat) clearInterval(heartbeat);
      }
    }

    throw new Error(
      `${model} call failed after ${attemptsMade} attempt(s): ${lastError?.message ?? 'Unknown error'}`,
    );
  }

  /** True for HTTP 429-style rate limits (used to pick the slower backoff schedule). */
  protected abstract isRateLimitError(error: unknown): boolean;

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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
