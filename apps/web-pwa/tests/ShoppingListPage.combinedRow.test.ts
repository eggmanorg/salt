/**
 * Characterization: the combined aisle row's shell and colour ladder (issue
 * #930, Phase 1).
 *
 * `ShoppingItemRow` owns a collapse shell and a colour ladder that decide what
 * a row looks like in each of its states. The combined row — the aggregate a
 * shopping list renders when two recipes want the same canon — is not that
 * component: it re-derives both inline in `ShoppingListPage`, about 55 lines of
 * it, and the two have already drifted (the combined row has no `isSelected`
 * arm, and carries the CSS collapse class without the Svelte transitions).
 *
 * Phase 8 lifts the shell and the ladder to one shared source and has the
 * combined row consume it. These assertions are what says the consumption is
 * like-for-like: they pin the resolved classes of the shell, of all three
 * reachable colour arms, and the two asymmetries #930 rules deliberate and
 * requires Phase 8 to preserve rather than resolve.
 *
 * Class-string assertions rather than rendered geometry because jsdom has no
 * layout engine — but the failure mode here was never a wrong number, it is a
 * class silently lost in an extraction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonItem, ShoppingList, ShoppingListItem } from '@salt/domain';

// jsdom's global `URL` resolves against the document base, so the node
// `new URL(…, import.meta.url)` idiom does not work here — resolve by path.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

const { mockCanonItems, mockAisles, mockLists, mockItems, mockDefaultListId, mockLoading } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockCanonItems: makeStore<CanonItem[]>([]),
      mockAisles: makeStore<{ id: string; name: string; order: number }[]>([]),
      mockLists: makeStore<ShoppingList[]>([]),
      mockItems: makeStore<ShoppingListItem[]>([]),
      mockDefaultListId: makeStore<string | null>('list-1'),
      mockLoading: makeStore<boolean>(false),
    };
  });

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: mockCanonItems,
  aisles: mockAisles,
  purchaseCounts: {
    subscribe(fn: (v: Record<string, number>) => void) {
      fn({});
      return () => {};
    },
  },
}));
vi.mock('../src/lib/productFormService.js', () => ({
  productForms: { subscribe: (fn: (v: never[]) => void) => (fn([]), () => {}) },
}));
vi.mock('../src/lib/shoppingListService.svelte.js', () => ({
  lists: mockLists,
  defaultListId: mockDefaultListId,
  itemsForActiveList: mockItems,
  isLoadingShoppingList: mockLoading,
  setActiveListId: vi.fn(),
  addItemToList: vi.fn(),
  updateItemRawText: vi.fn(),
  updateItemAmountUnit: vi.fn(),
  updateItemNotes: vi.fn(),
  toggleItemChecked: vi.fn(),
  checkItems: vi.fn(),
  uncheckItems: vi.fn(),
  removeItem: vi.fn(),
  removeItems: vi.fn(),
  clearChecked: vi.fn(),
  moveSelectedItems: vi.fn(),
}));

import ShoppingListPage from '../src/routes/shopping/ShoppingListPage.svelte';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function canonItem(overrides: Partial<CanonItem> & { id: string; name: string }): CanonItem {
  return {
    schemaVersion: 5,
    synonyms: [],
    aisleId: 'a-produce',
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
    ...overrides,
  };
}

function item(overrides: Partial<ShoppingListItem> & { id: string }): ShoppingListItem {
  return {
    rawText: 'onion',
    notes: '',
    sources: [],
    canonId: 'c-onion',
    matchState: 'matched',
    checked: false,
    needsCheck: false,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// Mutable, not `as const`: since #1115 the entity types derive from their Zod
// schemas, and `sources` is a mutable array there.
const fromRecipe = (label: string, recipeId: string) => [
  { kind: 'recipe' as const, recipeId, servings: 2, label },
];

const props = { props: { params: { listId: 'list-1' } } };

/** Two recipes wanting the same canon: the only thing that makes a row combine. */
function twoOnionRecipes(overrides: Partial<ShoppingListItem> = {}): void {
  mockItems._set([
    item({ id: 'i1', amount: 200, unit: 'g', sources: fromRecipe('Stew', 'r1') }),
    item({ id: 'i2', amount: 300, unit: 'g', sources: fromRecipe('Soup', 'r2'), ...overrides }),
  ]);
}

/** The combined row proper — the element carrying the colour ladder. */
async function combinedRow(view: {
  findAllByTestId: (id: string) => Promise<HTMLElement[]>;
}): Promise<HTMLElement> {
  const rows = await view.findAllByTestId('shopping-item-row');
  const row = rows.find((r) => r.dataset.combined === 'true');
  expect(row, 'no combined row rendered — the fixture stopped combining').toBeTruthy();
  return row!;
}

const classesOf = (el: Element): string[] => el.className.split(/\s+/).filter(Boolean);

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockLists._set([{ id: 'list-1', name: 'Groceries' } as ShoppingList]);
  mockDefaultListId._set('list-1');
  mockLoading._set(false);
  // Rows only COMBINE inside an aisle group, so the canon needs a live aisle.
  mockAisles._set([{ id: 'a-produce', name: 'Produce', order: 1 }]);
  mockCanonItems._set([canonItem({ id: 'c-onion', name: 'onion' })]);
  mockItems._set([]);
});

