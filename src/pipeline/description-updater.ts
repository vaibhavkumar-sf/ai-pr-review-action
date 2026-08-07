import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ActionConfig, MergedReviewResult, ReviewContext } from '../types';
import { AIProvider } from '../providers/ai-provider';
import { generateDiagramImages } from '../results/image-diagram-generator';
import { sanitizeMermaidBlocks, validateAndStripBrokenMermaid } from '../utils/mermaid';
import { loadPrompt } from '../prompts/loader';
import {
  buildRunsSection,
  highestRecordedRun,
  renderRunBlock,
  RUNS_HEADING,
  RUNS_REGION_END,
  RUNS_REGION_START,
} from '../results/run-history';
import { RunActivityStats } from '../results/backstage-reporter';
import {
  COSMETIC_CALL_TIMEOUT_MS,
  COSMETIC_TEMPERATURE,
  DESCRIPTION_CONTENT_MAX_CHARS,
  DESCRIPTION_FILE_CHARS,
  DESCRIPTION_MAX_TOKENS,
} from '../config/limits';
import { logger } from '../utils/logger';

const AI_DESCRIPTION_SEPARATOR = '----AI-description----';

/** Superseded by the Review Runs region; stripped from bodies written by
 *  earlier versions so the stale one-off table does not linger. */
const LEGACY_SUMMARY_RE = /###\s*Review Summary[\s\S]*?<sub>Last reviewed:[^<]*<\/sub>\s*/;

/** The AI-written half of the description. Generated once per PR, not per run. */
export interface DescriptionContent {
  narrative: string;
  diagrams: string;
}

/**
 * Phase 9: the AI calls only — narrative + Mermaid diagrams. Nothing is written
 * here, because the body also has to carry this run's metrics, and those do not
 * exist until every AI call is accounted for.
 *
 * Returns `null` on a re-run that already has an AI section: the PR's purpose
 * rarely changes between fix-pushes, and skipping it saves two AI calls per
 * re-run. `writePRDescription` then carries the existing content forward.
 */
export async function generateDescriptionContent(
  octokit: Octokit,
  config: ActionConfig,
  merged: MergedReviewResult,
  context: ReviewContext,
  provider: AIProvider,
  isRerun = false,
): Promise<DescriptionContent | null> {
  const existingBody = await fetchBody(octokit, config);
  const hasAiSection = existingBody.includes(AI_DESCRIPTION_SEPARATOR);

  if (isRerun && hasAiSection) {
    logger.info('Re-run: keeping the existing PR description and diagrams');
    return null;
  }

  let narrative: string;
  try {
    const response = await provider.chat(
      [
        { role: 'system', content: loadPrompt('system/pr-description') },
        { role: 'user', content: buildDescriptionUserPrompt(context) },
      ],
      // Cosmetic PR-description writing — no extended thinking (faster; thinking
      // adds latency without improving formatting).
      {
        maxTokens: DESCRIPTION_MAX_TOKENS,
        temperature: COSMETIC_TEMPERATURE,
        timeout: COSMETIC_CALL_TIMEOUT_MS,
        thinkingBudget: 0,
      },
    );
    narrative = sanitizeMermaidBlocks(response.content);
    // Validate mermaid blocks via Kroki — strip any that fail parsing
    narrative = await validateAndStripBrokenMermaid(narrative);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Failed to generate AI description: ${msg}`);
    narrative = buildFallbackDescription(context);
  }

  let diagrams = '';
  if (config.enableDiagrams) {
    try {
      diagrams = await generateDiagramImages(context, merged, provider);
      if (diagrams) {
        logger.info('Generated Mermaid diagrams for PR description');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Failed to generate diagrams: ${msg}`);
    }
  }

  // Diagram generation can fail after a previous run succeeded — carry those
  // forward rather than losing them.
  if (!diagrams && hasAiSection) {
    diagrams = extractExistingDiagrams(existingBody);
    if (diagrams) logger.info('Preserved existing diagrams from a previous run');
  }

  // The dedicated diagrams supersede whatever the model put under ## Architecture.
  if (diagrams) {
    narrative = narrative.replace(/## Architecture[\s\S]*?(?=## |$)/, '');
  }

  return { narrative: narrative.trim(), diagrams: diagrams.trim() };
}

