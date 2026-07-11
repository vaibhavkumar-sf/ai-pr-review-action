/**
 * The single import extractor for TypeScript/JavaScript sources, shared by
 * related-context gathering (context) and the import-graph diagram (results).
 */

/** One import statement as written in the source. */
export interface ExtractedImport {
  /** The module specifier exactly as written: './x', '@rao/core/y', '@local/pkg'. */
  specifier: string;
  /**
   * Named bindings imported from the module (the EXPORTED names, so `B as C`
   * records 'B'). Empty for default, namespace, and side-effect imports.
   * Used to resolve barrel (index.ts) re-exports to their defining files.
   */
  symbols: string[];
}

/**
 * Extracts all import specifiers (relative AND package/alias) with their
 * named-binding symbols. Matches ES imports, `export ... from`, dynamic
 * import() calls, and require() calls.
 */
export function extractImports(content: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  let match;

  // ES imports and re-exports with a from-clause:
  //   import <clause> from '...'; / export <clause> from '...'
  const esRegex = /(?:import|export)\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = esRegex.exec(content)) !== null) {
    imports.push({ specifier: match[2], symbols: extractNamedBindings(match[1]) });
  }

  // Side-effect imports: import '...'
  const sideEffectRegex = /import\s+['"]([^'"]+)['"]/g;
  while ((match = sideEffectRegex.exec(content)) !== null) {
    imports.push({ specifier: match[1], symbols: [] });
  }

  // Dynamic imports: import('...')
  const dynRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynRegex.exec(content)) !== null) {
    imports.push({ specifier: match[1], symbols: [] });
  }

  // CommonJS: require('...')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.push({ specifier: match[1], symbols: [] });
  }

  return imports;
}

/**
 * Pulls the exported names out of an import/export clause: `{ A, B as C }`
 * yields ['A', 'B'] (the names as exported by the module, which is what a
 * barrel re-export declares). Default and namespace bindings yield nothing.
 */
function extractNamedBindings(clause: string): string[] {
  const braceMatch = clause.match(/\{([\s\S]*?)\}/);
  if (!braceMatch) return [];
  return braceMatch[1]
    .split(',')
    .map((part) => part.replace(/^\s*type\s+/, '').trim().split(/\s+as\s+/)[0].trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

/**
 * Extracts RELATIVE import paths (starting with `.`) from source content.
 * Kept for consumers that only care about the same-package import graph
 * (e.g. the architecture diagram).
 */
export function extractRelativeImports(content: string): string[] {
  return extractImports(content)
    .map((imp) => imp.specifier)
    .filter((p) => p.startsWith('.'));
}

/**
 * Resolves a relative import path against the importing file's directory.
 * Returns null when the path escapes the repository root or cannot resolve.
 */
export function resolveRelativeImport(fromFile: string, importPath: string): string | null {
  const dir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  if (!dir && !importPath.startsWith('./')) return null;

  const base = dir ? dir + '/' + importPath : importPath;
  const parts = base.split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (resolved.length === 0) return null; // Can't go above root
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return resolved.join('/');
}
