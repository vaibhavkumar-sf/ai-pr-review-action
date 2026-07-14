import { ChatMessage, ChatOptions, ChatResponse } from '../../src/providers/ai-provider';
import { BaseProvider, extractAdvertisedOutputCap, rateLimitBackoffMs, StreamObservers } from '../../src/providers/base-provider';
import {
  OUTPUT_TOKENS_CEILING,
  PREFLIGHT_HANG_MAX_RETRIES,
  RATE_LIMIT_RETRY_DELAY_MAX_MS,
  RATE_LIMIT_RETRY_DELAY_MS,
} from '../../src/config/limits';

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
  probeHandler?: (signal: AbortSignal) => Promise<{ outputTokens: number }>;
  protected async probe(_model: string, signal: AbortSignal): Promise<{ outputTokens: number }> {
    return this.probeHandler ? this.probeHandler(signal) : { outputTokens: 1 };
  }
  // Backoff schedules (10s, 15s, …) must not slow the suite down.
  protected delay(_ms: number): Promise<void> {
    return Promise.resolve();
  }
  protected async listModels(): Promise<string[]> { return []; }
  protected curlHint(): string { return 'curl'; }
  protected isUnknownModelError(e: unknown): boolean { return /UNKNOWN_MODEL/.test(msg(e)); }
  protected isRetryableError(e: unknown): boolean { return /RETRYABLE|RATE_LIMIT/.test(msg(e)); }
  protected isThinkingUnsupportedError(e: unknown): boolean { return /NO_THINKING/.test(msg(e)); }
  protected getRetryAfterMs(e: unknown): number { return /RATE_LIMIT/.test(msg(e)) ? 5 : 0; }
  protected isRateLimitError(e: unknown): boolean { return /RATE_LIMIT/.test(msg(e)); }
  protected parseOutputCapError(e: unknown): number | null {
    const m = msg(e).match(/OUTPUT_CAP:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
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
    await expect(provider.chat(MESSAGES, OPTS)).rejects.toThrow(/All candidate models failed/);
  });

  it('falls back to the next model when one exhausts its transient retries, and latches the winner', async () => {
    const provider = new FakeProvider(['flaky', 'solid'], 1, 0, async ({ model }) => {
      if (model === 'flaky') throw new Error('RETRYABLE: 529 overloaded');
      return OK;
    });

    const res = await provider.chat(MESSAGES, OPTS);
    expect(res.content).toBe('ok');
    // flaky: initial attempt + maxRetries=1 retry, then the chain advances.
    expect(provider.calls.map(c => c.model)).toEqual(['flaky', 'flaky', 'solid']);
    expect(provider.getResolvedModel()).toBe('solid');

    // The winner is latched: the next call goes straight to it.
    await provider.chat(MESSAGES, OPTS);
    expect(provider.calls[provider.calls.length - 1].model).toBe('solid');
  });

  it('falls back past an already-latched model when it starts failing mid-run', async () => {
    let healthy = true;
    const provider = new FakeProvider(['primary', 'backup'], 0, 0, async ({ model }) => {
      if (model === 'primary' && !healthy) throw new Error('RETRYABLE: 529 overloaded');
      return OK;
    });

    await provider.chat(MESSAGES, OPTS); // latches primary
    expect(provider.getResolvedModel()).toBe('primary');

    healthy = false; // overload storm begins mid-run
    const res = await provider.chat(MESSAGES, OPTS);
    expect(res.content).toBe('ok');
    expect(provider.getResolvedModel()).toBe('backup');
  });

  it('does NOT fall back on a non-retryable (request-shaped) error', async () => {
    const provider = new FakeProvider(['a', 'b'], 2, 0, async ({ model }) => {
      if (model === 'a') throw new Error('FATAL: invalid request body');
      return OK;
    });

    await expect(provider.chat(MESSAGES, OPTS)).rejects.toThrow(/invalid request body/);
    expect(provider.calls.map(c => c.model)).toEqual(['a']); // b never tried
  });

  it('falls back to the next model after a timeout instead of failing the run', async () => {
    const provider = new FakeProvider(['slow', 'fast'], 3, 0, async ({ model, signal }) => {
      if (model === 'slow') {
        return new Promise<ChatResponse>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return OK;
    });

    const res = await provider.chat(MESSAGES, { ...OPTS, timeout: 50 });
    expect(res.content).toBe('ok');
    // slow is tried exactly once (no same-model timeout retry), then fast.
    expect(provider.calls.map(c => c.model)).toEqual(['slow', 'fast']);
  });

  it('verifyConnection latches the first working model', async () => {
    const provider = new FakeProvider(['x'], 1, 0, async () => OK);
    const result = await provider.verifyConnection(1000);
    expect(result.model).toBe('x');
    expect(provider.getResolvedModel()).toBe('x');
  });

  it('pre-flight waits out 429s instead of failing the run', async () => {
    let probes = 0;
    const provider = new FakeProvider(['x'], 0, 0, async () => OK);
    provider.probeHandler = async () => {
      probes += 1;
      if (probes <= 3) throw new Error('RATE_LIMIT: 429');
      return { outputTokens: 1 };
    };

    const result = await provider.verifyConnection(1000);
    expect(result.model).toBe('x');
    expect(probes).toBe(4);
  });

  it('pre-flight retries a hung probe (no first token) and succeeds when the endpoint recovers', async () => {
    let probes = 0;
    const provider = new FakeProvider(['x'], 0, 0, async () => OK);
    provider.probeHandler = async (signal) => {
      probes += 1;
      if (probes <= 2) {
        // Hang: never resolve; reject only when verifyConnection's timeout aborts.
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return { outputTokens: 1 };
    };

    const result = await provider.verifyConnection(30);
    expect(result.model).toBe('x');
    expect(probes).toBe(3);
  });

  it('pre-flight gives up with a clear error once the hang budget is exhausted', async () => {
    let probes = 0;
    const provider = new FakeProvider(['x'], 0, 0, async () => OK);
    provider.probeHandler = async (signal) => {
      probes += 1;
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };

    await expect(provider.verifyConnection(30)).rejects.toThrow(/did not respond within/);
    expect(probes).toBe(PREFLIGHT_HANG_MAX_RETRIES + 1);
  });

  it('pre-flight still fails fast on non-rate-limit errors', async () => {
    const provider = new FakeProvider(['x'], 0, 0, async () => OK);
    provider.probeHandler = async () => { throw new Error('401 unauthorized'); };

    await expect(provider.verifyConnection(1000)).rejects.toThrow(/pre-flight check failed/);
  });

  it('pre-flight tries the next chain candidate after a terminal probe failure', async () => {
    const probed: string[] = [];
    const provider = new FakeProvider(['down', 'up'], 0, 0, async () => OK);
    provider.probeHandler = async () => {
      // FakeProvider.probe ignores the model, so track order by call count.
      probed.push(probed.length === 0 ? 'down' : 'up');
      if (probed.length === 1) throw new Error('502 bad gateway upstream');
      return { outputTokens: 1 };
    };

    const result = await provider.verifyConnection(1000);
    expect(result.model).toBe('up');
    expect(probed).toEqual(['down', 'up']);
  });

  it('clamps the sent output budget to the assumed ceiling', async () => {
    const seen: number[] = [];
    const provider = new FakeProvider(['good'], 0, 0, async ({ options }) => {
      seen.push(options.maxTokens);
      return OK;
    });

    await provider.chat(MESSAGES, { ...OPTS, maxTokens: 500000 });
    expect(seen).toEqual([OUTPUT_TOKENS_CEILING]);
  });

  it('discovers a smaller endpoint output cap from the rejection, retries clamped, and latches it', async () => {
    const seen: number[] = [];
    const provider = new FakeProvider(['good'], 0, 0, async ({ options }) => {
      seen.push(options.maxTokens);
      if (options.maxTokens > 64000) throw new Error('OUTPUT_CAP:64000');
      return OK;
    });

    const res = await provider.chat(MESSAGES, { ...OPTS, maxTokens: 200000 });
    expect(res.content).toBe('ok');
    expect(seen).toEqual([OUTPUT_TOKENS_CEILING, 64000]);

    // The discovered cap is latched: the next call is clamped up front.
    await provider.chat(MESSAGES, { ...OPTS, maxTokens: 200000 });
    expect(seen[2]).toBe(64000);
  });
});

