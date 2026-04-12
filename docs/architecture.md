# AI PR Review Action — Architecture Document

## 1. Overview

**`sourcefuse/ai-pr-review-action`** is a GitHub Action that performs comprehensive, AI-powered code reviews on pull requests. It launches parallel specialist review agents — each focused on a specific quality dimension — and merges their findings into a single, structured PR comment with inline code annotations.

### Key Design Principles

- **Fault-tolerant**: No optional feature failure (JIRA, CLAUDE.md, individual agent) crashes the action
- **Highly configurable**: Profiles + individual toggles + prompt overrides at every level
- **Provider-agnostic**: Works with Anthropic, OpenRouter, GLM, or any Anthropic-compatible API
- **Drop-in simplicity**: 3 lines of config for a full review; sensible defaults for everything else
- **Company-wide standard**: Designed for org-level adoption across Angular & LoopBack4 projects

---

## 2. High-Level Architecture

```mermaid
flowchart TD
    subgraph "GitHub"
        PR["Pull Request<br/>(opened/synchronize)"]
        GHA["GitHub Actions<br/>Runner"]
        API["GitHub REST API<br/>(PR, Comments, Reviews)"]
    end

    subgraph "ai-pr-review-action (Docker)"
        ENTRY["index.ts<br/>Entry Point"]
        CONFIG["Config Parser<br/>action-inputs.ts"]
        ORCH["Orchestrator<br/>orchestrator.ts"]
        
        subgraph "Context Gathering"
            PRC["PR Context<br/>pr-context.ts"]
            JIRA["JIRA Context<br/>jira-context.ts"]
            REPO["Repo Context<br/>repo-context.ts"]
        end

        subgraph "Parallel Review Agents"
            SEC["Security<br/>Agent"]
            CQ["Code Quality<br/>Agent"]
            PERF["Performance<br/>Agent"]
            TS["Type Safety<br/>Agent"]
            ARCH["Architecture<br/>Agent"]
            TEST["Testing<br/>Agent"]
            APID["API Design<br/>Agent"]
        end

        subgraph "AI Provider Layer"
            PROV["Provider Factory"]
            ANTH["Anthropic Provider<br/>(compatible with OpenRouter,<br/>GLM, etc.)"]
        end

        subgraph "Results Processing"
            MERGE["Merger"]
            DEDUP["Deduplicator"]
            FMT["Formatter"]
            DIAG["Diagram Generator"]
        end

        subgraph "GitHub Integration"
            CMNT["PR Commenter<br/>(fixed comment)"]
            INLINE["Inline Reviewer<br/>(line comments)"]
            DIFF["Diff Parser"]
        end
    end

    subgraph "External Services"
        AIAPI["AI API<br/>(Anthropic / OpenRouter / GLM)"]
        JIRAAPI["JIRA REST API<br/>(optional)"]
    end

    PR -->|triggers| GHA
    GHA -->|runs| ENTRY
    ENTRY --> CONFIG --> ORCH

    ORCH --> PRC
    ORCH --> JIRA
    ORCH --> REPO

    PRC -->|fetch diff, files| API
    JIRA -->|fetch ticket| JIRAAPI
    REPO -->|read CLAUDE.md| API

    ORCH -->|dispatch| SEC & CQ & PERF & TS & ARCH & TEST & APID
    SEC & CQ & PERF & TS & ARCH & TEST & APID -->|call| PROV
    PROV --> ANTH --> AIAPI

    SEC & CQ & PERF & TS & ARCH & TEST & APID -->|findings| MERGE
    MERGE --> DEDUP --> FMT
    FMT --> DIAG

    FMT -->|summary| CMNT -->|update comment| API
    FMT -->|inline findings| INLINE -->|post review| API
    DIFF -->|line mapping| INLINE
```

---

## 3. Execution Flow

