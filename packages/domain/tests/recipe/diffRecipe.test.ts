import { describe, it, expect } from 'vitest';
import { diffRecipe, emptyRecipe, newIngredient, newStep } from '@salt/domain';
import type { Recipe, Ingredient, Step } from '@salt/domain';
import type { RecipeDiff } from '@salt/domain';

const ISO = '2026-01-01T00:00:00.000Z';

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return { ...emptyRecipe('r-1', ISO), ...overrides };
}

// Put a flat list of ingredients into a single unnamed group.
function withIngredients(base: Recipe, items: Ingredient[]): Recipe {
  return { ...base, ingredients: [{ id: 'g-1', name: null, items }] };
}

function withSteps(base: Recipe, steps: Step[]): Recipe {
  return { ...base, steps };
}

function withMetadata(base: Recipe, metadata: Partial<Recipe['metadata']>): Recipe {
  return { ...base, metadata: { ...base.metadata, ...metadata } };
}

describe('diffRecipe', () => {
  it('reports no changes for an identical recipe (no-op)', () => {
    const r = withSteps(
      withIngredients(recipe({ title: 'Soup', description: 'Warm', notes: 'Family fave' }), [
        newIngredient('i-1', '200g carrots'),
      ]),
      [newStep('s-1', 'Chop the carrots')],
    );
    const diff = diffRecipe(r, structuredClone(r));
    expect(diff.hasChanges).toBe(false);
    expect(diff.title).toBeUndefined();
    expect(diff.description).toBeUndefined();
    expect(diff.notes).toBeUndefined();
    expect(diff.ingredients).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.steps).toEqual({ added: [], removed: [], changed: [] });
    expect(diff.metadata).toEqual({});
    expect(diff.tags).toEqual({ added: [], removed: [] });
  });

  it('detects a title rename', () => {
    const before = recipe({ title: 'Tomato Soup' });
    const after = recipe({ title: 'Roasted Tomato Soup' });
    const diff = diffRecipe(before, after);
    expect(diff.hasChanges).toBe(true);
    expect(diff.title).toEqual({ from: 'Tomato Soup', to: 'Roasted Tomato Soup' });
  });

  it('detects a description change including null → string and back', () => {
    expect(
      diffRecipe(recipe({ description: null }), recipe({ description: 'New' })).description,
    ).toEqual({ from: null, to: 'New' });
    expect(
      diffRecipe(recipe({ description: 'Old' }), recipe({ description: null })).description,
    ).toEqual({ from: 'Old', to: null });
    expect(
      diffRecipe(recipe({ description: 'Same' }), recipe({ description: 'Same' })).description,
    ).toBeUndefined();
  });

  it('detects a notes change', () => {
    const diff = diffRecipe(recipe({ notes: null }), recipe({ notes: 'Season well' }));
    expect(diff.notes).toEqual({ from: null, to: 'Season well' });
  });

  it('detects an added ingredient', () => {
    const before = withIngredients(recipe(), [newIngredient('i-1', 'double cream')]);
    const after = withIngredients(recipe(), [
      newIngredient('i-1', 'double cream'),
      newIngredient('i-2', '200g crème fraîche'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.added).toEqual([{ id: 'i-2', rawText: '200g crème fraîche' }]);
    expect(diff.ingredients.removed).toEqual([]);
    expect(diff.ingredients.changed).toEqual([]);
    expect(diff.hasChanges).toBe(true);
  });

  it('detects a removed ingredient', () => {
    const before = withIngredients(recipe(), [
      newIngredient('i-1', 'double cream'),
      newIngredient('i-2', 'butter'),
    ]);
    const after = withIngredients(recipe(), [newIngredient('i-2', 'butter')]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.removed).toEqual([{ id: 'i-1', rawText: 'double cream' }]);
    expect(diff.ingredients.added).toEqual([]);
  });

  it('detects a changed ingredient (same id reused, rawText reworded)', () => {
    const before = withIngredients(recipe(), [newIngredient('i-1', '2 cloves garlic')]);
    const after = withIngredients(recipe(), [newIngredient('i-1', '3 cloves garlic')]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([
      { id: 'i-1', from: '2 cloves garlic', to: '3 cloves garlic' },
    ]);
    expect(diff.ingredients.added).toEqual([]);
    expect(diff.ingredients.removed).toEqual([]);
  });

  it('flattens ingredients across groups for the item-level diff', () => {
    const before: Recipe = {
      ...recipe(),
      ingredients: [
        { id: 'g-1', name: 'Sauce', items: [newIngredient('i-1', 'passata')] },
        { id: 'g-2', name: 'Base', items: [newIngredient('i-2', 'flour')] },
      ],
    };
    const after: Recipe = {
      ...recipe(),
      ingredients: [
        { id: 'g-1', name: 'Sauce', items: [newIngredient('i-1', 'passata')] },
        // 'flour' moved to a differently-named group but same id + rawText → no change
        {
          id: 'g-3',
          name: 'Dough',
          items: [newIngredient('i-2', 'flour'), newIngredient('i-3', 'yeast')],
        },
      ],
    };
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.added).toEqual([{ id: 'i-3', rawText: 'yeast' }]);
    expect(diff.ingredients.removed).toEqual([]);
    expect(diff.ingredients.changed).toEqual([]);
  });

  it('distinguishes id-reuse (edit) from a genuinely new item', () => {
    // Same id, different text → an edit (changed), not remove+add.
    const editBefore = withIngredients(recipe(), [newIngredient('i-1', 'salt')]);
    const editAfter = withIngredients(recipe(), [newIngredient('i-1', 'sea salt')]);
    const editDiff = diffRecipe(editBefore, editAfter);
    expect(editDiff.ingredients.changed).toEqual([{ id: 'i-1', from: 'salt', to: 'sea salt' }]);
    expect(editDiff.ingredients.added).toEqual([]);
    expect(editDiff.ingredients.removed).toEqual([]);

    // New id, new text, and too dissimilar for the fuzzy pass (Jaccard 0) → a
    // genuinely new item (added), old one removed — never a false "changed".
    const newBefore = withIngredients(recipe(), [newIngredient('i-1', 'salt')]);
    const newAfter = withIngredients(recipe(), [newIngredient('i-2', 'pepper')]);
    const newDiff = diffRecipe(newBefore, newAfter);
    expect(newDiff.ingredients.added).toEqual([{ id: 'i-2', rawText: 'pepper' }]);
    expect(newDiff.ingredients.removed).toEqual([{ id: 'i-1', rawText: 'salt' }]);
    expect(newDiff.ingredients.changed).toEqual([]);
  });

  it('pairs a reworded ingredient AND step with fresh ids (AI-flow style) as single changes', () => {
    // The AI author flow mints a fresh crypto.randomUUID() for every step and for
    // reworded ingredients, so a genuine reword changes BOTH id and content and
    // matches on neither the id nor the exact-content pass. The fuzzy pass reunites
    // them so each reads as one `old → new` edit, not a separate add + remove.
    const before = withSteps(
      withIngredients(recipe(), [newIngredient('i-old', '120ml hot water')]),
      [newStep('s-old', 'Simmer the sauce for 10 minutes')],
    );
    const after = withSteps(withIngredients(recipe(), [newIngredient('i-new', '120ml water')]), [
      newStep('s-new', 'Simmer the sauce for 15 minutes'),
    ]);
    const diff = diffRecipe(before, after);

    expect(diff.ingredients.changed).toEqual([
      { id: 'i-new', from: '120ml hot water', to: '120ml water' },
    ]);
    expect(diff.ingredients.added).toEqual([]);
    expect(diff.ingredients.removed).toEqual([]);

    expect(diff.steps.changed).toEqual([
      {
        id: 's-new',
        position: 1,
        text: {
          from: 'Simmer the sauce for 10 minutes',
          to: 'Simmer the sauce for 15 minutes',
        },
      },
    ]);
    expect(diff.steps.added).toEqual([]);
    expect(diff.steps.removed).toEqual([]);
  });

  it('leaves a dissimilar fresh-id pair as add + remove (conservative threshold)', () => {
    // Fresh ids on both sides, but the content is too dissimilar to be "the same
    // item reworded": sharing a couple of words ("hot smoked", Jaccard 0.4) is not
    // enough. A false "changed" here would tell the reviewer paprika became salmon,
    // which is worse than an honest add + remove — so the pair is left unpaired.
    const before = withIngredients(recipe(), [newIngredient('i-old', 'hot smoked paprika')]);
    const after = withIngredients(recipe(), [newIngredient('i-new', 'hot smoked salmon fillet')]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.added).toEqual([{ id: 'i-new', rawText: 'hot smoked salmon fillet' }]);
    expect(diff.ingredients.removed).toEqual([{ id: 'i-old', rawText: 'hot smoked paprika' }]);
    expect(diff.ingredients.changed).toEqual([]);
  });

  it('treats a new id with unchanged content as no change (rawText fallback)', () => {
    // The item text is identical but its id changed — must not read as remove+add.
    const before = withIngredients(recipe(), [newIngredient('i-old', '1 onion')]);
    const after = withIngredients(recipe(), [newIngredient('i-new', '1 onion')]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.added).toEqual([]);
    expect(diff.ingredients.removed).toEqual([]);
    expect(diff.ingredients.changed).toEqual([]);
    expect(diff.hasChanges).toBe(false);
  });

  it('detects a step reword with its 1-based position', () => {
    const before = withSteps(recipe(), [
      newStep('s-1', 'Preheat oven'),
      newStep('s-2', 'Roast for 20 minutes'),
      newStep('s-3', 'Serve'),
    ]);
    const after = withSteps(recipe(), [
      newStep('s-1', 'Preheat oven'),
      newStep('s-2', 'Roast until deeply golden'),
      newStep('s-3', 'Serve'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.steps.changed).toEqual([
      {
        id: 's-2',
        position: 2,
        text: { from: 'Roast for 20 minutes', to: 'Roast until deeply golden' },
      },
    ]);
  });

  it('detects a step timer change (re-time) without a text change', () => {
    const stepBefore: Step = {
      id: 's-1',
      text: 'Rest',
      timer: { durationMinutes: 5, description: null },
      note: null,
    };
    const stepAfter: Step = {
      id: 's-1',
      text: 'Rest',
      timer: { durationMinutes: 10, description: null },
      note: null,
    };
    const diff = diffRecipe(withSteps(recipe(), [stepBefore]), withSteps(recipe(), [stepAfter]));
    expect(diff.steps.changed).toEqual([
      {
        id: 's-1',
        position: 1,
        timer: {
          from: { durationMinutes: 5, description: null },
          to: { durationMinutes: 10, description: null },
        },
      },
    ]);
    expect(diff.steps.changed[0]!.text).toBeUndefined();
  });

  it('detects an added step (e.g. a resting step) with its position', () => {
    const before = withSteps(recipe(), [newStep('s-1', 'Mix'), newStep('s-2', 'Bake')]);
    const after = withSteps(recipe(), [
      newStep('s-1', 'Mix'),
      {
        id: 's-3',
        text: 'Rest the dough',
        timer: { durationMinutes: 10, description: null },
        note: null,
      },
      newStep('s-2', 'Bake'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.steps.added).toEqual([{ id: 's-3', position: 2, text: 'Rest the dough' }]);
    expect(diff.steps.removed).toEqual([]);
    expect(diff.steps.changed).toEqual([]);
  });

  it('detects a removed step with its position in the existing recipe', () => {
    const before = withSteps(recipe(), [
      newStep('s-1', 'Mix'),
      newStep('s-2', 'Rest'),
      newStep('s-3', 'Bake'),
    ]);
    const after = withSteps(recipe(), [newStep('s-1', 'Mix'), newStep('s-3', 'Bake')]);
    const diff = diffRecipe(before, after);
    expect(diff.steps.removed).toEqual([{ id: 's-2', position: 2, text: 'Rest' }]);
    expect(diff.steps.added).toEqual([]);
  });

  it('reports a step note change', () => {
    const before = withSteps(recipe(), [{ id: 's-1', text: 'Fry', timer: null, note: null }]);
    const after = withSteps(recipe(), [
      { id: 's-1', text: 'Fry', timer: null, note: 'Use high heat' },
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.steps.changed).toEqual([
      { id: 's-1', position: 1, note: { from: null, to: 'Use high heat' } },
    ]);
  });

  it('ignores a pure step reorder with no content change', () => {
    const before = withSteps(recipe(), [newStep('s-1', 'A'), newStep('s-2', 'B')]);
    const after = withSteps(recipe(), [newStep('s-2', 'B'), newStep('s-1', 'A')]);
    const diff = diffRecipe(before, after);
    expect(diff.hasChanges).toBe(false);
    expect(diff.steps).toEqual({ added: [], removed: [], changed: [] });
  });

  it('detects a servings change', () => {
    const diff = diffRecipe(
      withMetadata(recipe(), { servings: 2 }),
      withMetadata(recipe(), { servings: 4 }),
    );
    expect(diff.metadata.servings).toEqual({ from: 2, to: 4 });
    expect(diff.hasChanges).toBe(true);
  });

  // The three time fields are NOT reported (issue #1233): nothing proposes them
  // any more, so a diff that moved one would be offering the cook a change to a
  // number no screen shows. They were restored in PR #1231 only for as long as
  // `recipeAmend.ts` went on merging them.
  it('reports no prep, cook or total change — nothing proposes them', () => {
    const before = withMetadata(recipe(), {});
    const after = withMetadata(recipe(), {});
    const diff = diffRecipe(before, after);
    expect(diff.metadata).toEqual({});
    expect(diff.hasChanges).toBe(false);
  });

  it('detects a null → number metadata change', () => {
    const diff = diffRecipe(
      withMetadata(recipe(), { servings: null }),
      withMetadata(recipe(), { servings: 6 }),
    );
    expect(diff.metadata.servings).toEqual({ from: null, to: 6 });
  });

  it('detects tag additions and removals', () => {
    const before = withMetadata(recipe(), { tags: ['dinner', 'vegetarian'] });
    const after = withMetadata(recipe(), { tags: ['dinner', 'quick'] });
    const diff = diffRecipe(before, after);
    expect(diff.tags).toEqual({ added: ['quick'], removed: ['vegetarian'] });
    expect(diff.hasChanges).toBe(true);
  });

  it('reports no tag change when the tag set is identical regardless of order', () => {
    const before = withMetadata(recipe(), { tags: ['a', 'b'] });
    const after = withMetadata(recipe(), { tags: ['b', 'a'] });
    const diff = diffRecipe(before, after);
    expect(diff.tags).toEqual({ added: [], removed: [] });
    expect(diff.hasChanges).toBe(false);
  });

  // `kind` is immutable: a special never becomes a recipe, it is deleted and
  // re-created. Nothing can change it, so the diff — which exists to narrate an
  // AI edit back to the cook — has nothing to say about it (issue #637).
  it('ignores kind: it is fixed at creation, so it is never a change to report', () => {
    const before = recipe({ title: 'Soup' });
    const diff = diffRecipe(before, { ...before, kind: 'special' });
    expect(diff.hasChanges).toBe(false);
  });

  it('produces a schema-valid RecipeDiff shape', () => {
    const before = withIngredients(recipe({ title: 'X' }), [newIngredient('i-1', 'a')]);
    const after = withIngredients(recipe({ title: 'Y' }), [newIngredient('i-1', 'b')]);
    const diff: RecipeDiff = diffRecipe(before, after);
    // structural sanity: always-present sections exist even when empty
    expect(diff.ingredients).toBeDefined();
    expect(diff.steps).toBeDefined();
    expect(diff.metadata).toBeDefined();
    expect(diff.tags).toBeDefined();
  });

  // ── Issue #1137: a reworded item must read as one edit, not remove + add ────

  it('pairs a metricated ingredient reword measured on staging (#1137)', () => {
    // Verbatim from a ⋮ → Refresh of "Vinaigrette Potato Salad with Herbs and
    // Capers" on staging. Fresh id on the draft side (the AI flow only reuses an
    // ingredient id on a byte-identical rawText), so this reaches the fuzzy pass.
    // On raw tokens it scores 0.455 and split into remove + add; the quantity,
    // unit and size words that dilute it are dropped before scoring, and the
    // draft side's identity set turns out to be a subset of the existing side's
    // (a description was dropped, not swapped), so it scores via Dice and clears
    // the 0.5 threshold comfortably.
    const before = withIngredients(recipe(), [
      newIngredient('i-old', '1 small clove of garlic, grated or minced'),
    ]);
    const after = withIngredients(recipe(), [
      newIngredient('i-new', '3 g garlic (about 1 small clove), grated'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([
      {
        id: 'i-new',
        from: '1 small clove of garlic, grated or minced',
        to: '3 g garlic (about 1 small clove), grated',
      },
    ]);
    expect(diff.ingredients.added).toEqual([]);
    expect(diff.ingredients.removed).toEqual([]);
  });

  it('pairs two lines resolved to the same canon item, whatever the wording (#1137)', () => {
    // The second staging pair. Word-set overlap CANNOT reach it — see the
    // known-limitation test below — so the pairing has to come from the exact
    // signal every amendment draft already carries: a resolved canonId. No
    // threshold is involved.
    //
    // The shared canonId is INFERRED for this pair, not proved. Checked against
    // staging: the stored line `1 small red onion or a couple of shallots`
    // resolves to canon `712bc680…` "Red Onion" (whose own synonym list records
    // that phrasing), a distinct "Banana Shallots" item exists but no recipe uses
    // it, and every "red onion, finely sliced" line across the library matches the
    // same Red Onion item. The post-refresh text is not stored anywhere on staging
    // — it was never applied — so it cannot be read back directly.
    const before = withIngredients(recipe(), [
      {
        ...newIngredient('i-old', '1 small red onion or a couple of shallots'),
        canonId: 'canon-red-onion',
        matchState: 'matched',
      },
    ]);
    const after = withIngredients(recipe(), [
      {
        ...newIngredient('i-new', '150 g red onion, finely sliced'),
        canonId: 'canon-red-onion',
        matchState: 'matched',
      },
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([
      {
        id: 'i-new',
        from: '1 small red onion or a couple of shallots',
        to: '150 g red onion, finely sliced',
      },
    ]);
    expect(diff.ingredients.added).toEqual([]);
    expect(diff.ingredients.removed).toEqual([]);
  });

  it('KNOWN LIMITATION: without a canon signal, that same pair stays add + remove (#1137)', () => {
    // Stated rather than hidden (CLAUDE.md rule 12). On normalised tokens this
    // reword scores 0.400 — IDENTICALLY to the paprika/salmon non-pair pinned
    // above, which must stay split. No threshold and no symmetric word-set metric
    // can separate the two, so a canonId-less draft leaves this pair honestly
    // unpaired rather than buying it with a false pairing elsewhere.
    const before = withIngredients(recipe(), [
      newIngredient('i-old', '1 small red onion or a couple of shallots'),
    ]);
    const after = withIngredients(recipe(), [
      newIngredient('i-new', '150 g red onion, finely sliced'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([]);
    expect(diff.ingredients.added).toEqual([
      { id: 'i-new', rawText: '150 g red onion, finely sliced' },
    ]);
    expect(diff.ingredients.removed).toEqual([
      { id: 'i-old', rawText: '1 small red onion or a couple of shallots' },
    ]);
  });

  it('leaves an AMBIGUOUS shared canon id to the fuzzy pass (#1137)', () => {
    // The canon pass fires only when the key identifies exactly one unpaired item
    // on each side. Two lines sharing a canon item within one recipe carry no
    // information about which pairs with which, so the pass declines and the
    // fuzzy scores decide — here neither clears the threshold against the other.
    const canon = { canonId: 'canon-onion', matchState: 'matched' } as const;
    const before = withIngredients(recipe(), [
      { ...newIngredient('i-a', 'spring onion tops'), ...canon },
      { ...newIngredient('i-b', 'pickled onion halves'), ...canon },
    ]);
    const after = withIngredients(recipe(), [
      { ...newIngredient('i-c', 'burnt onion powder'), ...canon },
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([]);
    expect(diff.ingredients.added).toEqual([{ id: 'i-c', rawText: 'burnt onion powder' }]);
    expect(diff.ingredients.removed).toEqual([
      { id: 'i-a', rawText: 'spring onion tops' },
      { id: 'i-b', rawText: 'pickled onion halves' },
    ]);
  });

  it('gives one existing item to only one draft item when both want it (#1137)', () => {
    // Two draft lines both score 0.75 against the single existing line, and there
    // is no second existing line to rehouse the loser onto. The global assignment
    // has to give up on one of them rather than double-pair: the first in document
    // order takes the edit, the other is an honest addition.
    const before = withIngredients(recipe(), [newIngredient('i-flour', 'plain white flour')]);
    const after = withIngredients(recipe(), [
      newIngredient('d-1', 'plain white flour, sifted'),
      newIngredient('d-2', '200g plain white flour'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([
      { id: 'd-1', from: 'plain white flour', to: 'plain white flour, sifted' },
    ]);
    expect(diff.ingredients.added).toEqual([{ id: 'd-2', rawText: '200g plain white flour' }]);
    expect(diff.ingredients.removed).toEqual([]);
  });

  it('declines an AMBIGUOUS canon id on the DRAFT side too (#1137)', () => {
    // The mirror of the case above: one existing line, two draft lines, all three
    // on the same canon item. Which of the two is "the" edit is unknowable, so the
    // canon pass declines and the fuzzy scores decide — and neither clears.
    const canon = { canonId: 'canon-tomato', matchState: 'matched' } as const;
    const before = withIngredients(recipe(), [
      { ...newIngredient('i-a', 'plum tomatoes'), ...canon },
    ]);
    const after = withIngredients(recipe(), [
      { ...newIngredient('i-b', 'cherry tomatoes'), ...canon },
      { ...newIngredient('i-c', 'sun dried tomatoes'), ...canon },
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([]);
    expect(diff.ingredients.added).toEqual([
      { id: 'i-b', rawText: 'cherry tomatoes' },
      { id: 'i-c', rawText: 'sun dried tomatoes' },
    ]);
    expect(diff.ingredients.removed).toEqual([{ id: 'i-a', rawText: 'plum tomatoes' }]);
  });

  it('scores the raw words when normalisation would empty a side (#1137)', () => {
    // "about 250 g" is nothing BUT quantity words, so dropping them leaves an
    // empty set that would score 0 against everything and make the line
    // permanently unpairable. The raw token sets are scored instead (0.667 here),
    // so normalisation cannot take away a pairing it was never asked about.
    const before = withIngredients(recipe(), [newIngredient('i-old', 'about 250 g')]);
    const after = withIngredients(recipe(), [newIngredient('i-new', '250 g')]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([{ id: 'i-new', from: 'about 250 g', to: '250 g' }]);
    expect(diff.ingredients.added).toEqual([]);
    expect(diff.ingredients.removed).toEqual([]);
  });

  it('never pairs an item with no words at all (#1137)', () => {
    // An all-punctuation line tokenises to nothing. "Clearly the same item" is not
    // a thing an empty set can be, so it scores 0 and stays an honest remove.
    const before = withIngredients(recipe(), [newIngredient('i-old', '—')]);
    const after = withIngredients(recipe(), [newIngredient('i-new', '200g plain flour')]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([]);
    expect(diff.ingredients.added).toEqual([{ id: 'i-new', rawText: '200g plain flour' }]);
    expect(diff.ingredients.removed).toEqual([{ id: 'i-old', rawText: '—' }]);
  });

  it('assigns fuzzy pairs globally, not greedily in document order (#1137)', () => {
    // The first draft item scores 0.75 against BOTH existing items, and taking
    // the one it happens to meet first strands the second draft item — which had
    // its own 0.75 partner — as an addition, and that partner as a removal. The
    // assignment maximises the number of pairs instead, so both read as edits.
    const before = withIngredients(recipe(), [
      newIngredient('i-flour', 'plain white flour'),
      newIngredient('i-sugar', 'plain white sugar'),
    ]);
    const after = withIngredients(recipe(), [
      newIngredient('d-1', 'plain white flour and sugar'),
      newIngredient('d-2', '200g plain white flour'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.added).toEqual([]);
    expect(diff.ingredients.removed).toEqual([]);
    expect(diff.ingredients.changed).toEqual([
      { id: 'd-1', from: 'plain white sugar', to: 'plain white flour and sugar' },
      { id: 'd-2', from: 'plain white flour', to: '200g plain white flour' },
    ]);
  });

  // ── PR #1177 review B1: the assignment must not discard a strictly stronger
  // pair to manufacture a weaker one ────────────────────────────────────────

  it('does not misattribute a strong pair to free up a weaker one (#1137 review B1)', () => {
    // "dark brown sugar" → "dark brown soft sugar" is a strictly stronger edge
    // (0.750) than "dark brown sugar" → "dark sugar" (0.667) or
    // "brown sugar" → "dark brown soft sugar" (0.500). A cardinality-maximising
    // search that reassigns already-matched items without regard to score can
    // strip "dark brown sugar" off its best edge to manufacture a second, weaker
    // pair — reporting two `changed` rows that BOTH name the wrong existing
    // line. One correct edit plus an honest add + remove is the right answer;
    // a confidently wrong pairing is worse for #824's per-row accept/refuse
    // than an honest split, because refusing "half" of a misattributed pair
    // saves the wrong ingredient.
    const before = withIngredients(recipe(), [
      newIngredient('e-dark-brown', 'dark brown sugar'),
      newIngredient('e-brown', 'brown sugar'),
    ]);
    const after = withIngredients(recipe(), [
      newIngredient('d-dark-brown-soft', 'dark brown soft sugar'),
      newIngredient('d-dark', 'dark sugar'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([
      { id: 'd-dark-brown-soft', from: 'dark brown sugar', to: 'dark brown soft sugar' },
    ]);
    expect(diff.ingredients.added).toEqual([{ id: 'd-dark', rawText: 'dark sugar' }]);
    expect(diff.ingredients.removed).toEqual([{ id: 'e-brown', rawText: 'brown sugar' }]);
  });

  // ── PR #1177 review B2: normalisation must not cost a pairing appending a
  // preparation phrase to a short line used to have ─────────────────────────

  it('pairs a short ingredient extended with a prep phrase (#1137 review B2)', () => {
    // Dropping size words shrinks "1 large onion" to the single identity word
    // {onion}; against the 3-word draft set {onion, thinly, sliced}, Jaccard
    // alone scores 0.333 — below threshold, a regression from main's raw-token
    // 0.600. The existing side's identity set is fully CONTAINED in the
    // draft's, so this is a genuine addition, not a substitution.
    const before = withIngredients(recipe(), [newIngredient('i-old', '1 large onion')]);
    const after = withIngredients(recipe(), [
      newIngredient('i-new', '1 large onion, thinly sliced'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([
      { id: 'i-new', from: '1 large onion', to: '1 large onion, thinly sliced' },
    ]);
    expect(diff.ingredients.added).toEqual([]);
    expect(diff.ingredients.removed).toEqual([]);
  });

  it('pairs a short ingredient extended with a different prep phrase (#1137 review B2)', () => {
    const before = withIngredients(recipe(), [newIngredient('i-old', '1 small onion')]);
    const after = withIngredients(recipe(), [
      newIngredient('i-new', '1 small onion, finely chopped'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([
      { id: 'i-new', from: '1 small onion', to: '1 small onion, finely chopped' },
    ]);
    expect(diff.ingredients.added).toEqual([]);
    expect(diff.ingredients.removed).toEqual([]);
  });

  it('pairs a plural ingredient extended with a prep phrase (#1137 review B2)', () => {
    const before = withIngredients(recipe(), [newIngredient('i-old', '3 medium carrots')]);
    const after = withIngredients(recipe(), [
      newIngredient('i-new', '3 medium carrots, peeled and diced'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.ingredients.changed).toEqual([
      { id: 'i-new', from: '3 medium carrots', to: '3 medium carrots, peeled and diced' },
    ]);
    expect(diff.ingredients.added).toEqual([]);
    expect(diff.ingredients.removed).toEqual([]);
  });

  it('pairs a short step extended with more detail — steps have no canon fallback (#1137 review B2)', () => {
    // Steps pass no identityKey (Pass 3 cannot apply), so this pairing has to
    // survive on Pass 4 alone.
    const before = withSteps(recipe(), [newStep('s-old', 'Rest for 10 minutes.')]);
    const after = withSteps(recipe(), [
      newStep('s-new', 'Rest the dough for 10 minutes before shaping.'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.steps.changed).toEqual([
      {
        id: 's-new',
        position: 1,
        text: {
          from: 'Rest for 10 minutes.',
          to: 'Rest the dough for 10 minutes before shaping.',
        },
      },
    ]);
    expect(diff.steps.added).toEqual([]);
    expect(diff.steps.removed).toEqual([]);
  });

  it('pairs a second short step extended with more detail (#1137 review B2)', () => {
    const before = withSteps(recipe(), [newStep('s-old', 'Simmer for 20 minutes.')]);
    const after = withSteps(recipe(), [
      newStep('s-new', 'Simmer gently for 20 minutes, stirring often.'),
    ]);
    const diff = diffRecipe(before, after);
    expect(diff.steps.changed).toEqual([
      {
        id: 's-new',
        position: 1,
        text: {
          from: 'Simmer for 20 minutes.',
          to: 'Simmer gently for 20 minutes, stirring often.',
        },
      },
    ]);
    expect(diff.steps.added).toEqual([]);
    expect(diff.steps.removed).toEqual([]);
  });

  it('is pure — does not mutate either input recipe', () => {
    const before = withIngredients(recipe({ title: 'A' }), [newIngredient('i-1', 'x')]);
    const after = withIngredients(recipe({ title: 'B' }), [newIngredient('i-2', 'y')]);
    const beforeSnapshot = structuredClone(before);
    const afterSnapshot = structuredClone(after);
    diffRecipe(before, after);
    expect(before).toEqual(beforeSnapshot);
    expect(after).toEqual(afterSnapshot);
  });
});

// ── The phase strip and its sentence (issue #1212) ───────────────────────────
//
// The review gate is the only consumer of `diffRecipe`, and until this landed it
// could not see either half of a recipe's timing: a proposal that rewrote the
// strip, or (since #1203 let an amend clear it) one that deleted the sentence,
// was confirmed by a reviewer who was never shown it.
describe('diffRecipe — phases and timingSummary', () => {
  const MIX = { label: 'Mix & knead', handsOnMinutes: 20, handsOffMinutes: 0 };
  const PROVE = { label: 'First rise', handsOnMinutes: 0, handsOffMinutes: 90 };
  const BAKE = { label: 'Bake', handsOnMinutes: 5, handsOffMinutes: 40 };

  function withPhases(base: Recipe, phases: Recipe['metadata']['phases']): Recipe {
    return withMetadata(base, { phases });
  }

  it('reports nothing when the strip is identical', () => {
    const before = withPhases(recipe(), [MIX, PROVE, BAKE]);
    const after = withPhases(recipe(), [{ ...MIX }, { ...PROVE }, { ...BAKE }]);

    const diff: RecipeDiff = diffRecipe(before, after);

    expect(diff.metadata.phases).toBeUndefined();
    expect(diff.hasChanges).toBe(false);
  });

  it('treats an absent strip and an empty one as the same "no strip"', () => {
    const diff = diffRecipe(withPhases(recipe(), undefined), withPhases(recipe(), []));

    expect(diff.metadata.phases).toBeUndefined();
    expect(diff.hasChanges).toBe(false);
  });

  it('reports an added phase, carrying both sides whole', () => {
    const diff = diffRecipe(
      withPhases(recipe(), [MIX, BAKE]),
      withPhases(recipe(), [MIX, PROVE, BAKE]),
    );

    expect(diff.metadata.phases).toEqual({ from: [MIX, BAKE], to: [MIX, PROVE, BAKE] });
    expect(diff.hasChanges).toBe(true);
  });

  it('reports a removed phase', () => {
    const diff = diffRecipe(
      withPhases(recipe(), [MIX, PROVE, BAKE]),
      withPhases(recipe(), [MIX, BAKE]),
    );

    expect(diff.metadata.phases).toEqual({ from: [MIX, PROVE, BAKE], to: [MIX, BAKE] });
  });

  it('reports a rename, without reading the word', () => {
    const renamed = { ...PROVE, label: 'Bulk ferment' };

    const diff = diffRecipe(withPhases(recipe(), [PROVE]), withPhases(recipe(), [renamed]));

    expect(diff.metadata.phases).toEqual({ from: [PROVE], to: [renamed] });
  });

  it('reports a retimed phase, on either minute field', () => {
    const slower = { ...PROVE, handsOffMinutes: 120 };
    const fiddlier = { ...PROVE, handsOnMinutes: 5 };

    expect(
      diffRecipe(withPhases(recipe(), [PROVE]), withPhases(recipe(), [slower])).metadata.phases,
    ).toBeDefined();
    expect(
      diffRecipe(withPhases(recipe(), [PROVE]), withPhases(recipe(), [fiddlier])).metadata.phases,
    ).toBeDefined();
  });

  // The deliberate departure from the ingredients/steps convention, and the whole
  // reason it is deliberate: the order of a phase list IS the plan.
  it('reports a pure reorder, unlike a reordered ingredient or step', () => {
    const diff = diffRecipe(
      withPhases(recipe(), [MIX, PROVE, BAKE]),
      withPhases(recipe(), [MIX, BAKE, PROVE]),
    );

    expect(diff.metadata.phases).toEqual({
      from: [MIX, PROVE, BAKE],
      to: [MIX, BAKE, PROVE],
    });
    expect(diff.hasChanges).toBe(true);
  });

  it('reports a strip cleared to nothing', () => {
    const diff = diffRecipe(withPhases(recipe(), [MIX]), withPhases(recipe(), []));

    expect(diff.metadata.phases).toEqual({ from: [MIX], to: [] });
  });

  it('reports a sentence written where there was none', () => {
    const diff = diffRecipe(
      withMetadata(recipe(), { timingSummary: null }),
      withMetadata(recipe(), { timingSummary: 'About 25 minutes of you, over 2 hours.' }),
    );

    expect(diff.metadata.timingSummary).toEqual({
      from: null,
      to: 'About 25 minutes of you, over 2 hours.',
    });
  });

  // The #1208 ordering constraint in one assertion: an amend that clears the
  // sentence is now visible in the gate instead of landing unseen.
  it('reports a sentence deleted', () => {
    const diff = diffRecipe(
      withMetadata(recipe(), { timingSummary: 'About 25 minutes of you, over 2 hours.' }),
      withMetadata(recipe(), { timingSummary: null }),
    );

    expect(diff.metadata.timingSummary).toEqual({
      from: 'About 25 minutes of you, over 2 hours.',
      to: null,
    });
    expect(diff.hasChanges).toBe(true);
  });

  it('treats an absent sentence and an explicit null as the same nothing', () => {
    const diff = diffRecipe(
      withMetadata(recipe(), { timingSummary: undefined }),
      withMetadata(recipe(), { timingSummary: null }),
    );

    expect(diff.metadata.timingSummary).toBeUndefined();
    expect(diff.hasChanges).toBe(false);
  });
});

// ─── a preserved step id (issue #1178) ────────────────────────────────────────

// The point of asking the librarian which step each rewrite came from is that
// Pass 1 then does the pairing, with no new matching code at all. That is stated
// in `diffRecipe`'s header and in #1178's architecture notes, and until now
// nothing asserted it: the fuzzy passes would pair a MILD reword anyway, so a
// test using one would pass whether the id was honoured or not. These use a total
// rewrite — no shared identity word, so Pass 4 scores 0 — which makes the id the
// only thing that can be doing the work.
describe('diffRecipe — a step that kept its id', () => {
  const REWRITTEN = 'Warm the pan over a gentle flame until it shimmers';

  it('reports a totally rewritten step as one change, not a removal and an addition', () => {
    const before = withSteps(recipe(), [newStep('s-1', 'Chop the carrots')]);
    const after = withSteps(recipe(), [newStep('s-1', REWRITTEN)]);

    const diff = diffRecipe(before, after);
    expect(diff.steps.changed).toHaveLength(1);
    expect(diff.steps.changed[0]!.id).toBe('s-1');
    expect(diff.steps.changed[0]!.text).toEqual({ from: 'Chop the carrots', to: REWRITTEN });
    expect(diff.steps.added).toEqual([]);
    expect(diff.steps.removed).toEqual([]);
  });

  it('still splits the same rewrite into a removal and an addition without the id', () => {
    // The floor this feature raises the ceiling above, and the proof the test
    // above is measuring the id rather than the fuzzy passes.
    const before = withSteps(recipe(), [newStep('s-1', 'Chop the carrots')]);
    const after = withSteps(recipe(), [newStep('s-2', REWRITTEN)]);

    const diff = diffRecipe(before, after);
    expect(diff.steps.changed).toEqual([]);
    expect(diff.steps.added).toHaveLength(1);
    expect(diff.steps.removed).toHaveLength(1);
  });

  it('keeps a genuine addition beside a rewritten step in the right column', () => {
    const before = withSteps(recipe(), [newStep('s-1', 'Chop the carrots')]);
    const after = withSteps(recipe(), [
      newStep('s-1', REWRITTEN),
      newStep('s-9', 'Season and serve'),
    ]);

    const diff = diffRecipe(before, after);
    expect(diff.steps.changed).toHaveLength(1);
    expect(diff.steps.added.map((s) => s.text)).toEqual(['Season and serve']);
    expect(diff.steps.removed).toEqual([]);
  });
});
