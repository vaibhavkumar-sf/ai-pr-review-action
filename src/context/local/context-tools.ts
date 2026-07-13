/**
 * Local repo tools for the bounded agentic context loop: the reviewer model
 * can read exact file slices, grep, resolve references, and list directories
 * — each executing locally in milliseconds against the checkout, never the
 * GitHub API.
 *
 * Safety: every path is resolved inside the repo dir (`..` escapes rejected),
 * checked against the user's exclude patterns, and every result is char-capped.
 * A RUN-WIDE call budget is shared by all agents and batches; when spent,
 * tools answer with a budget message instead of data.
 */

import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { ActionConfig } from '../../types';
import {
  GIT_ACQUIRE_TIMEOUT_MS,
  TOOL_CALLS_RUN_BUDGET,
  TOOL_GREP_MAX_MATCHES,
  TOOL_LIST_DIR_MAX_ENTRIES,
  TOOL_RESULT_MAX_CHARS,
} from '../../config/limits';
import { ToolCall, ToolDefinition } from '../../providers/ai-provider';
import { addLineNumbers } from '../../utils/text';
import { createGitRunner, GitRunner } from './git';
import { LocalRepo } from './local-repo';
import { buildTsEngine, TsEngine } from './ts-project';

export interface ContextToolkit {
  definitions: ToolDefinition[];
  execute(call: ToolCall): Promise<string>;
  callsRemaining(): number;
  dispose(): Promise<void>;
}

