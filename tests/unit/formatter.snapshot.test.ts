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
    });
    expect(metrics).toMatchSnapshot();
  });
});