/**
 * Phase 10: composes and writes the whole body. Runs AFTER the run's activity
 * and AI-usage totals are known, so the metrics in the description are this
 * run's — the previous design wrote the description first and left the counts
 * frozen at whatever the first run found.
 */
export async function writePRDescription(
  octokit: Octokit,
  config: ActionConfig,
  merged: MergedReviewResult,
  context: ReviewContext,
  activity: RunActivityStats,
  content: DescriptionContent | null,
  runNumber: number,
  isRerun: boolean,
): Promise<void> {
  const existingBody = await fetchBody(octokit, config);

  const separatorIndex = existingBody.indexOf(AI_DESCRIPTION_SEPARATOR);
  const userDescription = separatorIndex >= 0
    ? existingBody.substring(0, separatorIndex).trimEnd()
    : existingBody.trimEnd();

  // On a re-run the AI content is not regenerated — recover it from the body.
  const narrative = content ? content.narrative : extractExistingNarrative(existingBody);
  const diagrams = content ? content.diagrams : extractExistingDiagrams(existingBody);

  const aiParts: string[] = ['', AI_DESCRIPTION_SEPARATOR, ''];

  if (diagrams) {
    // Open by default so reviewers see the architecture immediately, but
    // foldable so they can skip past it to the narrative in one click. The
    // blank line after </summary> is required or GitHub will not render the
    // mermaid fence inside the <details>.
    aiParts.push('<details open>');
    aiParts.push('<summary><strong>🧭 Diagrams</strong></summary>');
    aiParts.push('');
    aiParts.push(diagrams);
    aiParts.push('');
    aiParts.push('</details>');
    aiParts.push('');
  }

  aiParts.push(narrative);
  aiParts.push('');

  if (context.jiraContext) {
    aiParts.push(`**JIRA:** [${context.jiraContext.ticketId}](${context.jiraContext.ticketUrl}) — ${context.jiraContext.summary}`);
    aiParts.push('');
  }

  let head = userDescription + '\n' + aiParts.join('\n');
  // The narrative is model-generated and unbounded; clamp it here so the run
  // history always has room. The user's own description is never touched.
  if (head.length - userDescription.length > DESCRIPTION_CONTENT_MAX_CHARS) {
    core.warning('AI description exceeded its budget — truncating so run history still fits');
    head = head.slice(0, userDescription.length + DESCRIPTION_CONTENT_MAX_CHARS) +
      '\n\n<sub>Description truncated to fit GitHub\'s PR body limit.</sub>\n';
  }

  const block = renderRunBlock(runNumber, merged, config, context, activity, isRerun, new Date());
  const runsSection = buildRunsSection(block, existingBody, head.length);

  await octokit.pulls.update({
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
    body: `${head}\n${runsSection}\n`,
  });
  logger.info(`Updated PR description with the Run #${runNumber} report`);
}

/**
 * This run's 1-based ordinal. `rerunNumber` counts completed-review comments,
 * which a housekeeping delete can wipe out; the description's own run markers
 * survive that, so take whichever is higher.
 */
export async function resolveRunNumber(
  octokit: Octokit,
  config: ActionConfig,
  rerunNumber: number,
): Promise<number> {
  try {
    const body = await fetchBody(octokit, config);
    return Math.max(highestRecordedRun(body), rerunNumber) + 1;
  } catch {
    return rerunNumber + 1;
  }
}

async function fetchBody(octokit: Octokit, config: ActionConfig): Promise<string> {
  const { data: pr } = await octokit.pulls.get({
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
  });
  return pr.body || '';
}

