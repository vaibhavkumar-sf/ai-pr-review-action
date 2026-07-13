import * as fs from 'fs';
import * as path from 'path';
import { gatherRelatedFilesLocal } from '../../src/context/local/local-context';
import { LocalRepo } from '../../src/context/local/local-repo';
import { makeConfig } from '../fixtures/factory';
import { ChangedFile } from '../../src/types';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

// ts-morph project construction is CPU-heavy; under full-suite parallelism
// the first test can exceed Jest's 5s default.
jest.setTimeout(60000);

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'mini-repo');

function repoAt(dir: string): LocalRepo {
  return { dir, source: 'clone', cleanup: async () => undefined };
}

function changed(filename: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename,
    status: 'modified',
    content: fs.readFileSync(path.join(FIXTURE_DIR, filename), 'utf-8'),
    additions: 1,
    deletions: 0,
    ...overrides,
  };
}

function diffFor(filename: string, addedLines: string[]): string {
  return [
    `diff --git a/${filename} b/${filename}`,
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,2 +1,${1 + addedLines.length} @@`,
    ' // context line',
    ...addedLines.map((l) => `+${l}`),
  ].join('\n');
}

describe('gatherRelatedFilesLocal (compiler engine over mini-repo)', () => {
  it('resolves barrels to the exact defining files — no basename fuzz, no unrelated siblings', async () => {
    const files = [changed('src/app/board/board.service.ts')];
    const deps = await gatherRelatedFilesLocal(
      repoAt(FIXTURE_DIR), makeConfig(), files, diffFor('src/app/board/board.service.ts', ['const dto = new BoardCsvDto();']),
    );

    const byName = new Map(deps.map((d) => [d.filename, d]));
    // `import { BoardCsvDto } from './models'` lands on the barrel; the
    // compiler follows `export *` to the real definition.
    expect(byName.get('src/app/board/models/board-csv-dto.model.ts')?.reason).toBe('barrel-reexport');
    // The barrel's OTHER exports are not dragged in.
    expect(byName.has('src/app/board/models/board-meta.model.ts')).toBe(false);
    expect(byName.has('src/app/board/models/index.ts')).toBe(false);
  });

  it('resolves tsconfig path aliases natively', async () => {
    const files = [changed('src/app/board/board.service.ts')];
    const deps = await gatherRelatedFilesLocal(repoAt(FIXTURE_DIR), makeConfig(), files, '');

    const user = deps.find((d) => d.filename === 'src/app/user.model.ts');
    expect(user?.reason).toBe('imported');
    expect(user?.referencedBy).toContain('src/app/board/board.service.ts');
  });

  it('resolves workspace package imports via the package-name fallback', async () => {
    const files = [changed('src/app/board/board.service.ts')];
    const deps = await gatherRelatedFilesLocal(repoAt(FIXTURE_DIR), makeConfig(), files, '');

    expect(deps.some((d) => d.filename === 'packages/shared/src/index.ts')).toBe(true);
  });

  it('ranks hunk-referenced dependencies first', async () => {
    const files = [changed('src/app/board/board.service.ts')];
    const diff = diffFor('src/app/board/board.service.ts', ['const dto = new BoardCsvDto();']);
    const deps = await gatherRelatedFilesLocal(repoAt(FIXTURE_DIR), makeConfig(), files, diff);

    expect(deps[0].filename).toBe('src/app/board/models/board-csv-dto.model.ts');
  });

  it('expands Angular siblings (template, styles, declaring module) in full mode', async () => {
    const files = [changed('src/app/angular/widget.component.ts')];
    const deps = await gatherRelatedFilesLocal(repoAt(FIXTURE_DIR), makeConfig({ framework: 'angular' }), files, '');

    const reasons = new Map(deps.map((d) => [d.filename, d.reason]));
    expect(reasons.get('src/app/angular/widget.component.html')).toBe('template');
    expect(reasons.get('src/app/angular/widget.component.scss')).toBe('stylesheet');
    expect(reasons.get('src/app/angular/widget.module.ts')).toBe('declaring-module');
  });

  it('skips framework expansion in imports-only mode', async () => {
    const files = [changed('src/app/angular/widget.component.ts')];
    const deps = await gatherRelatedFilesLocal(
      repoAt(FIXTURE_DIR), makeConfig({ framework: 'angular', relatedContext: 'imports-only' }), files, '',
    );

    expect(deps.some((d) => d.reason === 'template' || d.reason === 'stylesheet')).toBe(false);
  });

  it('resolves LoopBack4 string-key DI bindings', async () => {
    const files = [changed('src/app/lb4/services/tollgate.service.ts')];
    const deps = await gatherRelatedFilesLocal(repoAt(FIXTURE_DIR), makeConfig({ framework: 'loopback4' }), files, '');

    const ds = deps.find((d) => d.filename === 'src/app/lb4/datasources/pgdb.datasource.ts');
    expect(ds?.reason).toBe('di-binding');
  });

  it('respects exclude patterns', async () => {
    const files = [changed('src/app/board/board.service.ts')];
    const deps = await gatherRelatedFilesLocal(
      repoAt(FIXTURE_DIR), makeConfig({ excludePatterns: ['**/*.model.ts'] }), files, '',
    );

    expect(deps.some((d) => d.filename.endsWith('.model.ts'))).toBe(false);
  });

  it('never reports changed files as related context', async () => {
    const files = [
      changed('src/app/board/board.service.ts'),
      changed('src/app/user.model.ts'),
    ];
    const deps = await gatherRelatedFilesLocal(repoAt(FIXTURE_DIR), makeConfig(), files, '');

    expect(deps.some((d) => d.filename === 'src/app/user.model.ts')).toBe(false);
  });

  it('skips unresolvable external packages instead of guessing', async () => {
    const files = [changed('src/app/angular/widget.component.ts')];
    const deps = await gatherRelatedFilesLocal(
      repoAt(FIXTURE_DIR), makeConfig({ framework: 'angular', relatedContext: 'imports-only' }), files, '',
    );

    // '@angular/core' has no node_modules and is not a workspace package.
    expect(deps).toHaveLength(0);
  });
});
