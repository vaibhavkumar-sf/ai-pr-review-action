# AI PR Review Action — Claude Code Guide

## What This Project Is

A Docker-based GitHub Action that performs AI-powered code reviews on pull requests. It launches 7 parallel specialist agents (security, code-quality, performance, type-safety, architecture, testing, api-design), consolidates findings, and posts structured PR comments with inline code annotations.

**Owner:** SourceFuse (currently at `vaibhavkumar-sf/ai-pr-review-action`, migrating to `sourcefuse/ai-pr-review-action`)

## Quick Reference

| Item | Location |
|------|----------|
| Entry point | `src/index.ts` |
| Main orchestration | `src/orchestrator.ts` |
| Agent base class | `src/agents/base-agent.ts` |
| Agent prompts | `prompts/*.md` |
| Type definitions | `src/types.ts` |
| Action inputs | `action.yml` |
| Architecture docs | `docs/architecture.md` |
| Examples | `examples/*.yml` |
| Default model | `claude-opus-4-6-20250610` (Opus 4.6, 1M context) |

## Build & Run

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm test             # Run Jest tests
npm run lint         # ESLint check
npm run lint:fix     # ESLint auto-fix
```

Docker (as GitHub Actions runs it):
```bash
docker build -t ai-pr-review .
```

The Dockerfile uses multi-stage build: builder compiles TS, production stage has only runtime deps + compiled output + prompts.

## Architecture Overview

```
src/
  index.ts              ← Entry point: parse config → runReview()
  orchestrator.ts       ← 13-phase review flow (THE core file)
  types.ts              ← All TypeScript types/interfaces
  agents/
    base-agent.ts       ← Template Method: buildSystemPrompt → buildUserPrompt → parseResponse
    *.agent.ts           ← 7 concrete agents (just set name/category/icon)
  config/
    action-inputs.ts    ← Parse GitHub Action inputs → ActionConfig
    profiles.ts         ← strict/standard/minimal → which agents are enabled
    defaults.ts         ← All default values (model, tokens, exclude patterns, etc.)
  context/
    pr-context.ts       ← Fetch PR diff, file contents, dependency files
    jira-context.ts     ← Optional JIRA ticket extraction (fault-tolerant)
    repo-context.ts     ← Framework detection + CLAUDE.md reader
  github/
    pr-commenter.ts     ← Fixed comment with progress, minimize old, resolve stale
    inline-reviewer.ts  ← Post inline review comments via GitHub Review API
    diff-parser.ts      ← Parse unified diff, map line numbers to diff positions
  providers/
    ai-provider.ts      ← Interface: chat(messages, options) → response
    anthropic.provider.ts ← Anthropic SDK with retry + configurable baseURL
    provider-factory.ts  ← createAIProvider(config)
  results/
    deduplicator.ts     ← Programmatic dedup (Levenshtein + Jaccard)
    consolidation-agent.ts ← AI-powered semantic dedup (final pass)
    merger.ts           ← Count by severity, determine pass/fail
    formatter.ts        ← Format findings → markdown PR comment
    diagram-generator.ts ← Generate Mermaid from file imports
prompts/
  security.md           ← OWASP, injections, auth, workflow security
  code-quality.md       ← SOLID, DRY, KISS, complexity, error typing
  performance.md        ← N+1, memory leaks, async, pagination
  type-safety.md        ← Return types, param types, JSDoc per function
  architecture.md       ← Layering, DI, circular deps
  testing.md            ← Coverage, edge cases, mocking
  api-design.md         ← REST conventions, status codes, validation
  angular-additions.md  ← OnPush, RxJS, Signals, lazy loading
  loopback4-additions.md ← @model descriptions, HttpErrors, @authorize
