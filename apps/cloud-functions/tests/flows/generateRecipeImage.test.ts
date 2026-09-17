import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerate = vi.fn();

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: mockGenerate,
  },
}));

vi.mock('@genkit-ai/google-genai', () => ({
  googleAI: {
    model: (name: string) => name,
  },
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  generateRecipeImageFlow,
  RECIPE_IMAGE_STYLE_ANCHORS,
  RECIPE_IMAGE_DISH_READING_FALLBACK,
  SPECIAL_IMAGE_STYLE_ANCHORS,
  SPECIAL_SCENE_FALLBACK,
  COCKTAIL_IMAGE_STYLE_ANCHORS,
  COCKTAIL_SCENE_FALLBACK,
  PLACEHOLDER_IMAGE_STYLE_ANCHORS,
  PLACEHOLDER_SCENE_FALLBACK,
  CURE_IMAGE_STYLE_ANCHORS,
  CURE_SCENE_FALLBACK,
  GENERATE_RECIPE_IMAGE_KINDS,
} = await import('../../src/flows/generateRecipeImage.js');

const { RecipeKindSchema } = await import('@salt/domain/schemas');

const IMAGE_OK = { media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateRecipeImage flow', () => {
  it('returns the model image as base64 + contentType', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    const result = await (generateRecipeImageFlow as Function)({
      title: 'Roast chicken',
      description: 'A whole roast chicken with lemon and thyme.',
    });

    expect(result).toEqual({ imageBase64: 'QUJD', contentType: 'image/png' });
  });

  it('builds a prompt from title + description with the locked house style', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({
      title: 'Roast chicken',
      description: 'A whole roast chicken with lemon and thyme.',
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('Roast chicken');
    expect(prompt).toContain('A whole roast chicken with lemon and thyme.');
    // The locked anchors are embedded verbatim.
    expect(prompt).toContain(RECIPE_IMAGE_STYLE_ANCHORS);
    expect(prompt).toContain('photorealistic food photograph');
  });

  it('omits the description clause when the recipe has none', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({ title: 'Roast chicken', description: null });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('the finished dish "Roast chicken"');
    expect(prompt).toContain(RECIPE_IMAGE_STYLE_ANCHORS);
  });

  it('appends an optional hint as additive guidance without altering the style', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({
      title: 'Roast chicken',
      description: null,
      hint: 'show it on a rustic board',
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('Additional guidance for this photo: show it on a rustic board');
    expect(prompt).toContain(RECIPE_IMAGE_STYLE_ANCHORS);
  });

  it('omits the guidance clause when no hint is given', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({ title: 'Roast chicken', description: null });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).not.toContain('Additional guidance');
  });

  it('weaves recipe tags in as a mood/season hint that must not be rendered', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({
      title: 'Roast chicken',
      description: null,
      tags: ['comfort-food', 'slow-cooker'],
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('This recipe is tagged: comfort-food, slow-cooker');
    // Tags are a cue, never text to render.
    expect(prompt).toContain('do NOT draw, write, label');
    expect(prompt).toContain(RECIPE_IMAGE_STYLE_ANCHORS);
  });

  it('appends the hint after the tag clause, still verbatim', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({
      title: 'Roast chicken',
      description: null,
      hint: 'show it on a rustic board',
      tags: ['comfort-food'],
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('This recipe is tagged: comfort-food');
    expect(prompt).toContain('Additional guidance for this photo: show it on a rustic board');
    // The hint is the last clause, after the tag clause.
    expect(prompt.indexOf('This recipe is tagged')).toBeLessThan(
      prompt.indexOf('Additional guidance for this photo'),
    );
  });

  it('adds no tag clause when tags are absent, empty, or whitespace-only', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    for (const tags of [undefined, [], ['', '   ']]) {
      mockGenerate.mockClear();
      await (generateRecipeImageFlow as Function)({
        title: 'Roast chicken',
        description: null,
        ...(tags ? { tags } : {}),
      });
      const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
      expect(prompt).not.toContain('This recipe is tagged');
    }
  });

  // ─── Scene brief (art direction authored from the whole recipe) ─────────────

  it('uses the scene brief in place of the dish-reading fallback', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({
      title: 'Melanzane',
      description: null,
      sceneBrief: 'A blistered, golden-topped bake scattered with torn basil.',
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('A blistered, golden-topped bake scattered with torn basil.');
    // The brief REPLACES the guess — the model is not asked to work the dish out
    // itself when it has already been told what the dish looks like.
    expect(prompt).not.toContain(RECIPE_IMAGE_DISH_READING_FALLBACK);
    // …but the anchors still hold.
    expect(prompt).toContain(RECIPE_IMAGE_STYLE_ANCHORS);
  });

  it('falls back to the dish-reading clause when no brief is available', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({ title: 'Roast chicken', description: null });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain(RECIPE_IMAGE_DISH_READING_FALLBACK);
    expect(prompt).toContain(RECIPE_IMAGE_STYLE_ANCHORS);
  });

  it('falls back when the brief is empty or whitespace-only (a failed brief step)', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    for (const sceneBrief of ['', '   ']) {
      mockGenerate.mockClear();
      await (generateRecipeImageFlow as Function)({
        title: 'Roast chicken',
        description: null,
        sceneBrief,
      });
      const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
      expect(prompt).toContain(RECIPE_IMAGE_DISH_READING_FALLBACK);
    }
  });

  it('reproduces the pre-brief prompt exactly on the plain fallback path', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({ title: 'Roast chicken', description: null });

    // The two constants were split out of ONE fused literal; with no brief, no tags
    // and no hint, `fallback + ' ' + anchors` must still recompose to it byte for
    // byte, so an existing recipe's hero is unchanged.
    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toBe(
      `A beautiful, appetising photograph of the finished dish "Roast chicken". ` +
        `${RECIPE_IMAGE_DISH_READING_FALLBACK} ${RECIPE_IMAGE_STYLE_ANCHORS}`,
    );
  });

  it('keeps the anchor wording verbatim', () => {
    // The anchors are the cross-recipe house style and the prohibitions. This is a
    // canary on the exact wording — if a refactor paraphrases them, every hero
    // silently drifts. Reword deliberately, then update this test.
    expect(RECIPE_IMAGE_STYLE_ANCHORS).toContain('photorealistic food photograph');
    expect(RECIPE_IMAGE_STYLE_ANCHORS).toContain('soft natural window light');
    expect(RECIPE_IMAGE_STYLE_ANCHORS).toContain('shallow depth of field');
    expect(RECIPE_IMAGE_STYLE_ANCHORS).toContain('rustic ceramic or worn crockery');
    expect(RECIPE_IMAGE_STYLE_ANCHORS).toContain(
      'Absolutely no text, no captions, no watermark, no logos, no branding, no hands, no people.',
    );
    // The fallback owns the dish-reading guess and must not smuggle anchors in.
    expect(RECIPE_IMAGE_DISH_READING_FALLBACK).not.toContain('no hands, no people');
  });

  it('puts the anchors LAST — after the brief, the tags and the hint', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({
      title: 'Melanzane',
      description: 'Baked aubergine.',
      sceneBrief: 'A blistered, golden-topped bake scattered with torn basil.',
      tags: ['comfort-food'],
      hint: 'show it on a rustic board',
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    // Everything authored — the brief, the tags, the user hint — sits BEFORE the
    // anchors, and the anchors end the prompt. This ordering is what stops an
    // (eventually editable) brief from overriding "no text, no people".
    expect(prompt.indexOf('torn basil')).toBeLessThan(prompt.indexOf(RECIPE_IMAGE_STYLE_ANCHORS));
    expect(prompt.indexOf('This recipe is tagged')).toBeLessThan(
      prompt.indexOf(RECIPE_IMAGE_STYLE_ANCHORS),
    );
    expect(prompt.indexOf('Additional guidance for this photo')).toBeLessThan(
      prompt.indexOf(RECIPE_IMAGE_STYLE_ANCHORS),
    );
    expect(prompt.endsWith(RECIPE_IMAGE_STYLE_ANCHORS)).toBe(true);
  });

  it('puts the anchors last on the fallback path too (no brief)', async () => {
    mockGenerate.mockResolvedValue({
      media: { url: 'data:image/png;base64,QUJD', contentType: 'image/png' },
    });

    await (generateRecipeImageFlow as Function)({
      title: 'Roast chicken',
      description: null,
      hint: 'show it on a rustic board',
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt.endsWith(RECIPE_IMAGE_STYLE_ANCHORS)).toBe(true);
  });

  it('throws when the model returns no image', async () => {
    mockGenerate.mockResolvedValue({ media: null });

    await expect(
      (generateRecipeImageFlow as Function)({ title: 'Roast chicken', description: null }),
    ).rejects.toThrow(/no image/);
  });
});

