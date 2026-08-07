import { Octokit } from '@octokit/rest';
import {
  resolveRunNumber,
  writePRDescription,
  DescriptionContent,
} from '../../src/pipeline/description-updater';
import { parseRunBlocks } from '../../src/results/run-history';
import { makeActivity, makeConfig, makeContext, makeMerged } from '../fixtures/factory';

jest.mock('@actions/core', () => ({
  info: jest.fn(), warning: jest.fn(), debug: jest.fn(),
  startGroup: jest.fn(), endGroup: jest.fn(), setOutput: jest.fn(),
}));

const USER_TEXT = "Reviewer's own notes — MUST SURVIVE every run.";
const DIAGRAM = '```mermaid\nflowchart TD\n  A["Start"] --> B["End"]\n```';
const NARRATIVE = '## What this PR does\n\nAdds user endpoints.\n\n## Changes\n\n- endpoint added';

/** An octokit whose `pulls.get` returns `body` and whose `update` records it. */
function fakeOctokit(body: string): { octokit: Octokit; written: () => string } {
  let written = '';
  const octokit = {
    pulls: {
      get: jest.fn().mockImplementation(() => Promise.resolve({ data: { body } })),
      update: jest.fn().mockImplementation((args: { body: string }) => {
        written = args.body;
        return Promise.resolve({});
      }),
    },
  } as unknown as Octokit;
  return { octokit, written: () => written };
}

function write(
  body: string,
  runNumber: number,
  content: DescriptionContent | null,
  isRerun = false,
): Promise<string> {
  const { octokit, written } = fakeOctokit(body);
  return writePRDescription(
    octokit,
    makeConfig(),
    makeMerged(),
    makeContext(),
    makeActivity(),
    content,
    runNumber,
    isRerun,
  ).then(() => written());
}

const FRESH: DescriptionContent = { narrative: NARRATIVE, diagrams: DIAGRAM };

