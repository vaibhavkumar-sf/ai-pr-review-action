# AI PR Review Action — Claude Code Guide

## What This Project Is

A Docker-based GitHub Action that performs AI-powered code reviews on pull requests. Two modes (`review_mode` input):
- **combined (default)**: one ComprehensiveAgent covers every dimension in a single exhaustive pass (`prompts/comprehensive.md`); each finding keeps its own per-finding category.
- **separate**: 8 parallel specialist agents (security, code-quality, performance, type-safety, architecture, testing, api-design, documentation) selected by profile/toggles, with an AI consolidation pass afterwards.

Findings are posted as structured PR comments with inline code annotations, and optionally POSTed (aggregates + every finding) to a Backstage tracker via `post_data_url` (`src/results/backstage-reporter.ts`, contract in `docs/backstage-integration.md`).

**Owner:** SourceFuse (currently at `vaibhavkumar-sf/ai-pr-review-action`, migrating to `sourcefuse/ai-pr-review-action`)

## Quick Reference

| Item | Location |
|------|----------|
| Entry point | `src/index.ts` |
| Main orchestration | `src/pipeline/orchestrator.ts` (phase list via `src/pipeline/phase.ts`) |
| Input registry (SSOT) | `src/config/schema.ts` → generates `action.yml` |
| Input parsing | `src/config/inputs.ts` |
| All tunables | `src/config/limits.ts` |
| Severities/categories | `src/config/taxonomy.ts` (all maps derived) |
| Agent base class | `src/agents/base-agent.ts`; specialists in `src/agents/specialists.ts` |
| Review prompts | `prompts/*.md`; meta-prompts in `prompts/system/*.md` (loader: `src/prompts/loader.ts`) |
| Providers | `src/providers/base-provider.ts` + anthropic/openai dialects |
| Type definitions | `src/types.ts` |
| Architecture docs | `docs/architecture.md` (plan: `docs/refactor-plan.md`) |
| Examples | `examples/*.yml` |
| Default model chain | `glm-5.2` (org z.ai endpoint) — comma-separated fallback chain supported, override per provider |

## Build & Run

```bash
npm install          # Install dependencies
npm run build        # prebuild (clean + check:action) + tsc → dist/
npm run gen:action   # Regenerate action.yml from src/config/schema.ts
npm test             # Jest tests
npm run lint         # ESLint check
npm run ci           # build + lint + test
docker build -t ai-pr-review .
```

## Non-Negotiable Rules

- **`action.yml` is GENERATED.** Never edit it by hand — edit `src/config/schema.ts` and run `npm run gen:action`. `check:action` in `prebuild` fails the build on drift. (Docker actions receive action.yml defaults via `INPUT_*` env, so a hand-edited action.yml silently shadows code — this caused production bugs.)
- **No magic numbers in feature code** — add named constants to `src/config/limits.ts` with a one-line rationale.
- **Severity/category data comes from `taxonomy.ts`** — never re-declare icons/labels/ranks locally.
- **Never log secrets** — inputs marked `secret: true` in the schema are masked via `core.setSecret` at parse time; log presence only.
- **Fail-safety is declared, not improvised** — wrap new pipeline work in `runPhase(name, {critical}, fn, fallback)`.

## Architecture

See `docs/architecture.md` for the full map, fail-safety table, provider matrix, and extension guides. Summary:

- `pipeline/orchestrator.ts` — flat list of `runPhase()` calls (startup → pre-flight → context → agents → consolidation → summary comment → replies/inline → description → outputs/telemetry).
- `config/` — schema (inputs SSOT), inputs (parse + batched validation), limits, taxonomy, patterns, profiles.
- `providers/` — `BaseProvider` holds chain fallback+latching, retry/backoff, streaming heartbeat, timeouts, thinking fallback, preflight; dialects implement `streamOnce`/`probe`/error classifiers. `ai_provider` input: `anthropic` (default, SDK) or `openai` (raw fetch SSE `/chat/completions`, works with any OpenAI-compatible endpoint).
- `github/threads.ts` — the single GraphQL review-threads module (fetch/resolve/minimize).
- `context/` — related-context retrieval (`related_context` input: full/imports-only/off). PRIMARY engine (`context/local/`): shallow git fetch of the PR head SHA inside the container (reuses the GITHUB_WORKSPACE checkout only when its HEAD == head SHA) + ts-morph/TypeScript-compiler-exact import & barrel resolution with hunk-seeded ranking, plus framework heuristics (Angular siblings, LB4 string-key DI in `related-files.ts`). FALLBACK engine (acquisition/analysis failure): the GitHub-API static graph — Git Trees index (`repo-tree.ts`), tsconfig aliases (`ts-paths.ts`), workspace packages (`workspace-packages.ts`), regex barrel expansion. Both share ranking/fair selection (`related-files.ts`), budgets, and the `DependencyFile[]` contract. On top, a BOUNDED agentic tool loop (`enable_context_tools`, default on): the reviewer model can call read_file/grep/find_references/list_dir against the local checkout via `BaseProvider.chatWithTools` — hard caps in limits.ts (2 rounds combined / 1 separate, 6 calls per review, 12 per run), final turn always tool-less. See docs/architecture.md § Related-context retrieval.
- `utils/` — mermaid sanitizer+validation, import extractor (specifiers + named symbols), json extraction, line numbering, logger (+ job summary).

## Key Design Decisions

