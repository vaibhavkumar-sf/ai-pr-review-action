# Backstage Integration — AI Code Review Tracker

This action can report every review run to a Backstage backend so review metrics (categories, severities, counts, scores) and each individual finding can be stored in a database and visualized on a Backstage dashboard.

It follows the same pattern as the `sourcefuse/ai-test-quality-analyzer` "Report to Backstage Test Quality Tracker" step: a single fire-and-forget HTTP POST after the review completes.

## How it works

1. Set the `post_data_url` input on the action (typically from an org secret):

   ```yaml
   - uses: sourcefuse/ai-pr-review-action@main
     with:
       # ...
       post_data_url: ${{ secrets.AI_REVIEW_POST_DATA_URL }}
   ```

2. After the review completes (summary comment, inline comments, and PR description are already posted), the action sends:

   ```
   POST <post_data_url>
   Content-Type: application/json
   ```

3. **Failure semantics:** the request has a 10-second timeout, no retries, and NEVER fails the action. A failed report is logged as a warning (`non-critical, continuing`). The action output `backstage_reported` is `true`/`false` (empty when `post_data_url` is not set).

## Payload

One JSON object per review run. All keys are snake_case.

```json
{
  "repo_name": "sourcefuse/telescope-health-backend-api",
  "pr_number": 123,
  "pr_title": "TEL-1234: Add lead sync service",
  "pr_url": "https://github.com/sourcefuse/telescope-health-backend-api/pull/123",
  "pr_creator": "some-dev",
  "branch_name": "feature/TEL-1234-lead-sync",
  "base_branch": "develop",
  "head_sha": "0a1b2c3d4e5f...",
  "workflow_run_id": "9876543210",
  "workflow_run_number": 42,
  "run_timestamp": "2026-07-10T09:30:00.000Z",

  "review_mode": "combined",
  "review_profile": "standard",
  "framework": "loopback4",
  "model_name": "glm-5.2",
  "ai_provider": "glm",

  "review_status": "completed",
  "skip_reason": "",
  "review_passed": true,
  "total_findings": 23,
  "critical_count": 0,
  "high_count": 4,
  "medium_count": 11,
  "low_count": 6,
  "nit_count": 2,
  "security_count": 3,
  "code_quality_count": 8,
  "performance_count": 2,
  "type_safety_count": 6,
  "architecture_count": 2,
  "testing_count": 1,
  "api_design_count": 1,
  "documentation_count": 2,
  "average_score": 6.5,
  "agents_run": "comprehensive",
  "agents_failed": "",
  "files_reviewed": 14,
  "duration_seconds": 187,

  "inline_comments_new": 4,
  "inline_comments_existing": 8,
  "stale_threads_resolved": 2,
  "threads_reopened": 1,
  "replies_posted": 4,
  "threads_resolved_from_replies": 1,
  "bot_comments_hidden": 3,

  "ai_calls": 7,
  "input_tokens": 245120,
  "output_tokens": 38440,
  "estimated_cost_usd": 0.2317,

  "findings": [
    {
      "category": "security",
      "severity": "high",
      "file": "src/datasources/sfdc-integration.datasource.ts",
      "line": 12,
      "title": "Hardcoded localhost URL in datasource config",
      "description": "The datasource baseURL contains http://localhost:4051 which will ship to higher environments...",
      "suggestion": "Resolve the URL from process.env.SFDC_INTEGRATION_FACADE_URL with no localhost fallback.",
      "has_code_suggestion": true
    }
  ]
}
```

Field notes:

