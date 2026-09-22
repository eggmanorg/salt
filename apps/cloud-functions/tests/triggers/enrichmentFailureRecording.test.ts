import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { emptyRecipe, newStep } from '@salt/domain';
import type { RecipeDoc } from '@salt/domain/schemas';

// A background job that gives up says so (issue #1419, Phase 1).
//
// What this file pins is the thing the whole issue exists for: after a failure
// there is a ROW, and after the next success there is not. Before it, the only
// trace of a job giving up was a Cloud Logging line and a PostHog event — which
// is why four recipes reached the library with no equipment list and nothing in
// the app could tell that apart from a dish that genuinely needs no equipment
// (#1418).
//
// Three properties, each stated as the failure it prevents:
//
//   1. RECORD ON FAILURE. Drop the `recordEnrichmentFailure` call from any of
//      the catch blocks and its case here goes red — the collection stays empty
//      and the marker never renders.
//   2. CLEAR ON SUCCESS. Drop the `clearEnrichmentFailure` call and the marker
//      outlives the repair: a recipe fixed by "Redo kit" keeps saying it
//      couldn't be worked out, forever.
//   3. RECORDING NEVER COSTS THE ENRICHMENT (Rule 10). Take the inner catch out
//      of `recordEnrichmentFailure` and the last case goes red — the rejection
//      escapes its branch, the handler's `Promise.allSettled` sibling is retried
//      whole, and a branch that had already succeeded is paid for twice.
//
// The equipment-brief branch's own record is pinned beside its trigger, in
// `onEquipmentManifestWritten.test.ts`, where the manifest fixture already lives.

vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_opts: unknown, handler: unknown) => handler,
}));
vi.mock('firebase-functions/params', () => ({ defineSecret: () => ({ value: () => '' }) }));
vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── Firestore: collection-aware, because three collections are in play ──────
// The enrichment's own write-back, the relocated canon embedding, and the new
// failure records. Everything else (devSettings, equipmentManifest) answers
// "absent", which reads as kill-switch-enabled and no manifest.
const recordedIds: string[] = [];
const clearedIds: string[] = [];
const failureSet = vi.fn<(id: string, doc: unknown) => Promise<undefined>>(async (id, _doc) => {
  recordedIds.push(id);
  return undefined;
});
const failureDelete = vi.fn<(id: string) => Promise<undefined>>(async (id) => {
  clearedIds.push(id);
  return undefined;
});
const recipeUpdate = vi
  .fn<(patch: Record<string, unknown>) => Promise<undefined>>()
  .mockResolvedValue(undefined);
