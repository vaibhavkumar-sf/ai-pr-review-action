// Mock @actions/core so getInput reads from process.env (as the real Docker
// runtime does) and setSecret/warning are observable.
jest.mock('@actions/core', () => ({
  getInput: (name: string): string =>
    (process.env[`INPUT_${name.toUpperCase().replace(/[ -]/g, '_')}`] ?? '').trim(),
  setSecret: jest.fn(),
  warning: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  context: { repo: { owner: 'acme', repo: 'widget' }, payload: {} as Record<string, unknown> },
}));

import * as core from '@actions/core';
import * as github from '@actions/github';
import { parseActionInputs } from '../../src/config/inputs';
import { INPUTS } from '../../src/config/schema';
import { DEFAULT_EXCLUDE_PATTERNS } from '../../src/config/patterns';

const defaultOf = (name: string): string => INPUTS.find(s => s.name === name)!.default;

function setInputs(map: Record<string, string>): void {
  for (const [k, v] of Object.entries(map)) {
    process.env[`INPUT_${k.toUpperCase()}`] = v;
  }
}

describe('parseActionInputs', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    // Clear every INPUT_* var so each test starts from schema defaults.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('INPUT_')) delete process.env[key];
    }
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_NUMBER;
    (github.context.payload as Record<string, unknown>) = {};
    jest.clearAllMocks();
  });

  afterAll(() => { process.env = saved; });

  function validMinimum(): void {
    setInputs({ github_token: 'gh', anthropic_auth_token: 'secret-key' });
    (github.context.payload as Record<string, unknown>).pull_request = { number: 42 };
  }

  it('batches ALL missing required inputs into one error', () => {
    // Nothing set, no PR in payload → github_token + anthropic_auth_token + pr number
    let error: Error | undefined;
    try { parseActionInputs(); } catch (e) { error = e as Error; }
    expect(error).toBeDefined();
    expect(error!.message).toContain('github_token');
    expect(error!.message).toContain('anthropic_auth_token');
    expect(error!.message).toContain('PR number');
  });

  it('applies schema defaults when inputs are unset', () => {
    validMinimum();
    const config = parseActionInputs();
    expect(config.aiProvider).toBe('anthropic');
    expect(config.anthropicModel).toBe(defaultOf('anthropic_model'));
    expect(config.maxRetries).toBe(parseInt(defaultOf('max_retries'), 10));
    expect(config.owner).toBe('acme');
    expect(config.prNumber).toBe(42);
  });

  it('parses booleans and numbers', () => {
    validMinimum();
    setInputs({ fail_on_critical: 'true', max_retries: '5' });
    const config = parseActionInputs();
    expect(config.failOnCritical).toBe(true);
    expect(config.maxRetries).toBe(5);
  });

  it('enables re-run focus by default and honors an explicit opt-out', () => {
    validMinimum();
    expect(parseActionInputs().enableRerunFocus).toBe(true);

    setInputs({ enable_rerun_focus: 'false' });
    expect(parseActionInputs().enableRerunFocus).toBe(false);
  });

  it('falls back to the default and warns on a malformed number', () => {
    validMinimum();
    setInputs({ max_retries: 'abc' });
    const config = parseActionInputs();
    expect(config.maxRetries).toBe(parseInt(defaultOf('max_retries'), 10));
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('max_retries'));
  });

  it('masks secret inputs via core.setSecret', () => {
    validMinimum();
    parseActionInputs();
    expect(core.setSecret).toHaveBeenCalledWith('secret-key');
  });

  it('appends user exclude patterns to the built-in defaults', () => {
    validMinimum();
    setInputs({ exclude_patterns: '**/foo/**, **/bar/**' });
    const config = parseActionInputs();
    expect(config.excludePatterns).toEqual(expect.arrayContaining([...DEFAULT_EXCLUDE_PATTERNS, '**/foo/**', '**/bar/**']));
    expect(config.excludePatterns.length).toBe(DEFAULT_EXCLUDE_PATTERNS.length + 2);
  });

  it('honors a tri-state agent toggle in separate mode', () => {
    validMinimum();
    setInputs({ review_mode: 'separate', review_profile: 'minimal', enable_testing_review: 'true' });
    const config = parseActionInputs();
    expect(config.enabledAgents).toContain('testing');
  });

  it('reads workflow run identifiers from the environment', () => {
    validMinimum();
    process.env.GITHUB_RUN_ID = '999';
    process.env.GITHUB_RUN_NUMBER = '7';
    const config = parseActionInputs();
    expect(config.workflowRunId).toBe('999');
    expect(config.workflowRunNumber).toBe(7);
  });
});
