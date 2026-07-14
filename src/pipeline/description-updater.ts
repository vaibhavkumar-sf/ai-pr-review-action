import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ActionConfig, MergedReviewResult, ReviewContext } from '../types';
import { AIProvider } from '../providers/ai-provider';
import { generateDiagramImages } from '../results/image-diagram-generator';
import { sanitizeMermaidBlocks, validateAndStripBrokenMermaid } from '../utils/mermaid';
import { loadPrompt } from '../prompts/loader';
import { SEVERITY_ICONS } from '../config/taxonomy';
import {
  COSMETIC_CALL_TIMEOUT_MS,
  COSMETIC_TEMPERATURE,
  DESCRIPTION_FILE_CHARS,
  DESCRIPTION_MAX_TOKENS,
} from '../config/limits';
import { logger } from '../utils/logger';

const AI_DESCRIPTION_SEPARATOR = '----AI-description----';

/**
 * Uses the AI to generate a detailed PR description with Mermaid diagrams,
 * then appends it below the ----AI-description---- separator.
 * Everything above the separator (user's manual description) is preserved.
 *
 * Re-runs keep the first run's description and diagrams untouched (2 fewer AI
 * calls per re-run; the PR's purpose rarely changes between fix-pushes) —
 * unless no AI section exists yet (a first run whose description phase
 * failed), in which case it is generated now.
 */
export async function appendToPRDescription(
  octokit: Octokit,
  config: ActionConfig,
  merged: MergedReviewResult,
  context: ReviewContext,
  provider: AIProvider,
  isRerun = false,
): Promise<void> {
  const { data: pr } = await octokit.pulls.get({
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
  });

  const existingBody = pr.body || '';

  // Split on the separator — keep everything above it
  const separatorIndex = existingBody.indexOf(AI_DESCRIPTION_SEPARATOR);
  const userDescription = separatorIndex >= 0
    ? existingBody.substring(0, separatorIndex).trimEnd()
    : existingBody.trimEnd();

  if (isRerun && separatorIndex >= 0) {
    logger.info('Re-run: keeping existing PR description and diagrams');
    return;
  }

  // Generate AI description + Mermaid diagram via AI call
  let aiGeneratedContent = '';

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
    aiGeneratedContent = sanitizeMermaidBlocks(response.content);
    // Validate mermaid blocks via Kroki — strip any that fail parsing
    aiGeneratedContent = await validateAndStripBrokenMermaid(aiGeneratedContent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Failed to generate AI description: ${msg}`);
    // Fall back to static summary
    aiGeneratedContent = buildFallbackDescription(context);
  }

  // Generate rich Mermaid diagrams (rendered natively by GitHub)
  let diagramsMarkdown = '';
  if (config.enableDiagrams) {
    try {
      diagramsMarkdown = await generateDiagramImages(context, merged, provider);
      if (diagramsMarkdown) {
        logger.info('Generated Mermaid diagrams for PR description');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Failed to generate diagrams: ${msg}`);
    }
  }

  // If diagram generation failed but existing description already has diagrams,
  // carry them forward instead of losing them
  if (!diagramsMarkdown && separatorIndex >= 0) {
    const existingAiSection = existingBody.substring(separatorIndex);
    const existingDiagramMatch = existingAiSection.match(/## Diagrams[\s\S]*?(?=## (?!#)|$)/);
    if (existingDiagramMatch) {
      diagramsMarkdown = existingDiagramMatch[0].replace(/^## Diagrams\s*\n?/, '').trim();
      if (diagramsMarkdown) {
        logger.info('Preserved existing diagrams from previous run');
      }
    }
  }

  // Remove the AI-generated Architecture mermaid section since we have dedicated diagrams
  if (diagramsMarkdown) {
    aiGeneratedContent = aiGeneratedContent.replace(/## Architecture[\s\S]*?(?=## |$)/, '');
  }

  // Build final section
  const aiParts: string[] = [];
  aiParts.push('');
  aiParts.push(AI_DESCRIPTION_SEPARATOR);
  aiParts.push('');

  // Rich Mermaid diagrams (rendered natively by GitHub)
  if (diagramsMarkdown) {
    aiParts.push('## Diagrams');
    aiParts.push('');
    aiParts.push(diagramsMarkdown);
    aiParts.push('');
  }

  aiParts.push(aiGeneratedContent);
  aiParts.push('');

  // JIRA context
  if (context.jiraContext) {
    aiParts.push(`**JIRA:** [${context.jiraContext.ticketId}](${context.jiraContext.ticketUrl}) — ${context.jiraContext.summary}`);
    aiParts.push('');
  }

  // Review summary table
  aiParts.push('### Review Summary');
  aiParts.push('');
  aiParts.push('| Severity | Count |');
  aiParts.push('|----------|-------|');
  if (merged.criticalCount > 0) aiParts.push(`| ${SEVERITY_ICONS.critical} Critical | ${merged.criticalCount} |`);
  if (merged.highCount > 0) aiParts.push(`| ${SEVERITY_ICONS.high} High | ${merged.highCount} |`);
  if (merged.mediumCount > 0) aiParts.push(`| ${SEVERITY_ICONS.medium} Medium | ${merged.mediumCount} |`);
  if (merged.lowCount > 0) aiParts.push(`| ${SEVERITY_ICONS.low} Low | ${merged.lowCount} |`);
  if (merged.nitCount > 0) aiParts.push(`| ${SEVERITY_ICONS.nit} Nit | ${merged.nitCount} |`);
  if (merged.totalFindings === 0) aiParts.push('| ✅ None | 0 |');
  aiParts.push(`| **Total** | **${merged.totalFindings}** |`);
  aiParts.push('');
  const profileMeta = config.reviewMode === 'separate' ? ` | Profile: ${config.reviewProfile}` : '';
  aiParts.push(`<sub>Last reviewed: ${new Date().toISOString()} | Model: ${config.anthropicModel} | Mode: ${config.reviewMode}${profileMeta}</sub>`);

  const newBody = userDescription + '\n' + aiParts.join('\n');

  await octokit.pulls.update({
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
    body: newBody,
  });
  logger.info('Updated PR description with AI summary');
}

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
