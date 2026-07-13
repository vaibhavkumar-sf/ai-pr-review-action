import { ChatMessage, ChatOptions, ChatResponse } from './ai-provider';
import { BaseProvider, extractAdvertisedOutputCap, StreamObservers } from './base-provider';
import { PREFLIGHT_MAX_TOKENS, PREFLIGHT_TEMPERATURE, RETRYABLE_HTTP_STATUS } from '../config/limits';

/**
 * OpenAI-dialect adapter: raw fetch + SSE streaming against any
 * /chat/completions endpoint (OpenAI, OpenRouter, z.ai coding API, vLLM,
 * Ollama, …). No SDK dependency. All retry/fallback/heartbeat behavior lives
 * in BaseProvider.
 *
 * Reasoning models: `delta.reasoning_content` (z.ai/DeepSeek convention) and
 * `delta.reasoning` (OpenRouter convention) both feed the thinking heartbeat.
 * When a thinking budget is set, a best-effort `thinking` extension is sent
 * (z.ai coding endpoint accepts it); endpoints that reject it trigger the
 * base class's one-time no-thinking fallback.
 */

/** Error carrying the HTTP status/body of a failed chat/completions call. */
class OpenAIHttpError extends Error {
  constructor(readonly status: number, body: string, readonly retryAfterHeader: string | null) {
    super(`HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = 'OpenAIHttpError';
  }
}

interface SseDelta {
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  /** Fragmented tool calls: id/name arrive on the first fragment of an index,
   *  `function.arguments` concatenates across fragments. */
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export class OpenAIProvider extends BaseProvider {
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string, models: string[], maxRetries: number, thinkingBudget: number) {
    super(baseUrl, apiKey, models, maxRetries, thinkingBudget);
    this.apiKey = apiKey;
  }

  private endpoint(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
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
    // options.maxTokens is the FINAL output budget: BaseProvider.chatWithModel
    // already added the thinking allowance and clamped to the model's real capacity.
    const body: Record<string, unknown> = {
      model,
      // Tool-loop transcripts: assistant turns with toolCalls and role:'tool'
      // results map to the OpenAI wire shapes.
      messages: messages.map(m => {
        if (m.role === 'assistant' && m.toolCalls?.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map(call => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          };
        }
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
        }
        return { role: m.role, content: m.content };
      }),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.tools?.length) {
      body.tools = options.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    // JSON mode: forces syntactically-valid JSON on OpenAI-compatible endpoints
    // that support it (eliminates the malformed-JSON class at the source).
    // Not combined with tools — a tool turn must be free to emit a tool call.
    if (options.jsonMode && !options.tools?.length) {
      body.response_format = { type: 'json_object' };
    }
    if (useThinking) {
      // Vendor extension (z.ai coding endpoint); rejected → base class strips it.
      body.thinking = { type: 'enabled' };
    } else if (options.thinkingBudget === 0) {
      // Explicitly request no reasoning where supported; harmless elsewhere.
      body.thinking = { type: 'disabled' };
    }

    const response = await fetch(this.endpoint('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new OpenAIHttpError(response.status, text, response.headers.get('retry-after'));
    }

    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | null = null;
    // Tool-call fragments accumulate by index: id/name on the first fragment,
    // arguments concatenated across the rest.
    const toolCallParts = new Map<number, { id: string; name: string; args: string }>();

    // SSE parsing: split on newlines, each `data: {json}` line is a chunk,
    // `data: [DONE]` terminates the stream.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        let chunk: {
          choices?: Array<{ delta?: SseDelta; finish_reason?: string | null }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // tolerate malformed keep-alive lines
        }

        const choice = chunk.choices?.[0];
        if (choice?.delta) {
          const reasoning = choice.delta.reasoning_content ?? choice.delta.reasoning;
          if (reasoning) observers.onThinking(reasoning);
          if (choice.delta.content) {
            observers.onText(choice.delta.content);
            content += choice.delta.content;
          }
          for (const fragment of choice.delta.tool_calls ?? []) {
            const existing = toolCallParts.get(fragment.index);
            if (existing) {
              existing.args += fragment.function?.arguments ?? '';
            } else {
              toolCallParts.set(fragment.index, {
                id: fragment.id ?? `call_${fragment.index}`,
                name: fragment.function?.name ?? '',
                args: fragment.function?.arguments ?? '',
              });
              if (fragment.function?.name) observers.onToolUse?.(fragment.function.name);
            }
          }
        }
        if (choice?.finish_reason) stopReason = choice.finish_reason;
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
          outputTokens = chunk.usage.completion_tokens ?? outputTokens;
        }
      }
    }

    const toolCalls = [...toolCallParts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => {
        let input: Record<string, unknown> = {};
        try {
          input = part.args ? JSON.parse(part.args) : {};
        } catch {
          // malformed arguments — surface the raw string so the tool can complain
          input = { _raw: part.args };
        }
        return { id: part.id, name: part.name, input };
      });

    return {
      content,
      inputTokens,
      outputTokens,
      // Normalize the OpenAI dialect's 'tool_calls' to the shared 'tool_use'.
      stopReason: stopReason === 'tool_calls' ? 'tool_use' : stopReason,
      ...(toolCalls.length ? { toolCalls } : {}),
    };
  }

  protected async probe(model: string, signal: AbortSignal): Promise<{ outputTokens: number }> {
    const response = await fetch(this.endpoint('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model,
        max_tokens: PREFLIGHT_MAX_TOKENS,
        temperature: PREFLIGHT_TEMPERATURE,
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      }),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new OpenAIHttpError(response.status, text, response.headers.get('retry-after'));
    }
    const data = await response.json() as { usage?: { completion_tokens?: number } };
    return { outputTokens: data.usage?.completion_tokens ?? 0 };
  }

  protected async listModels(): Promise<string[]> {
    const response = await fetch(this.endpoint('/models'), { headers: this.headers() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { data?: Array<{ id: string }> };
    return (data.data ?? []).map(m => m.id);
  }

  protected curlHint(): string {
    return `curl -sS '${this.endpoint('/models')}' -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN"`;
  }

  protected isThinkingUnsupportedError(error: unknown): boolean {
    if (error instanceof OpenAIHttpError && error.status === 400) {
      const msg = error.message.toLowerCase();
      return msg.includes('thinking') || msg.includes('reasoning');
    }
    return false;
  }

  protected isUnknownModelError(error: unknown): boolean {
    if (error instanceof OpenAIHttpError && error.status === 404) return true;
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return msg.includes('unknown model')
      || msg.includes('check the model code')
      || msg.includes('1211')
      || msg.includes('model_not_found')
      || (msg.includes('model') && msg.includes('does not exist'))
      || (msg.includes('model') && msg.includes('not found'));
  }

  protected isRetryableError(error: unknown): boolean {
    if (error instanceof OpenAIHttpError) {
      return RETRYABLE_HTTP_STATUS.includes(error.status);
    }
    if (error instanceof Error) {
      return error.name === 'AbortError' || error.message.includes('ECONNRESET')
        || error.message.includes('ETIMEDOUT') || error.message.includes('fetch failed');
    }
    return false;
  }

  protected isRateLimitError(error: unknown): boolean {
    return error instanceof OpenAIHttpError && error.status === 429;
  }

  protected parseOutputCapError(error: unknown): number | null {
    if (!(error instanceof OpenAIHttpError) || error.status !== 400) return null;
    return extractAdvertisedOutputCap(error.message);
  }

  protected getRetryAfterMs(error: unknown): number {
    if (error instanceof OpenAIHttpError && error.retryAfterHeader) {
      const seconds = parseInt(error.retryAfterHeader, 10);
      if (!isNaN(seconds)) return seconds * 1000;
    }
    return 0;
  }
}
