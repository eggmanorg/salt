import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AI_FLOW_ROLES } from '@salt/domain/schemas';

// describeRecipeScene: the cheap text step that reads the WHOLE recipe and writes
// the art-direction brief the hero prompt is built from. Mirrors the
// identifyRecipeKit flow tests' mocking seam — the input shape differs
// (`steps: string[]` here vs. `{ id, text }[]` plus `equipmentContext` there).

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

// Bypass the real timer, but keep everything else the module exports (the
// shared budget constant, the stream guard) — a factory that lists only
// `withAiTimeout` goes stale the moment the module grows.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));

const mockResolveModel = vi.fn(async () => 'gemini-flash-latest');
vi.mock('../../src/ai/resolveModel.js', () => ({ resolveModel: mockResolveModel }));

const { describeRecipeSceneFlow } = await import('../../src/flows/describeRecipeScene.js');

const RECIPE = {
  title: 'Melanzane alla parmigiana',
  description: 'A baked aubergine dish.',
  ingredients: ['2 aubergines, sliced', 'a handful of basil', '125g mozzarella'],
  steps: ['Layer the aubergine with sauce.', 'Grill until the top is blistered and golden.'],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveModel.mockResolvedValue('gemini-flash-latest');
});

describe('describeRecipeScene flow', () => {
  it('returns the brief the model wrote', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'A blistered, golden-topped bake.' } });

    const result = await (describeRecipeSceneFlow as Function)(RECIPE);

    expect(result).toEqual({ brief: 'A blistered, golden-topped bake.' });
  });

  it('trims the brief', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: '  A blistered bake.\n' } });
    const result = await (describeRecipeSceneFlow as Function)(RECIPE);
    expect(result).toEqual({ brief: 'A blistered bake.' });
  });

  it('feeds the model the WHOLE recipe — every ingredient and every step', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeRecipeSceneFlow as Function)(RECIPE);

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('Melanzane alla parmigiana');
    expect(prompt).toContain('A baked aubergine dish.');
    // The point of the whole flow: details that exist ONLY in the ingredients or
    // the method reach the model.
    expect(prompt).toContain('a handful of basil');
    expect(prompt).toContain('Grill until the top is blistered and golden.');
  });

  it('omits the description, ingredient and method blocks when empty', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeRecipeSceneFlow as Function)({
      title: 'Toast',
      description: null,
      ingredients: [],
      steps: [],
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toBe('Title: Toast');
  });

  it('asks for the dish-specific half only, never the house style or prohibitions', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeRecipeSceneFlow as Function)(RECIPE);

    const system = mockGenerate.mock.calls[0]![0].system as string;
    // It directs the dish…
    expect(system).toContain('plated');
    expect(system).toContain('garnish');
    expect(system).toContain('mood, season and cuisine');
    // …and explicitly stays off the anchors' territory. A brief that authored
    // lighting or prohibitions would be a per-recipe vote on the house style.
    expect(system).toContain('Do NOT write about photographic style, lighting');
    // And it is a paragraph, not an essay.
    expect(system).toContain('ONE paragraph');
  });

  it('resolves the fast model with its own flow id (per-flow overrides work)', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });
    await (describeRecipeSceneFlow as Function)(RECIPE);
    expect(mockResolveModel).toHaveBeenCalledWith('describeRecipeScene');
    expect(AI_FLOW_ROLES.describeRecipeScene).toBe('fast');
  });

  it('throws when the model returns an invalid output (AI output is a trust boundary)', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 42 } });

    await expect((describeRecipeSceneFlow as Function)(RECIPE)).rejects.toThrow(/invalid output/);
  });

  it('throws when the model returns nothing', async () => {
    mockGenerate.mockResolvedValue({ output: null });

    await expect((describeRecipeSceneFlow as Function)(RECIPE)).rejects.toThrow(/invalid output/);
  });
});

