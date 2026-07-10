import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ActionConfig, ReviewContext } from '../types';
import { AIProvider } from '../providers/ai-provider';
import { PRCommenter } from './pr-commenter';
import { INLINE_COMMENT_MARKER } from './inline-reviewer';
import { fetchReviewThreads, makeLoginMatchers, ReviewThread, ThreadComment } from './threads';
import { extractJsonObject } from '../utils/json';
import { addLineNumbers } from '../utils/text';
import { loadPrompt } from '../prompts/loader';
import { REPLY_CODE_CONTEXT_LINES, REPLY_VERDICT_MAX_TOKENS } from '../config/limits';

export const REPLY_MARKER = '<!-- ai-pr-review-reply -->';

export interface ReplyHandlingResult {
  repliesPosted: number;
  threadsResolved: number;
}

/**
 * Handles human replies on our previous inline review threads:
 * verifies each claim against the current code with an AI call, posts a
 * justification reply in EVERY thread that has an unanswered human reply,
 * and resolves the thread when the human is right or the issue is fixed.
 *
 * Fault-tolerant: any per-thread failure is logged and skipped.
 */
export class ReplyHandler {
  constructor(
    private octokit: Octokit,
    private commenter: PRCommenter,
    private provider: AIProvider,
    private config: ActionConfig,
  ) {}

  async processReplies(context: ReviewContext): Promise<ReplyHandlingResult> {
    const result: ReplyHandlingResult = { repliesPosted: 0, threadsResolved: 0 };

    const user = await this.commenter.getAuthenticatedUser();
    if (!user) return result;
    const { isOurLogin, isHuman } = makeLoginMatchers(user);

    let threads: ReviewThread[];
    try {
      threads = await fetchReviewThreads(this.octokit, this.config.owner, this.config.repo, this.config.prNumber);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Reply handling: failed to fetch review threads: ${msg}`);
      return result;
    }

    for (const thread of threads) {
      if (thread.isResolved) continue;
      const comments = thread.comments.nodes;
      const first = comments[0];
      if (!first) continue;

      // Our threads only
      const isOurs = first.body.includes(INLINE_COMMENT_MARKER) ||
        isOurLogin(first.author?.login ?? '');
      if (!isOurs) continue;

      // Needs a response: at least one human reply, and the human spoke last
      const hasHumanReply = comments.slice(1).some(c => isHuman(c.author?.login ?? ''));
      const last = comments[comments.length - 1];
      if (!hasHumanReply || !isHuman(last.author?.login ?? '')) continue;

      try {
        const handled = await this.handleThread(thread, context);
        if (handled.replied) result.repliesPosted++;
        if (handled.resolved) result.threadsResolved++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        core.warning(`Reply handling failed for thread at ${first.path}:${first.line}: ${msg}`);
      }
    }

    if (result.repliesPosted > 0) {
      core.info(
        `Reply handling: posted ${result.repliesPosted} justification repl${result.repliesPosted === 1 ? 'y' : 'ies'}, ` +
          `resolved ${result.threadsResolved} thread(s)`,
      );
    }

    return result;
  }

  private async handleThread(
    thread: ReviewThread,
    context: ReviewContext,
  ): Promise<{ replied: boolean; resolved: boolean }> {
    const comments = thread.comments.nodes;
    const first = comments[0];
    const path = first.path;
    const line = first.line ?? 0;

    const code = await this.getCodeContext(path, line, context);
    const verdict = await this.getVerdict(first, comments.slice(1), path, line, code);
    if (!verdict) return { replied: false, resolved: false };

    // Reply to the thread's top-level comment
    let replied = false;
    if (first.databaseId) {
      const shouldResolve = verdict.user_is_correct || verdict.issue_resolved;
      const footer = shouldResolve
        ? '\n\n_Resolving this thread._'
        : '';
      await this.octokit.pulls.createReplyForReviewComment({
        owner: this.config.owner,
        repo: this.config.repo,
        pull_number: this.config.prNumber,
        comment_id: first.databaseId,
        body: `${REPLY_MARKER}\n${verdict.reply}${footer}`,
      });
      replied = true;
    }

    let resolved = false;
    if (verdict.user_is_correct || verdict.issue_resolved) {
      resolved = (await this.commenter.resolveThread(thread.id)) > 0;
    }

    return { replied, resolved };
  }

  private async getVerdict(
    original: ThreadComment,
    replies: ThreadComment[],
    path: string,
    line: number,
    code: string,
  ): Promise<{ user_is_correct: boolean; issue_resolved: boolean; reply: string } | null> {
    let user = `## Original review finding (posted by the AI reviewer)\n`;
    user += `File: ${path}, line ${line}\n\n${stripMarkers(original.body)}\n\n`;
    user += `## Conversation replies (oldest first)\n\n`;
    for (const reply of replies) {
      user += `**@${reply.author?.login ?? 'unknown'}** (${reply.createdAt}):\n${stripMarkers(reply.body)}\n\n`;
    }
    user += `## Current code at ${path} (with line numbers)\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
    user += `Verify the human's reply against this code and return the JSON verdict.`;

    try {
      const response = await this.provider.chat(
        [
          { role: 'system', content: loadPrompt('system/reply-verdict') },
          { role: 'user', content: user },
        ],
        {
          maxTokens: REPLY_VERDICT_MAX_TOKENS,
          temperature: this.config.temperature,
          timeout: this.config.agentTimeout * 1000,
        },
      );

      const jsonStr = extractJsonObject(response.content);
      if (!jsonStr) return null;
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) return null;

      return {
        user_is_correct: parsed.user_is_correct === true,
        issue_resolved: parsed.issue_resolved === true,
        reply: parsed.reply.trim(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Reply verdict AI call failed for ${path}:${line}: ${msg}`);
      return null;
    }
  }

  /**
   * Returns the current file content around the thread's line, numbered.
   * Prefers the already-fetched changed-file content; falls back to the
   * GitHub contents API at the head SHA (the file may not be in this diff).
   */
  private async getCodeContext(path: string, line: number, context: ReviewContext): Promise<string> {
    let content = context.changedFiles.find(f => f.filename === path)?.content;

    if (!content) {
      try {
        const { data } = await this.octokit.repos.getContent({
          owner: this.config.owner,
          repo: this.config.repo,
          path,
          ref: context.headSha,
        });
        if (!Array.isArray(data) && 'content' in data && data.content) {
          content = Buffer.from(data.content, 'base64').toString('utf-8');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        core.debug(`Could not fetch ${path}@${context.headSha}: ${msg}`);
      }
    }

    if (!content) return '(file content unavailable)';

    const lines = content.split('\n');
    const start = Math.max(0, line - 1 - REPLY_CODE_CONTEXT_LINES);
    const end = Math.min(lines.length, line + REPLY_CODE_CONTEXT_LINES);
    return addLineNumbers(lines.slice(start, end).join('\n'), start + 1);
  }
}

function stripMarkers(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '').trim();
}