### Fault tolerance — NEVER crash the action on best-effort work
- Critical phases (pre-flight, context, agents, consolidation, summary comment) fail the run — with a failure comment, outputs, and a Backstage `failed` report first.
- Everything else (bot cleanup, replies, inline comments, metrics, description, diagrams, telemetry, job summary) warns and continues.
- Individual agent failures inside the agents phase are tolerated (`Promise.allSettled`); consolidation-AI failure falls back to programmatic dedup; description-AI failure falls back to a static description.

### Comments strategy
- **Summary comment:** one fixed comment per run; old ones minimized (not deleted) via GraphQL `minimizeComment(classifier: OUTDATED)`.
- **Inline comments:** per finding via the Review API (`line` + `side: 'RIGHT'`), critical/high/medium only, never on test files.
- **Re-run focus** (`enable_rerun_focus`, default on): once a completed review exists on the PR (hidden `REVIEW_COMPLETE_MARKER` in the summary), re-runs post NEW inline comments for critical/high only (mediums/lows still found and counted in the summary), reopen resolved threads whose critical/high issue reappeared (templated reply, no AI call, never after an accepted human justification), and keep the existing PR description/diagrams.
- **Stale threads:** auto-resolved when fixed (skipping threads with unanswered human replies). Resolve/unresolve mutations need the workflow to grant `contents: write` (GitHub requires push access for PR conversations); with `contents: read` they fail with "Resource not accessible by integration" — surfaced as a once-per-run warning with remediation.
- **Tracking metrics:** grouped tables (by severity / by category / review activity), each with its own total.
- **Finding counts:** only shown after consolidation, never during progress.

### Deduplication — two passes
1. **Programmatic** (`results/deduplicator.ts`): same file + within 2 lines + similar title (Levenshtein ≥ 0.65 OR Jaccard ≥ 0.5) — thresholds in `limits.ts`.
2. **AI consolidation** (`results/consolidation-agent.ts`): semantic merge across agents (separate mode; skipped if ≤ 3 findings).

### Exclude patterns
User `exclude_patterns` are **appended** to `DEFAULT_EXCLUDE_PATTERNS` (`src/config/patterns.ts`), never replacing them.

## Code Conventions

- TypeScript strict mode — no `any` unless unavoidable
- Errors: `error instanceof Error ? error.message : String(error)`
- Logging via `@actions/core` (info/warning/debug); debug gated by the `debug` input
- Prompts on disk, loaded via `src/prompts/loader.ts` (`{{var}}` substitution throws on unresolved placeholders)
- File content sent to AI always via `addLineNumbers()` (`src/utils/text.ts`)

## Common Tasks

### Add or change an action input
1. Edit `src/config/schema.ts` (one `InputSpec` entry).
2. `npm run gen:action` and commit the regenerated `action.yml`.
3. Read the value in `src/config/inputs.ts` → `ActionConfig`.

### Add a new specialist agent
1. Add the category (id/label/icon) to `CATEGORIES` in `src/config/taxonomy.ts`.
2. Create `prompts/<category>.md` (findings JSON contract, ONE FINDING PER VIOLATION).
3. Add the category to profiles in `src/config/profiles.ts`.
4. Cover it in `prompts/comprehensive.md` for combined mode.
Everything else (agent instance, `enable_*_review` toggle, labels, validation) derives automatically.

### Add a new AI provider dialect
1. Subclass `BaseProvider` (`src/providers/base-provider.ts`): implement `streamOnce`, `probe`, `listModels`, `curlHint`, and the error classifiers.
2. Add the enum value to the `ai_provider` input in `schema.ts` (+ `gen:action`).
3. Add the case in `src/providers/provider-factory.ts`.

### Modify agent prompts
Edit `prompts/*.md` (review criteria) or `prompts/system/*.md` (meta-prompts: output contract, consolidation, PR description, mermaid, reply verdicts). Response format must be JSON with `findings[]`, `summary`, `score`; each finding needs `severity`, `category`, `file`, `line`, `title`, `description`; `code_suggestion` must preserve exact original indentation.

### Modify Mermaid handling
- Sanitizer + Kroki validation: `src/utils/mermaid.ts`
- AI diagram generation: `src/results/image-diagram-generator.ts` + `prompts/system/mermaid-diagrams.md` / `mermaid-fix.md`
- Import-based architecture diagram: `src/results/diagram-generator.ts`

## Testing

Jest + ts-jest (`jest.config.js`, tests in `tests/unit/`, `tests/integration/`, fixtures in `tests/fixtures/factory.ts`). Formatter output is snapshot-locked — a rendering change shows up as a snapshot diff; review it before `jest -u`.

## Secrets (Org-Level)

Same org-level secrets as `sourcefuse/ai-test-quality-analyzer`:
- `ANTHROPIC_AUTH_TOKEN` — AI provider API key
- `ANTHROPIC_BASE_URL` — AI provider endpoint
- `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` — JIRA integration (optional)
- `GITHUB_TOKEN` — provided automatically by GitHub Actions

## Things NOT To Do

- Do NOT edit `action.yml` by hand — it is generated from `src/config/schema.ts`
- Do NOT delete PR comments — always minimize or resolve
- Do NOT show per-agent finding counts during progress — only after consolidation
- Do NOT flag intentional configuration choices (fail_on_critical, debug, review_profile)
- Do NOT flag standard GitHub Actions boilerplate (permissions, concurrency, if-guards)
- Do NOT use `position` in the GitHub Review API — use `line` + `side: 'RIGHT'`
- Do NOT send file content without line numbers — always `addLineNumbers()`
- Do NOT log secret values — schema-marked secrets are masked; log presence only
