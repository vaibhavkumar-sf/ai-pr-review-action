import { AnthropicProvider } from '../../src/providers/anthropic.provider';
import { StreamObservers } from '../../src/providers/base-provider';

/**
 * Locks the raw-stream usage capture: z.ai-style Anthropic-compatible
 * endpoints report input_tokens only in the final message_delta event, which
 * the SDK's snapshot accumulator discards (it copies only output_tokens), so
 * finalMessage() alone would report 0 input tokens.
 */

type Handler = (...args: unknown[]) => void;

function fakeStream(events: Array<Record<string, unknown>>, finalUsage: { input_tokens: number; output_tokens: number }) {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, cb: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
      return this;
    },
    async finalMessage() {
      for (const event of events) {
        for (const cb of handlers.get('streamEvent') ?? []) cb(event);
      }
      return {
        content: [{ type: 'text', text: 'ok' }],
        usage: finalUsage,
        stop_reason: 'end_turn',
      };
    },
  };
}

const observers: StreamObservers = { onThinking: () => {}, onText: () => {} };

function providerWith(stream: ReturnType<typeof fakeStream>) {
  const provider = new AnthropicProvider('https://api.example.com', 'key', ['glm-5.2'], 1, 0);
  (provider as unknown as { client: { messages: { stream: () => unknown } } }).client = {
    messages: { stream: () => stream },
  };
  return provider as unknown as {
    streamOnce(
      model: string,
      messages: Array<{ role: string; content: string }>,
      options: { maxTokens: number; temperature: number },
      useThinking: boolean,
      thinkingBudget: number,
      observers: StreamObservers,
      signal: AbortSignal,
    ): Promise<{ inputTokens: number; outputTokens: number }>;
  };
}

describe('AnthropicProvider stream usage capture', () => {
  it('recovers input_tokens reported only in the final message_delta (z.ai style)', async () => {
    const stream = fakeStream(
      [
        { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 4321, output_tokens: 100 } },
      ],
      { input_tokens: 0, output_tokens: 100 }, // what the SDK accumulator would produce
    );
    const provider = providerWith(stream);

    const result = await provider.streamOnce(
      'glm-5.2', [{ role: 'user', content: 'hi' }],
      { maxTokens: 100, temperature: 0 }, false, 0, observers, new AbortController().signal,
    );

    expect(result.inputTokens).toBe(4321);
    expect(result.outputTokens).toBe(100);
  });

  it('keeps the SDK-reported input_tokens when message_start already carried them', async () => {
    const stream = fakeStream(
      [
        { type: 'message_start', message: { usage: { input_tokens: 900, output_tokens: 0 } } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } },
      ],
      { input_tokens: 900, output_tokens: 50 },
    );
    const provider = providerWith(stream);

    const result = await provider.streamOnce(
      'glm-5.2', [{ role: 'user', content: 'hi' }],
      { maxTokens: 100, temperature: 0 }, false, 0, observers, new AbortController().signal,
    );

    expect(result.inputTokens).toBe(900);
    expect(result.outputTokens).toBe(50);
  });
});