// ─── Revision mode (issue #522, Phase 3) ──────────────────────────────────────
// "make it summery" applied to a brief that already exists. Two shapes, one flow:
// currentBrief + hint revises; neither authors from scratch (which is what "start
// over" sends).
describe('describeRecipeScene flow — revision mode', () => {
  const CURRENT_BRIEF = 'An autumnal bake on dark wood, low amber light, deep shadows.';

  it('revises: the model gets the recipe AND the current brief AND the hint', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'A summery bake.' } });

    const result = await (describeRecipeSceneFlow as Function)({
      ...RECIPE,
      currentBrief: CURRENT_BRIEF,
      hint: 'make it summery',
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain(CURRENT_BRIEF);
    expect(prompt).toContain('make it summery');
    // The RECIPE still goes in. Revising a paragraph without knowing which dish it
    // describes drifts away from the food — the exact failure this feature fixes.
    expect(prompt).toContain('Melanzane alla parmigiana');
    expect(prompt).toContain('a handful of basil');
    expect(prompt).toContain('Grill until the top is blistered and golden.');
    expect(result).toEqual({ brief: 'A summery bake.' });
  });

  it('revises with the revision system prompt: fold the steer through, never staple it on', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeRecipeSceneFlow as Function)({
      ...RECIPE,
      currentBrief: CURRENT_BRIEF,
      hint: 'make it summery',
    });

    const system = mockGenerate.mock.calls[0]![0].system as string;
    expect(system).toContain('Fold the change THROUGH the whole brief');
    expect(system).toContain('one coherent brief');
    // Still the dish-specific half ONLY — the anchors stay locked in code, and a
    // user steer must not become a per-recipe vote on the house style.
    expect(system).toContain('Do NOT write about photographic style');
    expect(system).toContain('ONE paragraph');
  });

  it('"start over" sends neither brief nor hint → authors from scratch', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'A fresh reading.' } });

    // Exactly what startOverRecipeSceneBrief sends: the recipe, nothing else.
    await (describeRecipeSceneFlow as Function)(RECIPE);

    const call = mockGenerate.mock.calls[0]![0];
    // The authoring system prompt, not the revising one.
    expect(call.system).toContain('You are given one recipe — its title');
    expect(call.system).not.toContain('Fold the change THROUGH');
    expect(call.prompt).not.toContain('Current brief:');
    expect(call.prompt).not.toContain('Requested change:');
  });

  it('authors from scratch when only one half of a revision is present', async () => {
    // A steer with no brief has nothing to revise, and a brief with no steer has
    // nothing to fold through it — neither is a revision, so both author afresh.
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeRecipeSceneFlow as Function)({ ...RECIPE, hint: 'make it summery' });
    expect(mockGenerate.mock.calls[0]![0].system).not.toContain('Fold the change THROUGH');
    expect(mockGenerate.mock.calls[0]![0].prompt).not.toContain('Requested change:');

    vi.clearAllMocks();
    mockResolveModel.mockResolvedValue('gemini-flash-latest');
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeRecipeSceneFlow as Function)({ ...RECIPE, currentBrief: CURRENT_BRIEF });
    expect(mockGenerate.mock.calls[0]![0].system).not.toContain('Fold the change THROUGH');
    expect(mockGenerate.mock.calls[0]![0].prompt).not.toContain('Current brief:');
  });
});

