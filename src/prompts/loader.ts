import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The single prompt loader. ALL prompt text lives in prompts/*.md:
 *  - prompts/<agent>.md            review criteria (user-editable, load-or-empty)
 *  - prompts/system/<name>.md      meta prompts the pipeline depends on (must exist)
 *
 * System prompts support {{placeholder}} substitution for their dynamic parts;
 * an unresolved placeholder is a code bug and fails loudly.
 */

// Prompt files are looked up in: /app/prompts (Docker), ./prompts (local dev),
// and relative to the compiled module (dist/../prompts) — first hit wins.
const PROMPT_LOCATIONS = [
  (filename: string): string => path.join('/app/prompts', filename),
  (filename: string): string => path.join(process.cwd(), 'prompts', filename),
  (filename: string): string => path.join(__dirname, '../../prompts', filename),
];

const cache = new Map<string, string | null>();

function readPromptFile(filename: string): string | null {
  if (cache.has(filename)) return cache.get(filename) ?? null;

  let content: string | null = null;
  for (const locate of PROMPT_LOCATIONS) {
    try {
      content = fs.readFileSync(locate(filename), 'utf-8');
      break;
    } catch {
      continue;
    }
  }

  cache.set(filename, content);
  return content;
}

/**
 * Loads a REQUIRED prompt (e.g. 'system/consolidation') and substitutes
 * {{placeholders}}. Throws when the file is missing or a placeholder is left
 * unresolved — these are packaging/code bugs, not runtime conditions.
 *
 * Exactly one trailing newline is stripped so files can stay POSIX-formatted
 * while callers control composition whitespace precisely.
 */
export function loadPrompt(name: string, vars?: Record<string, string>): string {
  const raw = readPromptFile(`${name}.md`);
  if (raw === null) {
    throw new Error(`Required prompt file prompts/${name}.md not found (packaging bug)`);
  }

  let text = raw.replace(/\n$/, '');
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      text = text.split(`{{${key}}}`).join(value);
    }
  }

  const unresolved = text.match(/\{\{[a-zA-Z0-9_]+\}\}/);
  if (unresolved) {
    throw new Error(`Prompt prompts/${name}.md has unresolved placeholder ${unresolved[0]}`);
  }

  return text;
}

/**
 * Loads an OPTIONAL prompt file verbatim (agent review criteria, framework
 * additions). Missing files log a warning and return '' — the review proceeds
 * with whatever prompt context is available.
 */
export function loadPromptOrEmpty(name: string): string {
  const content = readPromptFile(`${name}.md`);
  if (content === null) {
    core.warning(`Prompt file ${name}.md not found in any location`);
    return '';
  }
  return content;
}

/** Test hook: clears the file cache. */
export function clearPromptCache(): void {
  cache.clear();
}
