import * as core from '@actions/core';
import { ActionConfig, Framework, ReviewContext } from '../types';
import { gatherPRContext } from './pr-context';
import { gatherJiraContext } from './jira-context';
import { gatherRepoContext } from './repo-context';

export { gatherPRContext } from './pr-context';
export { gatherJiraContext } from './jira-context';
export { gatherRepoContext } from './repo-context';

/**
 * Gathers all context needed for a PR review.
 *
 * - PR context is required and will throw on failure.
 * - JIRA and repo context are fault-tolerant and gathered in parallel.
 */
export async function gatherAllContext(config: ActionConfig): Promise<ReviewContext> {
  // 1. Gather PR context — this is required and CAN throw
  core.info('Gathering PR context...');
  const prContext = await gatherPRContext(config);

  // 2. Gather JIRA and repo context in parallel — both are fault-tolerant
  core.info('Gathering JIRA and repo context in parallel...');
  const [jiraResult, repoResult] = await Promise.allSettled([
    gatherJiraContext(config, prContext.headBranch, prContext.prTitle, prContext.prBody),
    gatherRepoContext(config, prContext.changedFiles),
  ]);

  // Extract JIRA context (already fault-tolerant, but allSettled adds another layer)
  let jiraContext = null;
  if (jiraResult.status === 'fulfilled') {
    jiraContext = jiraResult.value;
  } else {
    core.warning(`JIRA context gathering failed unexpectedly: ${jiraResult.reason}`);
  }

  // Extract repo context with a sensible default
  let repoContext: ReviewContext['repoContext'] = {
    claudeMdContent: null,
    detectedFramework: 'generic' as Framework,
    hasAngularJson: false,
    hasLoopbackDeps: false,
  };
  if (repoResult.status === 'fulfilled') {
    repoContext = repoResult.value;
  } else {
    core.warning(`Repo context gathering failed unexpectedly: ${repoResult.reason}`);
  }

  // 3. Resolve final framework
  let framework: Framework;
  if (config.framework !== 'auto') {
    // User explicitly chose a framework
    framework = config.framework;
    core.info(`Using user-configured framework: ${framework}`);
  } else {
    // Auto-detect from repo signals
    framework = repoContext.detectedFramework;
    core.info(`Auto-detected framework: ${framework}`);
  }

  // 4. Assemble and return the complete ReviewContext
  const reviewContext: ReviewContext = {
    prNumber: config.prNumber,
    prTitle: prContext.prTitle,
    prBody: prContext.prBody,
    prAuthor: prContext.prAuthor,
    baseBranch: prContext.baseBranch,
    headBranch: prContext.headBranch,
    headSha: prContext.headSha,
    diff: prContext.diff,
    changedFiles: prContext.changedFiles,
    dependencyFiles: prContext.dependencyFiles,
    jiraContext,
    repoContext,
    framework,
  };

  core.info(
    `Context gathering complete: ${reviewContext.changedFiles.length} files, ` +
      `framework=${framework}, jira=${jiraContext ? jiraContext.ticketId : 'none'}`,
  );

  return reviewContext;
}
