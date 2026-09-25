import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #616: the URL-import flow PERSISTS the recipe it extracts, flagged
// needs_approval, instead of handing the only copy back to the browser. That is
// what makes a share-sheet import (#589) survive Android killing the backgrounded
// PWA mid-extraction — the recipe exists the moment the extraction finishes.
//
// A write failure must NOT fail the import: the extraction already succeeded and
// was already paid for, so the callable still returns the recipe and the client
// degrades to saving it from the editor itself.

const mockGenerate = vi.fn();
const mockSet = vi.fn();
const mockDoc = vi.fn(() => ({ set: mockSet }));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));
const mockLoggerError = vi.fn();

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: mockGenerate,
  },
}));
vi.mock('@genkit-ai/google-genai', () => ({ googleAI: { model: (name: string) => name } }));
// Bypass the real timer, but keep everything else the module exports (the
// shared budget constant, the stream guard) — a factory that lists only
// `withAiTimeout` goes stale the moment the module grows.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));
vi.mock('../../src/ai/resolveModel.js', () => ({
  resolveModel: vi.fn(async () => 'gemini-flash-latest'),
}));
vi.mock('@salt/observability/server', () => ({
  setActiveSpanName: vi.fn(),
  // assembleRecipeDraft reports an unjoinable parse result through
  // reportServerError, which builds its adapter at module load (issue #949).
  createServerObservabilityErrorReportingAdapter: () => ({ report: vi.fn() }),
  flushServerObservability: vi.fn(async () => {}),
}));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: mockCollection }),
}));
vi.mock('firebase-functions', () => ({ logger: { error: mockLoggerError, info: vi.fn() } }));

// The page fetch and the ingredient sub-flows are not what's under test here.
vi.mock('../../src/adapters/ssrfFetch.js', () => ({
  ssrfGuardedFetch: vi.fn(async () => ({ html: '<html><body>a recipe page</body></html>' })),
  SsrfFetchError: class extends Error {},
}));
vi.mock('../../src/adapters/jsonLdRecipe.js', () => ({ extractRecipeJsonLd: () => null }));
vi.mock('../../src/flows/parseRecipeIngredients.js', () => ({
  parseRecipeIngredientsFlow: vi.fn(async () => []),
}));
vi.mock('../../src/flows/canonicaliseRecipeIngredients.js', () => ({
  canonicaliseRecipeIngredientsFlow: vi.fn(async () => ({ settled: [] })),
}));

const { extractRecipeFromUrlFlow } = await import('../../src/flows/extractRecipeFromUrl.js');

const URL = 'https://example.com/carbonara';

// Rich enough to clear the not-a-recipe threshold on the no-JSON-LD path.
const AI_OUTPUT = {
  isRecipe: true,
  title: 'Carbonara',
  description: 'A Roman pasta.',
  ingredientGroups: [
    {
      name: null,
      ingredients: ['200g spaghetti', '2 eggs', '50g pecorino'].map((rawText) => ({
        rawText,
        isOptional: false,
        firstUsedInStepOrdinal: null,
      })),
    },
  ],
  steps: [{ text: 'Boil the pasta.', timerMinutes: null, timerLabel: null, note: null }],
  servings: 2,
  tags: ['pasta'],
  notes: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSet.mockResolvedValue(undefined);
  mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
});

describe('extractRecipeFromUrl — server-side persistence (#616)', () => {
  it('writes the extracted recipe to recipes/{id} flagged needs_approval', async () => {
    const recipe = await (extractRecipeFromUrlFlow as Function)({ url: URL });

    expect(mockCollection).toHaveBeenCalledWith('recipes');
    expect(mockDoc).toHaveBeenCalledWith(recipe.id);
    const written = mockSet.mock.calls[0]![0];
    expect(written.needs_approval).toBe(true);
    expect(written.id).toBe(recipe.id);
    expect(written.title).toBe('Carbonara');
    expect(written.source).toEqual({ type: 'url', url: URL });
  });

  it('returns the same flag it persisted, so the editor agrees with the list', async () => {
    const recipe = await (extractRecipeFromUrlFlow as Function)({ url: URL });

    expect(recipe.needs_approval).toBe(true);
  });

  it('still returns the recipe when the write fails, and logs it', async () => {
    mockSet.mockRejectedValue(new Error('firestore unavailable'));

    const recipe = await (extractRecipeFromUrlFlow as Function)({ url: URL });

    // The extraction succeeded and was paid for — throwing it away because the
    // write failed would be strictly worse than the pre-#616 behaviour.
    expect(recipe.title).toBe('Carbonara');
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('failed to persist'),
      expect.objectContaining({ recipeId: recipe.id }),
    );
  });
});

// Issue #1601: asked with `reportPersistence: true`, the flow says whether its
// write landed; not asked — every tab on an older bundle — it answers the bare
// recipe exactly as before.
describe('extractRecipeFromUrl — says whether the write landed, when asked (#1601)', () => {
  const invoke = (input: unknown) => (extractRecipeFromUrlFlow as Function)(input);

  it('answers { recipe, persistence: written } when asked and the write lands', async () => {
    const answer = await invoke({ url: URL, reportPersistence: true });

    expect(answer.persistence).toBe('written');
    expect(answer.recipe).toBe(mockSet.mock.calls[0]![0]);
  });

  it('answers persistence: failed when asked and the write fails', async () => {
    mockSet.mockRejectedValue(new Error('firestore unavailable'));

    const answer = await invoke({ url: URL, reportPersistence: true });

    expect(answer.persistence).toBe('failed');
    expect(answer.recipe.title).toBe('Carbonara');
  });

  it('answers the BARE recipe when not asked, even on a failed write', async () => {
    mockSet.mockRejectedValue(new Error('firestore unavailable'));

    const answer = await invoke({ url: URL });

    expect(answer).not.toHaveProperty('persistence');
    expect(answer).not.toHaveProperty('recipe');
    expect(answer.title).toBe('Carbonara');
  });

  it('never writes the outcome onto the stored recipe', async () => {
    await invoke({ url: URL, reportPersistence: true });

    expect(mockSet.mock.calls[0]![0]).not.toHaveProperty('persistence');
  });
});
