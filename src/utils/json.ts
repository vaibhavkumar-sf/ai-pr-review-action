/**
 * Robustly extract the first complete JSON object from a model response.
 *
 * Models wrap JSON in ```json fences, prepend prose ("Here is the review:"),
 * or append trailing commentary. The naive `indexOf('{')` … `lastIndexOf('}')`
 * approach breaks when a `}` appears inside a string value or in trailing prose.
 * This scanner strips a single fence, finds the first `{`, then balances braces
 * while respecting string literals and escapes, returning the exact substring of
 * the first complete top-level object.
 *
 * Returns null when there is no `{` at all (empty text / pure prose) or when the
 * object is never closed (truncated response) — the caller decides how to react
 * (e.g. retry for a clean JSON-only answer).
 */
export function extractJsonObject(raw: string): string | null {
  if (!raw) return null;

  // Strip a single ```json … ``` (or bare ``` … ```) fence if present.
  let text = raw;
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence && fence[1]) {
    text = fence[1];
  }

  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  // Opened but never closed → truncated JSON. Signal failure so the caller can
  // retry rather than feeding a syntactically-broken string to JSON.parse.
  return null;
}
