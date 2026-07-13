/**
 * Callers of changed code — the context class a human reviewer opens first
 * when a signature or behavior changes, and one no import graph provides
 * (imports point the wrong way).
 *
 * Pipeline: seed symbols = exports of changed files whose declarations
 * intersect the diff hunks → `git grep` prescreen for files mentioning any
 * seed → compiler confirmation (the candidate's imports must resolve to the
 * changed file, so same-named symbols from other modules never match) →
 * content as a skeleton with ONLY the calling bodies kept in full.
 */

import * as core from '@actions/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ChangedFile } from '../../types';
import { CALLERS_MAX_FILES, CALLER_SCAN_MAX_FILES, GIT_ACQUIRE_TIMEOUT_MS } from '../../config/limits';
import { isTestFile } from '../../config/patterns';
import { parseDiff } from '../../github/diff-parser';
import { GitRunner } from './git';
import { TsEngine } from './ts-project';
import { LineRange, toSkeleton } from './skeletons';

export interface CallerCandidate {
  path: string;
  /** Skeleton content with the calling function bodies preserved. */
  content: string;
  /** The changed files whose exported symbols this file calls. */
  referencedBy: string[];
}

export async function findCallers(
  repoDir: string,
  engine: TsEngine,
  changedFiles: ChangedFile[],
  diff: string,
  isExcluded: (p: string) => boolean,
  git: GitRunner,
): Promise<CallerCandidate[]> {
  // 1. Seed symbols from the diff hunks of each changed file.
  const hunkRanges = new Map<string, LineRange[]>();
  try {
    for (const parsed of parseDiff(diff)) {
      hunkRanges.set(
        parsed.filename,
        parsed.hunks.map((h) => ({ start: h.newStart, end: h.newStart + Math.max(h.newCount, 1) - 1 })),
      );
    }
  } catch {
    return [];
  }

  const changedPaths = new Set(changedFiles.map((f) => f.filename));
  const symbolToFiles = new Map<string, Set<string>>();
  for (const file of changedFiles) {
    if (!file.content || file.status === 'removed') continue;
    const ranges = hunkRanges.get(file.filename) ?? [];
    for (const symbol of engine.seedSymbols(file.filename, ranges)) {
      const files = symbolToFiles.get(symbol);
      if (files) files.add(file.filename);
      else symbolToFiles.set(symbol, new Set([file.filename]));
    }
  }
  if (symbolToFiles.size === 0) return [];

  // 2. git grep prescreen: which files mention any seed symbol at all.
  let candidates: string[];
  try {
    // --untracked: a fresh clone has none; matters only for fixture dirs.
    const grepArgs = ['grep', '-l', '--untracked', '--fixed-strings'];
    for (const symbol of symbolToFiles.keys()) grepArgs.push('-e', symbol);
    grepArgs.push('--', '*.ts', '*.tsx');
    const { stdout } = await git(grepArgs, { cwd: repoDir, timeoutMs: GIT_ACQUIRE_TIMEOUT_MS });
    candidates = stdout.split('\n').filter(Boolean);
  } catch {
    // git grep exits 1 on zero matches — either way, no callers.
    return [];
  }

  candidates = candidates
    .filter((p) => !changedPaths.has(p) && !isExcluded(p))
    .slice(0, CALLER_SCAN_MAX_FILES);

  // Confirm production callers before test callers. git grep returns paths in
  // tree order, where `__tests__/` sorts ahead of `controllers/`/`services/`;
  // without this, unit tests fill the whole CALLERS_MAX_FILES budget and the
  // real production callers — the reason the callers path exists — never get
  // confirmed. Stable within each group preserves tree order.
  const productionFirst = [
    ...candidates.filter((p) => !isTestFile(p)),
    ...candidates.filter((p) => isTestFile(p)),
  ];

  // 3. Compiler confirmation + skeleton extraction.
  const results: Array<CallerCandidate & { callSiteCount: number; isTest: boolean }> = [];
  for (const candidate of productionFirst) {
    if (results.length >= CALLERS_MAX_FILES) break;
    try {
      const { resolved } = engine.resolveImports(candidate);
      const matchedSymbols = new Set<string>();
      const referencedBy = new Set<string>();
      for (const imp of resolved) {
        if (!changedPaths.has(imp.path)) continue;
        for (const symbol of imp.symbols) {
          if (symbolToFiles.get(symbol)?.has(imp.path)) {
            matchedSymbols.add(symbol);
            referencedBy.add(imp.path);
          }
        }
      }
      if (matchedSymbols.size === 0) continue;

      const text = await fs.readFile(path.join(repoDir, candidate), 'utf-8');

      // Call sites = lines mentioning a matched symbol OR an instance bound
      // to it (`private boards: BoardService` → `this.boards.exportCsv(...)`),
      // so method-call bodies survive skeletonization, not just type mentions.
      const tokens = new Set<string>(matchedSymbols);
      for (const symbol of matchedSymbols) {
        const escaped = escapeRegExp(symbol);
        for (const m of text.matchAll(new RegExp(`(\\w+)\\s*[:=]\\s*(?:new\\s+)?${escaped}\\b`, 'g'))) {
          tokens.add(m[1]);
        }
      }
      const tokenPattern = new RegExp(`\\b(${[...tokens].map(escapeRegExp).join('|')})\\b`);
      const callSites: LineRange[] = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (tokenPattern.test(lines[i])) callSites.push({ start: i + 1, end: i + 1 });
      }
      results.push({
        path: candidate,
        content: toSkeleton(text, candidate, { keepBodiesOverlapping: callSites }),
        referencedBy: [...referencedBy],
        callSiteCount: callSites.length,
        isTest: isTestFile(candidate),
      });
    } catch (err) {
      core.debug(`Caller check failed for ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rank: production callers first, then by how many times they actually call
  // the changed code (a file with 5 call sites reviews harder than one that
  // merely mentions the type once). Drop the internal ranking fields.
  return results
    .sort((a, b) => {
      if (a.isTest !== b.isTest) return a.isTest ? 1 : -1;
      return b.callSiteCount - a.callSiteCount;
    })
    .map(({ path, content, referencedBy }) => ({ path, content, referencedBy }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
