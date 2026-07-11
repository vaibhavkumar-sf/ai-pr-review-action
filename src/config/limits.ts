/**
 * Every tunable constant in the action, in one place.
 *
 * Rule: no magic numbers in feature code. If a number controls a timeout, a
 * budget, a threshold, or a truncation, it lives here with a one-line rationale.
 * User-facing settings (model, tokens, timeouts a consumer may override) are
 * NOT here — those are action inputs declared in src/config/schema.ts.
 */

// ─── Token budgeting ────────────────────────────────────────────────────────

/** Rough char→token estimate for prompt budgeting — ~4 chars/token for code + English prose. */
export const CHARS_PER_TOKEN = 4;

/**
 * Headroom for message framing and estimator error, on top of the measured
 * system prompt, when trimming the user prompt to the model context window.
 */
export const CONTEXT_SAFETY_MARGIN_TOKENS = 6000;

/** Input budget for the compact fallback prompt used after a context-window rejection. */
export const COMPACT_INPUT_TOKENS = 50000;

/**
 * Combined mode returns ONE large findings array; a truncated JSON response
 * loses everything, so max_tokens is floored at this value in combined mode.
 */
export const COMBINED_MAX_TOKENS_FLOOR = 16384;

/** max_tokens for the cosmetic PR-description call (formatting, not analysis). */
export const DESCRIPTION_MAX_TOKENS = 4096;

/** max_tokens for the AI consolidation pass (returns the merged findings array). */
export const CONSOLIDATION_MAX_TOKENS = 8192;

/** max_tokens for a reply-thread verdict (a short JSON with a 2-5 sentence reply). */
export const REPLY_VERDICT_MAX_TOKENS = 2048;

/** max_tokens for the cosmetic Mermaid-diagram call. */
export const DIAGRAM_MAX_TOKENS = 4096;

/** The Anthropic API rejects thinking budgets below this floor. */
export const THINKING_FLOOR_TOKENS = 1024;

/** Output tokens for the pre-flight probe — just enough for a one-word answer. */
export const PREFLIGHT_MAX_TOKENS = 16;

// ─── Temperatures ───────────────────────────────────────────────────────────

/** Near-deterministic merging for the consolidation pass. */
export const CONSOLIDATION_TEMPERATURE = 0.1;

/** Slightly creative for prose/diagram writing (PR description, Mermaid). */
export const COSMETIC_TEMPERATURE = 0.3;

/** Deterministic pre-flight probe. */
export const PREFLIGHT_TEMPERATURE = 0;

// ─── Timeouts (ms) ──────────────────────────────────────────────────────────

/**
 * How often to emit a progress heartbeat while awaiting a streamed response, so
 * a long-running model call is visibly alive in the Action log instead of silent.
 */
export const HEARTBEAT_INTERVAL_MS = 20000;

/**
 * Timeout for the pre-flight probe. A healthy endpoint answers a 16-token
 * request in a few seconds; if it hangs past this, fail fast instead of wasting
 * the full agent_timeout later. Kept short on purpose.
 */
export const PREFLIGHT_TIMEOUT_MS = 45000;

/**
 * Timeout for cosmetic calls (PR description, diagrams) — bounded so they never
 * dominate the run; they are best-effort and fall back to static content.
 */
export const COSMETIC_CALL_TIMEOUT_MS = 120000;

/** Timeout for the Kroki.io Mermaid validation request. */
export const KROKI_TIMEOUT_MS = 10000;

/** Timeout for the fire-and-forget Backstage report POST. */
export const BACKSTAGE_TIMEOUT_MS = 10000;

// ─── Retries & backoff ──────────────────────────────────────────────────────

/** HTTP statuses worth retrying: 429=rate limit, 5xx=transient, 529=overloaded. */
export const RETRYABLE_HTTP_STATUS = [429, 500, 502, 503, 529];

/** Rate-limit (429) backoff step: 30s, 60s, 90s, … per attempt (unless Retry-After says otherwise). */
export const RATE_LIMIT_BACKOFF_STEP_MS = 30000;

