# AI PR Review Action

Comprehensive, AI-powered code review for TypeScript / Angular / LoopBack4 projects. Launches parallel specialist agents — each focused on a specific quality dimension — and posts structured findings as inline PR comments with a unified summary.

## Quick Start

```yaml
# .github/workflows/ai-code-review.yml
name: AI Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
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

## What It Reviews

Seven parallel specialist agents, each with deep domain expertise:

| Agent | What It Checks |
|-------|---------------|
| Security | OWASP Top 10, injection, secrets, auth, CORS, prototype pollution |
| Code Quality | SOLID, DRY, KISS, complexity, naming, error typing, logging context |
| Performance | N+1 queries, memory leaks, async patterns, pagination, caching |
| Type Safety & Docs | Missing types, JSDoc, inline return types, parameter counts |
| Architecture | Layering, DI, circular deps, Angular/LB4 patterns |
| Testing | Coverage gaps, edge cases, mock quality, test isolation |
| API Design | REST conventions, status codes, validation, pagination, versioning |

## Review Profiles

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

Works with any Anthropic-compatible API. Uses the same secrets as `sourcefuse/ai-test-quality-analyzer`:

| Provider | Configuration |
|----------|--------------|
| Anthropic (default) | `anthropic_auth_token: ${{ secrets.ANTHROPIC_AUTH_TOKEN }}` |
| OpenRouter | `anthropic_base_url: 'https://openrouter.ai/api/v1'` + `anthropic_auth_token: ${{ secrets.OPENROUTER_API_KEY }}` |
| GLM / Custom | Set `anthropic_base_url` to your endpoint |

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

## All Inputs

See [`action.yml`](action.yml) for the complete list of inputs with descriptions and defaults.

## Examples

- [`basic-usage.yml`](examples/basic-usage.yml) — Minimal setup
- [`full-config.yml`](examples/full-config.yml) — All options
- [`angular-project.yml`](examples/angular-project.yml) — Angular-specific
- [`loopback4-project.yml`](examples/loopback4-project.yml) — LoopBack4-specific
- [`openrouter-provider.yml`](examples/openrouter-provider.yml) — OpenRouter provider

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for detailed architecture documentation with Mermaid diagrams.

## License

MIT