```mermaid
sequenceDiagram
    participant GH as GitHub Actions
    participant Entry as index.ts
    participant Config as Config Parser
    participant Orch as Orchestrator
    participant PR as PR Context
    participant JIRA as JIRA Context
    participant Repo as Repo Context
    participant Comment as PR Commenter
    participant Agents as Review Agents (parallel)
    participant AI as AI Provider
    participant Merger as Result Merger
    participant Inline as Inline Reviewer

    GH->>Entry: Action triggered (PR event)
    Entry->>Config: Parse & validate inputs
    Config-->>Orch: ActionConfig

    Note over Orch: Phase 1: Initialize
    Orch->>Comment: Post "⏳ Review starting..." comment
    Comment-->>Orch: comment_id (for updates)

    Note over Orch: Phase 2: Gather Context
    par Parallel Context Gathering
        Orch->>PR: Fetch PR diff + changed files
        PR-->>Orch: PullRequestContext
    and
        Orch->>JIRA: Fetch ticket details (optional)
        JIRA-->>Orch: JiraContext | null (fault-tolerant)
    and
        Orch->>Repo: Read CLAUDE.md + detect framework
        Repo-->>Orch: RepoContext
    end

    Orch->>Comment: Update "📥 Context gathered, reviewing..."

    Note over Orch: Phase 3: Dispatch Agents
    par Promise.allSettled()
        Orch->>Agents: Security Agent
        Agents->>AI: Chat with security prompt + context
        AI-->>Agents: SecurityFindings[]
    and
        Orch->>Agents: Code Quality Agent
        Agents->>AI: Chat with quality prompt + context
        AI-->>Agents: QualityFindings[]
    and
        Orch->>Agents: Performance Agent
        Agents->>AI: Chat with perf prompt + context
        AI-->>Agents: PerfFindings[]
    and
        Orch->>Agents: Type Safety Agent
        Agents->>AI: Chat with types prompt + context
        AI-->>Agents: TypeFindings[]
    and
        Orch->>Agents: Architecture Agent
        Agents->>AI: Chat with arch prompt + context
        AI-->>Agents: ArchFindings[]
    and
        Orch->>Agents: Testing Agent
        Agents->>AI: Chat with testing prompt + context
        AI-->>Agents: TestFindings[]
    and
        Orch->>Agents: API Design Agent
        Agents->>AI: Chat with api prompt + context
        AI-->>Agents: ApiFindings[]
    end

    Note over Orch: Phase 4: Merge & Post
    Agents-->>Merger: All findings
    Merger->>Merger: Deduplicate + sort by severity
    Merger-->>Orch: MergedReviewResult

    par Post Results
        Orch->>Comment: Update with final summary table
    and
        Orch->>Inline: Post inline review comments
        Inline->>Inline: Map findings to diff line numbers
        Inline-->>GH: GitHub Review with inline comments
    end

    Note over Entry: Exit with configured status
    alt fail_on_critical=true AND critical findings exist
        Entry-->>GH: Exit code 1 (fail)
    else
        Entry-->>GH: Exit code 0 (success)
    end
```

---

## 4. Component Details

### 4.1 Config Parser (`src/config/action-inputs.ts`)

Reads all action inputs and produces a validated `ActionConfig` object.

```mermaid
flowchart LR
    subgraph "Input Sources"
        ENV["Environment Variables<br/>(INPUT_*)"]
        PROFILE["Review Profile<br/>(strict/standard/minimal)"]
        TOGGLES["Individual Toggles<br/>(enable_*_review)"]
    end

    subgraph "Config Parser"
        PARSE["Parse Inputs"]
        VALIDATE["Validate Required"]
        RESOLVE["Resolve Profile<br/>+ Overrides"]
    end

    subgraph "Output"
        CONFIG["ActionConfig"]
    end

    ENV --> PARSE --> VALIDATE --> RESOLVE --> CONFIG
```

**Profile Resolution Logic:**

| Profile | Security | Quality | Performance | Types | Architecture | Testing | API Design |
|---------|----------|---------|-------------|-------|-------------|---------|------------|
| strict  | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| standard | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| minimal | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |

Individual toggles (`enable_*_review`) override the profile setting for that dimension.

### 4.2 Context Gathering

