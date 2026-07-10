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
