import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ReviewCategory } from '../types';
import { INLINE_COMMENT_MARKER } from './inline-reviewer';

const COMMENT_MARKER = '<!-- ai-pr-review-action-comment -->';

interface AgentStatus {
  status: 'running' | 'done' | 'failed';
  findingCount?: number;
}

const AGENT_LABELS: Record<ReviewCategory, string> = {
  'security': '\uD83D\uDD12 Security',
  'code-quality': '\uD83D\uDCDD Code Quality',
  'performance': '\u26A1 Performance',
  'type-safety': '\uD83D\uDD0D Type Safety',
  'architecture': '\uD83C\uDFD7\uFE0F Architecture',
  'testing': '\uD83E\uDDEA Testing',
  'api-design': '\uD83D\uDD0C API Design',
};

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
   * On the first call of a new run, deletes any previous AI review summary
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

    // First call this run — delete old summary comments, then create new
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

  async updateProgress(
    agentName: string,
    status: 'running' | 'done' | 'failed',
    findingCount?: number,
  ): Promise<void> {
    this.agentStatuses.set(agentName, { status, findingCount });

    const allDone = Array.from(this.agentStatuses.values()).every(
      (s) => s.status === 'done' || s.status === 'failed',
    );

    const statusLabel = allDone ? 'Consolidating...' : 'In Progress';
    const headerEmoji = allDone ? '\u2699\uFE0F' : '\uD83D\uDD0D';

    let body = `## ${headerEmoji} AI Code Review \u2014 ${statusLabel}\n\n`;
    body += '| Agent | Status |\n';
    body += '|-------|--------|\n';

    for (const [name, agentStatus] of this.agentStatuses) {
      const label = AGENT_LABELS[name as ReviewCategory] ?? name;
      const statusText = this.formatStatus(agentStatus);
      body += `| ${label} | ${statusText} |\n`;
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
      const result = await this.octokit.graphql<{
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array<{
                id: string;
                isResolved: boolean;
                comments: {
                  nodes: Array<{
                    author: { login: string };
                    body: string;
                    path: string;
                    line: number | null;
                  }>;
                };
              }>;
            };
          };
        };
      }>(`
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                nodes {
                  id
                  isResolved
                  comments(first: 1) {
                    nodes {
                      author { login }
                      body
                      path
                      line
                    }
                  }
                }
              }
            }
          }
        }
      `, { owner: this.owner, repo: this.repo, number: this.prNumber });

      const threads = result.repository.pullRequest.reviewThreads.nodes;

      // Collect our unresolved threads
      // GraphQL returns 'github-actions', REST returns 'github-actions[bot]' — handle both
      const botLoginVariant = user.replace('[bot]', '');
      const ourThreads: Array<{ id: string; path: string; line: number; body: string }> = [];

      for (const thread of threads) {
        if (thread.isResolved) continue;
        const firstComment = thread.comments.nodes[0];
        if (!firstComment) continue;

        const isOurs = firstComment.body.includes(INLINE_COMMENT_MARKER) ||
          firstComment.author.login === user ||
          firstComment.author.login === botLoginVariant;
        if (!isOurs) continue;

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
               Math.abs(f.line - thread.line) <= 3,
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

  private async resolveThread(threadId: string): Promise<number> {
    try {
      await this.octokit.graphql(`
        mutation($threadId: ID!) {
          resolveReviewThread(input: {threadId: $threadId}) {
            thread { isResolved }
          }
        }
      `, { threadId });
      return 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.debug(`Failed to resolve thread: ${msg}`);
      return 0;
    }
  }

  private formatStatus(agentStatus: AgentStatus): string {
    switch (agentStatus.status) {
      case 'running':
        return '\u23F3 Running...';
      case 'done':
        if (agentStatus.findingCount !== undefined) {
          return `\u2705 Done (${agentStatus.findingCount} finding${agentStatus.findingCount !== 1 ? 's' : ''})`;
        }
        return '\u2705 Done';
      case 'failed':
        return '\u274C Failed';
    }
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
        per_page: 100,
      });

      for (const comment of comments) {
        if (!comment.body?.includes(COMMENT_MARKER)) continue;
        // Only minimize our own comments
        if (user && comment.user?.login !== user) continue;

        try {
          await this.octokit.graphql(`
            mutation($id: ID!) {
              minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) {
                minimizedComment { isMinimized }
              }
            }
          `, { id: comment.node_id });
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

  private async getAuthenticatedUser(): Promise<string | null> {
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