// ─── Entry kinds (issues #637, #671) ─────────────────────────────────────────
// The `recipes` collection also holds specials — a night off from cooking, which is
// a takeaway OR a meal out OR something bought ready to eat OR a sandwich made at
// home. Painting one with the recipe anchors produces a home-plated dish that never
// existed, so `kind` selects a sibling opener, fallback and anchor set. 'recipe' is
// the default arm everywhere, so absent and unrecognised kinds are unchanged.
describe('generateRecipeImage flow — entry kinds', () => {
  beforeEach(() => {
    mockGenerate.mockResolvedValue(IMAGE_OK);
  });

  async function promptFor(input: Record<string, unknown>): Promise<string> {
    mockGenerate.mockClear();
    await (generateRecipeImageFlow as Function)(input);
    return mockGenerate.mock.calls[0]![0].prompt as string;
  }

  it('pins the locally-declared kind literals against the domain enum', () => {
    // These literals CANNOT be imported: genkit bundles its own zod instance, so a
    // schema built from plain `zod` is not interchangeable with genkit's `z`. This
    // assertion is what stops the hand-copied list from drifting — add a kind to
    // RecipeKindSchema and this fails until the flow's list follows.
    expect([...GENERATE_RECIPE_IMAGE_KINDS]).toEqual(RecipeKindSchema.options);
  });

  it('produces a byte-identical prompt when kind is absent or "recipe"', async () => {
    const input = {
      title: 'Roast chicken',
      description: 'A whole roast chicken with lemon and thyme.',
      tags: ['comfort-food'],
      hint: 'show it on a rustic board',
    };

    const absent = await promptFor(input);
    const explicit = await promptFor({ ...input, kind: 'recipe' });

    // Every kind now has art direction of its own, so 'recipe' is the default arm
    // for absence only — a doc written before #637, or a caller that sends no kind.
    expect(explicit).toBe(absent);
  });

  it('paints a special as food that REALLY TURNS UP — special anchors, never the recipe ones', async () => {
    const prompt = await promptFor({
      title: 'Friday night curry',
      description: null,
      kind: 'special',
    });

    expect(prompt).toContain(SPECIAL_IMAGE_STYLE_ANCHORS);
    expect(prompt).toContain(SPECIAL_SCENE_FALLBACK);
    // The recipe house style must not leak in — a plated-dish anchor set is exactly
    // the picture a special is not.
    expect(prompt).not.toContain(RECIPE_IMAGE_STYLE_ANCHORS);
    expect(prompt).not.toContain(RECIPE_IMAGE_DISH_READING_FALLBACK);
    // …nor the "finished dish" opener.
    expect(prompt).not.toContain('the finished dish');
    expect(prompt).toContain("a chef's special: a meal that needs no recipe card");
  });

  it('keeps the special anchors LAST on the brief path', async () => {
    const prompt = await promptFor({
      title: 'Friday night curry',
      description: 'From the place on the corner.',
      kind: 'special',
      sceneBrief: 'Foil trays opened out on a coffee table, naan torn in half.',
      tags: ['takeaway'],
      hint: 'lots of little tubs',
    });

    // The brief REPLACES the fallback, exactly as on the recipe path…
    expect(prompt).toContain('Foil trays opened out on a coffee table');
    expect(prompt).not.toContain(SPECIAL_SCENE_FALLBACK);
    // …and everything authored still sits before the anchors, which end the prompt.
    // This ordering matters MORE here: with no method to read, a hand-edited brief
    // is the primary path for a special, so it is the likeliest thing to try to
    // talk the model out of "no people, no logos".
    expect(prompt.indexOf('Foil trays opened out')).toBeLessThan(
      prompt.indexOf(SPECIAL_IMAGE_STYLE_ANCHORS),
    );
    expect(prompt.indexOf('This recipe is tagged')).toBeLessThan(
      prompt.indexOf(SPECIAL_IMAGE_STYLE_ANCHORS),
    );
    expect(prompt.indexOf('Additional guidance for this photo')).toBeLessThan(
      prompt.indexOf(SPECIAL_IMAGE_STYLE_ANCHORS),
    );
    expect(prompt.endsWith(SPECIAL_IMAGE_STYLE_ANCHORS)).toBe(true);
  });

  it('keeps the special anchors LAST on the fallback path too (no brief)', async () => {
    const prompt = await promptFor({
      title: 'Friday night curry',
      description: null,
      kind: 'special',
      hint: 'lots of little tubs',
    });
    expect(prompt.endsWith(SPECIAL_IMAGE_STYLE_ANCHORS)).toBe(true);
  });

  it('keeps the special anchor wording verbatim', () => {
    // Canary, mirroring the recipe anchors': these are the special house style and
    // the prohibitions. Reword deliberately, then update this test.
    expect(SPECIAL_IMAGE_STYLE_ANCHORS).toContain('NO RECIPE WAS FOLLOWED HERE');
    expect(SPECIAL_IMAGE_STYLE_ANCHORS).toContain('Do NOT stage it as a restaurant would');
    // #1322. The anchors are appended LAST, so an unconditional "nobody cooked"
    // would outrank a brief that correctly describes a Sunday roast. The
    // prohibition is now bounded to restaurant plating, and the carve-out for a
    // dish the household cooks by heart is asserted rather than assumed.
    expect(SPECIAL_IMAGE_STYLE_ANCHORS).not.toContain('NOBODY COOKED A RECIPE HERE');
    expect(SPECIAL_IMAGE_STYLE_ANCHORS).toContain(
      'if the direction above says this is a dish the household cooks by heart, then it WAS cooked here',
    );
    expect(SPECIAL_SCENE_FALLBACK).toContain('cooks so often it was never written down');
    expect(SPECIAL_IMAGE_STYLE_ANCHORS).toContain('photorealistic photograph');
    expect(SPECIAL_IMAGE_STYLE_ANCHORS).toContain('shallow depth of field');
    expect(SPECIAL_IMAGE_STYLE_ANCHORS).toContain(
      'Absolutely no text, no captions, no watermark, no logos, no branding, no hands, no people.',
    );
    // The fallback owns the occasion-reading guess and must not smuggle anchors in.
    expect(SPECIAL_SCENE_FALLBACK).not.toContain('no hands, no people');
  });

  // Issue #671. "Chef's Specials" is not a synonym for takeaway — it is equally a meal
  // out, a pie from the butcher, or a sandwich made standing up. The anchors are
  // appended LAST, after the brief, the description, the tags and the hint, so any
  // vessel named in them outranks everything a user can type: naming "the open foil
  // tray" there put a disposable takeaway box in every special hero regardless of
  // what the special was. A vessel is a SUBJECT decision and belongs to the per-doc
  // brief; the anchors reference how the direction above serves the food instead.
  //
  // This is the same rule #652 established for the placeholder anchors, and it is
  // asserted the same way: no concrete vessel noun in the invariant text.
  it('names no vessel and assumes no takeaway in the special anchors', () => {
    for (const vessel of ['foil', 'carton', 'pizza box', 'styrofoam', 'bamboo', 'paper wrapping']) {
      expect(SPECIAL_IMAGE_STYLE_ANCHORS.toLowerCase()).not.toContain(vessel);
    }
    // Nor the takeaway PREMISE, which was false for three of the four cases — and
    // whose crockery prohibition was actively wrong for the sandwich, which is made
    // on a plate at home.
    expect(SPECIAL_IMAGE_STYLE_ANCHORS).not.toContain('home crockery');
    expect(SPECIAL_IMAGE_STYLE_ANCHORS).not.toContain('someone else made and handed over');
    // The fallback is the no-brief path, so it MAY name things — but it has to span
    // all four kinds of night off, not five wordings of takeaway.
    expect(SPECIAL_SCENE_FALLBACK).toContain('bought ready to eat');
    expect(SPECIAL_SCENE_FALLBACK).toContain('sandwich');
    expect(SPECIAL_SCENE_FALLBACK).toContain('restaurant');
    expect(SPECIAL_SCENE_FALLBACK).toContain('takeaway');
  });

  // ─── Cocktails (Phase 5) ───────────────────────────────────────────────────
  // A cocktail keeps the ingredients and the method, so unlike a special it is a
  // recipe in every way the editor cares about. What it has no version of is a
  // PLATE — so the recipe anchors, which put food "generously plated on rustic
  // ceramic", paint a drink that was served as dinner.

  it('paints a cocktail as a glass on a bar — cocktail anchors, never the recipe ones', async () => {
    const prompt = await promptFor({
      title: 'Negroni',
      description: null,
      kind: 'cocktail',
    });

    expect(prompt).toContain(COCKTAIL_IMAGE_STYLE_ANCHORS);
    expect(prompt).toContain(COCKTAIL_SCENE_FALLBACK);
    // The plated-dish house style must not leak in — a Negroni on rustic ceramic is
    // exactly the picture this kind exists to avoid.
    expect(prompt).not.toContain(RECIPE_IMAGE_STYLE_ANCHORS);
    expect(prompt).not.toContain(RECIPE_IMAGE_DISH_READING_FALLBACK);
    // …nor the "finished dish" opener, nor the special's arrives-in-a-box direction.
    expect(prompt).not.toContain('the finished dish');
    expect(prompt).not.toContain(SPECIAL_IMAGE_STYLE_ANCHORS);
    expect(prompt).toContain('the finished drink in its glass');
  });

  it('keeps the cocktail anchors LAST on the brief path', async () => {
    const prompt = await promptFor({
      title: 'Negroni',
      description: 'Equal parts, stirred, big cube.',
      kind: 'cocktail',
      sceneBrief: 'A deep red Negroni over a clear block of ice, orange twist across the rim.',
      tags: ['aperitivo'],
      hint: 'make it late evening',
    });

    // The brief REPLACES the fallback, exactly as on the other two paths…
    expect(prompt).toContain('A deep red Negroni over a clear block of ice');
    expect(prompt).not.toContain(COCKTAIL_SCENE_FALLBACK);
    // …and everything authored still sits before the anchors, which end the prompt.
    expect(prompt.indexOf('A deep red Negroni')).toBeLessThan(
      prompt.indexOf(COCKTAIL_IMAGE_STYLE_ANCHORS),
    );
    expect(prompt.indexOf('This recipe is tagged')).toBeLessThan(
      prompt.indexOf(COCKTAIL_IMAGE_STYLE_ANCHORS),
    );
    expect(prompt.indexOf('Additional guidance for this photo')).toBeLessThan(
      prompt.indexOf(COCKTAIL_IMAGE_STYLE_ANCHORS),
    );
    expect(prompt.endsWith(COCKTAIL_IMAGE_STYLE_ANCHORS)).toBe(true);
  });

  it('keeps the cocktail anchors LAST on the fallback path too (no brief)', async () => {
    const prompt = await promptFor({
      title: 'Negroni',
      description: null,
      kind: 'cocktail',
      hint: 'make it late evening',
    });
    expect(prompt.endsWith(COCKTAIL_IMAGE_STYLE_ANCHORS)).toBe(true);
  });

  it('keeps the cocktail anchor wording verbatim', () => {
    // Canary, mirroring the other two: the cocktail house style and the
    // prohibitions. Reword deliberately, then update this test.
    expect(COCKTAIL_IMAGE_STYLE_ANCHORS).toContain('CORRECT GLASSWARE');
    expect(COCKTAIL_IMAGE_STYLE_ANCHORS).toContain('Do NOT plate it as food');
    expect(COCKTAIL_IMAGE_STYLE_ANCHORS).toContain('photorealistic photograph');
    expect(COCKTAIL_IMAGE_STYLE_ANCHORS).toContain('shallow depth of field');
    // "no bottle labels" is the cocktail-specific addition: a bar back is where the
    // model most wants to invent a spirits brand, and a legible label is a logo.
    expect(COCKTAIL_IMAGE_STYLE_ANCHORS).toContain(
      'Absolutely no text, no captions, no watermark, no logos, no branding, no bottle labels, no hands, no people.',
    );
    // The fallback owns the serve-reading guess and must not smuggle anchors in.
    expect(COCKTAIL_SCENE_FALLBACK).not.toContain('no hands, no people');
  });

  // ─── Placeholders (issue #652) ─────────────────────────────────────────────
  // A placeholder goes further than a special did. A special lost the method but
  // kept a subject; a placeholder has none — it stands in for dinner on many
  // different evenings, so the one thing it must never do is name a dish. That
  // rule lives in the anchors rather than in a brief precisely because the
  // anchors are locked and appended last, and therefore survive a hand-edited
  // brief that the rule's whole job is to outrank.

  it('paints a placeholder as an unnameable evening — its own anchors, never the others', async () => {
    const prompt = await promptFor({
      title: 'Placeholder — autumn evening',
      description: null,
      kind: 'placeholder',
    });

    expect(prompt).toContain(PLACEHOLDER_IMAGE_STYLE_ANCHORS);
    expect(prompt).toContain(PLACEHOLDER_SCENE_FALLBACK);
    // None of the other three house styles may leak in. Each of them makes a
    // subject the star, which is exactly what would paint a nameable dish.
    expect(prompt).not.toContain(RECIPE_IMAGE_STYLE_ANCHORS);
    expect(prompt).not.toContain(RECIPE_IMAGE_DISH_READING_FALLBACK);
    expect(prompt).not.toContain(SPECIAL_IMAGE_STYLE_ANCHORS);
    expect(prompt).not.toContain(COCKTAIL_IMAGE_STYLE_ANCHORS);
    expect(prompt).not.toContain('the finished dish');
    expect(prompt).toContain('with no particular dish in it');
  });

  it('hands the title over as a mood cue, never as the subject', async () => {
    // The one opener that does not make the title the thing being photographed:
    // "Placeholder — autumn evening" is a note to the person browsing the
    // library, and a model told to paint it would paint a label.
    const prompt = await promptFor({
      title: 'Placeholder — autumn evening',
      description: null,
      kind: 'placeholder',
    });

    expect(prompt).toContain('titled "Placeholder — autumn evening"');
    expect(prompt).toContain('never as a dish to paint');
  });

  it('keeps the placeholder anchors LAST on the brief path', async () => {
    const prompt = await promptFor({
      title: 'Placeholder — autumn evening',
      description: 'Lamplight and steam.',
      kind: 'placeholder',
      sceneBrief: 'Steam rising off a bowl under a low lamp, the room dark behind it.',
      tags: ['comfort'],
      hint: 'push the depth of field harder',
    });

    // The brief REPLACES the fallback, exactly as on the other three paths…
    expect(prompt).toContain('Steam rising off a bowl under a low lamp');
    expect(prompt).not.toContain(PLACEHOLDER_SCENE_FALLBACK);
    // …and everything authored still sits before the anchors, which end the
    // prompt. This ordering matters MOST here: the "nothing nameable" rule lives
    // in the anchors, and a revised brief is the primary way these ten pictures
    // get tuned, so it is the likeliest text to talk the model into a dish.
    // Assert PRESENCE before ordering: `indexOf` returns -1 for a missing needle,
    // which is less than any real index, so an ordering assertion alone passes
    // vacuously when the clause it is about has been renamed out from under it.
    for (const clause of [
      'Steam rising off a bowl',
      'This picture is tagged',
      'Additional guidance for this photo',
    ]) {
      expect(prompt).toContain(clause);
      expect(prompt.indexOf(clause)).toBeLessThan(prompt.indexOf(PLACEHOLDER_IMAGE_STYLE_ANCHORS));
    }
    expect(prompt.endsWith(PLACEHOLDER_IMAGE_STYLE_ANCHORS)).toBe(true);
  });

  it('names no lead of its own — that is the description’s job, not the anchors’', () => {
    // The regression this pins. These anchors are byte-identical on all ten
    // pictures, and they used to be the only place in the prompt with concrete
    // imagery in it — four named leads, in a block otherwise made of
    // prohibitions. Ten placeholders therefore came back as four ideas, wine
    // glass and linen over and over, whatever their descriptions said.
    for (const lead of [
      'a glass of wine mid-pour',
      'a smart cloche waiting to be lifted',
      'steam rising off a bowl on a cold night',
      'let the lead be the glass, the lid, the steam',
    ]) {
      expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).not.toContain(lead);
    }
    // And the sentence that was supposed to prevent the sameness is gone too: a
    // negation still feeds the model the nouns it names, so "do NOT default to
    // the same glass, cloth, tabletop" was three more votes for glass and cloth.
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).not.toContain('do NOT default to the same glass');
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).not.toContain('glassware and linen');
    // What replaces them points AT the per-picture direction instead of
    // supplying a subject the anchors have no business choosing.
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain(
      'compose around whatever the direction above leads with',
    );
  });

  it('joins a placeholder description the same way every other kind does', async () => {
    // This was briefly labelled as binding direction ("…which you must follow:")
    // on the theory that one sentence was being outvoted by the anchors. The
    // production documents disproved it — their briefs track their descriptions
    // closely — and the label made a wrong description harder to correct, which
    // is the failure actually visible in the data.
    const prompt = await promptFor({
      title: 'Placeholder — autumn evening',
      description: 'A cloche about to be lifted, the table laid around it.',
      kind: 'placeholder',
    });

    expect(prompt).toContain(
      'never as a dish to paint. A cloche about to be lifted, the table laid around it.',
    );
    expect(prompt).not.toContain('which you must follow');

    const recipe = await promptFor({
      title: 'Roast chicken',
      description: 'Lemon and thyme.',
      kind: 'recipe',
    });
    expect(recipe).toContain('the finished dish "Roast chicken". Lemon and thyme.');
  });

  it('glosses a placeholder’s tags into what they look like', async () => {
    // The mood is the ONLY per-picture variable these ten photographs have, and
    // the image model only ever saw the bare word. Everything saying what
    // "comfort" looks like lived in the fallback — which by construction is used
    // only when there is NO brief, i.e. never on the path that normally runs.
    const prompt = await promptFor({
      title: 'Placeholder — autumn evening',
      description: 'A cloche about to be lifted.',
      kind: 'placeholder',
      sceneBrief: 'A low lamp over a laid table, the room dark behind it.',
      tags: ['comfort', 'wet'],
    });

    expect(prompt).toContain('This picture is tagged: comfort, wet.');
    expect(prompt).toContain('lamplight rather than overhead light');
    expect(prompt).toContain('rain running down the glass');
    // Read as the evening, never as a dish, and never rendered as text.
    expect(prompt).toContain('Read the tags as the EVENING this picture is for');
    expect(prompt).toContain('never let them name a dish');
    // A placeholder has no dish, so it must not be told to read "the dish's mood".
    expect(prompt).not.toContain("hints for reading the dish's mood");
  });

  it('leaves the tags clause byte-for-byte unchanged for the other three kinds', async () => {
    // Only `placeholder` diverges. Everything else keeps the issue #148 clause.
    for (const kind of ['recipe', 'special', 'cocktail'] as const) {
      const prompt = await promptFor({
        title: 'Something',
        description: null,
        kind,
        tags: ['comfort', 'wet'],
      });
      expect(prompt).toContain(
        "This recipe is tagged: comfort, wet. Use these tags only as hints for reading the dish's mood, season and cuisine when you stage the scene — do NOT draw, write, label or otherwise show any of these words in the image.",
      );
    }
  });

  it('lists an unglossed tag without inventing a meaning for it', async () => {
    // `tags` is free-form; only the moods and weather conditions have pictures to
    // hand. An unknown tag is still a cue, so it stays listed — it just gets no
    // gloss rather than a fabricated one.
    const prompt = await promptFor({
      title: 'Placeholder — bright evening',
      description: null,
      kind: 'placeholder',
      tags: ['bright', 'something-nobody-glossed'],
    });

    expect(prompt).toContain('This picture is tagged: bright, something-nobody-glossed.');
    expect(prompt).toContain('openness and air');
    expect(prompt).not.toContain('something-nobody-glossed —');
  });

  it('keeps mood and condition on separate axes so any pair can combine', async () => {
    // Mood is mandatory, condition is optional, so every mood × condition pair
    // has to read coherently — and the mismatched ones (a bright cold January, a
    // muggy grey August) are the whole reason there are two axes. The mood
    // glosses used to assert season, weather AND hour, which put them in direct
    // conflict: `comfort`'s "weather shut outside" against `hot`'s "doors open",
    // `bright`'s "sunlit air" against `cold`'s "properly cold night".
    for (const mood of ['bright', 'comfort'] as const) {
      const gloss = (
        await promptFor({ title: 'P', description: null, kind: 'placeholder', tags: [mood] })
      ).slice(0);
      // No season, no weather, no hour anywhere in a mood gloss.
      for (const trespass of [
        'autumn',
        'winter',
        'summer',
        'daylight',
        'sunlit',
        'weather shut outside',
        'a dark',
      ]) {
        expect(
          gloss.slice(gloss.indexOf('They mean:'), gloss.indexOf('Read the tags')),
        ).not.toContain(trespass);
      }
    }
    // And the conflicting pairs now co-exist.
    const brightCold = await promptFor({
      title: 'P',
      description: null,
      kind: 'placeholder',
      tags: ['bright', 'cold'],
    });
    expect(brightCold).toContain('openness and air');
    expect(brightCold).toContain('a properly cold night');
  });

  it('reads every condition as an evening, because every placeholder is dinner', async () => {
    // `hot` ("thin bleached light") and `sunny` ("hard, clear sun… sharp
    // shadows") described noon, while the opener and the anchors both assert a
    // meal about to be eaten. `wet` had the same defect quietly ("a grey
    // afternoon").
    const prompt = await promptFor({
      title: 'P',
      description: null,
      kind: 'placeholder',
      tags: ['sunny', 'hot', 'wet'],
    });

    expect(prompt).toContain('late, low sun coming in almost level');
    expect(prompt).toContain('cooling into the evening');
    expect(prompt).toContain('a wet, darkening evening');
    for (const noon of ['thin bleached light', 'hard, clear sun', 'a grey afternoon']) {
      expect(prompt).not.toContain(noon);
    }
  });

  it('does not contradict itself on "hero shot", and does not collide with the `cold` tag', () => {
    // The block prohibits a hero shot of food and then used to close with "A
    // single, inviting hero shot of a meal about to happen" — the same phrase,
    // the opposite instruction, in the final and highest-weighted sentence.
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain('Do NOT compose this as a hero shot of food');
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain(
      'A single, inviting photograph of a meal about to happen, in which nothing can be named.',
    );
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).not.toContain('inviting hero shot');
    // "Never a cold, bare or purely decorative frame" collided with `cold`, a tag
    // whose gloss ships in the same prompt.
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).not.toContain('Never a cold');
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain('Never a bleak, bare or purely decorative');
  });

  it('names no leads in the fallback either — the same failure, one constant along', () => {
    // The fallback is byte-identical on every placeholder and branches only two
    // ways, so an enumerated menu here is exactly what it was in the anchors.
    for (const lead of [
      'a glass being poured',
      'a dish being carried to a table by a window',
      'steam rising off a bowl',
      'a cloche about to be lifted',
    ]) {
      expect(PLACEHOLDER_SCENE_FALLBACK).not.toContain(lead);
    }
    // Still usable with no brief: it drives mood, light, surface and palette…
    expect(PLACEHOLDER_SCENE_FALLBACK).toContain('Let the mood drive the setting, the surface');
    expect(PLACEHOLDER_SCENE_FALLBACK).toContain('openness and air');
    expect(PLACEHOLDER_SCENE_FALLBACK).toContain('lamplight rather than overhead light');
    // …and the illegibility rule survives the rewrite.
    expect(PLACEHOLDER_SCENE_FALLBACK).toContain('never a dish anyone could name');
  });

  it('keeps the placeholder anchors LAST on the fallback path too (no brief)', async () => {
    const prompt = await promptFor({
      title: 'Placeholder — bright evening',
      description: null,
      kind: 'placeholder',
      hint: 'a glass being poured',
    });
    expect(prompt.endsWith(PLACEHOLDER_IMAGE_STYLE_ANCHORS)).toBe(true);
  });

  it('keeps the placeholder anchor wording verbatim', () => {
    // Canary, mirroring the other three — but the first clause here is not a
    // house-style preference, it is the feature. Reword deliberately, then
    // update this test.
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain(
      'NOTHING in this photograph may be identifiable as a particular dish',
    );
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain(
      'That rule is absolute and outranks everything else here',
    );
    // The subject need not be food — and must NOT be composed as a food hero
    // shot, which is what would push the model back toward a nameable dish.
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain('The subject need not be food at all');
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain('Do NOT compose this as a hero shot of food');
    // Warm, never a cold still life — the failure mode this set exists to avoid
    // is the second-class treatment in a new coat.
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain('must always read WARM and APPETISING');
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain('no styled still life');
    // House style and prohibitions, inherited from its siblings.
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain('photorealistic photograph');
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain('shallow depth of field');
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).toContain(
      'Absolutely no text, no captions, no watermark, no logos, no branding, no hands, no people.',
    );
    // It must NOT inherit the "fill the frame with the subject" clause its three
    // siblings share — that is the clause that would paint a dish.
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).not.toContain('fill the frame with the dish');
    expect(PLACEHOLDER_IMAGE_STYLE_ANCHORS).not.toContain('always the star of the shot');
    // The fallback owns the mood-reading guess and must not smuggle anchors in.
    expect(PLACEHOLDER_SCENE_FALLBACK).not.toContain('no hands, no people');
    // …but it does have to know what the two moods mean, because they are the
    // only thing it has to read.
    expect(PLACEHOLDER_SCENE_FALLBACK).toContain('"bright"');
    expect(PLACEHOLDER_SCENE_FALLBACK).toContain('"comfort"');
  });

  // ─── The CURE arm (issue #1404) ────────────────────────────────────────────
  // A cure is not a plated dinner: falling to the 'recipe' default arm would paint
  // a coppa on rustic ceramic with a fork beside it. These assert the three things
  // the arm exists for — its own words, its own anchors, and no leakage of the
  // recipe set into a prompt that must not carry it.
  it('paints a cure with its own opener, fallback and anchors', async () => {
    const prompt = await promptFor({
      title: 'Coppa',
      description: 'Dry-cured pork collar.',
      kind: 'cure',
    });

    expect(prompt).toContain('the cured meat "Coppa"');
    expect(prompt).toContain(CURE_SCENE_FALLBACK);
    expect(prompt).toContain(CURE_IMAGE_STYLE_ANCHORS);
    // The failure the arm exists to prevent, asserted directly rather than implied
    // by the set-size test below: not one word of the dinner direction may reach it.
    expect(prompt).not.toContain(RECIPE_IMAGE_STYLE_ANCHORS);
    expect(prompt).not.toContain(RECIPE_IMAGE_DISH_READING_FALLBACK);
  });

  it("a cure's anchors say what a cure is and refuse to plate it as dinner", () => {
    // The subject clause its recipe/special/cocktail siblings share and
    // `placeholder` alone drops — here there IS a specific subject.
    expect(CURE_IMAGE_STYLE_ANCHORS).toContain('always the star of the shot');
    // The one prohibition of its own: a charcuterie board styled for a magazine,
    // and a cure served up as a plated dinner, are both pictures of something else.
    expect(CURE_IMAGE_STYLE_ANCHORS).toContain('Do NOT stage it as a restaurant would');
    expect(CURE_IMAGE_STYLE_ANCHORS).toContain('do NOT plate it as a dinner on home crockery');
    // The STAGE — hanging, cut open, sliced — is a subject decision and belongs to
    // the per-doc brief. The anchors reference it and must never name one, or every
    // cure gets the same picture appended last where no brief can overrule it.
    expect(CURE_IMAGE_STYLE_ANCHORS).toContain('the STAGE the direction above describes');
    // House style and prohibitions, inherited from its siblings.
    expect(CURE_IMAGE_STYLE_ANCHORS).toContain('photorealistic photograph');
    expect(CURE_IMAGE_STYLE_ANCHORS).toContain('shallow depth of field');
    expect(CURE_IMAGE_STYLE_ANCHORS).toContain(
      'Absolutely no text, no captions, no watermark, no logos, no branding, no hands, no people.',
    );
    // The fallback owns the per-cure reading and must not smuggle anchors in.
    expect(CURE_SCENE_FALLBACK).not.toContain('no hands, no people');
  });

  it('gives each kind its own anchors — no two share a set', () => {
    const sets = [
      RECIPE_IMAGE_STYLE_ANCHORS,
      SPECIAL_IMAGE_STYLE_ANCHORS,
      COCKTAIL_IMAGE_STYLE_ANCHORS,
      PLACEHOLDER_IMAGE_STYLE_ANCHORS,
      CURE_IMAGE_STYLE_ANCHORS,
    ];
    expect(new Set(sets).size).toBe(GENERATE_RECIPE_IMAGE_KINDS.length);
  });
});
