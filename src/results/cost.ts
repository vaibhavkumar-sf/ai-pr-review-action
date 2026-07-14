import * as core from '@actions/core';
import { ModelUsage } from '../providers/ai-provider';
import { USD_PER_MILLION_TOKENS_DIVISOR } from '../config/limits';

/**
 * Client-side cost estimation from the run's token usage and a user-supplied
 * price table — the same approach the Claude Agent SDK uses for its
 * total_cost_usd (no AI API returns USD). Estimates only, never billing data;
 * with no price table configured the run still reports tokens, just no USD.
 */

/** USD prices for one model, per MILLION tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface CostEstimate {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** null when no used model has a configured price. */
  estimatedCostUsd: number | null;
  /** Models that consumed tokens but have no price entry (cost is partial). */
  unpricedModels: string[];
}

/**
 * Parses the model_pricing input: comma-separated `model=input/output` pairs,
 * prices in USD per million tokens (e.g. `glm-5.2=0.6/2.2,glm-5.2[1m]=1/3`).
 * Malformed entries are skipped with a warning — pricing must never fail a run.
 */
export function parseModelPricing(spec: string): Map<string, ModelPrice> {
  const pricing = new Map<string, ModelPrice>();
  for (const entry of spec.split(',').map(e => e.trim()).filter(Boolean)) {
    const eq = entry.lastIndexOf('=');
    const model = eq > 0 ? entry.slice(0, eq).trim() : '';
    const [inStr, outStr] = eq > 0 ? entry.slice(eq + 1).split('/') : [];
    const inputPerMTok = Number(inStr);
    const outputPerMTok = Number(outStr);
    if (!model || !isFinite(inputPerMTok) || !isFinite(outputPerMTok) || inputPerMTok < 0 || outputPerMTok < 0) {
      core.warning(`Ignoring malformed model_pricing entry "${entry}" — expected model=input/output (USD per 1M tokens)`);
      continue;
    }
    pricing.set(model, { inputPerMTok, outputPerMTok });
  }
  return pricing;
}

/**
 * Totals the run's usage and prices it. Models without a price entry are
 * excluded from the USD figure and reported in unpricedModels so the display
 * can say the estimate is partial.
 */
export function estimateCost(usage: ModelUsage[], pricing: Map<string, ModelPrice>): CostEstimate {
  let totalCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let costUsd = 0;
  let anyPriced = false;
  const unpricedModels: string[] = [];

  for (const u of usage) {
    totalCalls += u.calls;
    totalInputTokens += u.inputTokens;
    totalOutputTokens += u.outputTokens;
    const price = pricing.get(u.model);
    if (price) {
      anyPriced = true;
      costUsd += (u.inputTokens * price.inputPerMTok + u.outputTokens * price.outputPerMTok)
        / USD_PER_MILLION_TOKENS_DIVISOR;
    } else {
      unpricedModels.push(u.model);
    }
  }

  return {
    totalCalls,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd: anyPriced ? costUsd : null,
    unpricedModels,
  };
}
