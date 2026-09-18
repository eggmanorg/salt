import { describe, it, expect, vi, beforeEach } from 'vitest';
import { componentDisplayLines } from '@salt/domain';
import type { RecipeDoc } from '@salt/domain/schemas';

// Unit-level (mock-based, no emulator) coverage of the onRecipeWritten hero-image
// branch (issue #148, Tier-2): the edge-trigger guard, the generate→encode→upload
// →write-back happy path, the kill-switch, and the "manual upload / hidden / bare
// edit re-fire" skips. Mirrors onCanonItemWritten's unit tests.

vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_opts: unknown, handler: unknown) => handler,
}));

vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: () => '' }),
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Typed as the real function, not inferred: `vi.fn(async () => …)` infers a
// ZERO-argument mock, so every recorded call is an empty tuple and reading
// `mock.calls[0][n]` — which this suite does throughout — cannot compile, while
// `mockResolvedValue` is pinned to the one literal used here (#1135).
const mockGenerateImage = vi.fn<
  (input: Record<string, unknown>) => Promise<{ imageBase64: string; contentType: string }>
>(async () => ({ imageBase64: 'QUJD', contentType: 'image/png' }));
vi.mock('../../src/flows/generateRecipeImage.js', () => ({
  generateRecipeImageFlow: mockGenerateImage,
}));

const mockDescribeScene = vi.fn<
  (input: { components?: readonly string[] }) => Promise<{ brief: string }>
>(async () => ({ brief: 'A blistered, golden-topped bake.' }));
vi.mock('../../src/flows/describeRecipeScene.js', () => ({
  describeRecipeSceneFlow: mockDescribeScene,
}));

const mockEncode = vi.fn(async () => Buffer.from([1, 2, 3]));
vi.mock('../../src/imaging/encodeHeroImage.js', () => ({ encodeHeroImage: mockEncode }));

// The meal's attached dishes (issue #838). Mocked at the READ, exactly as the two
// flows above are: the Firestore fan-out has its own suite
// (tests/flows/componentContext.test.ts), and what this file is about is what the
// trigger does with what comes back — which is hand it to the REAL
// `componentDisplayLines`, so the lines asserted here are the lines the browser
// renders for the same meal.
const mockReadComponentContext = vi.fn(async (): Promise<RecipeDoc[]> => []);
vi.mock('../../src/flows/componentContext.js', () => ({
  readComponentContext: mockReadComponentContext,
}));

// Firestore admin: capture the write-back and answer the devSettings read.
// The partial the trigger patches onto the recipe doc — only the fields these
// assertions read. A whole `RecipeDoc` would be wrong: this is an update, not a
// write, and the trigger deliberately sends nothing else.
type RecipePatch = {
  image?: { source?: string; url?: string };
  imageHint?: unknown;
  imageBrief?: unknown;
  kit?: unknown;
  kitInferredAt?: unknown;
};
const mockUpdate = vi.fn<(patch: RecipePatch) => Promise<undefined>>().mockResolvedValue(undefined);
const mockGet = vi.fn().mockResolvedValue({ exists: false }); // devSettings missing → enabled
const DELETE_SENTINEL = Symbol('FieldValue.delete');
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => DELETE_SENTINEL },
  getFirestore: () => ({
    collection: () => ({ doc: () => ({ update: mockUpdate, get: mockGet }) }),
  }),
}));

const mockSave = vi.fn(async () => undefined);
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({ name: 'demo-salt.appspot.com', file: () => ({ save: mockSave }) }),
  }),
}));

const mockFlush = vi.fn().mockResolvedValue(undefined);
vi.mock('@salt/observability/server', async (importOriginal) => ({
  // Spread the real module so an export the ENTRYPOINT WRAPPER needs
  // (runWithSuppliedTraceContext) cannot go missing from this mock the way it
  // did when the wrapper landed — a one-export factory is exactly what goes
  // stale. Only the calls this suite asserts on are overridden below.
  ...((await importOriginal()) as Record<string, unknown>),
  flushServerObservability: mockFlush,
  // reportServerError.js constructs this at module load — it must exist on the mock.
  createServerObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
}));

const { onRecipeWritten } = await import('../../src/triggers/onRecipeWritten.js');

