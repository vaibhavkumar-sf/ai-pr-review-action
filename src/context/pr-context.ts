import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { minimatch } from 'minimatch';
import { ActionConfig, ChangedFile, DependencyFile } from '../types';

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
  const perPage = 100;

  while (true) {
    const { data: files } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: perPage,
      page,
    });

    allFiles.push(...files);

    if (files.length < perPage) {
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

  // 7. Fetch dependency files (imports referenced by changed files but not changed themselves)
  const dependencyFiles = await fetchDependencyFiles(
    octokit, owner, repo, headSha, changedFiles,
  );

  if (dependencyFiles.length > 0) {
    core.info(`Fetched ${dependencyFiles.length} dependency file(s) for additional context`);
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
 * Extracts import paths from changed files, resolves them, and fetches
 * any referenced files that aren't already in the changed file list.
 * This gives the AI reviewer context about interfaces, models, types,
 * and other dependencies that the changed code relies on.
 *
 * Limited to 10 dependency files to avoid excessive API calls.
 */
async function fetchDependencyFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  changedFiles: ChangedFile[],
): Promise<DependencyFile[]> {
  const changedPaths = new Set(changedFiles.map(f => f.filename));
  const depMap = new Map<string, Set<string>>(); // resolved path -> set of referencing files
  const MAX_DEPS = 10;

  for (const file of changedFiles) {
    if (!file.content || file.status === 'removed') continue;
    // Only process TypeScript/JavaScript files
    if (!/\.[tj]sx?$/.test(file.filename)) continue;

    const imports = extractImportPaths(file.content);
    for (const imp of imports) {
      const resolved = resolveImport(file.filename, imp);
      if (!resolved) continue;
      // Skip if the resolved path is already a changed file
      if (changedPaths.has(resolved)) continue;
      // Skip node_modules imports (non-relative)
      if (!imp.startsWith('.')) continue;

      if (!depMap.has(resolved)) {
        depMap.set(resolved, new Set());
      }
      depMap.get(resolved)!.add(file.filename);
    }
  }

  // Fetch up to MAX_DEPS dependency files
  const depsToFetch = Array.from(depMap.entries()).slice(0, MAX_DEPS);
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
          const truncated = content.length > 5000
            ? content.substring(0, 5000) + '\n// ... truncated for context ...'
            : content;
          results.push({
            filename: candidate,
            content: truncated,
            referencedBy: Array.from(referencedBy),
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

/**
 * Extracts import/require paths from TypeScript/JavaScript source code.
 */
function extractImportPaths(content: string): string[] {
  const paths: string[] = [];
  // ES imports: import ... from '...'
  const esRegex = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = esRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }
  // Dynamic imports: import('...')
  const dynRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }
  return paths.filter(p => p.startsWith('.'));
}

/**
 * Resolves a relative import path against the importing file's directory.
 */
function resolveImport(fromFile: string, importPath: string): string | null {
  const dir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  if (!dir && !importPath.startsWith('./')) return null;

  const base = dir ? dir + '/' + importPath : importPath;
  const parts = base.split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (resolved.length === 0) return null; // Can't go above root
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return resolved.join('/');
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
