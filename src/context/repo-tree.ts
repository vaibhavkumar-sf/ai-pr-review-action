/**
 * In-memory index of the repository file tree at the PR head, built from a
 * single recursive Git Trees API call. All related-context resolution (import
 * targets, framework siblings, barrels, DI bindings) becomes Set/Map lookups
 * against this index — no per-candidate 404 probing.
 */

import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';

export interface RepoTree {
  /** True when a blob exists at exactly this path. */
  has(path: string): boolean;
  /** Blob size in bytes as reported by the tree entry, if known. */
  size(path: string): number | undefined;
  /** Immediate child FILE paths of a directory ('' = repo root). */
  listDir(dir: string): readonly string[];
  /**
   * Finds files named `fileName` whose parent directory path ends with
   * `dirSuffix` (e.g. ('datasources', 'pgdb.datasource.ts') matches
   * 'services/x/src/datasources/pgdb.datasource.ts').
   */
  findByDirSuffixAndName(dirSuffix: string, fileName: string): string[];
  /**
   * Walks up from `fromDir` toward the root and returns the first file whose
   * basename matches `pattern` in the closest ancestor directory, or null.
   */
  nearestUp(fromDir: string, pattern: RegExp): string | null;
  /** Every blob path in the repository. */
  readonly paths: ReadonlySet<string>;
}

/**
 * Fetches the recursive tree at `ref`. Returns null when the tree is
 * truncated (repo too large for one listing) or the call fails — callers
 * fall back to legacy extension probing.
 */
export async function fetchRepoTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<RepoTree | null> {
  try {
    const { data } = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: ref,
      recursive: 'true',
    });

    if (data.truncated) {
      core.warning('Repository tree listing is truncated; related-context resolution degrades to relative-import probing');
      return null;
    }

    const paths = new Set<string>();
    const sizes = new Map<string, number>();
    const dirs = new Map<string, string[]>();

    for (const entry of data.tree) {
      if (entry.type !== 'blob' || !entry.path) continue;
      paths.add(entry.path);
      if (typeof entry.size === 'number') sizes.set(entry.path, entry.size);

      const slash = entry.path.lastIndexOf('/');
      const dir = slash === -1 ? '' : entry.path.substring(0, slash);
      const children = dirs.get(dir);
      if (children) children.push(entry.path);
      else dirs.set(dir, [entry.path]);
    }

    core.info(`Repo tree indexed: ${paths.size} files`);
    return buildIndex(paths, sizes, dirs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`Failed to fetch repository tree: ${message}. Related-context resolution degrades to relative-import probing`);
    return null;
  }
}

function buildIndex(
  paths: Set<string>,
  sizes: Map<string, number>,
  dirs: Map<string, string[]>,
): RepoTree {
  return {
    paths,
    has: (path) => paths.has(path),
    size: (path) => sizes.get(path),
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

/**
 * Resolves a base path (as written in an import, possibly without extension)
 * to an existing file by probing candidates against the tree.
 */
export function resolveWithExtensions(tree: RepoTree, basePath: string): string | null {
  const candidates = basePath.match(/\.[tj]sx?$/)
    ? [basePath]
    : [
        basePath,
        basePath + '.ts',
        basePath + '.tsx',
        basePath + '.js',
        basePath + '/index.ts',
        basePath + '/index.js',
      ];
  for (const candidate of candidates) {
    if (tree.has(candidate)) return candidate;
  }
  return null;
}
