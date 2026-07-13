import { toSkeleton } from '../../src/context/local/skeletons';

// ts-morph parsing is CPU-heavy under full-suite parallelism.
jest.setTimeout(60000);

const LONG_BODY_LINES = [
  "    const a = 'a long enough body that clearly exceeds the minimum';",
  "    const b = a.toUpperCase();",
  "    const c = [a, b].join(' / ');",
  '    return c.length;',
].join('\n');

describe('toSkeleton', () => {
  it('strips long method and function bodies but keeps signatures, JSDoc, and decorators', () => {
    const source = [
      '/** Docs for the service. */',
      '@Injectable()',
      'export class ReportService {',
      '  /** Docs for generate. */',
      '  generate(input: string): number {',
      LONG_BODY_LINES,
      '  }',
      '}',
      '',
      'export function standalone(x: number): number {',
      LONG_BODY_LINES,
      '}',
    ].join('\n');

    const result = toSkeleton(source, 'report.service.ts');

    expect(result).toContain('/** Docs for the service. */');
    expect(result).toContain('@Injectable()');
    expect(result).toContain('generate(input: string): number { /* … body omitted … */ }');
    expect(result).toContain('export function standalone(x: number): number { /* … body omitted … */ }');
    expect(result).not.toContain('toUpperCase');
  });

  it('keeps short bodies intact', () => {
    const source = 'export function tiny(): number {\n  return 1;\n}\n';
    expect(toSkeleton(source, 'tiny.ts')).toBe(source);
  });

  it('keeps interfaces, types, enums, and property declarations verbatim', () => {
    const source = [
      'export interface Shape { width: number; height: number; }',
      "export type Mode = 'a' | 'b';",
      'export enum Level { Low, High }',
      'export class Config {',
      "  readonly name: string = 'default';",
      '}',
    ].join('\n');

    expect(toSkeleton(source, 'shapes.ts')).toBe(source);
  });

  it('preserves bodies overlapping keepBodiesOverlapping ranges (call sites)', () => {
    const source = [
      'export class A {',
      '  caller(): number {',
      LONG_BODY_LINES,
      '  }',
      '  other(): number {',
      LONG_BODY_LINES,
      '  }',
      '}',
    ].join('\n');

    // Lines 2-8 cover caller(); other() starts later.
    const result = toSkeleton(source, 'a.ts', { keepBodiesOverlapping: [{ start: 3, end: 4 }] });

    const callerIdx = result.indexOf('caller()');
    const otherIdx = result.indexOf('other()');
    expect(result.substring(callerIdx, otherIdx)).toContain('toUpperCase');
    expect(result.substring(otherIdx)).toContain('body omitted');
  });

  it('returns the original text on unparseable input', () => {
    const source = 'not typescript at all }{ ((';
    expect(toSkeleton(source, 'broken.ts')).toBe(source);
  });
});
