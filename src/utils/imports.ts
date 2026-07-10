/**
 * The single import extractor for TypeScript/JavaScript sources, shared by
 * dependency-file gathering (context) and the import-graph diagram (results).
 */

/**
 * Extracts RELATIVE import paths (starting with `.`) from source content.
 * Matches ES imports, dynamic import() calls, and require() calls.
 */
export function extractRelativeImports(content: string): string[] {
  const paths: string[] = [];
  let match;

  // ES imports: import ... from '...'
  const esRegex = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = esRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }

  // Dynamic imports: import('...')
  const dynRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }

  // CommonJS: require('...')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    paths.push(match[1]);
  }

  return paths.filter(p => p.startsWith('.'));
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
