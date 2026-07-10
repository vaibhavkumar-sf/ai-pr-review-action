import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ActionConfig, ReviewContext } from '../types';
import { AIProvider } from '../providers/ai-provider';
import { PRCommenter } from './pr-commenter';
import { INLINE_COMMENT_MARKER } from './inline-reviewer';

export const REPLY_MARKER = '<!-- ai-pr-review-reply -->';

const CODE_CONTEXT_LINES = 60;

const VERDICT_SYSTEM_PROMPT = `You are a code review discussion arbiter. A previous AI code review posted a finding as an inline PR comment, and a human has replied to it (disagreeing, claiming it is fixed, asking a question, or adding context).

Your job: verify the human's reply against the CURRENT code and decide whether they are correct.

Rules:
1. Judge strictly from the code provided — never take the human's claim on faith, and never dismiss it without checking the code.
2. If the human is correct (the finding was wrong, doesn't apply, or the issue is now fixed in the code), acknowledge it plainly and say why.
3. If the human is incorrect or the issue still exists, explain exactly why with reference to the current code (line numbers, identifiers).
4. If the reply is a question, answer it concretely from the code.
5. Be respectful and concise (2-5 sentences). No headings, no severity tags — this is a conversation reply.

Return ONLY valid JSON:
{
  "user_is_correct": true|false,
  "issue_resolved": true|false,
  "reply": "The markdown reply to post in the thread"
}

"user_is_correct" = their objection/claim is valid. "issue_resolved" = the original issue no longer exists in the current code (whether or not the human argued it). Resolve-worthy threads are those where either is true.`;

interface ThreadComment {
  databaseId: number | null;
  author: { login: string } | null;
  body: string;
  path: string;
  line: number | null;
  createdAt: string;
}

interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: { nodes: ThreadComment[] };
}

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
    const botLoginVariant = user.replace('[bot]', '');
    const isOurLogin = (login: string): boolean =>
      login === user || login === botLoginVariant;
    const isHuman = (login: string): boolean =>
      !isOurLogin(login) && !login.endsWith('[bot]') && !/^(github-actions|sonarqubecloud|sonarcloud|dependabot|renovate)$/.test(login);

    let threads: ReviewThread[];
    try {
      const data: {
        repository: { pullRequest: { reviewThreads: { nodes: ReviewThread[] } } };
      } = await this.octokit.graphql(`
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  comments(first: 30) {
                    nodes {
                      databaseId
                      author { login }
                      body
                      path
                      line
                      createdAt
                    }
                  }
                }
              }
            }
          }
        }
      `, { owner: this.config.owner, repo: this.config.repo, number: this.config.prNumber });
      threads = data.repository.pullRequest.reviewThreads.nodes;
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
          { role: 'system', content: VERDICT_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        { maxTokens: 2048, temperature: 0.2, timeout: this.config.agentTimeout * 1000 },
      );

      const jsonStart = response.content.indexOf('{');
      const jsonEnd = response.content.lastIndexOf('}');
      if (jsonStart === -1 || jsonEnd === -1) return null;
      const parsed = JSON.parse(response.content.substring(jsonStart, jsonEnd + 1));
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
    const start = Math.max(0, line - 1 - CODE_CONTEXT_LINES);
    const end = Math.min(lines.length, line + CODE_CONTEXT_LINES);
    const padding = String(end).length;
    return lines
      .slice(start, end)
      .map((text, i) => `${String(start + i + 1).padStart(padding)} | ${text}`)
      .join('\n');
  }
}

function stripMarkers(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '').trim();
}