/** Transient-error backoff base: 2s, 4s, 8s, … (exponential per attempt). */
export const TRANSIENT_BACKOFF_BASE_MS = 1000;

/** Retries for the cosmetic Mermaid generation (1 fix-it retry keeps diagrams cheap). */
export const DIAGRAM_MAX_RETRIES = 1;

// ─── Prompt truncation ──────────────────────────────────────────────────────

/** Default per-file content cap in the review prompt, in chars. */
export const PROMPT_MAX_FILE_CHARS = 10000;

/**
 * Progressive trim stages for fitting the prompt into the context window:
 * full → drop dependency files → shrink per-file content.
 */
export const PROMPT_TRIM_STAGES: ReadonlyArray<{ maxDepFiles?: number; maxFileChars?: number }> = [
  {},
  { maxDepFiles: 0 },
  { maxDepFiles: 0, maxFileChars: 5000 },
  { maxDepFiles: 0, maxFileChars: 2500 },
  { maxDepFiles: 0, maxFileChars: 1200 },
];

/** Hard-clamp floor (tokens) so the budgeted prompt is never clamped to nothing. */
export const PROMPT_CLAMP_FLOOR_TOKENS = 2000;

/** Per-file content cap for the cosmetic PR-description prompt, in chars. */
export const DESCRIPTION_FILE_CHARS = 5000;

/** Dependency-file content cap, in chars (avoids token bloat from large deps). */
export const DEP_FILE_MAX_CHARS = 5000;

/** Diff cap for the cosmetic diagram prompt, in chars. */
export const DIAGRAM_DIFF_CHARS = 4000;

/** Code context sent for a reply-thread verdict: ± this many lines around the comment. */
export const REPLY_CODE_CONTEXT_LINES = 60;

/** Unparseable-response snippet length in warnings, in chars. */
export const ERROR_SNIPPET_CHARS = 300;

// ─── Deduplication & thread matching ────────────────────────────────────────

/** Findings within this many lines of each other are dedup candidates. */
export const DEDUP_LINE_PROXIMITY = 2;

/** Levenshtein title similarity at or above this ratio marks a duplicate. */
export const DEDUP_LEVENSHTEIN_MIN = 0.65;

/** Jaccard keyword overlap at or above this ratio marks a duplicate. */
export const DEDUP_JACCARD_MIN = 0.5;

/** AI consolidation is skipped at or below this many findings (too few to have duplicates). */
export const CONSOLIDATION_SKIP_THRESHOLD = 3;

/** An existing inline comment within this many lines makes a new one a duplicate. */
export const INLINE_DUPLICATE_PROXIMITY = 2;

/** How far (± lines) to search for a diff line when the AI's line number misses the diff. */
export const INLINE_NEARBY_SEARCH_RANGE = 3;

/** A previous inline thread within this many lines of a current finding is still relevant. */
export const STALE_THREAD_PROXIMITY = 3;

// ─── GitHub & context gathering ─────────────────────────────────────────────

/** Page size for GitHub REST/GraphQL list calls. */
export const GITHUB_PER_PAGE = 100;

/** Max comments fetched per review thread. */
export const THREAD_COMMENTS_PAGE = 30;

/** Max dependency files fetched for review context. */
export const MAX_DEP_FILES = 10;

/** Max sub-packages scanned for framework detection in a monorepo. */
export const MONOREPO_SCAN_LIMIT = 3;

/** Max changed files drawn in the import-graph architecture diagram. */
export const ARCH_DIAGRAM_MAX_FILES = 20;

// ─── Formatting ─────────────────────────────────────────────────────────────

/** Description column cap in the Critical & High issues table, in chars. */
export const TABLE_DESCRIPTION_CHARS = 120;

/** Agents scoring at or above this (with a summary) are listed as strengths. */
export const STRENGTHS_MIN_SCORE = 8;

/** Fallback agent score when the model omits one. */
export const DEFAULT_AGENT_SCORE = 5;

// ─── External endpoints ─────────────────────────────────────────────────────

/** Kroki.io Mermaid renderer, used to VALIDATE diagrams before posting (not to render). */
export const KROKI_MERMAID_URL = 'https://kroki.io/mermaid/svg';
