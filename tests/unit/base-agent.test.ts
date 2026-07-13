import { ComprehensiveAgent } from '../../src/agents/comprehensive.agent';
import { AIProvider, ChatMessage, ChatOptions, ChatResponse, ConnectionCheckResult } from '../../src/providers/ai-provider';
import { OUTPUT_TOKENS_CEILING } from '../../src/config/limits';
import { makeConfig, makeContext } from '../fixtures/factory';

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

// ComprehensiveAgent floors max_tokens at COMBINED_MAX_TOKENS_FLOOR (16384).
const BASE_TOKENS = 16384;

describe('BaseAgent output-budget escalation', () => {
  it('retries with thinking disabled and a doubled budget when thinking starves the output', async () => {
    const provider = new ScriptedProvider([starved(), good()]);
    const agent = new ComprehensiveAgent(provider, makeConfig());

    const result = await agent.review(makeContext());

    expect(result.error).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].options.thinkingBudget).toBe(0);
    expect(provider.calls[1].options.maxTokens).toBe(BASE_TOKENS * 2);
  });

  it('keeps escalating up to the ceiling while responses stay truncated', async () => {
    const provider = new ScriptedProvider([starved(), starved(), starved(), good()]);
    const agent = new ComprehensiveAgent(provider, makeConfig());

    const result = await agent.review(makeContext());

    expect(result.error).toBeUndefined();
    expect(provider.calls.slice(1).map(c => c.options.maxTokens)).toEqual([
      BASE_TOKENS * 2,
      BASE_TOKENS * 4,
      Math.min(BASE_TOKENS * 8, OUTPUT_TOKENS_CEILING),
    ]);
  });

  it('still uses the JSON-repair retry for non-truncated garbage', async () => {
    const provider = new ScriptedProvider([
      { content: 'Sorry, here is prose instead of JSON.', inputTokens: 10, outputTokens: 20, stopReason: 'end_turn' },
      good(),
    ]);
    const agent = new ComprehensiveAgent(provider, makeConfig());

    const result = await agent.review(makeContext());

    expect(result.error).toBeUndefined();
    expect(provider.calls).toHaveLength(2);
    // The repair conversation feeds the broken output back to the model.
    const repairMessages = provider.calls[1].messages;
    expect(repairMessages.some(m => m.role === 'assistant' && m.content.includes('prose'))).toBe(true);
  });

  it('reports an agent error when every retry stays unparseable', async () => {
    const provider = new ScriptedProvider([starved()]);
    const agent = new ComprehensiveAgent(provider, makeConfig());

    const result = await agent.review(makeContext());

    expect(result.error).toBe('unparseable response (no JSON object)');
    expect(result.findings).toHaveLength(0);
    // initial + 3 escalations + 1 JSON-repair retry
    expect(provider.calls).toHaveLength(5);
  });
});
