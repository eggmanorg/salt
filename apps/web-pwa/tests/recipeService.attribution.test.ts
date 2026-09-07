import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { Member, Recipe } from '@salt/domain';
import { emptyRecipe } from '@salt/domain';

// Recipe attribution (issue #845) — who added a recipe, and who last edited it.
//
// Audit only: a snapshot of `Member.name` taken at write time, recorded and
// displayed and never a gate. Two properties carry the whole feature, and both
// live in `persistRecipe`: `lastEditedBy` is re-stamped on EVERY write, and
// `createdBy` is filled ONCE and then never re-pointed at a later editor. The
// third is the quiet one — when there is no name to be had, nothing is written,
// because a placeholder reads as a person.
//
// The recipes store is module-internal singleton state with no reset seam, so
// every fixture id is namespaced per test (see recipeService.attachComponent).

vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  saveShoppingListItem: vi.fn(),
  subscribeMembers: vi.fn(() => vi.fn()),
  upsertMember: vi.fn(),
  deleteMember: vi.fn(),
}));

// Mutable auth stand-in: tests set `auth.user` to drive who is signed in. It also
// keeps `firebase.ts` (which boots the SDK on import) out of the graph.
vi.mock('../src/lib/auth.svelte.js', () => ({
  auth: { user: null as { uid: string; email: string | null } | null },
}));

vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  startUserActionSpan: vi.fn(),
}));

vi.mock('../src/lib/canonService.js', () => ({ getCanonItemsSnapshot: vi.fn(() => []) }));
vi.mock('../src/lib/productFormService.js', () => ({ getProductFormsSnapshot: vi.fn(() => []) }));

import * as firebaseSync from '@salt/firebase-sync';
import { auth } from '../src/lib/auth.svelte.js';
import { seedMembers, __resetMembersServiceForTest } from '../src/lib/membersService.js';
import { persistRecipe, stampRecipeAttribution } from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

let ns = 0;
function nsId(id: string): string {
  return `t${ns}-${id}`;
}

function member(overrides: Partial<Member> & { id: string }): Member {
  return {
    schemaVersion: 1,
    name: 'Person',
    email: overrides.id,
    admin: false,
    sortOrder: 0,
    icon: null,
    cookMode: 'standard',
    system: false,
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides,
  };
}

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return { ...emptyRecipe(nsId('r'), '2026-08-16T00:00:00.000Z'), ...overrides };
}

function saved(): Recipe {
  return fs.saveRecipe.mock.calls[0]![0];
}

function signIn(name: string, email = 'daniel@e.org'): void {
  seedMembers([member({ id: email, name })]);
  auth.user = { uid: 'u1', email };
}

beforeEach(() => {
  ns += 1;
  __resetMembersServiceForTest();
  vi.clearAllMocks();
  fs.saveRecipe.mockResolvedValue({ kind: 'ok', value: undefined });
  auth.user = null;
});

describe('persistRecipe — attribution', () => {
  it('stamps both fields on a recipe that has none', async () => {
    signIn('Daniel');

    await persistRecipe(recipe());

    expect(saved().createdBy).toBe('Daniel');
    expect(saved().lastEditedBy).toBe('Daniel');
  });

  it('fills createdBy once: a later editor moves lastEditedBy and nothing else', async () => {
    signIn('Kate', 'kate@e.org');

    await persistRecipe(recipe({ createdBy: 'Daniel', lastEditedBy: 'Daniel' }));

    expect(saved().createdBy).toBe('Daniel');
    expect(saved().lastEditedBy).toBe('Kate');
  });

  it('re-stamps lastEditedBy on your own save, leaving the chip reading "Added by" only', async () => {
    signIn('Daniel');

    await persistRecipe(recipe({ createdBy: 'Daniel', lastEditedBy: 'Kate' }));

    expect(saved().createdBy).toBe('Daniel');
    expect(saved().lastEditedBy).toBe('Daniel');
  });

  it('leaves both fields untouched when the roster has not synced yet', async () => {
    // Signed in, but the members subscription has not delivered — the cold-start
    // race. Writing "Unknown" here would be worse than writing nothing.
    auth.user = { uid: 'u1', email: 'daniel@e.org' };

    await persistRecipe(recipe({ createdBy: 'Daniel', lastEditedBy: 'Daniel' }));

    expect(saved().createdBy).toBe('Daniel');
    expect(saved().lastEditedBy).toBe('Daniel');
  });

  it('leaves both blank when the signed-in email is not on the roster', async () => {
    seedMembers([member({ id: 'kate@e.org', name: 'Kate' })]);
    auth.user = { uid: 'u2', email: 'guest@e.org' };

    await persistRecipe(recipe());

    expect(saved().createdBy).toBe('');
    expect(saved().lastEditedBy).toBe('');
  });

  it('still stamps updatedAt, and touches nothing else about the document', async () => {
    signIn('Daniel');
    const before = recipe({ title: 'Ragù' });

    await persistRecipe(before);

    expect(saved().updatedAt).not.toBe('');
    expect(saved()).toEqual({
      ...before,
      updatedAt: saved().updatedAt,
      createdBy: 'Daniel',
      lastEditedBy: 'Daniel',
    });
  });
});

describe('stampRecipeAttribution — the shared stamp the chat paths use', () => {
  it('is a pure function of the store: same recipe, same names, no write', () => {
    signIn('Daniel');
    const input = recipe();

    const stamped = stampRecipeAttribution(input);

    expect(stamped).toEqual({ ...input, createdBy: 'Daniel', lastEditedBy: 'Daniel' });
    expect(input.createdBy).toBe('');
    expect(fs.saveRecipe).not.toHaveBeenCalled();
  });

  it('returns the recipe unchanged when nobody is signed in', () => {
    const input = recipe({ createdBy: 'Daniel', lastEditedBy: 'Kate' });

    expect(stampRecipeAttribution(input)).toEqual(input);
  });
});