describe('writePRDescription — first run', () => {
  it('preserves the user description and adds the AI section below the separator', async () => {
    const out = await write(USER_TEXT, 1, FRESH);

    expect(out.indexOf(USER_TEXT)).toBe(0);
    expect(out.indexOf(USER_TEXT)).toBeLessThan(out.indexOf('----AI-description----'));
    expect(out).toContain(NARRATIVE);
    expect(parseRunBlocks(out)?.map(b => b.runNumber)).toEqual([1]);
  });

  it('wraps diagrams in a foldable block that is open by default', async () => {
    const out = await write(USER_TEXT, 1, FRESH);

    expect(out).toContain('<details open>\n<summary><strong>🧭 Diagrams</strong></summary>');
    // GitHub will not render a mermaid fence without a blank line after </summary>.
    expect(out).toMatch(/<summary><strong>🧭 Diagrams<\/strong><\/summary>\n\n```mermaid/);
    expect(out).toContain('flowchart TD');
  });

  it('writes the JIRA line exactly once', async () => {
    const out = await write(USER_TEXT, 1, FRESH);
    expect(out.match(/\*\*JIRA:\*\*/g)).toHaveLength(1);
  });
});

describe('writePRDescription — re-runs reuse the AI content', () => {
  /** Runs the writer repeatedly, feeding each output back in as the next body. */
  async function runTimes(times: number): Promise<string[]> {
    const outputs: string[] = [];
    let body = USER_TEXT;
    for (let run = 1; run <= times; run++) {
      // Only the first run generates AI content; re-runs pass null, exactly as
      // the orchestrator does.
      body = await write(body, run, run === 1 ? FRESH : null, run > 1);
      outputs.push(body);
    }
    return outputs;
  }

  it('keeps the narrative byte-stable across re-runs — no erosion, no duplication', async () => {
    const [, second, third] = await runTimes(3);

    const narrativeOf = (b: string): string =>
      b.slice(b.indexOf('## What this PR does'), b.indexOf('**JIRA:**'));
    expect(narrativeOf(third)).toBe(narrativeOf(second));
    expect(third.match(/## What this PR does/g)).toHaveLength(1);
    expect(third.match(/## Changes/g)).toHaveLength(1);
  });

  it('carries the diagrams forward without nesting or losing them', async () => {
    const [, , third] = await runTimes(3);

    expect(third).toContain('flowchart TD');
    expect(third.match(/🧭 Diagrams/g)).toHaveLength(1);
    expect(third.match(/```mermaid/g)).toHaveLength(1);
  });

  it('never duplicates the JIRA line or loses the user description', async () => {
    const [, , third] = await runTimes(3);

    expect(third.match(/\*\*JIRA:\*\*/g)).toHaveLength(1);
    expect(third.indexOf(USER_TEXT)).toBe(0);
    expect(third.match(new RegExp(USER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
  });

  it('accumulates one run block per run, newest first', async () => {
    const [, , third] = await runTimes(3);
    expect(parseRunBlocks(third)?.map(b => b.runNumber)).toEqual([3, 2, 1]);
  });

  it('updates the counts on every run — the bug this replaced froze them', async () => {
    const { octokit, written } = fakeOctokit(await write(USER_TEXT, 1, FRESH));
    await writePRDescription(
      octokit,
      makeConfig(),
      makeMerged({ findings: [], totalFindings: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, nitCount: 0 }),
      makeContext(),
      makeActivity(),
      null,
      2,
      true,
    );

    const blocks = parseRunBlocks(written())!;
    expect(blocks[0].meta.t).toBe(0);   // this run found nothing
    expect(blocks[1].meta.t).toBe(3);   // the previous run's numbers are intact
  });
});

describe('writePRDescription — migrating a body from the previous layout', () => {
  const LEGACY = [
    USER_TEXT,
    '',
    '----AI-description----',
    '',
    '## Diagrams',
    '',
    DIAGRAM,
    '',
    NARRATIVE,
    '',
    '**JIRA:** [TEL-101](https://jira.example.test/browse/TEL-101) — User CRUD endpoints',
    '',
    '### Review Summary',
    '',
    '| Severity | Count |',
    '|----------|-------|',
    '| 🔴 High | 1 |',
    '| **Total** | **12** |',
    '',
    '<sub>Last reviewed: 2026-07-27T07:08:38.413Z | Model: glm-5.2 | Mode: combined</sub>',
  ].join('\n');

  it('strips the stale Review Summary table it supersedes', async () => {
    const out = await write(LEGACY, 2, null, true);

    expect(out).not.toContain('### Review Summary');
    expect(out).not.toContain('Last reviewed:');
    expect(out).not.toContain('**12**');
    expect(out).toContain('### 📊 Review Runs');
  });

  it('lifts legacy "## Diagrams" into the foldable wrapper without losing the mermaid', async () => {
    const out = await write(LEGACY, 2, null, true);

    expect(out).toContain('flowchart TD');
    expect(out).toContain('<summary><strong>🧭 Diagrams</strong></summary>');
    expect(out).not.toContain('## Diagrams');
    expect(out.match(/```mermaid/g)).toHaveLength(1);
  });

  it('keeps the narrative and the user description, and does not double the JIRA line', async () => {
    const out = await write(LEGACY, 2, null, true);

    expect(out.indexOf(USER_TEXT)).toBe(0);
    expect(out).toContain('Adds user endpoints.');
    expect(out.match(/\*\*JIRA:\*\*/g)).toHaveLength(1);
  });

  it('is stable when migrated twice', async () => {
    const once = await write(LEGACY, 2, null, true);
    const twice = await write(once, 3, null, true);

    expect(twice.match(/## What this PR does/g)).toHaveLength(1);
    expect(twice.match(/```mermaid/g)).toHaveLength(1);
    expect(twice.match(/\*\*JIRA:\*\*/g)).toHaveLength(1);
    expect(parseRunBlocks(twice)?.map(b => b.runNumber)).toEqual([3, 2]);
  });
});

describe('resolveRunNumber', () => {
  it('is 1 for a PR with no history at all', async () => {
    const { octokit } = fakeOctokit(USER_TEXT);
    await expect(resolveRunNumber(octokit, makeConfig(), 0)).resolves.toBe(1);
  });

  it('continues from the description when the bot comments were deleted', async () => {
    let body = USER_TEXT;
    for (let run = 1; run <= 4; run++) {
      body = await write(body, run, run === 1 ? FRESH : null, run > 1);
    }
    const { octokit } = fakeOctokit(body);

    // rerunNumber 0 = every completed-review comment was deleted.
    await expect(resolveRunNumber(octokit, makeConfig(), 0)).resolves.toBe(5);
    // The comment count still wins when it is ahead (description was edited away).
    await expect(resolveRunNumber(octokit, makeConfig(), 9)).resolves.toBe(10);
  });

  it('falls back to the comment count on a legacy or corrupt body', async () => {
    const { octokit } = fakeOctokit('----AI-description----\n\n### Review Summary\n');
    await expect(resolveRunNumber(octokit, makeConfig(), 5)).resolves.toBe(6);
  });

  it('falls back rather than throwing when the PR cannot be fetched', async () => {
    const octokit = {
      pulls: { get: jest.fn().mockRejectedValue(new Error('404')) },
    } as unknown as Octokit;
    await expect(resolveRunNumber(octokit, makeConfig(), 2)).resolves.toBe(3);
  });
});
