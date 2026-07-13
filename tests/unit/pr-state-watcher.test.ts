import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { startPrStateWatcher } from '../../src/github/pr-state-watcher';
import { PR_STATE_POLL_INTERVAL_MS } from '../../src/config/limits';
import { makeConfig } from '../fixtures/factory';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  setSecret: jest.fn(),
  setOutput: jest.fn(),
}));

function makeOctokit(get: jest.Mock): Octokit {
  return { pulls: { get } } as unknown as Octokit;
}

describe('startPrStateWatcher', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('keeps quiet while the PR stays open', async () => {
    const get = jest.fn().mockResolvedValue({ data: { state: 'open', merged: false } });
    const stop = startPrStateWatcher(makeOctokit(get), makeConfig());

    await jest.advanceTimersByTimeAsync(PR_STATE_POLL_INTERVAL_MS * 2);
    stop();

    expect(get).toHaveBeenCalledTimes(2);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cancels the run with a neutral exit when the PR is merged', async () => {
    const get = jest.fn().mockResolvedValue({ data: { state: 'closed', merged: true } });
    const stop = startPrStateWatcher(makeOctokit(get), makeConfig());

    await jest.advanceTimersByTimeAsync(PR_STATE_POLL_INTERVAL_MS);
    stop();

    expect(core.setOutput).toHaveBeenCalledWith('review_status', 'cancelled');
    expect(core.setOutput).toHaveBeenCalledWith('skip_reason', 'pr_merged');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('reports pr_closed for a close without merge', async () => {
    const get = jest.fn().mockResolvedValue({ data: { state: 'closed', merged: false } });
    const stop = startPrStateWatcher(makeOctokit(get), makeConfig());

    await jest.advanceTimersByTimeAsync(PR_STATE_POLL_INTERVAL_MS);
    stop();

    expect(core.setOutput).toHaveBeenCalledWith('skip_reason', 'pr_closed');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('ignores poll failures and keeps the run alive', async () => {
    const get = jest.fn().mockRejectedValue(new Error('boom'));
    const stop = startPrStateWatcher(makeOctokit(get), makeConfig());

    await jest.advanceTimersByTimeAsync(PR_STATE_POLL_INTERVAL_MS * 3);
    stop();

    expect(get).toHaveBeenCalledTimes(3);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
