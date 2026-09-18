import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { appendCacheBuster } from '@salt/domain';
import type { Recipe } from '@salt/domain';

import WeekShopSheet from '../src/routes/mealplan/WeekShopSheet.svelte';

// "Shop the week", once a night can hold a MEAL (#752, Phase 2).
//
// The sheet's job did not change: it picks a subset of the entries it was handed
// and forgets them. What changed is what a ROW is — a meal speaks for the dishes
// of its own night, so they fold under it as one line with one tick. Everything
// here is about that fold, and about the one property the review queue depends on:
// what comes back out is still a FLAT list of entries, in the order the rows
// offered them, because the page opens one review sheet per entry in it.

function makeRecipe(
  id: string,
  title: string,
  componentRecipeIds: string[] = [],
  overrides: Partial<Recipe> = {},
): Recipe {
  return {
    cureCategory: null,
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title,
    description: null,
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds,
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const CHICKEN = makeRecipe('chicken', 'Roast chicken');
const POTATOES = makeRecipe('potatoes', 'Roast potatoes');
const GRAVY = makeRecipe('gravy', 'Onion gravy');
const PIE = makeRecipe('pie', 'Fish pie');
const ROAST = makeRecipe('roast', 'Sunday roast', ['chicken', 'potatoes', 'gravy']);

const SUNDAY = '2026-08-16';
const MONDAY = '2026-08-17';

type Entry = { date: string; recipe: Recipe };

function entry(date: string, recipe: Recipe): Entry {
  return { date, recipe };
}

function renderSheet(entries: Entry[]) {
  const onConfirm = vi.fn();
  render(WeekShopSheet, { props: { open: true, entries, onConfirm } });
  return { onConfirm };
}

/** The rows actually offered, in order — a group's lead is the only row it has. */
function rowTitles(): string[] {
  return screen
    .getAllByTestId(/^shop-week-row-/)
    .map((row) => row.textContent?.trim() ?? '')
    .map((t) => t.replace(/\s+/g, ' '));
}

async function confirm(): Promise<void> {
  await userEvent.click(screen.getByTestId('shop-week-confirm'));
}

/** The tick itself — the testid sits on the primitive's wrapper, not its control. */
async function untick(date: string, recipeId: string): Promise<void> {
  await userEvent.click(
    within(screen.getByTestId(`shop-week-tick-${date}-${recipeId}`)).getByRole('checkbox'),
  );
}

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.innerHTML = '';
});

describe('WeekShopSheet — a meal is one row', () => {
  it('folds the night’s component dishes under the meal, with a count and one tick', async () => {
    renderSheet([
      entry(SUNDAY, ROAST),
      entry(SUNDAY, CHICKEN),
      entry(SUNDAY, POTATOES),
      entry(SUNDAY, GRAVY),
    ]);

    await waitFor(() => expect(screen.getByTestId('shop-week-list')).toBeInTheDocument());

    // One row for the whole dinner, named by the meal and counting what it speaks
    // for. The dishes are not rows: the tick above already covers them.
    expect(rowTitles()).toEqual(['Sunday roast · 3']);
    expect(screen.queryByTestId(`shop-week-row-${SUNDAY}-chicken`)).toBeNull();
  });

  it('reviews every dish it spoke for, meal first, in the order the rows offered them', async () => {
    const { onConfirm } = renderSheet([
      entry(SUNDAY, ROAST),
      entry(SUNDAY, CHICKEN),
      entry(SUNDAY, POTATOES),
      entry(SUNDAY, GRAVY),
    ]);
    await waitFor(() => expect(screen.getByTestId('shop-week-confirm')).toBeInTheDocument());

    // The count on the button is a promise about how many review sheets follow —
    // FOUR, not one, even though there is a single row.
    expect(screen.getByTestId('shop-week-confirm')).toHaveTextContent('Review 4 recipes');

    await confirm();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0].map((e: Entry) => e.recipe.id)).toEqual([
      'roast',
      'chicken',
      'potatoes',
      'gravy',
    ]);
  });

  it('unticks the whole dinner at once — a group is never half on the list', async () => {
    const { onConfirm } = renderSheet([
      entry(SUNDAY, ROAST),
      entry(SUNDAY, CHICKEN),
      entry(SUNDAY, POTATOES),
      entry(SUNDAY, GRAVY),
      entry(MONDAY, PIE),
    ]);
    await waitFor(() => expect(screen.getByTestId('shop-week-confirm')).toBeInTheDocument());
    expect(screen.getByTestId('shop-week-confirm')).toHaveTextContent('Review 5 recipes');

    await untick(SUNDAY, 'roast');

    // All four go, not just the meal.
    await waitFor(() =>
      expect(screen.getByTestId('shop-week-confirm')).toHaveTextContent('Review 1 recipe'),
    );
    await confirm();
    expect(onConfirm.mock.calls[0]![0].map((e: Entry) => e.recipe.id)).toEqual(['pie']);
  });

  it('adopts a dish that was planned BEFORE the meal it belongs to', async () => {
    // Add the gravy on its own, then add the roast, and the gravy sits ahead of it
    // in the day. It still belongs to the meal — adoption is over the whole night,
    // not over what follows the meal.
    const { onConfirm } = renderSheet([entry(SUNDAY, GRAVY), entry(SUNDAY, ROAST)]);
    await waitFor(() => expect(screen.getByTestId('shop-week-list')).toBeInTheDocument());

    expect(rowTitles()).toEqual(['Sunday roast · 1']);
    await confirm();
    expect(onConfirm.mock.calls[0]![0].map((e: Entry) => e.recipe.id)).toEqual(['roast', 'gravy']);
  });
});

