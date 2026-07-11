import { gatherPRContext } from '../../src/context/pr-context';
import { makeConfig } from '../fixtures/factory';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

/**
 * Fake GitHub: a file map + a tree listing drive all Octokit calls that
 * gatherPRContext makes (pulls.get, pulls.listFiles, repos.getContent,
 * git.getTree).
 */
interface FakeRepo {
  files: Record<string, string>;
  changed: Array<{ filename: string; status?: string }>;
  treeTruncated?: boolean;
}

const state: { repo: FakeRepo; getContentCalls: string[]; getTreeCalls: number } = {
  repo: { files: {}, changed: [] },
  getContentCalls: [],
  getTreeCalls: 0,
};

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    pulls: {
      get: jest.fn().mockImplementation(({ mediaType }: { mediaType?: { format: string } }) => {
        if (mediaType?.format === 'diff') return Promise.resolve({ data: 'diff --git a/x b/x' });
        return Promise.resolve({
          data: {
            title: 'Test PR',
            body: 'body',
            user: { login: 'tester' },
            base: { ref: 'main' },
            head: { ref: 'feature', sha: 'headsha' },
          },
        });
      }),
      listFiles: jest.fn().mockImplementation(() =>
        Promise.resolve({
          data: state.repo.changed.map((f) => ({
            filename: f.filename,
            status: f.status ?? 'modified',
            additions: 1,
            deletions: 0,
            patch: '@@',
          })),
        }),
      ),
    },
    repos: {
      getContent: jest.fn().mockImplementation(({ path }: { path: string }) => {
        state.getContentCalls.push(path);
        const content = state.repo.files[path];
        if (content === undefined) return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
        return Promise.resolve({
          data: { type: 'file', content: Buffer.from(content).toString('base64') },
        });
      }),
      getTree: undefined,
    },
    git: {
      getTree: jest.fn().mockImplementation(() => {
        state.getTreeCalls++;
        return Promise.resolve({
          data: {
            truncated: state.repo.treeTruncated ?? false,
            tree: Object.keys(state.repo.files).map((path) => ({
              type: 'blob',
              path,
              size: state.repo.files[path].length,
            })),
          },
        });
      }),
    },
  })),
}));

function setRepo(repo: FakeRepo) {
  state.repo = repo;
  state.getContentCalls = [];
  state.getTreeCalls = 0;
}

