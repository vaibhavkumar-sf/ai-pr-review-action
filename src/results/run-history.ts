/**
 * The per-run review report that lives in the PR description.
 *
 * One collapsible block per run, newest open and every older one collapsed, so
 * a PR reviewed a dozen times still reads as a single tidy section instead of a
 * dozen full-length bot comments.
 *
 * ## How history survives across runs
 *
 * The PR body IS the store. Old blocks are never re-rendered — they are carried
 * forward verbatim, so a run only ever has to render its own block. Each block
 * is introduced by a marker comment carrying a small JSON payload:
 *
 *   <!-- ai-pr-review-run:7 {"at":"...","c":0,"h":1,"m":9,"l":3,"n":1,"t":14,"cost":0.31} -->
 *
 * That payload exists for exactly one reason: collapsing a block to a one-line
 * table row when the body runs out of space, without ever parsing rendered
 * markdown back into data.
 */

import { ActionConfig, MergedReviewResult, ReviewContext, Severity } from '../types';
import { RunActivityStats } from './backstage-reporter';
import { formatFindingsDetail, formatSevereFindingsTable, formatTrackingMetrics } from './formatter';
import {
  RERUN_INLINE_CATEGORIES,
  RERUN_INLINE_SEVERITIES,
  CATEGORY_LABELS,
  SEVERITY_ICONS,
  SEVERITY_LABELS,
} from '../config/taxonomy';
import {
  PR_BODY_MAX_CHARS,
  PR_BODY_SAFETY_MARGIN_CHARS,
  RUN_BLOCK_MAX_CHARS,
  RUN_HISTORY_MAX_RUNS,
} from '../config/limits';

export const RUNS_REGION_START = '<!-- ai-pr-review-runs:start -->';
export const RUNS_REGION_END = '<!-- ai-pr-review-runs:end -->';

/** Wraps the heavy sections (All Findings, JIRA, Agent Results, Strengths) so
 *  demotion can excise them with an exact splice rather than markdown parsing. */
const DETAIL_START = '<!-- ai-pr-review-run-detail:start -->';
const DETAIL_END = '<!-- ai-pr-review-run-detail:end -->';

const RUN_MARKER_RE = /<!-- ai-pr-review-run:(\d+) (\{.*?\}) -->/;
/** Global variant used to split the region; must stay in sync with the above. */
const RUN_MARKER_SPLIT_RE = /(?=<!-- ai-pr-review-run:\d+ \{)/;

export const RUNS_HEADING = '### 📊 Review Runs';

/** The compact per-run payload carried in each block's marker comment. */
interface RunMeta {
  /** ISO-8601 timestamp of the run. */
  at: string;
  c: number;
  h: number;
  m: number;
  l: number;
  n: number;
  /** Total findings. */
  t: number;
  /** Estimated USD cost, or null when no model_pricing entry covered the run. */
  cost: number | null;
}

interface RunBlock {
  runNumber: number;
  meta: RunMeta;
  /** The rendered block, marker line included. */
  markdown: string;
}

/**
 * A double hyphen terminates an HTML comment. If one reached a marker, GitHub
 * would render the entire rest of the body as visible text — so it can never be
 * allowed through, no matter what a model put in a finding title.
 */
function encodeMarkerJson(meta: RunMeta): string {
  return JSON.stringify(meta).replace(/-{2,}/g, m => '\\u002d'.repeat(m.length));
}

/**
 * Renders ONE run's block. `isLatest` controls both the open state and whether
 * the heavy detail sections are included at all.
 */
export function renderRunBlock(
  runNumber: number,
  result: MergedReviewResult,
  config: ActionConfig,
  context: ReviewContext,
  activity: RunActivityStats,
  isRerun: boolean,
  now: Date,
): string {
  const meta: RunMeta = {
    at: now.toISOString(),
    c: result.criticalCount,
    h: result.highCount,
    m: result.mediumCount,
    l: result.lowCount,
    n: result.nitCount,
    t: result.totalFindings,
    cost: activity.estimatedCostUsd,
  };

  const parts: string[] = [];
  parts.push(`<!-- ai-pr-review-run:${runNumber} ${encodeMarkerJson(meta)} -->`);
  parts.push('<details open>');
  parts.push(`<summary>${summaryLine(runNumber, meta, true)}</summary>`);
  parts.push('');
  parts.push(inlinePolicyNote(isRerun));
  parts.push('');
  parts.push(formatTrackingMetrics(result, config, activity).trim());
  parts.push('');

  const severeTable = formatSevereFindingsTable(result);
  if (severeTable) {
    parts.push(severeTable);
  }

  parts.push(DETAIL_START);
  parts.push(formatFindingsDetail(result, context).trim());
  parts.push(DETAIL_END);
  parts.push('</details>');

  const block = parts.join('\n');
  return block.length > RUN_BLOCK_MAX_CHARS ? truncateBlockDetail(block, config) : block;
}

/**
 * The line that answers "why did my Low finding not get an inline comment, and
 * why did a documentation nit get one?". Derived from the taxonomy constants
 * that actually drive the gate, so it can never drift from the behaviour, and
 * stored per block so an old run keeps the policy that was in force for it.
 */
function inlinePolicyNote(isRerun: boolean): string {
  if (!isRerun) {
    // Not "every finding above" — this block loses its findings list once it is
    // demoted, and the note is carried forward verbatim.
    return '> 🆕 **First run** — every finding in this run was posted as an inline comment, at every severity.';
  }

  const label = (s: Severity): string => `${SEVERITY_ICONS[s]} ${SEVERITY_LABELS[s]}`;
  const inlined = joinWithOr([...RERUN_INLINE_SEVERITIES].map(label));
  const held = joinWithOr(
    (['medium', 'low', 'nit'] as Severity[])
      .filter(s => !RERUN_INLINE_SEVERITIES.has(s))
      .map(label),
  );
  const categories = joinWithOr([...RERUN_INLINE_CATEGORIES].map(c => CATEGORY_LABELS[c]));

  return [
    `> 🔁 **Re-run policy** — this run posted NEW inline comments only for ${inlined} findings,`,
    `> plus **${categories}** findings at any severity.`,
    `>`,
    `> ${held} findings were still detected and **are counted in the tables above** — they are just`,
    `> not posted inline, because re-commenting them on every push created an endless`,
    `> fix→push→new-comments loop. ${categories} findings are exempt because they carry`,
    `> paste-ready suggestions that are quick and unambiguous to apply.`,
    `>`,
    `> Resolved threads reopen automatically if a ${inlined} issue comes back.`,
  ].join('\n');
}

/** "a, b or c" — the note is read by humans, so comma-joining every list reads wrong. */
function joinWithOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function summaryLine(runNumber: number, meta: RunMeta, isLatest: boolean): string {
  const when = formatWhen(meta.at);
  const label = isLatest
    ? `<strong>Latest — Run #${runNumber}</strong>`
    : `Run #${runNumber}`;
  const findings = meta.t === 1 ? '1 finding' : `${meta.t} findings`;
  const severe = meta.c + meta.h > 0 ? ` · ${meta.c} critical, ${meta.h} high` : '';
  return `${label} · ${when} · ${findings}${severe}`;
}

/** `2026-08-06 13:12 UTC` — readable in a collapsed summary, sorts naturally. */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
}