const embeddingSet = vi.fn<(doc: unknown) => Promise<undefined>>().mockResolvedValue(undefined);

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => 'DELETE' },
  getFirestore: () => ({
    collection: (name: string) => ({
      doc: (id: string) => {
        if (name === 'enrichmentFailures') {
          return {
            set: (docData: unknown) => failureSet(id, docData),
            delete: () => failureDelete(id),
          };
        }
        if (name === 'canonEmbeddings') {
          return { set: embeddingSet, get: async () => ({ exists: false }) };
        }
        return { update: recipeUpdate, get: async () => ({ exists: false }) };
      },
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

// ─── Flows: every one of them is a knob this suite turns to "throw" ──────────
const mockImage = vi.fn<(input: unknown) => Promise<{ imageBase64: string }>>(async () => ({
  imageBase64: 'QUJD',
}));
vi.mock('../../src/flows/generateRecipeImage.js', () => ({ generateRecipeImageFlow: mockImage }));
vi.mock('../../src/flows/describeRecipeScene.js', () => ({
  describeRecipeSceneFlow: vi.fn(async () => ({ brief: 'A blistered, golden-topped bake.' })),
}));
vi.mock('../../src/imaging/encodeHeroImage.js', () => ({
  encodeHeroImage: vi.fn(async () => Buffer.from([1, 2, 3])),
}));
vi.mock('../../src/flows/componentContext.js', () => ({
  readComponentContext: vi.fn(async () => []),
}));

const mockKit = vi.fn<(input: unknown) => Promise<{ kit: { label: string; stepIds: string[] }[] }>>(
  async () => ({ kit: [{ label: 'potato masher', stepIds: ['s1'] }] }),
);
vi.mock('../../src/flows/identifyRecipeKit.js', () => ({ identifyRecipeKitFlow: mockKit }));

const mockTimes = vi.fn<(input: unknown) => Promise<Record<string, unknown>>>(async () => ({
  prepMinutes: 10,
  cookMinutes: 20,
  totalMinutes: 30,
  phases: [],
}));
vi.mock('../../src/flows/estimateRecipeTimes.js', () => ({ estimateRecipeTimesFlow: mockTimes }));

const mockEmbed = vi.fn<(input: unknown) => Promise<{ values: number[] }>>(async () => ({
  values: [0.1, 0.2],
}));
vi.mock('../../src/flows/embedText.js', () => ({ embedTextFlow: mockEmbed }));
vi.mock('../../src/flows/generateCanonIcon.js', () => ({
  generateCanonIconFlow: vi.fn(async () => ({ imageBase64: 'QUJD' })),
}));

// The icon chain past the draw. Not this suite's subject, and a real libvips
// decode of three bytes is not a thing.
vi.mock('../../src/imaging/removeFlatBackground.js', () => ({
  removeFlatBackground: vi.fn(async (b: Buffer) => b),
}));
vi.mock('../../src/imaging/normalizeIconFraming.js', () => ({
  normalizeIconFraming: vi.fn(async (b: Buffer) => b),
}));
vi.mock('../../src/imaging/iconStorage.js', () => ({
  ICON_CONTENT_MAX: 0.82,
  uploadIcon: vi.fn(async () => 'https://example.test/icon.webp'),
}));

const { onRecipeWritten } = await import('../../src/triggers/onRecipeWritten.js');
const { onCanonItemWritten } = await import('../../src/triggers/onCanonItemWritten.js');
const { maybeGenerateIcon } = await import('../../src/triggers/iconWriteTrigger.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOW = '2026-09-05T00:00:00.000Z';

/** The real builder (UT-C2), so the fixture cannot drift from the entity. */
function baconRecipe(overrides: Partial<RecipeDoc> = {}): RecipeDoc {
  return {
    ...emptyRecipe('r1', NOW),
    title: 'Home-Cured Streaky Bacon',
    description: 'Twelve days in the cure.',
    steps: [newStep('s1', 'Rub the cure into the belly.')],
    // A hero already on the document is what keeps the image branch out of the
    // way; the cases that are ABOUT it pass `image: null`.
    image: { url: 'https://example.test/bacon.png', source: 'ai' },
    updatedAt: NOW,
    ...overrides,
  } as unknown as RecipeDoc;
}

function snap(data: Record<string, unknown> | null): DocumentSnapshot {
  return {
    exists: data !== null,
    data: () => data ?? undefined,
  } as unknown as DocumentSnapshot;
}

/** A create — `before` absent, which is what the kit and image guards infer on. */
function runRecipe(after: RecipeDoc, before?: Record<string, unknown>): Promise<void> {
  return (onRecipeWritten as unknown as (event: unknown) => Promise<void>)({
    params: { id: after.id },
    data: {
      after: snap(after as unknown as Record<string, unknown>),
      ...(before ? { before: snap(before) } : {}),
    },
  });
}

function runCanon(after: Record<string, unknown>): Promise<void> {
  return (onCanonItemWritten as unknown as (event: unknown) => Promise<void>)({
    params: { id: 'c-lime' },
    data: { after: snap(after) },
  });
}

function canonItem(): Record<string, unknown> {
  return {
    id: 'c-lime',
    schemaVersion: 5,
    name: 'Lime juice',
    synonyms: [],
    aisleId: null,
    // Non-null so the icon branch skips: the embedding branch is the subject here.
    thumbnail: 'https://example.test/lime.webp',
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
}

const iconDescriptor = {
  name: 'onKitchenToolWritten',
  collection: 'kitchenTools',
  storagePrefix: 'kitchen-tool-icons',
  enrichment: 'kitchenToolIcon' as const,
  schema: { safeParse: (v: unknown) => ({ success: true as const, data: v as IconDoc }) },
  subjectOf: (t: IconDoc) => t.label,
  draw: async () => ({ imageBase64: 'QUJD' }),
};
interface IconDoc {
  readonly thumbnail: string | null;
  readonly label: string;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedIds.length = 0;
  clearedIds.length = 0;
  failureSet.mockImplementation(async (id) => {
    recordedIds.push(id);
    return undefined;
  });
});

// ─── Property 1: record on failure ───────────────────────────────────────────

describe('a failed enrichment leaves a row', () => {
  it('records when kit inference gives up', async () => {
    mockKit.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    await runRecipe(baconRecipe());

    expect(recordedIds).toContain('recipeKit_r1');
    const [, written] = failureSet.mock.calls.find(([id]) => id === 'recipeKit_r1') ?? [];
    expect(written).toMatchObject({
      enrichment: 'recipeKit',
      subjectId: 'r1',
      subjectLabel: 'Home-Cured Streaky Bacon',
      reason: 'upstream',
    });
  });

  it('records when the hero image gives up', async () => {
    mockImage.mockRejectedValueOnce(new Error('boom'));
    await runRecipe(baconRecipe({ image: null } as Partial<RecipeDoc>));
    expect(recordedIds).toContain('recipeImage_r1');
  });

  it('records when the time estimate gives up', async () => {
    mockTimes.mockRejectedValueOnce(new Error('boom'));
    await runRecipe(
      baconRecipe({ kitInferredAt: 1, timesRequestedAt: 2 } as unknown as Partial<RecipeDoc>),
      { timesRequestedAt: 1, kitInferredAt: 1 },
    );
    expect(recordedIds).toContain('recipeTimes_r1');
  });

  it('records when a canon embedding gives up', async () => {
    mockEmbed.mockRejectedValueOnce(new Error('boom'));
    await runCanon(canonItem());
    expect(recordedIds).toContain('canonEmbedding_c-lime');
  });

  it('records when an icon drawing gives up, under its own family kind', async () => {
    await maybeGenerateIcon(
      { ...iconDescriptor, draw: async () => Promise.reject(new Error('boom')) },
      'whisk',
      { thumbnail: null, label: 'Balloon whisk' },
      undefined,
    );
    expect(recordedIds).toEqual(['kitchenToolIcon_whisk']);
    const [, written] = failureSet.mock.calls[0] ?? [];
    expect(written).toMatchObject({ enrichment: 'kitchenToolIcon', subjectLabel: 'Balloon whisk' });
  });
});

// ─── Property 2: clear on success ────────────────────────────────────────────

describe('the next success clears the row', () => {
  it('clears the kit row when inference answers — including with an empty list', async () => {
    mockKit.mockResolvedValueOnce({ kit: [] });
    await runRecipe(baconRecipe());
    // "We asked, and this dish needs nothing listed" is an ANSWER. Only "we
    // asked and could not tell you" is a failure.
    expect(clearedIds).toContain('recipeKit_r1');
    expect(recordedIds).toEqual([]);
  });

  it('clears the image row when the hero lands', async () => {
    await runRecipe(baconRecipe({ image: null } as Partial<RecipeDoc>));
    expect(clearedIds).toContain('recipeImage_r1');
  });

  it('clears the embedding row when the vector lands', async () => {
    await runCanon(canonItem());
    expect(clearedIds).toContain('canonEmbedding_c-lime');
  });

  it('clears the icon row when the picture lands', async () => {
    await maybeGenerateIcon(
      iconDescriptor,
      'whisk',
      { thumbnail: null, label: 'Balloon whisk' },
      undefined,
    );
    expect(clearedIds).toEqual(['kitchenToolIcon_whisk']);
  });
});

// ─── Property 3: recording never costs the enrichment (Rule 10) ──────────────

describe('recording is best-effort and cannot take anything down', () => {
  // WHERE THIS IS ACTUALLY PINNED, stated precisely rather than as an absolute.
  // The inner catch inside `recordEnrichmentFailure` is what makes "never
  // rejects" true, and it is pinned directly — verified red — in
  // `tests/adapters/enrichmentFailureStore.test.ts`. The two cases below are the
  // trigger-level reading of the same property: a branch whose record could not
  // be written still leaves its sibling's answer on the document.
  //
  // BOUNDARY: this file's two cases would stay GREEN if that inner catch were
  // removed, because `onRecipeWritten`'s own `Promise.allSettled` absorbs an
  // escaping rejection. The place where a missing inner catch genuinely costs
  // something is `onEquipmentManifestWritten`'s brief loop, which is sequential
  // and has no allSettled — one throw there loses every later item's brief. That
  // is pinned where it lives, in `onEquipmentManifestWritten.test.ts`.
  it('a failed RECORD does not fail the trigger, or the sibling branch that worked', async () => {
    mockImage.mockRejectedValueOnce(new Error('boom'));
    failureSet.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));

    await expect(
      runRecipe(baconRecipe({ image: null } as Partial<RecipeDoc>)),
    ).resolves.toBeUndefined();

    // The kit branch ran to completion and wrote its answer regardless.
    expect(recipeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ kit: [{ label: 'potato masher', stepIds: ['s1'] }] }),
    );
  });

  it('a failed CLEAR does not fail the enrichment that just succeeded', async () => {
    failureDelete.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    await expect(runRecipe(baconRecipe())).resolves.toBeUndefined();
    expect(recipeUpdate).toHaveBeenCalledWith(expect.objectContaining({ kit: expect.anything() }));
  });
});
