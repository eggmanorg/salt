import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RecipeDoc } from '@salt/domain/schemas';

// The kit branch's equipment context (issue #954). What is pinned here is the JOIN
// the defect was missing: the trigger reads the household's manifest and hands the
// rendered text to `identifyRecipeKitFlow`, so a label can say "Magimix Cook Expert"
// instead of "food processor" — the manifest holds four things that answer to the
// generic word, which is why the generic word answers nothing.
//
// The reader is NOT mocked. `readEquipmentContext` is the fail-open half of the
// contract (Rule 10) and mocking it would test the mock: every failure path here is
// driven through the Firestore stub instead, so what the suite proves is that a
// missing, corrupt or unreadable manifest still INFERS KIT — with '' — and never
// skips or fails inference.

vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_opts: unknown, handler: unknown) => handler,
}));
vi.mock('firebase-functions/params', () => ({ defineSecret: () => ({ value: () => '' }) }));
vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Typed as the real function, not inferred: `vi.fn(async () => …)` infers a
// ZERO-argument mock, so every recorded call is an empty tuple and reading
// `mock.calls[0][n]` — which this suite does throughout — cannot compile, while
// `mockResolvedValue` is pinned to the one literal used here (#1135).
const mockIdentifyKit = vi.fn<
  (...args: unknown[]) => Promise<{ kit: { label: string; stepIds: string[] }[] }>
>(async () => ({ kit: [{ label: 'potato masher', stepIds: ['s1'] }] }));
vi.mock('../../src/flows/identifyRecipeKit.js', () => ({
  identifyRecipeKitFlow: mockIdentifyKit,
}));

// The sibling hero-image branch is not this suite's subject; stub its flows so a
// recipe with steps cannot wander into one.
vi.mock('../../src/flows/generateRecipeImage.js', () => ({
  generateRecipeImageFlow: vi.fn(async () => ({ imageBase64: 'QUJD', contentType: 'image/png' })),
}));
vi.mock('../../src/flows/describeRecipeScene.js', () => ({
  describeRecipeSceneFlow: vi.fn(async () => ({ brief: 'A bowl of champ.' })),
}));
vi.mock('../../src/imaging/encodeHeroImage.js', () => ({
  encodeHeroImage: vi.fn(async () => Buffer.from([1, 2, 3])),
}));
vi.mock('../../src/flows/componentContext.js', () => ({
  readComponentContext: vi.fn(async () => []),
}));

// The partial this branch writes back — only the field these assertions read
// (mirrors onRecipeWritten.test.ts's local `RecipePatch`).
type KitPatch = { kit: unknown };
const mockUpdate = vi.fn<(patch: KitPatch) => Promise<undefined>>().mockResolvedValue(undefined);
// Collection-aware, because this branch reads TWO documents through the same
// `getFirestore()`: the devSettings kill-switch and the equipment manifest.
let manifestSnap: unknown = { exists: false };
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => 'DELETE' },
  getFirestore: () => ({
    collection: (name: string) => ({
      doc: () => ({
        update: mockUpdate,
        get: () =>
          name === 'equipmentManifest'
            ? typeof manifestSnap === 'function'
              ? (manifestSnap as () => Promise<unknown>)()
              : Promise.resolve(manifestSnap)
            : Promise.resolve({ exists: false }), // devSettings missing → enabled
      }),
    }),
  }),
}));
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({ name: 'demo-salt.appspot.com', file: () => ({ save: vi.fn() }) }),
  }),
}));
vi.mock('@salt/observability/server', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  flushServerObservability: vi.fn().mockResolvedValue(undefined),
  createServerObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
}));

const { onRecipeWritten } = await import('../../src/triggers/onRecipeWritten.js');

function manifestDoc(...names: string[]) {
  return {
    exists: true,
    data: () => ({
      schemaVersion: 1,
      updatedAt: '2026-07-01T00:00:00.000Z',
      items: names.map((name, i) => ({
        id: `eq-${i}`,
        schemaVersion: 1,
        name,
        accessories: [],
        rules: [],
        updatedAt: '2026-07-01T00:00:00.000Z',
      })),
    }),
  };
}

function makeRecipe(overrides: Partial<RecipeDoc> = {}): RecipeDoc {
  return {
    id: 'r1',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Champ',
    description: 'Buttery mashed potato.',
    ingredients: [],
    steps: [{ id: 's1', text: 'Blitz the potatoes in a food processor.', timer: null, note: null }],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    // The hero branch is out of scope here: an image already on the document is
    // what stops it, and it is not what any assertion below reads.
    image: { url: 'https://example.test/champ.png', source: 'ai' },
    kit: [],
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  } as unknown as RecipeDoc;
}

/** A create event — `before` absent, which is what `kitNeedsInference` asks to infer. */
function makeEvent(after: RecipeDoc) {
  return {
    params: { id: 'r1' },
    data: {
      before: { exists: false, data: () => undefined },
      after: { exists: true, data: () => after },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIdentifyKit.mockResolvedValue({ kit: [{ label: 'potato masher', stepIds: ['s1'] }] });
  manifestSnap = { exists: false };
});

describe('onRecipeWritten — kit inference gets the equipment manifest', () => {
  it('passes the manifest ITEMS to identifyRecipeKitFlow (issue #1465)', async () => {
    // Structured, not rendered: the flow renders them itself so the prompt's
    // handles and the map that reads them back come from one pass.
    manifestSnap = manifestDoc('Magimix Cook Expert', 'OXO Good Grips Chef’s Mandoline');

    await (onRecipeWritten as unknown as (e: unknown) => Promise<void>)(makeEvent(makeRecipe()));

    expect(mockIdentifyKit).toHaveBeenCalledTimes(1);
    const arg = mockIdentifyKit.mock.calls[0]?.[0] as { equipment: { name: string }[] };
    expect(arg.equipment.map((i) => i.name)).toEqual([
      'Magimix Cook Expert',
      'OXO Good Grips Chef’s Mandoline',
    ]);
  });

  it('still infers, with an empty manifest, when the doc is missing', async () => {
    manifestSnap = { exists: false };

    await (onRecipeWritten as unknown as (e: unknown) => Promise<void>)(makeEvent(makeRecipe()));

    expect(mockIdentifyKit).toHaveBeenCalledTimes(1);
    expect((mockIdentifyKit.mock.calls[0]?.[0] as { equipment: unknown[] }).equipment).toEqual([]);
    // And the answer is still written back — a household with no manifest gets the
    // pre-#954 behaviour, not a skipped inference.
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ kit: [{ label: 'potato masher', stepIds: ['s1'] }] }),
    );
  });

  it('still infers, with an empty manifest, when the doc fails validation', async () => {
    manifestSnap = { exists: true, data: () => ({ schemaVersion: 'nope' }) };

    await (onRecipeWritten as unknown as (e: unknown) => Promise<void>)(makeEvent(makeRecipe()));

    expect((mockIdentifyKit.mock.calls[0]?.[0] as { equipment: unknown[] }).equipment).toEqual([]);
  });

  it('still infers, with an empty manifest, when the read throws', async () => {
    manifestSnap = () => Promise.reject(new Error('unavailable'));

    await (onRecipeWritten as unknown as (e: unknown) => Promise<void>)(makeEvent(makeRecipe()));

    expect((mockIdentifyKit.mock.calls[0]?.[0] as { equipment: unknown[] }).equipment).toEqual([]);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ kit: expect.anything() }));
  });
});
