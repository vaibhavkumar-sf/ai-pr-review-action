import { ReviewCategory } from '../types';
import { AIProvider } from '../providers/ai-provider';
import { ActionConfig } from '../types';
import { BaseAgent } from './base-agent';
import { SPECIALIST_CATEGORY_IDS } from '../config/taxonomy';

/**
 * Specialist agents are pure data: each is a BaseAgent whose name/category is
 * one specialist category and whose review criteria live in prompts/<name>.md.
 * Adding a specialist = one taxonomy entry + one prompt file.
 */
class SpecialistAgent extends BaseAgent {
  constructor(
    readonly name: string,
    readonly category: ReviewCategory,
    provider: AIProvider,
    config: ActionConfig,
  ) {
    super(provider, config);
  }
}

/** Instantiates every specialist agent (callers filter by enabled categories). */
export function createSpecialistAgents(provider: AIProvider, config: ActionConfig): BaseAgent[] {
  return SPECIALIST_CATEGORY_IDS.map(
    category => new SpecialistAgent(category, category, provider, config),
  );
}
