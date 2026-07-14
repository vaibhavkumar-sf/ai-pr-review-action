import { Octokit } from '@octokit/rest';
import { PRCommenter, RegressedFinding, REOPEN_MARKER, REVIEW_COMPLETE_MARKER } from '../../src/github/pr-commenter';
import { buildFingerprintMarker, INLINE_COMMENT_MARKER } from '../../src/github/inline-reviewer';
import { RESOLUTION_FOOTER, ReviewThread } from '../../src/github/threads';
import { SEVERITY_TAGS } from '../../src/config/taxonomy';
import { REOPEN_THREADS_MAX_PER_RUN } from '../../src/config/limits';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

const BOT = 'github-actions[bot]';
const COMMENT_MARKER = '<!-- ai-pr-review-action-comment -->';

interface MockOctokit {
  graphql: jest.Mock;
  paginate: jest.Mock;
  issues: { listComments: unknown; createComment: jest.Mock; updateComment: jest.Mock };
  pulls: { createReplyForReviewComment: jest.Mock };
  users: { getAuthenticated: jest.Mock };
}

/** Octokit stub covering exactly what detection + reopen touch. */
function mockOctokit(opts: {
  issueComments?: Array<{ body: string; user?: string }>;
  threads?: ReviewThread[];
  listCommentsError?: boolean;
} = {}): MockOctokit {
  return {
    // fetchReviewThreads (query) + resolve/unresolve/minimize (mutations)
    graphql: jest.fn().mockImplementation((query: string) => {
      if (query.includes('reviewThreads')) {
        return Promise.resolve({
          repository: { pullRequest: { reviewThreads: { nodes: opts.threads ?? [] } } },
        });
      }
      return Promise.resolve({});
    }),
    paginate: jest.fn().mockImplementation(() => {
      if (opts.listCommentsError) return Promise.reject(new Error('boom'));
      return Promise.resolve(
        (opts.issueComments ?? []).map((c, i) => ({
          id: i + 1,
          node_id: `node_${i + 1}`,
          body: c.body,
          user: { login: c.user ?? BOT },
        })),
      );
    }),
    issues: {
      listComments: {},
      createComment: jest.fn().mockResolvedValue({ data: { id: 99, html_url: 'http://c/99' } }),
      updateComment: jest.fn().mockResolvedValue({ data: { id: 99, html_url: 'http://c/99' } }),
    },
    pulls: { createReplyForReviewComment: jest.fn().mockResolvedValue({}) },
    users: { getAuthenticated: jest.fn().mockResolvedValue({ data: { login: BOT } }) },
  };
}

function commenterWith(octokit: MockOctokit): PRCommenter {
  return new PRCommenter(octokit as unknown as Octokit, 'acme', 'widget', 42);
}

/** A resolved (or open) thread whose first comment is one of our inline findings. */
function thread(opts: {
  id: string;
  isResolved?: boolean;
  file?: string;
  line?: number;
  title?: string;
  severity?: 'critical' | 'high' | 'medium';
  extraComments?: Array<{ author: string; body: string }>;
}): ReviewThread {
  const file = opts.file ?? 'src/a.ts';
  const title = opts.title ?? 'SQL injection via raw query';
  const severity = opts.severity ?? 'critical';
  const firstBody = [
    INLINE_COMMENT_MARKER,
    buildFingerprintMarker(file, title),
    `**${SEVERITY_TAGS[severity]}:** ${title}`,
    '',
    'Details…',
  ].join('\n');
  return {
    id: opts.id,
    isResolved: opts.isResolved ?? true,
    comments: {
      nodes: [
        {
          databaseId: 1000,
          author: { login: 'github-actions' },
          body: firstBody,
          path: file,
          line: opts.line ?? 10,
          createdAt: '2026-07-01T00:00:00Z',
        },
        ...(opts.extraComments ?? []).map((c, i) => ({
          databaseId: 2000 + i,
          author: { login: c.author },
          body: c.body,
          path: file,
          line: opts.line ?? 10,
          createdAt: '2026-07-02T00:00:00Z',
        })),
      ],
    },
  };
}

function finding(overrides: Partial<RegressedFinding> = {}): RegressedFinding {
  return {
    file: 'src/a.ts',
    line: 10,
    title: 'SQL injection via raw query',
    severity: 'critical',
    description: 'User input reaches a raw SQL string.',
    ...overrides,
  };
}