describe('combined aisle row — the shell it re-derives from ShoppingItemRow', () => {
  it('sits inside the two-element collapse shell, outermost first', async () => {
    twoOnionRecipes();
    const view = render(ShoppingListPage, props);
    const row = await combinedRow(view);

    const inner = row.parentElement!;
    const collapse = inner.parentElement!;

    expect(classesOf(inner)).toEqual(['min-h-0', 'overflow-hidden']);
    expect(classesOf(collapse)).toEqual(['salt-row-collapse', 'motion-reduce:transition-none']);
  });

  it('carries the row proper’s geometry and transition classes', async () => {
    twoOnionRecipes();
    const view = render(ShoppingListPage, props);
    const row = await combinedRow(view);

    // Everything the shell contributes before the colour arm is chosen.
    for (const cls of [
      'flex',
      'items-center',
      'gap-3',
      'rounded',
      'border',
      'px-3',
      'py-2',
      'text-sm',
      'transition-colors',
      'duration-base',
      'ease-standard',
      'motion-reduce:transition-none',
    ]) {
      expect(classesOf(row)).toContain(cls);
    }
  });

  it('keeps the three attributes the shopping e2e specs select on', async () => {
    twoOnionRecipes();
    const view = render(ShoppingListPage, props);
    const row = await combinedRow(view);

    expect(row.dataset.combined).toBe('true');
    expect(row.dataset.canonId).toBe('c-onion');
    expect(row.getAttribute('data-testid')).toBe('shopping-item-row');
  });
});

describe('combined aisle row — the three-arm colour ladder', () => {
  it('rests on the neutral card arm', async () => {
    twoOnionRecipes();
    const view = render(ShoppingListPage, props);
    const row = await combinedRow(view);

    expect(classesOf(row)).toContain('border-border');
    expect(classesOf(row)).toContain('bg-card');
  });

  it('takes the `review` arm when any one contributor is flagged', async () => {
    // Row-level, not item-level: `AisleRow.needsCheck` is true if ANY
    // contributor is flagged, and only i2 is here.
    twoOnionRecipes({ needsCheck: true });
    const view = render(ShoppingListPage, props);
    const row = await combinedRow(view);

    expect(classesOf(row)).toContain('border-review');
    expect(classesOf(row)).toContain('bg-review/10');
    // The per-site `dark:` arm is gone: the token flips in `.dark` (#993).
    expect(classesOf(row).some((c) => c.startsWith('dark:'))).toBe(false);
    expect(classesOf(row)).not.toContain('border-border');
  });

  it('takes the exiting arm — and the whole aggregate leaves as one unit', async () => {
    twoOnionRecipes();
    const view = render(ShoppingListPage, props);
    const row = await combinedRow(view);

    await fireEvent.click(within(row).getByTestId('shopping-item-check'));

    await waitFor(() => {
      expect(classesOf(row)).toContain('border-secondary/40');
    });
    expect(classesOf(row)).toContain('bg-secondary-container/50');
    expect(classesOf(row)).not.toContain('bg-card');
    // One hold covering every contributor is what makes it exit as one unit.
    expect(classesOf(row.parentElement!.parentElement!)).toContain('salt-row-collapse-out');
  });

  it('has no selected arm — the ladder is three-armed, not four', async () => {
    // ShoppingItemRow's ladder has a fourth `isSelected` rung
    // (`border-ring ring-2 ring-ring`). The combined row deliberately does not;
    // #930 Phase 8 must preserve that, not harmonise it away.
    twoOnionRecipes();
    const view = render(ShoppingListPage, props);
    const row = await combinedRow(view);

    expect(classesOf(row)).not.toContain('ring-2');
    expect(classesOf(row)).not.toContain('border-ring');
  });
});

describe('combined aisle row — the asymmetry #930 rules deliberate', () => {
  it('collapses by CSS class alone, where a single row also runs Svelte transitions', () => {
    // ShoppingItemRow's collapse root carries `out:collapseOut` / `in:riseIn`;
    // the combined row's carries only the CSS class. Asserted at the source,
    // because a transition that never fires and a transition that is absent are
    // the same empty DOM in jsdom — and it is the DECLARATION that Phase 8 must
    // not quietly acquire when the shell is extracted. Whether the asymmetry is
    // a bug is a separate issue; #930 preserves it.
    const shell = readFileSync(join(SRC, 'routes/shopping/ShoppingItemRow.svelte'), 'utf8');
    const page = readFileSync(join(SRC, 'routes/shopping/ShoppingListPage.svelte'), 'utf8');

    expect(shell).toContain('out:collapseOut|global');
    expect(shell).toContain('in:riseIn|global');

    // Both roots are found by the shared helper #930 Phase 8 extracted them to,
    // not by the class literal — which is no longer written at either site.
    const rootsIn = (source: string): string[] =>
      [...source.matchAll(/<div\b[^>]*shoppingRowCollapseClass\([^)]*\)[^>]*>/g)].map((m) => m[0]);

    // The page renders exactly one collapse root of its own — the combined
    // row's — and it takes neither transition.
    const pageRoots = rootsIn(page);
    expect(pageRoots).toHaveLength(1);
    expect(pageRoots[0]).not.toContain('collapseOut');
    expect(pageRoots[0]).not.toContain('riseIn');

    // And the single row's one root takes both, so the asymmetry is a fact about
    // two live call sites rather than about one of them having been deleted.
    const shellRoots = rootsIn(shell);
    expect(shellRoots).toHaveLength(1);
    expect(shellRoots[0]).toContain('out:collapseOut|global');
    expect(shellRoots[0]).toContain('in:riseIn|global');
  });

  it('renders its contributors only once expanded', async () => {
    twoOnionRecipes();
    const view = render(ShoppingListPage, props);

    expect(view.queryByTestId('shopping-combined-breakdown')).toBeNull();
    await fireEvent.click(await view.findByTestId('shopping-combined-toggle'));
    const breakdown = within(await view.findByTestId('shopping-combined-breakdown'));
    expect(breakdown.getAllByTestId('shopping-item-row')).toHaveLength(2);
  });
});
