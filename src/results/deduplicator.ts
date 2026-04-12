import { Finding, Severity } from '../types';

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  nit: 1,
};

/**
 * Removes duplicate findings that share the same file and line with
 * similar or overlapping issues. When duplicates are detected the
 * finding with the higher severity is kept (its description is enriched
 * with details from the merged finding).
 */
export function deduplicateFindings(findings: Finding[]): Finding[] {
  if (findings.length === 0) return [];

  // Group by file to avoid cross-file deduplication
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.file || '__no_file__';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(f);
  }

  const result: Finding[] = [];

  for (const fileFindings of byFile.values()) {
    const kept: Finding[] = [];

    for (const finding of fileFindings) {
      const duplicateIdx = kept.findIndex(existing => isDuplicate(existing, finding));

      if (duplicateIdx !== -1) {
        // Merge: keep higher severity, enrich description
        const existing = kept[duplicateIdx];
        if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[existing.severity]) {
          // Promote severity but keep the existing as the primary
          const merged: Finding = {
            ...finding,
            description: finding.description + '\n\n**Also noted:** ' + existing.description,
            suggestion: finding.suggestion || existing.suggestion,
            codeSuggestion: finding.codeSuggestion || existing.codeSuggestion,
          };
          kept[duplicateIdx] = merged;
        } else {
          // Keep existing, append the new finding's details
          kept[duplicateIdx] = {
            ...existing,
            description: existing.description + '\n\n**Also noted:** ' + finding.description,
            suggestion: existing.suggestion || finding.suggestion,
            codeSuggestion: existing.codeSuggestion || finding.codeSuggestion,
          };
        }
      } else {
        kept.push(finding);
      }
    }

    result.push(...kept);
  }

  return result;
}

/**
 * Two findings are considered duplicates if:
 * 1. Same line (or within 2 lines of each other)
 * 2. AND one of: similar titles, overlapping keywords, or same description topic
 */
function isDuplicate(a: Finding, b: Finding): boolean {
  // Must be on nearly the same line (within 2 lines)
  if (Math.abs(a.line - b.line) > 2) return false;

  const titleA = a.title.toLowerCase().trim();
  const titleB = b.title.toLowerCase().trim();

  // Exact title match
  if (titleA === titleB) return true;

  // Substring match
  if (titleA.includes(titleB) || titleB.includes(titleA)) return true;

  // Keyword overlap: extract significant words, check overlap ratio
  const wordsA = extractKeywords(titleA + ' ' + a.description.toLowerCase());
  const wordsB = extractKeywords(titleB + ' ' + b.description.toLowerCase());
  const overlap = keywordOverlap(wordsA, wordsB);
  if (overlap >= 0.5) return true;

  // Levenshtein similarity for fuzzy matching
  const maxLen = Math.max(titleA.length, titleB.length);
  if (maxLen === 0) return true;
  const distance = levenshteinDistance(titleA, titleB);
  const similarity = 1 - distance / maxLen;
  if (similarity >= 0.65) return true;

  return false;
}

/**
 * Extract significant keywords from text, filtering out common stop words.
 */
function extractKeywords(text: string): Set<string> {
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'to', 'of',
    'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
    'that', 'which', 'this', 'these', 'those', 'it', 'its', 'or', 'and',
    'but', 'if', 'not', 'no', 'so', 'than', 'too', 'very', 'just', 'also',
    'using', 'use', 'used', 'code', 'file', 'line', 'instead',
  ]);

  const words = text
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  return new Set(words);
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|
 */
function keywordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  if (a.length > b.length) [a, b] = [b, a];

  const aLen = a.length;
  const bLen = b.length;

  let prevRow = new Array<number>(aLen + 1);
  let currRow = new Array<number>(aLen + 1);

  for (let i = 0; i <= aLen; i++) prevRow[i] = i;

  for (let j = 1; j <= bLen; j++) {
    currRow[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[i] = Math.min(
        prevRow[i] + 1,
        currRow[i - 1] + 1,
        prevRow[i - 1] + cost,
      );
    }
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[aLen];
}
