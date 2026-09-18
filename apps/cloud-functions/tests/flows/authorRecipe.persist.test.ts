import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #1431: the librarian flow WRITES the recipe it authored, instead of
// handing the only copy back to the browser to write on the statement after the
// `await` — the statement a locked phone, a backgrounded PWA or a closed tab
// never runs. The flow completed, the librarian and the whole parse/canon
// fan-out were paid for, and the recipe was thrown away with no error.
//
// Two properties carry the fix and they pull in opposite directions, which is why
// both are pinned here:
//
//   * CREATE mode writes. That is the loss this issue closes.
//   * EDIT mode writes NOTHING. An edit-mode call is `recipeAmend.propose` — a
//     PROPOSAL, shown to the user as a diff and written only when they confirm.
//     A write there would commit an unreviewed amendment straight over a live
//     recipe (#764, #791), so this suite fails if the flow touches Firestore on
//     that path at all.
//
// And the third, from #616's shape: a write failure must not fail the call. The
// generation already succeeded and was already paid for.

const mockGenerate = vi.fn();
const mockUUID = vi.fn();
const mockParseFlow = vi.fn();
const mockCanonFlow = vi.fn();
const mockGet = vi.fn(); // recipes/<id>
const mockEquipmentGet = vi.fn(); // equipmentManifest/current, and every other doc
const mockGetAll = vi.fn();
const mockLoggerError = vi.fn();
// Records (collection, docId, document) for every `.set()`, so "wrote
// recipes/{id}" is asserted rather than "wrote something somewhere".
const mockSet = vi.fn();

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: mockGenerate,
  },
}));

vi.mock('@genkit-ai/google-genai', () => ({
  googleAI: { model: (name: string) => name },
}));

// Bypass the real timer, but keep everything else the module exports (the
// shared budget constant, the stream guard) — a factory that lists only
// `withAiTimeout` goes stale the moment the module grows.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));

vi.mock('../../src/flows/parseRecipeIngredients.js', () => ({
  parseRecipeIngredientsFlow: mockParseFlow,
}));

vi.mock('../../src/flows/canonicaliseRecipeIngredients.js', () => ({
  canonicaliseRecipeIngredientsFlow: mockCanonFlow,
}));

// Collection-aware, like the main authorRecipe suite: `recipes/<id>` is the base
// recipe read, everything else (the equipment manifest, the model catalogue) gets
// the other stub, and a single shared `get` would silently cross the two.
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        id,
        get: name === 'recipes' ? mockGet : mockEquipmentGet,
        set: (doc: unknown) => mockSet(name, id, doc),
      }),
    }),
    getAll: (...refs: { id: string }[]) => mockGetAll(...refs),
  }),
}));

vi.mock('firebase-functions', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: mockLoggerError },
}));

const mockReportServerError = vi.fn();
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportServerError: (...args: unknown[]) => mockReportServerError(...(args as [])),
  reportFlowError: vi.fn(async () => undefined),
}));

vi.stubGlobal('crypto', { randomUUID: mockUUID });

const { authorRecipeFlow } = await import('../../src/flows/authorRecipe.js');

const MESSAGES = [
  {
    id: 'm1',
    role: 'user' as const,
    text: 'what goes with lamb?',
    createdAt: '2026-09-18T10:00:00.000Z',
  },
  {
    id: 'm2',
    role: 'assistant' as const,
    text: 'a fennel salad',
    createdAt: '2026-09-18T10:00:01.000Z',
  },
];

function librarianOutput() {
  return {
    title: 'Fennel, Orange & Olive Salad',
    kind: 'recipe' as const,
    cureCategory: null,
    description: 'Sharp and cold, against the lamb.',
    servings: 4,
    tags: ['side'],
    ingredientGroups: [
      {
        name: null,
        ingredients: [
          { rawText: '1 fennel bulb, shaved', isOptional: false, firstUsedInStepOrdinal: 0 },
        ],
      },
    ],
    steps: [{ text: 'Shave the fennel.', timerMinutes: null, timerLabel: null, note: null }],
    notes: null,
  };
}

