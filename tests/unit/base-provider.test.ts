import { ChatMessage, ChatOptions, ChatResponse } from '../../src/providers/ai-provider';
import { BaseProvider, StreamObservers } from '../../src/providers/base-provider';

// Silence @actions/core logging; the provider logs heavily via core.info/warning.
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  setSecret: jest.fn(),
  debug: jest.fn(),
}));

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Handler = (ctx: {
  model: string;
  useThinking: boolean;
  options: ChatOptions;
  observers: StreamObservers;
  signal: AbortSignal;
  attempt: number;
}) => Promise<ChatResponse>;

const OK: ChatResponse = { content: 'ok', inputTokens: 1, outputTokens: 2, stopReason: 'end_turn' };

/**
 * Minimal concrete provider that drives the shared engine. Error classification
 * keys off message substrings — deliberately, because chatWithModel wraps the
 * underlying error before chat() re-classifies it (unknown-model detection must
 * survive that wrapping, exactly as the real providers rely on).
 */
class FakeProvider extends BaseProvider {
  readonly calls: Array<{ model: string; useThinking: boolean; thinkingBudget: number }> = [];
  constructor(
    models: string[],
    maxRetries: number,
    thinkingBudget: number,
    private handler: Handler,
  ) {
    super('https://endpoint.test', 'key', models, maxRetries, thinkingBudget);
  }
  protected async streamOnce(
    model: string, _messages: ChatMessage[], options: ChatOptions,
    useThinking: boolean, thinkingBudget: number, observers: StreamObservers, signal: AbortSignal,
  ): Promise<ChatResponse> {
    this.calls.push({ model, useThinking, thinkingBudget });
    return this.handler({ model, useThinking, options, observers, signal, attempt: this.calls.length });
  }
  protected async probe(): Promise<{ outputTokens: number }> { return { outputTokens: 1 }; }
  protected async listModels(): Promise<string[]> { return []; }
  protected curlHint(): string { return 'curl'; }
  protected isUnknownModelError(e: unknown): boolean { return /UNKNOWN_MODEL/.test(msg(e)); }
  protected isRetryableError(e: unknown): boolean { return /RETRYABLE|RATE_LIMIT/.test(msg(e)); }
  protected isThinkingUnsupportedError(e: unknown): boolean { return /NO_THINKING/.test(msg(e)); }
  protected getRetryAfterMs(e: unknown): number { return /RATE_LIMIT/.test(msg(e)) ? 5 : 0; }
  protected isRateLimitError(e: unknown): boolean { return /RATE_LIMIT/.test(msg(e)); }
}

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const OPTS: ChatOptions = { maxTokens: 100, temperature: 0.1, timeout: 5000 };

describe('BaseProvider engine', () => {
  it('falls back through the model chain on unknown-model and latches the winner', async () => {
    const provider = new FakeProvider(['bad', 'good'], 2, 4096, async ({ model }) => {
      if (model === 'bad') throw new Error('UNKNOWN_MODEL: nope');
      return OK;
    });

    const res = await provider.chat(MESSAGES, OPTS);
    expect(res.content).toBe('ok');
    expect(provider.getResolvedModel()).toBe('good');

    // A subsequent call uses ONLY the latched model — the bad one is never retried.
    const before = provider.calls.length;
    await provider.chat(MESSAGES, OPTS);
    expect(provider.calls.slice(before).every(c => c.model === 'good')).toBe(true);
  });

  it('retries once without thinking when the endpoint rejects the thinking param', async () => {
    const provider = new FakeProvider(['glm-5.2'], 2, 4096, async ({ useThinking }) => {
      if (useThinking) throw new Error('NO_THINKING: unsupported');
      return OK;
    });

    const res = await provider.chat(MESSAGES, OPTS);
    expect(res.content).toBe('ok');
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].useThinking).toBe(true);
    expect(provider.calls[1].useThinking).toBe(false);
  });

  it('treats a timeout as terminal — no retry burns another window', async () => {
    const provider = new FakeProvider(['good'], 3, 0, ({ signal }) =>
      new Promise<ChatResponse>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }));

    await expect(provider.chat(MESSAGES, { ...OPTS, timeout: 50 })).rejects.toThrow(/timed out/);
    expect(provider.calls).toHaveLength(1);
  });

  it('retries a transient/rate-limit error then succeeds', async () => {
    let n = 0;
    const provider = new FakeProvider(['good'], 2, 0, async () => {
      n += 1;
      if (n === 1) throw new Error('RATE_LIMIT: 429');
      return OK;
    });

    const res = await provider.chat(MESSAGES, OPTS);
    expect(res.content).toBe('ok');
    expect(provider.calls).toHaveLength(2);
  });

  it('retries 429s on their own patient budget, far beyond max_retries', async () => {
    let n = 0;
    const provider = new FakeProvider(['good'], 1, 0, async () => {
      n += 1;
      if (n <= 6) throw new Error('RATE_LIMIT: 429');
      return OK;
    });

    // maxRetries=1 would allow only 2 attempts; the rate-limit budget keeps going.
    const res = await provider.chat(MESSAGES, OPTS);
    expect(res.content).toBe('ok');
    expect(provider.calls).toHaveLength(7);
  });

  it('transient (non-429) errors still respect the max_retries budget', async () => {
    const provider = new FakeProvider(['good'], 0, 0, async () => {
      throw new Error('RETRYABLE: 503');
    });
    await expect(provider.chat(MESSAGES, OPTS)).rejects.toThrow(/failed after 1 attempt/);
    expect(provider.calls).toHaveLength(1);
  });

  it('gives up with a clear error once the 429 budget is exhausted', async () => {
    const provider = new FakeProvider(['good'], 0, 0, async () => {
      throw new Error('RATE_LIMIT: 429');
    });
    // RATE_LIMIT_MAX_ATTEMPTS retries + the initial attempt = 401 calls.
    await expect(provider.chat(MESSAGES, OPTS)).rejects.toThrow(/failed after 401 attempt/);
    expect(provider.calls).toHaveLength(401);
  }, 60000);

  it('throws a clear error when every candidate is rejected as unknown', async () => {
    const provider = new FakeProvider(['a', 'b'], 1, 0, async () => {
      throw new Error('UNKNOWN_MODEL');
    });
    await expect(provider.chat(MESSAGES, OPTS)).rejects.toThrow(/rejected as unknown/);
  });

  it('verifyConnection latches the first working model', async () => {
    const provider = new FakeProvider(['x'], 1, 0, async () => OK);
    const result = await provider.verifyConnection(1000);
    expect(result.model).toBe('x');
    expect(provider.getResolvedModel()).toBe('x');
  });
});