const unresolveCalls = (octokit: MockOctokit): number =>
  octokit.graphql.mock.calls.filter(([q]: [string]) => q.includes('unresolveReviewThread')).length;

describe('re-run detection', () => {
  it('latches on a prior completed-review summary (even a minimized one)', async () => {
    const octokit = mockOctokit({
      issueComments: [{ body: `${COMMENT_MARKER}\n## AI Code Review\n…\n${REVIEW_COMPLETE_MARKER}` }],
    });
    const commenter = commenterWith(octokit);

    expect(commenter.isRerun()).toBe(false);
    await commenter.postOrUpdateComment('## progress'); // first post scans + minimizes
    expect(commenter.isRerun()).toBe(true);
  });

  it('counts prior completed reviews as the re-run number', async () => {
    const octokit = mockOctokit({
      issueComments: [
        { body: `${COMMENT_MARKER}\n## AI Code Review\n${REVIEW_COMPLETE_MARKER}` },
        { body: `${COMMENT_MARKER}\n## AI Code Review — Re-run #1\n${REVIEW_COMPLETE_MARKER}` },
        { body: `${COMMENT_MARKER}\n## ⏳ AI Code Review\n\nprogress only` }, // no complete marker
      ],
    });
    const commenter = commenterWith(octokit);

    expect(commenter.rerunNumber()).toBe(0);
    await commenter.postOrUpdateComment('## progress');
    expect(commenter.isRerun()).toBe(true);
    expect(commenter.rerunNumber()).toBe(2); // two completed reviews before this one
  });

  it('reports re-run number 0 on a first run', async () => {
    const octokit = mockOctokit({
      issueComments: [{ body: `${COMMENT_MARKER}\n## ⏳ AI Code Review\n\nprogress only` }],
    });
    const commenter = commenterWith(octokit);

    await commenter.postOrUpdateComment('## progress');
    expect(commenter.rerunNumber()).toBe(0);
  });

  it('ignores progress/error comments that never reached completion', async () => {
    const octokit = mockOctokit({
      issueComments: [{ body: `${COMMENT_MARKER}\n## ⏳ AI Code Review\n\nReview starting...` }],
    });
    const commenter = commenterWith(octokit);

    await commenter.postOrUpdateComment('## progress');
    expect(commenter.isRerun()).toBe(false);
  });

  it("ignores another user's comment carrying the marker", async () => {
    const octokit = mockOctokit({
      issueComments: [{ body: `${COMMENT_MARKER}\n${REVIEW_COMPLETE_MARKER}`, user: 'some-human' }],
    });
    const commenter = commenterWith(octokit);

    await commenter.postOrUpdateComment('## progress');
    expect(commenter.isRerun()).toBe(false);
  });

  it('fails open to first-run behavior when the comment scan errors', async () => {
    const octokit = mockOctokit({ listCommentsError: true });
    const commenter = commenterWith(octokit);

    await commenter.postOrUpdateComment('## progress');
    expect(commenter.isRerun()).toBe(false);
  });
});

