import { ActionConfig, AgentResult, Finding, MergedReviewResult, ReviewCategory, ReviewContext } from '../types';
import { RunActivityStats } from './backstage-reporter';
import {
  CATEGORY_LABELS,
  SEVERITY_ICONS,
  SEVERITY_LABELS,
  SPECIALIST_CATEGORY_IDS,
} from '../config/taxonomy';
import { STRENGTHS_MIN_SCORE, TABLE_DESCRIPTION_CHARS } from '../config/limits';
import { formatDuration } from '../utils/text';

/**
 * Formats the merged review result into a markdown comment for posting on the PR.
 */
export function formatReviewComment(
  result: MergedReviewResult,
  config: ActionConfig,
  context: ReviewContext,
  rerunNumber = 0,
  activity?: RunActivityStats,
): string {
  const parts: string[] = [];

  // Header (no marker here — postOrUpdateComment adds it). On a re-run we suffix
  // the title with the re-run number so readers can tell at a glance this is a
  // focused re-review and how many times the PR has been re-reviewed.
  const statusIcon = result.passed ? '✅' : '❌';
  const baseHeader = config.commentHeader || `${statusIcon} AI Code Review`;
  const headerText = rerunNumber > 0 ? `${baseHeader} — Re-run #${rerunNumber}` : baseHeader;
  parts.push(`## ${headerText}`);
  parts.push('');

  // Meta information
  const profileMeta = config.reviewMode === 'separate' ? ` | **Profile:** \`${config.reviewProfile}\`` : '';
  parts.push(`> **Model:** \`${config.anthropicModel}\` | **Mode:** \`${config.reviewMode}\`${profileMeta} | **Duration:** ${formatDuration(result.durationMs)}`);
  parts.push('');

  // The tracking-metrics block is the single home for severity/category counts
  // (no separate "Summary" table — it duplicated these). The activity + AI-usage
  // groups only render once those stats exist (the final post); the first post
  // shows the severity/category breakdown alone.
  parts.push(formatTrackingMetrics(result, config, activity).trimStart());

  // Pass/fail status
  if (result.passed) {
    parts.push('> ✅ **Review passed** — no findings above the configured threshold.');
  } else {
    parts.push(`> ❌ **Review failed** — findings above the \`${config.failThreshold}\` threshold detected.`);
  }
  parts.push('');

  // Critical & High issues table
  const severeFindings = result.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
  if (severeFindings.length > 0) {
    parts.push('### Critical & High Issues');
    parts.push('');
    parts.push('| Severity | File | Title | Description |');
    parts.push('|----------|------|-------|-------------|');
    for (const f of severeFindings) {
      const sevLabel = `${SEVERITY_ICONS[f.severity]} ${SEVERITY_LABELS[f.severity]}`;
      const fileLink = f.file ? `\`${f.file}:${f.line}\`` : 'N/A';
      const desc = truncate(f.description, TABLE_DESCRIPTION_CHARS);
      parts.push(`| ${sevLabel} | ${fileLink} | ${escapeMarkdownTable(f.title)} | ${escapeMarkdownTable(desc)} |`);
    }
    parts.push('');
  }

  // All findings (collapsible)
  if (result.totalFindings > 0) {
    parts.push('<details>');
    parts.push('<summary><strong>All Findings (' + result.totalFindings + ')</strong></summary>');
    parts.push('');
    for (const f of result.findings) {
      const sevLabel = `${SEVERITY_ICONS[f.severity]} ${SEVERITY_LABELS[f.severity]}`;
      const fileLine = f.file ? `\`${f.file}:${f.line}\`` : '';
      parts.push(`#### ${sevLabel}: ${f.title}`);
      parts.push(`${fileLine}`);
      parts.push('');
      parts.push(f.description);
      if (f.suggestion) {
        parts.push('');
        parts.push(`> **Suggestion:** ${f.suggestion}`);
      }
      if (f.codeSuggestion) {
        parts.push('');
        parts.push('```suggestion');
        parts.push(f.codeSuggestion);
        parts.push('```');
      }
      parts.push('');
      parts.push('---');
      parts.push('');
    }
    parts.push('</details>');
    parts.push('');
  }

  // JIRA context section
  if (context.jiraContext) {
    parts.push('<details>');
    parts.push('<summary><strong>JIRA Context</strong></summary>');
    parts.push('');
    parts.push(`- **Ticket:** [${context.jiraContext.ticketId}](${context.jiraContext.ticketUrl})`);
    parts.push(`- **Summary:** ${context.jiraContext.summary}`);
    parts.push(`- **Status:** ${context.jiraContext.status}`);
    parts.push(`- **Type:** ${context.jiraContext.type}`);
    parts.push(`- **Priority:** ${context.jiraContext.priority}`);
    if (context.jiraContext.acceptanceCriteria) {
      parts.push('');
      parts.push('**Acceptance Criteria:**');
      parts.push(context.jiraContext.acceptanceCriteria);
    }
    parts.push('');
    parts.push('</details>');
    parts.push('');
  }

  // Agent results summary
  parts.push('<details>');
  parts.push('<summary><strong>Agent Results</strong></summary>');
  parts.push('');
  parts.push('| Agent | Score | Findings | Duration | Status |');
  parts.push('|-------|-------|----------|----------|--------|');
  for (const agent of result.agentResults) {
    const statusText = agent.error ? '❌ Failed' : '✅ Complete';
    const scoreDisplay = agent.error ? 'N/A' : `${agent.score}/10`;
    parts.push(
      `| ${agent.agentName} | ${scoreDisplay} | ${agent.findings.length} | ${formatDuration(agent.durationMs)} | ${statusText} |`,
    );
  }
  parts.push('');

  // Agent summaries
  for (const agent of result.agentResults) {
    if (agent.summary) {
      parts.push(`**${agent.agentName}:** ${agent.summary}`);
      parts.push('');
    }
  }
  parts.push('</details>');
  parts.push('');

  // Strengths section (from agent summaries that scored high)
  const strengths = extractStrengths(result.agentResults);
  if (strengths.length > 0) {
    parts.push('<details>');
    parts.push('<summary><strong>Strengths</strong></summary>');
    parts.push('');
    for (const s of strengths) {
      parts.push(`- ${s}`);
    }
    parts.push('');
    parts.push('</details>');
    parts.push('');
  }

  // Footer
  if (config.commentFooter) {
    parts.push('---');
    parts.push(config.commentFooter);
    parts.push('');
  }

  // Powered by
  parts.push('---');
  parts.push(
    '<sub>Powered by [AI PR Review Action](https://github.com/sourcefuse/ai-pr-review-action) — automated code review with multi-agent AI</sub>',
  );
  parts.push('');

  return parts.join('\n');
}

