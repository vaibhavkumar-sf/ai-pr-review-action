import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { minimatch } from 'minimatch';
import { ActionConfig, ChangedFile, DependencyFile, DependencyReason, Framework } from '../types';
import { extractImports, extractRelativeImports, resolveRelativeImport } from '../utils/imports';
import {
  DEP_FILE_MAX_CHARS,
  GITHUB_PER_PAGE,
  MAX_DEP_FILES,
  RELATED_FILES_MAX,
  RELATED_FILE_MAX_BYTES,
  RELATED_TOTAL_MAX_CHARS,
} from '../config/limits';
import { fetchRepoTree, resolveWithExtensions } from './repo-tree';
import { buildAliasResolver, FetchText, NULL_ALIAS_RESOLVER, AliasResolver } from './ts-paths';
import { buildWorkspaceResolver, NULL_WORKSPACE_RESOLVER, WorkspaceResolver } from './workspace-packages';
import {
  collectFrameworkCandidates,
  rankCandidates,
  resolveBarrelTargets,
  RelatedCandidate,
} from './related-files';
import { detectFromFilePatterns } from './repo-context';

export async function gatherPRContext(config: ActionConfig): Promise<{
  prTitle: string;
  prBody: string;
  prAuthor: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  diff: string;
  changedFiles: ChangedFile[];
  dependencyFiles: DependencyFile[];
}> {
  const octokit = new Octokit({ auth: config.githubToken });
  const { owner, repo, prNumber } = config;

  // 1. Fetch PR metadata
  core.info(`Fetching PR #${prNumber} metadata from ${owner}/${repo}`);
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const prTitle = pr.title;
  const prBody = pr.body ?? '';
  const prAuthor = pr.user?.login ?? 'unknown';
  const baseBranch = pr.base.ref;
  const headBranch = pr.head.ref;
  const headSha = pr.head.sha;

  // 2. Fetch PR diff
  core.info('Fetching PR diff');
  const { data: diffData } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });
  // When format is 'diff', the response data is a string despite the type signature
  const diff = diffData as unknown as string;

  // 3. Fetch changed files with pagination
  core.info('Fetching changed files list');
  const allFiles: Awaited<ReturnType<typeof octokit.pulls.listFiles>>['data'] = [];
  let page = 1;

  while (true) {
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: GITHUB_PER_PAGE,
      page,
    });

    allFiles.push(...files);

    if (files.length < GITHUB_PER_PAGE) {
      break;
    }
    page++;
  }

  core.info(`Found ${allFiles.length} changed file(s) in PR`);

  // 4. Filter files based on include/exclude patterns
  let filteredFiles = allFiles.filter((file) => {
    const filename = file.filename;

    // If include patterns are specified, file must match at least one
    if (config.includePatterns.length > 0) {
      const included = config.includePatterns.some((pattern) =>
        minimatch(filename, pattern, { dot: true }),
      );
      if (!included) {
        core.debug(`Excluding ${filename}: does not match any include pattern`);
        return false;
      }
    }

    // File must not match any exclude pattern
    const excluded = config.excludePatterns.some((pattern) =>
      minimatch(filename, pattern, { dot: true }),
    );
    if (excluded) {
      core.debug(`Excluding ${filename}: matches exclude pattern`);
      return false;
    }

    return true;
  });

  core.info(`${filteredFiles.length} file(s) remain after filtering`);

  // 5. Respect maxFilesToReview
  if (filteredFiles.length > config.maxFilesToReview) {
    core.warning(
      `PR has ${filteredFiles.length} files to review, which exceeds the limit of ${config.maxFilesToReview}. ` +
        `Only the first ${config.maxFilesToReview} files will be reviewed.`,
    );
    filteredFiles = filteredFiles.slice(0, config.maxFilesToReview);
  }

  // 6. Build ChangedFile[] with content fetching
  const changedFiles: ChangedFile[] = [];

  for (const file of filteredFiles) {
    const status = mapFileStatus(file.status);

    const changedFile: ChangedFile = {
      filename: file.filename,
      status,
      patch: file.patch,
      additions: file.additions,
      deletions: file.deletions,
    };

    // Fetch file content for non-removed files
    if (status !== 'removed') {
      try {
        const { data: contentData } = await octokit.repos.getContent({
          owner,
          repo,
          path: file.filename,
          ref: headSha,
        });

        // getContent returns a single file object when path is a file
        if (!Array.isArray(contentData) && contentData.type === 'file' && contentData.content) {
          changedFile.content = Buffer.from(contentData.content, 'base64').toString('utf-8');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        core.warning(`Failed to fetch content for ${file.filename}: ${message}. Skipping content.`);
      }
    }

    changedFiles.push(changedFile);
  }

  core.info(`Successfully gathered context for ${changedFiles.length} changed file(s)`);

  // 7. Fetch related files (imports, framework siblings, DI bindings —
  //    referenced by changed files but not changed themselves)
  let dependencyFiles: DependencyFile[] = [];
  try {
    dependencyFiles = await gatherRelatedFiles(octokit, config, headSha, changedFiles);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`Related-context gathering failed: ${message}. Continuing with diff-only context`);
  }

  return {
    prTitle,
    prBody,
    prAuthor,
    baseBranch,
    headBranch,
    headSha,
    diff,
    changedFiles,
    dependencyFiles,
  };
}

