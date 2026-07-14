import type { Finding } from '../types';

/**
 * The single source of truth for severities and review categories.
 *
 * Every label, icon, rank, and validation set in the codebase is DERIVED from
 * these two tables — never hand-write a severity/category map anywhere else.
 * (Before this module existed the same maps were encoded independently in five
 * different files and drifted.)
 */

export const SEVERITIES = [
  { id: 'critical', label: 'Critical', icon: '🛑', rank: 5 },
  { id: 'high', label: 'High', icon: '🔴', rank: 4 },
  { id: 'medium', label: 'Medium', icon: '🟡', rank: 3 },
  { id: 'low', label: 'Low', icon: '🟢', rank: 2 },
  { id: 'nit', label: 'Nit', icon: '💬', rank: 1 },
] as const;

export const CATEGORIES = [
  { id: 'security', label: '🔒 Security', agentLabel: '🔒 Security' },
  { id: 'code-quality', label: '📝 Code Quality', agentLabel: '📝 Code Quality' },
  { id: 'performance', label: '⚡ Performance', agentLabel: '⚡ Performance' },
  { id: 'type-safety', label: '🔍 Type Safety', agentLabel: '🔍 Type Safety' },
  { id: 'architecture', label: '🏗️ Architecture', agentLabel: '🏗️ Architecture' },
  { id: 'testing', label: '🧪 Testing', agentLabel: '🧪 Testing' },
  { id: 'api-design', label: '🔌 API Design', agentLabel: '🔌 API Design' },
  { id: 'documentation', label: '📚 Documentation', agentLabel: '📚 Documentation' },
  { id: 'comprehensive', label: '🔎 Comprehensive', agentLabel: '🔎 Comprehensive Review' },
] as const;

/** Derived union types — re-exported by src/types.ts for general use. */
export type Severity = (typeof SEVERITIES)[number]['id'];
export type ReviewCategory = (typeof CATEGORIES)[number]['id'];

// ─── Derived lookups (never hand-write these elsewhere) ─────────────────────

export const SEVERITY_IDS = SEVERITIES.map(s => s.id) as readonly Severity[];

/** Severity → emoji icon (summary tables). */
export const SEVERITY_ICONS = Object.fromEntries(
  SEVERITIES.map(s => [s.id, s.icon]),
) as Record<Severity, string>;

/** Severity → display label. */
export const SEVERITY_LABELS = Object.fromEntries(
  SEVERITIES.map(s => [s.id, s.label]),
) as Record<Severity, string>;

/** Severity → "icon label" tag (inline comments). */
export const SEVERITY_TAGS = Object.fromEntries(
  SEVERITIES.map(s => [s.id, `${s.icon} ${s.label}`]),
) as Record<Severity, string>;

/** Severity → rank; higher rank wins when merging duplicate findings. */
export const SEVERITY_RANK = Object.fromEntries(
  SEVERITIES.map(s => [s.id, s.rank]),
) as Record<Severity, number>;

export const VALID_SEVERITIES = new Set<string>(SEVERITY_IDS);

export const CATEGORY_IDS = CATEGORIES.map(c => c.id) as readonly ReviewCategory[];

/** Category → display label (findings-by-category tables). */
export const CATEGORY_LABELS = Object.fromEntries(
  CATEGORIES.map(c => [c.id, c.label]),
) as Record<ReviewCategory, string>;

/** Category → agent display label (progress table). */
export const AGENT_LABELS = Object.fromEntries(
  CATEGORIES.map(c => [c.id, c.agentLabel]),
) as Record<ReviewCategory, string>;

/**
 * The categories a finding may carry. 'comprehensive' is an agent identity,
 * not a finding category — combined-mode findings keep their real category.
 */
export const SPECIALIST_CATEGORY_IDS = CATEGORY_IDS.filter(
  c => c !== 'comprehensive',
) as readonly ReviewCategory[];

export const VALID_FINDING_CATEGORIES = new Set<string>(SPECIALIST_CATEGORY_IDS);

/**
 * Severities that get inline PR comments on a FIRST run: all of them. The
 * first review is the exhaustive one — every finding (including low-severity
 * documentation suggestions) lands as an inline comment with its suggestion.
 * Noise control lives in RERUN_INLINE_SEVERITIES, not here.
 */
export const INLINE_SEVERITIES: ReadonlySet<Severity> = new Set(SEVERITY_IDS);

/**
 * Re-runs only inline-comment the severities a developer MUST act on. New
 * medium/low/nit findings on a re-run stay in the summary tables — posting
 * them inline created an endless fix→push→new-comments loop.
 */
export const RERUN_INLINE_SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'high']);

/**
 * Categories that keep inline-commenting on re-runs regardless of severity.
 * Documentation findings are always low but carry paste-ready suggestions the
 * developer applies from the inline comment, so they must keep appearing for
 * functions added after the first review. Fingerprint dedup in InlineReviewer
 * stops previously-posted ones from reposting, so this cannot loop.
 */
export const RERUN_INLINE_CATEGORIES: ReadonlySet<ReviewCategory> = new Set(['documentation']);

/**
 * The inline-comment gate for one finding. First runs inline everything; on
 * re-runs only critical/high findings — plus documentation suggestions — get
 * NEW inline comments.
 */
export function isInlineWorthy(
  finding: Pick<Finding, 'severity' | 'category'>,
  isRerun: boolean,
): boolean {
  if (!isRerun) return INLINE_SEVERITIES.has(finding.severity);
  return RERUN_INLINE_SEVERITIES.has(finding.severity) || RERUN_INLINE_CATEGORIES.has(finding.category);
}

// ─── Finding coercion (the ONE place raw model output becomes a Finding) ────

/** Validates a raw severity, falling back to 'medium' for anything unknown. */
export function coerceSeverity(raw: unknown): Severity {
  return VALID_SEVERITIES.has(raw as string) ? (raw as Severity) : 'medium';
}

/** Validates a raw finding category, falling back when unknown. */
export function coerceCategory(raw: unknown, fallback: ReviewCategory = 'code-quality'): ReviewCategory {
  return VALID_FINDING_CATEGORIES.has(raw as string) ? (raw as ReviewCategory) : fallback;
}

/**
 * Coerces one raw model-response object into a validated Finding.
 * `resolveCategory` lets the caller own category semantics: specialist agents
 * force their own category, the comprehensive agent and the consolidation pass
 * validate the per-finding category the model assigned.
 */
export function coerceFinding(
  raw: Record<string, unknown>,
  resolveCategory: (rawCategory: unknown) => ReviewCategory,
): Finding {
  return {
    severity: coerceSeverity(raw.severity),
    category: resolveCategory(raw.category),
    file: (raw.file as string) || '',
    line: (raw.line as number) || 0,
    endLine: (raw.endLine ?? raw.end_line) as number | undefined,
    title: (raw.title as string) || 'Untitled finding',
    description: (raw.description as string) || '',
    suggestion: raw.suggestion as string | undefined,
    codeSuggestion: (raw.code_suggestion ?? raw.codeSuggestion) as string | undefined,
  };
}
