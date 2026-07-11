import { AIProvider } from '../providers/ai-provider';
import { ActionConfig } from '../types';
import { BaseAgent } from './base-agent';
import { createSpecialistAgents } from './specialists';
import { ComprehensiveAgent } from './comprehensive.agent';

export { BaseAgent } from './base-agent';
export { ComprehensiveAgent } from './comprehensive.agent';
export { createSpecialistAgents } from './specialists';

/**
 * Creates agent instances for all enabled review categories.
 *
 * In combined mode a single comprehensive agent covers every category.
 * In separate mode all specialists are instantiated and then filtered to
 * those whose category appears in `config.enabledAgents`.
 */
export function createAgents(provider: AIProvider, config: ActionConfig): BaseAgent[] {
  if (config.reviewMode === 'combined') {
    return [new ComprehensiveAgent(provider, config)];
  }

  return createSpecialistAgents(provider, config)
    .filter(agent => config.enabledAgents.has(agent.category));
}
