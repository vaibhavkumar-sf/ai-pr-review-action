import * as core from '@actions/core';
import { parseActionInputs } from './config/inputs';
import { runReview } from './pipeline/orchestrator';
import { setDebug } from './utils/logger';

async function run(): Promise<void> {
  try {
    const config = parseActionInputs();
    setDebug(config.debug);

    core.info('AI PR Review Action starting...');
    core.info(`Mode: ${config.reviewMode} | Provider: ${config.aiProvider} | Model: ${config.anthropicModel}`);

    await runReview(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`AI PR Review Action failed: ${message}`);
  }
}

run();
