// Severity and ReviewCategory are DERIVED from the taxonomy tables — the
// single source of truth for ids, labels, icons, and ranks.
import type { ReviewCategory, Severity } from './config/taxonomy';
export type { ReviewCategory, Severity };
export type ReviewProfile = 'strict' | 'standard' | 'minimal';
export type ReviewMode = 'separate' | 'combined';
export type Framework = 'angular' | 'loopback4' | 'both' | 'auto' | 'generic';
export type FailThreshold = 'critical' | 'high' | 'medium';
export type RelatedContextMode = 'full' | 'imports-only' | 'off';

export interface Finding {
  severity: Severity;
  category: ReviewCategory;
  file: string;
  line: number;
  endLine?: number;
  title: string;
  description: string;
  suggestion?: string;
  codeSuggestion?: string;
}

export interface AgentResult {
  agentName: string;
  category: ReviewCategory;
  findings: Finding[];
  summary: string;
  score: number;
  durationMs: number;
  error?: string;
}

export interface ReviewContext {
  prNumber: number;
  prTitle: string;
  prBody: string;
  prAuthor: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  diff: string;
  changedFiles: ChangedFile[];
  dependencyFiles: DependencyFile[];
  jiraContext: JiraContext | null;
  repoContext: RepoContext;
  framework: Framework;
  /**
   * Bounded local-repo tools for agentic context retrieval (present when the
   * local checkout was acquired and enable_context_tools is on). Structural
   * typing keeps types.ts free of a context-module import; the orchestrator
   * disposes it after the agents phase.
   */
  contextTools?: {
    definitions: import('./providers/ai-provider').ToolDefinition[];
    execute(call: import('./providers/ai-provider').ToolCall): Promise<string>;
    callsRemaining(): number;
    dispose(): Promise<void>;
  };
}

/** Why an unchanged file was pulled in as review context. */
export type DependencyReason =
  | 'imported'
  | 'template'
  | 'stylesheet'
  | 'di-binding'
  | 'barrel-reexport'
  | 'declaring-module'
  | 'caller';

export interface DependencyFile {
  filename: string;
  content: string;
  referencedBy: string[];
  /** Optional for back-compat; renderers default to 'imported'. */
  reason?: DependencyReason;
  /** True when content is a declaration skeleton (bodies stripped). */
  skeleton?: boolean;
}

export interface ChangedFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  patch?: string;
  content?: string;
  additions: number;
  deletions: number;
}

export interface JiraContext {
  ticketId: string;
  ticketUrl: string;
  summary: string;
  description: string;
  status: string;
  type: string;
  priority: string;
  acceptanceCriteria?: string;
}

export interface RepoContext {
  claudeMdContent: string | null;
  detectedFramework: Framework;
  hasAngularJson: boolean;
  hasLoopbackDeps: boolean;
}

export interface ActionConfig {
  // Provider
  // API dialect: 'anthropic' (Anthropic-compatible, default) or 'openai'
  // (OpenAI-compatible /chat/completions). The anthropic* fields below apply
  // to whichever dialect is selected.
  aiProvider: 'anthropic' | 'openai';
  anthropicAuthToken: string;
  anthropicBaseUrl: string;
  // Model id, or a comma-separated fallback chain tried in order (the next is
  // used only when a model is rejected as unknown/unsupported by the endpoint).
  anthropicModel: string;
  // Raw model_pricing spec ("model=input/output" pairs, USD per 1M tokens);
  // parsed lazily by results/cost.ts. Empty = report tokens without USD.
  modelPricing: string;
  // Output-token cap per AI response. 0 (default) = auto: use the model's full
  // native output capacity (OUTPUT_TOKENS_CEILING, clamped by any smaller cap
  // the endpoint advertises via rejection). Positive = manual cap.
  maxTokens: number;
  // Extended-thinking budget in tokens, added on top of maxTokens. Directly
  // sets how long the model reasons before writing findings; 0 disables.
  thinkingBudget: number;
  // Total context window of the target model, in tokens. The assembled prompt is
  // trimmed to fit within (contextWindow - reserved output) so requests are not
  // rejected with model_context_window_exceeded. Default 1000000 (glm-5.2 /
  // Opus-tier); lower it for smaller-window models.
  contextWindow: number;
  temperature: number;

  // GitHub
  githubToken: string;
  owner: string;
  repo: string;
  prNumber: number;
  // GitHub runner context (resolved in the config layer, not read ad-hoc)
  workflowRunId: string;
  workflowRunNumber: number;

  // Profile & toggles
  reviewProfile: ReviewProfile;
  reviewMode: ReviewMode;
  enabledAgents: Set<ReviewCategory>;

  // Framework
  framework: Framework;

  // JIRA
  jiraUrl: string;
  jiraEmail: string;
  jiraApiToken: string;
  jiraProjectKey: string;

  // Behavior
  failOnCritical: boolean;
  failThreshold: FailThreshold;
  postInlineComments: boolean;
  postDataUrl: string;
  enableReplyHandling: boolean;
  enableRerunFocus: boolean;
  enableBotCommentCleanup: boolean;
  maxFilesToReview: number;
  excludePatterns: string[];
  /** Built-in noisy-bot phrases plus any the consumer added. */
  botHidePatterns: string[];
  includePatterns: string[];
  relatedContext: RelatedContextMode;
  enableContextTools: boolean;

  // Prompts
  systemPromptOverride: string;
  systemPromptAppend: string;
  angularPromptAppend: string;
  loopback4PromptAppend: string;

  // Diagrams
  enableDiagrams: boolean;

  // Comment
  commentHeader: string;
  commentFooter: string;

  // Advanced
  agentTimeout: number;
  maxRetries: number;
  cancelOnPrClose: boolean;
  debug: boolean;
}

export interface MergedReviewResult {
  findings: Finding[];
  agentResults: AgentResult[];
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  nitCount: number;
  passed: boolean;
  durationMs: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  diffPosition: number;
}

export interface ParsedDiff {
  filename: string;
  hunks: DiffHunk[];
}