/**
 * Gathers the unchanged files a reviewer needs as context for the changed
 * ones: resolved imports (relative, tsconfig-path aliases, npm-workspace
 * packages), framework-implied siblings (Angular templates/styles/modules,
 * LoopBack4 string-key DI bindings), and the definitions behind barrel
 * re-exports — ranked and budgeted.
 *
 * Backbone: one recursive Git Trees call turns all resolution into in-memory
 * lookups. When the tree is unavailable (truncated/huge repo), falls back to
 * the legacy relative-import extension probing.
 */
async function gatherRelatedFiles(
  octokit: Octokit,
  config: ActionConfig,
  headSha: string,
  changedFiles: ChangedFile[],
): Promise<DependencyFile[]> {
  if (config.relatedContext === 'off') return [];

  const { owner, repo } = config;
  const tree = await fetchRepoTree(octokit, owner, repo, headSha);
  if (!tree) {
    return fetchByProbing(octokit, owner, repo, headSha, changedFiles);
  }

  // Shared content fetcher with an in-run cache: tsconfigs, package.jsons,
  // barrels, and selected files are each fetched at most once.
  const textCache = new Map<string, string | null>();
  const fetchText: FetchText = async (path) => {
    const cached = textCache.get(path);
    if (cached !== undefined) return cached;
    let content: string | null = null;
    try {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ref: headSha });
      if (!Array.isArray(data) && data.type === 'file' && data.content) {
        content = Buffer.from(data.content, 'base64').toString('utf-8');
      }
    } catch {
      // 404 or transient error — treat as missing
    }
    textCache.set(path, content);
    return content;
  };

  const changedPaths = new Set(changedFiles.map((f) => f.filename));
  const isExcluded = (path: string) =>
    config.excludePatterns.some((pattern) => minimatch(path, pattern, { dot: true }));

  // Resolvers are best-effort: failures degrade to relative-only resolution.
  let aliasResolver: AliasResolver = NULL_ALIAS_RESOLVER;
  let wsResolver: WorkspaceResolver = NULL_WORKSPACE_RESOLVER;
  try {
    aliasResolver = await buildAliasResolver(fetchText, tree, [...changedPaths]);
  } catch (err) {
    core.warning(`tsconfig alias resolution unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    wsResolver = await buildWorkspaceResolver(fetchText, tree);
  } catch (err) {
    core.warning(`Workspace package resolution unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Collect candidates ──
  const candidates = new Map<string, RelatedCandidate>();

  const addCandidate = (path: string, referencedBy: Iterable<string>, reason: DependencyReason) => {
    if (changedPaths.has(path) || isExcluded(path)) return;
    const existing = candidates.get(path);
    if (existing) {
      for (const ref of referencedBy) existing.referencedBy.add(ref);
      if (reason === 'imported') existing.reason = 'imported'; // strongest signal wins
    } else {
      candidates.set(path, { path, referencedBy: new Set(referencedBy), reason });
    }
  };

  // 1. Resolved imports of every changed source file. Imports that land on a
  //    barrel (index.ts) are expanded to the files defining the imported
  //    symbols BEFORE ranking, so real definitions compete for budget slots
  //    instead of one-line re-export lists.
  for (const file of changedFiles) {
    if (!file.content || file.status === 'removed') continue;
    if (!/\.[tj]sx?$/.test(file.filename)) continue;

    for (const imp of extractImports(file.content)) {
      let resolved: string | null;
      if (imp.specifier.startsWith('.')) {
        const base = resolveRelativeImport(file.filename, imp.specifier);
        resolved = base ? resolveWithExtensions(tree, base) : null;
      } else {
        resolved =
          aliasResolver.resolve(imp.specifier, file.filename) ??
          (await wsResolver.resolve(imp.specifier));
      }
      if (!resolved || changedPaths.has(resolved)) continue;

      if (/(^|\/)index\.[tj]s$/.test(resolved) && imp.symbols.length > 0) {
        const barrelContent = await fetchText(resolved);
        const targets = barrelContent
          ? resolveBarrelTargets(resolved, barrelContent, imp.symbols, tree).filter(
              (t) => !changedPaths.has(t),
            )
          : [];
        if (targets.length > 0) {
          for (const target of targets) addCandidate(target, [file.filename], 'barrel-reexport');
          continue; // definitions replace the barrel itself
        }
      }

      addCandidate(resolved, [file.filename], 'imported');
    }
  }

  // 2. Framework-implied files (templates, modules, DI bindings).
  if (config.relatedContext === 'full') {
    try {
      const framework = frameworkForExpansion(config, changedFiles);
      for (const candidate of collectFrameworkCandidates(changedFiles, tree, framework)) {
        addCandidate(candidate.path, candidate.referencedBy, candidate.reason);
      }
    } catch (err) {
      core.warning(`Framework context expansion failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Rank and budget ──
  const sizeOf = (path: string) => tree.size(path) ?? DEP_FILE_MAX_CHARS;
  const eligible = [...candidates.values()].filter((c) => sizeOf(c.path) <= RELATED_FILE_MAX_BYTES);
  const ranked = rankCandidates(eligible, tree);

  // FAIR selection: round-robin across the referencing changed files so one
  // high-fan-out file (a controller importing 20+ services) cannot crowd out
  // another changed file's only — and therefore most review-critical —
  // dependencies. Each round, every changed file places its next-best
  // unselected candidate until the count/char budgets are exhausted.
  const byReferencer = new Map<string, RelatedCandidate[]>();
  for (const candidate of ranked) {
    for (const ref of candidate.referencedBy) {
      const queue = byReferencer.get(ref);
      if (queue) queue.push(candidate);
      else byReferencer.set(ref, [candidate]);
    }
  }
  const referencerOrder = changedFiles.map((f) => f.filename).filter((f) => byReferencer.has(f));

  const selectedPaths = new Set<string>();
  const selected: RelatedCandidate[] = [];
  const cursors = new Map<string, number>();
  let totalChars = 0;
  let progress = true;
  while (progress && selected.length < RELATED_FILES_MAX) {
    progress = false;
    for (const ref of referencerOrder) {
      if (selected.length >= RELATED_FILES_MAX) break;
      const queue = byReferencer.get(ref) ?? [];
      let idx = cursors.get(ref) ?? 0;
      while (idx < queue.length) {
        const candidate = queue[idx++];
        if (selectedPaths.has(candidate.path)) continue;
        const estimate = Math.min(sizeOf(candidate.path), DEP_FILE_MAX_CHARS);
        if (totalChars + estimate > RELATED_TOTAL_MAX_CHARS) continue;
        selectedPaths.add(candidate.path);
        selected.push(candidate);
        totalChars += estimate;
        progress = true;
        break;
      }
      cursors.set(ref, idx);
    }
  }
  // Prompt (and trim-stage slicing) still sees global rank order.
  const rankIndex = new Map(ranked.map((c, i) => [c.path, i]));
  selected.sort((a, b) => (rankIndex.get(a.path) ?? 0) - (rankIndex.get(b.path) ?? 0));

  // ── Fetch contents (rank order preserved) ──
  const truncate = (content: string) =>
    content.length > DEP_FILE_MAX_CHARS
      ? content.substring(0, DEP_FILE_MAX_CHARS) + '\n// ... truncated for context ...'
      : content;

  const fetched = await Promise.all(
    selected.map(async (candidate): Promise<DependencyFile | null> => {
      const content = await fetchText(candidate.path);
      if (content === null) return null;
      return {
        filename: candidate.path,
        content: truncate(content),
        referencedBy: Array.from(candidate.referencedBy),
        reason: candidate.reason,
      };
    }),
  );
  const results: DependencyFile[] = fetched.filter((f): f is DependencyFile => f !== null);

  if (results.length > 0) {
    const reasonCounts = new Map<string, number>();
    for (const dep of results) {
      const reason = dep.reason ?? 'imported';
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
    const breakdown = [...reasonCounts.entries()].map(([reason, n]) => `${reason} ${n}`).join(', ');
    core.info(`Related context: ${results.length} file(s) (${breakdown})`);
    for (const dep of results) {
      core.info(`  + ${dep.filename} (${dep.reason ?? 'imported'})`);
    }
  }

  return results;
}

/** Framework used for related-context expansion. Config override wins; auto
 *  falls back to changed-file patterns (authoritative detection runs later). */
function frameworkForExpansion(config: ActionConfig, changedFiles: ChangedFile[]): Framework {
  if (config.framework !== 'auto') return config.framework;
  const detected = detectFromFilePatterns(changedFiles);
  if (detected.angular && detected.loopback4) return 'both';
  if (detected.angular) return 'angular';
  if (detected.loopback4) return 'loopback4';
  return 'generic';
}

/**
 * Legacy dependency fetch — relative imports only, resolved by probing
 * extension candidates against the contents API. Used when the repo tree
 * is unavailable (truncated listing or API failure).
 */
async function fetchByProbing(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  changedFiles: ChangedFile[],
): Promise<DependencyFile[]> {
  const changedPaths = new Set(changedFiles.map(f => f.filename));
  const depMap = new Map<string, Set<string>>(); // resolved path -> set of referencing files

  for (const file of changedFiles) {
    if (!file.content || file.status === 'removed') continue;
    // Only process TypeScript/JavaScript files
    if (!/\.[tj]sx?$/.test(file.filename)) continue;

    const imports = extractRelativeImports(file.content);
    for (const imp of imports) {
      const resolved = resolveRelativeImport(file.filename, imp);
      if (!resolved) continue;
      // Skip if the resolved path is already a changed file
      if (changedPaths.has(resolved)) continue;

      if (!depMap.has(resolved)) {
        depMap.set(resolved, new Set());
      }
      depMap.get(resolved)!.add(file.filename);
    }
  }

  // Fetch up to MAX_DEP_FILES dependency files
  const depsToFetch = Array.from(depMap.entries()).slice(0, MAX_DEP_FILES);
  const results: DependencyFile[] = [];

  const fetchPromises = depsToFetch.map(async ([depPath, referencedBy]) => {
    // Try with common extensions
    const candidates = [depPath];
    if (!depPath.match(/\.[tj]sx?$/)) {
      candidates.push(depPath + '.ts', depPath + '.js', depPath + '/index.ts', depPath + '/index.js');
    }

    for (const candidate of candidates) {
      try {
        const { data } = await octokit.repos.getContent({
          owner, repo, path: candidate, ref: headSha,
        });
        if (!Array.isArray(data) && data.type === 'file' && data.content) {
          const content = Buffer.from(data.content, 'base64').toString('utf-8');
          // Limit dependency file size to avoid token bloat
          const truncated = content.length > DEP_FILE_MAX_CHARS
            ? content.substring(0, DEP_FILE_MAX_CHARS) + '\n// ... truncated for context ...'
            : content;
          results.push({
            filename: candidate,
            content: truncated,
            referencedBy: Array.from(referencedBy),
            reason: 'imported',
          });
          return; // Found it, stop trying other extensions
        }
      } catch {
        // 404 or other error — try next candidate
      }
    }
  });

  await Promise.all(fetchPromises);
  return results;
}

function mapFileStatus(status: string): ChangedFile['status'] {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'removed';
    case 'renamed':
      return 'renamed';
    case 'modified':
    case 'changed':
    default:
      return 'modified';
  }
}