// A valid RecipeDoc for the base-recipe read that edit mode performs.
function baseRecipeDoc() {
  return {
    id: 'r1',
    schemaVersion: 1 as const,
    title: 'Roast Lamb',
    description: null,
    ingredients: [],
    steps: [{ id: 's1', text: 'Roast it.', timer: null, note: null }],
    metadata: { servings: 4, tags: [] },
    source: { type: 'manual' as const },
    notes: null,
    image: null,
    createdBy: 'Kate',
    lastEditedBy: 'Kate',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

type FlowInput = Record<string, unknown>;
const run = (input: FlowInput) =>
  (authorRecipeFlow as unknown as (i: FlowInput) => Promise<Record<string, unknown>>)(input);

beforeEach(() => {
  vi.clearAllMocks();
  let counter = 0;
  mockUUID.mockImplementation(() => `id-${++counter}`);
  mockGenerate.mockResolvedValue({ output: librarianOutput() });
  mockParseFlow.mockResolvedValue([]);
  mockCanonFlow.mockResolvedValue([]);
  mockEquipmentGet.mockResolvedValue({ exists: false });
  mockGetAll.mockResolvedValue([]);
  mockGet.mockResolvedValue({ exists: false });
  mockSet.mockResolvedValue(undefined);
});

describe('authorRecipe — the flow writes what it authored (#1431)', () => {
  it('writes the recipe to recipes/{id} on the create path', async () => {
    const recipe = await run({ messages: MESSAGES, existingTags: [] });

    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledWith('recipes', recipe.id, recipe);
  });

  it('returns the very document it wrote, so the client can stash and paint it', async () => {
    const recipe = await run({ messages: MESSAGES, existingTags: [] });

    // Not merely "a recipe with the same id": the client stashes what comes back
    // and the page renders it until the listener catches up, so any divergence
    // paints something Firestore does not hold.
    expect(mockSet.mock.calls[0]![2]).toEqual(recipe);
    expect(recipe.title).toBe('Fennel, Orange & Olive Salad');
  });

  it('stamps createdAt and updatedAt to one instant, and neither is blank', async () => {
    const recipe = await run({ messages: MESSAGES, existingTags: [] });

    // The clock used to be the browser's, applied after the call. It is the
    // assembler's now, because the document the assembler mints is the document
    // that gets written.
    expect(recipe.createdAt).not.toBe('');
    expect(recipe.createdAt).toBe(recipe.updatedAt);
  });

  it('does NOT flag a chat-authored recipe needs_approval', async () => {
    const recipe = await run({ messages: MESSAGES, existingTags: [] });

    // `needs_approval` is the two IMPORT flows' option on `assembleRecipeDraft`.
    // Sharing the persist helper with them must not start flagging a recipe the
    // user talked through and asked for. Absent, not `false` — absent means
    // reviewed and an explicit `false` is a different document.
    expect('needs_approval' in recipe).toBe(false);
    expect(mockSet.mock.calls[0]![2]).not.toHaveProperty('needs_approval');
  });

  it('still returns the recipe when the write fails, and logs it', async () => {
    mockSet.mockRejectedValue(new Error('firestore unavailable'));

    const recipe = await run({ messages: MESSAGES, existingTags: [] });

    // The generation succeeded and was paid for; throwing it away over a write
    // error would be strictly worse than the pre-#1431 behaviour.
    expect(recipe.title).toBe('Fennel, Orange & Olive Salad');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('failed to persist'),
      expect.objectContaining({ recipeId: recipe.id }),
    );
  });

  it('reports the failed write (issue #1431 review, should-fix)', async () => {
    // The caller — the client, via `chatRecipeAuthor` — believes the recipe it
    // was handed back is safe. A silent Firestore failure here is exactly the
    // `StorageError` category CLAUDE.md's error-reporting conventions put in the
    // report column, and it is the same "already-paid-for run, don't fail the
    // call, but tell someone" reasoning `canonicaliseRecipeIngredients` already
    // acts on for its own write.
    const writeError = new Error('firestore unavailable');
    mockSet.mockRejectedValue(writeError);

    await run({ messages: MESSAGES, existingTags: [] });

    expect(mockReportServerError).toHaveBeenCalledWith(writeError, 'StorageError');
  });

  it('does not report a StorageError when the write succeeds', async () => {
    // Not "reports nothing" — this fixture's ingredient line has no parse
    // result, which `assembleRecipeDraft` reports on its own, unrelated axis.
    // The property under test is narrower: a successful persist never adds a
    // `StorageError` report of its own.
    await run({ messages: MESSAGES, existingTags: [] });

    expect(mockReportServerError).not.toHaveBeenCalledWith(expect.anything(), 'StorageError');
  });

  it('writes on the VARIATION path, which is a create with a grounding recipe', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => baseRecipeDoc() });

    const recipe = await run({ messages: MESSAGES, existingTags: [], basedOnRecipeId: 'r1' });

    // `basedOnRecipeId` grounds the prose and nothing else — no `recipeId`, so it
    // is a new independent dish and the browser saves it unconditionally.
    expect(mockSet).toHaveBeenCalledWith('recipes', recipe.id, recipe);
    expect(recipe.id).not.toBe('r1');
  });
});

