import { ActionConfig, AgentResult, Finding, MergedReviewResult, ReviewCategory, ReviewContext } from '../types';
import { generateArchitectureDiagram } from './diagram-generator';
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
): string {
  const parts: string[] = [];

  // Header (no marker here — postOrUpdateComment adds it)
  const statusIcon = result.passed ? '✅' : '❌';
  const headerText = config.commentHeader || `${statusIcon} AI Code Review`;
  parts.push(`## ${headerText}`);
  parts.push('');

  // Meta information
  const profileMeta = config.reviewMode === 'separate' ? ` | **Profile:** \`${config.reviewProfile}\`` : '';
  parts.push(`> **Model:** \`${config.anthropicModel}\` | **Mode:** \`${config.reviewMode}\`${profileMeta} | **Duration:** ${formatDuration(result.durationMs)}`);
  parts.push('');

  // Severity summary — horizontal (metrics as columns) to minimize vertical space
  parts.push('### Summary');
  parts.push('');
  parts.push(...horizontalTable(severityCells(result)));
  parts.push('');

  // Category breakdown — findings carry per-finding categories in both modes
  const categoryCounts = countByCategory(result.findings);
  if (categoryCounts.length > 0) {
    parts.push('### Findings by Category');
    parts.push('');
    parts.push(...horizontalTable(categoryCounts.map(([category, count]) => [CATEGORY_LABELS[category], count])));
    parts.push('');
  }

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

  // Architecture diagram (collapsible)
  const diagram = generateArchitectureDiagram(context);
  if (diagram) {
    parts.push('<details>');
    parts.push('<summary><strong>Architecture Diagram</strong></summary>');
    parts.push('');
    parts.push('```mermaid');
    parts.push(diagram);
    parts.push('```');
    parts.push('');
    parts.push('</details>');
    parts.push('');
  }

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
 * Formats the "Backstage Tracking Metrics" section appended to the summary
 * comment after all comment-lifecycle actions complete. It mirrors exactly
 * what is POSTed to the Backstage tracker, rendered as three visually distinct
 * groups — severity counts, category counts, and this run's activity — so each
 * group reads against its own total instead of one flat metric list.
 */
export function formatTrackingMetrics(
  result: MergedReviewResult,
  config: ActionConfig,
  activity: RunActivityStats,
): string {
  const parts: string[] = [];

  parts.push('');
  parts.push('### 📊 Backstage Tracking Metrics');
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

  // Group 3: comment-lifecycle activity for THIS run (not finding counts)
  parts.push('#### Review Activity (this run)');
  parts.push('');
  parts.push(...horizontalTable([
    ['🆕 New inline', activity.inlineCommentsNew],
    ['♻️ Carried-over', activity.inlineCommentsExisting],
    ['✅ Resolved (fixed)', activity.staleThreadsResolved],
    ['💬 Replies posted', activity.repliesPosted],
    ['☑️ Resolved (replies)', activity.threadsResolvedFromReplies],
    ['🤖 Bot hidden', activity.botCommentsHidden],
  ]));
  parts.push('');

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
