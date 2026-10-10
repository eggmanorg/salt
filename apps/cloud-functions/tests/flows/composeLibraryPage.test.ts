/**
 * The page writer (issue #1663) — `composeLibraryPageForChef`.
 *
 * Its promise is that it NEVER COSTS A WRITE: whatever goes wrong, it answers
 * `{ laidOut: false }` and the chef's draft is saved instead. Each case below is
 * one way it can go wrong. The figure case is the Rule 12 pin the issue names —
 * remove the `checkComposedPage` call and it goes red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from 'firebase-functions';
import { findLibraryBlocks } from '@salt/domain';
import { LIBRARY_BLOCK_KINDS, parseLibraryBlock } from '@salt/domain/schemas';

vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
vi.spyOn(logger, 'info').mockImplementation(() => undefined);

const mockReport = vi.fn();
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportServerError: (...args: unknown[]) => mockReport(...args),
}));

const mockGenerate = vi.fn();
vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: (...args: unknown[]) => mockGenerate(...args),
  },
}));
const mockFlowModel = vi.fn(async (_id: string) => 'fake-model');
vi.mock('../../src/ai/fakeModel.js', () => ({
  flowModel: (id: string) => mockFlowModel(id),
}));

const {
  composeLibraryPageForChef,
  unwrapWholeBodyFence,
  COMPOSE_LIBRARY_PAGE_TIMEOUT,
  COMPOSE_LIBRARY_PAGE_SYSTEM,
} = await import('../../src/flows/composeLibraryPage.js');

const DRAFT =
  'Duck breast: render at 130–140 °C, then crisp at 175 °C. Use Probe Control for poaching.';
const GOOD = [
  '```salt-cards',
  'groups:',
  '  - cards:',
  '      - title: Duck breast',
  '        arrows: true',
  '        chips:',
  '          - label: 130–140°',
  '            tone: sage',
  '          - label: 175°',
  '            tone: terracotta',
  '```',
  '',
  '```salt-callout',
  'tone: warning',
  'label: Probe Control',
  'body: Use it for poaching.',
  '```',
].join('\n');

beforeEach(() => {
  mockGenerate.mockReset();
  mockReport.mockReset();
});

describe('composeLibraryPageForChef — a layout that passes is kept', () => {
  it('returns the laid-out body', async () => {
    mockGenerate.mockResolvedValue({ text: GOOD });
    expect(await composeLibraryPageForChef('Control Freak', DRAFT)).toEqual({
      laidOut: true,
      body: GOOD,
    });
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('resolves its own model and sends the style guide as the system prompt', async () => {
    mockGenerate.mockResolvedValue({ text: GOOD });
    await composeLibraryPageForChef('Control Freak', DRAFT);
    expect(mockFlowModel).toHaveBeenCalledWith('composeLibraryPage');
    const request = mockGenerate.mock.calls[0]![0] as { system: string; prompt: string };
    expect(request.system).toBe(COMPOSE_LIBRARY_PAGE_SYSTEM);
    expect(request.prompt).toContain('Control Freak');
    expect(request.prompt).toContain(DRAFT);
  });

  it('unwraps a fence the model put round the whole answer', async () => {
    mockGenerate.mockResolvedValue({ text: `\`\`\`markdown\n${GOOD}\n\`\`\`` });
    expect(await composeLibraryPageForChef('Control Freak', DRAFT)).toEqual({
      laidOut: true,
      body: GOOD,
    });
  });
});

describe('composeLibraryPageForChef — every failure keeps the draft', () => {
  it('a layout that DROPS a figure is refused', async () => {
    mockGenerate.mockResolvedValue({ text: GOOD.replace('175°', 'hot') });
    expect(await composeLibraryPageForChef('Control Freak', DRAFT)).toEqual({ laidOut: false });
  });

  it('a layout that CHANGES a figure is refused', async () => {
    mockGenerate.mockResolvedValue({ text: GOOD.replace('175°', '180°') });
    expect(await composeLibraryPageForChef('Control Freak', DRAFT)).toEqual({ laidOut: false });
  });

  it('a layout with a block that does not parse is refused', async () => {
    mockGenerate.mockResolvedValue({ text: GOOD.replace('tone: warning', 'tone: red') });
    expect(await composeLibraryPageForChef('Control Freak', DRAFT)).toEqual({ laidOut: false });
  });

  it('a blank answer is refused', async () => {
    mockGenerate.mockResolvedValue({ text: '' });
    expect(await composeLibraryPageForChef('Control Freak', DRAFT)).toEqual({ laidOut: false });
  });

  it('a model error is refused, and reported as an AI failure', async () => {
    const boom = new Error('upstream 500');
    mockGenerate.mockRejectedValue(boom);
    expect(await composeLibraryPageForChef('Control Freak', DRAFT)).toEqual({ laidOut: false });
    expect(mockReport).toHaveBeenCalledWith(boom);
  });

  describe('a model that never answers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('gives up at its own deadline and keeps the draft', async () => {
      mockGenerate.mockReturnValue(new Promise(() => {}));
      const pending = composeLibraryPageForChef('Control Freak', DRAFT);
      await vi.advanceTimersByTimeAsync(COMPOSE_LIBRARY_PAGE_TIMEOUT.timeoutMs + 1);
      expect(await pending).toEqual({ laidOut: false });
      expect(mockGenerate).toHaveBeenCalledTimes(1);
      expect(mockReport).toHaveBeenCalledTimes(1);
    });
  });
});

describe('the page writer’s budget', () => {
  it('fits inside the chat stream’s 55 s idle window with room either side, and never retries', () => {
    // The tool run is silence to the stream; the model's last chunk before the
    // call and its first after share the same 55 s (chefChat.ts, the drain).
    expect(COMPOSE_LIBRARY_PAGE_TIMEOUT.timeoutMs).toBeLessThanOrEqual(55_000 / 2);
    expect(COMPOSE_LIBRARY_PAGE_TIMEOUT.retries).toBe(0);
  });
});

describe('the style guide', () => {
  // The model copies the guide's examples. An example the schema refuses would
  // teach it to write layouts the figure-and-block check then throws away.
  const examples = findLibraryBlocks(COMPOSE_LIBRARY_PAGE_SYSTEM);

  it('shows an example of every kind there is, and no other', () => {
    expect([...new Set(examples.map((b) => b.kind))].sort()).toEqual(
      [...LIBRARY_BLOCK_KINDS].sort(),
    );
  });

  it.each(examples.map((b) => [b.kind, b.source] as const))(
    'its salt-%s example parses',
    (kind, source) => {
      const parsed = parseLibraryBlock(kind, source);
      expect(parsed.ok ? 'ok' : parsed.problem).toBe('ok');
    },
  );
});

describe('unwrapWholeBodyFence', () => {
  it('leaves a body that merely starts with a block alone', () => {
    expect(unwrapWholeBodyFence(GOOD)).toBe(GOOD);
  });
  it('unwraps an unlabelled or md fence round the whole answer', () => {
    expect(unwrapWholeBodyFence('```\n# A\n```')).toBe('# A');
    expect(unwrapWholeBodyFence('```md\n# A\n```')).toBe('# A');
  });
});