/**
 * Formats the "Tracking Metrics" section — the single home for the severity and
 * category breakdowns (it replaced the old standalone Summary tables, which
 * duplicated it). It mirrors exactly what is POSTed to the Backstage tracker,
 * rendered as visually distinct groups so each reads against its own total.
 *
 * `activity` is only known once comment-lifecycle + AI work has run, so the
 * Review Activity and AI Usage groups render only when it is supplied; the
 * first (pre-activity) post shows just the severity/category breakdown.
 */
export function formatTrackingMetrics(
  result: MergedReviewResult,
  config: ActionConfig,
  activity?: RunActivityStats,
): string {
  const parts: string[] = [];

  parts.push('');
  parts.push('### 📊 Tracking Metrics');
  parts.push('');

  // Group 1: findings by severity (sums to the total) — horizontal for compactness
  parts.push(`#### Findings by Severity — ${result.totalFindings} total`);
  parts.push('');
  parts.push(...horizontalTable(severityCells(result)));
  parts.push('');

  // Group 2: findings by category (sums to the same total)
  const categoryCounts = new Map<ReviewCategory, number>(countByCategory(result.findings));
  parts.push(`#### Findings by Category — ${result.totalFindings} total`);
  parts.push('');
  parts.push(...horizontalTable([
    ...SPECIALIST_CATEGORY_IDS.map(
      (category): [string, number] => [CATEGORY_LABELS[category], categoryCounts.get(category) ?? 0],
    ),
    ['**Total**', `**${result.totalFindings}**`],
  ]));
  parts.push('');

  if (activity) {
    // Group 3: comment-lifecycle activity for THIS run (not finding counts)
    parts.push('#### Review Activity (this run)');
    parts.push('');
    parts.push(...horizontalTable([
      ['🆕 New inline', activity.inlineCommentsNew],
      ['♻️ Carried-over', activity.inlineCommentsExisting],
      ['✅ Resolved (fixed)', activity.staleThreadsResolved],
      ['🔁 Reopened', activity.threadsReopened],
      ['💬 Replies posted', activity.repliesPosted],
      ['☑️ Resolved (replies)', activity.threadsResolvedFromReplies],
      ['🤖 Bot hidden', activity.botCommentsHidden],
    ]));
    parts.push('');

    // Group 4: AI usage for THIS run; USD appears only when model_pricing priced
    // the models used (client-side estimate, never billing data).
    parts.push('#### AI Usage (this run)');
    parts.push('');
    parts.push(...horizontalTable([
      ['🧠 AI calls', activity.aiCalls],
      ['📥 Input tokens', activity.aiInputTokens.toLocaleString('en-US')],
      ['📤 Output tokens', activity.aiOutputTokens.toLocaleString('en-US')],
      ['💰 Est. cost', activity.estimatedCostUsd === null ? 'n/a' : `$${activity.estimatedCostUsd.toFixed(4)}`],
    ]));
    parts.push('');
    if (activity.estimatedCostUsd !== null) {
      parts.push('<sub>Cost is estimated client-side from token counts × the configured `model_pricing` — not billing data.</sub>');
      parts.push('');
    }
  }

  if (config.postDataUrl) {
    parts.push('<sub>Reported to the Backstage tracker — each review run is stored as a separate row, so re-reviews of this PR are tracked individually.</sub>');
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Renders label→value pairs as a compact horizontal table — labels across the
 * top, all values in a single row beneath — instead of one table row per
 * metric. Same information, a fraction of the vertical space (3 rendered rows
 * regardless of metric count), so the summary comment scrolls far less.
 */
function horizontalTable(cells: Array<[string, string | number]>): string[] {
  const header = `| ${cells.map(([label]) => label).join(' | ')} |`;
  const divider = `|${cells.map(() => ':-:').join('|')}|`;
  const values = `| ${cells.map(([, value]) => value).join(' | ')} |`;
  return [header, divider, values];
}

/** The five severity buckets plus a bold total, as horizontal-table cells. */
function severityCells(result: MergedReviewResult): Array<[string, string | number]> {
  return [
    [`${SEVERITY_ICONS.critical} Critical`, result.criticalCount],
    [`${SEVERITY_ICONS.high} High`, result.highCount],
    [`${SEVERITY_ICONS.medium} Medium`, result.mediumCount],
    [`${SEVERITY_ICONS.low} Low`, result.lowCount],
    [`${SEVERITY_ICONS.nit} Nit`, result.nitCount],
    ['**Total**', `**${result.totalFindings}**`],
  ];
}

function countByCategory(findings: Finding[]): Array<[ReviewCategory, number]> {
  const counts = new Map<ReviewCategory, number>();
  for (const f of findings) {
    counts.set(f.category, (counts.get(f.category) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 3) + '...';
}

function escapeMarkdownTable(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Extracts strengths from agent results.
 * Agents that scored highly and have a summary are considered to have identified strengths.
 */
function extractStrengths(agentResults: AgentResult[]): string[] {
  const strengths: string[] = [];
  for (const agent of agentResults) {
    if (agent.score >= STRENGTHS_MIN_SCORE && !agent.error) {
      strengths.push(`**${agent.agentName}** (${agent.score}/10): ${agent.summary}`);
    }
  }
  return strengths;
}
