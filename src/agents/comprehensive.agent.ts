import * as core from '@actions/core';
import { BaseAgent } from './base-agent';
import { ReviewCategory } from '../types';
import { DEFAULT_COMBINED_MAX_TOKENS } from '../config/defaults';

const VALID_CATEGORIES = new Set<ReviewCategory>([
  'security',
  'code-quality',
  'performance',
  'type-safety',
  'architecture',
  'testing',
  'api-design',
]);

/**
 * Single all-at-once review agent used in combined mode (review_mode: combined).
 * Covers every review dimension in one AI call, but each finding keeps the
 * per-finding category the model assigned so downstream reporting (summary
 * tables, Backstage webhook) stays as granular as separate mode.
 */
export class ComprehensiveAgent extends BaseAgent {
  readonly name = 'comprehensive';
  readonly category: ReviewCategory = 'comprehensive';
  readonly displayName = 'Comprehensive';
  readonly icon = '🔎';

  protected getMaxTokens(): number {
    // One call returns all findings; a low cap truncates the JSON and loses everything
    return Math.max(this.config.maxTokens, DEFAULT_COMBINED_MAX_TOKENS);
  }

  protected resolveCategory(raw: unknown): ReviewCategory {
    const category = String(raw || '') as ReviewCategory;
    if (VALID_CATEGORIES.has(category)) return category;
    if (raw) {
      core.debug(`Comprehensive agent returned unknown category "${String(raw)}" — coerced to code-quality`);
    }
    return 'code-quality';
  }
}