```mermaid
flowchart TD
    subgraph "PR Context"
        DIFF["Fetch PR Diff"]
        FILES["Fetch Changed File Contents"]
        META["Fetch PR Metadata<br/>(title, body, author, base/head)"]
    end

    subgraph "JIRA Context (Fault-Tolerant)"
        EXTRACT["Extract Ticket ID<br/>from branch name or PR title"]
        FETCH["Fetch JIRA Ticket Details"]
        FALLBACK["On Error: Log Warning<br/>Continue with null context"]
    end

    subgraph "Repo Context"
        CLAUDE["Read CLAUDE.md<br/>from repo root"]
        DETECT["Auto-detect Framework<br/>(angular.json → Angular,<br/>@loopback/core → LoopBack4)"]
    end

    DIFF --> FILES --> META
    EXTRACT --> FETCH --> FALLBACK
    CLAUDE --> DETECT
```

**JIRA Ticket ID Extraction** (from branch name or PR title):
- Pattern: `([A-Z]{2,10}-\d+)` matches `PLM-1234`, `PROJ-567`, etc.
- Sources checked in order: branch name → PR title → PR body
- If not found: skip JIRA context silently

**Framework Auto-Detection:**
1. Check for `angular.json` or `nx.json` with Angular projects → Angular
2. Check `package.json` for `@loopback/core` dependency → LoopBack4
3. Check both → apply both Angular and LoopBack4 prompts
4. Neither found → use generic TypeScript/Node.js prompts

### 4.3 Review Agents

Each agent extends `BaseAgent` and has:
- A specialized system prompt (from `prompts/` directory)
- Framework-specific additions (Angular/LoopBack4) appended automatically
- User overrides (system_prompt_append, framework-specific appends) applied last
- CLAUDE.md content injected into context

```mermaid
classDiagram
    class BaseAgent {
        +name: string
        +category: ReviewCategory
        +systemPrompt: string
        +review(context: ReviewContext): Promise~AgentResult~
        #buildPrompt(context: ReviewContext): Message[]
        #parseFindings(response: string): Finding[]
    }

    class SecurityAgent {
        +name = "security"
        +category = SECURITY
    }

    class CodeQualityAgent {
        +name = "code-quality"
        +category = CODE_QUALITY
    }

    class PerformanceAgent {
        +name = "performance"
        +category = PERFORMANCE
    }

    class TypeSafetyAgent {
        +name = "type-safety"
        +category = TYPE_SAFETY
    }

    class ArchitectureAgent {
        +name = "architecture"
        +category = ARCHITECTURE
    }

    class TestingAgent {
        +name = "testing"
        +category = TESTING
    }

    class ApiDesignAgent {
        +name = "api-design"
        +category = API_DESIGN
    }

    BaseAgent <|-- SecurityAgent
    BaseAgent <|-- CodeQualityAgent
    BaseAgent <|-- PerformanceAgent
    BaseAgent <|-- TypeSafetyAgent
    BaseAgent <|-- ArchitectureAgent
    BaseAgent <|-- TestingAgent
    BaseAgent <|-- ApiDesignAgent
```

**Agent Response Format** (structured JSON from AI):

```json
{
  "findings": [
    {
      "severity": "critical|high|medium|low|nit",
      "category": "security|quality|performance|...",
      "file": "src/auth.service.ts",
      "line": 42,
      "title": "SQL injection vulnerability",
      "description": "User input directly interpolated into SQL query",
      "suggestion": "Use parameterized queries: `await this.db.execute($1, [userInput])`",
      "code_suggestion": "const result = await this.db.execute('SELECT * FROM users WHERE id = $1', [userId]);"
    }
  ],
  "summary": "Found 3 security issues: 1 critical SQL injection, ...",
  "score": 6
}
```

### 4.4 AI Provider Layer

