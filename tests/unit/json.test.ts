import { extractJsonObject } from '../../src/utils/json';

describe('extractJsonObject', () => {
  it('extracts a bare JSON object', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts from a ```json fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts from a bare ``` fence', () => {
    expect(extractJsonObject('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('ignores prose before and after', () => {
    expect(extractJsonObject('Here is the review:\n{"a":1}\nHope that helps }')).toBe('{"a":1}');
  });

  it('respects braces inside string values', () => {
    expect(extractJsonObject('{"a":"}{"}tail')).toBe('{"a":"}{"}');
  });

  it('respects escaped quotes inside strings', () => {
    expect(extractJsonObject('{"a":"say \\"hi\\" {now}"}')).toBe('{"a":"say \\"hi\\" {now}"}');
  });

  it('returns null for truncated JSON', () => {
    expect(extractJsonObject('{"a": {"b": 1}')).toBeNull();
  });

  it('returns null for pure prose and empty input', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });
});

import { completeTruncatedJson, salvageFindingObjects, sanitizeJsonText } from '../../src/utils/json';

describe('sanitizeJsonText', () => {
  it('escapes raw control characters inside string values', () => {
    const broken = '{"a": "line1\nline2\ttabbed"}';
    expect(() => JSON.parse(broken)).toThrow();
    expect(JSON.parse(sanitizeJsonText(broken))).toEqual({ a: 'line1\nline2\ttabbed' });
  });

  it('fixes invalid escapes by escaping the backslash', () => {
    const broken = String.raw`{"code": "it\'s broken \d"}`;
    expect(() => JSON.parse(broken)).toThrow();
    expect(JSON.parse(sanitizeJsonText(broken))).toEqual({ code: "it\\'s broken \\d" });
  });

  it('removes trailing commas outside strings only', () => {
    const broken = '{"a": [1, 2,], "b": "x,y,",}';
    expect(JSON.parse(sanitizeJsonText(broken))).toEqual({ a: [1, 2], b: 'x,y,' });
  });

  it('leaves valid JSON byte-identical', () => {
    const valid = JSON.stringify({ a: 'quote " brace } newline\nok', n: [1, 2] });
    expect(sanitizeJsonText(valid)).toBe(valid);
  });
});

describe('completeTruncatedJson', () => {
  it('returns null for balanced JSON', () => {
    expect(completeTruncatedJson('{"a": 1}')).toBeNull();
  });

  it('closes an object truncated mid-string', () => {
    const completed = completeTruncatedJson('{"findings": [{"file": "src/a');
    expect(completed).not.toBeNull();
    const parsed = JSON.parse(completed!);
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  it('closes an object truncated after a comma, dropping the dangling fragment', () => {
    const completed = completeTruncatedJson('{"findings": [{"line": 12}, ');
    expect(JSON.parse(completed!)).toEqual({ findings: [{ line: 12 }] });
  });
});

describe('salvageFindingObjects', () => {
  it('recovers intact findings and drops only broken ones', () => {
    const text = `{"findings": [
      {"severity": "high", "title": "good one", "line": 3},
      {"severity": "medium", "title": "bad
newline", "line": 5},
      {"severity": "low", "title": "another good", "line": 9}
    ], "summary": "s"`;
    const salvaged = salvageFindingObjects(text);
    expect(salvaged).toHaveLength(3); // middle one heals via sanitization
    expect(salvaged![0].title).toBe('good one');
    expect(salvaged![1].title).toBe('bad\nnewline');
  });

  it('keeps findings before a truncated tail', () => {
    const text = '{"findings": [{"severity": "high", "title": "kept"}, {"severity": "low", "ti';
    const salvaged = salvageFindingObjects(text);
    expect(salvaged).toHaveLength(1);
    expect(salvaged![0].title).toBe('kept');
  });

  it('returns null when there is no findings array', () => {
    expect(salvageFindingObjects('no json here')).toBeNull();
  });
});
