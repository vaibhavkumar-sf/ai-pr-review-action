import * as core from '@actions/core';
import { ActionConfig, AgentResult, Finding, MergedReviewResult, ReviewCategory, ReviewContext } from '../types';
import { BACKSTAGE_TIMEOUT_MS } from '../config/limits';

/**
 * Per-finding record sent to Backstage. Field names are snake_case to match
 * the database schema documented in docs/backstage-integration.md.
 */
interface BackstageFinding {
  category: ReviewCategory;
  severity: string;
  file: string;
  line: number;
  title: string;
  description: string;
  suggestion: string | null;
  has_code_suggestion: boolean;
}

/**
 * Per-run comment-lifecycle activity. Every review run is stored as a
 * separate row in the Backstage tracker, so these counts let a dashboard
 * reconstruct the full story of a PR across re-pushes (e.g. run 1: 10 new
 * findings; run 2: 2 resolved, 8 carried over, 4 new, 4 replies answered).
 */
export interface RunActivityStats {
  inlineCommentsNew: number;
  inlineCommentsExisting: number;
  staleThreadsResolved: number;
  repliesPosted: number;
  threadsResolvedFromReplies: number;
  botCommentsHidden: number;
}

export interface BackstageReviewPayload {
  // Run / PR metadata
  repo_name: string;
  pr_number: number;
  pr_title: string;
  pr_url: string;
  pr_creator: string;
  branch_name: string;
  base_branch: string;
  head_sha: string;
  workflow_run_id: string;
  workflow_run_number: number;
  run_timestamp: string;

  // Review configuration
  review_mode: string;
  review_profile: string;
  framework: string;
  model_name: string;
  ai_provider: string;

  // Aggregates
  review_status: string;
  skip_reason: string;
  review_passed: boolean;
  total_findings: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  nit_count: number;
  security_count: number;
  code_quality_count: number;
  performance_count: number;
  type_safety_count: number;
  architecture_count: number;
  testing_count: number;
  api_design_count: number;
  average_score: number;
  agents_run: string;
  agents_failed: string;
  files_reviewed: number;
  duration_seconds: number;

  // Per-run comment lifecycle activity (see RunActivityStats)
  inline_comments_new: number;
  inline_comments_existing: number;
  stale_threads_resolved: number;
  replies_posted: number;
  threads_resolved_from_replies: number;
  bot_comments_hidden: number;

  // Full per-finding detail
  findings: BackstageFinding[];
}

/**
 * POSTs the full review result (aggregates + every individual finding) to the
 * Backstage tracker endpoint configured via the post_data_url input.
 *
 * Fire-and-forget: failures are logged as warnings and never fail the action,
 * matching the reporting pattern used by sourcefuse/ai-test-quality-analyzer.
 */
export async function reportToBackstage(
  config: ActionConfig,
  merged: MergedReviewResult,
  context: ReviewContext,
  agentResults: AgentResult[],
  activity: RunActivityStats,
): Promise<boolean> {
  const payload = buildPayload(config, merged, context, agentResults, activity);
  return postPayload(config, payload, `${payload.total_findings} findings`);
}

/**
 * Reports a run that produced NO review (skipped or failed) so the tracker
 * still records every run. Same payload shape with zero counts and the
 * status/reason set — mirrors the always()/failure() telemetry pattern of
 * sourcefuse/ai-test-quality-analyzer.
 */
export async function reportRunOutcome(
  config: ActionConfig,
  status: 'skipped' | 'failed',
  reason: string,
): Promise<boolean> {
  if (!config.postDataUrl) return false;
  const payload: BackstageReviewPayload = {
    repo_name: `${config.owner}/${config.repo}`,
    pr_number: config.prNumber,
    pr_title: '',
    pr_url: `https://github.com/${config.owner}/${config.repo}/pull/${config.prNumber}`,
    pr_creator: '',
    branch_name: '',
    base_branch: '',
    head_sha: '',
    workflow_run_id: config.workflowRunId,
    workflow_run_number: config.workflowRunNumber,
    run_timestamp: new Date().toISOString(),
    review_mode: config.reviewMode,
    review_profile: config.reviewProfile,
    framework: config.framework,
    model_name: config.anthropicModel,
    ai_provider: resolveProviderName(config.anthropicBaseUrl),
    review_status: status,
    skip_reason: reason,
    review_passed: false,
    total_findings: 0,
    critical_count: 0,
    high_count: 0,
    medium_count: 0,
    low_count: 0,
    nit_count: 0,
    security_count: 0,
    code_quality_count: 0,
    performance_count: 0,
    type_safety_count: 0,
    architecture_count: 0,
    testing_count: 0,
    api_design_count: 0,
    average_score: 0,
    agents_run: '',
    agents_failed: '',
    files_reviewed: 0,
    duration_seconds: 0,
    inline_comments_new: 0,
    inline_comments_existing: 0,
    stale_threads_resolved: 0,
    replies_posted: 0,
    threads_resolved_from_replies: 0,
    bot_comments_hidden: 0,
    findings: [],
  };
  return postPayload(config, payload, `status=${status} (${reason})`);
}

