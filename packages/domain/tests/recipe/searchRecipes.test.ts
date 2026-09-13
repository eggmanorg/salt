/**
 * Keyword search over the recipe library (issue #840).
 *
 * The ranking half of the chef's `findRecipes` tool. What is pinned here is what
 * the user-facing outcomes actually rest on:
 *
 *  - AN EMPTY QUERY BROWSES. "What shall we have this week?" carries no keywords,
 *    and a search that returned nothing for it would make the whole feature fail
 *    on its headline question.
 *  - A MATCH BEATS A MENTION. The dish called "Roast lamb" outranks the one whose
 *    description happens to say lamb, however long that description is.
 *  - NO MATCH IS AN EMPTY LIST, not the whole library. "We have nothing like
 *    that" is an answer; handing the chef fifty unrelated dishes is not.
 *  - IT IS PURE AND STABLE. Same library, same question, same answer — which is
 *    what makes a prompt-behaviour problem reproducible at all.
 */
import { describe, it, expect } from 'vitest';
import {
  searchRecipes,
  RECIPE_SEARCH_DEFAULT_MAX_RESULTS,
  RECIPE_SEARCH_RESULT_CEILING,
  type RecipeSearchCandidate,
} from '../../src/index.js';
import type { RecipeKind } from '../../src/index.js';

function dish(
  id: string,
  title: string,
  extra: Partial<Omit<RecipeSearchCandidate, 'id' | 'title'>> = {},
): RecipeSearchCandidate {
  return {
    id,
    title,
    description: null,
    kind: 'recipe',
    tags: [],
    ...extra,
  };
}

const LIBRARY: RecipeSearchCandidate[] = [
  dish('r-lamb', 'Slow-roast lamb shoulder', {
    description: 'Six hours in a low oven until it falls apart.',
    tags: ['sunday', 'roast'],
  }),
  dish('r-tagine', 'Lamb tagine', {
    description: 'Apricots, ras el hanout and a long simmer.',
    tags: ['moroccan'],
  }),
  dish('r-dhal', 'Red lentil dhal', {
    description: 'Storecupboard dinner, on the table in twenty minutes.',
    tags: ['vegetarian', 'quick'],
  }),
  dish('r-chicken', 'Roast chicken traybake', {
    description: 'Chicken thighs, lemon and potatoes in one tin.',
    tags: ['quick'],
  }),
  dish('r-negroni', 'Negroni', { kind: 'cocktail', tags: ['bitter'] }),
  dish('r-curryhouse', 'The curry house on the high street', { kind: 'special' }),
];

const ids = (results: readonly RecipeSearchCandidate[]) => results.map((r) => r.id);

// ─── Browse ───────────────────────────────────────────────────────────────────

describe('searchRecipes — an empty query browses', () => {
  it('returns the whole library, in title order, when there is no query at all', () => {
    expect(ids(searchRecipes(LIBRARY))).toEqual([
      'r-tagine', // Lamb tagine
      'r-negroni', // Negroni
      'r-dhal', // Red lentil dhal
      'r-chicken', // Roast chicken traybake
      'r-lamb', // Slow-roast lamb shoulder
      'r-curryhouse', // The curry house on the high street
    ]);
  });

  it('browses for a blank query too', () => {
    expect(searchRecipes(LIBRARY, { query: '   ' })).toHaveLength(LIBRARY.length);
  });

  it('browses rather than returning nothing when the query is only stop words', () => {
    // "what is the" tokenises to nothing. Zero results here would read to the
    // chef as an empty library.
    expect(searchRecipes(LIBRARY, { query: 'what is the' })).toHaveLength(LIBRARY.length);
  });

  it('still applies the filters while browsing', () => {
    expect(ids(searchRecipes(LIBRARY, { kind: 'cocktail' }))).toEqual(['r-negroni']);
  });
});

// ─── Ranking ──────────────────────────────────────────────────────────────────

