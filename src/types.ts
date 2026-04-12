export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'nit';
export type ReviewCategory = 'security' | 'code-quality' | 'performance' | 'type-safety' | 'architecture' | 'testing' | 'api-design';
export type ReviewProfile = 'strict' | 'standard' | 'minimal';
export type Framework = 'angular' | 'loopback4' | 'both' | 'auto' | 'generic';
export type FailThreshold = 'critical' | 'high' | 'medium';

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
}

export interface DependencyFile {
  filename: string;
  content: string;
  referencedBy: string[];
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
  anthropicAuthToken: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
  maxTokens: number;
  temperature: number;

  // GitHub
  githubToken: string;
  owner: string;
  repo: string;
  prNumber: number;

  // Profile & toggles
  reviewProfile: ReviewProfile;
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
  maxFilesToReview: number;
  excludePatterns: string[];
  includePatterns: string[];

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
