import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ActionConfig, ChangedFile, Framework, RepoContext } from '../types';

export async function gatherRepoContext(
  config: ActionConfig,
  changedFiles?: ChangedFile[],
): Promise<RepoContext> {
  const octokit = new Octokit({ auth: config.githubToken });
  const { owner, repo } = config;

  let headSha: string;
  try {
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: config.prNumber,
    });
    headSha = pr.head.sha;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`Failed to fetch PR for head SHA: ${message}. Using default branch for repo context.`);
    headSha = '';
  }

  const [claudeMdContent, hasAngularJson, packageJsonDeps] = await Promise.all([
    fetchClaudeMd(octokit, owner, repo, headSha),
    checkFileExists(octokit, owner, repo, 'angular.json', headSha),
    fetchPackageJsonDeps(octokit, owner, repo, headSha),
  ]);

  // Primary detection: root package.json
  let hasAngularCore = packageJsonDeps.has('@angular/core');
  let hasLoopbackCore = packageJsonDeps.has('@loopback/core');

  // Monorepo detection: if root package.json has "workspaces", also scan
  // sub-package package.json files and changed file patterns
  if (!hasAngularCore && !hasLoopbackCore) {
    const monoResult = await detectFromMonorepo(
      octokit, owner, repo, headSha, changedFiles,
    );
    hasAngularCore = hasAngularCore || monoResult.angular;
    hasLoopbackCore = hasLoopbackCore || monoResult.loopback4;
  }

  // File-pattern-based detection from changed files (catches monorepos too)
  if (changedFiles && changedFiles.length > 0) {
    const patternResult = detectFromFilePatterns(changedFiles);
    hasAngularCore = hasAngularCore || patternResult.angular;
    hasLoopbackCore = hasLoopbackCore || patternResult.loopback4;
  }

  let detectedFramework: Framework = 'generic';
  if ((hasAngularJson || hasAngularCore) && hasLoopbackCore) {
    detectedFramework = 'both';
  } else if (hasAngularJson || hasAngularCore) {
    detectedFramework = 'angular';
  } else if (hasLoopbackCore) {
    detectedFramework = 'loopback4';
  }

  const repoContext: RepoContext = {
    claudeMdContent,
    detectedFramework,
    hasAngularJson,
    hasLoopbackDeps: hasLoopbackCore,
  };

  core.info(
    `Repo context: framework=${detectedFramework}, ` +
      `angularJson=${hasAngularJson}, loopbackDeps=${hasLoopbackCore}, ` +
      `CLAUDE.md=${claudeMdContent !== null ? 'found' : 'not found'}`,
  );

  return repoContext;
}

/**
 * Detect frameworks from changed file patterns. This is the fastest check
 * and works even in monorepos where the root package.json doesn't list
 * framework dependencies.
 */
function detectFromFilePatterns(
  changedFiles: ChangedFile[],
): { angular: boolean; loopback4: boolean } {
  let angular = false;
  let loopback4 = false;

  for (const file of changedFiles) {
    const name = file.filename;

    // Angular patterns
    if (
      name.endsWith('.component.ts') ||
      name.endsWith('.module.ts') ||
      name.endsWith('.directive.ts') ||
      name.endsWith('.pipe.ts') ||
      name.endsWith('.component.html') ||
      name.endsWith('.component.scss') ||
      name.includes('/angular.json')
    ) {
      angular = true;
    }

    // LoopBack4 patterns
    if (
      name.endsWith('.controller.ts') ||
      name.endsWith('.repository.ts') ||
      name.endsWith('.model.ts') ||
      name.endsWith('.datasource.ts') ||
      name.endsWith('.interceptor.ts') ||
      name.endsWith('.sequence.ts') ||
      name.includes('/application.ts')
    ) {
      loopback4 = true;
    }

    // Also check file content for imports (if content available)
    if (file.content) {
      if (file.content.includes('@angular/core') || file.content.includes('@angular/common')) {
        angular = true;
      }
      if (file.content.includes('@loopback/core') || file.content.includes('@loopback/rest')) {
        loopback4 = true;
      }
    }

    if (angular && loopback4) break;
  }

  return { angular, loopback4 };
}

/**
 * For monorepos (workspaces detected in root package.json), scan a few
 * sub-package package.json files to detect framework dependencies.
 */
async function detectFromMonorepo(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  changedFiles?: ChangedFile[],
): Promise<{ angular: boolean; loopback4: boolean }> {
  let angular = false;
  let loopback4 = false;

  // Find unique sub-directories from changed files (first path segment)
  const subDirs = new Set<string>();
  if (changedFiles) {
    for (const file of changedFiles) {
      const parts = file.filename.split('/');
      if (parts.length >= 3) {
        // e.g., services/auth-service/src/... → services/auth-service
        subDirs.add(`${parts[0]}/${parts[1]}`);
      }
    }
  }

  // Check up to 3 sub-package package.json files
  const dirsToCheck = Array.from(subDirs).slice(0, 3);
  const checks = dirsToCheck.map(async (dir) => {
    try {
      const params: Parameters<typeof octokit.repos.getContent>[0] = {
        owner, repo, path: `${dir}/package.json`,
      };
      if (ref) params.ref = ref;

      const { data } = await octokit.repos.getContent(params);
      if (!Array.isArray(data) && data.type === 'file' && data.content) {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        const pkg = JSON.parse(content);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };

        if ('@angular/core' in allDeps) angular = true;
        if ('@loopback/core' in allDeps) loopback4 = true;
      }
    } catch {
      // 404 or parse error — skip silently
    }
  });

  await Promise.all(checks);
  return { angular, loopback4 };
}

async function fetchClaudeMd(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  try {
    const params: Parameters<typeof octokit.repos.getContent>[0] = {
      owner, repo, path: 'CLAUDE.md',
    };
    if (ref) params.ref = ref;

    const { data } = await octokit.repos.getContent(params);
    if (!Array.isArray(data) && data.type === 'file' && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch (err) {
    if (isHttpError(err, 404)) {
      core.debug('CLAUDE.md not found in repository root');
      return null;
    }
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`Failed to fetch CLAUDE.md: ${message}`);
    return null;
  }
}

async function checkFileExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<boolean> {
  try {
    const params: Parameters<typeof octokit.repos.getContent>[0] = {
      owner, repo, path,
    };
    if (ref) params.ref = ref;
    await octokit.repos.getContent(params);
    return true;
  } catch (err) {
    if (isHttpError(err, 404)) return false;
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`Failed to check for ${path}: ${message}`);
    return false;
  }
}

async function fetchPackageJsonDeps(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<Set<string>> {
  const deps = new Set<string>();
  try {
    const params: Parameters<typeof octokit.repos.getContent>[0] = {
      owner, repo, path: 'package.json',
    };
    if (ref) params.ref = ref;

    const { data } = await octokit.repos.getContent(params);
    if (!Array.isArray(data) && data.type === 'file' && data.content) {
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const pkg = JSON.parse(content);
      for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
        if (section && typeof section === 'object') {
          for (const name of Object.keys(section)) deps.add(name);
        }
      }
    }
  } catch (err) {
    if (isHttpError(err, 404)) {
      core.debug('package.json not found in repository root');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      core.warning(`Failed to fetch/parse package.json: ${message}`);
    }
  }
  return deps;
}

function isHttpError(err: unknown, statusCode: number): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    return (err as { status: number }).status === statusCode;
  }
  return false;
}