describe('WeekShopSheet — what a meal does NOT swallow', () => {
  it('leaves a dish alone when its meal is not planned for that night', async () => {
    // The gravy on Monday is nobody's component on Monday: the roast is Sunday.
    renderSheet([entry(SUNDAY, ROAST), entry(SUNDAY, CHICKEN), entry(MONDAY, GRAVY)]);
    await waitFor(() => expect(screen.getByTestId('shop-week-list')).toBeInTheDocument());

    expect(rowTitles()).toEqual(['Sunday roast · 1', 'Onion gravy']);
    expect(screen.getByTestId(`shop-week-row-${MONDAY}-gravy`)).toBeInTheDocument();
  });

  it('shows a meal whose dishes are elsewhere as a plain row, with no count', async () => {
    renderSheet([entry(SUNDAY, ROAST), entry(MONDAY, PIE)]);
    await waitFor(() => expect(screen.getByTestId('shop-week-list')).toBeInTheDocument());

    // No suffix: the count exists to say what the row is speaking for, and this
    // one speaks only for itself.
    expect(rowTitles()).toEqual(['Sunday roast', 'Fish pie']);
  });

  it('gives a dish named by two meals to the FIRST of them, in document order', async () => {
    const sunday = makeRecipe('roast', 'Sunday roast', ['gravy']);
    const supper = makeRecipe('supper', 'Late supper', ['gravy']);
    const { onConfirm } = renderSheet([
      entry(SUNDAY, sunday),
      entry(SUNDAY, supper),
      entry(SUNDAY, GRAVY),
    ]);
    await waitFor(() => expect(screen.getByTestId('shop-week-list')).toBeInTheDocument());

    expect(rowTitles()).toEqual(['Sunday roast · 1', 'Late supper']);
    await confirm();
    // The gravy is reviewed once, under the first meal — never twice.
    expect(onConfirm.mock.calls[0]![0].map((e: Entry) => e.recipe.id)).toEqual([
      'roast',
      'gravy',
      'supper',
    ]);
  });

  it('keeps the same recipe on two nights as two independent rows', async () => {
    // The date is half of a row's identity, so a meal planned twice is two
    // dinners, ticked separately.
    const { onConfirm } = renderSheet([
      entry(SUNDAY, ROAST),
      entry(SUNDAY, GRAVY),
      entry(MONDAY, ROAST),
      entry(MONDAY, GRAVY),
    ]);
    await waitFor(() => expect(screen.getByTestId('shop-week-list')).toBeInTheDocument());
    expect(rowTitles()).toEqual(['Sunday roast · 1', 'Sunday roast · 1']);

    await untick(SUNDAY, 'roast');
    await waitFor(() =>
      expect(screen.getByTestId('shop-week-confirm')).toHaveTextContent('Review 2 recipes'),
    );

    await confirm();
    expect(onConfirm.mock.calls[0]![0].map((e: Entry) => `${e.date}:${e.recipe.id}`)).toEqual([
      `${MONDAY}:roast`,
      `${MONDAY}:gravy`,
    ]);
  });

  it('keeps an ordinary night exactly as it was — no meals, no grouping', async () => {
    const { onConfirm } = renderSheet([entry(SUNDAY, PIE), entry(SUNDAY, GRAVY)]);
    await waitFor(() => expect(screen.getByTestId('shop-week-list')).toBeInTheDocument());

    expect(rowTitles()).toEqual(['Fish pie', 'Onion gravy']);
    await confirm();
    expect(onConfirm.mock.calls[0]![0].map((e: Entry) => e.recipe.id)).toEqual(['pie', 'gravy']);
  });
});

// ─── Hero URL rule (issue #933 characterisation) ──────────────────────────────
// This is issue #933's characterisation net for the "hero URL" rule — one of
// eight identical copies of `appendCacheBuster(recipe.image.url,
// recipe.imageRequestedAt ?? recipe.updatedAt)` scattered across web-pwa, here
// at the row thumbnail. It must stay green, UNMODIFIED, once all eight collapse
// onto one shared `@salt/domain` function. Expectations are computed by calling
// the REAL `appendCacheBuster` rather than hand-encoding a query string. The
// `<img>` here carries no testid of its own — only the row does — so it is
// queried off the row's DOM directly.
describe('WeekShopSheet — hero URL rule (issue #933 characterisation)', () => {
  it.each([
    { name: 'busts with imageRequestedAt when present', imageRequestedAt: 5000 },
    {
      name: 'falls back to updatedAt when imageRequestedAt is absent',
      imageRequestedAt: undefined,
    },
  ])('$name', async ({ imageRequestedAt }) => {
    const url = 'http://img.test/hero-rule.jpg';
    const heroRecipe = makeRecipe('hero-rule', 'Hero Rule', [], {
      image: { url, source: 'ai' },
      ...(imageRequestedAt !== undefined ? { imageRequestedAt } : {}),
      updatedAt: '2026-01-05T00:00:00.000Z',
    });
    renderSheet([entry(SUNDAY, heroRecipe)]);
    await waitFor(() => expect(screen.getByTestId('shop-week-list')).toBeInTheDocument());

    const row = screen.getByTestId(`shop-week-row-${SUNDAY}-hero-rule`);
    expect(row.querySelector('img')).toHaveAttribute(
      'src',
      appendCacheBuster(url, imageRequestedAt ?? heroRecipe.updatedAt),
    );
  });

  it('shows the fallback pictogram, not an img, when there is no image', async () => {
    renderSheet([entry(SUNDAY, makeRecipe('hero-none', 'Hero None'))]);
    await waitFor(() => expect(screen.getByTestId('shop-week-list')).toBeInTheDocument());

    const row = screen.getByTestId(`shop-week-row-${SUNDAY}-hero-none`);
    expect(row.querySelector('img')).toBeNull();
  });
});
