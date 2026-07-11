import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionConfig, FailThreshold, Framework, RelatedContextMode, ReviewMode, ReviewProfile } from '../types';
import { INPUTS, InputSpec } from './schema';
import { ProfileMap, SpecialistCategory, getEnabledAgents } from './profiles';
import { DEFAULT_EXCLUDE_PATTERNS } from './patterns';

/**
 * Parses action inputs into an ActionConfig, driven by the schema registry.
 *
 * Semantics:
 * - Missing REQUIRED inputs are collected and reported together in ONE error
 *   (so a misconfigured workflow shows every problem at once, not one per run).
 * - Malformed optional values (bad number/enum) fall back to the schema
 *   default with a warning — a typo shouldn't kill a review.
 * - Secret inputs are masked via core.setSecret before anything can log them.
 */

const SPEC_BY_NAME = new Map(INPUTS.map(spec => [spec.name, spec]));

function spec(name: string): InputSpec {
  const found = SPEC_BY_NAME.get(name);
  if (!found) throw new Error(`Input "${name}" is not declared in src/config/schema.ts`);
  return found;
}

/** Raw value: the INPUT_* env var (set by GitHub) or the schema default. */
function raw(name: string): string {
  return core.getInput(name) || spec(name).default;
}

function getString(name: string): string {
  return raw(name);
}

function getBoolean(name: string): boolean {
  return raw(name).toLowerCase() === 'true';
}

function getNumber(name: string): number {
  const value = raw(name);
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    const fallback = parseInt(spec(name).default, 10);
    core.warning(`Input ${name}="${value}" is not a number — using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

function getFloat(name: string): number {
  const value = raw(name);
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    const fallback = parseFloat(spec(name).default);
    core.warning(`Input ${name}="${value}" is not a number — using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

function getEnum<T extends string>(name: string): T {
  const { values, default: fallback } = spec(name);
  const value = raw(name).toLowerCase();
  if (values && !values.includes(value)) {
    core.warning(`Input ${name}="${value}" is not one of [${values.join(', ')}] — using default "${fallback}"`);
    return fallback as T;
  }
  return value as T;
}

function getCsv(name: string): string[] {
  const value = raw(name);
  if (!value.trim()) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/** Tri-state agent toggles: 'true'/'false' override the profile, '' follows it. */
function resolveAgentOverrides(): Partial<ProfileMap> | undefined {
  const agentToggleMap: Record<string, SpecialistCategory> = {
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
    const value = core.getInput(inputName);
    if (value) {
      overrides[category] = value.toLowerCase() === 'true';
      hasOverrides = true;
    }
  }

  return hasOverrides ? overrides : undefined;
}

function resolvePrNumber(errors: string[]): number {
  const inputPr = core.getInput('pr_number');
  if (inputPr) {
    const parsed = parseInt(inputPr, 10);
    if (!isNaN(parsed)) return parsed;
    core.warning(`Input pr_number="${inputPr}" is not a number — falling back to the event payload`);
  }

  const payload = github.context.payload;
  if (payload.pull_request?.number) {
    return payload.pull_request.number;
  }

  errors.push('Unable to determine PR number: provide the pr_number input or run on a pull_request event.');
  return 0;
}

export function parseActionInputs(): ActionConfig {
  const errors: string[] = [];

  // Mask secrets FIRST — before any parsing can log a value.
  for (const s of INPUTS) {
    if (!s.secret) continue;
    const value = core.getInput(s.name);
    if (value) core.setSecret(value);
  }

  // Required inputs: collect ALL missing ones into a single batched error.
  for (const s of INPUTS) {
    if (s.required && !core.getInput(s.name)) {
      errors.push(`Missing required input: ${s.name}`);
    }
  }

  const profile = getEnum<ReviewProfile>('review_profile');
  const reviewMode = getEnum<ReviewMode>('review_mode');
  const agentOverrides = resolveAgentOverrides();
  const enabledAgents = getEnabledAgents(profile, agentOverrides);

  if (reviewMode === 'combined' && (core.getInput('review_profile') || agentOverrides)) {
    core.info('review_mode is "combined": review_profile and enable_*_review toggles are ignored (a single comprehensive agent runs). Set review_mode: separate to use them.');
  }

  const userExcludes = getCsv('exclude_patterns');
  const prNumber = resolvePrNumber(errors);

  if (errors.length > 0) {
    throw new Error(`Invalid action configuration:\n- ${errors.join('\n- ')}`);
  }

  const { owner, repo } = github.context.repo;

  return {
    // Provider
    aiProvider: getEnum<'anthropic' | 'openai'>('ai_provider'),
    anthropicAuthToken: core.getInput('anthropic_auth_token'),
    anthropicBaseUrl: getString('anthropic_base_url'),
    anthropicModel: getString('anthropic_model'),
    maxTokens: getNumber('max_tokens'),
    thinkingBudget: getNumber('thinking_budget'),
    contextWindow: getNumber('context_window'),
    temperature: getFloat('temperature'),

    // GitHub
    githubToken: core.getInput('github_token'),
    owner,
    repo,
    prNumber,
    workflowRunId: process.env.GITHUB_RUN_ID || '',
    workflowRunNumber: parseInt(process.env.GITHUB_RUN_NUMBER || '0', 10),

    // Profile & toggles
    reviewProfile: profile,
    reviewMode,
    enabledAgents,

    // Framework
    framework: getEnum<Framework>('framework'),

    // JIRA
    jiraUrl: getString('jira_url'),
    jiraEmail: getString('jira_email'),
    jiraApiToken: getString('jira_api_token'),
    jiraProjectKey: getString('jira_project_key'),

    // Behavior
    failOnCritical: getBoolean('fail_on_critical'),
    failThreshold: getEnum<FailThreshold>('fail_threshold'),
    postInlineComments: getBoolean('post_inline_comments'),
    postDataUrl: getString('post_data_url'),
    enableReplyHandling: getBoolean('enable_reply_handling'),
    enableBotCommentCleanup: getBoolean('enable_bot_comment_cleanup'),
    maxFilesToReview: getNumber('max_files_to_review'),
    // User patterns are APPENDED to the built-in defaults, never replacing them
    excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS, ...userExcludes],
    includePatterns: getCsv('include_patterns'),
    relatedContext: getEnum<RelatedContextMode>('related_context'),

    // Diagrams
    enableDiagrams: getBoolean('enable_diagrams'),

    // Prompts
    systemPromptOverride: getString('system_prompt_override'),
    systemPromptAppend: getString('system_prompt_append'),
    angularPromptAppend: getString('angular_prompt_append'),
    loopback4PromptAppend: getString('loopback4_prompt_append'),

    // Comment
    commentHeader: getString('comment_header'),
    commentFooter: getString('comment_footer'),

    // Advanced
    agentTimeout: getNumber('agent_timeout'),
    maxRetries: getNumber('max_retries'),
    debug: getBoolean('debug'),
  };
}