describe('rateLimitBackoffMs', () => {
  it('escalates from the base delay and caps at the maximum', () => {
    expect(rateLimitBackoffMs(0)).toBe(RATE_LIMIT_RETRY_DELAY_MS);
    expect(rateLimitBackoffMs(1)).toBe(15000);
    expect(rateLimitBackoffMs(2)).toBe(22500);
    // Monotonic non-decreasing, and eventually pinned at the cap.
    for (let i = 1; i < 30; i++) {
      expect(rateLimitBackoffMs(i)).toBeGreaterThanOrEqual(rateLimitBackoffMs(i - 1));
    }
    expect(rateLimitBackoffMs(29)).toBe(RATE_LIMIT_RETRY_DELAY_MAX_MS);
  });
});

describe('extractAdvertisedOutputCap', () => {
  it('parses the Anthropic-style rejection', () => {
    expect(extractAdvertisedOutputCap(
      'max_tokens: 131072 > 64000, which is the maximum allowed number of output tokens for claude-opus-4-8',
    )).toBe(64000);
  });

  it('parses the OpenAI-style rejection', () => {
    expect(extractAdvertisedOutputCap(
      'max_tokens is too large: 131072. This model supports at most 16384 completion tokens',
    )).toBe(16384);
  });

  it('ignores context-length errors', () => {
    expect(extractAdvertisedOutputCap(
      "This model's maximum context length is 200000 tokens. However, your messages resulted in 250000 tokens",
    )).toBeNull();
  });
});

