import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { ReviewCategory, Severity } from '../types';
import { buildFingerprintMarker, INLINE_COMMENT_MARKER } from './inline-reviewer';
import {
  fetchReviewThreads,
  KNOWN_BOT_LOGINS,
  makeLoginMatchers,
  minimizeCommentById,
  RESOLUTION_FOOTER,
  resolveReviewThreadById,
  unresolveReviewThreadById,
} from './threads';
import { AGENT_LABELS, SEVERITY_LABELS, SEVERITY_TAGS } from '../config/taxonomy';
import { BOT_HIDE_ALL_PATTERNS } from '../config/patterns';
import {
  GITHUB_PER_PAGE,
  REOPEN_THREAD_PROXIMITY,
  REOPEN_THREADS_MAX_PER_RUN,
  STALE_THREAD_PROXIMITY,
} from '../config/limits';

const COMMENT_MARKER = '<!-- ai-pr-review-action-comment -->';

/**
 * Embedded only in the FINAL summary of a completed review — its presence on a
 * PR is the re-run signal. Progress/error comments carry only COMMENT_MARKER,
 * so a run that died mid-way never counts as a completed review.
 */
export const REVIEW_COMPLETE_MARKER = '<!-- ai-pr-review-complete -->';

/** Marks the templated reply posted when a resolved thread is reopened. */
export const REOPEN_MARKER = '<!-- ai-pr-review-reopen -->';

/** A recurring critical/high finding that may reopen a resolved thread. */
export interface RegressedFinding {
  file: string;
  line: number;
  title: string;
  severity: Severity;
  description: string;
}

type AgentStatus = 'running' | 'done' | 'failed';

export class PRCommenter {
  private agentStatuses: Map<string, AgentStatus> = new Map();
  private currentCommentId: number | null = null;
  private authenticatedUser: string | null = null;
  private priorCompletedRun = false;
  private priorCompletedRuns = 0;
  private threadPermissionWarned = false;

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

  /**
   * True once a prior COMPLETED review summary was seen on this PR.
   * Latched by minimizeOldSummaryComments() on the first post of the run;
   * false (first-run behavior) if that scan failed — fail-open by design.
   */
  isRerun(): boolean {
    return this.priorCompletedRun;
  }

