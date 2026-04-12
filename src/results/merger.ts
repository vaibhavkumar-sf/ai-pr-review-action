import { ActionConfig, AgentResult, Finding, MergedReviewResult, Severity } from '../types';

/**
 * Merges results from all review agents into a single consolidated result.
 *
 * Collects every finding, counts by severity, calculates total duration,
 * and determines whether the review passes based on the configured fail threshold.
 */
export function mergeResults(agentResults: AgentResult[], config: ActionConfig): MergedReviewResult {
  const allFindings: Finding[] = [];
  let totalDurationMs = 0;

  for (const result of agentResults) {
    allFindings.push(...result.findings);
    totalDurationMs = Math.max(totalDurationMs, result.durationMs);
  }

  const criticalCount = countBySeverity(allFindings, 'critical');
  const highCount = countBySeverity(allFindings, 'high');
  const mediumCount = countBySeverity(allFindings, 'medium');
  const lowCount = countBySeverity(allFindings, 'low');
  const nitCount = countBySeverity(allFindings, 'nit');

  const passed = determinePassFail(criticalCount, highCount, mediumCount, config);

  return {
    findings: allFindings,
    agentResults,
    totalFindings: allFindings.length,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    nitCount,
    passed,
    durationMs: totalDurationMs,
  };
}

function countBySeverity(findings: Finding[], severity: Severity): number {
  return findings.filter(f => f.severity === severity).length;
}

/**
 * Determines pass/fail based on the configured threshold.
 *
 * - `critical`: fail only if there are critical findings
 * - `high`: fail if there are critical OR high findings
 * - `medium`: fail if there are critical, high, OR medium findings
 */
function determinePassFail(
  criticalCount: number,
  highCount: number,
  mediumCount: number,
  config: ActionConfig,
): boolean {
  if (!config.failOnCritical) {
    return true;
  }

  switch (config.failThreshold) {
    case 'critical':
      return criticalCount === 0;
    case 'high':
      return criticalCount === 0 && highCount === 0;
    case 'medium':
      return criticalCount === 0 && highCount === 0 && mediumCount === 0;
    default:
      return criticalCount === 0;
  }
}