describe('searchRecipes — ranking', () => {
  it('finds the saved lamb dishes and nothing else', () => {
    expect(ids(searchRecipes(LIBRARY, { query: 'lamb' })).sort()).toEqual(['r-lamb', 'r-tagine']);
  });

  it('ranks a title match above a description mention', () => {
    const wordy = dish('r-wordy', 'Something else entirely', {
      description: 'lamb '.repeat(40),
    });
    const results = searchRecipes([wordy, ...LIBRARY], { query: 'lamb' });
    // The mention still counts — it may well be a lamb dish — but it scores once
    // per field, so forty repetitions cannot reach a dish actually CALLED lamb.
    expect(ids(results)).toEqual(['r-tagine', 'r-lamb', 'r-wordy']);
  });

  it('ranks a dish matching two query words above one matching one', () => {
    expect(searchRecipes(LIBRARY, { query: 'roast lamb' })[0]?.id).toBe('r-lamb');
  });

  it('matches across title, tags and description together', () => {
    expect(ids(searchRecipes(LIBRARY, { query: 'vegetarian' }))).toEqual(['r-dhal']);
    expect(ids(searchRecipes(LIBRARY, { query: 'apricots' }))).toEqual(['r-tagine']);
  });

  it('matches a longer form of the same word in either direction', () => {
    // "roasted" → "roast", and "lamb" → "lambs".
    expect(ids(searchRecipes(LIBRARY, { query: 'roasted' }))).toContain('r-lamb');
    expect(ids(searchRecipes([dish('r-l', 'Lambs liver')], { query: 'lamb' }))).toEqual(['r-l']);
  });

  it('does not prefix-match on a short word', () => {
    // "pea" must not reach "peanut" or "pear" — three letters is not enough
    // evidence, and the whole library would match on two.
    const pantry = [dish('r-peanut', 'Peanut noodles'), dish('r-pear', 'Pear tart')];
    expect(searchRecipes(pantry, { query: 'pea' })).toEqual([]);
  });

  it('returns nothing rather than everything when nothing matches', () => {
    expect(searchRecipes(LIBRARY, { query: 'kimchi gochujang' })).toEqual([]);
  });

  it('is case- and punctuation-insensitive', () => {
    expect(ids(searchRecipes(LIBRARY, { query: 'LAMB!' })).sort()).toEqual(['r-lamb', 'r-tagine']);
  });

  it('keeps an accented word as one token', () => {
    const one = [dish('r-creme', 'Crème brûlée')];
    expect(ids(searchRecipes(one, { query: 'crème' }))).toEqual(['r-creme']);
  });
});

// ─── Filters ──────────────────────────────────────────────────────────────────

describe('searchRecipes — filters', () => {
  it('restricts to one kind', () => {
    expect(ids(searchRecipes(LIBRARY, { query: 'curry', kind: 'special' }))).toEqual([
      'r-curryhouse',
    ]);
    expect(searchRecipes(LIBRARY, { query: 'lamb', kind: 'cocktail' })).toEqual([]);
  });

  it('requires ALL the requested tags, not any of them', () => {
    expect(ids(searchRecipes(LIBRARY, { tags: ['quick', 'vegetarian'] }))).toEqual(['r-dhal']);
    expect(ids(searchRecipes(LIBRARY, { tags: ['quick'] }))).toEqual(['r-dhal', 'r-chicken']);
  });

  it('compares tags case-insensitively and ignores surrounding space', () => {
    expect(ids(searchRecipes(LIBRARY, { tags: ['  Vegetarian '] }))).toEqual(['r-dhal']);
  });

  it('ignores an empty tag list', () => {
    expect(searchRecipes(LIBRARY, { tags: [] })).toHaveLength(LIBRARY.length);
  });
});

// ─── The result cap ───────────────────────────────────────────────────────────

describe('searchRecipes — the result cap', () => {
  const many = Array.from({ length: 100 }, (_, i) =>
    dish(`r-${i}`, `Dish ${String(i).padStart(3, '0')}`),
  );

  it('gives an unasked-for browse the whole library, up to the ceiling', () => {
    // NOT the 25-row default, and that is the whole point: a browse is ordered by
    // TITLE, so capping it at 25 makes every dish after the 25th invisible on
    // every planning turn — the same dishes, forever, with nothing in the result
    // saying so. A ranked search truncated at 25 loses its least relevant answers
    // instead, which is what a default is for.
    expect(searchRecipes(many)).toHaveLength(RECIPE_SEARCH_RESULT_CEILING);
  });

  it('caps an unasked-for RANKED search at the default', () => {
    expect(searchRecipes(many, { query: 'dish' })).toHaveLength(RECIPE_SEARCH_DEFAULT_MAX_RESULTS);
  });

  it('honours a smaller request', () => {
    expect(searchRecipes(many, { maxResults: 3 })).toHaveLength(3);
  });

  it('clamps a larger one to the ceiling', () => {
    expect(searchRecipes(many, { maxResults: 5000 })).toHaveLength(RECIPE_SEARCH_RESULT_CEILING);
  });

  it('falls back to the unasked-for limit for a nonsensical request', () => {
    for (const maxResults of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(searchRecipes(many, { maxResults })).toHaveLength(RECIPE_SEARCH_RESULT_CEILING);
      expect(searchRecipes(many, { query: 'dish', maxResults })).toHaveLength(
        RECIPE_SEARCH_DEFAULT_MAX_RESULTS,
      );
    }
  });

  it('the ceiling is above the library this shipped against', () => {
    // 59 dishes at the time of #840. The bound is on what one turn costs, not on
    // how big the library may get — but a ceiling BELOW the library would make
    // "browse everything" quietly untrue on day one.
    expect(RECIPE_SEARCH_RESULT_CEILING).toBeGreaterThan(59);
  });
});