function makeRecipe(id: string, overrides: Partial<RecipeDoc> = {}): RecipeDoc {
  return {
    cureCategory: null,
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Roast chicken',
    description: 'A whole roast chicken with lemon and thyme.',
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    image: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeEvent(id: string, after: RecipeDoc | null, before?: RecipeDoc | null) {
  return {
    params: { id },
    data: {
      before: before
        ? { exists: true, data: () => before }
        : { exists: false, data: () => undefined },
      after: after ? { exists: true, data: () => after } : { exists: false, data: () => undefined },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish clean default implementations each test (clearAllMocks resets
  // call history but not implementations, so a persistent override from one test
  // would otherwise leak into the next).
  mockGenerateImage.mockResolvedValue({ imageBase64: 'QUJD', contentType: 'image/png' });
  mockDescribeScene.mockResolvedValue({ brief: 'A blistered, golden-topped bake.' });
  mockEncode.mockResolvedValue(Buffer.from([1, 2, 3]));
  mockGet.mockResolvedValue({ exists: false });
  mockReadComponentContext.mockResolvedValue([]);
});

describe('onRecipeWritten — hero-image branch', () => {
  it('generates on create, encodes, uploads, and writes back an ai image + clears the hint', async () => {
    await (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1')));

    expect(mockGenerateImage).toHaveBeenCalledOnce();
    // Title + description + the recipe's tags + the freshly-authored scene brief
    // are fed to the flow; no hint present.
    expect(mockGenerateImage).toHaveBeenCalledWith({
      title: 'Roast chicken',
      description: 'A whole roast chicken with lemon and thyme.',
      kind: 'recipe',
      tags: [],
      sceneBrief: 'A blistered, golden-topped bake.',
    });
    expect(mockEncode).toHaveBeenCalledOnce();
    expect(mockSave).toHaveBeenCalledOnce();

    const writeArg = mockUpdate.mock.calls[0]![0];
    expect(writeArg.image!.source).toBe('ai');
    expect(writeArg.image!.url).toContain('recipe-images%2Fr1.webp');
    expect(writeArg.imageHint).toBe(DELETE_SENTINEL);
    // The brief is persisted in the SAME write as the image it produced.
    expect(writeArg.imageBrief).toBe('A blistered, golden-topped bake.');
    expect(mockFlush).toHaveBeenCalled();
  });

  it('forwards a one-shot hint to the flow', async () => {
    await (onRecipeWritten as Function)(
      makeEvent('r1', makeRecipe('r1', { imageHint: 'on a rustic board' })),
    );
    expect(mockGenerateImage).toHaveBeenCalledWith({
      title: 'Roast chicken',
      description: 'A whole roast chicken with lemon and thyme.',
      kind: 'recipe',
      hint: 'on a rustic board',
      tags: [],
      sceneBrief: 'A blistered, golden-topped bake.',
    });
  });

  it("forwards the recipe's tags to the flow as a dish-type signal", async () => {
    await (onRecipeWritten as Function)(
      makeEvent(
        'r1',
        makeRecipe('r1', {
          metadata: {
            servings: null,
            tags: ['comfort-food', 'slow-cooker'],
          },
        }),
      ),
    );
    expect(mockGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['comfort-food', 'slow-cooker'] }),
    );
  });

  it('skips when an image already exists (never clobbers a manual upload)', async () => {
    const recipe = makeRecipe('r1', {
      image: { url: 'https://x/upload.webp', source: 'upload' },
    });
    await (onRecipeWritten as Function)(makeEvent('r1', recipe));
    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('generates regardless of the retired imageHidden field (now inert)', async () => {
    // imageHidden was retired (Phase 1): the trigger no longer honors it, so a
    // create with a null image still generates even when the field is set.
    await (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1', { imageHidden: true })));
    expect(mockGenerateImage).toHaveBeenCalledOnce();
  });

  it('skips a bare edit re-fire while a generation is in flight (image null both sides, no nonce bump)', async () => {
    const before = makeRecipe('r1', { image: null });
    const after = makeRecipe('r1', { image: null, title: 'Roast chicken (edited)' });
    await (onRecipeWritten as Function)(makeEvent('r1', after, before));
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it('regenerates when the image was just cleared (non-null → null)', async () => {
    const before = makeRecipe('r1', { image: { url: 'https://x/old.webp', source: 'ai' } });
    const after = makeRecipe('r1', { image: null });
    await (onRecipeWritten as Function)(makeEvent('r1', after, before));
    expect(mockGenerateImage).toHaveBeenCalledOnce();
  });

  it('regenerates on a nonce bump even when the image was already null', async () => {
    const before = makeRecipe('r1', { image: null, imageRequestedAt: 1 });
    const after = makeRecipe('r1', { image: null, imageRequestedAt: 2 });
    await (onRecipeWritten as Function)(makeEvent('r1', after, before));
    expect(mockGenerateImage).toHaveBeenCalledOnce();
  });

  it('honours the recipe-image kill-switch', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        canonIconGenerationEnabled: true,
        recipeImageGenerationEnabled: false,
        schemaVersion: 1,
      }),
    });
    await (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1')));
    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not write back and still flushes when generation fails', async () => {
    // Reject every attempt (withAiTimeout retries), so the branch catch runs.
    mockGenerateImage.mockRejectedValue(new Error('model exploded'));
    await expect(
      (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1'))),
    ).resolves.toBeUndefined();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalled();
  });

  it('skips a blank-title draft', async () => {
    await (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1', { title: '   ' })));
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });
});

describe('onRecipeWritten — scene brief', () => {
  it('authors a brief from the WHOLE recipe — ingredients and steps, not just the title', async () => {
    await (onRecipeWritten as Function)(
      makeEvent(
        'r1',
        makeRecipe('r1', {
          ingredients: [
            {
              id: 'g1',
              name: null,
              items: [
                {
                  id: 'i1',
                  rawText: 'a handful of basil',
                  parsed: null,
                  canonId: null,
                  matchState: 'pending',
                  isOptional: false,
                  firstUsedInStepId: null,
                },
              ],
            },
          ],
          steps: [
            {
              id: 's1',
              text: 'Grill until the top is blistered and golden.',
              timer: null,
              note: null,
            },
          ],
        }),
      ),
    );

    // The ingredient groups are flattened to their display lines and the steps to
    // their text — this is the only path by which a garnish or a finishing cue that
    // appears nowhere in the title/description reaches the hero.
    expect(mockDescribeScene).toHaveBeenCalledWith({
      title: 'Roast chicken',
      description: 'A whole roast chicken with lemon and thyme.',
      kind: 'recipe',
      tags: [],
      ingredients: ['a handful of basil'],
      steps: ['Grill until the top is blistered and golden.'],
      // Issue #838. Still an EXACT-shape assertion: a recipe that is not a meal
      // sends an empty array, which is what makes the flow omit the dishes block
      // and the meal clause entirely.
      components: [],
    });
  });

  it('sends the tags to the art director, not only to the image model', async () => {
    // They used to reach generateRecipeImage and stop there. For a placeholder
    // that was a hole rather than a missed cue: no ingredients, no method, and a
    // mood that lives in `tags` — so the brief prompt's "read the MOOD, which the
    // tags carry" was reading a field the trigger never sent, leaving the title
    // and description as its only input.
    await (onRecipeWritten as Function)(
      makeEvent(
        'r1',
        makeRecipe('r1', {
          kind: 'placeholder',
          metadata: {
            servings: null,
            tags: ['comfort', 'wet'],
          },
        }),
      ),
    );

    expect(mockDescribeScene).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'placeholder', tags: ['comfort', 'wet'] }),
    );
    // And still to the image model, which is where they already worked.
    expect(mockGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['comfort', 'wet'] }),
    );
  });

  it('uses a brief already on the doc verbatim, without authoring a new one', async () => {
    await (onRecipeWritten as Function)(
      makeEvent('r1', makeRecipe('r1', { imageBrief: 'A human wrote this brief.' })),
    );

    // Present on the doc → used as-is. The trigger neither knows nor cares whether a
    // human or the model wrote it.
    expect(mockDescribeScene).not.toHaveBeenCalled();
    expect(mockGenerateImage).toHaveBeenCalledWith(
      expect.objectContaining({ sceneBrief: 'A human wrote this brief.' }),
    );
    expect(mockUpdate.mock.calls[0]![0].imageBrief).toBe('A human wrote this brief.');
  });

  it('authors one when the doc brief is blank', async () => {
    await (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1', { imageBrief: '   ' })));
    expect(mockDescribeScene).toHaveBeenCalledOnce();
  });

  it('still generates the image when the brief step fails (degrades, never throws)', async () => {
    mockDescribeScene.mockRejectedValue(new Error('brief model exploded'));

    await expect(
      (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1'))),
    ).resolves.toBeUndefined();

    // Rule 10: a brief is an improvement to the prompt, never a precondition. The
    // hero is generated anyway, with NO sceneBrief — so the flow uses its
    // dish-reading fallback, i.e. exactly the pre-brief behaviour.
    expect(mockGenerateImage).toHaveBeenCalledOnce();
    expect(mockGenerateImage.mock.calls[0]![0]).not.toHaveProperty('sceneBrief');
    const writeArg = mockUpdate.mock.calls[0]![0];
    expect(writeArg.image!.source).toBe('ai');
    expect(writeArg).not.toHaveProperty('imageBrief');
  });

  it('falls back when the brief flow returns an empty brief', async () => {
    mockDescribeScene.mockResolvedValue({ brief: '   ' });
    await (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1')));
    expect(mockGenerateImage).toHaveBeenCalledOnce();
    expect(mockGenerateImage.mock.calls[0]![0]).not.toHaveProperty('sceneBrief');
  });

  it('never pays for a brief when a guard skips generation', async () => {
    // The brief call sits AFTER every cheap guard, so a disabled environment, an
    // existing image, or a blank draft costs nothing.
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({
        canonIconGenerationEnabled: true,
        recipeImageGenerationEnabled: false,
        schemaVersion: 1,
      }),
    });
    await (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1')));
    expect(mockDescribeScene).not.toHaveBeenCalled();

    mockGet.mockResolvedValue({ exists: false });
    await (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1', { title: '  ' })));
    expect(mockDescribeScene).not.toHaveBeenCalled();

    await (onRecipeWritten as Function)(
      makeEvent('r1', makeRecipe('r1', { image: { url: 'https://x/u.webp', source: 'upload' } })),
    );
    expect(mockDescribeScene).not.toHaveBeenCalled();
  });
});

// ─── Entry kinds (issue #637) ────────────────────────────────────────────────
// The trigger runs the SAME two-step pipeline for every kind — a special gets a
// brief and a hero exactly as a recipe does, because the regenerate dialog seeds
// its textarea from `imageBrief` and skipping the brief step would leave it empty.
// The only thing that changes is which prompts the flows pick, so the trigger's
// whole job here is to forward the kind.
describe('onRecipeWritten — entry kinds', () => {
  it('forwards the kind to BOTH flows so a special is painted as a special', async () => {
    await (onRecipeWritten as Function)(
      makeEvent(
        'r-out',
        makeRecipe('r-out', {
          kind: 'special',
          title: 'Friday night curry',
          description: 'From the place on the corner.',
        }),
      ),
    );

    expect(mockDescribeScene).toHaveBeenCalledWith(expect.objectContaining({ kind: 'special' }));
    expect(mockGenerateImage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'special' }));
  });

  it('still generates a hero for a special — no ingredients, no method, same pipeline', async () => {
    await (onRecipeWritten as Function)(
      makeEvent('r-out', makeRecipe('r-out', { kind: 'special', ingredients: [], steps: [] })),
    );

    expect(mockGenerateImage).toHaveBeenCalledOnce();
    const writeArg = mockUpdate.mock.calls[0]![0];
    expect(writeArg.image!.source).toBe('ai');
    // The brief is persisted, which is what the regenerate dialog's textarea reads.
    expect(writeArg.imageBrief).toBe('A blistered, golden-topped bake.');
  });

  it('defaults a pre-#637 doc with no kind to "recipe"', async () => {
    // RecipeSchema defaults the field on read, so a recipe written before kinds
    // existed reaches both flows as a plain recipe and its prompt is unchanged.
    const legacy = makeRecipe('r-old') as Record<string, unknown>;
    delete legacy['kind'];

    await (onRecipeWritten as Function)(makeEvent('r-old', legacy as never));

    expect(mockDescribeScene).toHaveBeenCalledWith(expect.objectContaining({ kind: 'recipe' }));
    expect(mockGenerateImage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'recipe' }));
  });
});

