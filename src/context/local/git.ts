/**
 * Minimal, injectable git subprocess runner.
 *
 * Uses execFile with an argument ARRAY (no shell) so branch names, paths and
 * URLs can never be shell-injected. The runner is passed as a parameter to
 * every consumer so tests can record/mock command sequences without spawning
 * processes.
 */

import { execFile } from 'child_process';
import { GIT_MAX_BUFFER_BYTES } from '../../config/limits';

export interface GitResult {
  stdout: string;
  exitCode: number;
}

export type GitRunner = (
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
) => Promise<GitResult>;

/**
 * Real runner. `redactValues` (e.g. the GitHub token) are replaced with `***`
 * in any thrown error message — defense in depth on top of core.setSecret,
 * which only masks values in the live log stream, not in Error objects we
 * might rethrow or serialize later.
 */
export function createGitRunner(redactValues: string[]): GitRunner {
  const redact = (text: string): string => {
    let out = text;
    for (const value of redactValues) {
      if (value) out = out.split(value).join('***');
    }
    return out;
  };

  return (args, opts) =>
    new Promise<GitResult>((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          env: {
            ...process.env,
            // Never fall back to interactive credential prompts inside CI.
            GIT_TERMINAL_PROMPT: '0',
          },
        },
        (error, stdout) => {
          if (error) {
            reject(new Error(`git ${redact(args.join(' '))} failed: ${redact(error.message)}`));
            return;
          }
          resolve({ stdout: stdout.toString(), exitCode: 0 });
        },
      );
    });
}
