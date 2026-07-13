import { ChatMessage, ChatOptions } from '../../src/providers/ai-provider';
import { StreamObservers } from '../../src/providers/base-provider';
import { OpenAIProvider } from '../../src/providers/openai.provider';

/** Exposes the protected streamOnce so SSE parsing can be tested directly. */
class TestOpenAI extends OpenAIProvider {
  run(
    model: string, messages: ChatMessage[], options: ChatOptions,
    useThinking: boolean, thinkingBudget: number, observers: StreamObservers, signal: AbortSignal,
  ) {
    return this['streamOnce'](model, messages, options, useThinking, thinkingBudget, observers, signal);
  }
}

type SseEvent = Record<string, unknown>;

function sseResponse(events: SseEvent[]): unknown {
  const enc = new TextEncoder();
  const chunks = events.map(e => enc.encode(`data: ${JSON.stringify(e)}\n\n`));
  chunks.push(enc.encode('data: [DONE]\n\n'));
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () => i < chunks.length
          ? Promise.resolve({ done: false, value: chunks[i++] })
          : Promise.resolve({ done: true, value: undefined }),
      }),
    },
    text: () => Promise.resolve(''),
  };
}

function errorResponse(status: number, retryAfter: string | null = null): unknown {
  return {
    ok: false,
    status,
    headers: { get: (h: string) => (h === 'retry-after' ? retryAfter : null) },
    text: () => Promise.resolve('boom'),
  };
}

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const OPTS: ChatOptions = { maxTokens: 100, temperature: 0.1, timeout: 5000 };

function collector() {
  const state = { thinking: '', text: '' };
  const observers: StreamObservers = {
    onThinking: (d) => { state.thinking += d; },
    onText: (d) => { state.text += d; },
  };
  return { state, observers };
}

describe('OpenAIProvider SSE parsing', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('concatenates content, routes reasoning to thinking, and reads usage', async () => {
    global.fetch = jest.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 11, completion_tokens: 7 } },
    ])) as unknown as typeof fetch;

    const { state, observers } = collector();
    const provider = new TestOpenAI('https://api.test', 'key', ['m'], 0, 0);
    const res = await provider.run('m', MESSAGES, OPTS, false, 0, observers, new AbortController().signal);

    expect(res.content).toBe('Hello');
    expect(state.thinking).toBe('think');
    expect(res.inputTokens).toBe(11);
    expect(res.outputTokens).toBe(7);
    expect(res.stopReason).toBe('stop');
  });

  it('sends stream + usage + thinking extension and passes max_tokens through verbatim', async () => {
    const fetchMock = jest.fn().mockResolvedValue(sseResponse([{ choices: [{ delta: { content: 'x' } }] }]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { observers } = collector();
    const provider = new TestOpenAI('https://api.test/', 'key', ['glm-5.2'], 0, 4096);
    await provider.run('glm-5.2', MESSAGES, { ...OPTS, temperature: 0.5 }, true, 4096, observers, new AbortController().signal);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/chat/completions'); // trailing slash normalized
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.stream_options.include_usage).toBe(true);
    expect(body.thinking).toEqual({ type: 'enabled' });
    // The thinking allowance and capacity clamp are applied ONCE in
    // BaseProvider.chatWithModel; the dialect sends the final value as-is.
    expect(body.max_tokens).toBe(100);
  });

  it('throws an OpenAIHttpError carrying status and retry-after on a non-2xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue(errorResponse(429, '2')) as unknown as typeof fetch;

    const { observers } = collector();
    const provider = new TestOpenAI('https://api.test', 'key', ['m'], 0, 0);
    const err = await provider
      .run('m', MESSAGES, OPTS, false, 0, observers, new AbortController().signal)
      .catch((e: Error) => e) as Error & { status?: number; retryAfterHeader?: string | null };

    expect(err.name).toBe('OpenAIHttpError');
    expect(err.message).toMatch(/HTTP 429/);
    expect(err.status).toBe(429);
    expect(err.retryAfterHeader).toBe('2');
  });
});
