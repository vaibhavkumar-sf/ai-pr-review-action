/**
 * RepoTree implementation over a local checkout: one `git ls-files` call
 * (respects .gitignore and matches exactly what the PR head tree contains)
 * builds the same in-memory index the Git-Trees-API path uses, so all the
 * framework heuristics (Angular siblings, LB4 DI keys) and ranking helpers in
 * related-files.ts run unchanged against local checkouts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RepoTree } from '../repo-tree';
import { GIT_ACQUIRE_TIMEOUT_MS } from '../../config/limits';
import { createGitRunner, GitRunner } from './git';

export async function buildLocalFileIndex(
  repoDir: string,
  git: GitRunner = createGitRunner([]),
): Promise<RepoTree> {
  let listing: string[];
  try {
    // --others --exclude-standard also covers directories that are not (yet)
    // a git checkout of their own, e.g. test fixtures inside another repo.
    const { stdout } = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoDir,
      timeoutMs: GIT_ACQUIRE_TIMEOUT_MS,
    });
    listing = stdout.split('\0');
  } catch {
    listing = walkDir(repoDir);
  }

  const paths = new Set<string>();
  const dirs = new Map<string, string[]>();
  for (const p of listing) {
    if (!p) continue;
    paths.add(p);
    const slash = p.lastIndexOf('/');
    const dir = slash === -1 ? '' : p.substring(0, slash);
    const children = dirs.get(dir);
    if (children) children.push(p);
    else dirs.set(dir, [p]);
  }

  // Sizes are stat-ed lazily: ranking only inspects the (bounded) candidate
  // set, so eagerly stating 15k files would be pure waste.
  const sizeCache = new Map<string, number | undefined>();
  const size = (p: string): number | undefined => {
    if (sizeCache.has(p)) return sizeCache.get(p);
    let result: number | undefined;
    try {
      result = fs.statSync(path.join(repoDir, p)).size;
    } catch {
      result = undefined;
    }
    sizeCache.set(p, result);
    return result;
  };

  return {
    paths,
    has: (p) => paths.has(p),
    size,
    listDir: (dir) => dirs.get(dir) ?? [],

    findByDirSuffixAndName(dirSuffix, fileName) {
      const results: string[] = [];
      for (const [dir, children] of dirs) {
        if (dir !== dirSuffix && !dir.endsWith('/' + dirSuffix)) continue;
        for (const child of children) {
          if (child.endsWith('/' + fileName) || child === fileName) results.push(child);
        }
      }
      return results;
    },

    nearestUp(fromDir, pattern) {
      let dir = fromDir;
      while (true) {
        for (const child of dirs.get(dir) ?? []) {
          const base = child.substring(child.lastIndexOf('/') + 1);
          if (pattern.test(base)) return child;
        }
        if (dir === '') return null;
        const slash = dir.lastIndexOf('/');
        dir = slash === -1 ? '' : dir.substring(0, slash);
      }
    },
  };
}

/** Filesystem fallback when git listing is unavailable. */
function walkDir(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) results.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return results;
}
