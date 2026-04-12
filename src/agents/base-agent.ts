import { AIProvider, ChatMessage } from '../providers/ai-provider';
import { ActionConfig, AgentResult, Finding, ReviewCategory, ReviewContext } from '../types';
import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly category: ReviewCategory;
  abstract readonly displayName: string;
  abstract readonly icon: string;

  constructor(
    protected provider: AIProvider,
    protected config: ActionConfig,
  ) {}

  async review(context: ReviewContext): Promise<AgentResult> {
    const startTime = Date.now();
    try {
      const messages = this.buildMessages(context);
      const response = await this.provider.chat(messages, {
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        timeout: this.config.agentTimeout * 1000,
      });

      const parsed = this.parseResponse(response.content);
      return {
        agentName: this.name,
        category: this.category,
        findings: parsed.findings,
        summary: parsed.summary,
        score: parsed.score,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      core.warning(`Agent ${this.name} failed: ${errMsg}`);
      return {
        agentName: this.name,
        category: this.category,
        findings: [],
        summary: `Agent failed: ${errMsg}`,
        score: 0,
        durationMs: Date.now() - startTime,
        error: errMsg,
      };
    }
  }

  protected buildMessages(context: ReviewContext): ChatMessage[] {
    const systemPrompt = this.buildSystemPrompt(context);
    const userPrompt = this.buildUserPrompt(context);

    return [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt },
    ];
  }

  protected buildSystemPrompt(context: ReviewContext): string {
    // Load the agent's markdown prompt file
    let prompt = this.loadPromptFile(`${this.name}.md`);

    // Append framework-specific prompt if applicable
    if (context.framework === 'angular' || context.framework === 'both') {
      const angularPrompt = this.loadPromptFile('angular-additions.md');
      if (angularPrompt) prompt += '\n\n' + angularPrompt;
      if (this.config.angularPromptAppend) {
        prompt += '\n\n## Additional Angular Instructions (from user)\n' + this.config.angularPromptAppend;
      }
    }
    if (context.framework === 'loopback4' || context.framework === 'both') {
      const lb4Prompt = this.loadPromptFile('loopback4-additions.md');
      if (lb4Prompt) prompt += '\n\n' + lb4Prompt;
      if (this.config.loopback4PromptAppend) {
        prompt += '\n\n## Additional LoopBack4 Instructions (from user)\n' + this.config.loopback4PromptAppend;
      }
    }

    // Apply system prompt override or append
    if (this.config.systemPromptOverride) {
      prompt = this.config.systemPromptOverride;
    } else if (this.config.systemPromptAppend) {
      prompt += '\n\n## Additional Instructions (from user)\n' + this.config.systemPromptAppend;
    }

    // Add CLAUDE.md context if available
    if (context.repoContext.claudeMdContent) {
      prompt += '\n\n## Project-Specific Context (from CLAUDE.md)\n' + context.repoContext.claudeMdContent;
    }

    // Add JIRA context if available
    if (context.jiraContext) {
      prompt += '\n\n## JIRA Ticket Context\n';
      prompt += `Ticket: ${context.jiraContext.ticketId}\n`;
      prompt += `Summary: ${context.jiraContext.summary}\n`;
      prompt += `Status: ${context.jiraContext.status}\n`;
      prompt += `Type: ${context.jiraContext.type}\n`;
      if (context.jiraContext.description) {
        prompt += `Description: ${context.jiraContext.description}\n`;
      }
      if (context.jiraContext.acceptanceCriteria) {
        prompt += `Acceptance Criteria: ${context.jiraContext.acceptanceCriteria}\n`;
      }
    }

    return prompt;
  }

  protected buildUserPrompt(context: ReviewContext): string {
    let userPrompt = `## Pull Request Information\n`;
    userPrompt += `- **Title:** ${context.prTitle}\n`;
    userPrompt += `- **Author:** ${context.prAuthor}\n`;
    userPrompt += `- **Base Branch:** ${context.baseBranch}\n`;
    userPrompt += `- **Head Branch:** ${context.headBranch}\n`;
    userPrompt += `- **Framework:** ${context.framework}\n\n`;

    if (context.prBody) {
      userPrompt += `## PR Description\n${context.prBody}\n\n`;
    }

    userPrompt += `## Diff\n\`\`\`diff\n${context.diff}\n\`\`\`\n\n`;

    // Include full file contents WITH LINE NUMBERS for accurate line references
    const filesToInclude = context.changedFiles.filter(f => f.content && f.status !== 'removed');
    if (filesToInclude.length > 0) {
      userPrompt += `## Full File Contents (with line numbers)\n\n`;
      userPrompt += `> Line numbers are shown at the start of each line. Use these EXACT line numbers in your findings.\n\n`;
      for (const file of filesToInclude) {
        const content = file.content || '';
        const truncated = content.length > 10000
          ? content.substring(0, 10000) + '\n... (truncated)'
          : content;
        const numbered = addLineNumbers(truncated);
        userPrompt += `### ${file.filename}\n\`\`\`\n${numbered}\n\`\`\`\n\n`;
      }
    }

    // Include dependency files (imported by changed files, not changed themselves)
    if (context.dependencyFiles && context.dependencyFiles.length > 0) {
      userPrompt += `## Referenced Dependency Files (not changed, for context only)\n\n`;
      userPrompt += `> These files are imported by the changed files. Review them for context `;
      userPrompt += `(e.g., interfaces, models, types) but do NOT flag issues in these files — `;
      userPrompt += `only flag issues in the changed files shown in the diff above.\n\n`;
      for (const dep of context.dependencyFiles) {
        userPrompt += `### ${dep.filename}\n`;
        userPrompt += `*Referenced by: ${dep.referencedBy.join(', ')}*\n`;
        userPrompt += `\`\`\`\n${addLineNumbers(dep.content)}\n\`\`\`\n\n`;
      }
    }

    userPrompt += `\nPlease review the code changes and provide your findings in the specified JSON format.`;
    userPrompt += `\n\nCRITICAL LINE NUMBER RULES:`;
    userPrompt += `\n- Each file above has line numbers at the start of each line (e.g., "  26 | uses: ...")`;
    userPrompt += `\n- You MUST use these EXACT line numbers in your findings' "line" field`;
    userPrompt += `\n- Do NOT guess or estimate line numbers — read them from the numbered file content`;
    userPrompt += `\n- The "line" field must match the line number shown in the file, not the diff position`;
    userPrompt += `\n- Only flag issues in the CHANGED files (shown in the diff)`;
    userPrompt += `\n- Do NOT flag issues in dependency files — they are provided for context only`;
    userPrompt += `\n\nCRITICAL CODE SUGGESTION RULES:`;
    userPrompt += `\n- The "code_suggestion" field is used in GitHub's \`\`\`suggestion\`\`\` blocks, which REPLACE the original line(s)`;
    userPrompt += `\n- A code_suggestion REPLACES the line at the given line number. It does NOT insert before or after.`;
    userPrompt += `\n- ONLY provide code_suggestion when you are changing the EXISTING code at that exact line`;
    userPrompt += `\n- Do NOT provide code_suggestion for "add missing X" findings (e.g., add a checkout step, add a new function). Use the "suggestion" text field to explain what to add instead`;
    userPrompt += `\n- Do NOT provide code_suggestion that is IDENTICAL to the original code — that is a no-op and wastes the reviewer's time`;
    userPrompt += `\n- The code_suggestion must be a valid replacement for the line(s) at the specified line number. Read the file content to verify what is actually at that line before writing a suggestion`;
    userPrompt += `\n- You MUST preserve the EXACT indentation (leading spaces/tabs) of the original line`;
    userPrompt += `\n- Example: if the original line is "          debug: 'false'" (10 spaces), your suggestion must also start with 10 spaces`;
    userPrompt += `\n- NEVER strip or change indentation — GitHub will render it as a replacement, so wrong indentation breaks the file`;
    userPrompt += `\n- If unsure whether your code_suggestion is correct, OMIT it and use the "suggestion" text field instead`;
    userPrompt += `\n\nCONFIGURATION & WORKFLOW FILE RULES:`;
    userPrompt += `\n- In GitHub Actions workflow YAML files, all \`with:\` input values are STRINGS. Using quotes around 'false' or 'true' is CORRECT syntax — do NOT suggest removing quotes`;
    userPrompt += `\n- Do NOT flag intentional configuration choices (e.g., fail_on_critical: 'false', debug: 'false', review_profile: 'standard') — these are deliberate settings chosen by the developer`;
    userPrompt += `\n- Do NOT suggest changing config values like review_profile, fail_on_critical, or debug — the developer chose these values intentionally`;
    userPrompt += `\n- Do NOT flag standard GitHub Actions boilerplate as issues: permissions blocks, concurrency groups, cancel-in-progress, if-guards for bot PRs, branch name filters — these are standard patterns`;
    userPrompt += `\n- Do NOT suggest "optimization" changes to workflow files like adding \`paths:\` filters, adding checkout steps, changing trigger types, or other structural workflow improvements — these are architectural choices, not code quality issues`;
    userPrompt += `\n- For .yml/.yaml workflow files, ONLY flag: hardcoded secrets, unpinned action versions (@main vs SHA), script injection ($\{\{ }} in run: steps), overly broad permissions (write-all)`;
    userPrompt += `\n- For workflow files, OMIT code_suggestion entirely for most findings — workflow YAML structure is too complex for single-line replacements. Use the "suggestion" text field to explain what to do instead`;
    userPrompt += `\n- NEVER place a code_suggestion on a line that doesn't contain the code you're fixing. If your finding is about a missing feature (e.g., "add a checkout step"), do NOT provide code_suggestion — it would replace an unrelated line`;

    return userPrompt;
  }

  protected loadPromptFile(filename: string): string {
    // Try multiple locations: /app/prompts (Docker), ./prompts (local), relative to this file
    const locations = [
      path.join('/app/prompts', filename),
      path.join(process.cwd(), 'prompts', filename),
      path.join(__dirname, '../../prompts', filename),
    ];

    for (const loc of locations) {
      try {
        return fs.readFileSync(loc, 'utf-8');
      } catch {
        continue;
      }
    }

    core.warning(`Prompt file ${filename} not found in any location`);
    return '';
  }

  protected parseResponse(content: string): { findings: Finding[]; summary: string; score: number } {
    try {
      // Try to extract JSON from the response (may be wrapped in markdown code blocks)
      const jsonMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, content];
      const jsonStr = jsonMatch[1] || content;

      // Find the JSON object in the string
      const startIdx = jsonStr.indexOf('{');
      const endIdx = jsonStr.lastIndexOf('}');
      if (startIdx === -1 || endIdx === -1) {
        throw new Error('No JSON object found in response');
      }

      const parsed = JSON.parse(jsonStr.substring(startIdx, endIdx + 1));

      const validSeverities = new Set(['critical', 'high', 'medium', 'low', 'nit']);

      const findings: Finding[] = (parsed.findings || []).map((f: Record<string, unknown>) => ({
        severity: validSeverities.has(f.severity as string) ? f.severity as Finding['severity'] : 'medium',
        category: this.category,
        file: f.file || '',
        line: f.line || 0,
        endLine: f.endLine || f.end_line,
        title: f.title || 'Untitled finding',
        description: f.description || '',
        suggestion: f.suggestion,
        codeSuggestion: f.code_suggestion || f.codeSuggestion,
      }));

      return {
        findings,
        summary: parsed.summary || '',
        score: typeof parsed.score === 'number' ? parsed.score : 5,
      };
    } catch (error) {
      core.warning(
        `Failed to parse ${this.name} agent response: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { findings: [], summary: 'Failed to parse response', score: 0 };
    }
  }
}

/**
 * Prepends line numbers to each line of content (1-indexed, right-aligned).
 * Example output: "   1 | const x = 1;\n   2 | const y = 2;"
 */
function addLineNumbers(content: string): string {
  const lines = content.split('\n');
  const padding = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(padding)} | ${line}`)
    .join('\n');
}