export function buildContextToolkit(
  repo: LocalRepo,
  config: ActionConfig,
  git: GitRunner = createGitRunner([]),
): ContextToolkit {
  let callsRemaining = TOOL_CALLS_RUN_BUDGET;
  let engine: TsEngine | null = null;
  let disposed = false;

  const definitions: ToolDefinition[] = [
    {
      name: 'read_file',
      description:
        'Read a file from the repository (optionally a line range). Use for definitions, '
        + 'base classes, or configs the provided context is missing.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative file path' },
          start_line: { type: 'number', description: '1-based first line (optional)' },
          end_line: { type: 'number', description: '1-based last line (optional)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'grep',
      description:
        'Search file contents with an extended regex. Use to find usages, configs, or '
        + 'definitions when the location is unknown. Returns path:line:text matches.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Extended regular expression' },
          glob: { type: 'string', description: "Restrict to paths matching this glob (e.g. '*.service.ts')" },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'find_references',
      description:
        'Find repository files that import a symbol from a given file (compiler-confirmed), '
        + 'with the matching lines. Use to check callers/impact of a changed export.',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Exported symbol name' },
          file: { type: 'string', description: 'Repo-relative path of the file that declares it' },
        },
        required: ['symbol', 'file'],
      },
    },
    {
      name: 'list_dir',
      description: 'List the files in a repository directory (one level).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "Repo-relative directory ('' or '.' for the root)" },
        },
        required: ['path'],
      },
    },
  ];

  const isExcluded = (p: string) =>
    config.excludePatterns.some((pattern) => minimatch(p, pattern, { dot: true }));

  /** Resolves a repo-relative path safely inside the checkout. */
  const safePath = (rel: string): { abs: string; rel: string } | null => {
    const cleaned = rel.replace(/^\.?\//, '');
    const abs = path.resolve(repo.dir, cleaned);
    if (!abs.startsWith(path.resolve(repo.dir) + path.sep) && abs !== path.resolve(repo.dir)) return null;
    if (isExcluded(cleaned)) return null;
    return { abs, rel: cleaned };
  };

  const cap = (text: string): string =>
    text.length > TOOL_RESULT_MAX_CHARS
      ? text.substring(0, TOOL_RESULT_MAX_CHARS) + '\n… (result truncated)'
      : text;

  const readFile = (input: Record<string, unknown>): string => {
    const target = safePath(String(input.path ?? ''));
    if (!target) return `cannot read ${String(input.path)}: outside the repository or excluded`;
    let text: string;
    try {
      text = fs.readFileSync(target.abs, 'utf-8');
    } catch {
      return `file not found: ${target.rel}`;
    }
    const lines = text.split('\n');
    const start = Math.max(1, Number(input.start_line) || 1);
    const end = Math.min(lines.length, Number(input.end_line) || lines.length);
    const slice = lines.slice(start - 1, end).join('\n');
    return cap(addLineNumbers(slice, start));
  };

  const grep = async (input: Record<string, unknown>): Promise<string> => {
    const pattern = String(input.pattern ?? '');
    if (!pattern) return 'grep needs a pattern';
    const args = ['grep', '-n', '--untracked', '-E', '-e', pattern];
    if (input.glob) args.push('--', String(input.glob));
    try {
      const { stdout } = await git(args, { cwd: repo.dir, timeoutMs: GIT_ACQUIRE_TIMEOUT_MS });
      const matches = stdout
        .split('\n')
        .filter(Boolean)
        .filter((line) => !isExcluded(line.split(':')[0]))
        .slice(0, TOOL_GREP_MAX_MATCHES);
      return matches.length ? cap(matches.join('\n')) : 'no matches';
    } catch {
      return 'no matches';
    }
  };

  const findReferences = async (input: Record<string, unknown>): Promise<string> => {
    const symbol = String(input.symbol ?? '');
    const file = String(input.file ?? '');
    if (!symbol || !file) return 'find_references needs symbol and file';
    engine = engine ?? buildTsEngine(repo.dir);
    try {
      const { stdout } = await git(
        ['grep', '-ln', '--untracked', '--fixed-strings', '-e', symbol, '--', '*.ts', '*.tsx'],
        { cwd: repo.dir, timeoutMs: GIT_ACQUIRE_TIMEOUT_MS },
      );
      const candidates = stdout.split('\n').filter(Boolean).filter((p) => p !== file && !isExcluded(p));
      const confirmed: string[] = [];
      for (const candidate of candidates) {
        if (confirmed.length >= TOOL_GREP_MAX_MATCHES) break;
        const { resolved } = engine.resolveImports(candidate);
        if (resolved.some((imp) => imp.path === file && imp.symbols.includes(symbol))) {
          confirmed.push(candidate);
        }
      }
      return confirmed.length
        ? cap(`files importing ${symbol} from ${file}:\n${confirmed.join('\n')}`)
        : `no repository files import ${symbol} from ${file}`;
    } catch {
      return `no repository files import ${symbol} from ${file}`;
    }
  };

  const listDir = (input: Record<string, unknown>): string => {
    const raw = String(input.path ?? '');
    const target = raw === '' || raw === '.' ? { abs: repo.dir, rel: '' } : safePath(raw);
    if (!target) return `cannot list ${raw}: outside the repository or excluded`;
    try {
      const entries = fs
        .readdirSync(target.abs, { withFileTypes: true })
        .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
        .slice(0, TOOL_LIST_DIR_MAX_ENTRIES)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return entries.length ? cap(entries.join('\n')) : '(empty directory)';
    } catch {
      return `directory not found: ${raw}`;
    }
  };

  return {
    definitions,
    callsRemaining: () => callsRemaining,
    async execute(call: ToolCall): Promise<string> {
      if (disposed) return 'tools unavailable — answer from the provided context';
      if (callsRemaining <= 0) return 'tool budget exhausted — answer from the provided context';
      callsRemaining -= 1;
      switch (call.name) {
        case 'read_file': return readFile(call.input);
        case 'grep': return grep(call.input);
        case 'find_references': return findReferences(call.input);
        case 'list_dir': return listDir(call.input);
        default: return `unknown tool: ${call.name}`;
      }
    },
    async dispose(): Promise<void> {
      disposed = true;
      engine?.dispose();
      engine = null;
      await repo.cleanup();
    },
  };
}
