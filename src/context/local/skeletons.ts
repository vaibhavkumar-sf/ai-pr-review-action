/**
 * Declaration skeletons: strip function/method/constructor/accessor bodies
 * from a source file while keeping everything that teaches the reviewer the
 * file's shape — JSDoc, decorators, signatures, class/interface/type/enum
 * members, property types. Purely syntactic (no type checking), so it works
 * on repos without node_modules.
 *
 * A 400-line service becomes ~30 lines of API surface; the reviewer loses
 * nothing it is allowed to use (related files are context-only — findings in
 * them are prohibited by the prompt contract).
 */

import { Node, Project, SyntaxKind } from 'ts-morph';
import { SKELETON_BODY_MIN_CHARS } from '../../config/limits';

export interface LineRange {
  /** 1-based, inclusive. */
  start: number;
  end: number;
}

const BODY_PARENT_KINDS = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
] as const;

/**
 * Returns the source with long implementation bodies replaced by a
 * "body omitted" placeholder block. Bodies overlapping any of
 * `opts.keepBodiesOverlapping` (e.g. call sites of a changed symbol) are
 * preserved in full. On any parse problem the original text is returned —
 * skeletons are an optimization, never a failure mode.
 */
export function toSkeleton(
  sourceText: string,
  filePath: string,
  opts: { keepBodiesOverlapping?: LineRange[] } = {},
): string {
  try {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: true } });
    const sourceFile = project.createSourceFile(filePath.replace(/[^\w./-]/g, '_'), sourceText);
    const keep = opts.keepBodiesOverlapping ?? [];

    // Collect body spans to strip (outermost only — an inner function inside
    // a stripped body disappears with it).
    const spans: Array<{ start: number; end: number }> = [];
    for (const kind of BODY_PARENT_KINDS) {
      for (const node of sourceFile.getDescendantsOfKind(kind)) {
        const body = 'getBody' in node ? node.getBody() : undefined;
        if (!body || !Node.isBlock(body)) continue;
        if (body.getText().length < SKELETON_BODY_MIN_CHARS) continue;

        const startLine = body.getStartLineNumber();
        const endLine = body.getEndLineNumber();
        if (keep.some((r) => r.start <= endLine && r.end >= startLine)) continue;

        spans.push({ start: body.getStart(), end: body.getEnd() });
      }
    }
    if (spans.length === 0) return sourceText;

    spans.sort((a, b) => a.start - b.start);
    const outermost: typeof spans = [];
    for (const span of spans) {
      const last = outermost[outermost.length - 1];
      if (last && span.start >= last.start && span.end <= last.end) continue; // nested
      outermost.push(span);
    }

    let result = '';
    let cursor = 0;
    for (const span of outermost) {
      result += sourceText.substring(cursor, span.start) + '{ /* … body omitted … */ }';
      cursor = span.end;
    }
    result += sourceText.substring(cursor);
    return result;
  } catch {
    return sourceText;
  }
}
