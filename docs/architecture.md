# Architecture

AI PR Review Action — a Docker-based GitHub Action that reviews pull requests
with one or more AI agents, posts a structured summary comment plus inline
annotations, maintains review threads across runs, and optionally reports
telemetry to a Backstage tracker.

This document is the map of how the codebase is organized, the rules that keep
it consistent, and the recipes for extending it. The plan that produced this
architecture is preserved in [refactor-plan.md](refactor-plan.md).

## Design principles

1. **Single source of truth for everything.** Every input, default, tunable,
   severity, category, and prompt lives in exactly one place. Derived artifacts
   (`action.yml`, icon maps, agent lists) are generated or computed from the
   source, never hand-maintained in parallel.
2. **Fail-safe by policy, not by accident.** Every pipeline phase is declared
   `critical` or best-effort. A best-effort failure warns and continues; only a
   critical failure can fail the run — and even then the failure is reported
   (comment + outputs + Backstage) before the action exits.
3. **Provider-agnostic core.** The review pipeline talks to an `AIProvider`
   interface. Dialect-specific code (Anthropic SDK vs OpenAI-compatible HTTP)
   is confined to thin adapters under `src/providers/`.
4. **Minimum code.** Shared logic exists once (`utils/`, `github/threads.ts`,
   `config/taxonomy.ts`); data-driven constructs replace boilerplate (one
   `specialists.ts` instead of seven agent stub files).

## Module map

```
action.yml                  GENERATED — do not edit by hand (see Config SSOT)
scripts/gen-action.ts       renders action.yml from the schema; --check mode in prebuild/CI
prompts/                    review-criteria prompts (agent behavior)
prompts/system/             meta-prompts (global rules, user contract, consolidation,
                            pr-description, mermaid, mermaid-fix, reply-verdict, json-repair)
src/
  index.ts                  entry: parse inputs → set debug → runReview → setFailed
  types.ts                  shared interfaces (Severity/ReviewCategory re-exported from taxonomy)
  pipeline/
    orchestrator.ts         the review flow as a list of runPhase() calls
    phase.ts                runPhase(name, {critical}, fn, fallback) — grouping, timing, fail-safety
    description-updater.ts  AI PR description + diagrams appended below ----AI-description----
  config/
    schema.ts               INPUT REGISTRY — the SSOT for every action input
    inputs.ts               env → typed ActionConfig; batched validation; secret masking
    limits.ts               every tunable, named, with a one-line rationale
    taxonomy.ts             severities/categories SSOT; all maps derived; coerceFinding()
    patterns.ts             exclude / test-file / bot-hide patterns
    profiles.ts             strict/standard/minimal → enabled specialist set
  prompts/loader.ts         loadPrompt(name, vars): 3-path lookup, {{var}} substitution, cache
  agents/
    base-agent.ts           template method: build prompts → call provider → parse findings
    specialists.ts          the 7 specialist agents, data-driven from taxonomy
    comprehensive.agent.ts  combined-mode single agent (per-finding categories)
  providers/
    ai-provider.ts          the interface the pipeline depends on
    base-provider.ts        shared engine: model-chain fallback+latching, retry/backoff,
                            streaming heartbeat, timeouts, thinking-unsupported fallback
    anthropic.provider.ts   Anthropic SDK dialect (default)
    openai.provider.ts      OpenAI-compatible dialect (raw fetch + SSE)
    provider-factory.ts     dialect switch on the ai_provider input
  github/
    pr-commenter.ts         summary comment lifecycle, bot cleanup, stale-thread resolve
    inline-reviewer.ts      inline review comments (line + side: RIGHT)
    reply-handler.ts        AI verdict on human replies; justification + resolve
    threads.ts              the ONE GraphQL reviewThreads module (fetch/resolve/minimize)
    diff-parser.ts          unified-diff parsing, line→position mapping
  context/
    pr-context.ts           diff, changed files, related-context orchestration
    repo-tree.ts            one recursive Git Trees call → in-memory path index
    ts-paths.ts             tsconfig paths alias resolution (JSONC, extends, scoped)
    workspace-packages.ts   npm-workspace package → directory resolution
    related-files.ts        framework siblings (Angular templates/modules,
                            LB4 DI bindings), barrel re-exports, ranking
    repo-context.ts         framework detection, CLAUDE.md
    jira-context.ts         optional JIRA enrichment (fault-tolerant)
  results/
    deduplicator.ts         programmatic dedup (proximity + Levenshtein/Jaccard)
    consolidation-agent.ts  AI semantic dedup (separate mode)
    merger.ts               severity counts, pass/fail decision
    formatter.ts            findings → summary-comment markdown (snapshot-locked)
    image-diagram-generator.ts  AI Mermaid diagrams for the PR description
    backstage-reporter.ts   telemetry POST (success / skipped / failed)
  utils/
    logger.ts               debug gating + writeJobSummary (feature code logs via @actions/core)
    json.ts                 extractJsonObject
    mermaid.ts              the ONE sanitizer + Kroki validation
    imports.ts              the ONE import extractor (specifiers + named symbols)
    text.ts                 addLineNumbers
tests/
  unit/ integration/ fixtures/
```

