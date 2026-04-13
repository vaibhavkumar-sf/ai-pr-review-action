import { ActionConfig, ReviewProfile, Framework, FailThreshold } from '../types';
import { getEnabledAgents } from './profiles';

export const DEFAULT_MODEL = 'claude-opus-4-6-20250610';
export const DEFAULT_MAX_TOKENS = 8192;
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_PROFILE: ReviewProfile = 'standard';
export const DEFAULT_FRAMEWORK: Framework = 'auto';
export const DEFAULT_FAIL_THRESHOLD: FailThreshold = 'critical';
export const DEFAULT_MAX_FILES = 50;
export const DEFAULT_AGENT_TIMEOUT = 300;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/openapi.json',
  '**/migrations/**/*.js',
  '**/migrations/**/*.ts',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.bpmn',
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/coverage/**',
  '**/.angular/**',
  '**/*.generated.ts',
  '**/*.d.ts',
];

export const DEFAULT_COMMENT_HEADER = '## AI Code Review';
export const DEFAULT_COMMENT_FOOTER = '_Powered by [ai-pr-review-action](https://github.com/sourcefuse/ai-pr-review-action)_';

export function buildDefaultConfig(): ActionConfig {
  return {
    anthropicAuthToken: '',
    anthropicBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    anthropicModel: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,

    githubToken: '',
    owner: '',
    repo: '',
    prNumber: 0,

    reviewProfile: DEFAULT_PROFILE,
    enabledAgents: getEnabledAgents(DEFAULT_PROFILE),

    framework: DEFAULT_FRAMEWORK,

    jiraUrl: '',
    jiraEmail: '',
    jiraApiToken: '',
    jiraProjectKey: '',

    failOnCritical: false,
    failThreshold: DEFAULT_FAIL_THRESHOLD,
    postInlineComments: true,
    maxFilesToReview: DEFAULT_MAX_FILES,
    excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
    includePatterns: [],

    enableDiagrams: true,

    systemPromptOverride: '',
    systemPromptAppend: '',
    angularPromptAppend: '',
    loopback4PromptAppend: '',

    commentHeader: DEFAULT_COMMENT_HEADER,
    commentFooter: DEFAULT_COMMENT_FOOTER,

    agentTimeout: DEFAULT_AGENT_TIMEOUT,
    maxRetries: DEFAULT_MAX_RETRIES,
    debug: false,
  };
}
