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

/**
 * String-aware repair of the JSON ills models actually produce: raw control
 * characters inside string values (newlines/tabs in code_suggestion), invalid
 * escapes (\' or a stray backslash before a normal char), and trailing commas
 * before } or ]. Structure outside strings is left untouched.
 */
export function sanitizeJsonText(text: string): string {
  let out = '';
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (ch === '\\') {
        const next = text[i + 1] ?? '';
        if ('"\\/bfnrtu'.includes(next)) {
          out += ch + next;
          i++;
        } else {
          out += '\\\\'; // invalid escape → escape the backslash itself
        }
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      // Trailing comma: skip when the next non-whitespace closes a scope.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }

  return out;
}

/**
 * Completes a truncated JSON object by closing any string left open and
 * appending the missing closers in stack order. Returns null when the text
 * has no opening brace or is already balanced (nothing to complete).
 */
export function completeTruncatedJson(raw: string): string | null {
  const text = stripFence(raw);
  const start = text.indexOf('{');
  if (start === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (stack.length === 0 && !inString) return null;

  // A truncated tail often ends mid-value (`"file": "src/a` or `"line": 12,`);
  // closing the string and dropping the dangling fragment back to the last
  // comma keeps the completed object parseable at the cost of one field.
  let body = text.slice(start);
  if (inString) body += '"';
  body = body.replace(/,\s*("[^"]*"?\s*:?\s*"?)?$/, '');
  return body + stack.reverse().join('');
}

/**
 * Last-resort recovery: pull individual finding objects out of a malformed
 * response one by one, keeping every finding that parses on its own (after
 * sanitization) and dropping only the broken ones. A response with 9 good
 * findings and 1 bad escape yields 9 findings instead of a failed agent.
 */
export function salvageFindingObjects(raw: string): Record<string, unknown>[] | null {
  const text = stripFence(raw);
  const findingsKey = text.search(/"findings"\s*:\s*\[/);
  if (findingsKey === -1) return null;
  const arrayStart = text.indexOf('[', findingsKey);

  const results: Record<string, unknown>[] = [];
  let i = arrayStart + 1;
  while (i < text.length) {
    const objStart = text.indexOf('{', i);
    if (objStart === -1) break;

    // Balance one object, string-aware.
    let depth = 0;
    let inString = false;
    let escaped = false;
    let objEnd = -1;
    for (let j = objStart; j < text.length; j++) {
      const ch = text[j];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { if (inString) escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { objEnd = j; break; }
      }
    }
    if (objEnd === -1) break; // truncated tail — everything before it is kept

    const candidate = text.slice(objStart, objEnd + 1);
    for (const attempt of [candidate, sanitizeJsonText(candidate)]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === 'object') results.push(parsed);
        break;
      } catch {
        // try sanitized form, then give up on this one object only
      }
    }
    i = objEnd + 1;
  }

  return results.length > 0 ? results : null;
}

/** Strips a single ```json … ``` (or bare ```) fence if present. */
function stripFence(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return fence && fence[1] ? fence[1] : raw;
}
