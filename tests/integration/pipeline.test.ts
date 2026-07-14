/**
 * Full-pipeline smoke test: drives src/pipeline/orchestrator.runReview end to end
 * with the heavy boundaries stubbed (Octokit, AI provider, context gathering,
 * agents, PR commenter, description updater). The pure results layer
 * (dedup → merge → format) runs for real, so the test exercises the actual
 * finding-processing path and output wiring.
 */
import { makeAgentResult, makeChangedFile, makeConfig, makeContext, makeFinding } from '../fixtures/factory';

jest.mock('@octokit/rest', () => ({ Octokit: jest.fn(() => ({})) }));

jest.mock('@actions/core', () => ({
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  setSecret: jest.fn(),
  summary: { addRaw: () => ({ write: () => Promise.resolve() }) },
}));

jest.mock('../../src/pipeline/description-updater', () => ({
  appendToPRDescription: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/context', () => ({ gatherAllContext: jest.fn() }));
jest.mock('../../src/agents', () => ({ createAgents: jest.fn() }));

jest.mock('../../src/github/inline-reviewer', () => {
  const instance = { postReview: jest.fn().mockResolvedValue(1) };
  return {
    InlineReviewer: jest.fn(() => instance),
    INLINE_COMMENT_MARKER: '<!-- ai-pr-review-inline -->',
    buildFingerprintMarker: jest.fn(() => '<!-- fp -->'),
    __instance: instance,
  };
});

jest.mock('../../src/providers/provider-factory', () => {
  const provider = {
    logDiagnostics: jest.fn().mockResolvedValue(undefined),
    verifyConnection: jest.fn().mockResolvedValue({ model: 'glm-5.2', latencyMs: 100, outputTokens: 5 }),
    getResolvedModel: jest.fn(() => 'glm-5.2'),
    getModelUsage: jest.fn(() => [{ model: 'glm-5.2', calls: 2, inputTokens: 1000, outputTokens: 200 }]),
    chat: jest.fn().mockResolvedValue({ content: '{}', inputTokens: 1, outputTokens: 1 }),
  };
  return { createAIProvider: jest.fn(() => provider), __provider: provider };
});

jest.mock('../../src/github/pr-commenter', () => {
  const instance = {
    postOrUpdateComment: jest.fn().mockResolvedValue({ commentId: 'c1', commentUrl: 'https://gh/c1' }),
    cleanupBotComments: jest.fn().mockResolvedValue(2),
    updateProgress: jest.fn().mockResolvedValue(undefined),
    resolveStaleInlineComments: jest.fn().mockResolvedValue(0),
    reopenRegressedThreads: jest.fn().mockResolvedValue(0),
    isRerun: jest.fn().mockReturnValue(false),
    rerunNumber: jest.fn().mockReturnValue(0),
  };
  return {
    PRCommenter: jest.fn(() => instance),
    REVIEW_COMPLETE_MARKER: '<!-- ai-pr-review-complete -->',
    REOPEN_MARKER: '<!-- ai-pr-review-reopen -->',
    __instance: instance,
  };
});

import * as core from '@actions/core';
import { runReview } from '../../src/pipeline/orchestrator';
import { gatherAllContext } from '../../src/context';
import { createAgents } from '../../src/agents';

const providerMock = jest.requireMock('../../src/providers/provider-factory').__provider;
const commenter = jest.requireMock('../../src/github/pr-commenter').__instance;
const inlineReviewer = jest.requireMock('../../src/github/inline-reviewer').__instance;
const { appendToPRDescription } = jest.requireMock('../../src/pipeline/description-updater');

function output(key: string): unknown {
  const call = (core.setOutput as jest.Mock).mock.calls.find(c => c[0] === key);
  return call ? call[1] : undefined;
}

function stubAgent(findings = [
  makeFinding(),
  makeFinding({ severity: 'medium', category: 'code-quality', line: 3, title: 'Inline return type' }),
  makeFinding({ severity: 'critical', category: 'security', line: 9, title: 'SQL injection' }),
  makeFinding({ severity: 'low', category: 'documentation', line: 20, title: 'Missing JSDoc on createUser' }),
]) {
  return {
    name: 'comprehensive',
    category: 'comprehensive',
    review: jest.fn().mockResolvedValue(makeAgentResult({ findings })),
  };
}

const baseConfig = () => makeConfig({
  reviewMode: 'combined',
  postInlineComments: false,
  enableReplyHandling: false,
  enableDiagrams: false,
  postDataUrl: '',
});

describe('runReview pipeline (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    providerMock.verifyConnection.mockResolvedValue({ model: 'glm-5.2', latencyMs: 100, outputTokens: 5 });
    providerMock.getResolvedModel.mockReturnValue('glm-5.2');
    commenter.postOrUpdateComment.mockResolvedValue({ commentId: 'c1', commentUrl: 'https://gh/c1' });
    commenter.cleanupBotComments.mockResolvedValue(2);
    commenter.resolveStaleInlineComments.mockResolvedValue(0);
    commenter.reopenRegressedThreads.mockResolvedValue(0);
    commenter.isRerun.mockReturnValue(false);
    (createAgents as jest.Mock).mockReturnValue([stubAgent()]);
  });

  it('runs a happy-path review: posts the summary and sets completed outputs', async () => {
    (gatherAllContext as jest.Mock).mockResolvedValue(makeContext());

    await expect(runReview(baseConfig())).resolves.toBeUndefined();

    expect(output('review_status')).toBe('completed');
    expect(output('total_findings')).toBe(4);
    expect(output('critical_count')).toBe(1);

    // The final review comment (real formatter output) reached the PR.
    const posted: string[] = commenter.postOrUpdateComment.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(posted.some((c: string) => c.includes('SQL injection'))).toBe(true);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('re-run: inlines only critical/high, reopens regressed threads, keeps the description', async () => {
    commenter.isRerun.mockReturnValue(true);
    commenter.rerunNumber.mockReturnValue(2);
    commenter.reopenRegressedThreads.mockResolvedValue(1);
    inlineReviewer.postReview.mockResolvedValue(1);
    (gatherAllContext as jest.Mock).mockResolvedValue(makeContext());

    const config = makeConfig({ ...baseConfig(), postInlineComments: true });
    await expect(runReview(config)).resolves.toBeUndefined();

    // Critical/high findings plus the low documentation suggestion reach the
    // inline reviewer — the medium one stays summary-only on a re-run.
    const inlined = inlineReviewer.postReview.mock.calls[0][0] as Array<{ severity: string; category: string }>;
    expect(inlined.map(f => `${f.severity}:${f.category}`).sort()).toEqual(
      ['critical:security', 'high:security', 'low:documentation'],
    );

    // Regressed critical/high findings were offered for thread reopening.
    expect(commenter.reopenRegressedThreads).toHaveBeenCalledTimes(1);
    expect(output('threads_reopened')).toBe(1);

    // The description updater was told this is a re-run (it keeps the old body).
    expect((appendToPRDescription as jest.Mock).mock.calls[0][5]).toBe(true);

    // Summary totals still count ALL severities, and the completion marker +
    // re-run note are embedded for the next run.
    expect(output('total_findings')).toBe(4);
    const posted: string[] = commenter.postOrUpdateComment.mock.calls.map((c: unknown[]) => c[0] as string);
    const finalPost = posted[posted.length - 1];
    expect(finalPost).toContain('<!-- ai-pr-review-complete -->');
    expect(finalPost).toContain('Re-run focus');
    expect(finalPost).toContain('AI Code Review — Re-run #2');
  });

  it('first run: inlines every severity and never calls the reopen path', async () => {
    commenter.isRerun.mockReturnValue(false);
    inlineReviewer.postReview.mockResolvedValue(4);
    (gatherAllContext as jest.Mock).mockResolvedValue(makeContext());

    const config = makeConfig({ ...baseConfig(), postInlineComments: true });
    await expect(runReview(config)).resolves.toBeUndefined();

    const inlined = inlineReviewer.postReview.mock.calls[0][0] as Array<{ severity: string }>;
    expect(inlined.map(f => f.severity).sort()).toEqual(['critical', 'high', 'low', 'medium']);
    expect(commenter.reopenRegressedThreads).not.toHaveBeenCalled();
    expect((appendToPRDescription as jest.Mock).mock.calls[0][5]).toBe(false);
    // Completion marker still embedded so the NEXT run detects a re-run.
    const posted: string[] = commenter.postOrUpdateComment.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(posted[posted.length - 1]).toContain('<!-- ai-pr-review-complete -->');
    expect(posted[posted.length - 1]).not.toContain('Re-run focus');
  });

  it('skips gracefully when the AI pre-flight fails', async () => {
    providerMock.verifyConnection.mockRejectedValue(new Error('endpoint hung — no first token'));
    (gatherAllContext as jest.Mock).mockResolvedValue(makeContext());

    await expect(runReview(baseConfig())).resolves.toBeUndefined();

    expect(output('review_status')).toBe('failed');
    expect(output('skip_reason')).toBe('ai_unreachable');
    expect(core.setFailed).toHaveBeenCalled();
    // Context gathering must not run once the endpoint is unreachable.
    expect(gatherAllContext).not.toHaveBeenCalled();
  });

  it('skips when the PR exceeds max_files_to_review', async () => {
    const tooMany = Array.from({ length: 60 }, (_, i) => makeChangedFile({ filename: `src/f${i}.ts` }));
    (gatherAllContext as jest.Mock).mockResolvedValue(makeContext({ changedFiles: tooMany }));

    await expect(runReview(makeConfig({ ...baseConfig(), maxFilesToReview: 50 }))).resolves.toBeUndefined();

    expect(output('review_status')).toBe('skipped');
    expect(output('skip_reason')).toBe('too_many_files');
    expect(createAgents).not.toHaveBeenCalled();
  });
});
