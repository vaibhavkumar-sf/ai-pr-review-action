import { ParsedDiff, DiffHunk, DiffLine } from '../types';

export function parseDiff(rawDiff: string): ParsedDiff[] {
  const results: ParsedDiff[] = [];

  if (!rawDiff || !rawDiff.trim()) {
    return results;
  }

  const fileDiffs = rawDiff.split(/^diff --git /m).filter((s) => s.trim());

  for (const fileDiff of fileDiffs) {
    const parsed = parseFileDiff(fileDiff);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

function parseFileDiff(fileDiff: string): ParsedDiff | null {
  const lines = fileDiff.split('\n');

  let filename: string | null = null;
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      filename = line.slice(6);
      break;
    }
  }

  if (!filename) {
    return null;
  }

  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let diffPosition = 0;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      const oldStart = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      const newStart = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;

      currentHunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };

      oldLineNumber = oldStart;
      newLineNumber = newStart;
      diffPosition++;
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith('+')) {
      diffPosition++;
      const diffLine: DiffLine = {
        type: 'add',
        content: line.slice(1),
        newLineNumber,
        diffPosition,
      };
      currentHunk.lines.push(diffLine);
      newLineNumber++;
    } else if (line.startsWith('-')) {
      diffPosition++;
      const diffLine: DiffLine = {
        type: 'remove',
        content: line.slice(1),
        oldLineNumber,
        diffPosition,
      };
      currentHunk.lines.push(diffLine);
      oldLineNumber++;
    } else if (line.startsWith(' ')) {
      diffPosition++;
      const diffLine: DiffLine = {
        type: 'context',
        content: line.slice(1),
        oldLineNumber,
        newLineNumber,
        diffPosition,
      };
      currentHunk.lines.push(diffLine);
      oldLineNumber++;
      newLineNumber++;
    } else if (line === '\\ No newline at end of file') {
      // Skip this marker; do not increment diffPosition
      continue;
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return { filename, hunks };
}

export function findDiffPosition(
  parsedDiffs: ParsedDiff[],
  filename: string,
  lineNumber: number,
): number | null {
  const fileDiff = parsedDiffs.find((d) => d.filename === filename);
  if (!fileDiff) {
    return null;
  }

  for (const hunk of fileDiff.hunks) {
    for (const line of hunk.lines) {
      if (line.newLineNumber === lineNumber && (line.type === 'add' || line.type === 'context')) {
        return line.diffPosition;
      }
    }
  }

  return null;
}
