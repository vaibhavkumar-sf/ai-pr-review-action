import { generateDiagramImages } from '../../src/results/image-diagram-generator';
import { AIProvider, ChatResponse } from '../../src/providers/ai-provider';
import { ReviewContext, MergedReviewResult } from '../../src/types';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
}));

// Validation is exercised against a controllable stub — the real validator
// drags in jsdom + mermaid and network fallback, which unit tests must not.
jest.mock('../../src/utils/mermaid', () => ({
  sanitizeMermaidCode: jest.fn((code: string) => code),
  validateMermaid: jest.fn(),
}));

import { validateMermaid } from '../../src/utils/mermaid';
const validateMock = validateMermaid as jest.Mock;

const STYLED_FLOW = "%%{init: {'theme': 'base'}}%%\nflowchart TD\n    A[\"🚀 Start\"] --> B[\"Done\"]";
const SIMPLE_FLOW = 'flowchart TD\n    A["Start"] --> B["Done"]';
const STYLED_SEQ = 'sequenceDiagram\n    autonumber\n    A->>B: hi';
const SIMPLE_SEQ = 'sequenceDiagram\n    A->>B: hi';

function fakeProvider(responses: string[]): { provider: AIProvider; calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  const provider = {
    chat: jest.fn(async (): Promise<ChatResponse> => {
      calls.push(i);
      const content = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { content, inputTokens: 1, outputTokens: 1 };
    }),
  } as unknown as AIProvider;
  return { provider, calls };
}

function fullResponse(overrides: Record<string, string | null> = {}): string {
  return JSON.stringify({
    flowchart_styled: STYLED_FLOW,
    flowchart_simple: SIMPLE_FLOW,
    sequence_styled: STYLED_SEQ,
    sequence_simple: SIMPLE_SEQ,
    ...overrides,
  });
}

const context = {
  prTitle: 'feat: add thing',
  headBranch: 'feat/x',
  baseBranch: 'main',
  framework: 'node',
  changedFiles: [{ filename: 'src/a.ts', status: 'modified' }],
  diff: 'diff --git a/src/a.ts b/src/a.ts',
} as unknown as ReviewContext;

const merged = {} as MergedReviewResult;

beforeEach(() => {
  validateMock.mockReset();
});

describe('generateDiagramImages — dual-fidelity selection', () => {
  it('posts the STYLED variants when they validate, in a single AI call', async () => {
    validateMock.mockResolvedValue(null); // everything valid
    const { provider } = fakeProvider([fullResponse()]);

    const out = await generateDiagramImages(context, merged, provider);

    expect(out).toContain(STYLED_FLOW);
    expect(out).toContain(STYLED_SEQ);
    expect(out).not.toContain(SIMPLE_FLOW);
    expect((provider.chat as jest.Mock)).toHaveBeenCalledTimes(1);
    // Styled variants win → their simple twins are never even validated.
    expect(validateMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the SIMPLE twin when the styled variant fails, still one AI call', async () => {
    validateMock.mockImplementation(async (code: string) =>
      code.includes('%%{init') || code.includes('autonumber') ? 'parse error' : null);
    const { provider } = fakeProvider([fullResponse()]);

    const out = await generateDiagramImages(context, merged, provider);

    expect(out).toContain(SIMPLE_FLOW);
    expect(out).toContain(SIMPLE_SEQ);
    expect(out).not.toContain('%%{init');
    expect((provider.chat as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('spends the fix retry only when BOTH variants of a diagram are broken', async () => {
    // First response: flowchart broken in both variants; second response fixes it.
    validateMock.mockImplementation(async (code: string) =>
      code.includes('BROKEN') ? 'parse error near BROKEN' : null);
    const { provider } = fakeProvider([
      fullResponse({ flowchart_styled: 'BROKEN 1', flowchart_simple: 'BROKEN 2' }),
      fullResponse(),
    ]);

    const out = await generateDiagramImages(context, merged, provider);

    expect((provider.chat as jest.Mock)).toHaveBeenCalledTimes(2);
    expect(out).toContain(STYLED_FLOW);
    expect(out).toContain(STYLED_SEQ);
    // The fix request names both broken variants with their errors.
    const fixMessages = (provider.chat as jest.Mock).mock.calls[1][0];
    const fixPrompt = fixMessages[fixMessages.length - 1].content as string;
    expect(fixPrompt).toContain('Flowchart (styled) error');
    expect(fixPrompt).toContain('Flowchart (simple) error');
    expect(fixPrompt).not.toContain('Sequence (');
  });

  it('drops a diagram that stays broken after the retry, keeping the healthy one', async () => {
    validateMock.mockImplementation(async (code: string) =>
      code.includes('flowchart') || code.includes('BROKEN') ? 'parse error' : null);
    const { provider } = fakeProvider([
      fullResponse({ flowchart_styled: 'BROKEN', flowchart_simple: 'BROKEN' }),
    ]);

    const out = await generateDiagramImages(context, merged, provider);

    expect(out).not.toContain('Flow Diagram');
    expect(out).toContain('Sequence Diagram');
    expect(out).toContain(STYLED_SEQ);
  });

  it('accepts the legacy single-variant keys as the simple fallback', async () => {
    validateMock.mockResolvedValue(null);
    const { provider } = fakeProvider([
      JSON.stringify({ flowchart: SIMPLE_FLOW, sequence: SIMPLE_SEQ }),
    ]);

    const out = await generateDiagramImages(context, merged, provider);

    expect(out).toContain(SIMPLE_FLOW);
    expect(out).toContain(SIMPLE_SEQ);
  });

  it('treats a null sequence (both fields) as not-applicable, not a failure', async () => {
    validateMock.mockResolvedValue(null);
    const { provider } = fakeProvider([
      fullResponse({ sequence_styled: null, sequence_simple: null }),
    ]);

    const out = await generateDiagramImages(context, merged, provider);

    expect(out).toContain('Flow Diagram');
    expect(out).not.toContain('Sequence Diagram');
    expect((provider.chat as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});
