import { buildWorkspaceResolver } from '../../src/context/workspace-packages';
import { RepoTree } from '../../src/context/repo-tree';
import { FetchText } from '../../src/context/ts-paths';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

function makeTree(paths: string[]): RepoTree {
  const set = new Set(paths);
  return {
    paths: set,
    has: (p) => set.has(p),
    size: () => undefined,
    listDir: () => [],
    findByDirSuffixAndName: () => [],
    nearestUp: () => null,
  };
}

const TREE = makeTree([
  'package.json',
  'packages/rakuten-core/package.json',
  'packages/rakuten-core/src/index.ts',
  'packages/rakuten-core/src/mixins/tenant.mixin.ts',
  'services/auth-service/package.json',
  'services/auth-service/src/index.ts',
]);

const FILES: Record<string, string> = {
  'package.json': '{"workspaces": ["packages/*", "services/*"]}',
  'packages/rakuten-core/package.json': '{"name": "@local/rakuten-core"}',
  'services/auth-service/package.json': '{"name": "@services/auth"}',
};

function trackingFetch(files: Record<string, string>): { fetch: FetchText; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (path) => {
      calls.push(path);
      return files[path] ?? null;
    },
  };
}

describe('buildWorkspaceResolver', () => {
  it('resolves scoped workspace imports via basename heuristic + name confirmation', async () => {
    const { fetch } = trackingFetch(FILES);
    const resolver = await buildWorkspaceResolver(fetch, TREE);
    expect(await resolver.resolve('@local/rakuten-core/mixins/tenant.mixin'))
      .toBe('packages/rakuten-core/src/mixins/tenant.mixin.ts');
  });

  it('maps bare package imports to the source entry point', async () => {
    const { fetch } = trackingFetch(FILES);
    const resolver = await buildWorkspaceResolver(fetch, TREE);
    expect(await resolver.resolve('@local/rakuten-core')).toBe('packages/rakuten-core/src/index.ts');
  });

  it('caches package-name lookups (one package.json fetch per package)', async () => {
    const { fetch, calls } = trackingFetch(FILES);
    const resolver = await buildWorkspaceResolver(fetch, TREE);
    await resolver.resolve('@local/rakuten-core/a');
    await resolver.resolve('@local/rakuten-core/b');
    expect(calls.filter((c) => c === 'packages/rakuten-core/package.json')).toHaveLength(1);
  });

  it('falls back to scanning when the basename heuristic misses', async () => {
    // Import name doesn't match any dir basename; scan finds it by name field.
    const files = {
      'package.json': '{"workspaces": ["packages/*"]}',
      'packages/core-lib/package.json': '{"name": "@local/rakuten-core"}',
    };
    const tree = makeTree(['package.json', 'packages/core-lib/package.json', 'packages/core-lib/src/index.ts']);
    const resolver = await buildWorkspaceResolver(trackingFetch(files).fetch, tree);
    expect(await resolver.resolve('@local/rakuten-core')).toBe('packages/core-lib/src/index.ts');
  });

  it('returns null for external packages and when no workspaces are declared', async () => {
    const { fetch } = trackingFetch(FILES);
    const resolver = await buildWorkspaceResolver(fetch, TREE);
    expect(await resolver.resolve('@loopback/core')).toBeNull();
    expect(await resolver.resolve('moment')).toBeNull();

    const noWs = await buildWorkspaceResolver(async () => '{"name": "single-pkg"}', TREE);
    expect(await noWs.resolve('@local/rakuten-core')).toBeNull();
  });
});
