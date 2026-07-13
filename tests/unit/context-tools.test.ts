import * as path from 'path';
import { buildContextToolkit } from '../../src/context/local/context-tools';
import { LocalRepo } from '../../src/context/local/local-repo';
import { TOOL_CALLS_RUN_BUDGET } from '../../src/config/limits';
import { makeConfig } from '../fixtures/factory';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

// ts-morph/git-backed tools can be slow under full-suite parallelism.
jest.setTimeout(60000);

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'mini-repo');

function repoAt(dir: string): { repo: LocalRepo; cleanups: number[] } {
  const cleanups: number[] = [];
  return {
    repo: { dir, source: 'clone', cleanup: async () => { cleanups.push(1); } },
    cleanups,
  };
}

const call = (name: string, input: Record<string, unknown>) => ({ id: 'x', name, input });

describe('ContextToolkit', () => {
  it('read_file returns a line-numbered slice honoring the range', async () => {
    const toolkit = buildContextToolkit(repoAt(FIXTURE_DIR).repo, makeConfig());

    const result = await toolkit.execute(
      call('read_file', { path: 'src/app/board/board.service.ts', start_line: 5, end_line: 6 }),
    );

    expect(result).toContain('5 | export class BoardService {');
    expect(result).not.toContain('import');
  });

  it('rejects path escapes and excluded paths', async () => {
    const toolkit = buildContextToolkit(
      repoAt(FIXTURE_DIR).repo,
      makeConfig({ excludePatterns: ['**/*.secret.ts'] }),
    );

    expect(await toolkit.execute(call('read_file', { path: '../../../etc/passwd' })))
      .toContain('outside the repository or excluded');
    expect(await toolkit.execute(call('read_file', { path: 'src/app/keys.secret.ts' })))
      .toContain('outside the repository or excluded');
  });

  it('grep returns path:line matches, respecting the glob', async () => {
    const toolkit = buildContextToolkit(repoAt(FIXTURE_DIR).repo, makeConfig());

    const result = await toolkit.execute(call('grep', { pattern: 'exportCsv', glob: '*.ts' }));

    expect(result).toContain('src/app/board/board.service.ts');
    expect(result).toContain('src/app/reports/report.generator.ts');
  });

  it('find_references confirms importers via the compiler', async () => {
    const toolkit = buildContextToolkit(repoAt(FIXTURE_DIR).repo, makeConfig());

    const result = await toolkit.execute(
      call('find_references', { symbol: 'BoardService', file: 'src/app/board/board.service.ts' }),
    );

    expect(result).toContain('src/app/reports/report.generator.ts');
  });

  it('list_dir lists one level with directories marked', async () => {
    const toolkit = buildContextToolkit(repoAt(FIXTURE_DIR).repo, makeConfig());

    const result = await toolkit.execute(call('list_dir', { path: 'src/app' }));

    expect(result).toContain('board/');
    expect(result).toContain('user.model.ts');
  });

  it('enforces the run-wide call budget', async () => {
    const toolkit = buildContextToolkit(repoAt(FIXTURE_DIR).repo, makeConfig());

    for (let i = 0; i < TOOL_CALLS_RUN_BUDGET; i++) {
      await toolkit.execute(call('list_dir', { path: '' }));
    }

    expect(toolkit.callsRemaining()).toBe(0);
    expect(await toolkit.execute(call('list_dir', { path: '' }))).toContain('budget exhausted');
  });

  it('dispose cleans up the repo and disables the tools', async () => {
    const { repo, cleanups } = repoAt(FIXTURE_DIR);
    const toolkit = buildContextToolkit(repo, makeConfig());

    await toolkit.dispose();

    expect(cleanups).toHaveLength(1);
    expect(await toolkit.execute(call('list_dir', { path: '' }))).toContain('tools unavailable');
  });
});
