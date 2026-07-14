# AI PR Review Action

Comprehensive, AI-powered code review for TypeScript / Angular / LoopBack4 projects. Reviews every quality dimension — either in one exhaustive all-at-once pass (default) or with parallel specialist agents — and posts structured findings as inline PR comments with a unified summary. Every finding carries a category (security, performance, …) and a severity (critical … nit), and can be reported to a Backstage tracker for database storage.

## Quick Start

```yaml
# .github/workflows/ai-code-review.yml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write  # push access is required to resolve/unresolve review threads
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: sourcefuse/ai-pr-review-action@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          anthropic_auth_token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}
```

That's it. Three lines of config for a full review.

## Review Modes

| Mode | How it works |
|------|--------------|
| `combined` (default) | ONE comprehensive agent reviews everything at once in a single exhaustive pass — modeled on an expert reviewer walking a full checklist per file. Each finding is still tagged with its own category and severity. `review_profile` and the `enable_*_review` toggles are ignored. |
| `separate` | 8 parallel specialist agents (selected by `review_profile` / toggles) each review their own dimension; findings are deduplicated and AI-consolidated afterwards. |

```yaml
review_mode: 'combined'   # or 'separate'
```

Both modes produce the same output shape: categorized, severity-ranked findings in the summary comment, inline comments for every finding, Mermaid diagrams in the PR description, and (optionally) a Backstage report.

Notes on review behavior (both modes):
- Missing JSDoc/TSDoc is never flagged (missing types still are).
- Inline comments are never posted on unit test files (`*.spec.ts`, `*.unit.ts`, `*.test.ts`); missing-coverage findings are placed on the production file.
- On the first review, inline comments are posted for ALL findings (every severity, with paste-ready suggestions); on re-runs, only critical/high findings and documentation suggestions get new inline comments. Everything always appears in the summary comment and the Backstage payload.

## What It Reviews

Seven review dimensions, each with deep domain expertise (as one combined pass or parallel specialist agents):

| Category | What It Checks |
|-------|---------------|
| Security | OWASP Top 10, injection, secrets, auth, wildcard permissions, localhost datasources, CORS |
| Code Quality | SOLID, DRY, KISS, complexity, naming, error typing (HttpErrors), logging context |
| Performance | N+1 queries, memory leaks, async patterns, pagination, caching |
| Type Safety | Missing types, unsafe casts, inline return types, inline schemas/enums, parameter counts |
| Architecture | Layering, DI, circular deps, Angular/LB4 patterns |
| Testing | Coverage gaps, edge cases, mock quality, test isolation |
| API Design | REST conventions, status codes, validation, pagination, versioning |

## Review Profiles (separate mode only)

| Profile | Agents | Use Case |
|---------|--------|----------|
| `strict` | All 7 | Production-critical repos, pre-release |
| `standard` | Security, Quality, Performance, Types, Architecture | Day-to-day development (default) |
| `minimal` | Security, Quality | Quick checks, high-velocity branches |

Override any agent individually:
```yaml
review_profile: 'standard'
enable_testing_review: 'true'       # Add testing to standard
enable_performance_review: 'false'  # Remove performance from standard
```

## Provider Support

The action speaks two API dialects, selected with the `ai_provider` input, so it works with virtually any model endpoint — now and in the future. It uses the same secrets as `sourcefuse/ai-test-quality-analyzer`.

| `ai_provider` | Wire protocol | Use for |
|---------------|---------------|---------|
| `anthropic` (default) | Anthropic Messages SDK | Anthropic, or any Anthropic-compatible endpoint (org z.ai gateway, etc.) |
| `openai` | OpenAI-compatible `/chat/completions` (raw fetch + SSE streaming) | OpenRouter, z.ai coding API, vLLM, LiteLLM, or any OpenAI-compatible server |

The `anthropic_base_url`, `anthropic_auth_token`, and `anthropic_model` inputs apply to **whichever dialect is selected** (the names are kept for backward compatibility). `anthropic_model` may be a comma-separated fallback chain — the first model that the endpoint accepts is used for the rest of the run.

**Cost tracking:** every run reports its AI usage (calls, input/output tokens) in the summary comment's tracking metrics, the `ai_calls`/`input_tokens`/`output_tokens`/`estimated_cost_usd` action outputs, and the Backstage payload. To get a USD estimate, set `model_pricing` with your endpoint's prices in USD per **million** tokens, e.g. `model_pricing: 'glm-5.2=0.6/2.2'` (`model=input/output` pairs, comma-separated). The figure is a client-side estimate computed from token counts — the same approach the Claude Agent SDK uses for `total_cost_usd` — never billing data.

```yaml
# Default (Anthropic dialect) — nothing extra needed
with:
  anthropic_auth_token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}

# OpenAI-compatible dialect (e.g. OpenRouter)
with:
  ai_provider: 'openai'
  anthropic_base_url: 'https://openrouter.ai/api/v1'
  anthropic_auth_token: ${{ secrets.OPENROUTER_API_KEY }}
  anthropic_model: 'anthropic/claude-opus-4-8'
```

| Provider | `ai_provider` | Configuration |
|----------|---------------|---------------|
| Anthropic / z.ai gateway (default) | `anthropic` | `anthropic_auth_token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}` |
| OpenRouter | `openai` | `anthropic_base_url: 'https://openrouter.ai/api/v1'` + `anthropic_auth_token: ${{ secrets.OPENROUTER_API_KEY }}` |
| z.ai coding API | `openai` | `anthropic_base_url: 'https://api.z.ai/api/coding/paas/v4'` + your token |
| Any OpenAI-compatible server | `openai` | Set `anthropic_base_url` to your endpoint |

## JIRA Integration (Optional)

