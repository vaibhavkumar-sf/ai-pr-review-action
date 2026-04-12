import { ReviewContext } from '../types';

/**
 * Generates a Mermaid flowchart showing changed files and their import relationships.
 *
 * Only includes files that were actually changed in the PR. Relationships are
 * inferred from import/require statements found in the file content.
 *
 * Returns an empty string if there are fewer than 2 changed files (diagram
 * would not be informative).
 */
export function generateArchitectureDiagram(context: ReviewContext): string {
  const changedFiles = context.changedFiles.filter(f => f.status !== 'removed');

  if (changedFiles.length < 2) {
    return '';
  }

  // Limit diagram size for readability
  const filesToDiagram = changedFiles.slice(0, 20);

  // Build a map of filename -> sanitized node ID
  const nodeIds = new Map<string, string>();
  for (let i = 0; i < filesToDiagram.length; i++) {
    const f = filesToDiagram[i];
    nodeIds.set(f.filename, `f${i}`);
  }

  // Extract import relationships from file contents
  const edges: Array<{ from: string; to: string }> = [];

  for (const file of filesToDiagram) {
    if (!file.content) continue;

    const imports = extractImports(file.content);
    for (const imp of imports) {
      // Resolve relative imports against the file's directory
      const resolved = resolveImportPath(file.filename, imp);
      // Check if the resolved import matches any changed file
      const matchedFile = findMatchingFile(resolved, filesToDiagram.map(f => f.filename));
      if (matchedFile && matchedFile !== file.filename) {
        edges.push({ from: file.filename, to: matchedFile });
      }
    }
  }

  // Build Mermaid diagram
  const lines: string[] = [];
  lines.push('graph TD');

  // Declare nodes with labels
  for (const file of filesToDiagram) {
    const nodeId = nodeIds.get(file.filename)!;
    const label = shortenPath(file.filename);
    const shape = getNodeShape(file.filename, file.status);
    lines.push(`    ${nodeId}${shape.open}"${label}"${shape.close}`);
  }

  // Add edges
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    const fromId = nodeIds.get(edge.from);
    const toId = nodeIds.get(edge.to);
    if (fromId && toId) {
      const edgeKey = `${fromId}->${toId}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        lines.push(`    ${fromId} --> ${toId}`);
      }
    }
  }

  // Style nodes by status
  for (const file of filesToDiagram) {
    const nodeId = nodeIds.get(file.filename)!;
    const style = getStatusStyle(file.status);
    if (style) {
      lines.push(`    style ${nodeId} ${style}`);
    }
  }

  return lines.join('\n');
}

/**
 * Extracts import paths from TypeScript/JavaScript source content.
 */
function extractImports(content: string): string[] {
  const imports: string[] = [];

  // Match ES module imports: import ... from '...'
  const esImportRegex = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = esImportRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // Match require() calls: require('...')
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requireRegex.exec(content)) !== null) {
    imports.push(match[1]);
  }

  // Only keep relative imports (start with . or ..)
  return imports.filter(i => i.startsWith('.'));
}

/**
 * Resolves a relative import path against the importing file's directory.
 */
function resolveImportPath(fromFile: string, importPath: string): string {
  const dir = fromFile.substring(0, fromFile.lastIndexOf('/'));
  const parts = (dir + '/' + importPath).split('/');
  const resolved: string[] = [];

  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return resolved.join('/');
}

/**
 * Finds a changed file that matches the resolved import path.
 * Tries with common extensions (.ts, .js, /index.ts, /index.js).
 */
function findMatchingFile(resolvedPath: string, changedFiles: string[]): string | undefined {
  const candidates = [
    resolvedPath,
    resolvedPath + '.ts',
    resolvedPath + '.js',
    resolvedPath + '.tsx',
    resolvedPath + '.jsx',
    resolvedPath + '/index.ts',
    resolvedPath + '/index.js',
  ];

  for (const candidate of candidates) {
    const found = changedFiles.find(f => f === candidate || f.endsWith('/' + candidate));
    if (found) return found;
  }

  return undefined;
}

/**
 * Shortens a file path for display in the diagram.
 */
function shortenPath(filepath: string): string {
  const parts = filepath.split('/');
  if (parts.length <= 3) return filepath;
  return '.../' + parts.slice(-2).join('/');
}

/**
 * Returns the Mermaid shape delimiters based on file type and status.
 */
function getNodeShape(
  filename: string,
  status: string,
): { open: string; close: string } {
  if (filename.endsWith('.spec.ts') || filename.endsWith('.test.ts')) {
    return { open: '([', close: '])' }; // stadium shape for tests
  }
  if (status === 'added') {
    return { open: '[[', close: ']]' }; // double brackets for new files
  }
  return { open: '[', close: ']' }; // standard rectangle
}

/**
 * Returns Mermaid style string for a file based on its change status.
 */
function getStatusStyle(status: string): string {
  switch (status) {
    case 'added':
      return 'fill:#d4edda,stroke:#28a745,color:#000';
    case 'modified':
      return 'fill:#fff3cd,stroke:#ffc107,color:#000';
    case 'renamed':
      return 'fill:#cce5ff,stroke:#007bff,color:#000';
    default:
      return '';
  }
}
