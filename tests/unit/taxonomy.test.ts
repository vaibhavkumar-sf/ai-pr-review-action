import {
  AGENT_LABELS,
  CATEGORY_IDS,
  CATEGORY_LABELS,
  coerceCategory,
  coerceFinding,
  coerceSeverity,
  INLINE_SEVERITIES,
  isInlineWorthy,
  RERUN_INLINE_CATEGORIES,
  RERUN_INLINE_SEVERITIES,
  SEVERITY_ICONS,
  SEVERITY_IDS,
  SEVERITY_LABELS,
  SEVERITY_RANK,
  SEVERITY_TAGS,
  SPECIALIST_CATEGORY_IDS,
} from '../../src/config/taxonomy';

describe('taxonomy derived maps', () => {
  // These literals are the historical hand-written maps from formatter.ts,
  // inline-reviewer.ts, pr-commenter.ts and deduplicator.ts. The derived maps
  // must match them exactly so posted comments render identically.
  it('severity icons match the historical formatter map', () => {
    expect(SEVERITY_ICONS).toEqual({
      critical: '🛑', high: '🔴', medium: '🟡', low: '🟢', nit: '💬',
    });
  });

  it('severity labels match the historical formatter map', () => {
    expect(SEVERITY_LABELS).toEqual({
      critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', nit: 'Nit',
    });
  });

  it('severity tags match the historical inline-reviewer map', () => {
    expect(SEVERITY_TAGS).toEqual({
      critical: '🛑 Critical', high: '🔴 High', medium: '🟡 Medium', low: '🟢 Low', nit: '💬 Nit',
    });
  });

  it('severity ranks match the historical deduplicator map', () => {
    expect(SEVERITY_RANK).toEqual({ critical: 5, high: 4, medium: 3, low: 2, nit: 1 });
  });

  it('category labels match the historical formatter map', () => {
    expect(CATEGORY_LABELS).toEqual({
      'security': '🔒 Security',
      'code-quality': '📝 Code Quality',
      'performance': '⚡ Performance',
      'type-safety': '🔍 Type Safety',
      'architecture': '🏗️ Architecture',
      'testing': '🧪 Testing',
      'api-design': '🔌 API Design',
      'documentation': '📚 Documentation',
      'comprehensive': '🔎 Comprehensive',
    });
  });

  it('agent labels match the historical pr-commenter map', () => {
    expect(AGENT_LABELS).toEqual({
      'security': '🔒 Security',
      'code-quality': '📝 Code Quality',
      'performance': '⚡ Performance',
      'type-safety': '🔍 Type Safety',
      'architecture': '🏗️ Architecture',
      'testing': '🧪 Testing',
      'api-design': '🔌 API Design',
      'documentation': '📚 Documentation',
      'comprehensive': '🔎 Comprehensive Review',
    });
  });

  it('specialist categories exclude comprehensive', () => {
    expect(SPECIALIST_CATEGORY_IDS).toHaveLength(CATEGORY_IDS.length - 1);
    expect(SPECIALIST_CATEGORY_IDS).not.toContain('comprehensive');
  });

  it('first-run inline severities cover every severity (exhaustive first pass)', () => {
    expect([...INLINE_SEVERITIES].sort()).toEqual([...SEVERITY_IDS].sort());
  });

  it('re-run inline severities are exactly critical/high and a subset of the first-run set', () => {
    expect([...RERUN_INLINE_SEVERITIES].sort()).toEqual(['critical', 'high']);
    for (const severity of RERUN_INLINE_SEVERITIES) {
      expect(INLINE_SEVERITIES.has(severity)).toBe(true);
    }
  });

  it('isInlineWorthy: first run inlines every severity', () => {
    for (const severity of SEVERITY_IDS) {
      expect(isInlineWorthy({ severity, category: 'code-quality' }, false)).toBe(true);
    }
  });

  it('isInlineWorthy: re-runs inline critical/high only, except documentation findings', () => {
    expect(isInlineWorthy({ severity: 'critical', category: 'security' }, true)).toBe(true);
    expect(isInlineWorthy({ severity: 'high', category: 'code-quality' }, true)).toBe(true);
    expect(isInlineWorthy({ severity: 'medium', category: 'code-quality' }, true)).toBe(false);
    expect(isInlineWorthy({ severity: 'low', category: 'code-quality' }, true)).toBe(false);
    // Documentation suggestions are always low but must keep landing inline.
    expect(isInlineWorthy({ severity: 'low', category: 'documentation' }, true)).toBe(true);
    expect(RERUN_INLINE_CATEGORIES.has('documentation')).toBe(true);
  });
});

describe('coercion', () => {
  it('coerces unknown severities to medium', () => {
    expect(coerceSeverity('critical')).toBe('critical');
    expect(coerceSeverity('blocker')).toBe('medium');
    expect(coerceSeverity(undefined)).toBe('medium');
  });

  it('coerces unknown categories to the fallback', () => {
    expect(coerceCategory('security')).toBe('security');
    expect(coerceCategory('nonsense')).toBe('code-quality');
    expect(coerceCategory('nonsense', 'testing')).toBe('testing');
    // 'comprehensive' is an agent identity, not a finding category
    expect(coerceCategory('comprehensive')).toBe('code-quality');
  });

  it('coerces a raw finding with defaults and both code-suggestion spellings', () => {
    const finding = coerceFinding(
      { severity: 'high', category: 'security', file: 'a.ts', line: 3, end_line: 5, title: 'T', description: 'D', code_suggestion: 'x' },
      raw => coerceCategory(raw),
    );
    expect(finding).toEqual({
      severity: 'high', category: 'security', file: 'a.ts', line: 3, endLine: 5,
      title: 'T', description: 'D', suggestion: undefined, codeSuggestion: 'x',
    });

    const sparse = coerceFinding({}, () => 'testing');
    expect(sparse.severity).toBe('medium');
    expect(sparse.category).toBe('testing');
    expect(sparse.file).toBe('');
    expect(sparse.line).toBe(0);
    expect(sparse.title).toBe('Untitled finding');

    const camel = coerceFinding({ codeSuggestion: 'y' }, () => 'testing');
    expect(camel.codeSuggestion).toBe('y');
  });
});
