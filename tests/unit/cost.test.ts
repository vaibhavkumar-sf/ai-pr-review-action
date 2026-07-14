import { estimateCost, parseModelPricing } from '../../src/results/cost';
import { ModelUsage } from '../../src/providers/ai-provider';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

describe('parseModelPricing', () => {
  it('parses model=input/output pairs, including bracketed model names', () => {
    const pricing = parseModelPricing('glm-5.2=0.6/2.2, glm-5.2[1m]=1/3');
    expect(pricing.get('glm-5.2')).toEqual({ inputPerMTok: 0.6, outputPerMTok: 2.2 });
    expect(pricing.get('glm-5.2[1m]')).toEqual({ inputPerMTok: 1, outputPerMTok: 3 });
  });

  it('skips malformed entries with a warning instead of failing', () => {
    const core = jest.requireMock('@actions/core') as { warning: jest.Mock };
    core.warning.mockClear();
    const pricing = parseModelPricing('glm-5.2=0.6/2.2,broken,also=bad/,=1/2,neg=-1/2');
    expect(pricing.size).toBe(1);
    expect(core.warning).toHaveBeenCalledTimes(4);
  });

  it('returns an empty table for the empty default', () => {
    expect(parseModelPricing('').size).toBe(0);
  });
});

describe('estimateCost', () => {
  const usage: ModelUsage[] = [
    { model: 'glm-5.2', calls: 6, inputTokens: 1_000_000, outputTokens: 100_000 },
    { model: 'claude-opus-4-8', calls: 1, inputTokens: 200_000, outputTokens: 10_000 },
  ];

  it('totals tokens and prices covered models', () => {
    const cost = estimateCost(usage, parseModelPricing('glm-5.2=0.6/2.2,claude-opus-4-8=15/75'));
    expect(cost.totalCalls).toBe(7);
    expect(cost.totalInputTokens).toBe(1_200_000);
    expect(cost.totalOutputTokens).toBe(110_000);
    // glm: 1M×0.6/1M + 0.1M×2.2/1M = 0.82; opus: 0.2M×15/1M + 0.01M×75/1M = 3.75
    expect(cost.estimatedCostUsd).toBeCloseTo(4.57, 6);
    expect(cost.unpricedModels).toEqual([]);
  });

  it('reports a partial estimate when some used models are unpriced', () => {
    const cost = estimateCost(usage, parseModelPricing('glm-5.2=0.6/2.2'));
    expect(cost.estimatedCostUsd).toBeCloseTo(0.82, 6);
    expect(cost.unpricedModels).toEqual(['claude-opus-4-8']);
  });

  it('returns null cost (tokens still totaled) with no pricing at all', () => {
    const cost = estimateCost(usage, parseModelPricing(''));
    expect(cost.estimatedCostUsd).toBeNull();
    expect(cost.totalInputTokens).toBe(1_200_000);
    expect(cost.unpricedModels).toHaveLength(2);
  });
});
