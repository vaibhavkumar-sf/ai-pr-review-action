import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ActionConfig, AgentResult, MergedReviewResult, ReviewContext } from './types';
import { gatherAllContext } from './context';
import { AIProvider } from './providers/ai-provider';
import { createAIProvider } from './providers/provider-factory';
import { createAgents } from './agents';
import { PRCommenter } from './github/pr-commenter';
import { InlineReviewer } from './github/inline-reviewer';
import { parseDiff } from './github/diff-parser';
import { deduplicateFindings, consolidateFindings, mergeResults, formatReviewComment, generateArchitectureDiagram } from './results';
import { generateDiagramImages } from './results/image-diagram-generator';
import { logger } from './utils/logger';

/**
 * Main orchestration function for the AI PR Review Action.
 *
 * 1.  Creates GitHub client and commenter
 * 2.  Posts initial progress comment
 * 3.  Gathers all context (PR, JIRA, repo)
 * 4.  Validates file count against configured maximum
 * 5.  Creates AI provider and review agents
 * 6.  Launches all agents in parallel
 * 7.  Deduplicates and merges findings
 * 8.  Posts final review comment (and inline comments if enabled)
 * 9.  Sets action outputs and optionally fails the action
 */
export async function runReview(config: ActionConfig): Promise<void> {
  // 1. Create GitHub client & commenter
  const octokit = new Octokit({ auth: config.githubToken });
  const commenter = new PRCommenter(octokit, config.owner, config.repo, config.prNumber);

  // 2. Post initial progress comment
  await commenter.postOrUpdateComment(
    '## \u23F3 AI Code Review\n\nReview starting... gathering context.',
  );
  logger.info('Posted initial progress comment');

  // 3. Gather all context
  let context: ReviewContext;
  try {
    context = await gatherAllContext(config);
    await commenter.postOrUpdateComment(
      '## \uD83D\uDD0D AI Code Review\n\n\u2705 Context gathered. Preparing agents...',
    );
    logger.info(
      `Context gathered: ${context.changedFiles.length} files, framework=${context.framework}`,
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await commenter.postOrUpdateComment(
      `## \u274C AI Code Review\n\nFailed to gather context: ${msg}`,
    );
    throw error;
  }

  // 4. Validate file count
  if (context.changedFiles.length > config.maxFilesToReview) {
    const warningMsg =
      `## \u26A0\uFE0F AI Code Review\n\n` +
      `This PR changes **${context.changedFiles.length}** files, which exceeds the configured ` +
      `maximum of **${config.maxFilesToReview}**.\n\n` +
      `Review skipped to avoid excessive processing. Adjust the \`max_files_to_review\` input ` +
      `if you want to review larger PRs.`;
    await commenter.postOrUpdateComment(warningMsg);
    core.warning(
      `Skipping review: ${context.changedFiles.length} files exceeds max of ${config.maxFilesToReview}`,
    );
    core.setOutput('review_status', 'skipped');
    core.setOutput('skip_reason', 'too_many_files');
    return;
  }

  // 5. Create AI provider and agents
  const provider = createAIProvider(config);
  const agents = createAgents(provider, config);

  if (agents.length === 0) {
    await commenter.postOrUpdateComment(
      '## \u26A0\uFE0F AI Code Review\n\nNo agents are enabled for this review. Check your `review_profile` and agent toggle settings.',
    );
    core.warning('No agents enabled \u2014 nothing to review');
    core.setOutput('review_status', 'skipped');
    core.setOutput('skip_reason', 'no_agents');
    return;
  }

  logger.info(`Running ${agents.length} agents: ${agents.map(a => a.name).join(', ')}`);

  // 6. Update progress with agent list (all queued) and launch in parallel
  for (const agent of agents) {
    await commenter.updateProgress(agent.name, 'running');
  }

  const agentPromises = agents.map(async agent => {
    logger.info(`Agent ${agent.name} starting...`);
    const result = await agent.review(context);
    await commenter.updateProgress(
      agent.name,
      result.error ? 'failed' : 'done',
    );
    logger.info(
      `Agent ${agent.name} completed in ${(result.durationMs / 1000).toFixed(1)}s ` +
        `with ${result.findings.length} findings` +
        (result.error ? ` (error: ${result.error})` : ''),
    );
    return result;
  });

  const settled = await Promise.allSettled(agentPromises);

  // 7. Collect results from settled promises
  const agentResults: AgentResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      agentResults.push(outcome.value);
    } else {
      // This shouldn't normally happen since BaseAgent.review() catches errors,
      // but handle it gracefully just in case
      const errMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      core.warning(`Agent ${agents[i].name} promise rejected: ${errMsg}`);
      agentResults.push({
        agentName: agents[i].name,
        category: agents[i].category,
        findings: [],
        summary: `Agent crashed: ${errMsg}`,
        score: 0,
        durationMs: 0,
        error: errMsg,
      });
    }
  }

  // 8. Deduplicate findings: programmatic pass first, then AI consolidation
  const allFindings = agentResults.flatMap(r => r.findings);
  const deduplicated = deduplicateFindings(allFindings);

  // AI consolidation pass — catches semantic duplicates that string matching misses
  await commenter.postOrUpdateComment(
    '## \uD83D\uDD0D AI Code Review\n\n\u2705 All agents complete. Consolidating findings...',
  );
  const consolidated = await consolidateFindings(
    deduplicated,
    provider,
    config.agentTimeout * 1000,
  );

  // Replace findings in agent results with consolidated versions
  // (distribute consolidated findings back to their original agents)
  const consolidatedResults = agentResults.map(r => ({
    ...r,
    findings: consolidated.filter(f => f.category === r.category),
  }));

  const merged = mergeResults(consolidatedResults, config);

  logger.info(
    `Review complete: ${merged.totalFindings} findings ` +
      `(${merged.criticalCount} critical, ${merged.highCount} high, ` +
      `${merged.mediumCount} medium, ${merged.lowCount} low, ${merged.nitCount} nit)`,
  );

  // 9. Format and post the final comment
  const finalComment = formatReviewComment(merged, config, context);
  const { commentId, commentUrl } = await commenter.postOrUpdateComment(finalComment);
  logger.info('Posted final review comment');
  core.setOutput('review_comment_id', commentId);
  core.setOutput('review_comment_url', commentUrl);

  // 10. Resolve stale inline comments from previous runs, then post new ones
  if (config.postInlineComments) {
    // Resolve old inline comments that are no longer relevant
    const currentFindingSummary = consolidated.map(f => ({
      file: f.file, line: f.line, title: f.title,
    }));
    await commenter.resolveStaleInlineComments(currentFindingSummary);

    // Post new inline comments for critical, high, and medium findings
    if (merged.totalFindings > 0) {
      try {
        const parsedDiffs = parseDiff(context.diff);
        const inlineReviewer = new InlineReviewer(octokit, config.owner, config.repo, config.prNumber);

        const inlineFindings = consolidated.filter(
          f => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium',
        );

        if (inlineFindings.length > 0) {
          const posted = await inlineReviewer.postReview(inlineFindings, context.headSha, parsedDiffs);
          logger.info(`Posted ${posted} inline review comments`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        core.warning(`Failed to post inline comments: ${msg}`);
      }
    }
  }

  // 11. Append AI summary to PR description (below ----AI-description---- separator)
  try {
    await appendToPRDescription(octokit, config, merged, context, provider);
    logger.info('Updated PR description with AI summary');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    core.warning(`Failed to update PR description: ${msg}`);
  }

  // 12. Set action outputs
  core.setOutput('review_status', 'completed');
  core.setOutput('total_findings', merged.totalFindings);
  core.setOutput('critical_count', merged.criticalCount);
  core.setOutput('high_count', merged.highCount);
  core.setOutput('medium_count', merged.mediumCount);
  core.setOutput('low_count', merged.lowCount);
  core.setOutput('nit_count', merged.nitCount);
  core.setOutput('review_passed', merged.passed);
  core.setOutput('duration_seconds', Math.round(merged.durationMs / 1000));
  core.setOutput('agents_run', agents.map(a => a.name).join(','));
  core.setOutput('agents_failed', agentResults.filter(r => r.error).map(r => r.agentName).join(','));

  // 13. Fail the action if threshold is breached
  if (config.failOnCritical && !merged.passed) {
    const failMsg =
      `Review failed: found ${merged.criticalCount} critical, ${merged.highCount} high, ` +
      `${merged.mediumCount} medium findings (threshold: ${config.failThreshold})`;
    core.setFailed(failMsg);
  }
}

const AI_DESCRIPTION_SEPARATOR = '----AI-description----';

/**
 * Uses the AI to generate a detailed PR description with Mermaid diagrams,
 * then appends it below the ----AI-description---- separator.
 * Everything above the separator (user's manual description) is preserved.
 */
async function appendToPRDescription(
  octokit: Octokit,
  config: ActionConfig,
  merged: MergedReviewResult,
  context: ReviewContext,
  provider: AIProvider,
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

  // Generate AI description + Mermaid diagram via AI call
  let aiGeneratedContent = '';

  try {
    const descriptionPrompt = buildDescriptionPrompt(context, merged);
    const response = await provider.chat(
      [
        { role: 'system', content: descriptionPrompt.system },
        { role: 'user', content: descriptionPrompt.user },
      ],
      { maxTokens: 4096, temperature: 0.3, timeout: 120000 },
    );
    aiGeneratedContent = sanitizeMermaid(response.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    core.warning(`Failed to generate AI description: ${msg}`);
    // Fall back to static summary
    aiGeneratedContent = buildFallbackDescription(merged, context);
  }

  // Generate rendered diagram images (D2 + mermaid.ink) if enabled
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
  if (merged.criticalCount > 0) aiParts.push(`| \uD83D\uDED1 Critical | ${merged.criticalCount} |`);
  if (merged.highCount > 0) aiParts.push(`| \uD83D\uDD34 High | ${merged.highCount} |`);
  if (merged.mediumCount > 0) aiParts.push(`| \uD83D\uDFE1 Medium | ${merged.mediumCount} |`);
  if (merged.lowCount > 0) aiParts.push(`| \uD83D\uDFE2 Low | ${merged.lowCount} |`);
  if (merged.totalFindings === 0) aiParts.push('| \u2705 None | 0 |');
  aiParts.push('');
  aiParts.push(`<sub>Last reviewed: ${new Date().toISOString()} | Model: ${config.anthropicModel} | Profile: ${config.reviewProfile}</sub>`);

  const newBody = userDescription + '\n' + aiParts.join('\n');

  await octokit.pulls.update({
    owner: config.owner,
    repo: config.repo,
    pull_number: config.prNumber,
    body: newBody,
  });
}

function buildDescriptionPrompt(
  context: ReviewContext,
  merged: MergedReviewResult,
): { system: string; user: string } {
  const system = `You are a PR description writer. Given a PR diff and review findings, generate a clear, detailed description of what this PR does. Your output should be GitHub-flavored markdown that goes directly into the PR description.

You MUST include:
1. **## What this PR does** — A detailed explanation (3-8 sentences) of what changes were made and why.
2. **## Changes** — A bullet list of specific changes made, grouped logically.
3. **## Architecture** — One or more Mermaid diagrams showing the flow or structure. Choose the BEST diagram type for the content — do NOT always default to flowchart:
   - \`sequenceDiagram\` — PREFERRED for API calls, service interactions, request/response flows, multi-step processes between components
   - \`flowchart TD\` — for decision trees, conditional logic, CI/CD pipelines, workflow triggers
   - \`graph TD\` — for file/module dependency relationships, import trees
   - \`classDiagram\` — for class hierarchies, interfaces, type relationships
   - \`stateDiagram-v2\` — for state machines, lifecycle flows
   You may include MULTIPLE diagrams if the PR involves both interactions and structure. ALWAYS generate at least one diagram.
4. **## Impact** — What existing functionality is affected, and any risks.

## CRITICAL Mermaid Syntax Rules — Follow EXACTLY or the diagram will break:

1. **Quote ALL labels** with double quotes — every node and edge label, no exceptions:
   \`A["Label"] --> B["Label"]\`
2. **Edge labels use PIPE syntax** — \`-->|"label"|\` with pipes, NEVER commas:
   - CORRECT: \`A -->|"Yes"| B\`
   - WRONG:  \`A -->, "Yes", B\` (this WILL break)
   - WRONG:  \`A -->|Yes| B\` (missing quotes)
3. **No special characters unquoted** — always wrap in double quotes
4. **No HTML tags** — no \`<br/>\`, \`<b>\`, etc.
5. **Short labels** — max 4-5 words per node
6. **Simple IDs** — single letters: A, B, C, D, E, F

COPY THIS EXACT PATTERN for flowcharts:
\`\`\`mermaid
flowchart TD
  A["Step One"] --> B{"Decision"}
  B -->|"Yes"| C["Action"]
  B -->|"No"| D["Other Action"]
  C --> E["Result"]
\`\`\`

COPY THIS EXACT PATTERN for sequence diagrams:
\`\`\`mermaid
sequenceDiagram
  participant A as Service A
  participant B as Service B
  A->>B: Request
  B-->>A: Response
\`\`\`

Keep it professional, specific, and useful for reviewers. Do NOT include review findings — those are shown separately.
Output raw markdown only — no code fences wrapping the entire output.`;

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
      const content = file.content && file.content.length > 5000
        ? file.content.substring(0, 5000) + '\n... (truncated)'
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

  return { system, user };
}

function buildFallbackDescription(
  merged: MergedReviewResult,
  context: ReviewContext,
): string {
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

/**
 * Sanitizes Mermaid diagrams in AI-generated content by fixing common
 * syntax issues that cause GitHub rendering failures.
 * Processes line-by-line for reliability.
 */
function sanitizeMermaid(content: string): string {
  return content.replace(/```mermaid\n([\s\S]*?)```/g, (_fullMatch, diagram: string) => {
    const lines = (diagram as string).split('\n');
    const fixedLines = lines.map(line => {
      // Remove HTML tags (<br/>, <b>, etc.)
      line = line.replace(/<[^>]+>/g, ' ');

      // Fix ALL malformed edge label patterns the AI generates:
      //   -->, "Yes",   →  -->|"Yes"|
      //   -->, "Yes"|   →  -->|"Yes"|
      //   -->, "No",    →  -->|"No"|
      //   --> , "Yes" ,  →  -->|"Yes"|
      line = line.replace(
        /-->\s*,\s*"([^"]*)"\s*[,|]?\s*/g,
        '-->|"$1"| ',
      );

      // Fix unquoted edge labels: -->|Yes| → -->|"Yes"|
      line = line.replace(
        /-->\|([^"|]+)\|/g,
        '-->|"$1"|',
      );

      // Fix unquoted node labels with special chars: ID[a/b] → ID["a/b"]
      line = line.replace(
        /(\w+)\[([^\]"]*[\[\]{}()<>\/|&#][^\]"]*)\]/g,
        (_, id, label) => `${id}["${label.replace(/"/g, "'")}"]`,
      );

      // Fix unquoted diamond labels: ID{a/b} → ID{"a/b"}
      line = line.replace(
        /(\w+)\{([^}"]*[\[\]()<>\/|&#][^}"]*)\}/g,
        (_, id, label) => `${id}{"${label.replace(/"/g, "'")}"}`,
      );

      // Remove pipe chars inside quoted labels (breaks Mermaid)
      line = line.replace(/"([^"]*)\|([^"]*)"/g, (_, a, b) => `"${a}, ${b}"`);

      return line;
    });

    return '```mermaid\n' + fixedLines.join('\n') + '```';
  });
}
