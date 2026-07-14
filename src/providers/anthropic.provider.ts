import Anthropic from '@anthropic-ai/sdk';
import { ChatMessage, ChatOptions, ChatResponse } from './ai-provider';
import { BaseProvider, extractAdvertisedOutputCap, StreamObservers } from './base-provider';
import { CAPACITY_HTTP_STATUS, PREFLIGHT_MAX_TOKENS, PREFLIGHT_TEMPERATURE, RETRYABLE_HTTP_STATUS } from '../config/limits';

/**
 * Anthropic-dialect adapter (api.anthropic.com and compatible endpoints such
 * as z.ai's /api/anthropic). All retry/fallback/heartbeat behavior lives in
 * BaseProvider — this class only speaks the Messages API.
 */
export class AnthropicProvider extends BaseProvider {
  private client: Anthropic;

  constructor(baseUrl: string, apiKey: string, models: string[], maxRetries: number, thinkingBudget: number) {
    super(baseUrl, apiKey, models, maxRetries, thinkingBudget);
    this.client = new Anthropic({ baseURL: baseUrl, apiKey });
  }

  protected async streamOnce(
    model: string,
    messages: ChatMessage[],
    options: ChatOptions,
    useThinking: boolean,
    thinkingBudget: number,
    observers: StreamObservers,
    signal: AbortSignal,
  ): Promise<ChatResponse> {
    const systemMessage = messages.find((m) => m.role === 'system');
    // Tool-loop transcripts carry structured turns: assistant messages with
    // toolCalls become tool_use content blocks; role:'tool' results become
    // user messages with tool_result blocks (the Messages API shape).
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return {
            role: 'assistant' as const,
            content: [
              ...(m.content ? [{ type: 'text', text: m.content }] : []),
              ...m.toolCalls.map((call) => ({
                type: 'tool_use', id: call.id, name: call.name, input: call.input,
              })),
            ],
          };
        }
        if (m.role === 'tool') {
          return {
            role: 'user' as const,
            content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
          };
        }
        return { role: m.role as 'user' | 'assistant', content: m.content };
      });

    // options.maxTokens is the FINAL output budget: BaseProvider.chatWithModel
    // already added the thinking allowance and clamped to the model's real
    // capacity. When thinking is on, the API requires temperature 1.
    const requestParams: Record<string, unknown> = {
      model,
      max_tokens: options.maxTokens,
      ...(systemMessage ? { system: systemMessage.content } : {}),
      messages: conversationMessages,
      ...(options.tools?.length
        ? {
            tools: options.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
          }
        : {}),
    };

    if (useThinking) {
      requestParams.thinking = {
        type: 'enabled',
        budget_tokens: thinkingBudget,
      };
      requestParams.temperature = 1;
    } else {
      requestParams.temperature = options.temperature;
    }

    // Stream the response and accumulate the final message. Streaming is
    // required whenever max_tokens is large enough that the SDK estimates
    // the request could exceed 10 minutes — the non-streaming create() throws
    // "Streaming is strongly recommended..." before ever hitting the network.
    const stream = this.client.messages.stream(
      requestParams as unknown as Anthropic.MessageStreamParams,
      { signal },
    );

    // With thinking enabled the model emits thinking tokens first (often for a
    // long time) before any text — observing both keeps the heartbeat honest.
    // The 'error' listener prevents an unhandled-event crash; the rejection is
    // still delivered via finalMessage() below.
    stream.on('thinking', (delta: string) => observers.onThinking(delta));
    stream.on('text', (delta: string) => observers.onText(delta));
    stream.on('contentBlock', (block: Anthropic.ContentBlock) => {
      if (block.type === 'tool_use') observers.onToolUse?.(block.name);
    });
    stream.on('error', () => { /* delivered via finalMessage() rejection */ });

    const response = await stream.finalMessage();

    // Extract text content (skip thinking blocks)
    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Tool calls the model requested (stop_reason 'tool_use').
    const toolCalls = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      }));

    return {
      content,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }

  protected async probe(model: string, signal: AbortSignal): Promise<{ outputTokens: number }> {
    const stream = this.client.messages.stream(
      {
        model,
        max_tokens: PREFLIGHT_MAX_TOKENS,
        temperature: PREFLIGHT_TEMPERATURE,
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      } as unknown as Anthropic.MessageStreamParams,
      { signal },
    );
    stream.on('error', () => { /* delivered via finalMessage() rejection */ });
    const msg = await stream.finalMessage();
    return { outputTokens: msg.usage.output_tokens };
  }

  protected async listModels(): Promise<string[]> {
    // Anthropic-compatible endpoints expose GET /v1/models.
    const models = await this.client.models.list();
    return models.data.map((m) => m.id);
  }

  protected curlHint(): string {
    const modelsUrl = `${this.baseUrl.replace(/\/+$/, '')}/v1/models`;
    return `curl -sS '${modelsUrl}' -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" -H "anthropic-version: 2023-06-01"`;
  }

  protected isThinkingUnsupportedError(error: unknown): boolean {
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
  protected isUnknownModelError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError && error.status === 404) return true;
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return msg.includes('unknown model')
      || msg.includes('check the model code')
      || msg.includes('1211')
      || msg.includes('not_found_error')
      || (msg.includes('model') && msg.includes('does not exist'))
      || (msg.includes('model') && msg.includes('not found'));
  }

  protected isRetryableError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError) {
      return RETRYABLE_HTTP_STATUS.includes(error.status);
    }
    // Retry on timeout (AbortController) and network errors
    if (error instanceof Error) {
      return error.name === 'AbortError' || error.message.includes('ECONNRESET')
        || error.message.includes('ETIMEDOUT') || error.message.includes('fetch failed');
    }
    return false;
  }

  protected isRateLimitError(error: unknown): boolean {
    if (error instanceof Anthropic.APIError && CAPACITY_HTTP_STATUS.includes(error.status)) return true;
    // Some gateways report overload in the body with a non-529 status.
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return msg.includes('overloaded_error') || msg.includes('temporarily overloaded');
  }

  protected parseOutputCapError(error: unknown): number | null {
    if (!(error instanceof Anthropic.APIError) || error.status !== 400) return null;
    return extractAdvertisedOutputCap(error.message);
  }

  protected getRetryAfterMs(error: unknown): number {
    if (error instanceof Anthropic.APIError && error.headers) {
      const retryAfter = error.headers['retry-after'];
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) return seconds * 1000;
      }
    }
    return 0;
  }
}
