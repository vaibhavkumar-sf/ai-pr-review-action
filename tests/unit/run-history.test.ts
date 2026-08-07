import {
  buildRunsSection,
  highestRecordedRun,
  parseRunBlocks,
  renderRunBlock,
  RUNS_REGION_END,
  RUNS_REGION_START,
} from '../../src/results/run-history';
import { PR_BODY_MAX_CHARS } from '../../src/config/limits';
import {
  makeActivity,
  makeConfig,
  makeContext,
  makeFinding,
  makeMerged,
} from '../fixtures/factory';

const AT = new Date('2026-08-06T13:12:00.000Z');

function block(runNumber: number, opts: { isRerun?: boolean; merged?: ReturnType<typeof makeMerged> } = {}): string {
  return renderRunBlock(
    runNumber,
    opts.merged ?? makeMerged(),
    makeConfig(),
    makeContext(),
    makeActivity(),
    opts.isRerun ?? false,
    AT,
  );
}

/** Simulates a body already written by a previous run. */
function bodyWith(section: string): string {
  return `User's own description.\n\n----AI-description----\n\n## What this PR does\n\nStuff.\n\n${section}\n`;
}

describe('renderRunBlock', () => {
  it('opens the latest block and carries the full report', () => {
    const md = block(1);
    expect(md).toContain('<details open>');
    expect(md).toContain('<strong>Latest — Run #1</strong>');
    expect(md).toContain('2026-08-06 13:12 UTC');
    expect(md).toContain('### 📊 Tracking Metrics');
    expect(md).toContain('All Findings');
    expect(md).toContain('Agent Results');
  });

  it('states the first-run inline policy', () => {
    expect(block(1, { isRerun: false })).toContain('🆕 **First run**');
  });

  it('spells out the re-run policy — which severities inline, and why not the rest', () => {
    const md = block(2, { isRerun: true });
    expect(md).toContain('🔁 **Re-run policy**');
    // What DOES get an inline comment — phrased for humans, not comma-joined.
    expect(md).toContain('🛑 Critical or 🔴 High');
    expect(md).toContain('📚 Documentation');
    expect(md).toContain('🟡 Medium, 🟢 Low or 💬 Nit');
    // Why the rest do not — this is the question the note exists to answer.
    expect(md).toContain('are counted in the tables above');
    expect(md).toContain('fix→push→new-comments loop');
    expect(md).toContain('Resolved threads reopen automatically');
  });

  /**
   * A "--" inside an HTML comment terminates it, and GitHub then renders the
   * rest of the body as visible text. RunMeta is numbers and a timestamp today,
   * so nothing can carry one — this is a REGRESSION GUARD: it fails the moment
   * someone adds a free-text or URL field to the marker payload without
   * escaping it.
   */
  it('keeps the marker payload free of "--", whatever a finding contains', () => {
    const merged = makeMerged({
      findings: [makeFinding({ title: 'Bad -- flag -- here', description: 'uses --force --hard' })],
    });
    const md = block(1, { merged });
    const marker = md.split('\n')[0];
    expect(marker.startsWith('<!--')).toBe(true);
    expect(marker.endsWith('-->')).toBe(true);
    expect(marker.slice(4, -3)).not.toContain('--');
    expect(parseRunBlocks(bodyWith(buildRunsSection(md, '', 0)))).toHaveLength(1);
  });
});

describe('parseRunBlocks', () => {
  it('round-trips a section it just built', () => {
    const body = bodyWith(buildRunsSection(block(1), '', 500));
    const parsed = parseRunBlocks(body);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].runNumber).toBe(1);
    expect(parsed?.[0].meta.t).toBe(3);
  });

  it('returns null for a region a human half-deleted', () => {
    const good = bodyWith(buildRunsSection(block(1), '', 500));
    expect(parseRunBlocks(good.replace(RUNS_REGION_END, ''))).toBeNull();
    expect(parseRunBlocks(good.replace('</details>', ''))).toBeNull();
    expect(parseRunBlocks(good.replace(/<!-- ai-pr-review-run:1 \{.*?\} -->/, ''))).toBeNull();
  });

  it('returns null (not a throw) when the marker JSON is corrupt', () => {
    const body = bodyWith(buildRunsSection(block(1), '', 500))
      .replace(/<!-- ai-pr-review-run:1 \{.*?\} -->/, '<!-- ai-pr-review-run:1 {not json} -->');
    expect(parseRunBlocks(body)).toBeNull();
  });

  it('returns an empty list when there is no region at all', () => {
    expect(parseRunBlocks('just a description')).toBeNull();
    expect(parseRunBlocks(`${RUNS_REGION_START}\n${RUNS_REGION_END}`)).toEqual([]);
  });
});

