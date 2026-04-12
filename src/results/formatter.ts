import { ActionConfig, AgentResult, Finding, MergedReviewResult, ReviewContext, Severity } from '../types';
import { generateArchitectureDiagram } from './diagram-generator';

const SEVERITY_ICONS: Record<Severity, string> = {
  critical: '\uD83D\uDED1',
  high: '\uD83D\uDD34',
  medium: '\uD83D\uDFE1',
  low: '\uD83D\uDFE2',
  nit: '\uD83D\uDCAC',
};

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  nit: 'Nit',
};

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

  // Header
  const statusIcon = result.passed ? '\u2705' : '\u274C';
  const headerText = config.commentHeader || `${statusIcon} AI Code Review`;
  parts.push(`## ${headerText}`);
  parts.push('');

  // Meta information
  parts.push(`> **Model:** \`${config.anthropicModel}\` | **Profile:** \`${config.reviewProfile}\` | **Duration:** ${formatDuration(result.durationMs)}`);
  parts.push('');

  // Severity summary table
  parts.push('### Summary');
  parts.push('');
  parts.push('| Severity | Count |');
  parts.push('|----------|-------|');
  parts.push(`| ${SEVERITY_ICONS.critical} Critical | ${result.criticalCount} |`);
  parts.push(`| ${SEVERITY_ICONS.high} High | ${result.highCount} |`);
  parts.push(`| ${SEVERITY_ICONS.medium} Medium | ${result.mediumCount} |`);
  parts.push(`| ${SEVERITY_ICONS.low} Low | ${result.lowCount} |`);
  parts.push(`| ${SEVERITY_ICONS.nit} Nit | ${result.nitCount} |`);
  parts.push(`| **Total** | **${result.totalFindings}** |`);
  parts.push('');

  // Pass/fail status
  if (result.passed) {
    parts.push('> \u2705 **Review passed** \u2014 no findings above the configured threshold.');
  } else {
    parts.push(`> \u274C **Review failed** \u2014 findings above the \`${config.failThreshold}\` threshold detected.`);
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
      const desc = truncate(f.description, 120);
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
    const statusText = agent.error ? '\u274C Failed' : '\u2705 Complete';
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
    '<sub>Powered by [AI PR Review Action](https://github.com/sourcefuse/ai-pr-review-action) \u2014 automated code review with multi-agent AI</sub>',
  );
  parts.push('');

  return parts.join('\n');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = (ms / 1000).toFixed(1);
  return `${seconds}s`;
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
 * Agents that scored >= 8 and have a summary are considered to have identified strengths.
 */
function extractStrengths(agentResults: AgentResult[]): string[] {
  const strengths: string[] = [];
  for (const agent of agentResults) {
    if (agent.score >= 8 && !agent.error) {
      strengths.push(`**${agent.agentName}** (${agent.score}/10): ${agent.summary}`);
    }
  }
  return strengths;
}