/**
 * Demotes a block from latest: closes its <details> and strips the heavy detail
 * section entirely. Nobody re-reads All Findings for a superseded run, and
 * dropping it is what keeps a long-lived PR inside the body limit.
 */
function demoteBlock(block: RunBlock): RunBlock {
  // Only the block's own wrapper is `<details open>`; the nested detail
  // sections are plain `<details>`, so replacing the first occurrence is exact
  // and a no-op on an already-demoted block.
  let markdown = block.markdown.replace('<details open>', '<details>');

  const start = markdown.indexOf(DETAIL_START);
  const end = markdown.indexOf(DETAIL_END);
  if (start >= 0 && end > start) {
    markdown = markdown.slice(0, start) + markdown.slice(end + DETAIL_END.length);
  }

  markdown = markdown.replace(
    /<summary>.*?<\/summary>/s,
    `<summary>${summaryLine(block.runNumber, block.meta, false)}</summary>`,
  );

  return { ...block, markdown: markdown.replace(/\n{3,}/g, '\n\n') };
}

/** Last-resort trim when a single run's block busts the per-block cap. */
function truncateBlockDetail(block: string, config: ActionConfig): string {
  const start = block.indexOf(DETAIL_START);
  const end = block.indexOf(DETAIL_END);
  if (start < 0 || end <= start) return block;
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const runId = process.env.GITHUB_RUN_ID;
  const where = runId
    ? `See the [workflow run](${server}/${config.owner}/${config.repo}/actions/runs/${runId}).`
    : 'See the workflow run logs.';
  return (
    block.slice(0, start) +
    DETAIL_START +
    `\n<sub>Findings detail omitted — this run's report exceeded GitHub's PR body budget. ${where}</sub>\n` +
    block.slice(end)
  );
}

/**
 * Parses the existing region into blocks. Returns `null` when the region is
 * absent OR malformed — a PR description is user-editable, so a half-deleted
 * marker is a normal thing to encounter. In that case the caller starts the
 * region fresh rather than trying to repair it; content outside the delimiters
 * is never touched either way.
 */