describe('BaseProvider.chatWithTools (bounded tool loop)', () => {
  const TOOL = { name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } };
  const toolUse = (calls: Array<{ id: string; name: string; input: Record<string, unknown> }>): ChatResponse =>
    ({ content: '', inputTokens: 1, outputTokens: 1, stopReason: 'tool_use', toolCalls: calls });

  it('executes requested tools in parallel and feeds results back until the model answers', async () => {
    const provider = new FakeProvider(['m'], 2, 0, async ({ attempt, options }) => {
      if (attempt === 1) {
        expect(options.tools).toHaveLength(1);
        return toolUse([{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }]);
      }
      return OK;
    });
    const executed: string[] = [];

    const { response, transcript } = await provider.chatWithTools(
      MESSAGES, OPTS, [TOOL],
      async (call) => { executed.push(call.name); return 'file body'; },
      { maxRounds: 2, maxCalls: 6 },
    );

    expect(response.content).toBe('ok');
    expect(executed).toEqual(['read_file']);
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(transcript[1].toolCalls).toHaveLength(1);
    expect(transcript[2].content).toBe('file body');
    expect(transcript[2].toolCallId).toBe('t1');
  });

  it('forces a tool-less final turn once rounds are exhausted, guaranteeing an answer', async () => {
    const toolsSeen: boolean[] = [];
    const provider = new FakeProvider(['m'], 2, 0, async ({ options }) => {
      toolsSeen.push(Boolean(options.tools?.length));
      if (options.tools?.length) {
        return toolUse([{ id: 't1', name: 'read_file', input: {} }]);
      }
      return OK; // without tools the model must answer
    });

    const { response } = await provider.chatWithTools(
      MESSAGES, OPTS, [TOOL], async () => 'x', { maxRounds: 1, maxCalls: 6 },
    );

    expect(response.content).toBe('ok');
    expect(toolsSeen).toEqual([true, false]);
  });

  it('grants only the remaining call budget and answers denied calls with a budget message', async () => {
    const provider = new FakeProvider(['m'], 2, 0, async ({ attempt }) => {
      if (attempt === 1) {
        return toolUse([
          { id: 'a', name: 'read_file', input: {} },
          { id: 'b', name: 'read_file', input: {} },
          { id: 'c', name: 'read_file', input: {} },
        ]);
      }
      return OK;
    });
    let executions = 0;

    const { transcript } = await provider.chatWithTools(
      MESSAGES, OPTS, [TOOL],
      async () => { executions++; return 'data'; },
      { maxRounds: 2, maxCalls: 2 },
    );

    expect(executions).toBe(2);
    const toolMessages = transcript.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[2].content).toContain('budget exhausted');
  });

  it('returns immediately when the model answers without requesting tools', async () => {
    const provider = new FakeProvider(['m'], 2, 0, async () => OK);

    const { response, transcript } = await provider.chatWithTools(
      MESSAGES, OPTS, [TOOL], async () => 'x', { maxRounds: 2, maxCalls: 6 },
    );

    expect(response.content).toBe('ok');
    expect(transcript).toEqual(MESSAGES);
    expect(provider.calls).toHaveLength(1);
  });
});
