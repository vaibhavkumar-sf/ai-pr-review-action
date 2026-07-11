import { fetchRepoTree, resolveWithExtensions, RepoTree } from '../../src/context/repo-tree';
import { Octokit } from '@octokit/rest';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

function mockOctokit(response: unknown, fails = false): Octokit {
  return {
    git: {
      getTree: fails
        ? jest.fn().mockRejectedValue(new Error('boom'))
        : jest.fn().mockResolvedValue(response),
    },
  } as unknown as Octokit;
}

function treeResponse(files: Array<{ path: string; size?: number }>, truncated = false) {
  return {
    data: {
      truncated,
      tree: files.map((f) => ({ type: 'blob', path: f.path, size: f.size })),
    },
  };
}

const FILES = [
  { path: 'src/app/core/api/api.service.ts', size: 900 },
  { path: 'src/app/home/home.component.ts', size: 400 },
  { path: 'src/app/home/home.component.html', size: 300 },
  { path: 'src/app/home/home.module.ts', size: 200 },
  { path: 'src/app/app.module.ts', size: 100 },
  { path: 'services/x/src/datasources/pgdb.datasource.ts', size: 150 },
  { path: 'src/models/index.ts', size: 50 },
  { path: 'tsconfig.json', size: 80 },
];

describe('fetchRepoTree', () => {
  it('indexes blob paths, sizes, and directories', async () => {
    const tree = (await fetchRepoTree(mockOctokit(treeResponse(FILES)), 'o', 'r', 'sha')) as RepoTree;
    expect(tree).not.toBeNull();
    expect(tree.has('src/app/home/home.component.html')).toBe(true);
    expect(tree.has('src/app/nope.ts')).toBe(false);
    expect(tree.size('src/app/core/api/api.service.ts')).toBe(900);
    expect(tree.listDir('src/app/home')).toEqual([
      'src/app/home/home.component.ts',
      'src/app/home/home.component.html',
      'src/app/home/home.module.ts',
    ]);
    expect(tree.listDir('')).toEqual(['tsconfig.json']);
  });

  it('returns null on truncated trees and on API errors', async () => {
    expect(await fetchRepoTree(mockOctokit(treeResponse(FILES, true)), 'o', 'r', 'sha')).toBeNull();
    expect(await fetchRepoTree(mockOctokit(null, true), 'o', 'r', 'sha')).toBeNull();
  });

  it('findByDirSuffixAndName matches directory suffixes', async () => {
    const tree = (await fetchRepoTree(mockOctokit(treeResponse(FILES)), 'o', 'r', 'sha')) as RepoTree;
    expect(tree.findByDirSuffixAndName('datasources', 'pgdb.datasource.ts')).toEqual([
      'services/x/src/datasources/pgdb.datasource.ts',
    ]);
    expect(tree.findByDirSuffixAndName('datasources', 'missing.ts')).toEqual([]);
  });

  it('nearestUp finds the closest ancestor match', async () => {
    const tree = (await fetchRepoTree(mockOctokit(treeResponse(FILES)), 'o', 'r', 'sha')) as RepoTree;
    expect(tree.nearestUp('src/app/home', /\.module\.ts$/)).toBe('src/app/home/home.module.ts');
    expect(tree.nearestUp('src/app/core/api', /\.module\.ts$/)).toBe('src/app/app.module.ts');
    expect(tree.nearestUp('src/app/home', /\.nonexistent$/)).toBeNull();
  });
});

describe('resolveWithExtensions', () => {
  let tree: RepoTree;
  beforeAll(async () => {
    tree = (await fetchRepoTree(mockOctokit(treeResponse(FILES)), 'o', 'r', 'sha')) as RepoTree;
  });

  it('resolves extensionless paths through the candidate order', () => {
    expect(resolveWithExtensions(tree, 'src/app/core/api/api.service')).toBe('src/app/core/api/api.service.ts');
    expect(resolveWithExtensions(tree, 'src/models')).toBe('src/models/index.ts');
  });

  it('returns exact path when the extension is already present', () => {
    expect(resolveWithExtensions(tree, 'src/app/home/home.component.ts')).toBe('src/app/home/home.component.ts');
  });

  it('returns null for unresolvable paths', () => {
    expect(resolveWithExtensions(tree, 'src/does/not/exist')).toBeNull();
  });
});
