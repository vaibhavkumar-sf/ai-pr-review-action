import { AIProvider } from '../providers/ai-provider';
import { ActionConfig } from '../types';
import { BaseAgent } from './base-agent';
import { SecurityAgent } from './security.agent';
import { CodeQualityAgent } from './code-quality.agent';
import { PerformanceAgent } from './performance.agent';
import { TypeSafetyAgent } from './type-safety.agent';
import { ArchitectureAgent } from './architecture.agent';
import { TestingAgent } from './testing.agent';
import { ApiDesignAgent } from './api-design.agent';

export { BaseAgent } from './base-agent';
export { SecurityAgent } from './security.agent';
export { CodeQualityAgent } from './code-quality.agent';
export { PerformanceAgent } from './performance.agent';
export { TypeSafetyAgent } from './type-safety.agent';
export { ArchitectureAgent } from './architecture.agent';
export { TestingAgent } from './testing.agent';
export { ApiDesignAgent } from './api-design.agent';

/**
 * Creates agent instances for all enabled review categories.
 *
 * The full set of agents is instantiated and then filtered to only those
 * whose category appears in `config.enabledAgents`.
 */
export function createAgents(provider: AIProvider, config: ActionConfig): BaseAgent[] {
  const allAgents: BaseAgent[] = [
    new SecurityAgent(provider, config),
    new CodeQualityAgent(provider, config),
    new PerformanceAgent(provider, config),
    new TypeSafetyAgent(provider, config),
    new ArchitectureAgent(provider, config),
    new TestingAgent(provider, config),
    new ApiDesignAgent(provider, config),
  ];

  return allAgents.filter(agent => config.enabledAgents.has(agent.category));
}
