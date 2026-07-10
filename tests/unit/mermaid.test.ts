import { sanitizeMermaidBlocks, sanitizeMermaidCode } from '../../src/utils/mermaid';

describe('sanitizeMermaidCode', () => {
  it('strips HTML tags', () => {
    expect(sanitizeMermaidCode('A["Line<br/>Break"]')).not.toContain('<br/>');
  });

  it('replaces double colons', () => {
    expect(sanitizeMermaidCode('A["Step::Detail"]')).toContain(' - ');
  });

  it('fixes comma-style edge labels', () => {
    expect(sanitizeMermaidCode('A -->, "Yes", B')).toContain('-->|"Yes"|');
    expect(sanitizeMermaidCode('A -->|"Yes", B')).toContain('-->|"Yes"|');
  });

  it('quotes unquoted edge labels', () => {
    expect(sanitizeMermaidCode('A -->|Yes| B')).toContain('-->|"Yes"|');
  });

  it('quotes node labels containing special characters', () => {
    expect(sanitizeMermaidCode('A[src/index.ts]')).toBe('A["src/index.ts"]');
    expect(sanitizeMermaidCode('B{run a/b?}')).toBe('B{"run a/b?"}');
  });

  it('replaces pipes inside quoted labels', () => {
    expect(sanitizeMermaidCode('A["one|two"]')).toBe('A["one, two"]');
  });

  it('leaves already-valid code unchanged', () => {
    const valid = 'flowchart TD\n  A["Start"] --> B{"Ok?"}\n  B -->|"Yes"| C["Done"]';
    expect(sanitizeMermaidCode(valid)).toBe(valid);
  });
});

describe('sanitizeMermaidBlocks', () => {
  it('sanitizes only fenced mermaid blocks, not prose', () => {
    const doc = 'Some prose with A::B untouched.\n```mermaid\nA["x::y"]\n```\nMore prose.';
    const out = sanitizeMermaidBlocks(doc);
    expect(out).toContain('Some prose with A::B untouched.');
    expect(out).toContain('A["x - y"]');
  });
});
