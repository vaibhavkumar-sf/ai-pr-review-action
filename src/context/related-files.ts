/**
 * Framework-aware related-file discovery + barrel resolution + ranking.
 * Pure functions over file content and the repo tree — no API calls here.
 *
 * These find the unchanged files a human reviewer would open that do NOT
 * appear as ES imports of the changed files: Angular sibling templates/styles
 * and declaring modules, LoopBack4 string-key DI bindings, and the real
 * definitions behind barrel (index.ts) re-exports.
 */

import { ChangedFile, DependencyReason, Framework } from '../types';
import { extractImports, resolveRelativeImport } from '../utils/imports';
import { BARREL_MAX_TARGETS, RELATED_KIND_WEIGHT } from '../config/limits';
import { RepoTree, resolveWithExtensions } from './repo-tree';

export interface RelatedCandidate {
  path: string;
  referencedBy: Set<string>;
  reason: DependencyReason;
}

/**
 * Collects framework-implied related files for the changed files:
 * - Angular: templateUrl/styleUrls siblings + the nearest declaring module.
 * - LoopBack4: @inject('<string key>') binding targets.
 */
export function collectFrameworkCandidates(
  changedFiles: ChangedFile[],
  tree: RepoTree,
  framework: Framework,
): RelatedCandidate[] {
  const candidates: RelatedCandidate[] = [];
  const changedPaths = new Set(changedFiles.map((f) => f.filename));

  const add = (path: string | null, referencedBy: string, reason: DependencyReason) => {
    if (!path || changedPaths.has(path) || !tree.has(path)) return;
    candidates.push({ path, referencedBy: new Set([referencedBy]), reason });
  };

  for (const file of changedFiles) {
    if (!file.content || file.status === 'removed') continue;
    const dir = file.filename.includes('/')
      ? file.filename.substring(0, file.filename.lastIndexOf('/'))
      : '';

    if (framework === 'angular' || framework === 'both') {
      // Sibling template/styles referenced in @Component metadata.
      const templateMatch = file.content.match(/templateUrl\s*:\s*['"]([^'"]+)['"]/);
      if (templateMatch) {
        add(resolveRelativeImport(file.filename, templateMatch[1]), file.filename, 'template');
      }
      const styleUrlMatches = file.content.matchAll(/styleUrls?\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/g);
      for (const styleMatch of styleUrlMatches) {
        for (const urlMatch of styleMatch[1].matchAll(/['"]([^'"]+)['"]/g)) {
          add(resolveRelativeImport(file.filename, urlMatch[1]), file.filename, 'stylesheet');
        }
      }
      // The NgModule that declares this component (skip routing modules).
      if (/\.component\.ts$/.test(file.filename)) {
        const moduleFile = tree.nearestUp(dir, /^(?!.*routing).*\.module\.ts$/);
        add(moduleFile, file.filename, 'declaring-module');
      }
    }

    if (framework === 'loopback4' || framework === 'both') {
      // String-key DI: @inject('datasources.pgdb'), @inject('services.FooService'), …
      for (const injectMatch of file.content.matchAll(/@inject(?:\.getter)?\s*\(\s*['"]([^'"]+)['"]/g)) {
        add(resolveInjectKey(injectMatch[1], tree, file.filename), file.filename, 'di-binding');
      }
    }
  }

  return candidates;
}

/**
 * Resolves a LoopBack4 string binding key to its likely definition file via
 * naming conventions:
 * - 'datasources.pgdb'          → **&#47;datasources/pgdb.datasource.ts
 * - 'services.UserHelperService' → **&#47;services/user-helper.service.ts
 * - 'repositories.TaskRepository' → **&#47;repositories/task.repository.ts
 * - 'adapters.FooAdapter'       → **&#47;adapters/foo.adapter.ts
 * When several packages define the same name (monorepo), the match sharing
 * the longest path prefix with the referencing file wins.
 */
export function resolveInjectKey(key: string, tree: RepoTree, fromFile = ''): string | null {
  const dot = key.indexOf('.');
  if (dot === -1) return null;
  const namespace = key.substring(0, dot);
  const name = key.substring(dot + 1);
  if (!name || name.includes('.')) return null;

  const lookups: Array<{ dirSuffix: string; fileName: string }> = [];
  if (namespace === 'datasources') {
    lookups.push({ dirSuffix: 'datasources', fileName: `${name}.datasource.ts` });
  } else if (namespace === 'services') {
    const base = pascalToKebab(name.replace(/Service$/, ''));
    lookups.push({ dirSuffix: 'services', fileName: `${base}.service.ts` });
  } else if (namespace === 'repositories') {
    const base = pascalToKebab(name.replace(/Repository$/, ''));
    lookups.push({ dirSuffix: 'repositories', fileName: `${base}.repository.ts` });
  } else if (namespace === 'adapters') {
    const base = pascalToKebab(name.replace(/Adapter$/, ''));
    lookups.push({ dirSuffix: 'adapters', fileName: `${base}.adapter.ts` });
    lookups.push({ dirSuffix: 'adapters', fileName: `${base}.adapter.service.ts` });
  } else {
    return null;
  }

  for (const { dirSuffix, fileName } of lookups) {
    const matches = tree.findByDirSuffixAndName(dirSuffix, fileName);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      return matches
        .map((m) => ({ m, shared: sharedPrefixLength(m, fromFile) }))
        .sort((a, b) => b.shared - a.shared || a.m.localeCompare(b.m))[0].m;
    }
  }
  return null;
}

