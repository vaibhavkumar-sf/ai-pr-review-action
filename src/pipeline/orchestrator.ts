import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ActionConfig, AgentResult, Finding, MergedReviewResult, ReviewContext } from '../types';
import { gatherAllContext } from '../context';
import { AIProvider } from '../providers/ai-provider';
import { createAIProvider } from '../providers/provider-factory';
import { BaseAgent, createAgents } from '../agents';
import { PRCommenter } from '../github/pr-commenter';
import { InlineReviewer } from '../github/inline-reviewer';
import { ReplyHandler } from '../github/reply-handler';
import { parseDiff } from '../github/diff-parser';
import { consolidateFindings, deduplicateFindings, formatReviewComment, formatTrackingMetrics, mergeResults } from '../results';
import { reportRunOutcome, reportToBackstage, RunActivityStats } from '../results/backstage-reporter';
import { appendToPRDescription } from './description-updater';
import { runPhase } from './phase';
import { isTestFile } from '../config/patterns';
import { INLINE_SEVERITIES } from '../config/taxonomy';
import { logger, writeJobSummary } from '../utils/logger';

/**
 * The review pipeline. Each phase runs through runPhase() for grouped logs,
 * timing, and the fail-safety policy (critical phases abort the run;
 * best-effort phases degrade with a warning).
 */
export async function runReview(config: ActionConfig): Promise<void> {
  const octokit = new Octokit({ auth: config.githubToken });
  const commenter = new PRCommenter(octokit, config.owner, config.repo, config.prNumber);

  try {
    await runPipeline(config, octokit, commenter);
  } catch (error) {
    // Telemetry sees failed runs too (fire-and-forget), then the error
    // propagates to index.ts → setFailed.
    const msg = error instanceof Error ? error.message : String(error);
    if (config.postDataUrl) {
      await reportRunOutcome(config, 'failed', msg);
    }
    throw error;
  }
}

