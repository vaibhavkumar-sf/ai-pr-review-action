/**
 * Prepends line numbers to each line of content (1-indexed, right-aligned).
 * Example output: "   1 | const x = 1;\n   2 | const y = 2;"
 *
 * ALL code sent to the model uses this format — findings must reference these
 * exact line numbers.
 */
export function addLineNumbers(content: string, startLine = 1): string {
  const lines = content.split('\n');
  const padding = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(padding)} | ${line}`)
    .join('\n');
}

/**
 * Human-readable duration from milliseconds.
 * - < 1s   → "850ms"
 * - < 60s  → "45.5s"
 * - ≥ 60s  → "3m 46s" (minutes and seconds, so long runs are legible)
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  let minutes = Math.floor(totalSeconds / 60);
  let seconds = Math.round(totalSeconds % 60);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return `${minutes}m ${seconds}s`;
}
