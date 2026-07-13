import * as core from '@actions/core';
import { BaseAgent } from './base-agent';
import { ReviewCategory } from '../types';
import { coerceCategory, VALID_FINDING_CATEGORIES } from '../config/taxonomy';
import { COMBINED_MAX_TOKENS_FLOOR } from '../config/limits';

/**
 * Single all-at-once review agent used in combined mode (review_mode: combined).
 * Covers every review dimension in one AI call, but each finding keeps the
 * per-finding category the model assigned so downstream reporting (summary
 * tables, Backstage webhook) stays as granular as separate mode.
 */
export class ComprehensiveAgent extends BaseAgent {
  readonly name = 'comprehensive';
  readonly category: ReviewCategory = 'comprehensive';

  protected getMaxTokens(): number {
    // 0 = auto (the model's full capacity) — pass through untouched. A manual
    // cap is floored: one call returns ALL findings, and a low cap truncates
    // the JSON and loses everything.
    if (this.config.maxTokens === 0) return 0;
    return Math.max(this.config.maxTokens, COMBINED_MAX_TOKENS_FLOOR);
  }

  protected resolveCategory(raw: unknown): ReviewCategory {
    if (raw && !VALID_FINDING_CATEGORIES.has(String(raw))) {
      core.debug(`Comprehensive agent returned unknown category "${String(raw)}" — coerced to code-quality`);
    }
    return coerceCategory(raw);
  }
}