async function runPipeline(config: ActionConfig, octokit: Octokit, commenter: PRCommenter): Promise<void> {
  // ── Phase 1: startup — progress comment + bot-comment cleanup ─────────────
  const botCommentsHidden = await runPhase('Startup', { critical: false }, async () => {
    await commenter.postOrUpdateComment('## ⏳ AI Code Review\n\nReview starting... gathering context.');
    logger.info('Posted initial progress comment');
    return config.enableBotCommentCleanup ? commenter.cleanupBotComments() : 0;
  }, 0);
  core.setOutput('bot_comments_hidden', botCommentsHidden);

  // ── Phase 2: AI pre-flight — verify the endpoint BEFORE expensive work ────
  // A hung or unreachable model should fail fast and loud here, not after a
  // multi-minute stall that silently yields zero findings. This probe also
  // resolves which model in the fallback chain works and latches it.
  const provider = createAIProvider(config);
  let preflightError: string | null = null;
  await runPhase('AI pre-flight', { critical: false }, async () => {
    await provider.logDiagnostics();
    await commenter.postOrUpdateComment('## 🔌 AI Code Review\n\nVerifying AI model connection...');
    try {
      const check = await provider.verifyConnection();
      logger.info(`AI connection verified: ${check.model} (${(check.latencyMs / 1000).toFixed(1)}s round-trip)`);
    } catch (error) {
      preflightError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    return undefined;
  }, undefined);

  if (preflightError !== null) {
    // Custom skip handling (not a throw): explain on the PR, mark outputs, fail.
    const msg: string = preflightError;
    await commenter.postOrUpdateComment(
      `## ❌ AI Code Review\n\nAI model connection check failed — not proceeding.\n\n` +
      `\`\`\`\n${msg}\n\`\`\`\n\n` +
      `The review was skipped to avoid gathering context against an unreachable model. ` +
      `Check the \`ANTHROPIC_BASE_URL\` / \`ANTHROPIC_AUTH_TOKEN\` secrets and the endpoint status, then re-run.`,
    );
    core.setOutput('review_status', 'failed');
    core.setOutput('skip_reason', 'ai_unreachable');
    if (config.postDataUrl) await reportRunOutcome(config, 'failed', 'ai_unreachable');
    core.setFailed(`AI pre-flight check failed: ${msg}`);
    return;
  }

  // ── Phase 3: context gathering (critical) ─────────────────────────────────
  const context = await runPhase('Context gathering', { critical: true }, async () => {
    try {
      const gathered = await gatherAllContext(config);
      await commenter.postOrUpdateComment('## 🔍 AI Code Review\n\n✅ Context gathered. Preparing agents...');
      logger.info(`Context gathered: ${gathered.changedFiles.length} files, framework=${gathered.framework}`);
      return gathered;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await commenter.postOrUpdateComment(`## ❌ AI Code Review\n\nFailed to gather context: ${msg}`);
      throw error;
    }
  });

  // ── Guards: file count and agent selection ────────────────────────────────
  if (context.changedFiles.length > config.maxFilesToReview) {
    await commenter.postOrUpdateComment(
      `## ⚠️ AI Code Review\n\n` +
      `This PR changes **${context.changedFiles.length}** files, which exceeds the configured ` +
      `maximum of **${config.maxFilesToReview}**.\n\n` +
      `Review skipped to avoid excessive processing. Adjust the \`max_files_to_review\` input ` +
      `if you want to review larger PRs.`,
    );
    core.warning(`Skipping review: ${context.changedFiles.length} files exceeds max of ${config.maxFilesToReview}`);
    core.setOutput('review_status', 'skipped');
    core.setOutput('skip_reason', 'too_many_files');
    if (config.postDataUrl) await reportRunOutcome(config, 'skipped', 'too_many_files');
    return;
  }

  const agents = createAgents(provider, config);
  if (agents.length === 0) {
    await commenter.postOrUpdateComment(
      '## ⚠️ AI Code Review\n\nNo agents are enabled for this review. Check your `review_profile` and agent toggle settings.',
    );
    core.warning('No agents enabled — nothing to review');
    core.setOutput('review_status', 'skipped');
    core.setOutput('skip_reason', 'no_agents');
    if (config.postDataUrl) await reportRunOutcome(config, 'skipped', 'no_agents');
    return;
  }

  // ── Phase 4: review agents (critical) ─────────────────────────────────────
  const agentResults = await runPhase('Review agents', { critical: true }, () =>
    runAgents(agents, context, commenter),
  );

  // Report the model actually used (after any fallback resolution) rather than
  // the raw candidate chain, so PR comments and Backstage record the real model.
  config.anthropicModel = provider.getResolvedModel();

  // ── Phase 5: dedup + consolidation + merge (critical) ─────────────────────
  const { merged, consolidated } = await runPhase('Consolidation', { critical: true }, () =>
    consolidateResults(agentResults, config, provider, commenter),
  );

  logger.info(
    `Review complete: ${merged.totalFindings} findings ` +
      `(${merged.criticalCount} critical, ${merged.highCount} high, ` +
      `${merged.mediumCount} medium, ${merged.lowCount} low, ${merged.nitCount} nit)`,
  );

  // ── Phase 6: summary comment (critical — the review's main deliverable) ───
  const finalComment = formatReviewComment(merged, config, context);
  const { commentId, commentUrl } = await runPhase('Summary comment', { critical: true }, async () => {
    const posted = await commenter.postOrUpdateComment(finalComment);
    logger.info('Posted final review comment');
    return posted;
  });
  core.setOutput('review_comment_id', commentId);
  core.setOutput('review_comment_url', commentUrl);

  // ── Phase 7: reply handling (best-effort) ─────────────────────────────────
  const replyResult = await runPhase('Reply handling', { critical: false }, async () => {
    if (!config.enableReplyHandling) return { repliesPosted: 0, threadsResolved: 0 };
    const replyHandler = new ReplyHandler(octokit, commenter, provider, config);
    return replyHandler.processReplies(context);
  }, { repliesPosted: 0, threadsResolved: 0 });
  core.setOutput('replies_posted', replyResult.repliesPosted);
  core.setOutput('threads_resolved_from_replies', replyResult.threadsResolved);

  // ── Phase 8: stale-thread resolution + inline comments (best-effort) ──────
  const inline = await runPhase('Inline comments', { critical: false }, () =>
    postInlineComments(octokit, config, context, consolidated, merged, commenter),
  { staleThreadsResolved: 0, inlineCommentsNew: 0, inlineCommentsExisting: 0 });

  const activity: RunActivityStats = {
    inlineCommentsNew: inline.inlineCommentsNew,
    inlineCommentsExisting: inline.inlineCommentsExisting,
    staleThreadsResolved: inline.staleThreadsResolved,
    repliesPosted: replyResult.repliesPosted,
    threadsResolvedFromReplies: replyResult.threadsResolved,
    botCommentsHidden,
  };

  // ── Phase 9: tracking metrics appended to the summary (best-effort) ───────
  await runPhase('Tracking metrics', { critical: false }, async () => {
    await commenter.postOrUpdateComment(finalComment + formatTrackingMetrics(merged, config, activity));
    return undefined;
  }, undefined);

  // ── Phase 10: PR description + diagrams (best-effort) ─────────────────────
  await runPhase('PR description', { critical: false }, async () => {
    await appendToPRDescription(octokit, config, merged, context, provider);
    logger.info('Updated PR description with AI summary');
    return undefined;
  }, undefined);

  // ── Outputs ────────────────────────────────────────────────────────────────
  core.setOutput('review_status', 'completed');
  core.setOutput('total_findings', merged.totalFindings);
  core.setOutput('critical_count', merged.criticalCount);
  core.setOutput('high_count', merged.highCount);
  core.setOutput('medium_count', merged.mediumCount);
  core.setOutput('low_count', merged.lowCount);
  core.setOutput('nit_count', merged.nitCount);
  core.setOutput('review_passed', merged.passed);
  core.setOutput('duration_seconds', Math.round(merged.durationMs / 1000));
  core.setOutput('agents_run', agents.map(a => a.name).join(','));
  core.setOutput('agents_failed', agentResults.filter(r => r.error).map(r => r.agentName).join(','));

  // ── Phase 11: Backstage telemetry (best-effort, fire-and-forget) ──────────
  if (config.postDataUrl) {
    const reported = await runPhase('Backstage report', { critical: false }, () =>
      reportToBackstage(config, merged, context, agentResults, activity),
    false);
    core.setOutput('backstage_reported', reported);
  }

  // ── Job summary (best-effort) ─────────────────────────────────────────────
  await writeJobSummary(buildJobSummary(config, merged, commentUrl, agentResults));

  // ── Fail threshold ─────────────────────────────────────────────────────────
  if (config.failOnCritical && !merged.passed) {
    core.setFailed(
      `Review failed: found ${merged.criticalCount} critical, ${merged.highCount} high, ` +
      `${merged.mediumCount} medium findings (threshold: ${config.failThreshold})`,
    );
  }
}

/** Launches all agents in parallel and collects their results fault-tolerantly. */
async function runAgents(
  agents: BaseAgent[],
  context: ReviewContext,
  commenter: PRCommenter,
): Promise<AgentResult[]> {
  logger.info(`Running ${agents.length} agents: ${agents.map(a => a.name).join(', ')}`);

  for (const agent of agents) {
    await commenter.updateProgress(agent.name, 'running');
  }

  const agentPromises = agents.map(async agent => {
    logger.info(`Agent ${agent.name} starting...`);
    const result = await agent.review(context);
    await commenter.updateProgress(agent.name, result.error ? 'failed' : 'done');
    logger.info(
      `Agent ${agent.name} completed in ${(result.durationMs / 1000).toFixed(1)}s ` +
        `with ${result.findings.length} findings` +
        (result.error ? ` (error: ${result.error})` : ''),
    );
    return result;
  });

  const settled = await Promise.allSettled(agentPromises);

  const agentResults: AgentResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      agentResults.push(outcome.value);
    } else {
      // BaseAgent.review() catches its own errors; this is a last-resort guard.
      const errMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      core.warning(`Agent ${agents[i].name} promise rejected: ${errMsg}`);
      agentResults.push({
        agentName: agents[i].name,
        category: agents[i].category,
        findings: [],
        summary: `Agent crashed: ${errMsg}`,
        score: 0,
        durationMs: 0,
        error: errMsg,
      });
    }
  }
  return agentResults;
}

