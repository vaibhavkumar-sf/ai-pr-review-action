import {
  formatFullReportComment,
  formatReviewComment,
  formatTrackingMetrics,
} from '../../src/results/formatter';
import { makeAgentResult, makeConfig, makeContext, makeMerged } from '../fixtures/factory';
import { makeActivity } from '../fixtures/factory';

/**
 * Locks the exact markdown of the summary comment. The full report now lives in
 * the PR description (see run-history.test.ts); this comment is a stub whose
 * job is to carry the completion marker and point at the description.
 */
describe('formatReviewComment snapshot', () => {
  it('renders the stub comment for a combined-mode first run', () => {
    const comment = formatReviewComment(makeMerged(), makeConfig(), 1, false);
    expect(comment).toMatchSnapshot();
  });

  it('titles the header with the true run ordinal', () => {
    const merged = makeMerged();
    expect(formatReviewComment(merged, makeConfig(), 1, false).split('\n')[0])
      .toMatch(/AI Code Review — Run #1$/);
    expect(formatReviewComment(merged, makeConfig(), 7, true).split('\n')[0])
      .toMatch(/AI Code Review — Run #7$/);
  });

  it('carries the re-run inline note only on re-runs', () => {
    const merged = makeMerged();
    expect(formatReviewComment(merged, makeConfig(), 1, false)).not.toContain('🔁 Re-run');
    expect(formatReviewComment(merged, makeConfig(), 2, true)).toContain('🔁 Re-run');
  });

  it('keeps the report OUT of the comment — that is the description\'s job', () => {
    const comment = formatReviewComment(makeMerged(), makeConfig(), 1, false);
    expect(comment).not.toContain('Tracking Metrics');
    expect(comment).not.toContain('All Findings');
    expect(comment).not.toContain('Agent Results');
    expect(comment).toContain('is in the **PR description**');
  });

  it('renders a passing zero-findings stub in separate mode', () => {
    const merged = makeMerged({
      findings: [],
      agentResults: [
        makeAgentResult({ agentName: 'security', category: 'security', score: 9 }),
        makeAgentResult({ agentName: 'testing', category: 'testing', score: 4, summary: '', error: 'timed out' }),
      ],
    });
    const comment = formatReviewComment(
      merged,
      makeConfig({ reviewMode: 'separate', commentFooter: 'Custom footer' }),
      1,
      false,
    );
    expect(comment).toMatchSnapshot();
  });
});

/**
 * The fallback path: only reached when writing the PR description failed. It
 * must contain the whole report, because otherwise that run produced a review
 * nobody can read.
 */
describe('formatFullReportComment', () => {
  it('carries the entire report plus an explanation of why it is here', () => {
    const comment = formatFullReportComment(
      makeMerged(), makeConfig(), makeContext(), makeActivity(), 3, false,
    );
    expect(comment).toContain('The PR description could not be updated');
    expect(comment).toContain('### 📊 Tracking Metrics');
    expect(comment).toContain('#### Review Activity (this run)');
    expect(comment).toContain('All Findings');
    expect(comment).toContain('Agent Results');
    expect(comment).toContain('AI Code Review — Run #3');
    expect(comment.indexOf('### 📊 Tracking Metrics')).toBeLessThan(comment.indexOf('Critical & High'));
    expect(comment).toMatchSnapshot();
  });
});

describe('formatTrackingMetrics snapshot', () => {
  it('renders the tracking metrics section', () => {
    const metrics = formatTrackingMetrics(makeMerged(), makeConfig({ postDataUrl: 'https://backstage.example.test/hook' }), {
      inlineCommentsNew: 3,
      inlineCommentsExisting: 1,
      staleThreadsResolved: 2,
      threadsReopened: 1,
      repliesPosted: 1,
      threadsResolvedFromReplies: 1,
      botCommentsHidden: 4,
      aiCalls: 7,
      aiInputTokens: 245120,
      aiOutputTokens: 38440,
      estimatedCostUsd: 0.2317,
    });
    expect(metrics).toMatchSnapshot();
  });

  it('shows n/a cost (and no estimate footnote) when no model is priced', () => {
    const metrics = formatTrackingMetrics(makeMerged(), makeConfig(), {
      inlineCommentsNew: 0,
      inlineCommentsExisting: 0,
      staleThreadsResolved: 0,
      threadsReopened: 0,
      repliesPosted: 0,
      threadsResolvedFromReplies: 0,
      botCommentsHidden: 0,
      aiCalls: 3,
      aiInputTokens: 1000,
      aiOutputTokens: 500,
      estimatedCostUsd: null,
    });
    expect(metrics).toContain('| 💰 Est. cost |');
    expect(metrics).toContain(' n/a |');
    expect(metrics).not.toContain('estimated client-side');
  });
});
