/**
 * Primary related-context engine: runs over a local checkout of the PR head
 * with TypeScript-compiler-exact import resolution, plus the kept framework
 * heuristics (Angular siblings, LB4 DI bindings) and diff-hunk-seeded
 * ranking. Emits the same DependencyFile[] contract as the GitHub-API engine
 * (which remains the fallback), so agents/prompts/batching are untouched.
 */

import * as core from '@actions/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { ActionConfig, ChangedFile, DependencyFile, DependencyReason } from '../../types';
import { DEP_FILE_MAX_CHARS } from '../../config/limits';
import { parseDiff } from '../../github/diff-parser';
import { buildWorkspaceResolver, NULL_WORKSPACE_RESOLVER, WorkspaceResolver } from '../workspace-packages';
import { FetchText } from '../ts-paths';
import {
  collectFrameworkCandidates,
  frameworkForExpansion,
  rankCandidates,
  RelatedCandidate,
  selectRelatedCandidates,
} from '../related-files';
import { LocalRepo } from './local-repo';
import { buildLocalFileIndex } from './file-index';
import { buildTsEngine } from './ts-project';

export async function gatherRelatedFilesLocal(
  repo: LocalRepo,
  config: ActionConfig,
  changedFiles: ChangedFile[],
  diff: string,
): Promise<DependencyFile[]> {
  const index = await buildLocalFileIndex(repo.dir);
  core.info(`Local file index: ${index.paths.size} files (${repo.source})`);
  const engine = buildTsEngine(repo.dir);

  const readLocal: FetchText = async (relPath) => {
    try {
      return await fs.readFile(path.join(repo.dir, relPath), 'utf-8');
    } catch {
      return null;
    }
  };

  // Workspace-package fallback for the non-relative specifiers the compiler
  // cannot resolve without node_modules (reuses the tested heuristic, now
  // reading from disk instead of the contents API).
  let wsResolver: WorkspaceResolver = NULL_WORKSPACE_RESOLVER;
  try {
    wsResolver = await buildWorkspaceResolver(readLocal, index);
  } catch (err) {
    core.debug(`Workspace package resolution unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const changedPaths = new Set(changedFiles.map((f) => f.filename));
  const isExcluded = (p: string) =>
    config.excludePatterns.some((pattern) => minimatch(p, pattern, { dot: true }));

  const candidates = new Map<string, RelatedCandidate>();
  const addCandidate = (p: string, referencedBy: string, reason: DependencyReason) => {
    if (changedPaths.has(p) || isExcluded(p) || !index.has(p)) return;
    const existing = candidates.get(p);
    if (existing) {
      existing.referencedBy.add(referencedBy);
      if (reason === 'imported') existing.reason = 'imported'; // strongest signal wins
    } else {
      candidates.set(p, { path: p, referencedBy: new Set([referencedBy]), reason });
    }
  };

  // Added-line text per changed file: candidates whose imported symbols
  // actually appear in the changed hunks outrank ones only used in untouched
  // code (the diff-blindness fix).
  const hunkText = new Map<string, string>();
  try {
    for (const parsed of parseDiff(diff)) {
      const added = parsed.hunks
        .flatMap((h) => h.lines)
        .filter((l) => l.type === 'add')
        .map((l) => l.content)
        .join('\n');
      hunkText.set(parsed.filename, added);
    }
  } catch (err) {
    core.debug(`Hunk parsing for context ranking failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const hunkHits = new Map<string, number>();

  for (const file of changedFiles) {
    if (!file.content || file.status === 'removed') continue;
    const { resolved, unresolved } = engine.resolveImports(file.filename);

    for (const imp of resolved) {
      addCandidate(imp.path, file.filename, imp.viaBarrel ? 'barrel-reexport' : 'imported');
      const hunks = hunkText.get(file.filename);
      if (hunks && imp.symbols.length > 0) {
        const hits = imp.symbols.filter((s) => s !== 'default' && hunks.includes(s)).length;
        if (hits > 0) hunkHits.set(imp.path, Math.max(hunkHits.get(imp.path) ?? 0, hits));
      }
    }
    for (const miss of unresolved) {
      const resolvedWs = await wsResolver.resolve(miss.specifier);
      if (resolvedWs) addCandidate(resolvedWs, file.filename, 'imported');
    }
  }

  if (config.relatedContext === 'full') {
    try {
      const framework = frameworkForExpansion(config, changedFiles);
      for (const candidate of collectFrameworkCandidates(changedFiles, index, framework)) {
        for (const ref of candidate.referencedBy) addCandidate(candidate.path, ref, candidate.reason);
      }
    } catch (err) {
      core.warning(`Framework context expansion failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rank globally, then stable-boost candidates referenced from the changed
  // hunks themselves (stable sort preserves rank order within equal hits).
  const ranked = rankCandidates([...candidates.values()], index);
  ranked.sort((a, b) => (hunkHits.get(b.path) ?? 0) - (hunkHits.get(a.path) ?? 0));

  const selected = selectRelatedCandidates(
    ranked,
    index,
    changedFiles.map((f) => f.filename),
  );

  const truncate = (content: string) =>
    content.length > DEP_FILE_MAX_CHARS
      ? content.substring(0, DEP_FILE_MAX_CHARS) + '\n// ... truncated for context ...'
      : content;

  const results: DependencyFile[] = [];
  for (const candidate of selected) {
    const content = await readLocal(candidate.path);
    if (content === null) continue;
    results.push({
      filename: candidate.path,
      content: truncate(content),
      referencedBy: Array.from(candidate.referencedBy),
      reason: candidate.reason,
    });
  }

  engine.dispose();

  if (results.length > 0) {
    const reasonCounts = new Map<string, number>();
    for (const dep of results) {
      const reason = dep.reason ?? 'imported';
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
    const breakdown = [...reasonCounts.entries()].map(([reason, n]) => `${reason} ${n}`).join(', ');
    core.info(`Related context (local/compiler): ${results.length} file(s) (${breakdown})`);
    for (const dep of results) {
      core.info(`  + ${dep.filename} (${dep.reason ?? 'imported'})`);
    }
  }

  return results;
}