// ─── Specials (issues #637, #671) ──────────────────────────────────────────────
// A special — a night off from cooking — has no method and no ingredients, so the
// recipe prompt's premise ("read the whole recipe, especially the METHOD") is one
// it cannot satisfy. Asked that question it invents a plated, cooked dish: exactly
// the picture a special is not. `kind` selects a prompt that asks what the food
// looks like when it really turns up instead.
//
// #671: "when it really turns up" is FOUR pictures, not one. This prompt used to
// say "a takeaway, a picnic, a chippy tea, a street-food stop or a meal out" and
// hand over a vessel list starting "the foil tray", so every brief it wrote came
// back describing takeaway packaging — including for a meal out, a butcher's pie
// and a sandwich, none of which have any. It now makes deciding WHICH of the four
// the model's first job, and names no vessel for it to default to.
describe('describeRecipeScene flow — specials', () => {
  const SPECIAL = {
    title: 'Friday night curry',
    description: 'From the place on the corner. Always the same order.',
    ingredients: [],
    steps: [],
  };

  const SHARED_SCOPE_RULE =
    'Do NOT write about photographic style, lighting, lens, framing, camera angle, or what must not appear in the shot — those are fixed elsewhere and anything you say about them is discarded.';

  async function systemFor(input: Record<string, unknown>): Promise<string> {
    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });
    await (describeRecipeSceneFlow as Function)(input);
    return mockGenerate.mock.calls[0]![0].system as string;
  }

  it('asks what the food looks like when it TURNS UP, not how it is cooked and plated', async () => {
    const system = await systemFor({ ...SPECIAL, kind: 'special' });

    expect(system).toContain("CHEF'S SPECIAL");
    expect(system).toContain('how it is served and what it is served in or on');
    expect(system).toContain('mood, occasion and cuisine');
    // The recipe premise — a method and an ingredient list to read — is absent, and
    // is explicitly ruled out rather than merely omitted.
    expect(system).not.toContain('especially the METHOD and the INGREDIENTS');
    expect(system).toContain('do not invent a method or an ingredient list');
    expect(system).toContain('ONE paragraph');
  });

  // Issue #671. Deciding which kind of chef's special this is comes FIRST, because
  // the vessel, the setting and the light are all downstream of it — and most of
  // them have no packaging at all.
  //
  // Issue #1322 added the fifth branch, and it is the one this prompt used to rule
  // out: a dish the household cooks so often it was never written down. Three of
  // the eight live entries are that, so the branch is asserted here rather than
  // left to the prose — without it, pressing regenerate on Roast Chicken is a coin
  // flip between a Sunday roast and a takeaway carton.
  it("makes the model choose which kind of chef's special it is, and names no default vessel", async () => {
    const system = await systemFor({ ...SPECIAL, kind: 'special' });

    expect(system).toContain('Your FIRST job');
    expect(system).toContain('Do NOT assume a takeaway');
    for (const branch of [
      'handed over',
      'eaten OUT',
      'bought ready to eat',
      'no real cooking',
      'cooks so often it was never written down',
    ]) {
      expect(system).toContain(branch);
    }
    // The old vessel list — whose first noun every brief then reached for.
    expect(system).not.toContain('the foil tray, the carton, the pizza box');
  });

  // Issue #1322, and the whole of the art-direction defect this rename carried.
  // The prohibition on a cooked-from-scratch plated dish is RIGHT for a takeaway
  // and WRONG for a Sunday roast, so it survives only in its conditional form. An
  // unconditional "do not turn it into a dish cooked from scratch" going back in
  // is exactly the regression this asserts against.
  it('lets a dish the household cooks by heart actually be cooked', async () => {
    const system = await systemFor({ ...SPECIAL, kind: 'special' });

    expect(system).toContain('Unless you decided this is a dish the household cooks by heart');
    expect(system).not.toContain('Nobody cooked a recipe here');
    // Cooked at home is not cooked in a restaurant: the plating carve-out is
    // bounded, not an invitation to a chef's composition.
    expect(system).toContain("never a restaurant's plating");
  });

  it('revises a special brief with the special revision prompt', async () => {
    const system = await systemFor({
      ...SPECIAL,
      kind: 'special',
      currentBrief: 'Foil trays on a coffee table under warm lamplight.',
      hint: 'make it a picnic',
    });

    expect(system).toContain('Fold the change THROUGH the whole brief');
    expect(system).toContain("CHEF'S SPECIAL");
    // #1322: the revising prompt carries the same fifth flavour and the same
    // conditional prohibition as the authoring one, or a steer could quietly
    // un-cook a roast the author correctly cooked.
    expect(system).toContain('cooks so often it was never written down');
    expect(system).toContain('Unless this is a dish the household cooks by heart');
    // The recipe revision prompt must not be the one that ran.
    expect(system).not.toContain('The finished dish');
  });

  // Issue #671. "Keep everything the requested change does not touch" is correct and
  // load-bearing, but it is also why a foil tray survived every attempt to steer an
  // special away from being a takeaway: the packaging counted as untouched. Packaging
  // is a consequence of the occasion, so it has to move when the occasion does.
  it('moves the packaging when the occasion moves', async () => {
    const system = await systemFor({
      ...SPECIAL,
      kind: 'special',
      currentBrief: 'Foil trays on a coffee table under warm lamplight.',
      hint: 'actually we went out for this one',
    });

    expect(system).toContain('NEVER independent of the occasion');
    expect(system).toContain(
      'Do not leave a takeaway container in a brief that is no longer a takeaway',
    );
  });

  it('inherits the shared scope rule verbatim on both special variants', async () => {
    // The subject half ONLY. This matters more for a special than for a recipe:
    // with no method for the model to read, a hand-edited brief is the primary path,
    // so the brief is user text far more often — and a paraphrased scope rule is a
    // per-kind loophole in the locked anchors.
    const authoring = await systemFor({ ...SPECIAL, kind: 'special' });
    const revising = await systemFor({
      ...SPECIAL,
      kind: 'special',
      currentBrief: 'Foil trays on a coffee table.',
      hint: 'make it a picnic',
    });
    const recipeAuthoring = await systemFor(RECIPE);

    for (const system of [authoring, revising, recipeAuthoring]) {
      expect(system).toContain(SHARED_SCOPE_RULE);
    }
  });

  it('leaves the recipe prompt untouched for an absent or "recipe" kind', async () => {
    const absent = await systemFor(RECIPE);
    const explicit = await systemFor({ ...RECIPE, kind: 'recipe' });

    expect(absent).toContain('especially the METHOD and the INGREDIENTS');
    expect(explicit).toBe(absent);
    expect(absent).not.toContain('NIGHT OFF FROM COOKING');
  });
});

