import {
  collectFrameworkCandidates,
  pascalToKebab,
  rankCandidates,
  resolveBarrelTargets,
  resolveInjectKey,
  RelatedCandidate,
} from '../../src/context/related-files';
import { RepoTree } from '../../src/context/repo-tree';
import { ChangedFile } from '../../src/types';

function makeTree(entries: Array<string | { path: string; size: number }>): RepoTree {
  const sizes = new Map<string, number>();
  const set = new Set<string>();
  for (const entry of entries) {
    const path = typeof entry === 'string' ? entry : entry.path;
    set.add(path);
    if (typeof entry !== 'string') sizes.set(path, entry.size);
  }
  const dirOf = (p: string) => {
    const slash = p.lastIndexOf('/');
    return slash === -1 ? '' : p.substring(0, slash);
  };
  return {
    paths: set,
    has: (p) => set.has(p),
    size: (p) => sizes.get(p),
    listDir: (dir) => [...set].filter((p) => dirOf(p) === dir),
    findByDirSuffixAndName(dirSuffix, fileName) {
      return [...set].filter((p) => {
        const dir = dirOf(p);
        return (dir === dirSuffix || dir.endsWith('/' + dirSuffix)) && p.endsWith('/' + fileName);
      });
    },
    nearestUp(fromDir, pattern) {
      let dir = fromDir;
      while (true) {
        for (const p of set) {
          if (dirOf(p) === dir && pattern.test(p.substring(p.lastIndexOf('/') + 1))) return p;
        }
        if (dir === '') return null;
        const slash = dir.lastIndexOf('/');
        dir = slash === -1 ? '' : dir.substring(0, slash);
      }
    },
  };
}

function changed(filename: string, content: string): ChangedFile {
  return { filename, content, status: 'modified', additions: 1, deletions: 0 };
}

describe('collectFrameworkCandidates — Angular', () => {
  const tree = makeTree([
    'src/app/home/home.component.ts',
    'src/app/home/home.component.html',
    'src/app/home/home.component.scss',
    'src/app/home/home-routing.module.ts',
    'src/app/home/home.module.ts',
  ]);

  it('finds sibling template, styles, and the declaring module (skipping routing modules)', () => {
    const file = changed(
      'src/app/home/home.component.ts',
      `@Component({
        selector: 'app-home',
        templateUrl: './home.component.html',
        styleUrls: ['./home.component.scss'],
      })`,
    );
    const candidates = collectFrameworkCandidates([file], tree, 'angular');
    const byReason = Object.fromEntries(candidates.map((c) => [c.reason, c.path]));
    expect(byReason['template']).toBe('src/app/home/home.component.html');
    expect(byReason['stylesheet']).toBe('src/app/home/home.component.scss');
    expect(byReason['declaring-module']).toBe('src/app/home/home.module.ts');
  });

  it('skips templates that are themselves changed files', () => {
    const component = changed(
      'src/app/home/home.component.ts',
      `templateUrl: './home.component.html'`,
    );
    const template = changed('src/app/home/home.component.html', '<div></div>');
    const candidates = collectFrameworkCandidates([component, template], tree, 'angular');
    expect(candidates.some((c) => c.path === 'src/app/home/home.component.html')).toBe(false);
  });
});

describe('collectFrameworkCandidates — LoopBack4', () => {
  const tree = makeTree([
    'services/x/src/datasources/pgdb.datasource.ts',
    'services/x/src/services/user-resource-helper.service.ts',
    'services/x/src/adapters/timeline-settings.adapter.ts',
  ]);

  it('resolves string-key @inject bindings', () => {
    const file = changed(
      'services/x/src/controllers/board.controller.ts',
      `class C {
        constructor(
          @inject('datasources.pgdb') private db: unknown,
          @inject('services.UserResourceHelperService') private helper: unknown,
          @inject.getter('adapters.TimelineSettingsAdapter') private adapter: unknown,
        ) {}
      }`,
    );
    const paths = collectFrameworkCandidates([file], tree, 'loopback4').map((c) => c.path).sort();
    expect(paths).toEqual([
      'services/x/src/adapters/timeline-settings.adapter.ts',
      'services/x/src/datasources/pgdb.datasource.ts',
      'services/x/src/services/user-resource-helper.service.ts',
    ]);
  });
});

