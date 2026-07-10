import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, ChatMessage, ChatOptions, ChatResponse, ConnectionCheckResult } from './ai-provider';
import * as core from '@actions/core';

// How often to emit a progress heartbeat while awaiting a streamed response, so a
// long-running model call is visibly alive in the Action log instead of silent.
const HEARTBEAT_INTERVAL_MS = 20000;
// Timeout for the pre-flight probe. A healthy endpoint answers a 16-token request
// in a few seconds; if it hangs past this, fail fast instead of wasting the full
// agent_timeout later. Kept short on purpose.
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 45000;

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  // Ordered fallback chain: tried in order, advancing only on "unknown model"
  // errors. Once one works it is latched into `resolvedModel` for all later calls.
  private models: string[];
  private resolvedModel?: string;
  private maxRetries: number;
  private baseUrl: string;
  private thinkingBudget: number;
  // Presence only — the key value is a secret and is never stored/logged.
  private apiKeyProvided: boolean;

  constructor(
    baseUrl: string,
    apiKey: string,
    models: string[],
    maxRetries: number,
    thinkingBudget: number,
  ) {
    this.client = new Anthropic({
      baseURL: baseUrl,
      apiKey,
    });
    this.models = models.length ? models : ['claude-opus-4-8'];
    this.maxRetries = maxRetries;
    this.baseUrl = baseUrl;
    this.thinkingBudget = thinkingBudget;
    this.apiKeyProvided = Boolean(apiKey && apiKey.trim().length > 0);
  }

  /** The model already confirmed to work, or the first candidate if none tried yet. */
  getResolvedModel(): string {
    return this.resolvedModel ?? this.models[0];
  }

  /**
   * Logs which model and endpoint are actually in use, and best-effort lists the
   * models the endpoint advertises. Fault-tolerant: never throws. Helpful when a
   * request fails with "Unknown Model" — the list reveals the exact accepted ids
   * (e.g. a z.ai/GLM endpoint lists glm-* ids and only maps Claude-tier names).
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
      // Anthropic-compatible endpoints expose GET /v1/models.
      const models = await this.client.models.list();
      const ids = models.data.map((m) => m.id);
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
    const modelsUrl = `${this.baseUrl.replace(/\/+$/, '')}/v1/models`;
    core.info(
      'Debug locally (export your key first, e.g. `export ANTHROPIC_AUTH_TOKEN=...`):\n'
      + `  curl -sS '${modelsUrl}' -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" -H "anthropic-version: 2023-06-01"`,
    );
  }

  /**
   * Pre-flight connectivity probe. Sends a minimal request (16 tokens, no
   * thinking) so we learn — cheaply and quickly — whether the endpoint answers
   * and which candidate model works, BEFORE gathering PR/JIRA context. Advances
   * through the fallback chain on "unknown model" and latches the winner so the
   * real review call skips re-probing. Throws a clear error if none respond.
   */
  async verifyConnection(timeoutMs: number = DEFAULT_PREFLIGHT_TIMEOUT_MS): Promise<ConnectionCheckResult> {
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
        const stream = this.client.messages.stream(
          {
            model,
            max_tokens: 16,
            temperature: 0,
            messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
          } as unknown as Anthropic.MessageStreamParams,
          { signal: abortController.signal },
        );
        stream.on('error', () => { /* delivered via finalMessage() rejection */ });
        const msg = await stream.finalMessage();
        clearTimeout(timeoutId);

        const latencyMs = Date.now() - t0;
        if (!this.resolvedModel) {
          this.resolvedModel = model;
        }
        core.info(
          `Pre-flight OK: ${model} answered in ${(latencyMs / 1000).toFixed(1)}s `
          + `(${msg.usage.output_tokens} out tok). Proceeding.`,
        );
        return { model, latencyMs, outputTokens: msg.usage.output_tokens };
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
      + `(~${Math.ceil(inputChars / 4).toLocaleString()} tok est), `
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
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    // Extended thinking for deeper reasoning. The budget is added on top of
    // max_tokens (so it never starves the text output) and stays >= the 1024
    // floor the API requires. When thinking is on, temperature must be 1.
    const thinkingBudget = Math.max(this.thinkingBudget, 1024);
    const useThinking = this.supportsThinking(model);
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
      let firstEventMs = 0;
      let timedOut = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, options.timeout);
      const elapsedSec = (): number => Math.round((Date.now() - attemptStart) / 1000);

      try {
        const requestParams: Record<string, unknown> = {
          model,
          max_tokens: options.maxTokens + (useThinking ? thinkingBudget : 0),
          ...(systemMessage ? { system: systemMessage.content } : {}),
          messages: conversationMessages,
        };

        if (useThinking) {
          requestParams.thinking = {
            type: 'enabled',
            budget_tokens: thinkingBudget,
          };
          // Temperature must be 1 when thinking is enabled
          requestParams.temperature = 1;
        } else {
          requestParams.temperature = options.temperature;
        }

        core.info(
          `Calling ${model} (attempt ${attempt + 1}/${this.maxRetries + 1}, `
          + `thinking=${useThinking ? `on/${thinkingBudget}tok` : 'off'})…`,
        );

        // Stream the response and accumulate the final message. Streaming is
        // required whenever max_tokens is large enough that the SDK estimates
        // the request could exceed 10 minutes (max_tokens > ~21k, which the
        // combined-mode floor + thinking budget reaches) — the non-streaming
        // create() throws "Streaming is strongly recommended..." before ever
        // hitting the network. finalMessage() returns the same Message shape.
        const stream = this.client.messages.stream(
          requestParams as unknown as Anthropic.MessageStreamParams,
          {
            signal: abortController.signal,
          },
        );

        // Observe streamed deltas. With thinking enabled the model emits thinking
        // tokens first (often for a long time) before any text — counting both
        // keeps the heartbeat honest instead of reporting "no output" while it
        // reasons. The 'error' listener prevents an unhandled-event crash; the
        // rejection is still delivered via finalMessage() below.
        stream.on('thinking', (delta: string) => {
          if (!firstEventMs) firstEventMs = Date.now() - attemptStart;
          thinkingChars += delta.length;
        });
        stream.on('text', (delta: string) => {
          if (!firstEventMs) firstEventMs = Date.now() - attemptStart;
          textChars += delta.length;
        });
        stream.on('error', () => { /* delivered via finalMessage() rejection */ });

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

        const response = await stream.finalMessage();

        // Extract text content (skip thinking blocks)
        const content = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        core.info(
          `${model} responded in ${elapsedSec()}s `
          + `(${response.usage.input_tokens} in / ${response.usage.output_tokens} out tok, `
          + `stop_reason=${response.stop_reason ?? 'n/a'}`
          + `${stream.request_id ? `, request_id=${stream.request_id}` : ''})`,
        );

        return {
          content,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          stopReason: response.stop_reason,
        };
      } catch (error: unknown) {
        const attemptSec = elapsedSec();
        if (timedOut) {
          // Our own AbortController fired at options.timeout — surface that plainly
          // instead of the SDK's opaque "Request was aborted", with what we did get.
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
          this.disableThinking = true;
          continue;
        }

        // A timeout is terminal: a retry just burns another full timeout window on
        // the same slow call. Report it clearly and stop trying this model.
        if (timedOut) {
          core.warning(`${model} attempt ${attempt + 1}: ${lastError.message}`);
          break;
        }

        if (this.isRetryableError(error) && attempt < this.maxRetries) {
          const isRateLimit = error instanceof Anthropic.APIError && error.status === 429;

          // Check for Retry-After header from Anthropic
          let retryAfterMs = 0;
          if (error instanceof Anthropic.APIError && error.headers) {
            const retryAfter = error.headers['retry-after'];
            if (retryAfter) {
              retryAfterMs = parseInt(retryAfter, 10) * 1000;
            }
          }

          // Rate limit (429): use Retry-After header, or 30s, 60s, 90s, 120s
          // Other transient errors: 2s, 4s, 8s
          const delayMs = retryAfterMs > 0
            ? retryAfterMs
            : isRateLimit
              ? (attempt + 1) * 30000
              : Math.pow(2, attempt + 1) * 1000;
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

  private disableThinking = false;

  private supportsThinking(modelName: string): boolean {
    if (this.disableThinking) return false;
    // Extended thinking is supported on Claude 3.5+/4+ and GLM-4.5+/5.x. If a
    // provider rejects the thinking param, isThinkingUnsupportedError() below
    // triggers a one-time retry without it.
    const model = modelName.toLowerCase();
    return model.includes('claude-3') || model.includes('claude-opus')
      || model.includes('claude-sonnet') || model.includes('claude-haiku')
      || model.includes('glm');
  }

  private isThinkingUnsupportedError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError) {
      // 400 with "thinking" in message means the model/provider doesn't support it
      return error.status === 400 && (
        error.message.includes('thinking') || error.message.includes('budget_tokens')
      );
    }
    return false;
  }

  /**
   * True when a model was rejected because the endpoint doesn't recognise it —
   * the trigger to fall back to the next candidate. Matches Anthropic's
   * not_found_error and z.ai/GLM's `[1211] Unknown Model, please check the model
   * code.` Works on both raw APIErrors and the wrapped retry error (string match).
   */
  private isUnknownModelError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError && error.status === 404) return true;
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return msg.includes('unknown model')
      || msg.includes('check the model code')
      || msg.includes('1211')
      || msg.includes('not_found_error')
      || (msg.includes('model') && msg.includes('does not exist'))
      || (msg.includes('model') && msg.includes('not found'));
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError) {
      // 429=rate limit, 500/502/503=transient server errors, 529=overloaded
      return [429, 500, 502, 503, 529].includes(error.status);
    }
    // Retry on timeout (AbortController) and network errors
    if (error instanceof Error) {
      return error.name === 'AbortError' || error.message.includes('ECONNRESET')
        || error.message.includes('ETIMEDOUT') || error.message.includes('fetch failed');
    }
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
