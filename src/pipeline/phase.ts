import * as core from '@actions/core';

/**
 * Runs one named pipeline phase with log grouping, timing, and the action's
 * fail-safety policy:
 *
 * - critical: true  → the error propagates; the run cannot continue without
 *   this phase (pre-flight, context gathering, the review itself, the
 *   summary comment).
 * - critical: false → the error is logged as a warning annotation and the
 *   fallback value is returned; the review continues degraded (bot cleanup,
 *   replies, inline comments, diagrams, description, telemetry).
 */
export async function runPhase<T>(
  name: string,
  opts: { critical: true },
  fn: () => Promise<T>,
): Promise<T>;
export async function runPhase<T>(
  name: string,
  opts: { critical: false },
  fn: () => Promise<T>,
  fallback: T,
): Promise<T>;
export async function runPhase<T>(
  name: string,
  opts: { critical: boolean },
  fn: () => Promise<T>,
  fallback?: T,
): Promise<T> {
  core.startGroup(`▶ ${name}`);
  const t0 = Date.now();
  try {
    const result = await fn();
    core.info(`✓ ${name} completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (opts.critical) {
      core.info(`✗ ${name} failed after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      throw error;
    }
    core.warning(`${name} failed (non-fatal, continuing): ${msg}`);
    return fallback as T;
  } finally {
    core.endGroup();
  }
}
