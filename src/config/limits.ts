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
 * How many times a HUNG pre-flight probe (no first token within
 * PREFLIGHT_TIMEOUT_MS) is retried before the run is failed. Fair-usage
 * throttling (z.ai code 1313) sometimes stalls connections instead of
 * returning a clean 429 — observed in production right after a string of
 * 429s, proving the endpoint was alive. Unlike 429s (cheap, patient budget of
 * RATE_LIMIT_MAX_ATTEMPTS), each hang costs a full probe timeout, so this
 * budget is small: 6 retries ≈ 8 minutes worst case on a truly dead endpoint.
 */
export const PREFLIGHT_HANG_MAX_RETRIES = 6;

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

/**
 * Rate limits (429) get their own patient retry budget, independent of
 * max_retries: quota churn on shared endpoints clears in seconds-to-minutes,
 * and a long wait beats failing the whole review run. 400 × 10s ≈ 67 min of
 * waiting worst case; the GitHub job timeout is the effective backstop.
 */
export const RATE_LIMIT_MAX_ATTEMPTS = 400;

/**
 * First wait between 429 retries. Later waits ESCALATE (see
 * RATE_LIMIT_DELAY_GROWTH): fair-usage limiters punish request FREQUENCY, so
 * retrying on a fixed short cadence can keep re-tripping the very limit being
 * waited out. A server-sent Retry-After always takes precedence.
 */
export const RATE_LIMIT_RETRY_DELAY_MS = 10000;

/** Growth factor per consecutive 429 retry (10s → 15s → 22s → …). */
export const RATE_LIMIT_DELAY_GROWTH = 1.5;

/** Ceiling for one escalated 429 wait — polling every 2 min is patient AND polite. */
export const RATE_LIMIT_RETRY_DELAY_MAX_MS = 120000;

/**
 * Total 429 waiting budget per call. Observed in production: z.ai fair-usage
 * (code 1313) spells can outlast a full hour, and failing the run then wastes
 * the wait already invested — so this sits just under GitHub's 6h job hard
 * limit, leaving room to fail with a clean report (comment, outputs,
 * Backstage) instead of being killed mid-flight by the runner.
 */
export const RATE_LIMIT_MAX_TOTAL_WAIT_MS = 5 * 60 * 60 * 1000;

/** Transient-error backoff base: 2s, 4s, 8s, … (exponential per attempt). */
export const TRANSIENT_BACKOFF_BASE_MS = 1000;

/** Retries for the cosmetic Mermaid generation (1 fix-it retry keeps diagrams cheap). */
export const DIAGRAM_MAX_RETRIES = 1;

// ─── Prompt truncation ──────────────────────────────────────────────────────

/** Fallback per-file content cap used by the LOWER trim stages, in chars.
 *  Stage 0 is uncapped: a carefully-reviewed file is a complete file. */
export const PROMPT_MAX_FILE_CHARS = 10000;

/**
 * Progressive trim stages for fitting the prompt into the context window:
 * full fidelity (uncapped files) → shrink per-file content → drop related
 * files → shrink further. Stage 0 is the only stage a review should normally
 * use; anything lower is logged loudly. (Related files arrive rank-sorted, so
 * a maxDepFiles cap keeps the most valuable ones.)
 */