export function parseRunBlocks(body: string): RunBlock[] | null {
  const start = body.indexOf(RUNS_REGION_START);
  const end = body.indexOf(RUNS_REGION_END);
  if (start < 0 || end <= start) return null;

  const region = body.slice(start + RUNS_REGION_START.length, end).trim();
  if (!region) return [];

  const chunks = region.split(RUN_MARKER_SPLIT_RE).map(c => c.trim()).filter(Boolean);
  const blocks: RunBlock[] = [];

  for (const chunk of chunks) {
    const match = chunk.match(RUN_MARKER_RE);
    if (!match) return null;
    // Unbalanced <details> would swallow every block after this one when the
    // body renders. Counting is the only check that catches a tag deleted from
    // the middle — the block nests its own detail sections, so "contains a
    // closing tag" proves nothing.
    const opens = (chunk.match(/<details[\s>]/g) ?? []).length;
    const closes = (chunk.match(/<\/details>/g) ?? []).length;
    if (opens === 0 || opens !== closes) return null;
    let meta: RunMeta;
    try {
      meta = JSON.parse(match[2]) as RunMeta;
    } catch {
      return null;
    }
    if (typeof meta.t !== 'number' || typeof meta.at !== 'string') return null;
    blocks.push({ runNumber: Number(match[1]), meta, markdown: chunk });
  }

  return blocks;
}

/** The highest run number already recorded in the body, or 0. */
export function highestRecordedRun(body: string): number {
  const blocks = parseRunBlocks(body);
  if (!blocks || blocks.length === 0) return 0;
  return Math.max(...blocks.map(b => b.runNumber));
}

/** One-line row per run, used once full blocks no longer fit. */
function oneLinerTable(blocks: RunBlock[]): string {
  const rows = blocks.map(b => {
    const cost = b.meta.cost === null ? 'n/a' : `$${b.meta.cost.toFixed(4)}`;
    return `| #${b.runNumber} | ${formatWhen(b.meta.at)} | ${b.meta.c} | ${b.meta.h} | ${b.meta.m} | ${b.meta.l} | ${b.meta.n} | **${b.meta.t}** | ${cost} |`;
  });
  return [
    '<details>',
    `<summary>Older runs (${blocks.length})</summary>`,
    '',
    `| Run | When | ${SEVERITY_ICONS.critical} | ${SEVERITY_ICONS.high} | ${SEVERITY_ICONS.medium} | ${SEVERITY_ICONS.low} | ${SEVERITY_ICONS.nit} | Total | Cost |`,
    '|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|',
    ...rows,
    '',
    '</details>',
  ].join('\n');
}

/**
 * Builds the complete Review Runs section: the new block, then as much prior
 * history as the remaining body budget allows.
 *
 * `otherContentChars` is everything else the body will contain (the user's own
 * description, the AI narrative, diagrams). The ladder walks down from full
 * detail to one-line rows to dropping the oldest rows, and every step that
 * loses information says so in the output — a silently truncated history reads
 * as "these are all the runs", which is worse than the truncation itself.
 */
export function buildRunsSection(
  newBlockMarkdown: string,
  previousBody: string,
  otherContentChars: number,
): string {
  const prior = parseRunBlocks(previousBody) ?? [];
  // Newest first. Guard against a duplicate run number (a re-run of the very
  // same workflow run would otherwise render two "Run #N" blocks).
  const newRunNumber = Number(newBlockMarkdown.match(RUN_MARKER_RE)?.[1] ?? 0);
  const demoted = prior
    .filter(b => b.runNumber !== newRunNumber)
    .sort((a, b) => b.runNumber - a.runNumber)
    .map(demoteBlock);

  const budget =
    PR_BODY_MAX_CHARS - PR_BODY_SAFETY_MARGIN_CHARS - otherContentChars -
    RUNS_HEADING.length - RUNS_REGION_START.length - RUNS_REGION_END.length;

  const assemble = (full: RunBlock[], rows: RunBlock[], note: string): string => {
    const pieces = [newBlockMarkdown, ...full.map(b => b.markdown)];
    if (rows.length > 0) pieces.push(oneLinerTable(rows));
    if (note) pieces.push(note);
    return pieces.join('\n\n');
  };

  // Tier 1: the new block plus as many full blocks as RUN_HISTORY_MAX_RUNS allows.
  let full = demoted.slice(0, RUN_HISTORY_MAX_RUNS - 1);
  let rows = demoted.slice(RUN_HISTORY_MAX_RUNS - 1);
  let note = '';
  let section = assemble(full, rows, note);

  // Tier 2: degrade the oldest full blocks to one-line rows until it fits.
  while (section.length > budget && full.length > 0) {
    rows = [full[full.length - 1], ...rows];
    full = full.slice(0, -1);
    section = assemble(full, rows, note);
  }

  // Tier 3: drop the oldest rows — loudly.
  while (section.length > budget && rows.length > 0) {
    rows = rows.slice(0, -1);
    note = `<sub>Older runs trimmed to fit GitHub's ${PR_BODY_MAX_CHARS.toLocaleString('en-US')}-character PR body limit.</sub>`;
    section = assemble(full, rows, note);
  }

  return [RUNS_HEADING, '', RUNS_REGION_START, section, RUNS_REGION_END].join('\n');
}