## Config SSOT — the generated action.yml

The historical failure mode of this action: a default changed in code but not in
`action.yml` (or vice versa). Docker actions always populate `INPUT_*` env vars
from action.yml defaults, so **action.yml silently wins** — code defaults are
unreachable. This shipped two production bugs.

The fix is structural:

```
src/config/schema.ts  ──(npm run gen:action)──▶  action.yml (inputs + runs.env)
        │
        └─(npm run check:action, wired into prebuild)──▶ build fails on drift
```

- `schema.ts` holds one `InputSpec` per input: name, type, default, description,
  group, `required`, `secret`, enum `values`.
- `scripts/gen-action.ts` renders the `inputs:` block (grouped, commented) and a
  `runs.env` entry `INPUT_<UPPER>: ${{ inputs.<name> }}` for **every** input —
  a forgotten env line (the `enable_diagrams` bug) can no longer happen.
- `inputs.ts` parses env → `ActionConfig`: masks `secret: true` values with
  `core.setSecret` **before** anything can log them, collects all validation
  errors into one batched Error, and falls back to schema defaults on malformed
  optional values (warn, don't crash).

**Rule: to add/change an input, edit `schema.ts` and run `npm run gen:action`.
Never edit `action.yml`.**

## Tunables and taxonomy

- `src/config/limits.ts` — every numeric/behavioral constant (token budgets,
  timeouts, retry schedules, truncation stages, dedup thresholds, page sizes),
  each named with a rationale comment. No magic numbers in feature code.
- `src/config/taxonomy.ts` — `SEVERITIES` and `CATEGORIES` as `const` arrays;
  the `Severity`/`ReviewCategory` types and every icon/label/tag/rank map,
  agent label, and validation set are **derived** from them. `coerceFinding()`
  is the single normalizer for AI-returned findings (alias handling, severity/
  category coercion). Adding a severity or category is a one-array-entry change.

## Prompt architecture

Two layers, both on disk, both shipped in the Docker image (`COPY prompts/`):

| Layer | Location | Purpose |
|---|---|---|
| Review criteria | `prompts/*.md` | what each agent looks for (per-agent + framework additions) |
| Meta-prompts | `prompts/system/*.md` | output contract, consolidation, PR description, mermaid generation/fix, reply verdicts, JSON repair |

`src/prompts/loader.ts` resolves prompts from `/app/prompts` (Docker), then
`cwd/prompts`, then relative to the compiled module; substitutes `{{var}}`
placeholders (throws on unresolved — fail loud); caches file reads.
`loadPrompt` strips exactly one trailing newline; `loadPromptOrEmpty` is
verbatim and returns `''` with a warning when the file is missing (used for
optional framework additions).

## Provider abstraction

```
pipeline ──▶ AIProvider (interface)
                 ▲
          BaseProvider (shared reliability engine)
           ▲                    ▲
 AnthropicProvider        OpenAIProvider
   (SDK dialect)         (fetch + SSE dialect)
```

`BaseProvider` owns the hard-won reliability logic, shared by every dialect:

- **Model-chain fallback + latching**: `anthropic_model` may be a comma-separated
  chain; unknown-model errors advance to the next entry; the first working model
  is latched for the rest of the run (`getResolvedModel()`).
- **Retry/backoff**: rate-limits honor `Retry-After` (else 30s steps); transient
  errors (429/500/502/503/529, network) use exponential backoff; timeouts are
  terminal (a 10-minute agent call should not silently double).
- **Streaming heartbeat**: progress logged every 20s so long calls are visibly alive.
- **Thinking-unsupported fallback**: one-shot retry without extended thinking if
  the endpoint rejects it.
- **Pre-flight** (`verifyConnection`): a tiny probe with a 45s timeout and a
  curl reproduction hint on failure.

Dialects implement only: `streamOnce`, `probe`, `listModels`, `curlHint`, and
the error classifiers. The `ai_provider` input selects the dialect:

| `ai_provider` | Wire protocol | Thinking support | Notes |
|---|---|---|---|
| `anthropic` (default) | Anthropic Messages SDK | `thinking.budget_tokens`; temperature forced to 1 while thinking | identical behavior to pre-refactor consumers |
| `openai` | raw `fetch` SSE to `/chat/completions` | `delta.reasoning_content`/`reasoning` observed; vendor `thinking` extension sent best-effort, stripped on rejection | works with any OpenAI-compatible endpoint (z.ai coding API, OpenRouter, vLLM, …) |

`anthropic_base_url` / `anthropic_auth_token` / `anthropic_model` apply to
whichever dialect is selected (names kept for backward compatibility).

## Pipeline and fail-safety

`src/pipeline/orchestrator.ts` is a flat list of `runPhase()` calls. Each phase
gets a `::group::`-wrapped log section with duration and a declared criticality:

| Phase | Criticality | On failure |
|---|---|---|
| Startup (initial comment, bot cleanup) | best-effort | warn, continue |
| AI pre-flight | gate | error comment, outputs `review_status=failed` + `skip_reason=ai_unreachable`, Backstage `failed`, setFailed |
| Context gathering | critical | failure comment, Backstage `failed`, rethrow |
| Guards (file count, no agents enabled) | gate | outputs `skipped` + `skip_reason`, Backstage `skipped`, clean exit |
| Review agents | critical | rethrow (individual agent failures inside are tolerated via `Promise.allSettled`) |
| Consolidation + merge | critical | rethrow (AI-consolidation failure inside falls back to programmatic dedup) |
| Summary comment | critical | rethrow — a review nobody can see is a failed review |
| Reply handling / inline comments / metrics / description / diagrams | best-effort | warn, continue |
| Outputs, Backstage report, job summary | best-effort | warn, continue |
| Fail threshold (`fail_on_critical` / `fail_on_high`) | — | setFailed by configuration |

A top-level catch in `runReview` guarantees Backstage receives a `failed` report
(with the error reason) for any unhandled critical failure before the action exits.

## Observability standard

- **Grouped logs**: every phase logs `▶ Phase name` … `✓ completed in Ns` inside
  a collapsible group.
- **Secrets**: all `secret: true` inputs are masked via `core.setSecret` at parse
  time — before any log line can leak them. The API key is never logged; only
  its presence.
- **Annotations**: degraded phases emit `core.warning`; hard failures `core.setFailed`.
- **Job summary**: a final `GITHUB_STEP_SUMMARY` panel (verdict, severity counts,
  model, mode, duration) — best-effort.
- **Backstage telemetry**: every run reports when `post_data_url` is set —
  success runs post full metrics + findings; skipped/failed runs post a minimal
  payload with `status` and `skip_reason`. Fire-and-forget, 10s timeout, never
  affects the run outcome.

## Review flow (functional behavior)

1. Post/refresh the fixed progress comment; hide noisy bot comments.
2. Pre-flight the AI endpoint (probe + model-chain resolution).
3. Gather PR + JIRA + repo context in parallel (PR context includes
   related-context retrieval — see the dedicated section below).
4. Run agents: `combined` mode = one ComprehensiveAgent covering every
   dimension; `separate` mode = the profile/toggle-selected specialists in
   parallel.
5. Dedup programmatically → AI consolidation (separate mode) → merge counts.
6. Replace the progress comment with the summary (findings + tracking-metrics
   tables grouped by severity / category / activity; format snapshot-locked).
7. Handle human replies (AI verdict vs current code → justification reply →
   resolve valid ones); resolve stale threads; post new inline comments
   (every severity on first runs, critical/high + documentation suggestions on re-runs, never on test files).
8. Regenerate the AI PR description + Mermaid diagrams below
   `----AI-description----` (user content above the separator is preserved).
9. Set outputs, report to Backstage, write the job summary, apply the fail
   threshold.

## Related-context retrieval

A reviewer needs the unchanged files the changed code depends on. Controlled by
the `related_context` input (`full` default | `imports-only` | `off`), wired in
`pr-context.ts` step 7. Two engines share the ranking/fair-selection helpers in
`related-files.ts`, the budgets, and the `DependencyFile[]` output contract.

### Primary engine: local checkout + TypeScript compiler (`context/local/`)

1. **Local repo acquisition** (`local-repo.ts`): reuse the mounted
   `GITHUB_WORKSPACE` checkout only when its HEAD equals the PR head SHA
   (`actions/checkout` on pull_request checks out the MERGE commit, whose tree
   would desync every line number); otherwise `git fetch --depth 1` of exactly
   the head SHA into a scratch dir (blob-size filtered, token redacted from
   errors, `git.ts` runs git with array args — no shell). Any failure → API
   fallback engine.
2. **File index** (`file-index.ts`): `git ls-files` implements the same
   `RepoTree` interface the API engine uses, so the framework heuristics run
   unchanged.
3. **Compiler-exact imports** (`ts-project.ts`, ts-morph — the tsserver
   engine): one lazy Project per governing tsconfig (monorepo-safe `paths`
   resolution incl. `extends`), imports resolved semantically, barrels followed
   via `getExportedDeclarations()` to the files that actually define the
   imported symbols — no basename heuristics. External packages (no
   node_modules) are skipped; workspace imports fall back to
   `workspace-packages.ts` reading from disk. Memory bounded by
   `TS_PROJECT_MAX_LOADED_FILES`.
4. **Hunk-seeded ranking** (`local-context.ts`): candidates whose imported
   symbols appear in the diff's added lines are boosted ahead of ones only
   used in untouched code.
5. **Declaration skeletons** (`skeletons.ts`): related files above
   `SKELETON_FULL_FILE_MAX_CHARS` are sent as API surface only — long
   function/method bodies replaced with a "body omitted" marker, keeping
   JSDoc, decorators, signatures, and type members (purely syntactic, no
   node_modules needed). Flagged `skeleton: true` and noted in the prompt.
6. **Callers of changed code** (`callers.ts`): exported symbols whose
   declarations intersect the diff hunks seed a `git grep` prescreen,
   confirmed by compiler-resolved imports back to the changed file (so
   same-named symbols elsewhere never match). Caller files are included as
   skeletons with only the calling bodies kept (reason `caller`), with
   reserved slots inside the shared file budget — the reverse-dependency
   context no import graph provides.
7. **Bounded context tool loop** (`context-tools.ts` + provider tool-use,
   `enable_context_tools` input, default on): the reviewer model may fetch
   context the deterministic layer missed via local tools — `read_file`
   (line ranges), `grep`, `find_references` (compiler-confirmed importers),
   `list_dir` — each executing against the checkout in milliseconds, path-
   escape-proof and exclude-pattern-filtered. Hard bounds
   (`TOOL_LOOP_MAX_ROUNDS` = 2 combined / 1 separate,
   `TOOL_LOOP_MAX_CALLS_PER_REVIEW` = 6, run-wide `TOOL_CALLS_RUN_BUDGET` =
   12, capped result sizes) keep worst case at 2 extra AI turns; the final
   turn is always sent tool-less so the findings JSON contract is
   guaranteed. Heal retries (compact/escalation/repair) reuse the tool
   transcript without re-running tools. `BaseProvider.chatWithTools` runs
   the loop; each turn inherits the full retry machinery; both dialects
   translate the neutral tool definitions (Anthropic `input_schema` blocks /
   OpenAI streamed `tool_calls` fragments reassembled by index). The
   orchestrator disposes the toolkit (and the checkout it holds) right after
   the agents phase.

### Fallback engine: GitHub API static graph

One recursive Git Trees call (`repo-tree.ts`) + regex import extraction with
tsconfig-alias (`ts-paths.ts`) and workspace (`workspace-packages.ts`)
resolution and heuristic barrel expansion — the pre-compiler implementation,
kept verbatim for when local acquisition fails (fetch blocked, exotic setups)
and degrading further to relative-only probing when the tree is truncated.

### Shared selection

Framework expansion (`full` only, `related-files.ts`): Angular sibling
`templateUrl`/`styleUrls` + nearest declaring NgModule; LoopBack4 string-key
`@inject(...)` resolved by naming convention. Candidates ranked by reference
count → kind weight (models/types highest) → size, then fair round-robin
selection across changed files (`selectRelatedCandidates`), capped by
`RELATED_FILES_MAX` (24) and `RELATED_TOTAL_MAX_CHARS` (100k). Rank order
feeds the trim stages: the first shrink keeps the top 8 related files before
dropping them all.

Each related file carries a `reason` (`imported`, `template`, `di-binding`,
`barrel-reexport`, `declaring-module`, `stylesheet`) rendered in the prompt as
"*Included because: …*" so the model knows why it's looking at the file. The
whole phase is best-effort: any failure warns and the review proceeds with
whatever context resolved.

## Extension guides

**Add an input** — one entry in `src/config/schema.ts`, run
`npm run gen:action`, read it in `src/config/inputs.ts`. The build fails if you
forget to regenerate.

**Add a specialist agent** — add the category to `CATEGORIES` in `taxonomy.ts`
(label + icon), create `prompts/<category>.md`, add the category to the
relevant profiles in `profiles.ts`, and cover it in `prompts/comprehensive.md`
for combined mode. `specialists.ts`, the enable toggle, labels, and validation
sets derive automatically.

**Add a provider dialect** — subclass `BaseProvider`, implement `streamOnce` +
`probe` + `listModels` + `curlHint` + the error classifiers, add the enum value
to the `ai_provider` input in `schema.ts` (+ regen), and add the case in
`provider-factory.ts`.

**Change a tunable** — edit `limits.ts`. If it should be user-configurable,
promote it to an input in `schema.ts` instead.

**Change comment rendering** — edit `formatter.ts`; the snapshot tests in
`tests/unit/formatter.snapshot.test.ts` show the exact before/after diff.

## Testing

`npm test` (jest + ts-jest). Suites: taxonomy derivations, prompt loader,
mermaid sanitizer, deduplicator thresholds, diff-parser, JSON extraction,
formatter markdown snapshots, base-provider engine (fake subclass), OpenAI SSE
parsing (mocked fetch), schema↔action.yml sync, input batch validation, and a
stubbed full-pipeline integration test. `npm run ci` = build (includes
`check:action`) + lint + test.