async function postPayload(
  config: ActionConfig,
  payload: BackstageReviewPayload,
  summary: string,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKSTAGE_TIMEOUT_MS);
    try {
      const response = await fetch(config.postDataUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        core.warning(`Backstage report failed with HTTP ${response.status} (non-critical, continuing)`);
        return false;
      }
      core.info(`Reported review data to Backstage (${summary})`);
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to report to Backstage: ${msg} (non-critical, continuing)`);
    return false;
  }
}

function buildPayload(
  config: ActionConfig,
  merged: MergedReviewResult,
  context: ReviewContext,
  agentResults: AgentResult[],
  activity: RunActivityStats,
): BackstageReviewPayload {
  const categoryCounts = countByCategory(merged.findings);
  const scoredAgents = agentResults.filter(r => !r.error);
  const averageScore = scoredAgents.length > 0
    ? Math.round((scoredAgents.reduce((sum, r) => sum + r.score, 0) / scoredAgents.length) * 10) / 10
    : 0;

  return {
    repo_name: `${config.owner}/${config.repo}`,
    pr_number: config.prNumber,
    pr_title: context.prTitle,
    pr_url: `https://github.com/${config.owner}/${config.repo}/pull/${config.prNumber}`,
    pr_creator: context.prAuthor,
    branch_name: context.headBranch,
    base_branch: context.baseBranch,
    head_sha: context.headSha,
    workflow_run_id: config.workflowRunId,
    workflow_run_number: config.workflowRunNumber,
    run_timestamp: new Date().toISOString(),

    review_mode: config.reviewMode,
    review_profile: config.reviewProfile,
    framework: context.framework,
    model_name: config.anthropicModel,
    ai_provider: resolveProviderName(config.anthropicBaseUrl),

    review_status: 'completed',
    skip_reason: '',
    review_passed: merged.passed,
    total_findings: merged.totalFindings,
    critical_count: merged.criticalCount,
    high_count: merged.highCount,
    medium_count: merged.mediumCount,
    low_count: merged.lowCount,
    nit_count: merged.nitCount,
    security_count: categoryCounts['security'] || 0,
    code_quality_count: categoryCounts['code-quality'] || 0,
    performance_count: categoryCounts['performance'] || 0,
    type_safety_count: categoryCounts['type-safety'] || 0,
    architecture_count: categoryCounts['architecture'] || 0,
    testing_count: categoryCounts['testing'] || 0,
    api_design_count: categoryCounts['api-design'] || 0,
    average_score: averageScore,
    agents_run: agentResults.map(r => r.agentName).join(','),
    agents_failed: agentResults.filter(r => r.error).map(r => r.agentName).join(','),
    files_reviewed: context.changedFiles.length,
    duration_seconds: Math.round(merged.durationMs / 1000),

    inline_comments_new: activity.inlineCommentsNew,
    inline_comments_existing: activity.inlineCommentsExisting,
    stale_threads_resolved: activity.staleThreadsResolved,
    replies_posted: activity.repliesPosted,
    threads_resolved_from_replies: activity.threadsResolvedFromReplies,
    bot_comments_hidden: activity.botCommentsHidden,

    findings: merged.findings.map(toBackstageFinding),
  };
}

function toBackstageFinding(finding: Finding): BackstageFinding {
  return {
    category: finding.category,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    description: finding.description,
    suggestion: finding.suggestion || null,
    has_code_suggestion: Boolean(finding.codeSuggestion),
  };
}

function countByCategory(findings: Finding[]): Partial<Record<ReviewCategory, number>> {
  const counts: Partial<Record<ReviewCategory, number>> = {};
  for (const f of findings) {
    counts[f.category] = (counts[f.category] || 0) + 1;
  }
  return counts;
}

function resolveProviderName(baseUrl: string): string {
  if (baseUrl.includes('api.anthropic.com')) return 'anthropic';
  if (baseUrl.includes('openrouter')) return 'openrouter';
  if (baseUrl.includes('bigmodel') || baseUrl.includes('z.ai')) return 'glm';
  return 'custom';
}