```mermaid
flowchart LR
    subgraph "Provider Factory"
        FACTORY["createProvider(config)"]
    end

    subgraph "Anthropic Provider"
        CLIENT["Anthropic SDK Client"]
        RETRY["Retry Logic<br/>(3 retries, exponential backoff)"]
        TIMEOUT["Timeout: 120s per call"]
    end

    subgraph "Compatible APIs"
        A1["api.anthropic.com"]
        A2["openrouter.ai/api/v1"]
        A3["Custom GLM endpoint"]
        A4["Any Anthropic-compatible"]
    end

    FACTORY --> CLIENT --> RETRY --> TIMEOUT
    TIMEOUT --> A1 & A2 & A3 & A4
```

The provider uses the official `@anthropic-ai/sdk` with configurable `baseURL` — this automatically supports any Anthropic-compatible API.

### 4.5 GitHub Integration

**PR Commenter (Fixed Comment Pattern):**

```mermaid
stateDiagram-v2
    [*] --> SearchExisting: Find comment with marker
    SearchExisting --> CreateNew: Not found
    SearchExisting --> UpdateExisting: Found
    CreateNew --> CommentPosted
    UpdateExisting --> CommentPosted
    CommentPosted --> UpdateProgress: Agent completes
    UpdateProgress --> UpdateProgress: More agents complete
    UpdateProgress --> FinalUpdate: All agents done
    FinalUpdate --> [*]
```

The comment contains a hidden HTML marker to identify it:
```html
<!-- ai-pr-review-action-comment -->
```

**Inline Review Comments:**

Uses GitHub's Pull Request Review API to post inline comments on specific diff lines:
1. Parse the PR diff to build a line-number-to-diff-position map
2. For each finding with a file + line, look up the diff position
3. If the line is within a diff hunk, post an inline comment
4. If not in a diff hunk, include the finding in the summary comment only
5. Submit all inline comments as a single review (not individual comments)

### 4.6 Results Processing

```mermaid
flowchart TD
    FINDINGS["Raw Findings<br/>from all agents"]
    DEDUP["Deduplicator<br/>Remove findings on same file:line<br/>with similar description"]
    SORT["Sort by Severity<br/>critical → high → medium → low → nit"]
    GROUP["Group by Category<br/>for summary table"]
    FORMAT["Format Markdown<br/>summary + severity table"]
    MERMAID["Generate Mermaid Diagrams<br/>(if architecture findings exist)"]
    
    FINDINGS --> DEDUP --> SORT --> GROUP --> FORMAT --> MERMAID
```

---

## 5. Fault Tolerance Matrix

```mermaid
flowchart TD
    subgraph "Fault Tolerance Strategy"
        direction TB
        
        J["JIRA Fetch Fails"] -->|"log warning"| JR["Continue without<br/>JIRA context"]
        C["CLAUDE.md Not Found"] -->|"silent skip"| CR["Continue without<br/>repo context"]
        F["Framework Detection Fails"] -->|"default generic"| FR["Use TypeScript/Node.js<br/>prompts only"]
        A["Single Agent Fails"] -->|"log error"| AR["Mark as failed in<br/>comment, continue others"]
        AA["All Agents Fail"] -->|"post error comment"| AAR["Exit with warning<br/>(code 0)"]
        L["Line Mapping Fails"] -->|"fallback"| LR["Include finding in<br/>summary table only"]
        G["GitHub API Error"] -->|"retry 3x"| GR["Log to action output<br/>if all retries fail"]
        AI["AI Rate Limit"] -->|"exponential backoff"| AIR["Retry up to 3 times<br/>per agent"]
    end
```

---

## 6. Configuration Hierarchy

```mermaid
flowchart TD
    subgraph "Priority (highest to lowest)"
        P1["1. Action Inputs<br/>(workflow YAML)"]
        P2["2. CLAUDE.md<br/>(from target repo)"]
        P3["3. Review Profile<br/>(strict/standard/minimal)"]
        P4["4. Built-in Defaults<br/>(hardcoded in action)"]
    end

    P1 --> P2 --> P3 --> P4

    subgraph "Prompt Assembly"
        BASE["Base System Prompt"]
        AGENT["Agent-Specific Prompt"]
        FW["Framework Prompt<br/>(Angular / LoopBack4)"]
        CLAUDE_MD["CLAUDE.md Content"]
        JIRA_CTX["JIRA Ticket Context"]
        USER_APPEND["User system_prompt_append"]
        FW_APPEND["User framework_prompt_append"]
        
        BASE --> AGENT --> FW --> CLAUDE_MD --> JIRA_CTX --> USER_APPEND --> FW_APPEND
    end
```

