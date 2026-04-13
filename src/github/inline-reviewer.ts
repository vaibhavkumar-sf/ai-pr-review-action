import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';
import { Finding, ParsedDiff, Severity } from '../types';
import { findDiffPosition } from './diff-parser';

/** Hidden HTML marker to reliably identify our inline comments regardless of bot login */
export const INLINE_COMMENT_MARKER = '<!-- ai-pr-review-inline -->';

/**
 * Builds a fingerprint marker encoding file + title into a compact hash.
 * Used as the primary dedup key — independent of line numbers.
 */
function buildFingerprintMarker(file: string, title: string): string {
  const normalized = `${file}::${title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80)}`;
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `<!-- ai-pr-review-fp:${(hash >>> 0).toString(16).padStart(8, '0')} -->`;
}

const SEVERITY_TAGS: Record<Severity, string> = {
  critical: '\uD83D\uDED1 Critical',
  high: '\uD83D\uDD34 High',
  medium: '\uD83D\uDFE1 Medium',
  low: '\uD83D\uDFE2 Low',
  nit: '\uD83D\uDCAC Nit',
};

interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export class InlineReviewer {
  constructor(
    private octokit: Octokit,
    private owner: string,
    private repo: string,
    private prNumber: number,
  ) {}

  async postReview(
    findings: Finding[],
    headSha: string,
    parsedDiffs: ParsedDiff[],
  ): Promise<number> {
    // Fetch existing open inline comments from previous runs to avoid duplicates
    const existingComments = await this.fetchExistingInlineComments();

    const comments: ReviewComment[] = [];
    const batchFingerprints = new Set<string>();

    for (const finding of findings) {
      if (!finding.file || !finding.line) continue;

      // Verify the line exists in the diff (so GitHub won't reject it)
      const position = findDiffPosition(parsedDiffs, finding.file, finding.line);
      if (position === null) {
        // Try nearby lines (AI might be off by 1-2 lines)
        const nearbyLine = this.findNearbyDiffLine(parsedDiffs, finding.file, finding.line);
        if (nearbyLine === null) {
          core.debug(
            `Skipping inline comment: ${finding.file}:${finding.line} not found in diff`,
          );
          continue;
        }
        finding.line = nearbyLine;
      }

      // Skip if ANY comment already exists at this file+line from a previous run
      // (different agents generate different titles for the same issue)
      if (this.isDuplicateOfExisting(finding, existingComments)) {
        core.debug(
          `Skipping duplicate inline comment: ${finding.file}:${finding.line} "${finding.title}" — already exists`,
        );
        continue;
      }

      // Skip if we already queued a comment for this file+line in this batch
      // (one comment per location is enough — first finding wins)
      const locationKey = `${finding.file}:${finding.line}`;
      if (batchFingerprints.has(locationKey)) {
        core.debug(
          `Skipping within-batch duplicate: ${finding.file}:${finding.line} "${finding.title}" — location already covered`,
        );
        continue;
      }
      batchFingerprints.add(locationKey);

      // Validate code suggestion against actual line content
      this.validateCodeSuggestion(finding, parsedDiffs);

      const body = this.formatCommentBody(finding);
      comments.push({
        path: finding.file,
        line: finding.line,
        side: 'RIGHT',
        body,
      });
    }

    if (comments.length === 0) {
      return 0;
    }

    try {
      await this.octokit.pulls.createReview({
        owner: this.owner,
        repo: this.repo,
        pull_number: this.prNumber,
        commit_id: headSha,
        event: 'COMMENT',
        comments: comments as any, // Octokit types don't include line+side yet
      });

      return comments.length;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      core.warning(`Failed to post inline review: ${message}`);

      // If batch fails, try posting comments individually
      return this.postCommentsIndividually(headSha, comments);
    }
  }

  /**
   * Fetches existing unresolved inline review comments authored by our bot
   * on this PR. Used to avoid posting duplicate comments on re-triggers.
   */
  private async fetchExistingInlineComments(): Promise<Array<{ path: string; line: number; body: string }>> {
    try {
      const allComments = await this.octokit.paginate(
        this.octokit.pulls.listReviewComments,
        {
          owner: this.owner,
          repo: this.repo,
          pull_number: this.prNumber,
          per_page: 100,
        },
      );

      // Identify our comments by hidden marker (reliable) or bot login (fallback)
      return allComments
        .filter(c => c.body?.includes(INLINE_COMMENT_MARKER) || c.user?.login === 'github-actions[bot]')
        .map(c => ({
          path: c.path,
          line: c.line ?? c.original_line ?? 0,
          body: c.body ?? '',
        }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      core.debug(`Failed to fetch existing inline comments: ${msg}`);
      return [];
    }
  }

  /**
   * Checks if a finding already has an open inline comment from a previous run
   * at the same file+line with a similar title/content.
   */
  private isDuplicateOfExisting(
    finding: Finding,
    existing: Array<{ path: string; line: number; body: string }>,
  ): boolean {
    // Primary: location-based check — if ANY of our comments already exists
    // at the same file+line (±2), it's a duplicate regardless of title.
    // Different agents/runs generate different titles for the same issue.
    const hasCommentAtLocation = existing.some(c =>
      c.path === finding.file &&
      c.line !== 0 &&
      Math.abs(c.line - finding.line) <= 2,
    );
    if (hasCommentAtLocation) {
      return true;
    }

    // Secondary: fingerprint match (file + title hash, line-independent)
    // Catches cases where line numbers changed but same issue persists
    const fingerprint = buildFingerprintMarker(finding.file, finding.title);
    if (existing.some(c => c.body.includes(fingerprint))) {
      return true;
    }

    // Tertiary: title-in-body match for old comments without markers and with line=0
    const titleLower = finding.title.toLowerCase();
    return existing.some(c => {
      if (c.path !== finding.file) return false;
      if (c.line !== 0) return false; // Non-zero lines already handled above
      return c.body.toLowerCase().includes(titleLower);
    });
  }

  /**
   * Validates that a code suggestion is meaningful — not a no-op and not
   * replacing the wrong content. Strips invalid suggestions so the finding
   * is still posted as a comment without a broken suggestion block.
   */
  private validateCodeSuggestion(finding: Finding, parsedDiffs: ParsedDiff[]): void {
    if (!finding.codeSuggestion) return;

    const originalLine = this.getOriginalLineContent(parsedDiffs, finding.file, finding.line);
    if (!originalLine) return; // Can't validate without original content

    const originalTrimmed = originalLine.trim();
    const suggestionTrimmed = finding.codeSuggestion.trim();

    // No-op check: suggestion is identical to original line
    if (originalTrimmed === suggestionTrimmed) {
      core.debug(
        `Dropping no-op code suggestion on ${finding.file}:${finding.line} — identical to original`,
      );
      finding.codeSuggestion = undefined;
      return;
    }

    // Structural mismatch: suggestion contains completely unrelated content
    // (e.g., suggesting a checkout step on an angular_prompt_append line)
    // Heuristic: if suggestion has zero words in common with original, it's likely wrong
    const originalWords = new Set(originalTrimmed.toLowerCase().split(/[\s:_\-./]+/).filter(w => w.length > 2));
    const suggestionWords = new Set(suggestionTrimmed.toLowerCase().split(/[\s:_\-./]+/).filter(w => w.length > 2));
    let commonWords = 0;
    for (const word of originalWords) {
      if (suggestionWords.has(word)) commonWords++;
    }

    // If original line has meaningful words but suggestion shares NONE, likely wrong line
    if (originalWords.size >= 2 && commonWords === 0) {
      core.debug(
        `Dropping mismatched code suggestion on ${finding.file}:${finding.line} — suggestion content doesn't match original line`,
      );
      finding.codeSuggestion = undefined;
    }
  }

  /**
   * Extracts the content of a specific line from parsed diffs.
   */
  private getOriginalLineContent(
    parsedDiffs: ParsedDiff[],
    filename: string,
    lineNumber: number,
  ): string | null {
    const fileDiff = parsedDiffs.find(d => d.filename === filename);
    if (!fileDiff) return null;

    for (const hunk of fileDiff.hunks) {
      for (const line of hunk.lines) {
        if (line.newLineNumber === lineNumber && (line.type === 'add' || line.type === 'context')) {
          return line.content;
        }
      }
    }
    return null;
  }

  /**
   * If a finding's line number isn't exactly in the diff, search nearby lines
   * (within +/- 3) that ARE in the diff. Returns the nearest valid line or null.
   */
  private findNearbyDiffLine(
    parsedDiffs: ParsedDiff[],
    filename: string,
    targetLine: number,
  ): number | null {
    for (let offset = 1; offset <= 3; offset++) {
      if (findDiffPosition(parsedDiffs, filename, targetLine + offset) !== null) {
        return targetLine + offset;
      }
      if (findDiffPosition(parsedDiffs, filename, targetLine - offset) !== null) {
        return targetLine - offset;
      }
    }
    return null;
  }

  /**
   * Fall back to posting each comment individually. If one fails (e.g., line
   * not in diff), the others can still succeed.
   */
  private async postCommentsIndividually(
    headSha: string,
    comments: ReviewComment[],
  ): Promise<number> {
    let posted = 0;
    for (const comment of comments) {
      try {
        await this.octokit.pulls.createReview({
          owner: this.owner,
          repo: this.repo,
          pull_number: this.prNumber,
          commit_id: headSha,
          event: 'COMMENT',
          comments: [comment as any],
        });
        posted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        core.debug(`Failed to post comment on ${comment.path}:${comment.line}: ${msg}`);
      }
    }
    return posted;
  }

  private formatCommentBody(finding: Finding): string {
    const severityTag = SEVERITY_TAGS[finding.severity];
    const parts: string[] = [];

    // Hidden markers for reliable dedup across runs
    parts.push(INLINE_COMMENT_MARKER);
    parts.push(buildFingerprintMarker(finding.file, finding.title));
    parts.push(`**${severityTag}:** ${finding.title}`);
    parts.push('');
    parts.push(finding.description);

    if (finding.suggestion) {
      parts.push('');
      parts.push(finding.suggestion);
    }

    if (finding.codeSuggestion) {
      parts.push('');
      parts.push('```suggestion');
      parts.push(finding.codeSuggestion);
      parts.push('```');
    }

    return parts.join('\n');
  }
}
