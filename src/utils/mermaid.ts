import * as core from '@actions/core';
import { KROKI_MERMAID_URL, KROKI_TIMEOUT_MS } from '../config/limits';

/**
 * The single Mermaid toolkit: sanitize AI-generated diagram code, then
 * validate it with the same mermaid.js parser GitHub uses (Kroki as fallback)
 * so a broken diagram is stripped instead of rendering as a parse error.
 */

/**
 * Fixes the Mermaid syntax mistakes AI models habitually make — malformed edge
 * labels, unquoted labels with special characters, HTML tags, double colons —
 * line by line for reliability. Operates on RAW mermaid code (no fences).
 */
export function sanitizeMermaidCode(code: string): string {
  const lines = code.split('\n');
  const fixedLines = lines.map(line => {
    // Remove HTML tags (<br/>, <b>, etc.)
    line = line.replace(/<[^>]+>/g, ' ');

    // Fix double colons in labels (breaks GitHub parser)
    line = line.replace(/::/g, ' - ');

    // Fix ALL malformed edge label patterns the AI generates:
    //   -->, "Yes",   →  -->|"Yes"|
    //   -->, "Yes"|   →  -->|"Yes"|
    //   --> , "Yes" ,  →  -->|"Yes"|
    line = line.replace(
      /-->\s*,\s*"([^"]*)"\s*[,|]?\s*/g,
      '-->|"$1"| ',
    );

    // Fix edge labels with opening pipe but comma instead of closing pipe:
    //   -->|"Yes",   →  -->|"Yes"|
    //   -->|"Yes" ,  →  -->|"Yes"|
    line = line.replace(
      /-->\|"([^"]*)"\s*,/g,
      '-->|"$1"|',
    );

    // Fix unquoted edge labels with comma closing: -->|Yes, → -->|"Yes"|
    line = line.replace(
      /-->\|([^"|,\]]+)\s*,/g,
      '-->|"$1"|',
    );

    // Fix unquoted edge labels: -->|Yes| → -->|"Yes"|
    line = line.replace(
      /-->\|([^"|]+)\|/g,
      '-->|"$1"|',
    );

    // Fix unquoted node labels with special chars: ID[a/b] → ID["a/b"]
    line = line.replace(
      /(\w+)\[([^\]"]*[\[\]{}()<>\/|&#][^\]"]*)\]/g,
      (_, id, label) => `${id}["${label.replace(/"/g, "'")}"]`,
    );

    // Fix unquoted diamond labels: ID{a/b} → ID{"a/b"}
    line = line.replace(
      /(\w+)\{([^}"]*[\[\]()<>\/|&#][^}"]*)\}/g,
      (_, id, label) => `${id}{"${label.replace(/"/g, "'")}"}`,
    );

    // Remove pipe chars inside quoted labels (breaks Mermaid). Bracket chars are
    // excluded so the match can't span from one label's closing quote to the
    // next label's opening quote (that corrupted valid `-->|"Yes"| C["Done"]`).
    line = line.replace(/"([^"[\]{}]*)\|([^"[\]{}]*)"/g, (_, a, b) => `"${a}, ${b}"`);

    return line;
  });

  return fixedLines.join('\n');
}

/**
 * Applies sanitizeMermaidCode to every ```mermaid block inside a markdown
 * document, leaving the surrounding prose untouched.
 */
export function sanitizeMermaidBlocks(content: string): string {
  return content.replace(/```mermaid\n([\s\S]*?)```/g, (_fullMatch, diagram: string) => {
    return '```mermaid\n' + sanitizeMermaidCode(diagram) + '```';
  });
}

/**
 * Validates Mermaid syntax using the local mermaid.js parser (same as GitHub).
 * Falls back to Kroki.io if local validation is unavailable.
 * Returns null if valid, or the error message string if invalid.
 */
export async function validateMermaid(mermaidCode: string): Promise<string | null> {
  // Try local validation first (same parser as GitHub)
  const localResult = await validateMermaidLocally(mermaidCode);
  if (localResult !== undefined) {
    return localResult; // null = valid, string = error
  }

  // Fall back to Kroki if local validation unavailable
  return validateMermaidViaKroki(mermaidCode);
}

/**
 * Validates Mermaid syntax using the local mermaid.js parser.
 * Returns null if valid, error string if invalid, undefined if parser unavailable.
 */
async function validateMermaidLocally(mermaidCode: string): Promise<string | null | undefined> {
  try {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    (globalThis as Record<string, unknown>).window = dom.window;
    (globalThis as Record<string, unknown>).document = dom.window.document;
    Object.defineProperty(globalThis, 'navigator', {
      value: dom.window.navigator,
      writable: true,
      configurable: true,
    });
    (globalThis as Record<string, unknown>).DOMParser = dom.window.DOMParser;

    const DOMPurifyModule = await import('dompurify');
    const DOMPurify = (DOMPurifyModule.default as (window: unknown) => unknown)(dom.window);
    (globalThis as Record<string, unknown>).DOMPurify = DOMPurify;

    const mermaidModule = await import('mermaid');
    const mermaid = mermaidModule.default;

    await mermaid.parse(mermaidCode);
    return null; // Valid
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    // If it's a module loading error, local validation is unavailable
    if (msg.includes('Cannot find module') || msg.includes('ERR_MODULE_NOT_FOUND')) {
      core.debug('Local mermaid validation unavailable, falling back to Kroki');
      return undefined;
    }

    // Parse error — diagram is invalid
    return msg.substring(0, 500);
  }
}

/**
 * Validates Mermaid syntax by sending it to Kroki.io's Mermaid renderer.
 * Returns null if valid, or the error message string if invalid.
 * When Kroki is unreachable, returns an error (does NOT silently pass).
 */
export async function validateMermaidViaKroki(mermaidCode: string): Promise<string | null> {
  try {
    const response = await fetch(KROKI_MERMAID_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: mermaidCode,
      signal: AbortSignal.timeout(KROKI_TIMEOUT_MS),
    });

    if (response.ok) {
      return null; // Valid!
    }

    const errorBody = await response.text();
    const plainError = errorBody
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 500);
    return plainError || `Kroki validation failed with HTTP ${response.status}`;
  } catch (err) {
    // Kroki unreachable — return error instead of silently passing
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Kroki validation unavailable: ${msg}`);
    return `Kroki unreachable: ${msg}`;
  }
}

/**
 * Validates each ```mermaid block in the content and strips blocks that fail
 * parsing, so GitHub doesn't show parse errors in the PR description.
 */
export async function validateAndStripBrokenMermaid(content: string): Promise<string> {
  const mermaidRegex = /```mermaid\n([\s\S]*?)```/g;
  const matches = [...content.matchAll(mermaidRegex)];
  if (matches.length === 0) return content;

  let result = content;
  for (const match of matches) {
    const mermaidCode = match[1];
    const error = await validateMermaid(mermaidCode);
    if (error) {
      core.warning(`Stripping broken Mermaid block from description: ${error.substring(0, 200)}`);
      result = result.replace(match[0], '');
    }
  }

  return result;
}
