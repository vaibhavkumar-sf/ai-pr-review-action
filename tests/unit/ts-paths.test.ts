import { buildAliasResolver, stripJsonComments, FetchText } from '../../src/context/ts-paths';
import { RepoTree } from '../../src/context/repo-tree';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

/** Minimal tree over a path list (sizes/dirs only as needed by ts-paths). */
function makeTree(paths: string[]): RepoTree {
  const set = new Set(paths);
  return {
    paths: set,
    has: (p) => set.has(p),
    size: () => undefined,
    listDir: (dir) =>
      paths.filter((p) => {
        const slash = p.lastIndexOf('/');
        return (slash === -1 ? '' : p.substring(0, slash)) === dir;
      }),
    findByDirSuffixAndName: () => [],
    nearestUp(fromDir, pattern) {
      let dir = fromDir;
      while (true) {
        for (const p of set) {
          const slash = p.lastIndexOf('/');
          const pDir = slash === -1 ? '' : p.substring(0, slash);
          const base = p.substring(slash + 1);
          if (pDir === dir && pattern.test(base)) return p;
        }
        if (dir === '') return null;
        const slash = dir.lastIndexOf('/');
        dir = slash === -1 ? '' : dir.substring(0, slash);
      }
    },
  };
}

function makeFetch(files: Record<string, string>): FetchText {
  return async (path) => files[path] ?? null;
}

describe('stripJsonComments', () => {
  it('strips line and block comments but preserves comment markers inside strings', () => {
    const src = `{
      // line comment
      "url": "https://example.com/path", /* block */
      "glob": "src/**/*.ts",
    }`;
    const parsed = JSON.parse(stripJsonComments(src));
    expect(parsed.url).toBe('https://example.com/path');
    expect(parsed.glob).toBe('src/**/*.ts');
  });

  it('removes trailing commas in objects and arrays', () => {
    expect(JSON.parse(stripJsonComments('{"a": [1, 2,], }'))).toEqual({ a: [1, 2] });
  });
});

describe('buildAliasResolver', () => {
  const angularTree = makeTree([
    'tsconfig.json',
    'tsconfig.base.json',
    'tsconfig.app.json',
    'src/app/core/api/api.service.ts',
    'src/app/shared/services/asset.service.ts',
    'src/app/feature/feature.component.ts',
  ]);

  it('resolves wildcard aliases with * capture (Angular-style)', async () => {
    const resolver = await buildAliasResolver(
      makeFetch({
        'tsconfig.json': '{"compilerOptions": {"paths": {"@rao/core/*": ["src/app/core/*"], "@rao/shared/*": ["src/app/shared/*"]}}}',
      }),
      angularTree,
      ['src/app/feature/feature.component.ts'],
    );
    expect(resolver.resolve('@rao/core/api/api.service', 'src/app/feature/feature.component.ts'))
      .toBe('src/app/core/api/api.service.ts');
    expect(resolver.resolve('@rao/shared/services/asset.service', 'src/app/feature/feature.component.ts'))
      .toBe('src/app/shared/services/asset.service.ts');
    expect(resolver.resolve('@angular/core', 'src/app/feature/feature.component.ts')).toBeNull();
  });

  it('falls through to the next matcher when targets do not resolve in the tree (app overrides base)', async () => {
    const resolver = await buildAliasResolver(
      makeFetch({
        // base maps to app/* (not in tree) — app maps to src/app/* (in tree)
        'tsconfig.json': '{"extends": "./tsconfig.base.json"}',
        'tsconfig.base.json': '{"compilerOptions": {"paths": {"@rao/core/*": ["app/core/*"]}}}',
        'tsconfig.app.json': '{"compilerOptions": {"paths": {"@rao/core/*": ["src/app/core/*"]}}}',
      }),
      angularTree,
      ['src/app/feature/feature.component.ts'],
    );
    expect(resolver.resolve('@rao/core/api/api.service', 'src/app/feature/feature.component.ts'))
      .toBe('src/app/core/api/api.service.ts');
  });

  it('prefers exact patterns over wildcards', async () => {
    const tree = makeTree(['tsconfig.json', 'src/special/index.ts', 'src/generic/thing.ts']);
    const resolver = await buildAliasResolver(
      makeFetch({
        'tsconfig.json':
          '{"compilerOptions": {"paths": {"@lib/thing": ["src/special/index.ts"], "@lib/*": ["src/generic/*"]}}}',
      }),
      tree,
      ['src/generic/thing.ts'],
    );
    expect(resolver.resolve('@lib/thing', 'src/generic/thing.ts')).toBe('src/special/index.ts');
  });

  it('resolves targets relative to the declaring tsconfig dir with baseUrl', async () => {
    const tree = makeTree(['services/a/tsconfig.json', 'services/a/src/models/user.model.ts', 'services/a/src/x.ts']);
    const resolver = await buildAliasResolver(
      makeFetch({
        'services/a/tsconfig.json':
          '{"compilerOptions": {"baseUrl": "./src", "paths": {"~models/*": ["models/*"]}}}',
      }),
      tree,
      ['services/a/src/x.ts'],
    );
    expect(resolver.resolve('~models/user.model', 'services/a/src/x.ts'))
      .toBe('services/a/src/models/user.model.ts');
  });

  it('scopes matchers per package — aliases do not leak across monorepo packages', async () => {
    const tree = makeTree([
      'services/a/tsconfig.json',
      'services/a/src/util.ts',
      'services/b/tsconfig.json',
      'services/b/src/other.ts',
      'services/b/src/caller.ts',
    ]);
    const resolver = await buildAliasResolver(
      makeFetch({
        'services/a/tsconfig.json': '{"compilerOptions": {"paths": {"#app/*": ["src/*"]}}}',
        'services/b/tsconfig.json': '{"compilerOptions": {"paths": {}}}',
      }),
      tree,
      ['services/a/src/util.ts', 'services/b/src/caller.ts'],
    );
    // a's alias works for a's files…
    expect(resolver.resolve('#app/util', 'services/a/src/util.ts')).toBe('services/a/src/util.ts');
    // …but not for b's files
    expect(resolver.resolve('#app/other', 'services/b/src/caller.ts')).toBeNull();
  });

  it('terminates extends chains at npm-package specifiers without error', async () => {
    const tree = makeTree(['services/a/tsconfig.json', 'services/a/src/x.ts']);
    const resolver = await buildAliasResolver(
      makeFetch({
        'services/a/tsconfig.json': '{"extends": "@loopback/build/config/tsconfig.common.json"}',
      }),
      tree,
      ['services/a/src/x.ts'],
    );
    expect(resolver.resolve('@anything/x', 'services/a/src/x.ts')).toBeNull();
  });

  it('skips unparseable tsconfigs gracefully', async () => {
    const tree = makeTree(['tsconfig.json', 'src/x.ts']);
    const resolver = await buildAliasResolver(
      makeFetch({ 'tsconfig.json': '{not valid json' }),
      tree,
      ['src/x.ts'],
    );
    expect(resolver.resolve('@rao/core/x', 'src/x.ts')).toBeNull();
  });
});
