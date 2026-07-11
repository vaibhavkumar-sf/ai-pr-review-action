# Architecture Overhaul — Refactor Plan (executed)

> This is the plan that drove the `refactor/world-class-architecture` branch.
> The resulting architecture is documented in [architecture.md](architecture.md).

## Context

The action worked, but its architecture had real debt that caused production bugs
twice (the action.yml-shadows-code-defaults trap). Goal: **world-class architecture
in minimum, manageable code** — single source of truth for every config value and
default, all prompts externalized, industry-standard Action logging, fail-safe
phases, security best practices, and future-proof model support (any
OpenAI-compatible endpoint, multi-agent preserved). All existing functionality and
the actual review prompts preserved.

Audit findings that drove the design:

- Every default duplicated in `action.yml` + `defaults.ts`; action.yml silently
  shadowed code (2 live mismatches: `comment_header`, `comment_footer`).
- ~50 magic numbers scattered across 15 files; `THINKING_BUDGET_TOKENS = 8192` in
  base-agent out of sync with the real default 4096.
- Half the prompt surface hardcoded in `.ts` (global rules, user contract,
  consolidation, PR-description, mermaid, reply-verdict, JSON-repair); only the
  review criteria lived in `prompts/`.
- Severity/category maps encoded 5+ times; duplicated mermaid sanitizers, import
  extractors, finding coercion ×3, GraphQL thread queries ×2, retry loops ×2.
- Dead code: `MODERN_PROMPT` (~108 lines), `mermaidToImageUrl`, unused logger
  exports, dead progress branch.
- Wiring bugs: `INPUT_ENABLE_DIAGRAMS` missing from the action.yml env block
  (the input was silently ignored), `pr_number` read but undeclared.
- No `::group::` phases, no `GITHUB_STEP_SUMMARY`, no `core.setSecret`, logger
  inconsistently used, zero tests.

## Non-negotiables

1. **Zero behavior change for existing consumers by default.** The z.ai Anthropic
   path (model chain, streaming, heartbeat, thinking=4096, preflight, retry,
   timeout=600) behaves identically. Effective defaults = the previous
   action.yml values.
2. **All 10 `prompts/*.md` review-criteria files preserved byte-for-byte.**
   Inline meta-prompt text moved verbatim.
3. **Net-negative src LOC** even after adding the OpenAI provider.
4. Build green (tsc + lint + tests + docker build).

## Key mechanisms

### 1. Config SSOT — generated action.yml

`src/config/schema.ts` declares every input once. `scripts/gen-action.ts` renders
the `inputs:` and `runs.env:` blocks of `action.yml` from it. `npm run
check:action` diffs regenerated vs committed and is wired into `prebuild` — the
shadowing trap is structurally impossible now. Fixes for free: the missing
`INPUT_ENABLE_DIAGRAMS` env line, the undeclared `pr_number` input.
`src/config/inputs.ts` collects ALL validation errors into one batched Error.

### 2. Provider abstraction (any-model future-proofing)

`base-provider.ts` extracts the hard-won reliability logic verbatim from the
Anthropic provider (chain latching, retry schedule, heartbeat, timeout
diagnostics, preflight) behind abstract hooks. `anthropic` stays the default —
zero workflow changes for consumers. `openai.provider.ts` adds an
OpenAI-compatible dialect: raw fetch, SSE streaming, `stream_options.include_usage`,
`delta.reasoning_content|reasoning` → thinking observer, best-effort `thinking`
vendor extension with graceful strip. Selected via the new `ai_provider` input.

### 3. Prompts layer

All inline meta-prompt text moved **byte-for-byte** into `prompts/system/*.md`;
dynamic parts stay in code via `{{var}}` substitution (loader throws on
unresolved placeholders — fail loud).

### 4. Logging / observability

Every phase wrapped in `core.startGroup('▶ Phase')`/`endGroup` with duration;
`core.setSecret()` on all schema `secret: true` inputs at startup; final
`GITHUB_STEP_SUMMARY` job-summary; `core.warning` annotations for degraded phases.

### 5. Fail-safety policy

`runPhase(name, {critical}, fn, fallback)`: **critical** = pre-flight, context,
agents, summary comment → throw/setFailed. **Best-effort** = bot cleanup, replies,
stale resolve, inline comments, metrics, description, diagrams, Backstage, job
summary → warn + continue. Backstage telemetry became always-report: when
`post_data_url` is set, skip/failure paths also POST (`status: skipped|failed`),
fire-and-forget with a 10s timeout.

### 6. Taxonomy + limits

`taxonomy.ts`: severities/categories as const arrays with derived types and ALL
label/icon/rank maps plus a single `coerceFinding()`. `limits.ts`: every magic
number named with a one-line rationale.

## Migration order (as executed)

1. **Scaffolding (no behavior change):** limits, taxonomy, patterns,
   utils/mermaid, utils/imports, github/threads, prompt loader +
   `prompts/system/*.md` (byte-for-byte extraction); jest activated; formatter
   output snapshot-locked.
2. **Consumers switched to shared modules;** dead code deleted.
3. **Config SSOT:** schema + gen-action + inputs; action.yml generated and
   hand-reviewed; defaults.ts/action-inputs.ts deleted; check:action wired in.
4. **Provider split:** base-provider extracted, openai.provider added,
   `ai_provider` input + factory switch.
5. **Agents:** data-driven `specialists.ts` replaced 7 stub files.
6. **Pipeline:** phase.ts + description-updater; orchestrator rewritten as a
   phase list; logger rewrite + setSecret + job summary; Backstage always-report.
7. **Tests completion:** provider unit tests + full-pipeline integration test.
8. **Docs:** architecture.md rewritten; CLAUDE.md, README, examples updated.

## Bugs fixed en route

1. `INPUT_ENABLE_DIAGRAMS` missing from the action.yml env block (input silently ignored).
2. `pr_number` undeclared in action.yml.
3. `comment_header`/`comment_footer` canonicalized to the effective values.
4. Stale `THINKING_BUDGET_TOKENS = 8192` → the configured value is used for output reservation.
5. Provider hard fallback `['claude-opus-4-8']` → schema default chain.
6. `GITHUB_RUN_ID/NUMBER` reads moved into the config layer.
7. reply-handler's naive `indexOf('{')` JSON parse → shared `extractJsonObject`.
8. Mermaid sanitizer's pipe-in-quotes regex corrupted valid `-->|"Yes"| C["Done"]` edges.
9. Thinking-unsupported fallback previously re-sent thinking on the retry.
10. Bot-login matching regex was unanchored (false-positive risk).
