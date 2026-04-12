import Anthropic from '@anthropic-ai/sdk';
import { AIProvider, ChatMessage, ChatOptions, ChatResponse } from './ai-provider';
import * as core from '@actions/core';

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  private model: string;
  private maxRetries: number;

  constructor(baseUrl: string, apiKey: string, model: string, maxRetries: number) {
    this.client = new Anthropic({
      baseURL: baseUrl,
      apiKey,
    });
    this.model = model;
    this.maxRetries = maxRetries;
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

          const response = await this.client.messages.create(
            requestParams as unknown as Anthropic.MessageCreateParamsNonStreaming,
            {
              signal: abortController.signal,
            },
          );

          // Extract text content (skip thinking blocks)
          const content = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');

          return {
            content,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
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
          const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
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
    // Extended thinking is supported on Claude 3.5+ and Claude 4+ models
    const model = this.model.toLowerCase();
    return model.includes('claude-3') || model.includes('claude-opus')
      || model.includes('claude-sonnet') || model.includes('claude-haiku');
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
