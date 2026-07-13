/**
 * TypeScript-compiler-backed import resolution over a local checkout — the
 * same engine tsserver/VS Code use, replacing regex import parsing and the
 * fuzzy barrel `export *` basename heuristic with exact answers.
 *
 * Constraints honored here:
 * - The reviewed repo has NO node_modules installed: external specifiers
 *   simply fail module resolution and are reported as unresolved (the caller
 *   applies the workspace-package fallback). Intra-repo resolution (relative
 *   paths, tsconfig `paths` aliases incl. `extends` chains, barrels) is fully
 *   semantic.
 * - Memory is bounded: files are added to projects on demand only, and barrel
 *   expansion stops once TS_PROJECT_MAX_LOADED_FILES source files have been
 *   materialized across all projects.
 * - Best-effort: every compiler interaction is wrapped; a throw degrades to
 *   "no result for that import", never a phase failure.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { ExportDeclaration, ImportDeclaration, Project, SourceFile } from 'ts-morph';
import { CALLER_SEED_SYMBOLS_MAX, TS_PROJECT_MAX_LOADED_FILES } from '../../config/limits';
import { LineRange } from './skeletons';

export interface ResolvedImport {
  /** Repo-relative path of the file that DEFINES the imported symbols. */
  path: string;
  /** Named symbols this import brings in (empty for namespace/side-effect). */
  symbols: string[];
  /** True when the import landed on a barrel and was followed to the definition. */
  viaBarrel: boolean;
}

export interface UnresolvedImport {
  specifier: string;
  symbols: string[];
}

export interface ImportResolution {
  resolved: ResolvedImport[];
  unresolved: UnresolvedImport[];
}

export interface TsEngine {
  /**
   * Exact resolution of a changed file's imports/re-exports.
   *
   * `changedRanges` (1-based new-side line ranges of the file's added diff
   * lines) gates RE-EXPORTS only: a re-export is followed solely when its
   * declaration intersects a changed range. A changed barrel forwards every
   * sibling module, but the PR only touches the export lines it added — the
   * untouched siblings are not context. Imports are always followed (the
   * file's code genuinely uses them), and omitting `changedRanges` follows
   * everything (fail open when diff info is unavailable).
   */
  resolveImports(changedFile: string, changedRanges?: LineRange[]): ImportResolution;
  /** Exported symbols of a file whose declarations intersect the given
   *  1-based line ranges (the diff hunks) — the seeds for caller search. */
  seedSymbols(changedFile: string, ranges: LineRange[]): string[];
  /** Source files currently materialized across all projects. */
  loadedFileCount(): number;
  dispose(): void;
}