/**
 * Deduplicates findings (programmatic pass, then the AI consolidation pass in
 * separate mode — combined mode has a single agent, so there are no
 * cross-agent duplicates) and merges everything into the final result.
 */
async function consolidateResults(
  agentResults: AgentResult[],
  config: ActionConfig,
  provider: AIProvider,
  commenter: PRCommenter,
): Promise<{ merged: MergedReviewResult; consolidated: Finding[] }> {
  const allFindings = agentResults.flatMap(r => r.findings);
  const deduplicated = deduplicateFindings(allFindings);

  let consolidated = deduplicated;
  if (config.reviewMode !== 'combined') {
    // AI consolidation pass — catches semantic duplicates that string matching misses
    await commenter.postOrUpdateComment('## 🔍 AI Code Review\n\n✅ All agents complete. Consolidating findings...');
    consolidated = await consolidateFindings(deduplicated, provider, config.agentTimeout * 1000);
  }

  // Replace findings in agent results with consolidated versions.
  // In separate mode, distribute consolidated findings back to their original
  // agents by category. In combined mode the single comprehensive agent owns
  // every finding (findings carry per-finding sub-categories, so a category
  // filter would drop them all).
  const consolidatedResults = config.reviewMode === 'combined'
    ? agentResults.map(r => ({ ...r, findings: consolidated }))
    : agentResults.map(r => ({
        ...r,
        findings: consolidated.filter(f => f.category === r.category),
      }));

  return { merged: mergeResults(consolidatedResults, config), consolidated };
}

