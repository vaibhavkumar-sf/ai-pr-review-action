import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireLocalRepo } from '../../src/context/local/local-repo';
import { createGitRunner, GitRunner } from '../../src/context/local/git';
import { makeConfig } from '../fixtures/factory';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

const HEAD_SHA = 'abc123def456abc123def456abc123def456abc1';

/** Records every git invocation; behavior is driven by a handler. */
function fakeGit(handler: (args: string[]) => string | Error): { git: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    const result = handler(args);
    if (result instanceof Error) throw result;
    return { stdout: result, exitCode: 0 };
  };
  return { git, calls };
}

describe('acquireLocalRepo', () => {
  const savedEnv = { workspace: process.env.GITHUB_WORKSPACE, runnerTemp: process.env.RUNNER_TEMP };
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    fs.mkdirSync(path.join(workspaceDir, '.git'));
    process.env.GITHUB_WORKSPACE = workspaceDir;
    delete process.env.RUNNER_TEMP;
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    if (savedEnv.workspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = savedEnv.workspace;
    if (savedEnv.runnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedEnv.runnerTemp;
  });

  it('reuses the workspace checkout when its HEAD is exactly the PR head SHA', async () => {
    const { git, calls } = fakeGit((args) => (args[0] === 'rev-parse' ? `${HEAD_SHA}\n` : ''));

    const repo = await acquireLocalRepo(makeConfig(), HEAD_SHA, git);

    expect(repo?.source).toBe('workspace');
    expect(repo?.dir).toBe(workspaceDir);
    // safe.directory must be configured before any workspace git command.
    expect(calls[0]).toEqual(['config', '--global', '--add', 'safe.directory', workspaceDir]);
  });

  it('rejects a workspace at a different SHA (merge commit) and shallow-fetches the head', async () => {
    const { git, calls } = fakeGit((args) => (args[0] === 'rev-parse' ? 'mergecommitsha\n' : ''));

    const repo = await acquireLocalRepo(makeConfig(), HEAD_SHA, git);

    expect(repo?.source).toBe('clone');
    const fetch = calls.find((args) => args[0] === 'fetch');
    expect(fetch).toBeDefined();
    expect(fetch).toEqual(expect.arrayContaining(['--depth', '1', 'origin', HEAD_SHA]));
    const checkout = calls.find((args) => args[0] === 'checkout');
    expect(checkout).toContain('FETCH_HEAD');
    await repo?.cleanup();
  });

  it('retries the fetch without the blob filter when the server rejects it', async () => {
    let fetches = 0;
    const { git, calls } = fakeGit((args) => {
      if (args[0] === 'rev-parse') return 'othersha\n';
      if (args[0] === 'fetch') {
        fetches++;
        if (args.some((a) => a.startsWith('--filter='))) return new Error('filter not supported');
      }
      return '';
    });

    const repo = await acquireLocalRepo(makeConfig(), HEAD_SHA, git);

    expect(repo?.source).toBe('clone');
    expect(fetches).toBe(2);
    expect(calls.filter((a) => a[0] === 'fetch')[1].some((a) => a.startsWith('--filter='))).toBe(false);
    await repo?.cleanup();
  });

  it('returns null when the clone fails entirely (caller falls back to the API engine)', async () => {
    const { git } = fakeGit(() => new Error('network down'));

    const repo = await acquireLocalRepo(makeConfig(), HEAD_SHA, git);

    expect(repo).toBeNull();
  });

  it('cleanup removes the scratch clone directory', async () => {
    const { git } = fakeGit((args) => (args[0] === 'rev-parse' ? 'othersha\n' : ''));

    const repo = await acquireLocalRepo(makeConfig(), HEAD_SHA, git);
    expect(repo).not.toBeNull();
    expect(fs.existsSync(repo!.dir)).toBe(true);

    await repo!.cleanup();
    expect(fs.existsSync(repo!.dir)).toBe(false);
  });
});

describe('createGitRunner', () => {
  it('redacts secret values from error messages', async () => {
    const git = createGitRunner(['supersecrettoken']);

    const err = await git(['--config-env=x=supersecrettoken', 'not-a-real-command'], { timeoutMs: 10000 })
      .catch((e: Error) => e) as Error;

    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('supersecrettoken');
    expect(err.message).toContain('***');
  });
});
