import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PROPOSE_KITCHEN_TOOLS_CLIENT_TIMEOUT_MS,
  PROPOSE_KITCHEN_TOOLS_TIMEOUT_SECONDS,
  type KitchenToolDoc,
  type KitchenToolProposalAI,
} from '@salt/domain/schemas';

const mockGenerate = vi.fn();

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: mockGenerate,
  },
}));

vi.mock('@genkit-ai/google-genai', () => ({
  googleAI: { model: (name: string) => name },
}));

// Stub withAiTimeout to call op() directly — timeout/retry logic is tested
// elsewhere. Keep everything else the module exports, so a factory listing only
// the wrapper does not go stale when the module grows.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));

vi.mock('../../src/ai/resolveModel.js', () => ({
  resolveModel: vi.fn().mockResolvedValue('gemini-flash-latest'),
}));

const { proposeKitchenToolsFlow, sanitiseKitchenToolProposals } =
  await import('../../src/flows/proposeKitchenTools.js');

beforeEach(() => {
  vi.clearAllMocks();
});

function tool(id: string, label: string, matchers: string[] = []): KitchenToolDoc {
  return {
    id,
    schemaVersion: 1,
    label,
    matchers,
    thumbnail: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** One untrusted answer, exactly as the model's schema shapes it. */
function said(
  label: string,
  kind: KitchenToolProposalAI['kind'],
  fields: { toolId?: string | null; suggestedLabel?: string | null } = {},
): KitchenToolProposalAI {
  return {
    label,
    kind,
    toolId: fields.toolId ?? null,
    suggestedLabel: fields.suggestedLabel ?? null,
  };
}

const VOCABULARY = [
  tool('mixing-bowl', 'Mixing bowl', ['bowl']),
  tool('potato-masher', 'Potato masher', ['masher']),
  // A tool with no other names — the commonest shape in the seeded vocabulary,
  // and the one whose prompt line has nothing after the name.
  tool('whisk', 'Whisk'),
];

describe('sanitiseKitchenToolProposals — the trust boundary', () => {
  it('keeps the REQUESTED spelling, matching the model case-insensitively', () => {
    // The page keys its rows by the word it asked about, so an answer that comes
    // back capitalised differently must still land on the row it belongs to.
    const out = sanitiseKitchenToolProposals(
      [said('TAGINE  DISH', 'new', { suggestedLabel: 'Tagine' })],
      ['tagine dish'],
      VOCABULARY,
    );
    expect(out).toEqual([{ kind: 'new', label: 'tagine dish', suggestedLabel: 'Tagine' }]);
  });

  it('drops an answer about a word it was never asked about', () => {
    const out = sanitiseKitchenToolProposals(
      [said('tagine dish', 'not-kit'), said('a word nobody asked about', 'not-kit')],
      ['tagine dish'],
      VOCABULARY,
    );
    expect(out).toEqual([{ kind: 'not-kit', label: 'tagine dish' }]);
  });

  it('keeps the first answer for a word and drops a second', () => {
    const out = sanitiseKitchenToolProposals(
      [said('tagine dish', 'not-kit'), said('tagine dish', 'new', { suggestedLabel: 'Tagine' })],
      ['tagine dish'],
      VOCABULARY,
    );
    expect(out).toEqual([{ kind: 'not-kit', label: 'tagine dish' }]);
  });

  it('drops an alias naming a tool that is not in the vocabulary it was sent', () => {
    // The row then falls back to its head-noun suggestion, which is exactly the
    // no-proposal state. A sentence pointing at nothing is worse than none.
    const out = sanitiseKitchenToolProposals(
      [said('tagine dish', 'alias', { toolId: 'invented-tool' })],
      ['tagine dish'],
      VOCABULARY,
    );
    expect(out).toEqual([]);
  });

  it('drops an alias that names no tool at all', () => {
    const out = sanitiseKitchenToolProposals(
      [said('tagine dish', 'alias')],
      ['tagine dish'],
      VOCABULARY,
    );
    expect(out).toEqual([]);
  });

  it('answers each word once, ignoring a blank or repeated request', () => {
    // A word that folds to nothing is not a row, and a word asked about twice is
    // still one row — the page keys by the spelling, so both would collide.
    const out = sanitiseKitchenToolProposals(
      [said('tagine dish', 'not-kit'), said('   ', 'not-kit')],
      ['tagine dish', 'tagine dish', '   '],
      VOCABULARY,
    );
    expect(out).toEqual([{ kind: 'not-kit', label: 'tagine dish' }]);
  });

  it('falls back to the word itself when a new tool comes back unnamed', () => {
    const out = sanitiseKitchenToolProposals(
      [said('tagine dish', 'new', { suggestedLabel: '   ' })],
      ['tagine dish'],
      VOCABULARY,
    );
    expect(out).toEqual([{ kind: 'new', label: 'tagine dish', suggestedLabel: 'tagine dish' }]);
  });
});

describe('the alias-over-new guard (Rule 12)', () => {
  // THE PINNED CLAIM: a `new` proposal whose model-suggested name contains an
  // existing tool's whole name, token-aligned, is never proposed as new. Verified
  // RED by deleting the `resolveKitchenTool(rawSuggestedLabel, tools)` lookup in
  // `sanitiseKitchenToolProposals` — the two cases below go red, and the third
  // (the control) stays green. There is deliberately no case checking the
  // REQUESTED word — see the next test and the guard's own header for why that
  // check has no input it can ever fire correctly on.
  it('turns a new tool into an alias when the SUGGESTED NAME already names one', () => {
    // A duplicate by a different route: nothing in "spud smasher" matches, but
    // minting a second document called "Potato masher" is the same #956 defect.
    const out = sanitiseKitchenToolProposals(
      [said('spud smasher', 'new', { suggestedLabel: 'Potato masher' })],
      ['spud smasher'],
      VOCABULARY,
    );
    expect(out).toEqual([{ kind: 'alias', label: 'spud smasher', toolId: 'potato-masher' }]);
  });

  it('matches a tool on its other names too, not only its own label', () => {
    const out = sanitiseKitchenToolProposals(
      [said('old masher', 'new', { suggestedLabel: 'Old masher' })],
      ['old masher'],
      VOCABULARY,
    );
    expect(out).toEqual([{ kind: 'alias', label: 'old masher', toolId: 'potato-masher' }]);
  });

  it('leaves a genuinely new tool alone — the control', () => {
    const out = sanitiseKitchenToolProposals(
      [said('tagine dish', 'new', { suggestedLabel: 'Tagine' })],
      ['tagine dish'],
      VOCABULARY,
    );
    expect(out).toEqual([{ kind: 'new', label: 'tagine dish', suggestedLabel: 'Tagine' }]);
  });

  it('leaves a `new` proposal alone even where the WORD itself would resolve — #1525 blocking finding 1', () => {
    // "Thermo Bowl" is `kitchenToolForKitLabel`'s own example of a manifest
    // accessory (#1460): the WORD resolves via `resolveKitchenTool` ('bowl' is a
    // matcher on Mixing bowl), which is exactly why the accessory rule refuses it
    // a picture and exactly why a row for it can reach this queue at all — every
    // `label` this function sees already failed that gate. Checking the word here
    // would rewrite that refusal into the very alias #1460 exists to prevent, on
    // the row's own leading press. Only the model's OWN suggested name is
    // checked, so a genuinely distinct name leaves the row `new`.
    const out = sanitiseKitchenToolProposals(
      [said('Thermo Bowl', 'new', { suggestedLabel: 'Thermal blending vessel' })],
      ['Thermo Bowl'],
      VOCABULARY,
    );
    expect(out).toEqual([
      { kind: 'new', label: 'Thermo Bowl', suggestedLabel: 'Thermal blending vessel' },
    ]);
  });

  it('does not touch a not-kit answer — the guard is about MINTING, not about naming', () => {
    // "20cm" is a size, and the vocabulary cannot name it either. The guard must
    // not turn every unrecognised word into an alias of something.
    const out = sanitiseKitchenToolProposals([said('20cm', 'not-kit')], ['20cm'], VOCABULARY);
    expect(out).toEqual([{ kind: 'not-kit', label: '20cm' }]);
  });
});

describe('proposeKitchenToolsFlow', () => {
  it('asks no model at all for an empty queue', async () => {
    const out = await proposeKitchenToolsFlow({ labels: [], tools: VOCABULARY });
    expect(out).toEqual({ proposals: [] });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('shows the model the vocabulary with its ids and other names', async () => {
    mockGenerate.mockResolvedValue({ output: { proposals: [] } });
    await proposeKitchenToolsFlow({ labels: ['tagine dish'], tools: VOCABULARY });
    const prompt = (mockGenerate.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain('[mixing-bowl] Mixing bowl — also called: bowl');
    // A tool with no other names says only its name — no dangling dash.
    expect(prompt).toContain('- [whisk] Whisk\n');
    expect(prompt).toContain('- tagine dish');
  });

  it('returns the sanitised answers', async () => {
    mockGenerate.mockResolvedValue({
      output: {
        proposals: [
          { label: 'masher handle', kind: 'alias', toolId: 'potato-masher', suggestedLabel: null },
          { label: '20cm', kind: 'not-kit', toolId: null, suggestedLabel: null },
        ],
      },
    });
    const out = await proposeKitchenToolsFlow({
      labels: ['masher handle', '20cm'],
      tools: VOCABULARY,
    });
    expect(out).toEqual({
      proposals: [
        { kind: 'alias', label: 'masher handle', toolId: 'potato-masher' },
        { kind: 'not-kit', label: '20cm' },
      ],
    });
  });

  it('throws on output the schema refuses, rather than passing it on', async () => {
    mockGenerate.mockResolvedValue({ output: { proposals: [{ label: 'x', kind: 'maybe' }] } });
    await expect(proposeKitchenToolsFlow({ labels: ['x'], tools: VOCABULARY })).rejects.toThrow(
      /invalid output/,
    );
  });
});

describe('proposeKitchenTools deadlines', () => {
  it('nests the three deadlines: AI budget < client < function', async () => {
    // The client's must also exceed the callable SDK's 70 s default, which is the
    // whole reason the wrapper passes one at all (#1529).
    const { AI_TEXT_FLOW_TIMEOUT } = await import('../../src/adapters/withAiTimeout.js');
    expect(AI_TEXT_FLOW_TIMEOUT.timeoutMs).toBeLessThan(PROPOSE_KITCHEN_TOOLS_CLIENT_TIMEOUT_MS);
    expect(PROPOSE_KITCHEN_TOOLS_CLIENT_TIMEOUT_MS).toBeLessThan(
      PROPOSE_KITCHEN_TOOLS_TIMEOUT_SECONDS * 1000,
    );
    expect(PROPOSE_KITCHEN_TOOLS_CLIENT_TIMEOUT_MS).toBeGreaterThan(70_000);
  });
});
