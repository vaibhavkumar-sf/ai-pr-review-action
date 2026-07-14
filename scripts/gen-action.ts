/**
 * Generates action.yml from src/config/schema.ts — the single source of truth
 * for inputs. The name/branding/outputs/runs sections are a template here;
 * the inputs: and runs.env: blocks are emitted from the schema.
 *
 *   npm run gen:action     write action.yml
 *   npm run check:action   fail (exit 1) if action.yml is out of date
 */
import * as fs from 'fs';
import * as path from 'path';
import { INPUTS, InputSpec, inputEnvVar } from '../src/config/schema';

const ACTION_PATH = path.join(__dirname, '..', 'action.yml');

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function emitInput(spec: InputSpec): string {
  const lines: string[] = [];
  lines.push(`  ${spec.name}:`);
  lines.push(`    description: ${yamlQuote(spec.description)}`);
  lines.push(`    required: ${spec.required ? 'true' : 'false'}`);
  if (!spec.required) {
    lines.push(`    default: ${yamlQuote(spec.default)}`);
  }
  return lines.join('\n');
}

function emitInputs(): string {
  const chunks: string[] = [];
  let currentGroup = '';
  for (const spec of INPUTS) {
    if (spec.group !== currentGroup) {
      currentGroup = spec.group;
      chunks.push(`  # ─── ${currentGroup} ${'─'.repeat(Math.max(3, 52 - currentGroup.length))}`);
    }
    chunks.push(emitInput(spec));
  }
  return chunks.join('\n');
}

function emitEnv(): string {
  const lines = ['    GITHUB_TOKEN: ${{ inputs.github_token }}'];
  for (const spec of INPUTS) {
    lines.push(`    ${inputEnvVar(spec.name)}: \${{ inputs.${spec.name} }}`);
  }
  return lines.join('\n');
}

function render(): string {
  return `# ─────────────────────────────────────────────────────────────────────────────
# GENERATED FILE — do not edit the inputs or env sections by hand.
# Edit src/config/schema.ts and run \`npm run gen:action\` to regenerate.
# CI runs \`npm run check:action\` to reject drift.
# ─────────────────────────────────────────────────────────────────────────────
name: 'AI PR Review Action'
description: 'Comprehensive AI-powered code review for TypeScript/Angular/LoopBack4 projects with parallel specialist agents'
author: 'SourceFuse'

branding:
  icon: 'eye'
  color: 'blue'

inputs:
${emitInputs()}

outputs:
  review_status:
    description: 'Review status: completed, skipped'
  skip_reason:
    description: 'Reason for skipping: too_many_files, no_agents (empty if not skipped)'
  review_comment_id:
    description: 'ID of the review summary comment posted on the PR'
  review_comment_url:
    description: 'URL of the review summary comment'
  total_findings:
    description: 'Total number of findings across all agents'
  critical_count:
    description: 'Number of critical severity findings'
  high_count:
    description: 'Number of high severity findings'
  medium_count:
    description: 'Number of medium severity findings'
  low_count:
    description: 'Number of low severity findings'
  nit_count:
    description: 'Number of nit severity findings'
  review_passed:
    description: 'Whether the review passed (no findings at or above fail_threshold)'
  agents_run:
    description: 'Comma-separated list of agents that ran'
  agents_failed:
    description: 'Comma-separated list of agents that failed (if any)'
  duration_seconds:
    description: 'Total review duration in seconds'
  backstage_reported:
    description: 'Whether review data was successfully POSTed to post_data_url (true/false, empty if post_data_url not set)'
  replies_posted:
    description: 'Number of justification replies posted on review threads that had human replies'
  threads_resolved_from_replies:
    description: 'Number of threads resolved because a human reply was verified as valid'
  threads_reopened:
    description: 'Number of resolved threads reopened because their critical/high issue was detected again on a re-run'
  bot_comments_hidden:
    description: 'Number of noisy bot comments minimized during cleanup'
  ai_calls:
    description: 'Number of AI chat calls made during the run (agents, consolidation, replies, description, diagrams)'
  input_tokens:
    description: 'Total input tokens consumed across all AI calls this run'
  output_tokens:
    description: 'Total output tokens (including thinking) across all AI calls this run'
  estimated_cost_usd:
    description: 'Estimated run cost in USD from token counts x model_pricing (client-side estimate, not billing data; empty when model_pricing is unset)'

runs:
  using: 'docker'
  image: 'Dockerfile'
  env:
${emitEnv()}
`;
}

const rendered = render();

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(ACTION_PATH) ? fs.readFileSync(ACTION_PATH, 'utf-8') : '';
  if (existing !== rendered) {
    console.error('action.yml is out of date with src/config/schema.ts — run `npm run gen:action` and commit the result.');
    process.exit(1);
  }
  console.log('action.yml is in sync with src/config/schema.ts');
} else {
  fs.writeFileSync(ACTION_PATH, rendered, 'utf-8');
  console.log(`Wrote ${ACTION_PATH} (${INPUTS.length} inputs)`);
}