// ─── Cocktails (issue #637, Phase 5) ─────────────────────────────────────────
// A cocktail sits on the far side of the special from a recipe. The special had to
// LOSE the "read the method" premise; a cocktail keeps it in full — 50ml gin, 25ml
// Campari, stir, strain, orange twist is an ingredient list and a method, and it is
// where every visual fact about the drink lives. What changes is the SUBJECT: there
// is no plating up a Negroni, so asked the recipe question the model reaches for
// crockery.
describe('describeRecipeScene flow — cocktails', () => {
  const COCKTAIL = {
    title: 'Negroni',
    description: 'Equal parts, stirred, big cube.',
    ingredients: ['25ml gin', '25ml Campari', '25ml sweet vermouth', 'an orange twist'],
    steps: [
      'Stir over ice until well chilled.',
      'Strain over a big cube.',
      'Twist orange over it.',
    ],
  };

  const SHARED_SCOPE_RULE =
    'Do NOT write about photographic style, lighting, lens, framing, camera angle, or what must not appear in the shot — those are fixed elsewhere and anything you say about them is discarded.';

  async function systemFor(input: Record<string, unknown>): Promise<string> {
    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });
    await (describeRecipeSceneFlow as Function)(input);
    return mockGenerate.mock.calls[0]![0].system as string;
  }

  it('asks what is in the GLASS, and still asks the model to read the method', async () => {
    const system = await systemFor({ ...COCKTAIL, kind: 'cocktail' });

    // Unlike a special, the method premise SURVIVES — it is the only thing that
    // knows the colour, the clarity and the serve.
    expect(system).toContain('especially the METHOD and the INGREDIENTS');
    expect(system).toContain('glassware the serve implies');
    expect(system).toContain('garnish');
    // The technique is a visual fact, not a procedural one.
    expect(system).toContain('stirred is silky and crystal clear');
    // But the plated-dish framing is gone: there is no plating up a Negroni.
    expect(system).not.toContain('You are given one recipe — its title');
    expect(system).not.toContain('cooked and plated');
    expect(system).toContain('ONE paragraph');
  });

  it('revises a cocktail brief with the cocktail revision prompt', async () => {
    const system = await systemFor({
      ...COCKTAIL,
      kind: 'cocktail',
      currentBrief: 'A deep red Negroni on dark wood under low amber light.',
      hint: 'make it a summer afternoon',
    });

    expect(system).toContain('Fold the change THROUGH the whole brief');
    expect(system).toContain('what is in the glass');
    // A steer re-directs the SHOT; it must never quietly re-pour the drink.
    expect(system).toContain('must not turn it into a drink this recipe does not make');
    // Neither of the other two revision prompts is the one that ran.
    expect(system).not.toContain('The finished dish');
    expect(system).not.toContain('NIGHT OFF FROM COOKING');
  });

  it('inherits the shared scope rule verbatim on both cocktail variants', async () => {
    const authoring = await systemFor({ ...COCKTAIL, kind: 'cocktail' });
    const revising = await systemFor({
      ...COCKTAIL,
      kind: 'cocktail',
      currentBrief: 'A deep red Negroni on dark wood.',
      hint: 'make it a summer afternoon',
    });

    for (const system of [authoring, revising]) {
      expect(system).toContain(SHARED_SCOPE_RULE);
    }
  });

  it('does not paint a cocktail with the recipe or special prompt', async () => {
    const cocktail = await systemFor({ ...COCKTAIL, kind: 'cocktail' });
    const recipe = await systemFor(RECIPE);
    const special = await systemFor({ ...COCKTAIL, kind: 'special' });

    expect(cocktail).not.toBe(recipe);
    expect(cocktail).not.toBe(special);
  });
});