/** Number of leading path segments two repo paths share. */
function sharedPrefixLength(a: string, b: string): number {
  const partsA = a.split('/');
  const partsB = b.split('/');
  let shared = 0;
  while (shared < partsA.length && shared < partsB.length && partsA[shared] === partsB[shared]) shared++;
  return shared;
}

/** UserResourceHelperService → user-resource-helper-service (per-word kebab). */
export function pascalToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Given a fetched barrel (index.ts) and the symbols imported through it,
 * returns the paths of the files that actually define those symbols:
 * - named re-exports (`export { Foo } from './foo.model'`) matched exactly;
 * - `export * from './x'` targets included when a kebab-cased symbol matches
 *   the target basename (bounded heuristic — no content fetch needed).
 * Cycle-safe by construction: only resolves one barrel's own statements;
 * callers cap chain depth with BARREL_FOLLOW_DEPTH and a visited set.
 */
export function resolveBarrelTargets(
  barrelPath: string,
  barrelContent: string,
  importedSymbols: string[],
  tree: RepoTree,
  maxTargets = BARREL_MAX_TARGETS,
): string[] {
  const targets = new Set<string>();
  const wanted = new Set(importedSymbols);

  for (const reexport of extractImports(barrelContent)) {
    if (!reexport.specifier.startsWith('.')) continue;
    const base = resolveRelativeImport(barrelPath, reexport.specifier);
    if (!base) continue;
    const resolved = resolveWithExtensions(tree, base);
    if (!resolved || resolved === barrelPath) continue;

    if (reexport.symbols.length > 0) {
      // Named re-export: include when it provides a wanted symbol (or when
      // the importer's symbols are unknown, e.g. namespace import).
      if (wanted.size === 0 || reexport.symbols.some((s) => wanted.has(s))) {
        targets.add(resolved);
      }
    } else {
      // `export * from './x'`: match when the target basename, stripped of
      // separators, starts with the symbol ('BoardCsvDto' ⇢ board-csv-dto.model.ts,
      // 'UserModel' ⇢ user.model.ts). Bounded heuristic — no content fetch.
      const baseName = resolved.substring(resolved.lastIndexOf('/') + 1).replace(/\.[tj]sx?$/, '');
      const normalizedBase = baseName.replace(/[^a-z0-9]/gi, '').toLowerCase();
      for (const symbol of wanted) {
        const normalizedSymbol = symbol.replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (normalizedBase.startsWith(normalizedSymbol) || normalizedSymbol.startsWith(normalizedBase)) {
          targets.add(resolved);
          break;
        }
      }
    }
    if (targets.size >= maxTargets) break;
  }

  return Array.from(targets).slice(0, maxTargets);
}

/** Kind classification for ranking weights. */
function kindOf(path: string): string {
  if (/\.(model|dto|interface|types?|enum)\.ts$/.test(path) || /\/(models|interfaces|types|enums)\//.test(path)) {
    return 'model';
  }
  if (/\.(service|repository|adapter|provider|facade)\.ts$/.test(path)) return 'service';
  if (/\.module\.ts$/.test(path)) return 'module';
  if (/\.html$/.test(path)) return 'template';
  if (/\.(scss|css|less)$/.test(path)) return 'stylesheet';
  return 'other';
}

/**
 * Ranks candidates: most-referenced first, then by kind weight (models/types
 * teach the reviewer the most per token), then smaller files, then path for
 * determinism.
 */
export function rankCandidates(candidates: RelatedCandidate[], tree: RepoTree): RelatedCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.referencedBy.size !== b.referencedBy.size) return b.referencedBy.size - a.referencedBy.size;
    const weightA = RELATED_KIND_WEIGHT[kindOf(a.path)] ?? RELATED_KIND_WEIGHT.other;
    const weightB = RELATED_KIND_WEIGHT[kindOf(b.path)] ?? RELATED_KIND_WEIGHT.other;
    if (weightA !== weightB) return weightB - weightA;
    const sizeA = tree.size(a.path) ?? Number.MAX_SAFE_INTEGER;
    const sizeB = tree.size(b.path) ?? Number.MAX_SAFE_INTEGER;
    if (sizeA !== sizeB) return sizeA - sizeB;
    return a.path.localeCompare(b.path);
  });
}
