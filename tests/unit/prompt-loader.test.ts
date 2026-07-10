import { clearPromptCache, loadPrompt, loadPromptOrEmpty } from '../../src/prompts/loader';

describe('prompt loader', () => {
  beforeEach(() => clearPromptCache());

  it('loads every required system prompt', () => {
    for (const name of [
      'system/global-rules', 'system/user-contract', 'system/json-repair',
      'system/consolidation', 'system/pr-description', 'system/mermaid-diagrams',
      'system/reply-verdict',
    ]) {
      const text = loadPrompt(name);
      expect(text.length).toBeGreaterThan(100);
      expect(text.endsWith('\n')).toBe(false); // exactly one trailing newline stripped
    }
  });

  it('substitutes {{placeholders}}', () => {
    const text = loadPrompt('system/mermaid-fix', { error_sections: 'SECTION-A\n\n' });
    expect(text).toContain('SECTION-A');
    expect(text).not.toContain('{{error_sections}}');
    expect(text.startsWith('The Mermaid diagrams have syntax errors.')).toBe(true);
    expect(text).toContain('Common fixes:');
  });

  it('throws on an unresolved placeholder', () => {
    expect(() => loadPrompt('system/mermaid-fix')).toThrow(/unresolved placeholder/);
  });

  it('throws on a missing required prompt', () => {
    expect(() => loadPrompt('system/does-not-exist')).toThrow(/not found/);
  });

  it('does not treat GitHub Actions ${{ }} syntax as a placeholder', () => {
    const text = loadPrompt('system/user-contract');
    expect(text).toContain('${{ }}');
  });

  it('loadPromptOrEmpty returns file content verbatim and "" when missing', () => {
    const comprehensive = loadPromptOrEmpty('comprehensive');
    expect(comprehensive.length).toBeGreaterThan(1000);
    expect(loadPromptOrEmpty('does-not-exist')).toBe('');
  });
});