// ─── Meals (issues #838, #1452) ──────────────────────────────────────────────
// A meal is a recipe pointing at other recipes, and the art director never heard
// about them: a Sunday roast that is nothing but chicken + potatoes + gravy has no
// ingredients and no method of its own, so the ENTIRE input was a title and the
// model painted whatever it guesses a roast looks like. The dishes are the picture.
//
// Two things are pinned here and they are separable on purpose. The DISHES reach
// the user prompt for any kind, because that block is built from the input alone.
// The CLAUSE that tells the model what to do with them is per-kind, and there are
// two of them because `takesComponents` is true for two kinds that mean opposite
// things by it: a recipe's dishes are served ALONGSIDE it (dished up together), a
// cocktail's are parts it is MADE FROM (already in the glass, so a second glass
// beside it would be exactly wrong).
//
// #1452 INVERTED the recipe clause: one plate is the default and the table spread
// is the exception, the other way round from #838. The wording is the whole fix,
// so these assertions are load-bearing rather than incidental — they are the only
// mechanism there is for "the brief says one plate" and "the table is still
// reachable" short of running the model.
describe('describeRecipeScene flow — meals', () => {
  const MEAL = {
    title: 'Sunday roast',
    description: null,
    ingredients: [],
    steps: [],
    components: [
      'Roast chicken — Lemon and thyme, skin crisp and burnished.',
      'Roast potatoes',
      'Onion gravy — Dark, glossy, made from the roasting juices.',
    ],
  };

  const COCKTAIL_WITH_PARTS = {
    title: 'House negroni',
    description: 'Equal parts, stirred, big cube.',
    ingredients: ['25ml gin', '25ml Campari', '25ml house vermouth'],
    steps: ['Stir over ice.', 'Strain over a big cube.'],
    components: ['House vermouth — Steeped with wormwood and orange peel, deep amber.'],
  };

  const MEAL_RULE_MARKER = 'This recipe is a MEAL.';
  const COCKTAIL_RULE_MARKER = 'MADE FROM';
  // The default direction and the exception, quoted from MEAL_SCENE_RULE. Both are
  // asserted positively where the rule fires and negatively where it must not, so
  // the negative cases keep testing something after #1452 changed the wording.
  const ONE_PLATE_MARKER = 'dished up on ONE PLATE';
  const TABLE_EXCEPTION_MARKER = 'Set the dishes out separately across the table ONLY where';

  async function callFlow(input: Record<string, unknown>): Promise<{
    system: string;
    prompt: string;
  }> {
    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });
    await (describeRecipeSceneFlow as Function)(input);
    const call = mockGenerate.mock.calls[0]![0];
    return { system: call.system as string, prompt: call.prompt as string };
  }

  it('lists the dishes in the user prompt, between the tags and the ingredients', async () => {
    const { prompt } = await callFlow({
      ...MEAL,
      kind: 'recipe',
      tags: ['comfort'],
      ingredients: ['a jug of gravy from the juices'],
    });

    expect(prompt).toContain(
      'Dishes in this meal:\n' +
        '- Roast chicken — Lemon and thyme, skin crisp and burnished.\n' +
        '- Roast potatoes\n' +
        '- Onion gravy — Dark, glossy, made from the roasting juices.',
    );
    // Position is the argument, not decoration: for a bundle-only meal the dishes
    // ARE the food, so they sit above the meal's own ingredients — which are the
    // coordination (a gravy, a timing plan), not what is on the table.
    expect(prompt.indexOf('Tags:')).toBeLessThan(prompt.indexOf('Dishes in this meal:'));
    expect(prompt.indexOf('Dishes in this meal:')).toBeLessThan(prompt.indexOf('Ingredients:'));
  });

  it('plates a recipe-kind meal onto ONE PLATE by default', async () => {
    const { system } = await callFlow({ ...MEAL, kind: 'recipe' });

    expect(system).toContain(MEAL_RULE_MARKER);
    expect(system).toContain(ONE_PLATE_MARKER);
    // The inversion, stated as the absence it has to be: #838's direction is gone,
    // not merely demoted. A rule that still said "photograph the WHOLE TABLE"
    // anywhere would leave the model two defaults to pick between.
    expect(system).not.toContain('WHOLE TABLE');
    expect(system).not.toContain('not a single plated portion');
    // The meal's own lines are the dinner's coordination, never any one dish's —
    // reading them as a dish is how a gravy becomes the subject of the picture.
    expect(system).toContain('belong to the DINNER as a whole');
    // Appended to the recipe prompt, not a replacement for it.
    expect(system).toContain('especially the METHOD and the INGREDIENTS');
    expect(system).not.toContain(COCKTAIL_RULE_MARKER);
  });

  it('leaves the table reachable, as the exception and not the default', async () => {
    // #1452 inverted the direction rather than deleting it: a curry night, tapas
    // or a buffet genuinely is not one plated serving, and the art director must
    // still be able to choose the spread from the dishes themselves. Nothing but
    // this string carries that, so nothing but this assertion can pin it.
    const { system } = await callFlow({ ...MEAL, kind: 'recipe' });

    expect(system).toContain(TABLE_EXCEPTION_MARKER);
    expect(system).toContain('never the default');
    // Ordering is the direction: the plate is stated before the exception that
    // qualifies it, so the exception reads as a carve-out and not as a second rule.
    expect(system.indexOf(ONE_PLATE_MARKER)).toBeLessThan(system.indexOf(TABLE_EXCEPTION_MARKER));
  });

  it('says NOTHING about meals for a recipe with no dishes attached', async () => {
    // The back-compat property the whole change rests on: every recipe that is not
    // a meal — which is nearly all of them — sends byte-for-byte the prompt it sent
    // before, in both halves.
    const { system, prompt } = await callFlow(RECIPE);

    expect(prompt).not.toContain('Dishes in this meal');
    expect(system).not.toContain(MEAL_RULE_MARKER);
    expect(system).not.toContain(ONE_PLATE_MARKER);
    expect(system).not.toContain(TABLE_EXCEPTION_MARKER);
    expect(system).not.toContain(COCKTAIL_RULE_MARKER);
    // And it is the SAME system prompt an empty components array produces, so
    // "absent" and "empty" are not two different behaviours.
    const explicitlyEmpty = await callFlow({ ...RECIPE, components: [] });
    expect(explicitlyEmpty.system).toBe(system);
  });

  it('keeps a cocktail in one glass — its components are parts, not a second drink', async () => {
    const { system } = await callFlow({ ...COCKTAIL_WITH_PARTS, kind: 'cocktail' });

    expect(system).toContain(COCKTAIL_RULE_MARKER);
    expect(system).toContain('already IN the glass');
    // The rule a shared clause could not have carried: the meal rule plates its
    // components together and may set them out across a table, which for a Negroni
    // made with a house vermouth means the bottle next to the drink either way.
    expect(system).not.toContain(MEAL_RULE_MARKER);
    expect(system).not.toContain(ONE_PLATE_MARKER);
    expect(system).not.toContain(TABLE_EXCEPTION_MARKER);
    // Still the cocktail prompt underneath.
    expect(system).toContain('glassware the serve implies');
  });

  it('leaves a special and a placeholder untouched even when handed dishes', async () => {
    // Neither kind can HAVE components (`takesComponents` is false for both), so
    // this is a belt to that braces: the arms ignore the flag rather than trusting
    // no caller ever passes one. A special has no table to widen to and a
    // placeholder must never be given a dish at all.
    for (const kind of ['special', 'placeholder']) {
      const withDishes = await callFlow({ ...MEAL, kind, components: MEAL.components });
      const without = await callFlow({ ...MEAL, kind, components: [] });

      expect(withDishes.system).toBe(without.system);
      expect(withDishes.system).not.toContain(MEAL_RULE_MARKER);
      expect(withDishes.system).not.toContain(COCKTAIL_RULE_MARKER);
    }
  });

  it('carries the meal rule through a revision too', async () => {
    // "make it summery" on a roast must still be revising a picture of ONE PLATE,
    // with the table still available to it. The rule hangs off whether dishes are
    // present, not off which mode is running, so a brief hand-edited into a spread
    // cannot quietly become the new default on the next revision.
    const { system, prompt } = await callFlow({
      ...MEAL,
      kind: 'recipe',
      currentBrief: 'Each dish in its own bowl, set out across dark wood.',
      hint: 'make it summery',
    });

    expect(system).toContain('Fold the change THROUGH the whole brief');
    expect(system).toContain(MEAL_RULE_MARKER);
    expect(system).toContain(ONE_PLATE_MARKER);
    expect(system).toContain(TABLE_EXCEPTION_MARKER);
    expect(system).not.toContain('WHOLE TABLE');
    expect(prompt).toContain('Dishes in this meal:');
  });
});

