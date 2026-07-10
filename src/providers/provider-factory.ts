import { ActionConfig } from '../types';
import { AIProvider } from './ai-provider';
import { AnthropicProvider } from './anthropic.provider';

export function createAIProvider(config: ActionConfig): AIProvider {
  // anthropicModel may be a comma-separated fallback chain (tried in order).
  const models = config.anthropicModel
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return new AnthropicProvider(
    config.anthropicBaseUrl,
    config.anthropicAuthToken,
    models,
    config.maxRetries,
    config.thinkingBudget,
  );
}