describe('authorRecipe — edit mode writes nothing (the review gate)', () => {
  it('writes nothing when recipeId is set', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => baseRecipeDoc() });

    const draft = await run({ messages: MESSAGES, existingTags: [], recipeId: 'r1' });

    // The whole point of `recipeAmend.propose`: the user sees the diff first.
    expect(mockSet).not.toHaveBeenCalled();
    expect(draft.title).toBeDefined();
  });

  it('writes nothing even when the base recipe cannot be read', async () => {
    // `readBaseRecipe` degrades to null on a missing or unparseable document, so
    // `baseRecipe` is an unsafe gate — gating on it would mint a stray recipe out
    // of an amendment nobody confirmed. The gate is `input.recipeId`.
    mockGet.mockResolvedValue({ exists: false });

    await run({ messages: MESSAGES, existingTags: [], recipeId: 'r1' });

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('writes nothing when the base recipe fails validation', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ id: 'r1', title: 42 }) });

    await run({ messages: MESSAGES, existingTags: [], recipeId: 'r1' });

    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('authorRecipe — attribution travels with the write', () => {
  it('stamps createdBy and lastEditedBy from the name on the wire', async () => {
    const recipe = await run({ messages: MESSAGES, existingTags: [], authorName: 'Daniel' });

    expect(recipe.createdBy).toBe('Daniel');
    expect(recipe.lastEditedBy).toBe('Daniel');
    // What was WRITTEN carries it too — the stamp is applied before the write,
    // not to the returned copy alone.
    expect(mockSet.mock.calls[0]![2]).toMatchObject({
      createdBy: 'Daniel',
      lastEditedBy: 'Daniel',
    });
  });

  it('leaves both fields blank when no name is sent', async () => {
    // An older bundle after a deploy, or a roster that has not loaded. A
    // placeholder would read as a person; blank already means "no attribution on
    // record".
    const recipe = await run({ messages: MESSAGES, existingTags: [] });

    expect(recipe.createdBy).toBe('');
    expect(recipe.lastEditedBy).toBe('');
  });

  it('leaves both fields blank when the name is an empty string', async () => {
    const recipe = await run({ messages: MESSAGES, existingTags: [], authorName: '' });

    expect(recipe.createdBy).toBe('');
    expect(recipe.lastEditedBy).toBe('');
  });

  // The fill-once half of the rule — an existing `createdBy` is never re-pointed
  // at a later editor — is NOT observable through this flow, and saying otherwise
  // would be the kind of unfalsifiable claim this repo's rule 12 exists to stop:
  // the assembler hands the create path a blank `createdBy` every time (edit mode
  // is the only composition that carries one, and edit mode writes nothing here).
  // It is pinned where the rule lives, in
  // `packages/domain/tests/recipe/stampAttribution.test.ts`.
});