describe('resolveInjectKey', () => {
  const tree = makeTree(['app/src/repositories/task.repository.ts']);
  it('resolves repositories namespace and rejects unknown namespaces', () => {
    expect(resolveInjectKey('repositories.TaskRepository', tree)).toBe('app/src/repositories/task.repository.ts');
    expect(resolveInjectKey('custom.SomethingElse', tree)).toBeNull();
    expect(resolveInjectKey('nodots', tree)).toBeNull();
  });

  it('prefers the match sharing the longest path prefix with the referencing file', () => {
    const monoTree = makeTree([
      'services/analytics-service/src/datasources/pgdb.datasource.ts',
      'services/project-management-service/src/datasources/pgdb.datasource.ts',
    ]);
    expect(
      resolveInjectKey('datasources.pgdb', monoTree, 'services/project-management-service/src/controllers/board.controller.ts'),
    ).toBe('services/project-management-service/src/datasources/pgdb.datasource.ts');
    expect(
      resolveInjectKey('datasources.pgdb', monoTree, 'services/analytics-service/src/services/report.service.ts'),
    ).toBe('services/analytics-service/src/datasources/pgdb.datasource.ts');
  });
});

describe('pascalToKebab', () => {
  it('converts PascalCase, handling acronym runs', () => {
    expect(pascalToKebab('UserResourceHelper')).toBe('user-resource-helper');
    expect(pascalToKebab('HTTPServer')).toBe('http-server');
  });
});

describe('resolveBarrelTargets', () => {
  const tree = makeTree([
    'src/models/index.ts',
    'src/models/user.model.ts',
    'src/models/board-csv-dto.model.ts',
    'src/models/other.model.ts',
  ]);

  it('resolves named re-exports for imported symbols only', () => {
    const barrel = `
      export { UserModel } from './user.model';
      export { OtherModel } from './other.model';
    `;
    expect(resolveBarrelTargets('src/models/index.ts', barrel, ['UserModel'], tree))
      .toEqual(['src/models/user.model.ts']);
  });

  it('matches export-* targets by normalized symbol/basename', () => {
    const barrel = `
      export * from './user.model';
      export * from './board-csv-dto.model';
    `;
    expect(resolveBarrelTargets('src/models/index.ts', barrel, ['BoardCsvDto'], tree))
      .toEqual(['src/models/board-csv-dto.model.ts']);
  });

  it('never returns the barrel itself (self/circular re-export)', () => {
    const barrel = `export * from './index';`;
    expect(resolveBarrelTargets('src/models/index.ts', barrel, ['Anything'], tree)).toEqual([]);
  });

  it('expands wide imports fully when maxTargets scales with the symbol count', () => {
    const wideTree = makeTree(Array.from({ length: 6 }, (_, i) => `src/svc/s${i}.service.ts`).concat('src/svc/index.ts'));
    const barrel = Array.from({ length: 6 }, (_, i) => `export { S${i}Service } from './s${i}.service';`).join('\n');
    const symbols = Array.from({ length: 6 }, (_, i) => `S${i}Service`);
    expect(resolveBarrelTargets('src/svc/index.ts', barrel, symbols, wideTree, 6)).toHaveLength(6);
    // default cap still limits to 4
    expect(resolveBarrelTargets('src/svc/index.ts', barrel, symbols, wideTree)).toHaveLength(4);
  });
});

describe('rankCandidates', () => {
  const tree = makeTree([
    { path: 'src/a.model.ts', size: 100 },
    { path: 'src/b.service.ts', size: 100 },
    { path: 'src/c.model.ts', size: 50 },
    { path: 'src/d.scss', size: 10 },
  ]);
  const make = (path: string, refs: string[]): RelatedCandidate => ({
    path,
    referencedBy: new Set(refs),
    reason: 'imported',
  });

  it('orders by reference count, then kind weight, then size, deterministically', () => {
    const ranked = rankCandidates(
      [make('src/d.scss', ['x', 'y']), make('src/a.model.ts', ['x']), make('src/b.service.ts', ['x']), make('src/c.model.ts', ['x'])],
      tree,
    );
    expect(ranked.map((c) => c.path)).toEqual([
      'src/d.scss',        // 2 refs beats everything
      'src/c.model.ts',    // model weight, smaller
      'src/a.model.ts',    // model weight, larger
      'src/b.service.ts',  // service weight
    ]);
  });
});