| Field | Type | Notes |
|-------|------|-------|
| `review_mode` | string | `combined` (single all-at-once agent) or `separate` (specialist agents) |
| `review_profile` | string | Only meaningful when `review_mode` = `separate` |
| `ai_provider` | string | Derived from `anthropic_base_url`: `anthropic`, `openrouter`, `glm`, or `custom` |
| `review_status` | string | `completed`, `skipped`, `failed`, or `cancelled` |
| `skip_reason` | string | Why a non-completed run ended: `too_many_files`, `no_agents`, `ai_unreachable`, `ai_call_failed`, `pr_closed`, `pr_merged`. Empty string on completed runs |
| `*_count` (severity) | int | Counts after deduplication — sum equals `total_findings` |
| `*_count` (category) | int | One counter per category; sum equals `total_findings`. Categories are always the 8 specialist ones — in combined mode each finding still carries its own category |
| `average_score` | float | Mean of agent scores (0–10, one decimal). In combined mode this is the single comprehensive agent's score |
| `agents_run` / `agents_failed` | string | Comma-separated agent names (`comprehensive` in combined mode) |
| `inline_comments_new` | int | Inline comments actually posted this run (genuinely new findings) |
| `inline_comments_existing` | int | Inline-eligible findings that already had a comment from a previous run (carried over) |
| `stale_threads_resolved` | int | Threads auto-resolved this run because the issue is fixed / no longer reported |
| `threads_reopened` | int | Resolved threads unresolved this run because their critical/high issue was detected again (re-runs only) |
| `replies_posted` | int | Justification replies posted in threads where a human had replied |
| `threads_resolved_from_replies` | int | Threads resolved because the human's reply was verified as valid |
| `bot_comments_hidden` | int | Noisy bot comments minimized during cleanup |
| `ai_calls` | int | AI chat calls made this run (agents, consolidation, replies, description, diagrams) |
| `input_tokens` / `output_tokens` | int | Total tokens across all AI calls (output includes thinking) |
| `estimated_cost_usd` | float \| null | Client-side estimate: token counts × the `model_pricing` input (USD per 1M tokens). `null` when `model_pricing` is unset; partial if some used models are unpriced. Never billing data |
| `findings[].category` | string | `security`, `code-quality`, `performance`, `type-safety`, `architecture`, `testing`, `api-design`, `documentation` |
| `findings[].severity` | string | `critical`, `high`, `medium`, `low`, `nit` |
| `findings[].suggestion` | string \| null | Free-text fix guidance |
| `findings[].has_code_suggestion` | bool | Whether a committable GitHub suggestion was attached to the finding |

**Every run is reported, not just successful ones.** Skipped (`too_many_files`, `no_agents`), failed (`ai_unreachable`, `ai_call_failed`, uncaught error) and cancelled (`pr_closed`, `pr_merged`) runs all POST the same payload shape with zero counts, an empty `findings[]`, and `review_status` / `skip_reason` set — so the tracker records the complete picture, including the reviews that never produced findings.

### Re-review tracking — one row per run

**Every review run is a separate row** — the action never updates a previous report. On GitHub the old summary comment is minimized and replaced (the PR stays clean), but in Backstage the full history is preserved, so a dashboard can reconstruct the complete story of a PR:

| Run | What the row shows |
|-----|--------------------|
| Run 1 (PR opened) | `total_findings: 10`, `inline_comments_new: 10`, everything else 0 |
| Run 2 (re-push) | `stale_threads_resolved: 2` (fixed in code), `inline_comments_existing: 8` (still open), `inline_comments_new: 4` (new critical/high issues — re-runs never post new medium/low inline), `threads_reopened: 1` (a resolved critical came back), `replies_posted: 4` (humans pushed back, all answered), `threads_resolved_from_replies: 1` |
| Run 3 (re-push) | ... and so on |

Group rows by `repo_name` + `pr_number` (ordered by `run_timestamp`) to get "this PR was reviewed 3 times"; `head_sha` distinguishes the exact commit each run reviewed. The same metrics table is also posted on the PR itself (the "📊 Tracking Metrics" section at the top of the summary comment), so reviewers see exactly what was recorded.

## Suggested database schema

Two tables: one row per review run, one row per finding.

### `ai_code_reviews`

