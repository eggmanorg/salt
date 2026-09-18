import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngredientDoc, IngredientGroupDoc } from '@salt/domain/schemas';

// ─── The function records the match itself (issue #1434) ─────────────────────
//
// The canonicalise button was a two-minute `await` in the browser with the recipe
// write as the statement AFTER it, so a locked phone or a closed tab lost the
// `canonId`/`matchState` half of the run while the canon documents the same run
// created survived. These tests drive the flow with NO CLIENT INVOLVED AT ALL and
// assert the recipe document itself carries the matches afterwards.
//
// Four properties, and two of them are claims the code would otherwise only
// assert in prose (CLAUDE.md rule 12):
//  1. with a `recipeId`, `recipes/{id}` carries the fold;
//  2. WITHOUT one — the `assembleRecipeDraft` shape, a recipe that does not exist
//     in Firestore yet — no recipe document is written, while the canon documents
//     still are;
//  3. a recipe-write failure is logged, reported and the results still returned;
//  4. an `ingredientId` no longer in the document is skipped, never re-created.
//
// The flow + the real domain matchOrCreateBatch + the real createFirestoreCanonStore
// run against an in-memory Firestore, as the sibling suites do. The `.persist`
// suffix follows the per-concern naming of `…trace` / `…proposal` / `…reporting`.

// ─── In-memory Firestore mock, with transactions ─────────────────────────────

const collections = new Map<string, Map<string, Record<string, unknown>>>();
// Set to a value for `runTransaction` to throw, so a test can drive the
// write-failure branch rather than merely an absent document. Deliberately
// `unknown`: what a Firestore call rejects with is not guaranteed to be an Error.
let transactionFailure: unknown = null;

function getCollection(name: string) {
  let c = collections.get(name);
  if (!c) {
    c = new Map();
    collections.set(name, c);
  }
  return c;
}

function snapshotOf(name: string, id: string) {
  const data = getCollection(name).get(id);
  return {
    exists: data !== undefined,
    data: () => data,
    get: (field: string) => data?.[field],
  };
}

function docsOf(name: string) {
  return [...getCollection(name).entries()].map(([id, data]) => ({
    id,
    data: () => data,
    get: (field: string) => data[field],
  }));
}

// A ref carries its own address so the transaction can resolve it, exactly as a
// real `DocumentReference` does.
type Ref = { readonly __name: string; readonly __id: string };

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: (name: string) => {
      const store = getCollection(name);
      return {
        doc: (id: string) => ({
          __name: name,
          __id: id,
          async set(data: Record<string, unknown>) {
            store.set(id, data);
          },
          async get() {
            return snapshotOf(name, id);
          },
          async delete() {
            store.delete(id);
          },
        }),
        // The produced-canon read is a field PROJECTION.
        select: () => ({
          async get() {
            return { docs: docsOf(name) };
          },
        }),
        async get() {
          return { docs: docsOf(name) };
        },
      };
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      if (transactionFailure !== null) throw transactionFailure;
      const tx = {
        async get(ref: Ref) {
          return snapshotOf(ref.__name, ref.__id);
        },
        update(ref: Ref, data: Record<string, unknown>) {
          const store = getCollection(ref.__name);
          const current = store.get(ref.__id);
          if (current === undefined) throw new Error('update on a missing document');
          store.set(ref.__id, { ...current, ...data });
        },
      };
      return fn(tx);
    },
  }),
}));

// Genkit: defineFlow returns the handler directly.
vi.mock('../../src/genkit.js', () => ({
  ai: { defineFlow: (_cfg: unknown, handler: unknown) => handler },
}));

// AI stubbed: this suite is about where the result is RECORDED, not how it is
// decided. `arbitrateProductForm` is deliberately NOT mocked — unstubbed it
// throws on the mocked genkit client and the flow degrades to plain matching
// (Rule 10, the same reliance `…trace.test.ts` makes), which keeps this file
// under UT-B1's five-mock cap without weakening anything it asserts.
vi.mock('../../src/flows/embedText.js', () => ({
  embedTextFlow: vi.fn(async () => ({ values: [0, 0, 0] })),
}));
vi.mock('../../src/flows/arbitrateCanon.js', () => ({ arbitrateCanonFlow: vi.fn() }));

