import { ActionConfig } from '../types';
import { AIProvider } from './ai-provider';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAIProvider } from './openai.provider';
import { INPUTS } from '../config/schema';

/** Creates the provider for the configured API dialect. */
export function createAIProvider(config: ActionConfig): AIProvider {
  // anthropicModel may be a comma-separated fallback chain (tried in order).
  let models = config.anthropicModel
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  if (models.length === 0) {
    // Degenerate input (e.g. anthropic_model: ','): fall back to the schema
    // default chain rather than an arbitrary hardcoded model.
    const defaultChain = INPUTS.find(i => i.name === 'anthropic_model')?.default ?? '';
    models = defaultChain.split(',').map(m => m.trim()).filter(Boolean);
  }

  const Provider = config.aiProvider === 'openai' ? OpenAIProvider : AnthropicProvider;
  return new Provider(
    config.anthropicBaseUrl,
    config.anthropicAuthToken,
    models,
    config.maxRetries,
    config.thinkingBudget,
  );
}
