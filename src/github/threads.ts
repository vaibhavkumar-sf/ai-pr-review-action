import { Octokit } from '@octokit/rest';
import { GITHUB_PER_PAGE, THREAD_COMMENTS_PAGE } from '../config/limits';

/**
 * The single GraphQL module for PR review threads — fetching, resolving, and
 * minimizing — plus the bot-login matching rules. Shared by the stale-thread
 * resolver and the reply handler (which previously each had their own copy).
 */

export interface ThreadComment {
  databaseId: number | null;
  author: { login: string } | null;
  body: string;
  path: string;
  line: number | null;
  createdAt: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: { nodes: ThreadComment[] };
}

/** CI bots whose comments are never treated as human replies. */
export const KNOWN_BOT_LOGINS = /^(github-actions|sonarqubecloud|sonarcloud|dependabot|renovate)$/;

/**
 * Appended by the reply handler when it resolves a thread after accepting a
 * human's justification. Reopen logic must never undo these resolutions.
 */
export const RESOLUTION_FOOTER = '_Resolving this thread._';

/**
 * Login matchers relative to OUR authenticated user. GraphQL returns logins
 * without the '[bot]' suffix while REST includes it — both variants match.
 */
export function makeLoginMatchers(botUser: string): {
  isOurLogin: (login: string) => boolean;
  isHuman: (login: string) => boolean;
} {
  const botLoginVariant = botUser.replace('[bot]', '');
  const isOurLogin = (login: string): boolean =>
    login === botUser || login === botLoginVariant;
  const isHuman = (login: string): boolean =>
    !isOurLogin(login) && !login.endsWith('[bot]') && !KNOWN_BOT_LOGINS.test(login);
  return { isOurLogin, isHuman };
}

/** Fetches all review threads on a PR with their comments. */
export async function fetchReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const data: {
    repository: { pullRequest: { reviewThreads: { nodes: ReviewThread[] } } };
  } = await octokit.graphql(`
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: ${GITHUB_PER_PAGE}) {
            nodes {
              id
              isResolved
              comments(first: ${THREAD_COMMENTS_PAGE}) {
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
  `, { owner, repo, number: prNumber });
  return data.repository.pullRequest.reviewThreads.nodes;
}

/** Resolves a review thread. Throws on failure — callers decide how to degrade. */
export async function resolveReviewThreadById(octokit: Octokit, threadId: string): Promise<void> {
  await octokit.graphql(`
    mutation($threadId: ID!) {
      resolveReviewThread(input: {threadId: $threadId}) {
        thread { isResolved }
      }
    }
  `, { threadId });
}

/** Unresolves (reopens) a review thread. Throws on failure — callers decide how to degrade. */
export async function unresolveReviewThreadById(octokit: Octokit, threadId: string): Promise<void> {
  await octokit.graphql(`
    mutation($threadId: ID!) {
      unresolveReviewThread(input: {threadId: $threadId}) {
        thread { isResolved }
      }
    }
  `, { threadId });
}

/** Minimizes (collapses) a comment as OUTDATED. Throws on failure. */
export async function minimizeCommentById(octokit: Octokit, nodeId: string): Promise<void> {
  await octokit.graphql(`
    mutation($id: ID!) {
      minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) {
        minimizedComment { isMinimized }
      }
    }
  `, { id: nodeId });
}