const mockReportServerError = vi.fn();
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportServerError: (...args: unknown[]) => mockReportServerError(...(args as [])),
  reportFlowError: vi.fn(async () => undefined),
}));

const { logger } = await import('firebase-functions');
const { canonicaliseRecipeIngredientsFlow } =
  await import('../../src/flows/canonicaliseRecipeIngredients.js');

// Spied rather than mocked, for the same cap: the flow reads `logger.error` off
// the imported binding at call time.
const mockLoggerError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

const runFlow = canonicaliseRecipeIngredientsFlow as unknown as (
  input: unknown,
) => Promise<{ kind: string; value?: { item: { id: string } } }[]>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SEEDED_AT = '2026-01-01T00:00:00.000Z';

function ingredient(id: string, rawText: string): IngredientDoc {
  return {
    id,
    rawText,
    parsed: {
      quantity: { type: 'single', value: 100 },
      unit: 'g',
      item: rawText,
      preparation: [],
      notes: null,
      displayText: null,
    },
    canonId: null,
    matchState: 'pending',
    isOptional: false,
    firstUsedInStepId: null,
  };
}

function seedRecipe(id: string, items: IngredientDoc[]): void {
  const group: IngredientGroupDoc = { id: 'g1', name: null, items };
  getCollection('recipes').set(id, {
    id,
    title: 'Test Recipe',
    ingredients: [group],
    updatedAt: SEEDED_AT,
  });
}

function storedRecipe(id: string): {
  ingredients: IngredientGroupDoc[];
  updatedAt: string;
} {
  return getCollection('recipes').get(id) as unknown as {
    ingredients: IngredientGroupDoc[];
    updatedAt: string;
  };
}

function rows(id: string): IngredientDoc[] {
  return storedRecipe(id).ingredients.flatMap((g) => g.items);
}

beforeEach(() => {
  collections.clear();
  transactionFailure = null;
  mockLoggerError.mockClear();
  mockReportServerError.mockClear();
});

