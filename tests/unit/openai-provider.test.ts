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

  it('sends response_format json_object when jsonMode is set without tools', async () => {
    const fetchMock = jest.fn().mockResolvedValue(sseResponse([{ choices: [{ delta: { content: 'x' } }] }]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { observers } = collector();
    const provider = new TestOpenAI('https://api.test/', 'key', ['glm-5.2'], 0, 4096);
    await provider.run('glm-5.2', MESSAGES, { ...OPTS, jsonMode: true }, false, 0, observers, new AbortController().signal);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('suppresses json_object mode on a tool turn (a tool call must be allowed)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(sseResponse([{ choices: [{ delta: { content: 'x' } }] }]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { observers } = collector();
    const provider = new TestOpenAI('https://api.test/', 'key', ['glm-5.2'], 0, 4096);
    await provider.run(
      'glm-5.2', MESSAGES,
      { ...OPTS, jsonMode: true, tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' } }] },
      false, 0, observers, new AbortController().signal,
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format).toBeUndefined();
    expect(body.tools).toBeDefined();
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

describe('OpenAIProvider tool calling', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('accumulates fragmented tool_calls by index and normalizes the stop reason', async () => {
    global.fetch = jest.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'grep', arguments: '{"pat' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] },
    ])) as unknown as typeof fetch;

    const { observers } = collector();
    const provider = new TestOpenAI('https://api.test', 'key', ['m'], 0, 0);
    const res = await provider.run('m', MESSAGES, OPTS, false, 0, observers, new AbortController().signal);

    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toEqual([
      { id: 'c1', name: 'grep', input: { pattern: 'x' } },
      { id: 'c2', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  });

  it('sends tools and maps tool-loop transcript messages to the OpenAI wire shapes', async () => {
    const fetchMock = jest.fn().mockResolvedValue(sseResponse([{ choices: [{ delta: { content: 'x' } }] }]));
    global.fetch = fetchMock as unknown as typeof fetch;

    const { observers } = collector();
    const provider = new TestOpenAI('https://api.test', 'key', ['m'], 0, 0);
    const transcript: ChatMessage[] = [
      { role: 'user', content: 'review this' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'grep', input: { pattern: 'x' } }] },
      { role: 'tool', content: 'match', toolCallId: 'c1' },
    ];
    await provider.run('m', transcript, {
      ...OPTS,
      tools: [{ name: 'grep', description: 'search', inputSchema: { type: 'object' } }],
    }, false, 0, observers, new AbortController().signal);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object' } } },
    ]);
    expect(body.messages[1].tool_calls[0]).toEqual(
      { id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } },
    );
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'match' });
  });
});

describe('OpenAIProvider error classification', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  const classifier = (): { isRateLimitError(e: unknown): boolean; isRetryableError(e: unknown): boolean } =>
    new TestOpenAI('https://api.test', 'key', ['m'], 0, 0) as unknown as {
      isRateLimitError(e: unknown): boolean; isRetryableError(e: unknown): boolean;
    };

  it('classifies HTTP 529 (overloaded) as a capacity error → patient retry schedule', async () => {
    global.fetch = jest.fn().mockResolvedValue(errorResponse(529)) as unknown as typeof fetch;

    const { observers } = collector();
    const provider = new TestOpenAI('https://api.test', 'key', ['m'], 0, 0);
    const err = await provider
      .run('m', MESSAGES, OPTS, false, 0, observers, new AbortController().signal)
      .catch((e: Error) => e);

    expect(classifier().isRateLimitError(err)).toBe(true);
    expect(classifier().isRetryableError(err)).toBe(true);
  });

  it('classifies a body-reported overload with a non-529 status as capacity too', () => {
    const c = classifier();
    expect(c.isRateLimitError(new Error(
      '500 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][The service may be temporarily overloaded, please try again later]"}}',
    ))).toBe(true);
    expect(c.isRateLimitError(new Error('HTTP 400: bad request'))).toBe(false);
  });
});
