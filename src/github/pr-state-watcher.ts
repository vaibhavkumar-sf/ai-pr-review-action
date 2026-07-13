import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ActionConfig } from '../types';
import { PR_STATE_POLL_INTERVAL_MS } from '../config/limits';
import { reportRunOutcome } from '../results/backstage-reporter';

/**
 * Watches the PR while the review runs and cancels the action the moment the
 * PR is closed or merged — reviewing a dead PR wastes runner minutes and AI
 * quota (especially under the patient 429 retry budget, where a single run
 * can legitimately wait a long time).
 *
 * Exit is NEUTRAL (code 0): a merged/closed PR must not get a red ❌ from a
 * review that simply became pointless. Best-effort by design: poll errors are
 * ignored, and the timer is unref'd so it never keeps the process alive after
 * a normal finish.
 */
export function startPrStateWatcher(octokit: Octokit, config: ActionConfig): () => void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return; // a slow API answer must not stack polls
    inFlight = true;
    void checkOnce(octokit, config).finally(() => { inFlight = false; });
  }, PR_STATE_POLL_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function checkOnce(octokit: Octokit, config: ActionConfig): Promise<void> {
  try {
    const { data } = await octokit.pulls.get({
      owner: config.owner,
      repo: config.repo,
      pull_number: config.prNumber,
    });
    if (data.state === 'open') return;

    const how = data.merged ? 'merged' : 'closed';
    core.warning(
      `PR #${config.prNumber} was ${how} while the review was still running — `
      + 'cancelling the run to free the runner and AI quota (cancel_on_pr_close: true).',
    );
    core.setOutput('review_status', 'cancelled');
    core.setOutput('skip_reason', `pr_${how}`);
    if (config.postDataUrl) {
      await reportRunOutcome(config, 'cancelled', `pr_${how}`);
    }
    process.exit(0);
  } catch (error) {
    // Never let telemetry kill a healthy run — a poll failure is just skipped.
    core.debug(
      `PR state poll failed (ignored): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
