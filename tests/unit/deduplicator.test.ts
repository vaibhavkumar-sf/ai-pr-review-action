import { deduplicateFindings } from '../../src/results/deduplicator';
import { makeFinding } from '../fixtures/factory';

describe('deduplicateFindings', () => {
  it('passes distinct findings through', () => {
    const findings = [
      makeFinding({ title: 'SQL injection', line: 10 }),
      makeFinding({ title: 'Missing pagination', line: 200, category: 'performance' }),
    ];
    expect(deduplicateFindings(findings)).toHaveLength(2);
  });

  it('merges same-title findings within 2 lines, keeping higher severity', () => {
    const findings = [
      makeFinding({ title: 'Missing return type', line: 10, severity: 'medium' }),
      makeFinding({ title: 'Missing return type', line: 11, severity: 'high' }),
    ];
    const result = deduplicateFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('high');
    expect(result[0].description).toContain('**Also noted:**');
  });

  it('does not merge findings more than 2 lines apart', () => {
    const findings = [
      makeFinding({ title: 'Missing return type', line: 10 }),
      makeFinding({ title: 'Missing return type', line: 14 }),
    ];
    expect(deduplicateFindings(findings)).toHaveLength(2);
  });

  it('does not merge across files', () => {
    const findings = [
      makeFinding({ title: 'Missing return type', file: 'a.ts', line: 10 }),
      makeFinding({ title: 'Missing return type', file: 'b.ts', line: 10 }),
    ];
    expect(deduplicateFindings(findings)).toHaveLength(2);
  });

  it('merges fuzzy-similar titles (substring / keyword overlap)', () => {
    const findings = [
      makeFinding({ title: 'Missing input validation', line: 5 }),
      makeFinding({ title: 'Missing input validation on id param', line: 5 }),
    ];
    expect(deduplicateFindings(findings)).toHaveLength(1);
  });

  it('handles the empty list', () => {
    expect(deduplicateFindings([])).toEqual([]);
  });
});