/** Resolves stale threads from previous runs, then posts new inline comments. */
async function postInlineComments(
  octokit: Octokit,
  config: ActionConfig,
  context: ReviewContext,
  consolidated: Finding[],
  merged: MergedReviewResult,
  commenter: PRCommenter,
): Promise<{ staleThreadsResolved: number; inlineCommentsNew: number; inlineCommentsExisting: number }> {
  if (!config.postInlineComments) {
    return { staleThreadsResolved: 0, inlineCommentsNew: 0, inlineCommentsExisting: 0 };
  }

  // Resolve old inline comments that are no longer relevant
  const currentFindingSummary = consolidated.map(f => ({ file: f.file, line: f.line, title: f.title }));
  const staleThreadsResolved = await commenter.resolveStaleInlineComments(currentFindingSummary);

  let inlineCommentsNew = 0;
  let inlineCommentsExisting = 0;
  if (merged.totalFindings > 0) {
    const parsedDiffs = parseDiff(context.diff);
    const inlineReviewer = new InlineReviewer(octokit, config.owner, config.repo, config.prNumber);

    // Inline comments cover critical/high/medium and never go on unit test
    // files (findings remain in the summary comment) — mirrors the
    // prompt-level suppression as a hard guard.
    const inlineFindings = consolidated.filter(
      f => INLINE_SEVERITIES.has(f.severity) && !isTestFile(f.file),
    );

    if (inlineFindings.length > 0) {
      inlineCommentsNew = await inlineReviewer.postReview(inlineFindings, context.headSha, parsedDiffs);
      inlineCommentsExisting = Math.max(0, inlineFindings.length - inlineCommentsNew);
      logger.info(`Posted ${inlineCommentsNew} inline review comments (${inlineCommentsExisting} already existed)`);
    }
  }

  return { staleThreadsResolved, inlineCommentsNew, inlineCommentsExisting };
}

/** The markdown panel shown on the workflow run page. */
function buildJobSummary(
  config: ActionConfig,
  merged: MergedReviewResult,
  commentUrl: string,
  agentResults: AgentResult[],
): string {
  const failed = agentResults.filter(r => r.error).map(r => r.agentName);
  return [
    '## AI Code Review',
    '',
    '| | |',
    '|---|---|',
    `| Status | ${merged.passed ? '✅ passed' : '❌ failed threshold'} |`,
    `| Model | \`${config.anthropicModel}\` |`,
    `| Mode | \`${config.reviewMode}\` |`,
    `| Findings | ${merged.totalFindings} (🛑 ${merged.criticalCount} / 🔴 ${merged.highCount} / 🟡 ${merged.mediumCount} / 🟢 ${merged.lowCount} / 💬 ${merged.nitCount}) |`,
    `| Duration | ${Math.round(merged.durationMs / 1000)}s |`,
    `| Agents failed | ${failed.length ? failed.join(', ') : 'none'} |`,
    `| Review comment | ${commentUrl} |`,
    '',
  ].join('\n');
}