/** The AI narrative: everything between the separator and the runs region. */
function extractExistingNarrative(body: string): string {
  const separatorIndex = body.indexOf(AI_DESCRIPTION_SEPARATOR);
  if (separatorIndex < 0) return '';

  let section = body.substring(separatorIndex + AI_DESCRIPTION_SEPARATOR.length);
  const headingIndex = section.indexOf(RUNS_HEADING);
  const regionIndex = section.indexOf(RUNS_REGION_START);
  const cut = headingIndex >= 0 ? headingIndex : regionIndex;
  if (cut >= 0) section = section.substring(0, cut);

  // Drop the diagrams (re-emitted separately) and any legacy summary table.
  section = section.replace(/<details open>\s*<summary><strong>🧭 Diagrams<\/strong><\/summary>[\s\S]*?<\/details>/, '');
  section = section.replace(/## Diagrams[\s\S]*?(?=## (?!#)|$)/, '');
  section = section.replace(LEGACY_SUMMARY_RE, '');
  section = section.replace(/\*\*JIRA:\*\*[^\n]*\n/, '');
  return section.trim();
}

/** Diagrams from a previous run, in either the current or the legacy layout. */
function extractExistingDiagrams(body: string): string {
  const wrapped = body.match(
    /<details open>\s*<summary><strong>🧭 Diagrams<\/strong><\/summary>\s*([\s\S]*?)\s*<\/details>\s*(?=\n)/,
  );
  if (wrapped) return wrapped[1].trim();

  const separatorIndex = body.indexOf(AI_DESCRIPTION_SEPARATOR);
  if (separatorIndex < 0) return '';
  const legacy = body.substring(separatorIndex).match(/## Diagrams[\s\S]*?(?=## (?!#)|$)/);
  return legacy ? legacy[0].replace(/^## Diagrams\s*\n?/, '').trim() : '';
}

/** Exported for tests: the region delimiters must round-trip through a write. */
export const DESCRIPTION_MARKERS = {
  separator: AI_DESCRIPTION_SEPARATOR,
  runsStart: RUNS_REGION_START,
  runsEnd: RUNS_REGION_END,
};

function buildDescriptionUserPrompt(context: ReviewContext): string {
  let user = `## PR Information\n`;
  user += `- **Title:** ${context.prTitle}\n`;
  user += `- **Author:** ${context.prAuthor}\n`;
  user += `- **Base:** ${context.baseBranch} ← **Head:** ${context.headBranch}\n`;
  user += `- **Framework:** ${context.framework}\n`;
  user += `- **Files changed:** ${context.changedFiles.length}\n\n`;

  user += `## Diff\n\`\`\`diff\n${context.diff}\n\`\`\`\n\n`;

  const filesToInclude = context.changedFiles.filter(f => f.content && f.status !== 'removed');
  if (filesToInclude.length > 0) {
    user += `## Changed Files\n\n`;
    for (const file of filesToInclude) {
      const content = file.content && file.content.length > DESCRIPTION_FILE_CHARS
        ? file.content.substring(0, DESCRIPTION_FILE_CHARS) + '\n... (truncated)'
        : file.content;
      user += `### ${file.filename} (${file.status})\n\`\`\`\n${content}\n\`\`\`\n\n`;
    }
  }

  if (context.jiraContext) {
    user += `## JIRA Context\n`;
    user += `- **Ticket:** ${context.jiraContext.ticketId}\n`;
    user += `- **Summary:** ${context.jiraContext.summary}\n`;
    if (context.jiraContext.description) {
      user += `- **Description:** ${context.jiraContext.description}\n`;
    }
  }

  return user;
}

function buildFallbackDescription(context: ReviewContext): string {
  const parts: string[] = [];
  parts.push('## What this PR does');
  parts.push('');
  parts.push(`This PR modifies ${context.changedFiles.length} file(s) in the \`${context.headBranch}\` branch targeting \`${context.baseBranch}\`.`);
  parts.push('');
  parts.push('## Changes');
  parts.push('');
  for (const file of context.changedFiles) {
    parts.push(`- \`${file.filename}\` (${file.status}: +${file.additions}/-${file.deletions})`);
  }
  return parts.join('\n');
}