describe('buildRunsSection', () => {
  it('prepends the new run and demotes the previous latest', () => {
    const first = bodyWith(buildRunsSection(block(1), '', 500));
    const second = bodyWith(buildRunsSection(block(2), first, 500));

    const parsed = parseRunBlocks(second);
    expect(parsed?.map(b => b.runNumber)).toEqual([2, 1]);

    const [latest, previous] = parsed!;
    expect(latest.markdown).toContain('<details open>');
    expect(latest.markdown).toContain('<strong>Latest — Run #2</strong>');
    expect(previous.markdown).not.toContain('<details open>');
    expect(previous.markdown).toContain('Run #1 ·');
    expect(previous.markdown).not.toContain('<strong>Latest');
  });

  it('strips exactly All Findings and Agent Results from a demoted block, keeping the metrics', () => {
    const first = bodyWith(buildRunsSection(block(1), '', 500));
    const second = buildRunsSection(block(2), first, 500);
    const previous = parseRunBlocks(bodyWith(second))![1];

    expect(previous.markdown).not.toContain('All Findings');
    expect(previous.markdown).not.toContain('Agent Results');
    // The part with historical value survives.
    expect(previous.markdown).toContain('### 📊 Tracking Metrics');
    expect(previous.markdown).toContain('Findings by Severity');
    expect(previous.markdown).toContain('Critical & High Issues');
    expect(previous.markdown).toContain('🆕 **First run**');
  });

  it('is idempotent across many runs and never duplicates a run number', () => {
    let body = '';
    for (let run = 1; run <= 6; run++) {
      body = bodyWith(buildRunsSection(block(run), body, 500));
    }
    const parsed = parseRunBlocks(body)!;
    expect(parsed.map(b => b.runNumber)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(parsed.filter(b => b.markdown.includes('<details open>'))).toHaveLength(1);
  });

  it('re-running the SAME run number replaces rather than duplicates its block', () => {
    const first = bodyWith(buildRunsSection(block(1), '', 500));
    const again = parseRunBlocks(bodyWith(buildRunsSection(block(1), first, 500)))!;
    expect(again.map(b => b.runNumber)).toEqual([1]);
  });
});

describe('the degradation ladder', () => {
  /**
   * A realistically chunky run — big enough that a dozen of them blow the body
   * budget, but comfortably under RUN_BLOCK_MAX_CHARS so tier 2 is what gets
   * exercised rather than tier 4's per-block truncation.
   */
  function fatMerged(): ReturnType<typeof makeMerged> {
    const findings = Array.from({ length: 8 }, (_, i) =>
      makeFinding({
        line: i + 1,
        title: `Finding number ${i}`,
        description: 'x'.repeat(300),
      }));
    return makeMerged({ findings });
  }

  it('tier 2: degrades the oldest blocks to one-line rows and stays under the body limit', () => {
    let body = '';
    for (let run = 1; run <= 20; run++) {
      const section = buildRunsSection(
        renderRunBlock(run, fatMerged(), makeConfig(), makeContext(), makeActivity(), run > 1, AT),
        body,
        1000,
      );
      body = bodyWith(section);
    }

    expect(body.length).toBeLessThan(PR_BODY_MAX_CHARS);
    // The one-liner table appeared, and the latest run still has full detail.
    expect(body).toContain('Older runs (');
    expect(body).toContain('| Run | When |');
    expect(body).toContain('<strong>Latest — Run #20</strong>');
    expect(body).toContain('All Findings');
  });

  it('tier 3: says so out loud rather than silently dropping runs', () => {
    // A huge fixed prefix leaves almost no budget, forcing rows to be dropped.
    const otherContent = PR_BODY_MAX_CHARS - 6000;
    let body = '';
    for (let run = 1; run <= 12; run++) {
      body = bodyWith(buildRunsSection(
        renderRunBlock(run, fatMerged(), makeConfig(), makeContext(), makeActivity(), run > 1, AT),
        body,
        otherContent,
      ));
    }
    expect(body).toContain('Older runs trimmed to fit');
  });

  it('tier 4: a single pathological run still produces a valid, bounded block', () => {
    const huge = makeMerged({
      findings: Array.from({ length: 500 }, (_, i) =>
        makeFinding({ line: i + 1, title: `Finding ${i}`, description: 'y'.repeat(500) })),
    });
    const md = renderRunBlock(1, huge, makeConfig(), makeContext(), makeActivity(), false, AT);

    expect(md).toContain('Findings detail omitted');
    expect(md).toContain('### 📊 Tracking Metrics');
    // Still a well-formed block the next run can parse and carry forward.
    expect(parseRunBlocks(bodyWith(buildRunsSection(md, '', 0)))).toHaveLength(1);
  });

  it('a corrupt region is discarded, and content outside it is untouched', () => {
    const before = 'PRESERVE ME above.\n\n----AI-description----\n\n## What this PR does\n\nStuff.\n\n';
    const corrupted = before + buildRunsSection(block(1), '', 500).replace(RUNS_REGION_END, '');

    const section = buildRunsSection(block(2), corrupted, before.length);
    const rebuilt = parseRunBlocks(before + section)!;

    // Started fresh from this run rather than trying to repair the old region.
    expect(rebuilt.map(b => b.runNumber)).toEqual([2]);
    expect(section).toContain(RUNS_REGION_START);
    expect(section).toContain(RUNS_REGION_END);
  });
});

describe('highestRecordedRun', () => {
  it('reads the ordinal back out of the body so numbering survives comment deletion', () => {
    let body = '';
    for (let run = 1; run <= 4; run++) {
      body = bodyWith(buildRunsSection(block(run), body, 500));
    }
    expect(highestRecordedRun(body)).toBe(4);
  });

  it('is 0 for a body with no history', () => {
    expect(highestRecordedRun('nothing here')).toBe(0);
  });
});
