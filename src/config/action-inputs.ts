import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionConfig, ReviewCategory, ReviewProfile, Framework, FailThreshold } from '../types';
import { ProfileMap, getEnabledAgents } from './profiles';
import { buildDefaultConfig, DEFAULT_EXCLUDE_PATTERNS } from './defaults';

function getInputOrDefault(name: string, defaultValue: string): string {
  return core.getInput(name) || defaultValue;
}

function getBooleanInput(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name);
  if (!raw) return defaultValue;
  return raw.toLowerCase() === 'true';
}

function getNumberInput(name: string, defaultValue: number): number {
  const raw = core.getInput(name);
  if (!raw) return defaultValue;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseCommaSeparated(input: string): string[] {
  if (!input.trim()) return [];
  return input.split(',').map(s => s.trim()).filter(Boolean);
}

function parseReviewProfile(raw: string): ReviewProfile {
  const valid: ReviewProfile[] = ['strict', 'standard', 'minimal'];
  const lower = raw.toLowerCase() as ReviewProfile;
  return valid.includes(lower) ? lower : 'standard';
}

function parseFramework(raw: string): Framework {
  const valid: Framework[] = ['angular', 'loopback4', 'both', 'auto', 'generic'];
  const lower = raw.toLowerCase() as Framework;
  return valid.includes(lower) ? lower : 'auto';
}

function parseFailThreshold(raw: string): FailThreshold {
  const valid: FailThreshold[] = ['critical', 'high', 'medium'];
  const lower = raw.toLowerCase() as FailThreshold;
  return valid.includes(lower) ? lower : 'critical';
}

function resolveAgentOverrides(): Partial<ProfileMap> | undefined {
  const agentToggleMap: Record<string, ReviewCategory> = {
    'enable_security_review': 'security',
    'enable_code_quality_review': 'code-quality',
    'enable_performance_review': 'performance',
    'enable_type_safety_review': 'type-safety',
    'enable_architecture_review': 'architecture',
    'enable_testing_review': 'testing',
    'enable_api_design_review': 'api-design',
  };

  const overrides: Partial<ProfileMap> = {};
  let hasOverrides = false;

  for (const [inputName, category] of Object.entries(agentToggleMap)) {
    const raw = core.getInput(inputName);
    if (raw) {
      overrides[category] = raw.toLowerCase() === 'true';
      hasOverrides = true;
    }
  }

  return hasOverrides ? overrides : undefined;
}

function resolvePrNumber(): number {
  const inputPr = core.getInput('pr_number');
  if (inputPr) {
    const parsed = parseInt(inputPr, 10);
    if (!isNaN(parsed)) return parsed;
  }

  const payload = github.context.payload;
  if (payload.pull_request?.number) {
    return payload.pull_request.number;
  }

  throw new Error('Unable to determine PR number. Provide pr_number input or run on a pull_request event.');
}

function resolveOwnerRepo(): { owner: string; repo: string } {
  return github.context.repo;
}

export function parseActionInputs(): ActionConfig {
  const defaults = buildDefaultConfig();
  const { owner, repo } = resolveOwnerRepo();

  const profile = parseReviewProfile(getInputOrDefault('review_profile', defaults.reviewProfile));
  const agentOverrides = resolveAgentOverrides();
  const enabledAgents = getEnabledAgents(profile, agentOverrides);

  const excludeRaw = core.getInput('exclude_patterns');
  const excludePatterns = excludeRaw
    ? [...DEFAULT_EXCLUDE_PATTERNS, ...parseCommaSeparated(excludeRaw)]
    : [...DEFAULT_EXCLUDE_PATTERNS];

  const config: ActionConfig = {
    // Provider
    anthropicAuthToken: core.getInput('anthropic_auth_token', { required: true }),
    anthropicBaseUrl: getInputOrDefault('anthropic_base_url', defaults.anthropicBaseUrl),
    anthropicModel: getInputOrDefault('anthropic_model', defaults.anthropicModel),
    maxTokens: getNumberInput('max_tokens', defaults.maxTokens),
    temperature: parseFloat(getInputOrDefault('temperature', String(defaults.temperature))),

    // GitHub
    githubToken: core.getInput('github_token', { required: true }),
    owner,
    repo,
    prNumber: resolvePrNumber(),

    // Profile & toggles
    reviewProfile: profile,
    enabledAgents,

    // Framework
    framework: parseFramework(getInputOrDefault('framework', defaults.framework)),

    // JIRA
    jiraUrl: core.getInput('jira_url'),
    jiraEmail: core.getInput('jira_email'),
    jiraApiToken: core.getInput('jira_api_token'),
    jiraProjectKey: core.getInput('jira_project_key'),

    // Behavior
    failOnCritical: getBooleanInput('fail_on_critical', defaults.failOnCritical),
    failThreshold: parseFailThreshold(getInputOrDefault('fail_threshold', defaults.failThreshold)),
    postInlineComments: getBooleanInput('post_inline_comments', defaults.postInlineComments),
    maxFilesToReview: getNumberInput('max_files_to_review', defaults.maxFilesToReview),
    excludePatterns,
    includePatterns: parseCommaSeparated(core.getInput('include_patterns')),

    // Diagrams
    enableDiagrams: getBooleanInput('enable_diagrams', defaults.enableDiagrams),

    // Prompts
    systemPromptOverride: core.getInput('system_prompt_override'),
    systemPromptAppend: core.getInput('system_prompt_append'),
    angularPromptAppend: core.getInput('angular_prompt_append'),
    loopback4PromptAppend: core.getInput('loopback4_prompt_append'),

    // Comment
    commentHeader: getInputOrDefault('comment_header', defaults.commentHeader),
    commentFooter: getInputOrDefault('comment_footer', defaults.commentFooter),

    // Advanced
    agentTimeout: getNumberInput('agent_timeout', defaults.agentTimeout),
    maxRetries: getNumberInput('max_retries', defaults.maxRetries),
    debug: getBooleanInput('debug', defaults.debug),
  };

  return config;
}
