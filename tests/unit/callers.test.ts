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

function changed(filename: string): ChangedFile {
  return {
    filename,
    status: 'modified',
    content: fs.readFileSync(path.join(FIXTURE_DIR, filename), 'utf-8'),
    additions: 1,
    deletions: 0,
  };
}

/** A diff whose hunk covers the whole file (seeds every exported symbol). */
function wholeFileDiff(filename: string): string {
  const lineCount = fs.readFileSync(path.join(FIXTURE_DIR, filename), 'utf-8').split('\n').length;
  return [
    `diff --git a/${filename} b/${filename}`,
    `--- a/${filename}`,
    `+++ b/${filename}`,
    `@@ -1,${lineCount} +1,${lineCount} @@`,
    '+// touched',
  ].join('\n');
}

describe('caller discovery (reverse dependencies)', () => {
  it('finds files that call exported symbols changed in the diff, as skeletons', async () => {
    const files = [changed('src/app/board/board.service.ts')];
    const deps = await gatherRelatedFilesLocal(
      repoAt(FIXTURE_DIR), makeConfig(), files, wholeFileDiff('src/app/board/board.service.ts'),
    );

    const caller = deps.find((d) => d.filename === 'src/app/reports/report.generator.ts');
    expect(caller).toBeDefined();
    expect(caller?.reason).toBe('caller');
    expect(caller?.skeleton).toBe(true);
    expect(caller?.referencedBy).toContain('src/app/board/board.service.ts');
    // The calling body survives; the unrelated helper body is stripped.
    expect(caller?.content).toContain('exportCsv');
    expect(caller?.content).not.toContain('reduce');
    expect(caller?.content).toContain('body omitted');
  });

  it('finds no callers when the diff does not touch exported declarations', async () => {
    const files = [changed('src/app/board/board.service.ts')];
    // Hunk confined to line 1 (imports) — no exported declaration intersects.
    const diff = [
      'diff --git a/src/app/board/board.service.ts b/src/app/board/board.service.ts',
      '--- a/src/app/board/board.service.ts',
      '+++ b/src/app/board/board.service.ts',
      '@@ -1,1 +1,1 @@',
      "+import { BoardCsvDto } from './models';",
    ].join('\n');

    const deps = await gatherRelatedFilesLocal(repoAt(FIXTURE_DIR), makeConfig(), files, diff);

    expect(deps.some((d) => d.reason === 'caller')).toBe(false);
  });

  it('skips caller discovery in imports-only mode', async () => {
    const files = [changed('src/app/board/board.service.ts')];
    const deps = await gatherRelatedFilesLocal(
      repoAt(FIXTURE_DIR),
      makeConfig({ relatedContext: 'imports-only' }),
      files,
      wholeFileDiff('src/app/board/board.service.ts'),
    );

    expect(deps.some((d) => d.reason === 'caller')).toBe(false);
  });

  it('never reports a changed file or an excluded file as a caller', async () => {
    const files = [
      changed('src/app/board/board.service.ts'),
      changed('src/app/reports/report.generator.ts'),
    ];
    const deps = await gatherRelatedFilesLocal(
      repoAt(FIXTURE_DIR), makeConfig(), files, wholeFileDiff('src/app/board/board.service.ts'),
    );

    expect(deps.some((d) => d.filename === 'src/app/reports/report.generator.ts')).toBe(false);
  });
});

describe('skeletons for large imported files', () => {
  it('sends small imported files whole (no skeleton flag)', async () => {
    const files = [changed('src/app/board/board.service.ts')];
    const deps = await gatherRelatedFilesLocal(repoAt(FIXTURE_DIR), makeConfig(), files, '');

    const model = deps.find((d) => d.filename === 'src/app/board/models/board-csv-dto.model.ts');
    expect(model?.skeleton).toBeUndefined();
    expect(model?.content).toContain('rows');
  });
});
