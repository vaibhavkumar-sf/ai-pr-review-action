import * as core from '@actions/core';
import { parseActionInputs } from './config/action-inputs';
import { runReview } from './orchestrator';
import { setDebug } from './utils/logger';

async function run(): Promise<void> {
  try {
    const config = parseActionInputs();
    setDebug(config.debug);

    core.info(`AI PR Review Action starting...`);
    core.info(`Profile: ${config.reviewProfile} | Model: ${config.anthropicModel}`);
    core.info(`Enabled agents: ${Array.from(config.enabledAgents).join(', ')}`);

    await runReview(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`AI PR Review Action failed: ${message}`);
  }
}

run();