```

## Key Design Decisions

### Fault Tolerance — NEVER crash the action
- JIRA failure → skip JIRA context, continue review
- Individual agent failure → log warning, continue with other agents
- CLAUDE.md missing → skip project context, continue
- Consolidation agent failure → use programmatic dedup results
- PR description AI failure → use static fallback description
- `Promise.allSettled()` for all parallel operations

### Review Flow (orchestrator.ts)
1. Post initial progress comment
2. Gather context (PR + JIRA + repo) in parallel
3. Create AI provider + filter agents by profile
4. Launch all agents in parallel (`Promise.allSettled`)
5. Programmatic dedup → AI consolidation pass → merge
6. Post final summary comment (replaces progress)
7. Resolve stale inline threads → post new inline comments
8. Append AI description with Mermaid diagram to PR body
9. Set action outputs, optionally fail

### Comments Strategy
- **Summary comment:** One fixed comment per run, old ones minimized (not deleted) via GraphQL `minimizeComment(classifier: OUTDATED)`
- **Inline comments:** Individual per finding via GitHub Review API (`line` + `side: 'RIGHT'`)
- **Stale threads:** Auto-resolved when the issue is fixed (via GraphQL `resolveReviewThread`)
- **Finding counts:** Only shown after consolidation, NOT during progress

### Deduplication — Two passes
1. **Programmatic** (`deduplicator.ts`): Same file + within 2 lines + similar title (Levenshtein >= 0.65 OR Jaccard keyword overlap >= 0.5)
2. **AI Consolidation** (`consolidation-agent.ts`): Sends all findings to one final AI call to merge semantic duplicates across agents. Skipped if <= 3 findings.

### Exclude Patterns — Defaults are built-in
Users only need to add project-specific extras via `exclude_patterns` input. Their patterns are **appended** to defaults, never replacing them. See `DEFAULT_EXCLUDE_PATTERNS` in `src/config/defaults.ts`.

### Provider Agnostic
Any Anthropic-compatible API works. Set `anthropic_base_url` to OpenRouter, GLM, etc. The SDK handles the rest.

## Code Conventions

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **Error handling** — always `error instanceof Error ? error.message : String(error)`
- **Logging** — use `@actions/core` (core.info, core.warning, core.debug)
- **No plain `throw new Error()`** in user-facing code
- **Imports** — barrel exports via `index.ts` in each directory
- **Agent prompts** — Markdown files in `prompts/`, loaded at runtime by `BaseAgent.loadPromptFile()`
- **Line numbers** — File content sent to AI with `addLineNumbers()` format: `  26 | code here`

## Common Tasks

### Adding a New Review Agent
1. Create `src/agents/my-agent.agent.ts` extending `BaseAgent`
2. Set `name`, `category`, `displayName`, `icon`
3. Add category to `ReviewCategory` type in `src/types.ts`
4. Add agent label in `src/github/pr-commenter.ts` AGENT_LABELS
5. Create `prompts/my-agent.md` with review rules + JSON response format
6. Register in `src/agents/index.ts` createAgents()
7. Add to profiles in `src/config/profiles.ts`
8. Add `enable_my_agent_review` input in `action.yml`
9. Add toggle mapping in `src/config/action-inputs.ts`

### Adding a New AI Provider
1. Create `src/providers/my-provider.ts` implementing `AIProvider`
2. Add to `src/providers/provider-factory.ts`

### Modifying Agent Prompts
Edit the corresponding `prompts/*.md` file. Key rules:
- Response format must be JSON with `findings[]`, `summary`, `score`
- Each finding needs: `severity`, `category`, `file`, `line`, `title`, `description`
- `code_suggestion` must preserve exact original indentation
- Include "ONE FINDING PER VIOLATION" instruction
- Framework additions (`angular-additions.md`, `loopback4-additions.md`) are auto-appended

### Modifying the Mermaid Diagram Generation
- **Import-based diagrams:** `src/results/diagram-generator.ts`
- **AI-generated PR description diagrams:** `buildDescriptionPrompt()` in `src/orchestrator.ts`
- **Mermaid sanitizer:** `sanitizeMermaid()` in `src/orchestrator.ts` — auto-quotes labels with special chars

## Testing

Test directories exist at `tests/` but are empty. When adding tests:
- Use Jest + ts-jest (already configured in devDependencies)
- Unit tests: `tests/unit/agents/`, `tests/unit/github/`, `tests/unit/providers/`
- Fixtures: `tests/fixtures/sample-diffs/`, `tests/fixtures/sample-responses/`
- Priority test targets: `deduplicator.ts`, `diff-parser.ts`, `sanitizeMermaid()`, `consolidation-agent.ts`

## Secrets (Org-Level)

This action uses the same org-level secrets as `sourcefuse/ai-test-quality-analyzer`:
- `ANTHROPIC_AUTH_TOKEN` — AI provider API key
- `ANTHROPIC_BASE_URL` — AI provider endpoint
- `JIRA_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` — JIRA integration (optional)
- `GITHUB_TOKEN` — Provided automatically by GitHub Actions

## Things NOT To Do

- Do NOT delete PR comments — always minimize or resolve
- Do NOT show per-agent finding counts during progress — only after consolidation
- Do NOT flag intentional configuration choices (fail_on_critical, debug, review_profile)
- Do NOT flag standard GitHub Actions boilerplate (permissions, concurrency, if-guards)
- Do NOT use `position` in GitHub Review API — use `line` + `side: 'RIGHT'`
- Do NOT send file content without line numbers — always use `addLineNumbers()`
- Do NOT throw plain `Error` — use typed errors or graceful fallbacks