export function buildTsEngine(repoDir: string): TsEngine {
  // One Project per governing tsconfig so `paths` aliases resolve exactly as
  // the repo's own build does (monorepos have per-package tsconfigs).
  const projects = new Map<string, Project>();
  let capWarned = false;
  let disposed = false;

  const loadedFileCount = (): number => {
    let total = 0;
    for (const project of projects.values()) total += project.getSourceFiles().length;
    return total;
  };

  const atCapacity = (): boolean => {
    if (loadedFileCount() < TS_PROJECT_MAX_LOADED_FILES) return false;
    if (!capWarned) {
      capWarned = true;
      core.warning(
        `Local TS analysis reached ${TS_PROJECT_MAX_LOADED_FILES} loaded files — `
        + 'remaining imports resolve without barrel expansion',
      );
    }
    return true;
  };

  const nearestTsConfig = (fromFile: string): string | null => {
    let dir = path.dirname(path.join(repoDir, fromFile));
    const root = path.resolve(repoDir);
    while (dir.startsWith(root)) {
      const candidate = path.join(dir, 'tsconfig.json');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  };

  const projectFor = (changedFile: string): Project => {
    const tsconfig = nearestTsConfig(changedFile);
    const key = tsconfig ?? '<none>';
    const existing = projects.get(key);
    if (existing) return existing;
    const project = tsconfig
      ? new Project({
          tsConfigFilePath: tsconfig,
          skipAddingFilesFromTsConfig: true,
          skipFileDependencyResolution: true,
        })
      : new Project({
          compilerOptions: { allowJs: true, rootDir: repoDir },
          skipAddingFilesFromTsConfig: true,
          skipFileDependencyResolution: true,
        });
    projects.set(key, project);
    return project;
  };

  const toRepoRelative = (sf: SourceFile): string | null => {
    const abs = sf.getFilePath();
    const rel = path.relative(repoDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('node_modules')) return null;
    return rel.split(path.sep).join('/');
  };

  /** Named symbols an import/re-export declaration brings in. */
  const symbolsOf = (decl: ImportDeclaration | ExportDeclaration): string[] => {
    const names: string[] = [];
    if (decl instanceof ImportDeclaration) {
      for (const named of decl.getNamedImports()) names.push(named.getName());
      if (decl.getDefaultImport()) names.push('default');
    } else {
      for (const named of decl.getNamedExports()) names.push(named.getName());
    }
    return names;
  };

  const resolveImports = (changedFile: string, changedRanges?: LineRange[]): ImportResolution => {
    const resolved: ResolvedImport[] = [];
    const unresolved: UnresolvedImport[] = [];
    if (disposed || !/\.[cm]?[tj]sx?$/.test(changedFile)) return { resolved, unresolved };

    let sourceFile: SourceFile;
    try {
      sourceFile = projectFor(changedFile).addSourceFileAtPath(path.join(repoDir, changedFile));
    } catch (err) {
      core.debug(`TS engine could not load ${changedFile}: ${err instanceof Error ? err.message : String(err)}`);
      return { resolved, unresolved };
    }

    const declarations = [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()];
    for (const decl of declarations) {
      try {
        if (decl instanceof ExportDeclaration && changedRanges) {
          const start = decl.getStartLineNumber();
          const end = decl.getEndLineNumber();
          if (!changedRanges.some((r) => r.start <= end && r.end >= start)) continue;
        }
        const specifier = decl.getModuleSpecifierValue();
        if (!specifier) continue; // `export { x }` without a source
        const symbols = symbolsOf(decl);

        const target = decl.getModuleSpecifierSourceFile();
        const targetRel = target ? toRepoRelative(target) : null;
        if (!target || !targetRel) {
          // External package, missing node_modules, or resolution miss —
          // non-relative ones get the workspace-package fallback upstream.
          if (!specifier.startsWith('.')) unresolved.push({ specifier, symbols });
          continue;
        }

        // Follow named imports to the files that actually DECLARE them: this
        // is the exact replacement for the barrel basename heuristic, and it
        // also traverses `export *` chains semantically.
        if (symbols.length > 0 && !atCapacity()) {
          const byDefiningFile = new Map<string, string[]>();
          const exported = target.getExportedDeclarations();
          for (const symbol of symbols) {
            const definers = exported.get(symbol);
            const definingFile = definers?.[0]?.getSourceFile();
            const definingRel = definingFile ? toRepoRelative(definingFile) : null;
            const home = definingRel ?? targetRel;
            const list = byDefiningFile.get(home);
            if (list) list.push(symbol);
            else byDefiningFile.set(home, [symbol]);
          }
          for (const [definingRel, definedSymbols] of byDefiningFile) {
            resolved.push({
              path: definingRel,
              symbols: definedSymbols,
              viaBarrel: definingRel !== targetRel,
            });
          }
        } else {
          // Namespace/side-effect import, or capacity reached: keep the
          // resolved module itself.
          resolved.push({ path: targetRel, symbols, viaBarrel: false });
        }
      } catch (err) {
        core.debug(
          `TS engine failed on an import in ${changedFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { resolved, unresolved };
  };

  const seedSymbols = (changedFile: string, ranges: LineRange[]): string[] => {
    if (disposed || ranges.length === 0 || !/\.[cm]?[tj]sx?$/.test(changedFile)) return [];
    try {
      const sourceFile = projectFor(changedFile).addSourceFileAtPath(path.join(repoDir, changedFile));
      const seeds: string[] = [];
      for (const [name, decls] of sourceFile.getExportedDeclarations()) {
        if (seeds.length >= CALLER_SEED_SYMBOLS_MAX) break;
        const local = decls.find((d) => d.getSourceFile() === sourceFile);
        if (!local) continue; // re-export — the change isn't in this file
        const start = local.getStartLineNumber();
        const end = local.getEndLineNumber();
        if (ranges.some((r) => r.start <= end && r.end >= start)) seeds.push(name);
      }
      return seeds;
    } catch (err) {
      core.debug(`TS engine seedSymbols failed for ${changedFile}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  };

  return {
    resolveImports,
    seedSymbols,
    loadedFileCount,
    dispose: () => {
      disposed = true;
      projects.clear();
    },
  };
}