  /**
   * How many COMPLETED reviews already exist on this PR — i.e. which re-run
   * this is. Each completed run leaves exactly one summary comment carrying
   * REVIEW_COMPLETE_MARKER (minimized old ones still appear in listComments),
   * so this equals the count of those markers seen at startup. 0 on a first
   * run (or if the scan failed — fail-open, consistent with isRerun()).
   */
  rerunNumber(): number {
    return this.priorCompletedRuns;
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
      this.reportThreadMutationFailure('resolve', err);
      return 0;
    }
  }

  /**
   * Thread resolve/unresolve failures must not be invisible: GitHub requires
   * PUSH access to (un)resolve PR conversations, so a workflow with the
   * common `contents: read` gets "Resource not accessible by integration" on
   * every attempt — stale threads silently stay open and regressed threads
   * stay resolved. Warn ONCE per run with the exact remediation; anything
   * else stays at debug (best-effort operations).
   */
  private reportThreadMutationFailure(operation: 'resolve' | 'reopen', err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (/resource not accessible/i.test(msg) && !this.threadPermissionWarned) {
      this.threadPermissionWarned = true;
      core.warning(
        `GitHub token cannot ${operation} review threads ("Resource not accessible by integration"). ` +
        'GitHub requires push access to resolve/unresolve PR conversations — grant the workflow ' +
        '`permissions: contents: write` (alongside `pull-requests: write`). Until then, fixed findings’ ' +
        'threads stay open and regressed threads stay resolved.',
      );
      return;
    }
    core.debug(`Failed to ${operation} thread: ${msg}`);
  }

  /**
   * Re-run only: previously-RESOLVED threads whose critical/high issue was
   * found AGAIN are unresolved and get a templated explanation reply (no AI
   * call). Never touches threads the reply handler resolved after accepting a
   * human justification (RESOLUTION_FOOTER), threads where a human spoke last,
   * or threads whose original severity was below high (proximity match only —
   * a fingerprint match is the same finding regardless of its old tag).
   *
   * Callers pass findings already filtered to critical/high on non-test files.
   */
  async reopenRegressedThreads(regressedFindings: RegressedFinding[]): Promise<number> {
    if (regressedFindings.length === 0) return 0;
    const user = await this.getAuthenticatedUser();
    if (!user) return 0;

    let reopened = 0;

    try {
      const threads = await fetchReviewThreads(this.octokit, this.owner, this.repo, this.prNumber);
      const { isOurLogin, isHuman } = makeLoginMatchers(user);

      // Tags identifying a thread whose ORIGINAL finding was critical/high.
      const severeTags = ['critical', 'high'].map(s => `**${SEVERITY_TAGS[s as Severity]}:**`);
      const usedFindings = new Set<RegressedFinding>();

      for (const thread of threads) {
        if (reopened >= REOPEN_THREADS_MAX_PER_RUN) break;
        if (!thread.isResolved) continue;
        const firstComment = thread.comments.nodes[0];
        if (!firstComment) continue;

        const isOurs = firstComment.body.includes(INLINE_COMMENT_MARKER) ||
          isOurLogin(firstComment.author?.login ?? '');
        if (!isOurs) continue;

        // The reply handler resolved this after accepting a human's
        // justification — never undo that decision.
        const justificationAccepted = thread.comments.nodes.some(
          c => isOurLogin(c.author?.login ?? '') && c.body.includes(RESOLUTION_FOOTER),
        );
        if (justificationAccepted) continue;

        // A human had the final word (e.g. self-resolved with a rationale) —
        // reopening would fight them; same conservatism as stale resolution.
        const lastComment = thread.comments.nodes[thread.comments.nodes.length - 1];
        if (isHuman(lastComment?.author?.login ?? '')) continue;

        const oldWasSevere = severeTags.some(tag => firstComment.body.includes(tag));

        // Primary match: exact fingerprint (same file+title, line-independent).
        // Secondary: tight location proximity, only when the old tag was severe
        // (never reopen a medium/low/nit thread on a mere location match).
        const match = regressedFindings.find(f =>
          !usedFindings.has(f) && (
            firstComment.body.includes(buildFingerprintMarker(f.file, f.title)) ||
            (oldWasSevere &&
              f.file === firstComment.path &&
              Math.abs(f.line - (firstComment.line ?? 0)) <= REOPEN_THREAD_PROXIMITY)
          ),
        );
        if (!match) continue;

        try {
          await unresolveReviewThreadById(this.octokit, thread.id);
          if (firstComment.databaseId) {
            await this.octokit.pulls.createReplyForReviewComment({
              owner: this.owner,
              repo: this.repo,
              pull_number: this.prNumber,
              comment_id: firstComment.databaseId,
              body: buildReopenReply(match),
            });
          }
          usedFindings.add(match);
          reopened++;
        } catch (err) {
          this.reportThreadMutationFailure('reopen', err);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`Failed to reopen regressed threads: ${msg}`);
    }

    if (reopened > 0) {
      core.info(`Reopened ${reopened} resolved thread(s) whose critical/high issue was detected again`);
    }

    return reopened;
  }

  /**
   * Minimize noisy recurring bot comments on the PR:
   * - Comments matching a hide pattern are hidden on every occurrence.
   * - Any other recurring bot comment type (grouped by bot login + first
   *   heading line) keeps only the latest occurrence; older ones are hidden.
   *
   * Our own marker comments are never touched (they're handled by
   * minimizeOldSummaryComments), and already-minimized comments are skipped.
   *
   * `hidePatterns` defaults to the built-ins; the orchestrator passes the
   * built-ins plus whatever the consumer added via `bot_hide_patterns`.
   *
   * Called twice per run — once at startup, once near the end — because a
   * review takes minutes and other CI bots comment during that window.
   */
  async cleanupBotComments(hidePatterns: readonly string[] = BOT_HIDE_ALL_PATTERNS): Promise<number> {
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
        if (hidePatterns.some(pattern => comment.body.includes(pattern))) {
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

        // A completed review summary from an earlier run ⇒ this run is a re-run.
        // Minimized comments still appear in REST listComments (minimization is
        // a display state), so the signal survives run after run.
        if (comment.body.includes(REVIEW_COMPLETE_MARKER)) {
          this.priorCompletedRun = true;
          this.priorCompletedRuns += 1;
        }

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

/**
 * Templated reply for a reopened thread — explains why the finding matters
 * using its own description. Deliberately NOT an AI call: re-runs must stay
 * cheap, and the original finding already carries the reasoning.
 */
function buildReopenReply(finding: RegressedFinding): string {
  return [
    REOPEN_MARKER,
    `**${SEVERITY_TAGS[finding.severity]} — issue detected again**`,
    '',
    'This thread was resolved earlier, but the latest review still finds the issue:',
    '',
    finding.description,
    '',
    `_Reopened automatically: ${SEVERITY_LABELS[finding.severity].toLowerCase()}-severity findings stay open until fixed, or justified with a reply._`,
  ].join('\n');
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
