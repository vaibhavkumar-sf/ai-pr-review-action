import * as core from '@actions/core';

/**
 * The single logging surface. Feature code logs through @actions/core (info/
 * warning/debug annotations); this module adds the pieces core doesn't give
 * us directly: config-gated debug, and the job summary.
 */

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function debug(message: string): void {
  if (!debugEnabled) return;
  core.debug(message);
}

export function info(message: string): void {
  core.info(message);
}

export function warning(message: string): void {
  core.warning(message);
}

export const logger = { debug, info, warning, setDebug };

/**
 * Writes the GitHub job summary (the markdown panel on the run page).
 * Best-effort: a summary failure never affects the review outcome.
 */
export async function writeJobSummary(markdown: string): Promise<void> {
  try {
    await core.summary.addRaw(markdown).write();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    core.debug(`Could not write job summary (non-critical): ${msg}`);
  }
}