// ─── Purity and stability ─────────────────────────────────────────────────────

describe('searchRecipes — pure and stable', () => {
  it('never mutates or reorders its input', () => {
    const before = [...LIBRARY];
    searchRecipes(LIBRARY, { query: 'lamb roast chicken' });
    expect(LIBRARY).toEqual(before);
  });

  it('gives the same answer twice, whatever order the library arrives in', () => {
    const shuffled = [...LIBRARY].reverse();
    expect(ids(searchRecipes(shuffled, { query: 'roast' }))).toEqual(
      ids(searchRecipes(LIBRARY, { query: 'roast' })),
    );
  });

  it('breaks a score tie on the title, not on input order', () => {
    const tied = [dish('r-b', 'Bravo bake'), dish('r-a', 'Alpha bake')];
    expect(ids(searchRecipes(tied, { query: 'bake' }))).toEqual(['r-a', 'r-b']);
  });

  it('carries the caller’s own extra fields through untouched', () => {
    // The generic is what lets the Cloud Function keep servings and timings on
    // its rows without this function knowing they exist.
    const row = { ...dish('r-x', 'Pie'), servings: 4 };
    expect(searchRecipes([row], { query: 'pie' })[0]?.servings).toBe(4);
  });

  it('handles an empty library', () => {
    expect(searchRecipes([], { query: 'lamb' })).toEqual([]);
    expect(searchRecipes([])).toEqual([]);
  });

  it('accepts every kind a household could eat as a candidate', () => {
    const kinds: RecipeKind[] = ['recipe', 'special', 'cocktail'];
    const all = kinds.map((kind, i) => dish(`r-${i}`, `Thing ${i}`, { kind }));
    expect(searchRecipes(all)).toHaveLength(kinds.length);
  });
});

// ─── Placeholders are not dishes ──────────────────────────────────────────────

describe('searchRecipes — placeholders', () => {
  // The ~20 `placeholder` documents in production are stock photographs for a
  // night planned in a sentence: no ingredients, no method, every capability in
  // `capabilities.ts` false. They are also the WORST possible search results,
  // because their tags are `comfort`/`cold`/`bright`/`hot` and their descriptions
  // are evocative kitchen prose — so a search for a vibe scores them while a real
  // recipe that never says the word scores zero and is dropped. The chef is told
  // to name and link every entry it gets back, so leaving them in offers the
  // household a photograph as tonight's dinner.
  const photo = dish('r-photo', 'Placeholder — pot and ladle, grey afternoon', {
    kind: 'placeholder',
    description: 'A tall pot with its lid propped half off, steam curling from the gap.',
    tags: ['comfort', 'cold', 'wet'],
  });
  const stew = dish('r-stew', 'Beef stew', { tags: ['comfort'] });

  it('never offers one in a browse', () => {
    expect(ids(searchRecipes([photo, stew]))).toEqual(['r-stew']);
  });

  it('never offers one for a search it would otherwise win', () => {
    // 'ladle' appears in nothing but the photograph. Without the exclusion this
    // returns the photograph and nothing else.
    expect(searchRecipes([photo, stew], { query: 'ladle steam pot' })).toEqual([]);
  });

  it('never offers one for a tag filter it carries', () => {
    expect(ids(searchRecipes([photo, stew], { tags: ['comfort'] }))).toEqual(['r-stew']);
  });

  it('returns them when they are asked for by name', () => {
    // The exclusion is a default, not a ban: a caller that names the kind has
    // asked for exactly these and is not the chef browsing for dinner.
    expect(ids(searchRecipes([photo, stew], { kind: 'placeholder' }))).toEqual(['r-photo']);
  });
});