export const PROMPT_TRIM_STAGES: ReadonlyArray<{ maxDepFiles?: number; maxFileChars?: number }> = [
  { maxFileChars: Number.POSITIVE_INFINITY },
  { maxFileChars: 25000 },
  {},
  { maxDepFiles: 8 },
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

/** Thinking-stream snippet kept for debugging when a call produces no findings text. */
export const THINKING_SNIPPET_CHARS = 800;

/**
 * When a response stops at max_tokens without parseable findings JSON (either
 * runaway thinking ate the whole budget — GLM can ignore budget_tokens — or a
 * big PR's findings genuinely need more room), the call is retried with
 * thinking disabled and the output budget multiplied by this factor, escalating
 * per retry. A user's review must never fail because OUR output cap was too small.
 */
export const TRUNCATION_RETRY_TOKENS_MULTIPLIER = 2;

/** Max escalation retries after max_tokens truncation (16k → 32k → 64k → 128k). */
export const TRUNCATION_RETRY_MAX_ESCALATIONS = 3;

/**
 * The model's full native output capacity assumed in auto mode (max_tokens: 0)
 * — GLM-5.x's documented 128K maximum. Endpoints with a smaller real cap
 * reject with a 400 that states their maximum; the provider parses it, latches
 * the discovered cap per model, and retries (see parseOutputCapError), so this
 * value never has to be exactly right for any given model.
 */
export const OUTPUT_TOKENS_CEILING = 131072;

/**
 * Input-budget reservation divisor in auto output mode: reserve
 * min(OUTPUT_TOKENS_CEILING, contextWindow / this) for output when trimming
 * the prompt, so small-window models keep most of their window for input.
 */
export const AUTO_OUTPUT_RESERVATION_DIVISOR = 4;

/**
 * Cost backstop for auto-batching: a PR too big for even this many
 * full-fidelity review calls falls back to the trim stages (with a loud
 * warning) instead of unbounded spend.
 */
export const MAX_REVIEW_BATCHES = 10;

/** Bounded retries after an endpoint rejects max_tokens as above its real cap. */
export const OUTPUT_CAP_CLAMP_RETRIES = 2;

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

/**
 * How often the run polls the PR's open/closed state so a review of a
 * closed/merged PR is cancelled promptly without burning API quota.
 */
export const PR_STATE_POLL_INTERVAL_MS = 30000;

/** Max comments fetched per review thread. */
export const THREAD_COMMENTS_PAGE = 30;

/** Max dependency files fetched via the legacy probing fallback (tree unavailable). */
export const MAX_DEP_FILES = 10;

/** Max sub-packages scanned for framework detection in a monorepo. */
export const MONOREPO_SCAN_LIMIT = 3;

// ─── Related-context retrieval (tree-based) ─────────────────────────────────

/** Max related (imported/framework-sibling) files included as review context.
 *  Higher than the legacy 10: tree-based resolution is precise and pre-ranked,
 *  and RELATED_TOTAL_MAX_CHARS bounds the aggregate cost. */
export const RELATED_FILES_MAX = 24;

/** Aggregate char budget across all related files (~25k tokens at 4 chars/tok). */
export const RELATED_TOTAL_MAX_CHARS = 100_000;

/** Blob-size ceiling for a related file; larger files (bundles, generated code) are skipped pre-fetch. */
export const RELATED_FILE_MAX_BYTES = 200_000;

/** Max tsconfig files fetched per run (nearest per changed dir + root app/base configs). */
export const TSCONFIG_FETCH_MAX = 6;

/** Max workspace package.json fetches when mapping package names to directories. */
export const WORKSPACE_PKG_FETCH_MAX = 8;

/** Barrel (index.ts) re-export chains are followed at most this deep (visited set breaks cycles). */
export const BARREL_FOLLOW_DEPTH = 2;

/** Minimum re-export targets resolvable per barrel import; the effective cap
 *  scales up with the import's symbol count (see BARREL_TARGETS_HARD_CAP). */
export const BARREL_MAX_TARGETS = 4;

/** Absolute ceiling on targets expanded from one barrel import, however many
 *  symbols it names (keeps an `import { …20 things }` from flooding candidates). */
export const BARREL_TARGETS_HARD_CAP = 16;

/** Ranking weight per related-file kind: types/models teach the reviewer the most per token. */
export const RELATED_KIND_WEIGHT: Readonly<Record<string, number>> = {
  model: 5,
  service: 4,
  module: 3,
  template: 2,
  stylesheet: 1,
  other: 3,
};

/** Max changed files drawn in the import-graph architecture diagram. */
export const ARCH_DIAGRAM_MAX_FILES = 20;

// ─── Related-context retrieval (local clone + TypeScript compiler) ──────────

/** Ceiling for every git subprocess in local-repo acquisition. A shallow
 *  single-commit fetch of any sane repo finishes well under this; beyond it
 *  we fall back to the API engine rather than stall the review. */
export const GIT_ACQUIRE_TIMEOUT_MS = 120_000;

/** stdout buffer ceiling for git subprocesses (`git ls-files` on a 100k-file
 *  monorepo is still only a few MB; 64 MB never truncates a legitimate repo). */
export const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Partial-clone blob filter: blobs above this are never sent to the model
 *  (RELATED_FILE_MAX_BYTES is far smaller), so skip downloading them. */
export const LOCAL_CLONE_BLOB_LIMIT = '10m';

/** Memory ceiling for compiler analysis on 15k-file monorepos: source files
 *  materialized across all ts-morph projects. One-hop import context never
 *  legitimately needs more; past it, barrel expansion degrades gracefully. */
export const TS_PROJECT_MAX_LOADED_FILES = 400;

/** Related files at or under this size are sent whole — small files teach
 *  more complete than stripped, and stripping them saves almost nothing. */
export const SKELETON_FULL_FILE_MAX_CHARS = 3000;

/** Function/method bodies shorter than this survive skeletonization:
 *  stripping tiny bodies saves no tokens and costs fidelity. */
export const SKELETON_BODY_MIN_CHARS = 120;

/** Max changed exported symbols used to seed the caller search; hunks rarely
 *  touch more exported API than this in one PR file. */
export const CALLER_SEED_SYMBOLS_MAX = 12;

/** Max files the `git grep` caller prescreen may return before we stop —
 *  a symbol matched in more files than this is too generic to be useful. */
export const CALLER_SCAN_MAX_FILES = 200;

/** Max caller files added as review context. Callers are skeletons with only
 *  the calling bodies kept, so each is cheap; more than this adds noise. */
export const CALLERS_MAX_FILES = 6;

// ─── Context tool loop (bounded agentic retrieval) ──────────────────────────
// This is a GitHub Action: tool use is a bounded escape hatch for context the
// deterministic engine missed, NOT an open agent loop. Every extra round is
// one more AI call against a throttling-prone endpoint, so the bounds are
// deliberately tiny and the prompt tells the model to batch its lookups.

/** Max tool ROUNDS per review call in combined mode (each round = 1 extra AI
 *  call; the model is told to batch independent lookups into one round). */
export const TOOL_LOOP_MAX_ROUNDS = 2;

/** Max tool rounds per review call in separate mode: 7 agents share the run,
 *  so each gets a single round to fill its one most important gap. */
export const TOOL_LOOP_MAX_ROUNDS_SEPARATE = 1;

/** Max individual tool calls per review call (across its rounds). */
export const TOOL_LOOP_MAX_CALLS_PER_REVIEW = 6;

/** Run-wide tool-call budget shared by ALL agents and batches — the hard
 *  ceiling on how much agentic retrieval one review run can spend. */
export const TOOL_CALLS_RUN_BUDGET = 12;

/** Char cap per tool result (a read_file slice or grep listing; ~2k tokens). */
export const TOOL_RESULT_MAX_CHARS = 8000;

/** Max grep matches returned to the model — beyond this the pattern is too
 *  generic to be review context. */
export const TOOL_GREP_MAX_MATCHES = 50;

/** Max entries returned by the list_dir tool. */
export const TOOL_LIST_DIR_MAX_ENTRIES = 200;

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
