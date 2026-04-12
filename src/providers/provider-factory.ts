import { ActionConfig } from '../types';
import { AIProvider } from './ai-provider';
import { AnthropicProvider } from './anthropic.provider';

export function createAIProvider(config: ActionConfig): AIProvider {
  return new AnthropicProvider(
    config.anthropicBaseUrl,
    config.anthropicAuthToken,
    config.anthropicModel,
    config.maxRetries,
  );
}