---

## 7. Review Dimensions

### Security Agent
- OWASP Top 10 vulnerabilities
- Injection attacks (SQL, NoSQL, command, XSS, template)
- Hardcoded secrets/credentials
- Authentication & authorization flaws
- CSRF, CORS misconfiguration
- Prototype pollution (Node.js specific)
- Insecure deserialization
- Sensitive data in logs
- Missing input validation at boundaries
- Dependency vulnerabilities (known CVE patterns)

### Code Quality Agent
- SOLID principles violations (SRP, OCP, LSP, ISP, DIP)
- DRY violations (duplicated logic)
- KISS violations (overcomplicated solutions)
- Cyclomatic & cognitive complexity
- Naming conventions and consistency
- Dead code, unused imports
- Magic numbers/strings
- File size and function length
- Error typing (HttpErrors vs plain Error)
- Function parameter count (max 5)
- Inline return types (enforce DTOs)
- Code simplification opportunities

### Performance Agent
- N+1 query patterns
- Memory leaks (event listeners, subscriptions, timers)
- Blocking operations in async context
- Missing pagination on collections
- Unbounded loops
- Redundant computations in hot paths
- Missing caching opportunities
- Large payloads without streaming
- Observable/subscription cleanup (Angular)

### Type Safety & Documentation Agent
- Missing return types on functions
- Missing parameter types (implicit `any`)
- Loose types (`any`, `object`, `Function`)
- Missing JSDoc/TSDoc on all functions
- Missing `@param` and `@returns` documentation
- Incorrect/outdated comments
- Missing model & property descriptions (LoopBack4)
- Inline response schemas (enforce DTOs)

### Architecture Agent
- Layering violations (controller ↔ repository direct access)
- Dependency injection issues
- Circular dependencies
- Missing abstractions / over-abstraction
- Separation of concerns violations
- Configuration hardcoding
- Angular: Change detection strategy, module structure, lazy loading
- LoopBack4: Decorator usage, repository patterns, interceptors

### Testing Agent
- Missing test coverage for new code paths
- Missing edge case tests (empty, null, boundary)
- Mock quality (do mocks match real implementations?)
- Test naming clarity
- Async test handling
- Snapshot test overuse
- Test isolation (no interdependencies)

### API Design Agent
- HTTP method correctness
- Status code appropriateness
- URL naming conventions
- Input validation at boundaries
- Pagination implementation
- Response format consistency
- Breaking API changes
- OpenAPI spec accuracy
- Error response format

---

## 8. Versioning Strategy

- **Tags**: `v1.0.0`, `v1.1.0`, `v2.0.0` — semantic versioning
- **Major tag**: `v1` — always points to latest v1.x.x (for consumer stability)
- **Docker image**: Published to GHCR on each release tag
- **Breaking changes**: Major version bump only

Consumer usage: `sourcefuse/ai-pr-review-action@v1` — always gets latest v1.x patches.

---

## 9. Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20 (inside Docker) |
| Language | TypeScript 5.x |
| AI SDK | @anthropic-ai/sdk |
| GitHub SDK | @actions/core, @actions/github, @octokit/rest |
| HTTP Client | Built-in fetch (Node 20) |
| Testing | Jest |
| Linting | ESLint + typescript-eslint |
| Container | Docker (Alpine-based Node 20) |
| CI/CD | GitHub Actions |

---

## 10. Security Considerations

- **No secrets stored**: All credentials passed via action inputs (encrypted GitHub Secrets)
- **Minimal permissions**: Only `contents: read` and `pull-requests: write` required
- **No external data exfil**: Only communicates with configured AI API and GitHub API
- **Diff-only context**: Only changed files sent to AI, not entire repo
- **Token scoping**: GITHUB_TOKEN automatically scoped to the repo