// ─── Placeholders (issue #652) ───────────────────────────────────────────────
// A special lost the "read the method" premise but kept a SUBJECT — a curry, a
// chippy tea, something the model can picture. A placeholder has neither: it
// stands in for dinner on an evening someone planned in a sentence, and it is
// attached to many different evenings, so naming a dish is the one thing it must
// never do. All that is left to read is the MOOD the entry is tagged with.
describe('describeRecipeScene flow — placeholders', () => {
  const PLACEHOLDER = {
    title: 'Placeholder — autumn evening',
    description: 'Lamplight, steam, the weather shut outside.',
    ingredients: [],
    steps: [],
  };

  const SHARED_SCOPE_RULE =
    'Do NOT write about photographic style, lighting, lens, framing, camera angle, or what must not appear in the shot — those are fixed elsewhere and anything you say about them is discarded.';

  async function systemFor(input: Record<string, unknown>): Promise<string> {
    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });
    await (describeRecipeSceneFlow as Function)(input);
    return mockGenerate.mock.calls[0]![0].system as string;
  }

  it('asks for a MOOD, and forbids inventing a dish to hang it on', async () => {
    const system = await systemFor({ ...PLACEHOLDER, kind: 'placeholder' });

    expect(system).toContain('There is no dish here, and there must not be one');
    expect(system).toContain('Do not invent a meal');
    expect(system).toContain('"bright"');
    expect(system).toContain('"comfort"');
    // The subject need not be food — the lead may be a glass, a cloche, steam.
    expect(system).toContain('what LEADS the picture');
    expect(system).toContain('it need not be food');
    // Neither recipe premise survives: there is no method and no arrival.
    expect(system).not.toContain('especially the METHOD and the INGREDIENTS');
    expect(system).not.toContain('NIGHT OFF FROM COOKING');
    expect(system).toContain('ONE paragraph');
  });

  it('is actually GIVEN the mood it is told to read', async () => {
    // The prompt has always said "what you read instead is the MOOD, which the
    // tags carry" — and the input schema had no `tags` field, so nothing ever
    // carried them. For a placeholder that left title + description as the whole
    // input to a step whose stated job is to read a mood.
    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });
    await (describeRecipeSceneFlow as Function)({
      ...PLACEHOLDER,
      kind: 'placeholder',
      tags: ['comfort', 'wet'],
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain('Tags: comfort, wet');
  });

  it('teaches the SAME tag vocabulary the image prompt uses, on both variants', async () => {
    // These two prompts were written separately and drifted: this one described
    // `bright` as "cool daylight, pale crockery, a sunlit table" long after the
    // generator stopped saying anything of the kind, and it defined none of the
    // five conditions at all while the flow fed them to it on a `Tags:` line.
    // The words now live in one module and both prompts interpolate it.
    const { PLACEHOLDER_TAG_VOCABULARY, PLACEHOLDER_TAG_MEANINGS } =
      await import('../../src/flows/placeholderVocabulary.js');

    const authoring = await systemFor({ ...PLACEHOLDER, kind: 'placeholder' });
    const revising = await systemFor({
      ...PLACEHOLDER,
      kind: 'placeholder',
      currentBrief: 'A low lamp over a laid table.',
      hint: 'make it a winter evening',
    });

    for (const system of [authoring, revising]) {
      expect(system).toContain(PLACEHOLDER_TAG_VOCABULARY);
      // Every tag it can be handed is defined — the five conditions included.
      for (const tag of ['bright', 'comfort', 'wet', 'sunny', 'cloudy', 'hot', 'cold']) {
        expect(system).toContain(`"${tag}" is `);
      }
      // And the season-laden mood language is gone from both.
      expect(system).not.toContain('cool daylight');
      expect(system).not.toContain('a dark evening indoors');
    }
    // Same word collision the anchors had: `cold` is a tag whose gloss ships in
    // this very prompt, so the prohibition must not spend the word on "bleak".
    expect(authoring).not.toContain('never a cold, empty table');
    expect(authoring).toContain('never a bleak, empty table');

    // The gloss the image model sees is built from the same source, so the two
    // cannot say different things about the same word.
    expect(PLACEHOLDER_TAG_MEANINGS.comfort).toContain('lamplight rather than overhead light');
    expect(authoring).toContain('lamplight rather than overhead light');
  });

  it('takes the lead from the description instead of offering a menu of four', async () => {
    // With no method and no ingredients to read, an enumerated list of leads was
    // the most concrete thing in front of the model — so it chose from the list
    // and the per-doc description that should have decided the shot was averaged
    // into it. Ten placeholders, four ideas.
    const system = await systemFor({ ...PLACEHOLDER, kind: 'placeholder' });

    expect(system).toContain('the description says what this one leads with');
    expect(system).toContain('take it as given');
    for (const lead of [
      'a glass of wine mid-pour',
      'a cloche waiting to be lifted',
      'steam rising off a bowl',
      'a serving dish so close and so soft',
    ]) {
      expect(system).not.toContain(lead);
    }
  });

  it('refuses the dish even when the requested change asks for one', async () => {
    // The guard the other three revision prompts do not need. Editing the brief
    // is how these ten pictures get good, so "make it a roast dinner" is a
    // plausible thing to type — and it is the one steer this must not fold in.
    const system = await systemFor({
      ...PLACEHOLDER,
      kind: 'placeholder',
      currentBrief: 'Steam off a bowl under a low lamp.',
      hint: 'make it a roast dinner',
    });

    expect(system).toContain('Fold the change THROUGH the whole brief');
    expect(system).toContain('There is still no dish, whatever the change asks for');
    expect(system).toContain('never the dish itself');
    // None of the other three revision prompts is the one that ran.
    expect(system).not.toContain('The finished dish');
    expect(system).not.toContain('NIGHT OFF FROM COOKING');
    expect(system).not.toContain('what is in the glass');
  });

  it('inherits the shared scope rule verbatim on both placeholder variants', async () => {
    const authoring = await systemFor({ ...PLACEHOLDER, kind: 'placeholder' });
    const revising = await systemFor({
      ...PLACEHOLDER,
      kind: 'placeholder',
      currentBrief: 'Steam off a bowl under a low lamp.',
      hint: 'make it a winter evening',
    });

    for (const system of [authoring, revising]) {
      expect(system).toContain(SHARED_SCOPE_RULE);
    }
  });

  it('does not paint a placeholder with any of the other three prompts', async () => {
    const placeholder = await systemFor({ ...PLACEHOLDER, kind: 'placeholder' });
    const recipe = await systemFor(RECIPE);
    const special = await systemFor({ ...PLACEHOLDER, kind: 'special' });
    const cocktail = await systemFor({ ...PLACEHOLDER, kind: 'cocktail' });

    expect(placeholder).not.toBe(recipe);
    expect(placeholder).not.toBe(special);
    expect(placeholder).not.toBe(cocktail);
  });
});
