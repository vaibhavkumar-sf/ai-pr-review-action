/**
 * THE single source of truth for every action input: name, type, default,
 * description, grouping, and secrecy.
 *
 * action.yml is GENERATED from this file (`npm run gen:action`) and verified
 * in CI (`npm run check:action`), so an input default can never again exist in
 * two places that drift apart. (Docker actions always populate INPUT_* from
 * action.yml's `default:` — a hand-maintained copy silently shadowed the code
 * defaults twice before this registry existed.)
 *
 * To add an input: add one entry here, run `npm run gen:action`, and read it
 * in src/config/inputs.ts.
 */

export type InputType = 'string' | 'boolean' | 'number' | 'float' | 'enum' | 'csv';

export interface InputSpec {
  /** snake_case action input name (also the INPUT_<UPPER> env var). */
  name: string;
  type: InputType;
  /** Default exactly as emitted into action.yml (string form). */
  default: string;
  description: string;
  /** Section banner in the generated action.yml. */
  group: string;
  required?: boolean;
  /** core.setSecret() is applied to secret inputs at startup. */
  secret?: boolean;
  /** Allowed values for enum inputs (first is NOT implicitly the default). */
  values?: readonly string[];
}

export const INPUTS: readonly InputSpec[] = [
  // ─── Required ───
  {
    name: 'github_token',
    type: 'string',
    default: '',
    required: true,
    secret: true,
    group: 'Required',
    description: 'GitHub token for PR access (usually secrets.GITHUB_TOKEN)',
  },
  {
    name: 'anthropic_auth_token',
    type: 'string',
    default: '',
    required: true,
    secret: true,
    group: 'Required',
    description: 'API key for the AI endpoint (Anthropic, z.ai/GLM, OpenRouter, OpenAI, or any compatible provider)',
  },

  // ─── Provider Configuration ───
  {
    name: 'ai_provider',
    type: 'enum',
    values: ['anthropic', 'openai'],
    default: 'anthropic',
    group: 'Provider Configuration',
    description: "API dialect: 'anthropic' for Anthropic-compatible endpoints (default, the existing behavior); 'openai' for OpenAI-compatible /chat/completions endpoints (OpenAI, OpenRouter, z.ai coding API, local servers). The anthropic_* inputs apply to whichever dialect is selected",
  },
  {
    name: 'anthropic_base_url',
    type: 'string',
    default: 'https://api.anthropic.com',
    group: 'Provider Configuration',
    description: 'Base URL for the AI API. Change for z.ai/GLM, OpenRouter, OpenAI, or custom endpoints',
  },
  {
    name: 'anthropic_model',
    type: 'string',
    default: 'glm-5.2,glm-5.2[1m],claude-opus-4-8',
    group: 'Provider Configuration',
    description: 'Model id, or a comma-separated fallback chain tried in order (the next is used only when a model is rejected as unknown by the endpoint). Default tries GLM-5.2, then its 1M variant, then a Claude-tier name the z.ai endpoint maps to GLM',
  },
  {
    name: 'max_tokens',
    type: 'number',
    default: '0',
    group: 'Provider Configuration',
    description: '0 (default) = auto: use the model\'s full native output capacity (e.g. 131072 on GLM-5.2) so a review is never truncated by a self-imposed cap; if an endpoint advertises a smaller maximum in its rejection, it is discovered and latched automatically. Set a positive number to cap output tokens manually',
  },
  {
    name: 'thinking_budget',
    type: 'number',
    default: '4096',
    group: 'Provider Configuration',
    description: 'Extended-thinking budget in tokens, added on top of max_tokens. NOTE: GLM endpoints treat thinking as on/off and do NOT enforce this budget — with the default max_tokens auto mode the full output capacity absorbs even a long think. Set 0 to disable thinking. Auto-disabled if the endpoint rejects the thinking param',
  },
  {
    name: 'context_window',
    type: 'number',
    default: '1000000',
    group: 'Provider Configuration',
    description: 'Total context window of the target model, in tokens. The prompt is trimmed to fit within this minus reserved output, avoiding model_context_window_exceeded. Default 1000000 (GLM-5.2 / Opus 4.8); if a request still overflows after a fallback to a smaller model, the compact retry recovers it',
  },
  {
    name: 'temperature',
    type: 'float',
    default: '0.2',
    group: 'Provider Configuration',
    description: 'AI temperature (0.0 - 1.0)',
  },

  // ─── Review Mode ───
  {
    name: 'review_mode',
    type: 'enum',
    values: ['combined', 'separate'],
    default: 'combined',
    group: 'Review Mode',
    description: 'combined (default): one comprehensive all-at-once review covering every category. separate: 7 parallel specialist agents selected by review_profile/toggles',
  },
  {
    name: 'review_profile',
    type: 'enum',
    values: ['strict', 'standard', 'minimal'],
    default: 'standard',
    group: 'Review Mode',
    description: 'Review intensity for separate mode: strict (all 7 agents), standard (5 agents), minimal (2 agents). Ignored in combined mode',
  },

  // ─── Individual Review Toggles (override profile) ───
  ...(['security', 'code_quality', 'performance', 'type_safety', 'architecture', 'testing', 'api_design'] as const).map(
    (key): InputSpec => ({
      name: `enable_${key}_review`,
      type: 'string',
      default: '',
      group: 'Individual Review Toggles (override profile)',
      description: `Enable/disable the ${key.replace(/_/g, ' ')} review agent in separate mode (true/false overrides the profile; empty follows the profile)`,
    }),
  ),

  // ─── Framework Configuration ───
  {
    name: 'framework',
    type: 'enum',
    values: ['angular', 'loopback4', 'both', 'auto', 'generic'],
    default: 'auto',
    group: 'Framework Configuration',
    description: 'Framework for prompt additions: angular, loopback4, both, generic (none), auto (detect from repo)',
  },

  // ─── GitHub ───
  {
    name: 'pr_number',
    type: 'number',
    default: '',
    group: 'GitHub',
    description: 'Pull request number to review. Defaults to the PR of the triggering pull_request event',
  },

  // ─── JIRA Integration (optional, fault-tolerant) ───
  {
    name: 'jira_url',
    type: 'string',
    default: '',
    group: 'JIRA Integration (optional, fault-tolerant)',
    description: 'JIRA instance URL (e.g., https://company.atlassian.net)',
  },
  {
    name: 'jira_email',
    type: 'string',
    default: '',
    group: 'JIRA Integration (optional, fault-tolerant)',
    description: 'JIRA user email for API authentication',
  },
  {
    name: 'jira_api_token',
    type: 'string',
    default: '',
    secret: true,
    group: 'JIRA Integration (optional, fault-tolerant)',
    description: 'JIRA API token',
  },
  {
    name: 'jira_project_key',
    type: 'string',
    default: '',
    group: 'JIRA Integration (optional, fault-tolerant)',
    description: 'JIRA project key for ticket validation (e.g., PLM, PROJ)',
  },

  // ─── Behavior Flags ───
  {
    name: 'fail_on_critical',
    type: 'boolean',
    default: 'false',
    group: 'Behavior Flags',
    description: 'Fail the action (exit code 1) when findings at or above fail_threshold exist',
  },
  {
    name: 'fail_threshold',
    type: 'enum',
    values: ['critical', 'high', 'medium'],
    default: 'critical',
    group: 'Behavior Flags',
    description: 'Minimum severity to fail: critical, high, medium',
  },
  {
    name: 'post_inline_comments',
    type: 'boolean',
    default: 'true',
    group: 'Behavior Flags',
    description: 'Post inline review comments on specific diff lines',
  },
  {
    name: 'post_data_url',
    type: 'string',
    default: '',
    group: 'Behavior Flags',
    description: 'Optional Backstage/webhook endpoint. When set, review metrics and all individual findings are POSTed as JSON after the review — including skip/failure runs, so the tracker sees every run (fire-and-forget, never fails the action). See docs/backstage-integration.md',
  },
  {
    name: 'enable_reply_handling',
    type: 'boolean',
    default: 'true',
    group: 'Behavior Flags',
    description: 'Verify human replies on previous review threads against the code, post a justification reply in each, and resolve the thread when the reply is valid',
  },
  {
    name: 'enable_bot_comment_cleanup',
    type: 'boolean',
    default: 'true',
    group: 'Behavior Flags',
    description: 'Minimize noisy recurring bot comments (e.g. sonarqubecloud, unit-test-quality reports): known noise is hidden entirely, other recurring types keep only the latest occurrence',
  },
  {
    name: 'max_files_to_review',
    type: 'number',
    default: '50',
    group: 'Behavior Flags',
    description: 'Skip review if PR has more changed files than this',
  },
  {
    name: 'exclude_patterns',
    type: 'csv',
    default: '',
    group: 'Behavior Flags',
    description: 'Comma-separated glob patterns to exclude (appended to built-in defaults: package-lock, openapi.json, migrations, .bpmn, dist, node_modules, .d.ts, etc.)',
  },
  {
    name: 'include_patterns',
    type: 'csv',
    default: '',
    group: 'Behavior Flags',
    description: 'Comma-separated glob patterns to include (if set, only these are reviewed)',
  },
  {
    name: 'enable_context_tools',
    type: 'boolean',
    default: 'true',
    group: 'Behavior Flags',
    description:
      'Let the reviewer model fetch missing context itself via bounded local-repo tools (read_file, grep, find_references, list_dir). Hard-capped: at most 2 extra AI turns per review and 12 tool calls per run; requires the local-clone context engine (falls back to no tools when unavailable)',
  },
  {
    name: 'related_context',
    type: 'enum',
    values: ['full', 'imports-only', 'off'],
    default: 'full',
    group: 'Behavior Flags',
    description:
      'How much unchanged-file context is fetched for the reviewer: full (import graph incl. tsconfig path aliases, npm-workspace packages and barrel re-exports, plus framework expansion — Angular sibling templates/styles/modules, LoopBack4 string-key DI bindings), imports-only (import graph only), off (none)',
  },

  // ─── Prompt Customization ───
  {
    name: 'system_prompt_override',
    type: 'string',
    default: '',
    group: 'Prompt Customization',
    description: 'Full replacement of the default system prompt (replaces all built-in prompts)',
  },
  {
    name: 'system_prompt_append',
    type: 'string',
    default: '',
    group: 'Prompt Customization',
    description: 'Text appended to the default system prompt (adds to built-in prompts)',
  },
  {
    name: 'angular_prompt_append',
    type: 'string',
    default: '',
    group: 'Prompt Customization',
    description: 'Additional instructions appended for Angular-specific reviews',
  },
  {
    name: 'loopback4_prompt_append',
    type: 'string',
    default: '',
    group: 'Prompt Customization',
    description: 'Additional instructions appended for LoopBack4-specific reviews',
  },

  // ─── Comment Configuration ───
  {
    name: 'comment_header',
    type: 'string',
    default: 'AI Code Review',
    group: 'Comment Configuration',
    description: 'Custom header for the review summary comment',
  },
  {
    name: 'comment_footer',
    type: 'string',
    default: '',
    group: 'Comment Configuration',
    description: 'Custom footer text for the review summary comment',
  },

  // ─── Diagrams ───
  {
    name: 'enable_diagrams',
    type: 'boolean',
    default: 'true',
    group: 'Diagrams',
    description: 'Generate AI Mermaid diagrams (validated via Kroki.io, rendered natively by GitHub) in the PR description',
  },

  // ─── Advanced ───
  {
    name: 'agent_timeout',
    type: 'number',
    default: '800',
    group: 'Advanced',
    description: 'Timeout in seconds for each review agent AI call. 800 leaves headroom for slow endpoint spells: glm-5.2 streams all thinking before writing findings, and a timeout mid-thought yields 0 findings',
  },
  {
    name: 'max_retries',
    type: 'number',
    default: '3',
    group: 'Advanced',
    description: 'Maximum retries per agent on transient AI API failure (5xx/network). Rate limits (429) retry on their own patient budget — up to 400 attempts with escalating waits (10s up to 2min, max 5h total, riding out fair-usage throttling spells) — independent of this setting',
  },
  {
    name: 'cancel_on_pr_close',
    type: 'boolean',
    default: 'true',
    group: 'Advanced',
    description: 'Cancel the review run (neutral exit, not a failure) if the PR is closed or merged while the review is still running, freeing the runner and AI quota',
  },
  {
    name: 'debug',
    type: 'boolean',
    default: 'false',
    group: 'Advanced',
    description: 'Enable debug logging',
  },
];

/** INPUT_<UPPER_SNAKE> env var name for an input. */
export function inputEnvVar(name: string): string {
  return `INPUT_${name.toUpperCase()}`;
}
