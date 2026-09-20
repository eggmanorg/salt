import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { normaliseMemberEmail } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { KitchenToolDoc } from '@salt/domain/schemas';

// Handing a word nothing draws to a tool that already does — a gap row's "Make it
// another name for…" (issue #882 Phase 4, moved onto the one list in #1489 Phase
// 3, where it stopped having a dialog of its own and started using the same move
// dialog a name already on a tool uses).
//
// ITS OWN FILE, and that is a constraint rather than a preference. The action is a
// combobox inside a dialog, and a bits-ui combobox only commits a selection while
// its layer is the topmost one on the library's GLOBAL layer stack. A dialog
// opened and closed earlier in the same file leaves that stack one layer deep in
// jsdom (the release is rAF-driven and jsdom never fires rAF), after which the
// click opens the listbox, closes it again, and commits nothing — a failure that
// reads exactly like a broken page. Vitest's isolation is per FILE, so this is the
// smallest boundary that makes the test honest.

const { mockRecipes, mockMembers, mockIsLoading, mockAuth, toolSink } = await vi.hoisted(
  async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockRecipes: makeStore<readonly Recipe[]>([]),
      mockMembers: makeStore<{ email: string; admin: boolean }[]>([]),
      mockIsLoading: makeStore<boolean>(false),
      mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
      toolSink: { push: null as null | ((tools: readonly unknown[]) => void) },
    };
  },
);

vi.mock('svelte-spa-router', () => ({
  push: vi.fn(),
  pop: vi.fn(),
  router: { location: '/admin/kitchen-tools', querystring: '' },
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));
vi.mock('../src/lib/membersService.js', () => ({
  members: mockMembers,
  isLoadingMembers: mockIsLoading,
  // AdminGuard reads this since #1055 (Phase 5) instead of re-deriving admin
  // itself; derived here from the same members/auth stubs as the real
  // `currentMember` in membersService.ts.
  currentMember: {
    subscribe(fn: (v: { email: string; admin: boolean } | null) => void) {
      return mockMembers.subscribe((roster) => {
        const email = mockAuth.user?.email ?? '';
        if (!email) return fn(null);
        const normalised = normaliseMemberEmail(email);
        fn(roster.find((m) => m.email === normalised) ?? null);
      });
    },
  },
}));
vi.mock('../src/lib/recipeService.js', () => ({ recipes: mockRecipes }));
vi.mock('../src/lib/guidedPlanService.js', () => ({
  loadAllGuidedPlansForCuration: vi.fn(async () => ({ kind: 'ok', value: [] })),
}));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: () => ({ report: vi.fn() }),
}));
vi.mock('@salt/firebase-sync', () => ({
  subscribeKitchenTools: vi.fn((onTools: (tools: readonly unknown[]) => void) => {
    toolSink.push = onTools;
    return () => {};
  }),
  upsertKitchenTool: vi.fn(async () => ({ kind: 'ok' as const, value: undefined })),
  deleteKitchenTool: vi.fn(async () => ({ kind: 'ok', value: undefined })),
}));

import { upsertKitchenTool } from '@salt/firebase-sync';
import {
  initKitchenToolSync,
  __resetKitchenToolServiceForTest,
} from '../src/lib/kitchenToolService.js';
import KitchenToolsPage from '../src/routes/admin/KitchenToolsPage.svelte';

function setTools(tools: readonly KitchenToolDoc[]): void {
  toolSink.push?.(tools);
}

function recipeWithKit(id: string, ...labels: string[]): Recipe {
  return {
    cureCategory: null,
    createdBy: '',
    lastEditedBy: '',
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Dish',
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
    componentRecipeIds: [],
    kit: labels.map((label) => ({ label, stepIds: [], equipment: null })),
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  cleanup();
  __resetKitchenToolServiceForTest();
  toolSink.push = null;
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = { email: 'admin@e.org' };
  mockIsLoading._set(false);
  mockMembers._set([{ email: 'admin@e.org', admin: true }]);
  mockRecipes._set([]);
  initKitchenToolSync();
});

describe('KitchenToolsPage — handing an undrawn word to a tool', () => {
  it('appends the name to an existing tool and creates no second tool', async () => {
    // The action that stops the vocabulary filling with near-duplicates that all
    // want the same drawing — and every duplicate would be another AI image call.
    mockRecipes._set([recipeWithKit('r1', 'masher')]);
    setTools([
      {
        id: 'potato-masher',
        schemaVersion: 1,
        label: 'Potato masher',
        matchers: ['ricer'],
        thumbnail: 'https://example.com/kit/masher.webp',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    render(KitchenToolsPage);

    const row = await screen.findByTestId('kitchen-tool-gap-row');
    expect(row).toHaveAttribute('data-kit-label', 'masher');
    await userEvent.click(within(row).getByTestId('kitchen-tool-gap-menu'));
    await userEvent.click(await screen.findByTestId('kitchen-tool-gap-alias'));

    // THE SAME DIALOG a name already on a tool is moved with — the separate
    // `kitchen-tool-alias-dialog` is gone, because it was a second picker over
    // one decision.
    const dialog = await screen.findByTestId('kitchen-tool-move-dialog');
    expect(dialog).toHaveTextContent('Another name for “masher”');
    await userEvent.click(within(dialog).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Potato masher' }));

    const confirm = screen.getByTestId('kitchen-tool-move-confirm');
    expect(confirm).toHaveTextContent('Add as another name');
    // The confirm button is the readout of the combobox's committed value, so
    // waiting for it to enable is waiting for the selection to have landed.
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    const written = vi.mocked(upsertKitchenTool).mock.calls[0]![0];
    // The SAME document — no new id, so no second pictogram is ever generated and
    // the tool keeps the drawing it already had.
    expect(written.id).toBe('potato-masher');
    expect(written.matchers).toEqual(['ricer', 'masher']);
    expect(written.thumbnail).toBe('https://example.com/kit/masher.webp');
  });

  it('makes the gap row disappear once the alias resolves it', async () => {
    // No reprocessing and no write to the recipe: the row goes because resolution
    // happens at display time, against whatever the vocabulary now says.
    mockRecipes._set([recipeWithKit('r1', 'masher')]);
    const potatoMasher: KitchenToolDoc = {
      id: 'potato-masher',
      schemaVersion: 1,
      label: 'Potato masher',
      matchers: [],
      thumbnail: 'https://example.com/kit/masher.webp',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    setTools([potatoMasher]);
    render(KitchenToolsPage);

    await screen.findByTestId('kitchen-tool-gap-row');
    setTools([{ ...potatoMasher, matchers: ['masher'] }]);

    await waitFor(() => expect(screen.queryByTestId('kitchen-tool-gap-row')).toBeNull());
  });
});