```sql
CREATE TABLE ai_code_reviews (
  id                    BIGSERIAL PRIMARY KEY,
  repo_name             VARCHAR(255)  NOT NULL,
  pr_number             INTEGER       NOT NULL,
  pr_title              TEXT,
  pr_url                VARCHAR(512),
  pr_creator            VARCHAR(255),
  branch_name           VARCHAR(255),
  base_branch           VARCHAR(255),
  head_sha              VARCHAR(64),
  workflow_run_id       VARCHAR(64),
  workflow_run_number   INTEGER,
  review_mode           VARCHAR(16),
  review_profile        VARCHAR(16),
  framework             VARCHAR(32),
  model_name            VARCHAR(128),
  ai_provider           VARCHAR(32),
  review_status         VARCHAR(32),
  review_passed         BOOLEAN,
  total_findings        INTEGER       NOT NULL DEFAULT 0,
  critical_count        INTEGER       NOT NULL DEFAULT 0,
  high_count            INTEGER       NOT NULL DEFAULT 0,
  medium_count          INTEGER       NOT NULL DEFAULT 0,
  low_count             INTEGER       NOT NULL DEFAULT 0,
  nit_count             INTEGER       NOT NULL DEFAULT 0,
  security_count        INTEGER       NOT NULL DEFAULT 0,
  code_quality_count    INTEGER       NOT NULL DEFAULT 0,
  performance_count     INTEGER       NOT NULL DEFAULT 0,
  type_safety_count     INTEGER       NOT NULL DEFAULT 0,
  architecture_count    INTEGER       NOT NULL DEFAULT 0,
  testing_count         INTEGER       NOT NULL DEFAULT 0,
  api_design_count      INTEGER       NOT NULL DEFAULT 0,
  documentation_count   INTEGER       NOT NULL DEFAULT 0,
  average_score         NUMERIC(4,1),
  agents_run            TEXT,
  agents_failed         TEXT,
  files_reviewed        INTEGER,
  duration_seconds      INTEGER,
  inline_comments_new   INTEGER       NOT NULL DEFAULT 0,
  inline_comments_existing INTEGER    NOT NULL DEFAULT 0,
  stale_threads_resolved INTEGER      NOT NULL DEFAULT 0,
  threads_reopened      INTEGER       NOT NULL DEFAULT 0,
  replies_posted        INTEGER       NOT NULL DEFAULT 0,
  threads_resolved_from_replies INTEGER NOT NULL DEFAULT 0,
  bot_comments_hidden   INTEGER       NOT NULL DEFAULT 0,
  ai_calls              INTEGER       NOT NULL DEFAULT 0,
  input_tokens          BIGINT        NOT NULL DEFAULT 0,
  output_tokens         BIGINT        NOT NULL DEFAULT 0,
  estimated_cost_usd    NUMERIC(12,6),
  run_timestamp         TIMESTAMPTZ   NOT NULL,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_code_reviews_repo_pr ON ai_code_reviews (repo_name, pr_number);
CREATE INDEX idx_ai_code_reviews_run_timestamp ON ai_code_reviews (run_timestamp);
```

### `ai_review_findings`

```sql
CREATE TABLE ai_review_findings (
  id                    BIGSERIAL PRIMARY KEY,
  review_id             BIGINT        NOT NULL REFERENCES ai_code_reviews(id) ON DELETE CASCADE,
  category              VARCHAR(32)   NOT NULL,
  severity              VARCHAR(16)   NOT NULL,
  file                  VARCHAR(512),
  line                  INTEGER,
  title                 TEXT,
  description           TEXT,
  suggestion            TEXT,
  has_code_suggestion   BOOLEAN       NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_review_findings_review_id ON ai_review_findings (review_id);
CREATE INDEX idx_ai_review_findings_category ON ai_review_findings (category);
CREATE INDEX idx_ai_review_findings_severity ON ai_review_findings (severity);
```

Ingestion is a straightforward insert: write the top-level object (minus `findings`) into `ai_code_reviews`, then insert each element of `findings[]` into `ai_review_findings` with the returned `review_id`. Re-runs on the same PR produce a NEW review row each time (use `head_sha`/`run_timestamp` to distinguish runs; the latest row per `repo_name` + `pr_number` is the current state).

## Useful dashboard queries

```sql
-- Findings by category across an org, last 30 days
SELECT f.category, COUNT(*) AS findings
FROM ai_review_findings f
JOIN ai_code_reviews r ON r.id = f.review_id
WHERE r.run_timestamp > now() - INTERVAL '30 days'
GROUP BY f.category ORDER BY findings DESC;

-- Repos with the most critical/high findings
SELECT r.repo_name, SUM(r.critical_count + r.high_count) AS severe
FROM ai_code_reviews r
GROUP BY r.repo_name ORDER BY severe DESC LIMIT 10;

-- Average review score trend per repo
SELECT r.repo_name, date_trunc('week', r.run_timestamp) AS week, AVG(r.average_score)
FROM ai_code_reviews r
GROUP BY 1, 2 ORDER BY 2 DESC;
```

## Backstage scaffolder template

This repo also ships a Backstage Software Template at `scaffolder/ai-code-review-workflow/template.yaml` that opens a PR adding `.github/workflows/ai-code-review.yml` (from `templates/ai-code-review.yml`) to any sourcefuse repository. It uses the same 3-step mechanism as `ai-test-quality-analyzer`'s templates:

1. `fetch:plain:file` — downloads the skeleton workflow from this repo
2. `acme:file:replace` — parameterizes trigger branches, JIRA project key, review mode, and review profile (requires the custom `acme:file:replace` scaffolder action installed in the Backstage backend)
3. `publish:github:pull-request` — opens the PR against the target repo

Register the template in your Backstage catalog by adding a Location pointing at the raw `template.yaml` URL.
