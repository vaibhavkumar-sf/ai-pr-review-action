import { ActionConfig, AgentResult, ChangedFile, Finding, MergedReviewResult, ReviewContext } from '../../src/types';
import { getEnabledAgents } from '../../src/config/profiles';

/**
 * Deterministic fixture builders for unit tests. Values mirror the action's
 * effective defaults but are intentionally hardcoded here so tests never
 * depend on the config layer they help verify.
 */

export function makeConfig(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return {
    aiProvider: 'anthropic',
    anthropicAuthToken: 'test-token',
    anthropicBaseUrl: 'https://api.example.test',
    anthropicModel: 'glm-5.2',
    maxTokens: 0, // auto — the model's full native output capacity
    thinkingBudget: 4096,
    contextWindow: 1000000,
    temperature: 0.2,
    githubToken: 'gh-token',
    owner: 'acme',
    repo: 'widget',
    prNumber: 42,
    workflowRunId: '1234567',
    workflowRunNumber: 7,
    reviewProfile: 'standard',
    reviewMode: 'combined',
    enabledAgents: getEnabledAgents('standard'),
    framework: 'auto',
    jiraUrl: '',
    jiraEmail: '',
    jiraApiToken: '',
    jiraProjectKey: '',
    failOnCritical: false,
    failThreshold: 'critical',
    postInlineComments: true,
    postDataUrl: '',
    enableReplyHandling: true,
    enableRerunFocus: true,
    enableBotCommentCleanup: true,
    maxFilesToReview: 50,
    excludePatterns: [],
    includePatterns: [],
    relatedContext: 'full',
    enableContextTools: false,
    systemPromptOverride: '',
    systemPromptAppend: '',
    angularPromptAppend: '',
    loopback4PromptAppend: '',
    enableDiagrams: true,
    commentHeader: 'AI Code Review',
    commentFooter: '',
    agentTimeout: 600,
    maxRetries: 3,
    cancelOnPrClose: true,
    debug: false,
    ...overrides,
  };
}

export function makeChangedFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename: 'src/service/user.service.ts',
    status: 'modified',
    additions: 12,
    deletions: 3,
    content: 'import { UserRepo } from "./user.repo";\nexport class UserService {}\n',
    ...overrides,
  };
}

export function makeContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    prNumber: 42,
    prTitle: 'feat: add user endpoints',
    prBody: 'Adds CRUD endpoints for users.',
    prAuthor: 'jane-dev',
    baseBranch: 'dev',
    headBranch: 'feat/users',
    headSha: 'abc1234',
    diff: 'diff --git a/src/service/user.service.ts b/src/service/user.service.ts\n'
      + '+++ b/src/service/user.service.ts\n'
      + '@@ -1,2 +1,3 @@\n'
      + ' import { UserRepo } from "./user.repo";\n'
      + '+export const x = 1;\n'
      + ' export class UserService {}\n',
    changedFiles: [
      makeChangedFile(),
      makeChangedFile({
        filename: 'src/service/user.repo.ts',
        status: 'added',
        content: 'export class UserRepo {}\n',
      }),
    ],
    dependencyFiles: [],
    jiraContext: {
      ticketId: 'TEL-101',
      ticketUrl: 'https://jira.example.test/browse/TEL-101',
      summary: 'User CRUD endpoints',
      description: 'As a user I want CRUD.',
      status: 'In Progress',
      type: 'Story',
      priority: 'High',
      acceptanceCriteria: '- endpoints exist',
    },
    repoContext: {
      claudeMdContent: null,
      detectedFramework: 'loopback4',
      hasAngularJson: false,
      hasLoopbackDeps: true,
    },
    framework: 'loopback4',
    ...overrides,
  };
}

export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'high',
    category: 'security',
    file: 'src/service/user.service.ts',
    line: 2,
    title: 'Missing input validation',
    description: 'The id parameter is not validated before use.',
    suggestion: 'Validate the id parameter.',
    ...overrides,
  };
}

export function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    agentName: 'comprehensive',
    category: 'comprehensive',
    findings: [],
    summary: 'Solid change overall.',
    score: 8,
    durationMs: 154000,
    ...overrides,
  };
}

export function makeMerged(overrides: Partial<MergedReviewResult> = {}): MergedReviewResult {
  const findings = overrides.findings ?? [
    makeFinding(),
    makeFinding({
      severity: 'medium',
      category: 'code-quality',
      line: 3,
      title: 'Inline return type',
      description: 'Extract the inline return type to a named interface.',
      codeSuggestion: '  getUser(id: string): UserDto {',
    }),
    makeFinding({
      severity: 'nit',
      category: 'testing',
      file: 'src/service/user.repo.ts',
      line: 1,
      title: 'Missing test for repo',
      description: 'No unit test covers UserRepo.',
      suggestion: undefined,
    }),
  ];
  const agentResults = overrides.agentResults ?? [
    makeAgentResult({ findings }),
  ];
  return {
    findings,
    agentResults,
    totalFindings: findings.length,
    criticalCount: findings.filter(f => f.severity === 'critical').length,
    highCount: findings.filter(f => f.severity === 'high').length,
    mediumCount: findings.filter(f => f.severity === 'medium').length,
    lowCount: findings.filter(f => f.severity === 'low').length,
    nitCount: findings.filter(f => f.severity === 'nit').length,
    passed: true,
    durationMs: 154000,
    ...overrides,
  };
}
