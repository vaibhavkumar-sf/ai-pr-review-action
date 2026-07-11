/**
 * tsconfig `compilerOptions.paths` alias resolution for related-context
 * gathering. Discovers the tsconfig(s) governing the changed files via the
 * repo tree (nearest ancestor per file, plus the Angular-convention root
 * tsconfig.app.json/tsconfig.base.json pair), follows local `extends` chains,
 * and resolves non-relative import specifiers through per-tsconfig matchers.
 *
 * Matchers are SCOPED to their tsconfig's directory: in a monorepo, one
 * package's aliases must not leak into another's files.
 */

import * as core from '@actions/core';
import { TSCONFIG_FETCH_MAX } from '../config/limits';
import { RepoTree, resolveWithExtensions } from './repo-tree';

export interface AliasResolver {
  /** Repo-relative resolved file path, or null when no alias matches. */
  resolve(importPath: string, fromFile: string): string | null;
}

export type FetchText = (path: string) => Promise<string | null>;

interface PathsEntry {
  /** Alias pattern as declared, e.g. '@rao/core/*' or 'exact-alias'. */
  pattern: string;
  /** Literal prefix before '*' ('' when no wildcard). */
  prefix: string;
  /** Literal suffix after '*' ('' when no wildcard or nothing follows). */
  suffix: string;
  hasWildcard: boolean;
  /** Substitution targets, repo-relative (baseUrl already applied). */
  targets: string[];
}

interface ScopedMatcher {
  /** Directory of the tsconfig ('' = repo root); files under it use this matcher. */
  scopeDir: string;
  entries: PathsEntry[];
}

/** A resolver that never matches (no tsconfig / no paths found). */
export const NULL_ALIAS_RESOLVER: AliasResolver = { resolve: () => null };

/**
 * Builds the alias resolver for a set of changed files. Fault-tolerant:
 * any fetch/parse failure degrades to fewer (or no) alias matchers.
 */
export async function buildAliasResolver(
  fetchText: FetchText,
  tree: RepoTree,
  changedFilePaths: string[],
): Promise<AliasResolver> {
  // 1. Discover candidate tsconfig paths: nearest tsconfig.json per changed
  //    file dir, plus root tsconfig.app.json/tsconfig.base.json when present
  //    (Angular CLI convention: app overrides base).
  const configPaths = new Set<string>();
  for (const file of changedFilePaths) {
    const dir = file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : '';
    const nearest = tree.nearestUp(dir, /^tsconfig\.json$/);
    if (nearest) configPaths.add(nearest);
    if (configPaths.size >= TSCONFIG_FETCH_MAX) break;
  }
  for (const rootConfig of ['tsconfig.app.json', 'tsconfig.base.json', 'tsconfig.json']) {
    if (tree.has(rootConfig)) configPaths.add(rootConfig);
  }

  // 2. Load each (following extends chains) into a scoped matcher.
  //    tsconfig.app.json is checked before tsconfig.base.json at the same
  //    scope because Sets preserve insertion order and app was added first.
  const matchers: ScopedMatcher[] = [];
  let fetches = 0;
  for (const configPath of configPaths) {
    if (fetches >= TSCONFIG_FETCH_MAX) break;
    const loaded = await loadEffectivePaths(fetchText, tree, configPath, () => fetches++);
    if (loaded && loaded.entries.length > 0) matchers.push(loaded);
  }

  if (matchers.length === 0) return NULL_ALIAS_RESOLVER;

  // Deepest scope first so the most specific tsconfig wins per importing file.
  matchers.sort((a, b) => b.scopeDir.length - a.scopeDir.length);

  return {
    resolve(importPath, fromFile) {
      for (const matcher of matchers) {
        if (matcher.scopeDir && !fromFile.startsWith(matcher.scopeDir + '/')) continue;
        const resolved = matchEntries(matcher.entries, importPath, tree);
        if (resolved) return resolved;
      }
      return null;
    },
  };
}