describe('reopenRegressedThreads', () => {
  it('reopens a resolved thread on a fingerprint match and posts the templated reply', async () => {
    const octokit = mockOctokit({ threads: [thread({ id: 't1' })] });
    const commenter = commenterWith(octokit);

    const reopened = await commenter.reopenRegressedThreads([finding()]);

    expect(reopened).toBe(1);
    expect(unresolveCalls(octokit)).toBe(1);
    expect(octokit.pulls.createReplyForReviewComment).toHaveBeenCalledTimes(1);
    const body = octokit.pulls.createReplyForReviewComment.mock.calls[0][0].body as string;
    expect(body).toContain(REOPEN_MARKER);
    expect(body).toContain(SEVERITY_TAGS.critical);
    expect(body).toContain('User input reaches a raw SQL string.');
    expect(body).toContain('Reopened automatically');
  });

  it('reopens on tight location proximity when the old thread was critical/high', async () => {
    const octokit = mockOctokit({ threads: [thread({ id: 't1', line: 10, severity: 'high' })] });
    const commenter = commenterWith(octokit);

    // Different title (no fingerprint match), 2 lines away.
    const reopened = await commenter.reopenRegressedThreads([
      finding({ title: 'Reworded: injection reachable', line: 12, severity: 'high' }),
    ]);

    expect(reopened).toBe(1);
  });

  it('never reopens a medium-tagged thread on a location-only match', async () => {
    const octokit = mockOctokit({ threads: [thread({ id: 't1', line: 10, severity: 'medium' })] });
    const commenter = commenterWith(octokit);

    const reopened = await commenter.reopenRegressedThreads([
      finding({ title: 'Different title entirely', line: 10 }),
    ]);

    expect(reopened).toBe(0);
    expect(unresolveCalls(octokit)).toBe(0);
  });

  it('skips threads resolved after an accepted human justification', async () => {
    const octokit = mockOctokit({
      threads: [thread({
        id: 't1',
        extraComments: [{ author: 'github-actions', body: `Reply…\n\n${RESOLUTION_FOOTER}` }],
      })],
    });
    const commenter = commenterWith(octokit);

    expect(await commenter.reopenRegressedThreads([finding()])).toBe(0);
    expect(unresolveCalls(octokit)).toBe(0);
  });

  it('skips threads where a human spoke last', async () => {
    const octokit = mockOctokit({
      threads: [thread({
        id: 't1',
        extraComments: [{ author: 'dev-user', body: 'this is fine, see ticket' }],
      })],
    });
    const commenter = commenterWith(octokit);

    expect(await commenter.reopenRegressedThreads([finding()])).toBe(0);
  });

  it('ignores threads that are still unresolved', async () => {
    const octokit = mockOctokit({ threads: [thread({ id: 't1', isResolved: false })] });
    const commenter = commenterWith(octokit);

    expect(await commenter.reopenRegressedThreads([finding()])).toBe(0);
  });

  it('caps reopens at REOPEN_THREADS_MAX_PER_RUN', async () => {
    const threads = Array.from({ length: REOPEN_THREADS_MAX_PER_RUN + 5 }, (_, i) =>
      thread({ id: `t${i}`, file: `src/f${i}.ts`, title: `Issue ${i}` }));
    const findings = threads.map((_, i) =>
      finding({ file: `src/f${i}.ts`, title: `Issue ${i}` }));
    const octokit = mockOctokit({ threads });
    const commenter = commenterWith(octokit);

    expect(await commenter.reopenRegressedThreads(findings)).toBe(REOPEN_THREADS_MAX_PER_RUN);
  });

  it('degrades per-thread on mutation failure without throwing', async () => {
    const octokit = mockOctokit({ threads: [thread({ id: 't1' })] });
    octokit.graphql.mockImplementation((query: string) => {
      if (query.includes('reviewThreads')) {
        return Promise.resolve({
          repository: { pullRequest: { reviewThreads: { nodes: [thread({ id: 't1' })] } } },
        });
      }
      if (query.includes('unresolveReviewThread')) return Promise.reject(new Error('403'));
      return Promise.resolve({});
    });
    const commenter = commenterWith(octokit);

    expect(await commenter.reopenRegressedThreads([finding()])).toBe(0);
    expect(octokit.pulls.createReplyForReviewComment).not.toHaveBeenCalled();
  });

  it('warns once with remediation when the token lacks push access', async () => {
    const core = jest.requireMock('@actions/core') as { warning: jest.Mock };
    core.warning.mockClear();
    const threads = [
      thread({ id: 't1', file: 'src/a.ts', title: 'Issue A' }),
      thread({ id: 't2', file: 'src/b.ts', title: 'Issue B' }),
    ];
    const octokit = mockOctokit({ threads });
    octokit.graphql.mockImplementation((query: string) => {
      if (query.includes('reviewThreads')) {
        return Promise.resolve({ repository: { pullRequest: { reviewThreads: { nodes: threads } } } });
      }
      if (query.includes('unresolveReviewThread')) {
        return Promise.reject(new Error('Resource not accessible by integration'));
      }
      return Promise.resolve({});
    });
    const commenter = commenterWith(octokit);

    const reopened = await commenter.reopenRegressedThreads([
      finding({ file: 'src/a.ts', title: 'Issue A' }),
      finding({ file: 'src/b.ts', title: 'Issue B' }),
    ]);

    expect(reopened).toBe(0);
    // Both threads failed, but the permission warning fires exactly once and
    // names the fix (contents: write).
    const permWarnings = core.warning.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('contents: write'),
    );
    expect(permWarnings).toHaveLength(1);
  });
});