describe('canonicaliseRecipeIngredients — the function writes the match back', () => {
  it('records canonId + matchState on recipes/{id} with no client involved', async () => {
    seedRecipe('recipe-1', [ingredient('i1', 'tinned tomatoes'), ingredient('i2', 'chickpeas')]);

    const results = await runFlow({
      recipeId: 'recipe-1',
      items: [
        { ingredientId: 'i1', rawName: 'tinned tomatoes' },
        { ingredientId: 'i2', rawName: 'chickpeas' },
      ],
    });

    expect(results).toHaveLength(2);
    for (const r of results) expect(r.kind).toBe('ok');

    // The document itself — this is the whole defect. Nothing in this test ran in
    // a browser, and the rows carry their matches.
    const [first, second] = rows('recipe-1');
    expect(first!.matchState).toBe('matched');
    expect(second!.matchState).toBe('matched');
    expect(first!.canonId).toBe(results[0]!.value!.item.id);
    expect(second!.canonId).toBe(results[1]!.value!.item.id);
    // Both names are new, so both canon items are minted by this run — and a
    // freshly minted canon item carries `needs_approval: true`. The row is matched
    // to it ANYWAY: pending canon is used live and the flag is review-only, never
    // a gate (the property `recipeService.canonicalise.test.ts` used to pin on the
    // client's fold, now pinned where the fold lives).
    const canon = [...getCollection('canonItems').values()];
    expect(canon).toHaveLength(2);
    for (const item of canon) expect(item.needs_approval).toBe(true);

    // Newer than what was seeded: the client's `applySnapshot` echo guard drops an
    // incoming document that is not.
    expect(storedRecipe('recipe-1').updatedAt > SEEDED_AT).toBe(true);
    // Untouched fields survive — this is an `update`, not a `set` of a document
    // the caller supplied.
    expect(storedRecipe('recipe-1')).toMatchObject({ title: 'Test Recipe' });
  });

  it('folds an errored per-item slot to failed + null canonId', async () => {
    // A blank name is rejected by the matcher as INVALID_CANON_NAME, which is the
    // per-item `err` slot the client used to fold into `failed`.
    seedRecipe('recipe-2', [ingredient('i1', 'lentils'), ingredient('i2', '   ')]);

    const results = await runFlow({
      recipeId: 'recipe-2',
      items: [
        { ingredientId: 'i1', rawName: 'lentils' },
        { ingredientId: 'i2', rawName: '   ' },
      ],
    });

    expect(results[1]!.kind).toBe('err');
    const [ok, bad] = rows('recipe-2');
    expect(ok!.matchState).toBe('matched');
    expect(bad!.matchState).toBe('failed');
    expect(bad!.canonId).toBeNull();
  });

  it('writes NO recipe document when the input carries no recipeId', async () => {
    // The `assembleRecipeDraft` shape: the flow runs in-process while a recipe is
    // being assembled and does not exist in Firestore yet. The rule-12 pin for the
    // conditional branch — the guarantee is that nothing is written, so a recipe
    // document that happens to share the draft's id is proof enough.
    seedRecipe('recipe-3', [ingredient('i1', 'tinned tomatoes')]);

    const results = await runFlow({
      items: [{ ingredientId: 'i1', rawName: 'tinned tomatoes' }],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe('ok');
    // Untouched, to the timestamp.
    expect(storedRecipe('recipe-3').updatedAt).toBe(SEEDED_AT);
    expect(rows('recipe-3')[0]!.matchState).toBe('pending');
    expect(rows('recipe-3')[0]!.canonId).toBeNull();
    // …while the expensive half still happened: the canon item was created.
    expect([...getCollection('canonItems').values()]).toHaveLength(1);
  });

  it('writes no recipe document when no item names a row', async () => {
    // The other half of the same branch: a `recipeId` with items that carry no
    // `ingredientId` has nothing to fold onto, and must not bump the document.
    seedRecipe('recipe-4', [ingredient('i1', 'tinned tomatoes')]);

    await runFlow({ recipeId: 'recipe-4', items: [{ rawName: 'tinned tomatoes' }] });

    expect(storedRecipe('recipe-4').updatedAt).toBe(SEEDED_AT);
    expect(rows('recipe-4')[0]!.matchState).toBe('pending');
  });

  it('skips an ingredientId that is no longer in the document, and never re-creates it', async () => {
    // The row was deleted while the call was in flight, and a THIRD row was added
    // that this batch knows nothing about. The recipe as it stands is the truth:
    // the row the batch matched is annotated, the gone row stays gone, the row
    // nobody asked about is untouched.
    seedRecipe('recipe-5', [ingredient('i1', 'tinned tomatoes'), ingredient('i9', 'parsley')]);

    await runFlow({
      recipeId: 'recipe-5',
      items: [
        { ingredientId: 'i1', rawName: 'tinned tomatoes' },
        { ingredientId: 'deleted-row', rawName: 'chickpeas' },
      ],
    });

    const current = rows('recipe-5');
    expect(current.map((r) => r.id)).toEqual(['i1', 'i9']);
    expect(current[0]!.matchState).toBe('matched');
    expect(current[1]!.matchState).toBe('pending');
    expect(current[1]!.canonId).toBeNull();
  });

  it('writes nothing when every id the batch carried has gone from the document', async () => {
    // Every row the batch was for was deleted mid-call. Nothing is folded, so
    // nothing is written — `updatedAt` is not bumped and `onRecipeWritten` is not
    // re-fired for a document that would be byte-identical.
    seedRecipe('recipe-8', [ingredient('i9', 'parsley')]);

    await runFlow({
      recipeId: 'recipe-8',
      items: [{ ingredientId: 'deleted-row', rawName: 'chickpeas' }],
    });

    expect(storedRecipe('recipe-8').updatedAt).toBe(SEEDED_AT);
    expect(rows('recipe-8')[0]!.matchState).toBe('pending');
  });

  it('writes nothing when the recipe document has gone entirely', async () => {
    // Nothing seeded for this id.
    const results = await runFlow({
      recipeId: 'recipe-missing',
      items: [{ ingredientId: 'i1', rawName: 'tinned tomatoes' }],
    });

    expect(results[0]!.kind).toBe('ok');
    expect(getCollection('recipes').has('recipe-missing')).toBe(false);
  });

  it('logs and reports a write failure, and still returns the results', async () => {
    // An already-paid-for AI run is never discarded over a Firestore hiccup
    // (`persistAuthoredRecipe`'s shape); the failure crosses as a log, never a
    // throw (Rule 10).
    seedRecipe('recipe-6', [ingredient('i1', 'tinned tomatoes')]);
    transactionFailure = new Error('simulated recipes write failure');

    const results = await runFlow({
      recipeId: 'recipe-6',
      items: [{ ingredientId: 'i1', rawName: 'tinned tomatoes' }],
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe('ok');

    const errors = mockLoggerError.mock.calls.filter((c) =>
      String(c[0]).includes('failed to persist canon matches'),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toMatchObject({
      recipeId: 'recipe-6',
      error: 'simulated recipes write failure',
    });
    expect(mockReportServerError).toHaveBeenCalledWith(expect.any(Error), 'StorageError');

    // The canon half is still durable — the run's expensive output survived the
    // failed recipe write.
    expect([...getCollection('canonItems').values()]).toHaveLength(1);
  });

  it('logs a non-Error rejection by its string value', async () => {
    // A rejected Firestore call is not guaranteed to carry an Error, and the log
    // line has to survive that rather than print `[object Object]`.
    seedRecipe('recipe-9', [ingredient('i1', 'tinned tomatoes')]);
    transactionFailure = 'a bare string, not an Error';

    await runFlow({
      recipeId: 'recipe-9',
      items: [{ ingredientId: 'i1', rawName: 'tinned tomatoes' }],
    });

    const errors = mockLoggerError.mock.calls.filter((c) =>
      String(c[0]).includes('failed to persist canon matches'),
    );
    expect(errors[0]![1]).toMatchObject({ error: 'a bare string, not an Error' });
  });

  it('skips a row edited mid-call instead of stamping a match computed from stale text', async () => {
    // The blocking finding from the #1475 review: a line edited on another
    // device (or in edit mode on this one) DURING the up-to-120s call must not
    // be stamped with a match computed from the text it no longer carries — that
    // would leave a row whose text and match disagree with no marker to prompt a
    // re-tap. The item's `rawText` is the pre-call snapshot; the document is
    // seeded with a DIFFERENT current `rawText` for the same id, simulating the
    // edit landing before this transaction reads the document.
    seedRecipe('recipe-10', [ingredient('i1', '200g cocoa powder')]);

    const results = await runFlow({
      recipeId: 'recipe-10',
      items: [{ ingredientId: 'i1', rawName: 'flor', rawText: '200g plain flor' }],
    });

    // The match still happened and is still returned — only the fold onto the
    // recipe document is skipped.
    expect(results[0]!.kind).toBe('ok');
    const [row] = rows('recipe-10');
    expect(row!.matchState).toBe('pending');
    expect(row!.canonId).toBeNull();
    expect(row!.rawText).toBe('200g cocoa powder');
    // Nothing folded means nothing written — same guarantee as every id that
    // vanished from the document mid-call.
    expect(storedRecipe('recipe-10').updatedAt).toBe(SEEDED_AT);
  });

  it('skips the fold, and writes nothing, when the stored ingredients fail validation', async () => {
    // A Firestore read is a trust boundary. A document whose `ingredients` field
    // is not the shape the schema names is left alone rather than folded against
    // blind — and the results still return.
    getCollection('recipes').set('recipe-7', {
      id: 'recipe-7',
      ingredients: 'not an array of groups',
      updatedAt: SEEDED_AT,
    });

    const results = await runFlow({
      recipeId: 'recipe-7',
      items: [{ ingredientId: 'i1', rawName: 'tinned tomatoes' }],
    });

    expect(results[0]!.kind).toBe('ok');
    expect(getCollection('recipes').get('recipe-7')).toMatchObject({
      ingredients: 'not an array of groups',
      updatedAt: SEEDED_AT,
    });
    expect(
      mockLoggerError.mock.calls.filter((c) => String(c[0]).includes('failed validation')),
    ).toHaveLength(1);
  });
});