/**
 * Loads a tsconfig and its local `extends` chain, returning the effective
 * paths entries. Nearest declaration of `paths` wins wholesale (TS semantics —
 * no key merging); targets resolve relative to the DECLARING config's dir
 * (with its baseUrl applied).
 */
async function loadEffectivePaths(
  fetchText: FetchText,
  tree: RepoTree,
  configPath: string,
  countFetch: () => void,
): Promise<ScopedMatcher | null> {
  const scopeDir = configPath.includes('/') ? configPath.substring(0, configPath.lastIndexOf('/')) : '';
  let currentPath: string | null = configPath;
  const visited = new Set<string>();

  while (currentPath && !visited.has(currentPath)) {
    visited.add(currentPath);
    countFetch();
    const raw = await fetchText(currentPath);
    if (raw === null) return null;

    let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }; extends?: string };
    try {
      parsed = JSON.parse(stripJsonComments(raw));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      core.warning(`Failed to parse ${currentPath}: ${message}. Skipping this tsconfig`);
      return null;
    }

    const paths = parsed.compilerOptions?.paths;
    if (paths && typeof paths === 'object') {
      const declaringDir = currentPath.includes('/')
        ? currentPath.substring(0, currentPath.lastIndexOf('/'))
        : '';
      const baseUrl = parsed.compilerOptions?.baseUrl ?? '.';
      const baseDir = joinRepoPath(declaringDir, baseUrl);
      return { scopeDir, entries: buildEntries(paths, baseDir) };
    }

    // No paths here — follow extends. A specifier that doesn't resolve inside
    // the tree is an npm package (e.g. '@loopback/build/...') — stop silently.
    currentPath = resolveExtends(tree, currentPath, parsed.extends);
  }

  return null;
}

function resolveExtends(tree: RepoTree, fromConfig: string, extendsSpec?: string): string | null {
  if (!extendsSpec || !extendsSpec.startsWith('.')) {
    if (extendsSpec) core.debug(`tsconfig extends chain ends at package specifier: ${extendsSpec}`);
    return null;
  }
  const fromDir = fromConfig.includes('/') ? fromConfig.substring(0, fromConfig.lastIndexOf('/')) : '';
  const base = joinRepoPath(fromDir, extendsSpec);
  for (const candidate of [base, base + '.json', base + '/tsconfig.json']) {
    if (tree.has(candidate)) return candidate;
  }
  return null;
}

function buildEntries(paths: Record<string, string[]>, baseDir: string): PathsEntry[] {
  const entries: PathsEntry[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf('*');
    entries.push({
      pattern,
      hasWildcard: star !== -1,
      prefix: star === -1 ? pattern : pattern.substring(0, star),
      suffix: star === -1 ? '' : pattern.substring(star + 1),
      targets: targets.map((t) => joinRepoPath(baseDir, t)),
    });
  }
  // TS precedence: exact patterns first, then wildcards by longest literal prefix.
  entries.sort((a, b) => {
    if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
    return b.prefix.length - a.prefix.length;
  });
  return entries;
}

function matchEntries(entries: PathsEntry[], importPath: string, tree: RepoTree): string | null {
  for (const entry of entries) {
    if (!entry.hasWildcard) {
      if (importPath !== entry.pattern) continue;
      for (const target of entry.targets) {
        const resolved = resolveWithExtensions(tree, target.replace(/\*/g, ''));
        if (resolved) return resolved;
      }
      continue;
    }
    if (!importPath.startsWith(entry.prefix) || !importPath.endsWith(entry.suffix)) continue;
    const captured = importPath.substring(entry.prefix.length, importPath.length - entry.suffix.length);
    for (const target of entry.targets) {
      const substituted = target.includes('*') ? target.replace('*', captured) : target;
      const resolved = resolveWithExtensions(tree, substituted);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Joins a repo-relative dir with a possibly-relative segment, normalizing . and .. */
function joinRepoPath(dir: string, segment: string): string {
  const combined = (dir ? dir + '/' : '') + segment;
  const parts = combined.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

/**
 * Strips // and block comments plus trailing commas from JSONC text,
 * string-literal aware (comment markers inside strings are preserved).
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }

  // Trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}
