import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ReviewCategory } from '../types';
import { INLINE_COMMENT_MARKER } from './inline-reviewer';
import { fetchReviewThreads, KNOWN_BOT_LOGINS, makeLoginMatchers, minimizeCommentById, resolveReviewThreadById } from './threads';
import { AGENT_LABELS } from '../config/taxonomy';
import { BOT_HIDE_ALL_PATTERNS } from '../config/patterns';
import { GITHUB_PER_PAGE, STALE_THREAD_PROXIMITY } from '../config/limits';

const COMMENT_MARKER = '<!-- ai-pr-review-action-comment -->';

type AgentStatus = 'running' | 'done' | 'failed';

export class PRCommenter {
  private agentStatuses: Map<string, AgentStatus> = new Map();
  private currentCommentId: number | null = null;
  private authenticatedUser: string | null = null;

  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    private prNumber: number,
  ) {}

  /**
   * Posts a new comment or updates the one created during THIS run.
   * On the first call of a new run, minimizes any previous AI review summary
   * comments (our own only) and creates a fresh one.
   */
  async postOrUpdateComment(body: string): Promise<{ commentId: number; commentUrl: string }> {
    const markedBody = `${COMMENT_MARKER}\n${body}`;

    // If we already have a comment from THIS run, update it
    if (this.currentCommentId) {
      const updated = await this.octokit.issues.updateComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: this.currentCommentId,
        body: markedBody,
      });
      return { commentId: updated.data.id, commentUrl: updated.data.html_url };
    }

    // First call this run — minimize old summary comments, then create new
    await this.minimizeOldSummaryComments();

    const created = await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: this.prNumber,
      body: markedBody,
    });

    this.currentCommentId = created.data.id;
    return { commentId: created.data.id, commentUrl: created.data.html_url };
  }

  async updateProgress(agentName: string, status: AgentStatus): Promise<void> {
    this.agentStatuses.set(agentName, status);

    const allDone = Array.from(this.agentStatuses.values()).every(
      (s) => s === 'done' || s === 'failed',
    );

    const statusLabel = allDone ? 'Consolidating...' : 'In Progress';
    const headerEmoji = allDone ? '⚙️' : '🔍';

    let body = `## ${headerEmoji} AI Code Review — ${statusLabel}\n\n`;
    body += '| Agent | Status |\n';
    body += '|-------|--------|\n';

    for (const [name, agentStatus] of this.agentStatuses) {
      const label = AGENT_LABELS[name as ReviewCategory] ?? name;
      body += `| ${label} | ${formatStatus(agentStatus)} |\n`;
    }

    await this.postOrUpdateComment(body);
  }

  /**
   * Resolves inline review comment threads from previous runs that are no
   * longer relevant — the issue was fixed or the code at that location no
   * longer exists in the current diff.
   *
   * Only resolves OUR OWN threads, never other reviewers'.
   */
  async resolveStaleInlineComments(
    currentFindings: Array<{ file: string; line: number; title: string }>,
  ): Promise<number> {
    const user = await this.getAuthenticatedUser();
    if (!user) return 0;

    let resolved = 0;

    try {
      const threads = await fetchReviewThreads(this.octokit, this.owner, this.repo, this.prNumber);
      const { isOurLogin, isHuman } = makeLoginMatchers(user);

      // Collect our unresolved threads
      const ourThreads: Array<{ id: string; path: string; line: number; body: string }> = [];

      for (const thread of threads) {
        if (thread.isResolved) continue;
        const firstComment = thread.comments.nodes[0];
        if (!firstComment) continue;

        const isOurs = firstComment.body.includes(INLINE_COMMENT_MARKER) ||
          isOurLogin(firstComment.author?.login ?? '');
        if (!isOurs) continue;

        // A human replied after our last message — the reply handler owns this
        // thread now; never auto-resolve it out from under the conversation
        const lastComment = thread.comments.nodes[thread.comments.nodes.length - 1];
        if (isHuman(lastComment.author?.login ?? '')) continue;

        ourThreads.push({
          id: thread.id,
          path: firstComment.path,
          line: firstComment.line ?? 0,
          body: firstComment.body,
        });
      }

      // Step 1: Resolve duplicate threads at the same file+line (keep only the latest)
      const locationMap = new Map<string, typeof ourThreads>();
      for (const thread of ourThreads) {
        const key = `${thread.path}:${thread.line}`;
        const existing = locationMap.get(key) || [];
        existing.push(thread);
        locationMap.set(key, existing);
      }

      const threadsToKeep = new Set<string>();
      for (const [, threadsAtLocation] of locationMap) {
        // Keep only the last thread (most recent), resolve all earlier ones
        threadsToKeep.add(threadsAtLocation[threadsAtLocation.length - 1].id);
        for (let i = 0; i < threadsAtLocation.length - 1; i++) {
          resolved += await this.resolveThread(threadsAtLocation[i].id);
        }
      }

      // Step 2: Resolve threads where the issue is no longer in current findings
      for (const thread of ourThreads) {
        if (!threadsToKeep.has(thread.id)) continue; // Already resolved as duplicate

        const stillRelevant = currentFindings.some(
          f => f.file === thread.path &&
               Math.abs(f.line - thread.line) <= STALE_THREAD_PROXIMITY,
        );

        if (!stillRelevant) {
          resolved += await this.resolveThread(thread.id);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Failed to resolve stale inline comments: ${msg}`);
    }

    if (resolved > 0) {
      core.info(`Resolved ${resolved} stale inline comment(s) from previous review`);
    }

    return resolved;
  }

  async resolveThread(threadId: string): Promise<number> {
    try {
      await resolveReviewThreadById(this.octokit, threadId);
      return 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.debug(`Failed to resolve thread: ${msg}`);
      return 0;
    }
  }

  /**
   * Minimize noisy recurring bot comments on the PR:
   * - Comments matching BOT_HIDE_ALL_PATTERNS are hidden on every occurrence.
   * - Any other recurring bot comment type (grouped by bot login + first
   *   heading line) keeps only the latest occurrence; older ones are hidden.
   *
   * Our own marker comments are never touched (they're handled by
   * minimizeOldSummaryComments), and already-minimized comments are skipped.
   */
  async cleanupBotComments(): Promise<number> {
    let hidden = 0;

    try {
      interface PrCommentNode {
        id: string;
        isMinimized: boolean;
        createdAt: string;
        body: string;
        author: { login: string } | null;
      }

      const allComments: PrCommentNode[] = [];
      let cursor: string | null = null;

      do {
        const page: {
          repository: {
            pullRequest: {
              comments: {
                nodes: PrCommentNode[];
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            };
          };
        } = await this.octokit.graphql(`
          query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                comments(first: ${GITHUB_PER_PAGE}, after: $cursor) {
                  nodes {
                    id
                    isMinimized
                    createdAt
                    body
                    author { login }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        `, { owner: this.owner, repo: this.repo, number: this.prNumber, cursor });

        const connection = page.repository.pullRequest.comments;
        allComments.push(...connection.nodes);
        cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      } while (cursor);

      // GraphQL author logins have no '[bot]' suffix; bots are typed as "Bot"
      // but login-based matching covers the common CI bots reliably
      const BOT_LOGINS = new RegExp(`\\[bot\\]$|${KNOWN_BOT_LOGINS.source}`);
      const botComments = allComments.filter(c =>
        !c.isMinimized &&
        BOT_LOGINS.test(c.author?.login ?? '') &&
        !c.body.includes(COMMENT_MARKER),
      );

      const toHide: PrCommentNode[] = [];
      const recurring = new Map<string, PrCommentNode[]>();

      for (const comment of botComments) {
        if (BOT_HIDE_ALL_PATTERNS.some(pattern => comment.body.includes(pattern))) {
          toHide.push(comment);
          continue;
        }
        // Group recurring types by bot login + normalized first heading line
        const heading = (comment.body.split('\n').find(l => l.trim()) ?? '')
          .replace(/[#*_`\u{1F300}-\u{1FAFF}✀-➿]/gu, '')
          .trim()
          .toLowerCase()
          .substring(0, 60);
        const key = `${comment.author?.login ?? ''}|${heading}`;
        const group = recurring.get(key) ?? [];
        group.push(comment);
        recurring.set(key, group);
      }

      // Keep only the latest of each recurring type
      for (const group of recurring.values()) {
        if (group.length < 2) continue;
        group.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        toHide.push(...group.slice(0, -1));
      }

      for (const comment of toHide) {
        try {
          await minimizeCommentById(this.octokit, comment.id);
          hidden++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          core.debug(`Failed to minimize bot comment: ${msg}`);
        }
      }

      if (hidden > 0) {
        core.info(`Minimized ${hidden} noisy bot comment(s)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Bot comment cleanup failed: ${msg}`);
    }

    return hidden;
  }

  /**
   * Minimize (collapse) previous AI review summary comments (our own only).
   * Uses GraphQL minimizeComment with OUTDATED classifier to hide them,
   * preserving history while keeping the PR clean.
   */
  private async minimizeOldSummaryComments(): Promise<void> {
    const user = await this.getAuthenticatedUser();
    try {
      const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
        owner: this.owner,
        repo: this.repo,
        issue_number: this.prNumber,
        per_page: GITHUB_PER_PAGE,
      });

      for (const comment of comments) {
        if (!comment.body?.includes(COMMENT_MARKER)) continue;
        // Only minimize our own comments
        if (user && comment.user?.login !== user) continue;

        try {
          await minimizeCommentById(this.octokit, comment.node_id);
          core.debug(`Minimized old summary comment ${comment.id}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          core.debug(`Failed to minimize comment ${comment.id}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Failed to minimize old summary comments: ${msg}`);
    }
  }

  async getAuthenticatedUser(): Promise<string | null> {
    if (this.authenticatedUser) return this.authenticatedUser;
    try {
      const { data } = await this.octokit.users.getAuthenticated();
      this.authenticatedUser = data.login;
      return data.login;
    } catch {
      this.authenticatedUser = 'github-actions[bot]';
      return 'github-actions[bot]';
    }
  }
}

function formatStatus(status: AgentStatus): string {
  switch (status) {
    case 'running':
      return '⏳ Running...';
    case 'done':
      return '✅ Done';
    case 'failed':
      return '❌ Failed';
  }
}
