/**
 * npm-workspace package resolution for related-context gathering. In
 * monorepos, imports like '@local/rakuten-core/foo' refer to sibling
 * workspace packages (packages/rakuten-core), not npm registry packages.
 * Resolution is lazy: a directory-basename heuristic confirmed by one cached
 * package.json fetch per import prefix, with a bounded scan as fallback.
 */

import * as core from '@actions/core';
import { minimatch } from 'minimatch';
import { WORKSPACE_PKG_FETCH_MAX } from '../config/limits';
import { RepoTree, resolveWithExtensions } from './repo-tree';
import { FetchText } from './ts-paths';

export interface WorkspaceResolver {
  /** '@local/rakuten-core/foo' → 'packages/rakuten-core/src/foo.ts', or null (external pkg). */
  resolve(importPath: string): Promise<string | null>;
}

/** A resolver that never matches (no workspaces declared). */
export const NULL_WORKSPACE_RESOLVER: WorkspaceResolver = { resolve: async () => null };

export async function buildWorkspaceResolver(
  fetchText: FetchText,
  tree: RepoTree,
): Promise<WorkspaceResolver> {
  const rootRaw = await fetchText('package.json');
  if (rootRaw === null) return NULL_WORKSPACE_RESOLVER;

  let workspaceGlobs: string[];
  try {
    const pkg = JSON.parse(rootRaw);
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (!Array.isArray(ws) || ws.length === 0) return NULL_WORKSPACE_RESOLVER;
    workspaceGlobs = ws;
  } catch {
    return NULL_WORKSPACE_RESOLVER;
  }

  // Workspace dirs = dirs containing a package.json that match a workspaces glob.
  const workspaceDirs: string[] = [];
  for (const path of tree.paths) {
    if (!path.endsWith('/package.json')) continue;
    const dir = path.substring(0, path.length - '/package.json'.length);
    if (workspaceGlobs.some((glob) => minimatch(dir, glob, { dot: true }))) {
      workspaceDirs.push(dir);
    }
  }
  if (workspaceDirs.length === 0) return NULL_WORKSPACE_RESOLVER;

  // packageName -> workspace dir (or null = confirmed external), filled lazily.
  const nameToDir = new Map<string, string | null>();
  let pkgFetches = 0;

  async function dirForPackage(packageName: string): Promise<string | null> {
    const cached = nameToDir.get(packageName);
    if (cached !== undefined) return cached;

    // Basename heuristic first: '@local/rakuten-core' → dir ending '/rakuten-core'.
    const unscoped = packageName.includes('/') ? packageName.split('/')[1] : packageName;
    const candidates = [
      ...workspaceDirs.filter((d) => d === unscoped || d.endsWith('/' + unscoped)),
      ...workspaceDirs.filter((d) => d !== unscoped && !d.endsWith('/' + unscoped)),
    ];

    for (const dir of candidates) {
      if (pkgFetches >= WORKSPACE_PKG_FETCH_MAX) break;
      pkgFetches++;
      const raw = await fetchText(`${dir}/package.json`);
      if (raw === null) continue;
      try {
        const name = JSON.parse(raw).name;
        if (typeof name === 'string') {
          nameToDir.set(name, dir);
          if (name === packageName) return dir;
        }
      } catch {
        // unparseable package.json — skip
      }
      // Re-check: an earlier fetch in this loop may have registered our target.
      const found = nameToDir.get(packageName);
      if (found !== undefined) return found;
    }

    nameToDir.set(packageName, null);
    return null;
  }

  return {
    async resolve(importPath) {
      try {
        // Package name = first segment, or first two for @scoped packages.
        const segments = importPath.split('/');
        const packageName = importPath.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
        if (!packageName) return null;

        const dir = await dirForPackage(packageName);
        if (!dir) return null;

        const subpath = importPath.substring(packageName.length).replace(/^\//, '');
        if (!subpath) {
          // Bare import → the package's source entry point.
          return resolveWithExtensions(tree, `${dir}/src/index`) ?? resolveWithExtensions(tree, `${dir}/index`);
        }
        return (
          resolveWithExtensions(tree, `${dir}/${subpath}`) ??
          resolveWithExtensions(tree, `${dir}/src/${subpath}`)
        );
      } catch (err) {
        core.debug(`Workspace resolution failed for ${importPath}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
  };
}
