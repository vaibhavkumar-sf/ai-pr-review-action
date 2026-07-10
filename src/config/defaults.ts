import { ActionConfig, ReviewProfile, ReviewMode, Framework, FailThreshold } from '../types';
import { getEnabledAgents } from './profiles';

// Default model as an ordered fallback chain (comma-separated): try the latest
// GLM first, then its explicit 1M variant, then a Claude-tier name that the z.ai
// endpoint maps to GLM. The provider advances to the next only when a model is
// rejected as "Unknown Model", and latches the first that works.
export const DEFAULT_MODEL = 'glm-5.2,glm-5.2[1m],claude-opus-4-8';
export const DEFAULT_MAX_TOKENS = 8192;
// Total context window (tokens) the prompt is trimmed to fit within (minus reserved
// output). 1M targets GLM-5.2 / Opus 4.8; if a request still overflows (e.g. after
// falling back to a smaller-window model), the compact auto-heal retry recovers it.
export const DEFAULT_CONTEXT_WINDOW = 1000000;
// Extended-thinking budget (tokens), added on top of max_tokens. High by default.
export const DEFAULT_THINKING_BUDGET = 16384;
// Combined mode returns one large findings array; a higher floor avoids truncated JSON
export const DEFAULT_COMBINED_MAX_TOKENS = 16384;
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_PROFILE: ReviewProfile = 'standard';
export const DEFAULT_REVIEW_MODE: ReviewMode = 'combined';
export const DEFAULT_FRAMEWORK: Framework = 'auto';
export const DEFAULT_FAIL_THRESHOLD: FailThreshold = 'critical';
export const DEFAULT_MAX_FILES = 50;
// Per-agent API timeout (seconds). High by default because extended thinking is
// on (thinking_budget=16384): finishing a full thinking budget on a large prompt
// can take ~7-8 minutes end-to-end, so 300s was too short and truncated the call
// before it could write findings. Thinking is capped by its budget, so this is
// bounded across PR sizes; lower thinking_budget if you prefer faster reviews.
export const DEFAULT_AGENT_TIMEOUT = 600;
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

// Bot comments whose body matches one of these phrases are ALWAYS hidden
// (every occurrence). All other recurring bot comment types keep only the
// latest occurrence per (bot, heading) — older ones are minimized as OUTDATED.
export const BOT_HIDE_ALL_PATTERNS = [
  'Unit Test Quality Report',
  'Unit Test Quality Analysis Failed',
];

// Findings in these files are kept in the summary but never posted as inline comments
export const TEST_FILE_PATTERNS: RegExp[] = [
  /\.unit\.[tj]s$/,
  /\.spec\.[tj]s$/,
  /\.test\.[tj]s$/,
  /(^|\/)__tests__\/unit\//,
];

export function isTestFile(filename: string): boolean {
  return TEST_FILE_PATTERNS.some(pattern => pattern.test(filename));
}

export const DEFAULT_COMMENT_HEADER = '## AI Code Review';
export const DEFAULT_COMMENT_FOOTER = '_Powered by [ai-pr-review-action](https://github.com/sourcefuse/ai-pr-review-action)_';

export function buildDefaultConfig(): ActionConfig {
  return {
    anthropicAuthToken: '',
    anthropicBaseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    anthropicModel: DEFAULT_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    thinkingBudget: DEFAULT_THINKING_BUDGET,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    temperature: DEFAULT_TEMPERATURE,

    githubToken: '',
    owner: '',
    repo: '',
    prNumber: 0,

    reviewProfile: DEFAULT_PROFILE,
    reviewMode: DEFAULT_REVIEW_MODE,
    enabledAgents: getEnabledAgents(DEFAULT_PROFILE),

    framework: DEFAULT_FRAMEWORK,

    jiraUrl: '',
    jiraEmail: '',
    jiraApiToken: '',
    jiraProjectKey: '',

    failOnCritical: false,
    failThreshold: DEFAULT_FAIL_THRESHOLD,
    postInlineComments: true,
    postDataUrl: '',
    enableReplyHandling: true,
    enableBotCommentCleanup: true,
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
