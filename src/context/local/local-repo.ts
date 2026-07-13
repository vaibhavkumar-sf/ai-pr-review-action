/**
 * Acquires a local working copy of the reviewed repository at the PR HEAD SHA.
 *
 * WHY HEAD SHA (not the merge commit): every other part of the pipeline is
 * head-side — changed-file contents are fetched at head, inline comments use
 * `line + side: 'RIGHT'` against head, and diff-hunk newLineNumbers are head
 * line numbers. `actions/checkout` on pull_request events checks out the
 * MERGE commit (refs/pull/N/merge) whose tree differs from head, so a naive
 * workspace reuse would silently desynchronize every line number. We only
 * reuse the workspace when its HEAD is exactly the PR head SHA; otherwise we
 * shallow-fetch that SHA ourselves.
 *
 * Best-effort by contract: any failure returns null and the caller falls back
 * to the GitHub-API-based context engine.
 */

import * as core from '@actions/core';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ActionConfig } from '../../types';
import { GIT_ACQUIRE_TIMEOUT_MS, LOCAL_CLONE_BLOB_LIMIT } from '../../config/limits';
import { createGitRunner, GitRunner } from './git';

export interface LocalRepo {
  /** Absolute path of the working tree at the PR head SHA. */
  dir: string;
  source: 'workspace' | 'clone';
  /** Removes the scratch clone; no-op for a reused workspace. */
  cleanup(): Promise<void>;
}

export async function acquireLocalRepo(
  config: ActionConfig,
  headSha: string,
  git: GitRunner = createGitRunner([config.githubToken]),
): Promise<LocalRepo | null> {
  const fromWorkspace = await tryWorkspace(headSha, git);
  if (fromWorkspace) return fromWorkspace;
  return shallowClone(config, headSha, git);
}

/**
 * Reuses the runner workspace mounted into the container when the consuming
 * workflow already checked out exactly the head SHA.
 */
async function tryWorkspace(headSha: string, git: GitRunner): Promise<LocalRepo | null> {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) return null;
  try {
    await fs.access(path.join(workspace, '.git'));
    // The container runs as root while the mounted workspace is runner-owned;
    // without safe.directory every git command fails ("dubious ownership").
    // Global config is required — git ignores safe.directory passed via -c.
    // The container filesystem is ephemeral, so the global write is harmless.
    await git(['config', '--global', '--add', 'safe.directory', workspace], {
      timeoutMs: GIT_ACQUIRE_TIMEOUT_MS,
    });
    const { stdout } = await git(['rev-parse', 'HEAD'], {
      cwd: workspace,
      timeoutMs: GIT_ACQUIRE_TIMEOUT_MS,
    });
    if (stdout.trim() !== headSha) {
      core.info(
        `Workspace checkout is ${stdout.trim().substring(0, 7)} (likely the PR merge commit), `
        + `not head ${headSha.substring(0, 7)} — using a shallow fetch instead`,
      );
      return null;
    }
    core.info(`Local context: reusing workspace checkout at head ${headSha.substring(0, 7)}`);
    return { dir: workspace, source: 'workspace', cleanup: async () => undefined };
  } catch {
    return null;
  }
}

/** Shallow-fetches exactly the head SHA into a scratch directory. */
async function shallowClone(
  config: ActionConfig,
  headSha: string,
  git: GitRunner,
): Promise<LocalRepo | null> {
  const { owner, repo } = config;
  const scratchRoot = process.env.RUNNER_TEMP ?? os.tmpdir();
  const dir = await fs.mkdtemp(path.join(scratchRoot, 'ai-pr-review-repo-'));
  const cleanup = async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // scratch space on an ephemeral runner — best effort
    }
  };
  // The token rides in the remote URL; it is redacted from errors by the
  // runner and this URL is NEVER logged.
  const remoteUrl = `https://x-access-token:${config.githubToken}@github.com/${owner}/${repo}`;
  const timeoutMs = GIT_ACQUIRE_TIMEOUT_MS;

  try {
    core.info(`Local context: fetching ${owner}/${repo}@${headSha.substring(0, 7)} (shallow)`);
    await git(['init', '--quiet', dir], { timeoutMs });
    await git(['remote', 'add', 'origin', remoteUrl], { cwd: dir, timeoutMs });
    try {
      // Skip huge blobs (they exceed every related-file budget anyway).
      await git(
        ['fetch', '--quiet', '--depth', '1', '--no-tags', `--filter=blob:limit=${LOCAL_CLONE_BLOB_LIMIT}`, 'origin', headSha],
        { cwd: dir, timeoutMs },
      );
    } catch {
      // Some servers reject partial-clone filters — retry a plain shallow fetch.
      await git(['fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', headSha], { cwd: dir, timeoutMs });
    }
    await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], { cwd: dir, timeoutMs });
    return { dir, source: 'clone', cleanup };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`Local repo acquisition failed: ${message}. Falling back to API-based related context`);
    await cleanup();
    return null;
  }
}
