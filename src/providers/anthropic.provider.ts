import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, ChatMessage, ChatOptions, ChatResponse } from './ai-provider';
import * as core from '@actions/core';

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  private maxRetries: number;
  private baseUrl: string;

  constructor(baseUrl: string, apiKey: string, model: string, maxRetries: number) {
    this.client = new Anthropic({
      baseURL: baseUrl,
      apiKey,
    });
    this.model = model;
    this.maxRetries = maxRetries;
    this.baseUrl = baseUrl;
  }

  /**
   * Logs which model and endpoint are actually in use, and best-effort lists the
   * models the endpoint advertises. Fault-tolerant: never throws. Helpful when a
   * request fails with "Unknown Model" — the list reveals the exact accepted ids
   * (e.g. a z.ai/GLM endpoint lists glm-* ids and only maps Claude-tier names).
   */
  async logDiagnostics(): Promise<void> {
    core.info(`AI model requested: ${this.model}`);
    let host = this.baseUrl;
    try {
      host = new URL(this.baseUrl).host;
    } catch {
      // keep the raw value if it is not a parseable URL
    }
    core.info(`AI endpoint: ${host}`);

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

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    // Enable extended thinking for deeper reasoning
    // When thinking is enabled, temperature must be 1 (Anthropic requirement)
    const thinkingBudget = Math.min(options.maxTokens, 8192);
    const useThinking = this.supportsThinking();

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), options.timeout);

        try {
          const requestParams: Record<string, unknown> = {
            model: this.model,
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
          const response = await stream.finalMessage();

          // Extract text content (skip thinking blocks)
          const content = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');

          return {
            content,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            stopReason: response.stop_reason,
          };
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // If thinking fails (unsupported model/provider), retry without it
        if (useThinking && attempt === 0 && this.isThinkingUnsupportedError(error)) {
          core.info('Extended thinking not supported, falling back to standard mode');
          this.disableThinking = true;
          continue;
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
          core.info(`Retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${this.maxRetries})${isRateLimit ? ' — rate limited' : ''}`);
          await this.delay(delayMs);
          continue;
        }

        if (!this.isRetryableError(error)) {
          break;
        }
      }
    }

    throw new Error(
      `Anthropic API call failed after ${this.maxRetries + 1} attempts: ${lastError?.message ?? 'Unknown error'}`,
    );
  }

  private disableThinking = false;

  private supportsThinking(): boolean {
    if (this.disableThinking) return false;
    // Extended thinking is supported on Claude 3.5+/4+ and GLM-4.5+/5.x. If a
    // provider rejects the thinking param, isThinkingUnsupportedError() below
    // triggers a one-time retry without it.
    const model = this.model.toLowerCase();
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
