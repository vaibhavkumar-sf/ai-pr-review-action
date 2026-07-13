import { ComprehensiveAgent } from '../../src/agents/comprehensive.agent';
import { AIProvider, ChatMessage, ChatOptions, ChatResponse, ConnectionCheckResult } from '../../src/providers/ai-provider';
import { OUTPUT_TOKENS_CEILING } from '../../src/config/limits';
import { makeChangedFile, makeConfig, makeContext } from '../fixtures/factory';

// Silence @actions/core logging; the agent warns on every auto-heal step.
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  setSecret: jest.fn(),
}));

/** Replays a scripted sequence of responses and records every call's options. */
class ScriptedProvider implements AIProvider {
  readonly calls: Array<{ messages: ChatMessage[]; options: ChatOptions }> = [];
  constructor(private responses: ChatResponse[]) {}

  async chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResponse> {
    this.calls.push({ messages, options });
    return this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
  }
  async logDiagnostics(): Promise<void> { /* not used */ }
  async verifyConnection(): Promise<ConnectionCheckResult> {
    return { model: 'glm-5.2', latencyMs: 1, outputTokens: 1 };
  }
  getResolvedModel(): string { return 'glm-5.2'; }
}

const GOOD_JSON = JSON.stringify({ findings: [], summary: 'Looks solid.', score: 9 });

const good = (): ChatResponse =>
  ({ content: GOOD_JSON, inputTokens: 10, outputTokens: 50, stopReason: 'end_turn' });

/** A max_tokens stop with NO text — thinking consumed the entire output budget. */
const starved = (): ChatResponse =>
  ({ content: '', inputTokens: 10, outputTokens: 20480, stopReason: 'max_tokens' });

// ComprehensiveAgent floors a MANUAL max_tokens at COMBINED_MAX_TOKENS_FLOOR.
const MANUAL_BASE = 16384;

describe('BaseAgent auto output budget (max_tokens: 0)', () => {
  it('requests the model ceiling on a large-window model', async () => {
    const provider = new ScriptedProvider([good()]);
    const agent = new ComprehensiveAgent(provider, makeConfig()); // maxTokens: 0, window 1M

    const result = await agent.review(makeContext());

    expect(result.error).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].options.maxTokens).toBe(OUTPUT_TOKENS_CEILING);
    expect(provider.calls[0].options.maxTokensAuto).toBe(true);
  });

  it('retries once with thinking disabled when thinking starves even the ceiling', async () => {
    const provider = new ScriptedProvider([starved(), good()]);
    const agent = new ComprehensiveAgent(provider, makeConfig());

    const result = await agent.review(makeContext());

    expect(result.error).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].options.thinkingBudget).toBe(0);
    expect(provider.calls[1].options.maxTokens).toBe(OUTPUT_TOKENS_CEILING);
  });
});

describe('BaseAgent manual output budget escalation', () => {
  const manual = (): ReturnType<typeof makeConfig> => makeConfig({ maxTokens: 8192 });

  it('retries with thinking disabled and a doubled budget when thinking starves the output', async () => {
    const provider = new ScriptedProvider([starved(), good()]);
    const agent = new ComprehensiveAgent(provider, manual());

    const result = await agent.review(makeContext());

    expect(result.error).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].options.thinkingBudget).toBe(0);
    expect(provider.calls[1].options.maxTokens).toBe(MANUAL_BASE * 2);
  });

  it('keeps escalating up to the ceiling while responses stay truncated', async () => {
    const provider = new ScriptedProvider([starved(), starved(), starved(), good()]);
    const agent = new ComprehensiveAgent(provider, manual());

    const result = await agent.review(makeContext());

    expect(result.error).toBeUndefined();
    expect(provider.calls.slice(1).map(c => c.options.maxTokens)).toEqual([
      MANUAL_BASE * 2,
      MANUAL_BASE * 4,
      Math.min(MANUAL_BASE * 8, OUTPUT_TOKENS_CEILING),
    ]);
  });

  it('still uses the JSON-repair retry for non-truncated garbage', async () => {
    const provider = new ScriptedProvider([
      { content: 'Sorry, here is prose instead of JSON.', inputTokens: 10, outputTokens: 20, stopReason: 'end_turn' },
      good(),
    ]);
    const agent = new ComprehensiveAgent(provider, manual());

    const result = await agent.review(makeContext());

    expect(result.error).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
    // The repair conversation feeds the broken output back to the model.
    const repairMessages = provider.calls[1].messages;
    expect(repairMessages.some(m => m.role === 'assistant' && m.content.includes('prose'))).toBe(true);
  });

  it('reports an agent error when every retry stays unparseable', async () => {
    const provider = new ScriptedProvider([starved()]);
    const agent = new ComprehensiveAgent(provider, manual());

    const result = await agent.review(makeContext());

    expect(result.error).toBe('unparseable response (no JSON object)');
    expect(result.findings).toHaveLength(0);
    // initial + 3 escalations + 1 JSON-repair retry
    expect(provider.calls).toHaveLength(5);
  });
});

describe('BaseAgent auto-batching for huge PRs', () => {
  function hugeContext(fileCount: number, charsPerFile: number): ReturnType<typeof makeContext> {
    const files = Array.from({ length: fileCount }, (_, i) =>
      makeChangedFile({
        filename: `src/service/file-${i}.ts`,
        content: `// file ${i}\n${'x'.repeat(charsPerFile)}\n`,
      }));
    const diff = files
      .map(f => `diff --git a/${f.filename} b/${f.filename}\n+++ b/${f.filename}\n@@ -1 +1,2 @@\n+// changed\n`)
      .join('');
    return makeContext({ changedFiles: files, dependencyFiles: [], diff });
  }

  it('splits an oversized PR into multiple full-fidelity review calls and merges findings', async () => {
    // Small window forces batching: ~16k-token input budget vs 6 × 30k-char files.
    const config = makeConfig({ contextWindow: 60000 });
    const provider = new ScriptedProvider([good()]);
    const agent = new ComprehensiveAgent(provider, config);

    const context = hugeContext(6, 30000);
    const result = await agent.review(context);

    expect(result.error).toBeUndefined();
    expect(provider.calls.length).toBeGreaterThan(1);

    // Every file is reviewed exactly once, spread across the batches.
    const filesPerCall = provider.calls.map(c => {
      const prompt = c.messages.find(m => m.role === 'user')?.content ?? '';
      return context.changedFiles.filter(f => prompt.includes(f.filename)).map(f => f.filename);
    });
    const allSeen = filesPerCall.flat();
    expect(new Set(allSeen).size).toBe(6);
    expect(allSeen).toHaveLength(6);
    expect(filesPerCall.every(files => files.length < 6)).toBe(true);
  });

  it('keeps a normal-sized PR in a single call', async () => {
    const provider = new ScriptedProvider([good()]);
    const agent = new ComprehensiveAgent(provider, makeConfig());

    const result = await agent.review(makeContext());

    expect(result.error).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
  });
});