describe('gatherPRContext related-context', () => {
  it('resolves relative, alias, and workspace imports plus framework siblings, with reasons', async () => {
    setRepo({
      changed: [{ filename: 'src/app/home/home.component.ts' }],
      files: {
        'src/app/home/home.component.ts': [
          `import { Helper } from './helper';`,
          `import { ApiService } from '@rao/core/api/api.service';`,
          `import { TenantMixin } from '@local/core-lib';`,
          `@Component({ templateUrl: './home.component.html' })`,
          `export class HomeComponent {}`,
        ].join('\n'),
        'src/app/home/helper.ts': 'export const Helper = 1;',
        'src/app/home/home.component.html': '<div></div>',
        'src/app/home/home.module.ts': 'export class HomeModule {}',
        'src/app/core/api/api.service.ts': 'export class ApiService {}',
        'tsconfig.json': '{"compilerOptions": {"paths": {"@rao/core/*": ["src/app/core/*"]}}}',
        'package.json': '{"workspaces": ["packages/*"]}',
        'packages/core-lib/package.json': '{"name": "@local/core-lib"}',
        'packages/core-lib/src/index.ts': 'export * from "./mixins";',
      },
    });

    const context = await gatherPRContext(makeConfig());
    const byPath = Object.fromEntries(context.dependencyFiles.map((d) => [d.filename, d]));

    expect(byPath['src/app/home/helper.ts']?.reason).toBe('imported');
    expect(byPath['src/app/core/api/api.service.ts']?.reason).toBe('imported');
    expect(byPath['src/app/home/home.component.html']?.reason).toBe('template');
    expect(byPath['src/app/home/home.module.ts']?.reason).toBe('declaring-module');
    expect(byPath['src/app/home/helper.ts']?.referencedBy).toContain('src/app/home/home.component.ts');
  });

  it('expands barrel imports into the defining files before ranking', async () => {
    setRepo({
      changed: [{ filename: 'src/a.ts' }],
      files: {
        'src/a.ts': `import { UserModel } from './models';`,
        'src/models/index.ts': `export { UserModel } from './user.model';\nexport { OtherModel } from './other.model';`,
        'src/models/user.model.ts': 'export class UserModel {}',
        'src/models/other.model.ts': 'export class OtherModel {}',
      },
    });

    const context = await gatherPRContext(makeConfig());
    const byPath = Object.fromEntries(context.dependencyFiles.map((d) => [d.filename, d]));
    expect(byPath['src/models/user.model.ts']?.reason).toBe('barrel-reexport');
    expect(byPath['src/models/index.ts']).toBeUndefined(); // definitions replace the barrel
    expect(byPath['src/models/other.model.ts']).toBeUndefined(); // symbol not imported
  });

  it('makes zero tree/content calls beyond changed files when related_context is off', async () => {
    setRepo({
      changed: [{ filename: 'src/a.ts' }],
      files: { 'src/a.ts': `import { B } from './b';`, 'src/b.ts': 'export const B = 1;' },
    });

    const context = await gatherPRContext(makeConfig({ relatedContext: 'off' }));
    expect(context.dependencyFiles).toEqual([]);
    expect(state.getTreeCalls).toBe(0);
    expect(state.getContentCalls).toEqual(['src/a.ts']); // only the changed file body
  });

  it('falls back to legacy relative-only probing when the tree is truncated', async () => {
    setRepo({
      treeTruncated: true,
      changed: [{ filename: 'src/a.ts' }],
      files: {
        'src/a.ts': `import { B } from './b';\nimport { X } from '@alias/x';`,
        'src/b.ts': 'export const B = 1;',
        'tsconfig.json': '{"compilerOptions": {"paths": {"@alias/*": ["src/*"]}}}',
        'src/x.ts': 'export const X = 1;',
      },
    });

    const context = await gatherPRContext(makeConfig());
    const paths = context.dependencyFiles.map((d) => d.filename);
    expect(paths).toContain('src/b.ts');   // relative import still resolved by probing
    expect(paths).not.toContain('src/x.ts'); // alias resolution unavailable without the tree
  });

  it('tolerates content-fetch failures for individual related files', async () => {
    setRepo({
      changed: [{ filename: 'src/a.ts' }],
      files: {
        'src/a.ts': `import { B } from './b';\nimport { C } from './c';`,
        'src/b.ts': 'export const B = 1;',
        // src/c.ts intentionally NOT in files map — but ensure it's in the tree
      },
    });
    // Put c.ts in the tree but make its content fetch fail:
    state.repo.files['src/c.ts'] = undefined as unknown as string;

    const context = await gatherPRContext(makeConfig());
    const paths = context.dependencyFiles.map((d) => d.filename);
    expect(paths).toContain('src/b.ts');
    expect(paths).not.toContain('src/c.ts');
  });

  it('selects fairly across changed files — a high-fan-out file cannot crowd out another file\'s only dependency', async () => {
    // hub.ts imports 30 small model files (top-ranked globally); lone.ts
    // imports a single larger service. Fair selection must include it.
    const files: Record<string, string> = {
      'src/hub.ts': Array.from({ length: 30 }, (_, i) => `import { M${i} } from './m/m${i}.model';`).join('\n'),
      'src/lone.ts': `import { LoneService } from './lone.service';`,
      'src/lone.service.ts': 'export class LoneService { ' + 'x'.repeat(500) + ' }',
    };
    for (let i = 0; i < 30; i++) files[`src/m/m${i}.model.ts`] = `export class M${i} {}`;

    setRepo({ changed: [{ filename: 'src/hub.ts' }, { filename: 'src/lone.ts' }], files });

    const context = await gatherPRContext(makeConfig());
    const paths = context.dependencyFiles.map((d) => d.filename);
    expect(paths).toContain('src/lone.service.ts');
    expect(paths.length).toBeLessThanOrEqual(24); // RELATED_FILES_MAX
  });

  it('excludes related files matching exclude patterns', async () => {
    setRepo({
      changed: [{ filename: 'src/a.ts' }],
      files: {
        'src/a.ts': `import { B } from './generated/b';`,
        'src/generated/b.ts': 'export const B = 1;',
      },
    });

    const context = await gatherPRContext(makeConfig({ excludePatterns: ['**/generated/**'] }));
    expect(context.dependencyFiles).toEqual([]);
  });
});