Automatically extracts JIRA ticket ID from branch name or PR title, fetches ticket details, and includes them in the review context. Completely fault-tolerant — if JIRA is unavailable or ticket not found, the review continues without it.

```yaml
jira_url: ${{ secrets.JIRA_URL }}
jira_email: ${{ secrets.JIRA_EMAIL }}
jira_api_token: ${{ secrets.JIRA_TOKEN }}
jira_project_key: 'PLM'
```

## CLAUDE.md Support

If your repo has a `CLAUDE.md` file in the root, its contents are automatically included in the review context. Use this for project-specific coding standards, architectural decisions, or review guidelines.

## Framework Auto-Detection

The action auto-detects your framework from `angular.json` and `package.json` dependencies:
- **Angular** projects get additional checks for change detection, RxJS patterns, module structure
- **LoopBack4** projects get checks for model decorators, repository patterns, HttpErrors

Override with `framework: 'angular'`, `framework: 'loopback4'`, or `framework: 'both'`.

## Prompt Customization

| Input | Purpose |
|-------|---------|
| `system_prompt_append` | Add instructions to all agents |
| `system_prompt_override` | Replace the entire system prompt |
| `angular_prompt_append` | Add Angular-specific instructions |
| `loopback4_prompt_append` | Add LoopBack4-specific instructions |

## Failure Behavior

By default, the action never fails your PR. Enable failure gates when ready:

```yaml
fail_on_critical: 'true'        # Fail PR on critical findings
fail_threshold: 'high'          # Fail on high or critical findings
```

## Automated Comment Lifecycle

The action manages the whole comment lifecycle on a PR, so commenting, collapsing, resolving, and replying are automated:

| Behavior | How |
|----------|-----|
| One live summary | Previous AI review summary comments are minimized as OUTDATED — only the latest stays visible |
| Noisy bot comments collapsed | `enable_bot_comment_cleanup` (default on): known noise (e.g. Unit Test Quality reports) is hidden entirely; any other recurring bot comment type (SonarQube etc.) keeps only the latest occurrence |
| Outdated findings auto-resolved | On every run, its own inline threads are resolved when the issue no longer exists in the re-reviewed code (and duplicate threads at one location collapse to the latest) |
| Re-runs focus on what matters | `enable_rerun_focus` (default on): the FIRST review is exhaustive (inline comments for every severity). Once a completed review exists on the PR, re-runs post NEW inline comments **only for critical/high findings and documentation suggestions** — other new medium/low/nit findings still appear in the summary totals but never as fresh inline comments, so fix-and-push doesn't spawn an endless stream of nitpicks. Existing medium/low threads are untouched: they stay open until actually fixed, then auto-resolve. Re-runs also keep the first run's PR description and diagrams (2 fewer AI calls) |
| Resolved-but-recurring issues reopened | On a re-run, if a thread was resolved but its critical/high issue is still detected, the thread is **unresolved** and gets a templated reply explaining why the finding matters (no AI call). Threads resolved after an accepted human justification are never reopened |
| Human replies answered | `enable_reply_handling` (default on): when someone replies to a review comment, the AI verifies the claim against the current code and posts a justification reply in EVERY such thread — agreeing and **resolving the thread** if the person is right (or the issue is fixed), or explaining exactly why the issue still stands |

Safety rules: only its own threads are ever resolved/minimized (never other reviewers'), threads with an unanswered human reply are never silently auto-resolved, and each thread gets at most one AI response per human message (no reply loops). Replies are processed on each review run (i.e. on every push to the PR).

## Backstage Reporting (Optional)

Set `post_data_url` to POST the full review result — aggregate metrics plus every individual finding with its category and severity — to a Backstage tracker endpoint after each run:

```yaml
post_data_url: ${{ secrets.AI_REVIEW_POST_DATA_URL }}
```

The request is fire-and-forget (10s timeout, never fails the action). Each run is stored as a **separate row**, so re-reviews of a PR are tracked individually (run 1: 10 new findings; run 2: 2 resolved, 8 carried over, 4 new, 4 replies answered — the full story stays queryable). The exact metrics sent are also posted on the PR itself as the "📊 Backstage Tracking Metrics" table in the summary comment (severity counts, per-category counts, new/carried-over comments, threads resolved, replies posted, bot comments hidden). See [`docs/backstage-integration.md`](docs/backstage-integration.md) for the payload contract and the suggested database schema (`ai_code_reviews` + `ai_review_findings` tables).

## Backstage Scaffolder Template

[`scaffolder/ai-code-review-workflow/template.yaml`](scaffolder/ai-code-review-workflow/template.yaml) is a Backstage Software Template that opens a PR adding this workflow ([`templates/ai-code-review.yml`](templates/ai-code-review.yml)) to any repository — same mechanism as `sourcefuse/ai-test-quality-analyzer`'s templates (`fetch:plain:file` → `acme:file:replace` → `publish:github:pull-request`). Parameters: target repo, trigger branches, JIRA project key, review mode, review profile.

## All Inputs

See [`action.yml`](action.yml) for the complete list of inputs with descriptions and defaults.

## Examples

- [`basic-usage.yml`](examples/basic-usage.yml) — Minimal setup
- [`combined-mode.yml`](examples/combined-mode.yml) — All-at-once review + Backstage reporting
- [`full-config.yml`](examples/full-config.yml) — All options
- [`angular-project.yml`](examples/angular-project.yml) — Angular-specific
- [`loopback4-project.yml`](examples/loopback4-project.yml) — LoopBack4-specific
- [`openrouter-provider.yml`](examples/openrouter-provider.yml) — OpenRouter provider

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for detailed architecture documentation with Mermaid diagrams.

## License

MIT