// ─── Meals (issue #838) ──────────────────────────────────────────────────────
// A bundle-only meal — a Sunday roast that is nothing but chicken + potatoes +
// gravy — has no ingredients and no method of its own, so before this the art
// director's ENTIRE input was a title. That is the case where the blindness costs
// most, and it is a hero the user then has to keep regenerating.
//
// The trigger's whole job here is resolve → render → forward, and the rendering is
// deliberately not its own: it hands the resolved dishes to `componentDisplayLines`
// in `@salt/domain`, the same helper the browser's brief dialog uses, so a brief
// authored on write and a brief authored from the dialog cannot describe different
// dinners.
describe('onRecipeWritten — meal components', () => {
  const CHICKEN = makeRecipe('chicken', {
    title: 'Roast chicken',
    description: 'Lemon and thyme, skin crisp and burnished.',
  });
  const POTATOES = makeRecipe('potatoes', { title: 'Roast potatoes', description: null });

  it('sends the art director the dishes the meal is built from', async () => {
    mockReadComponentContext.mockResolvedValue([CHICKEN, POTATOES]);

    await (onRecipeWritten as Function)(
      makeEvent(
        'roast',
        makeRecipe('roast', {
          title: 'Sunday roast',
          description: null,
          componentRecipeIds: ['chicken', 'potatoes'],
        }),
      ),
    );

    // Title and description only, in stored order, and the dish with no
    // description is its title alone — `componentDisplayLines`' contract, not a
    // string this trigger builds. A hand-written literal here could drift from the
    // browser's; this cannot.
    expect(mockDescribeScene).toHaveBeenCalledWith(
      expect.objectContaining({
        components: componentDisplayLines([CHICKEN, POTATOES]),
      }),
    );
    expect(mockDescribeScene.mock.calls[0]![0]!.components).toEqual([
      'Roast chicken — Lemon and thyme, skin crisp and burnished.',
      'Roast potatoes',
    ]);
  });

  it('resolves the dishes against the recipe that was actually written', async () => {
    // The read is keyed off the after-doc, not the trigger params: a meal whose
    // dishes were just re-arranged must be described by the NEW list.
    const roast = makeRecipe('roast', { componentRecipeIds: ['chicken'] });
    await (onRecipeWritten as Function)(makeEvent('roast', roast));

    expect(mockReadComponentContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ componentRecipeIds: ['chicken'] }),
      'onRecipeWritten',
    );
  });

  it('passes an empty array for a recipe that is not a meal', async () => {
    // What keeps nearly every recipe on exactly the prompt it had before: the flow
    // omits both the dishes block and the meal clause on an empty array.
    await (onRecipeWritten as Function)(makeEvent('r1', makeRecipe('r1')));

    expect(mockDescribeScene).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });

  it('still authors a brief when the component read comes back empty', async () => {
    // `readComponentContext` degrades to [] on any failure (Rule 10) — a Firestore
    // hiccup must cost the dinner its dish list, never its hero.
    mockReadComponentContext.mockResolvedValue([]);

    await (onRecipeWritten as Function)(
      makeEvent('roast', makeRecipe('roast', { componentRecipeIds: ['chicken'] })),
    );

    expect(mockDescribeScene).toHaveBeenCalledOnce();
    expect(mockDescribeScene.mock.calls[0]![0]!.components).toEqual([]);
    expect(mockGenerateImage).toHaveBeenCalledOnce();
  });

  it('never pays for the component read when a guard skips the brief', async () => {
    // The read sits inside the brief step, which sits after every cheap guard — so
    // a doc that already carries a brief costs no Firestore read either.
    await (onRecipeWritten as Function)(
      makeEvent(
        'roast',
        makeRecipe('roast', {
          componentRecipeIds: ['chicken'],
          imageBrief: 'A human wrote this brief.',
        }),
      ),
    );

    expect(mockDescribeScene).not.toHaveBeenCalled();
    expect(mockReadComponentContext).not.toHaveBeenCalled();
  });
});
