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
