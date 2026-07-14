import { formatReviewComment, formatTrackingMetrics } from '../../src/results/formatter';
import { makeAgentResult, makeConfig, makeContext, makeMerged } from '../fixtures/factory';

/**
 * Locks the exact markdown of the summary comment. The taxonomy/limits
 * refactor must not change a single rendered character (except the tracking
 * metrics regrouping, whose new layout is locked here once implemented).
 */
describe('formatReviewComment snapshot', () => {
  it('renders the full summary comment for a combined-mode run', () => {
    const merged = makeMerged();
    const comment = formatReviewComment(merged, makeConfig(), makeContext());
    expect(comment).toMatchSnapshot();
  });

  it('suffixes the header with "— Re-run #N" when rerunNumber > 0', () => {
    const merged = makeMerged();
    const firstRun = formatReviewComment(merged, makeConfig(), makeContext(), 0);
    const firstRerun = formatReviewComment(merged, makeConfig(), makeContext(), 1);
    const secondRerun = formatReviewComment(merged, makeConfig(), makeContext(), 2);
    expect(firstRun.split('\n')[0]).not.toMatch(/Re-run/);
    expect(firstRerun.split('\n')[0]).toMatch(/AI Code Review — Re-run #1$/);
    expect(secondRerun.split('\n')[0]).toMatch(/AI Code Review — Re-run #2$/);
  });

  it('renders a passing zero-findings comment in separate mode', () => {
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
      makeContext({ jiraContext: null }),
    );
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
