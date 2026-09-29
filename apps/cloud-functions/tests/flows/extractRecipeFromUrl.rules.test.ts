import { describe, it, expect, vi, beforeEach } from 'vitest';

// Issue #785: the URL import is one of three authoring paths that must all be
// prompted by the SAME field-rule module. It is the only one with TWO prompts —
// the JSON-LD path (the page told us where the recipe is; the model converts it)
// and the HTML fallback (the model has to find it first) — and both are asserted
// here, because a hand-rolled twin on either one is the drift this module removed.
//
// Issue #1637 added a third road — a YouTube video, read by the model watching it
// — and its request shape is pinned at the bottom of this file, in the same
// harness rather than a second copy of it.

const mockGenerate = vi.fn();
const mockJsonLd = vi.fn();
const mockFetch = vi.fn(async (_url: string) => ({
  html: '<html><body>a recipe page</body></html>',
}));
const mockResolveModel = vi.fn(async (_flowId: string) => 'gemini-flash-latest');
const mockTimeout = vi.fn((_label: string, op: () => unknown, _opts?: unknown) => op());
const mockSpanName = vi.fn();

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
  withAiTimeout: mockTimeout,
}));
vi.mock('../../src/ai/resolveModel.js', () => ({ resolveModel: mockResolveModel }));
vi.mock('@salt/observability/server', () => ({
  setActiveSpanName: mockSpanName,
  // assembleRecipeDraft reports an unjoinable parse result through
  // reportServerError, which builds its adapter at module load (issue #949).
  createServerObservabilityErrorReportingAdapter: () => ({ report: vi.fn() }),
  flushServerObservability: vi.fn(async () => {}),
}));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: () => ({ doc: () => ({ set: vi.fn() }) }) }),
}));
vi.mock('firebase-functions', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock('../../src/adapters/ssrfFetch.js', () => ({
  ssrfGuardedFetch: mockFetch,
  SsrfFetchError: class extends Error {},
}));
vi.mock('../../src/adapters/jsonLdRecipe.js', () => ({ extractRecipeJsonLd: mockJsonLd }));
vi.mock('../../src/flows/parseRecipeIngredients.js', () => ({
  parseRecipeIngredientsFlow: vi.fn(async () => []),
}));
vi.mock('../../src/flows/canonicaliseRecipeIngredients.js', () => ({
  canonicaliseRecipeIngredientsFlow: vi.fn(async () => ({ settled: [] })),
}));

const { extractRecipeFromUrlFlow, UrlImportError } =
  await import('../../src/flows/extractRecipeFromUrl.js');
const { recipeFieldRules } = await import('../../src/flows/recipeFieldRules.js');

const URL = 'https://example.com/carbonara';

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

const JSON_LD = {
  title: 'Carbonara',
  description: null,
  servings: 2,
  totalTimeMinutes: 20,
  prepTimeMinutes: null,
  cookTimeMinutes: null,
  tags: [],
  ingredients: ['200g spaghetti', '2 eggs'],
  steps: ['Boil the pasta.'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
  mockJsonLd.mockReturnValue(null);
});

function systemPromptFrom(): string {
  return (mockGenerate.mock.calls[0]![0] as { system: string }).system;
}

describe('extractRecipeFromUrl — shared field rules (#785)', () => {
  it('interpolates them verbatim on the HTML fallback prompt', async () => {
    await (extractRecipeFromUrlFlow as Function)({ url: URL });

    expect(systemPromptFrom()).toContain(recipeFieldRules({ measures: 'metricate' }));
  });

  it('interpolates the SAME block on the JSON-LD prompt', async () => {
    mockJsonLd.mockReturnValue(JSON_LD);

    await (extractRecipeFromUrlFlow as Function)({ url: URL });

    // The two prompts differ in how the recipe reaches the model, never in the
    // rules it is held to: a recipe imported off a page with schema.org data and
    // one scraped out of its HTML must come back identical in shape and units.
    expect(systemPromptFrom()).toContain(recipeFieldRules({ measures: 'metricate' }));
  });

  it('asks for the rewrite policy on a DOCUMENT source, never the librarian preserve policy', async () => {
    await (extractRecipeFromUrlFlow as Function)({ url: URL });

    // Rewriting someone else's line IS the import.
    const system = systemPromptFrom();
    expect(system).toContain('the ingredient line rewritten in British spelling/terms');
    expect(system).not.toContain('preserve the original wording');
  });

  it('exempts the TIMING from faithfulness, and nothing else (#952)', async () => {
    mockJsonLd.mockReturnValue(JSON_LD);

    await (extractRecipeFromUrlFlow as Function)({ url: URL });

    // The JSON-LD prompt used to name "times" in the same breath as ingredients
    // and steps — "Use ONLY the ingredients, steps, times and servings given" —
    // so an import inherited the food blog's optimistic prep time by explicit
    // instruction, and no amount of defining prep in the shared field rules could
    // reach it.
    const system = systemPromptFrom();
    expect(system).not.toContain('Use ONLY the ingredients, steps, times and servings given');
    expect(system).toContain('Use ONLY the ingredients, steps and servings given');
    expect(system).toContain('The TIMING is the one exception');
    expect(system).toContain('a HINT, not a floor');

    // The narrowing is for the TIMING ONLY. Content stays verbatim.
    expect(system).toContain('Do not invent, add, drop or reorder');
    expect(system).toContain('Keep every ingredient and every instruction');
    expect(system).toContain('this licence covers the timing and nothing else');
  });

  it("labels the page's own times as the page's, not as fields to copy", async () => {
    mockJsonLd.mockReturnValue(JSON_LD);

    await (extractRecipeFromUrlFlow as Function)({ url: URL });

    const prompt = (mockGenerate.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain('Total time as stated by the page (minutes): 20');
    expect(prompt).not.toContain('Total time (minutes): 20');
  });

  it("bans cups but keeps the source's tsp/tbsp for the parse stage", async () => {
    await (extractRecipeFromUrlFlow as Function)({ url: URL });

    // Converting someone else's units IS the import — but converting the SPOON
    // measures is not, and used to be: the rawText emitted here is the only thing
    // `parseRecipeIngredients` ever sees, so a "1 tsp" metricated at this step is
    // a "(1 tsp)" the cook never gets in the ingredient list.
    const system = systemPromptFrom();
    expect(system).toContain('NEVER cups, sticks, pints, quarts, fluid ounces, ounces or pounds');
    expect(system).toContain('leave a spoon measure EXACTLY as the source wrote it');
    expect(system).not.toContain('tablespoons and teaspoons');
  });
});

// ─── the step-citation clause is not here (issue #1178) ───────────────────────

// #1178 asks the LIBRARIAN, in edit mode only, which existing step each rewrite
// came from. "The blast radius is edit mode alone" is a sentence unless the
// prompts it must not have reached say so themselves, and an import prompt is
// where it would land by accident: `recipeFieldRules` and `STEP_RULES` are shared
// with the librarian since #785, so a clause put there instead would arrive here
// silently and be asking a question a web page cannot answer.
describe('extractRecipeFromUrl — no step-provenance clause (#1178)', () => {
  it('never asks an import to cite a step it came from, on either prompt', async () => {
    await (extractRecipeFromUrlFlow as Function)({ url: URL });
    expect(systemPromptFrom()).not.toContain('sourceStepId');
    expect(systemPromptFrom()).not.toContain('Where each step came from');

    vi.clearAllMocks();
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
    mockJsonLd.mockReturnValue(JSON_LD);
    await (extractRecipeFromUrlFlow as Function)({ url: URL });
    expect(systemPromptFrom()).not.toContain('sourceStepId');
    expect(systemPromptFrom()).not.toContain('Where each step came from');
  });
});

// ─── recipe or cocktail (issue #765) ─────────────────────────────────────────
//
// The URL import's half of "every route that can make a recipe can make a
// cocktail". Both prompts are covered, because the JSON-LD path and the HTML
// fallback are separate system prompts and a rule added to only one of them
// would leave half the web classifying and half not.
describe('extractRecipeFromUrl — recipe or cocktail', () => {
  it.each([
    ['the HTML fallback prompt', false],
    ['the JSON-LD prompt', true],
  ])('asks the question and states the tie-break on %s', async (_name, withJsonLd) => {
    if (withJsonLd) mockJsonLd.mockReturnValue(JSON_LD);

    await (extractRecipeFromUrlFlow as Function)({ url: URL });

    const system = systemPromptFrom();
    expect(system).toContain('- kind:');
    expect(system).toContain('a drink that is MIXED and served in a glass');
    expect(system).toContain('When it is not clearly a mixed drink in a glass, answer "recipe"');
  });

  it('lands a cocktail page in the Cocktails section', async () => {
    mockGenerate.mockResolvedValue({
      output: { ...AI_OUTPUT, kind: 'cocktail', title: 'Negroni' },
    });

    const recipe = await (extractRecipeFromUrlFlow as Function)({ url: URL });

    expect(recipe.kind).toBe('cocktail');
  });

  it('lands an ordinary dinner as a recipe, exactly as before', async () => {
    // AI_OUTPUT carries no `kind` at all — which is also the pre-#765 payload, so
    // this is the back-compat assertion as much as the happy path.
    const recipe = await (extractRecipeFromUrlFlow as Function)({ url: URL });

    expect(recipe.kind).toBe('recipe');
  });

  it('does not fail the import when the model answers a kind that does not exist', async () => {
    // A bad `kind` must never turn a perfectly good extraction into a failed
    // import. The extractor validates INSIDE its retried op, so a throw here would
    // burn the retry as well and surface as ai-failed.
    mockGenerate.mockResolvedValue({ output: { ...AI_OUTPUT, kind: 'beverage' } });

    const recipe = await (extractRecipeFromUrlFlow as Function)({ url: URL });

    expect(recipe.kind).toBe('recipe');
    expect(recipe.title).toBe('Carbonara');
    // One generate call: nothing was retried.
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});

// ─── A YouTube video (issue #1637) ──────────────────────────────────────────────
// A video link is imported by handing the video itself to Gemini. These pin the
// road it takes: the normalised watch URL as a media part clipped at 30 minutes,
// its own flow id and budget, the failure codes, the draft's source pointing
// back at the video, and (Phase 2) the watch page read for its description and
// length — best effort, so its failure is silent.

const SHORT_LINK = 'https://youtu.be/dQw4w9WgXcQ?si=tracker';
const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

type VideoRequest = {
  system: string;
  prompt: Array<{ text?: string; media?: { url: string }; metadata?: unknown }>;
};
const videoRequest = (): VideoRequest => mockGenerate.mock.calls[0]![0] as VideoRequest;

// The error the Gemini Developer API returns, through the google-genai plugin,
// for a video it cannot watch — measured 2026-09-29 (see isVideoRefused).
function refusal(): Error {
  return Object.assign(new Error('[403 Forbidden] The caller does not have permission'), {
    status: 'UNKNOWN',
    detail: {
      error: {
        code: 403,
        message: 'The caller does not have permission',
        status: 'PERMISSION_DENIED',
      },
    },
  });
}

async function failureCode(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UrlImportError);
  return (err as InstanceType<typeof UrlImportError>).code;
}

// A watch page as YouTube serves it, reduced to the object the parser reads.
function watchPage(details: { shortDescription?: string; lengthSeconds?: string }): {
  html: string;
} {
  const response = { videoDetails: { videoId: 'dQw4w9WgXcQ', ...details } };
  return {
    html: `<html><body><script>var ytInitialPlayerResponse = ${JSON.stringify(response)};</script></body></html>`,
  };
}

const videoText = (): string =>
  videoRequest()
    .prompt.map((p) => p.text ?? '')
    .join('\n');

describe('extractRecipeFromUrl — a YouTube video (#1637)', () => {
  it('fetches only the normalised watch page, through the SSRF guard', async () => {
    await (extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK });

    expect(mockFetch.mock.calls).toEqual([[WATCH]]);
  });

  it('sends the NORMALISED watch URL as a video part clipped at 30 minutes', async () => {
    await (extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK });

    const media = videoRequest().prompt.find((p) => p.media !== undefined)!;
    expect(media.media!.url).toBe(WATCH);
    expect(media.metadata).toEqual({ videoMetadata: { endOffset: '1800s' } });
  });

  it('runs under its own flow id, budget and span name', async () => {
    await (extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK });

    expect(mockResolveModel).toHaveBeenCalledWith('extractRecipeFromVideo');
    expect(mockResolveModel).not.toHaveBeenCalledWith('extractRecipeFromUrl');
    expect(mockTimeout).toHaveBeenCalledWith('extractRecipeFromVideo', expect.any(Function), {
      timeoutMs: 180_000,
      retries: 0,
    });
    expect(mockSpanName).toHaveBeenCalledWith('Import recipe from YouTube');
  });

  it('holds the video to the same field rules as every other authoring path', async () => {
    await (extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK });

    expect(videoRequest().system).toContain(recipeFieldRules({ measures: 'metricate' }));
  });

  it('points the draft source back at the video, flagged for review', async () => {
    const recipe = await (extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK });

    expect(recipe.source).toEqual({ type: 'url', url: WATCH });
    expect(recipe.needs_approval).toBe(true);
  });

  it('maps a video Gemini cannot watch to video-unavailable', async () => {
    mockGenerate.mockRejectedValue(refusal());

    expect(await failureCode((extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK }))).toBe(
      'video-unavailable',
    );
  });

  it.each([
    ['a plain error', new Error('upstream 500')],
    ['a server error', Object.assign(new Error('500'), { detail: { error: { code: 500 } } })],
    ['an error body with no error', Object.assign(new Error('odd'), { detail: {} })],
    ['a non-Error rejection', null],
  ])('maps any other model failure to ai-failed: %s', async (_label, err) => {
    mockGenerate.mockRejectedValue(err);

    expect(await failureCode((extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK }))).toBe(
      'ai-failed',
    );
  });

  it('maps a video that cooks nothing to not-a-recipe', async () => {
    mockGenerate.mockResolvedValue({
      output: { ...AI_OUTPUT, isRecipe: false, ingredientGroups: [], steps: [] },
    });

    expect(await failureCode((extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK }))).toBe(
      'not-a-recipe',
    );
  });

  it('leaves a YouTube address that is not one video on the page road', async () => {
    await (extractRecipeFromUrlFlow as Function)({ url: 'https://www.youtube.com/@SomeChef' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockResolveModel).toHaveBeenCalledWith('extractRecipeFromUrl');
  });

  it('refuses a video over 30 minutes before any model call', async () => {
    mockFetch.mockResolvedValueOnce(watchPage({ lengthSeconds: '2700' }));

    expect(await failureCode((extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK }))).toBe(
      'video-too-long',
    );
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockResolveModel).not.toHaveBeenCalled();
  });

  it('lets a video of exactly 30 minutes through', async () => {
    mockFetch.mockResolvedValueOnce(watchPage({ lengthSeconds: '1800' }));

    await (extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK });

    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  it("hands the model the creator's description, which wins on amounts", async () => {
    mockFetch.mockResolvedValueOnce(
      watchPage({ shortDescription: 'INGREDIENTS\n250g 00 flour\n3 eggs', lengthSeconds: '600' }),
    );

    await (extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK });

    expect(videoText()).toContain("The creator's written description of this video:");
    expect(videoText()).toContain('250g 00 flour');
    expect(videoRequest().system).toContain('that amount wins over what is said or shown');
  });

  it.each([
    ['the fetch fails', () => mockFetch.mockRejectedValueOnce(new Error('too-large'))],
    [
      'a consent page is served',
      () => mockFetch.mockResolvedValueOnce({ html: '<h1>Before you continue to YouTube</h1>' }),
    ],
  ])('carries on from the video alone when %s', async (_label, arrange) => {
    arrange();

    const recipe = await (extractRecipeFromUrlFlow as Function)({ url: SHORT_LINK });

    expect(recipe.title).toBe('Carbonara');
    expect(videoText()).not.toContain('description');
    // Unknown length: the clip still holds the cost ceiling.
    const media = videoRequest().prompt.find((p) => p.media !== undefined)!;
    expect(media.metadata).toEqual({ videoMetadata: { endOffset: '1800s' } });
  });
});
