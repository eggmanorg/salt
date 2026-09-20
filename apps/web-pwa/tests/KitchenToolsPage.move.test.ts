import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { normaliseMemberEmail } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { KitchenToolDoc } from '@salt/domain/schemas';

// Moving a name from one tool to another (issue #1489, Phase 2), driven all the
// way through the destination picker.
//
// ITS OWN FILE, for the constraint `KitchenToolsPage.alias.test.ts` already
// documents: the picker is a combobox inside a dialog, and a bits-ui combobox
// only commits a selection while its layer is the topmost one on the library's
// GLOBAL layer stack. A dialog opened and closed earlier in the same file leaves
// that stack a layer deep in jsdom (the release is rAF-driven and jsdom never
// fires rAF), after which the click opens the listbox, closes it again, and
// commits nothing — a failure that reads exactly like a broken page. Vitest's
// isolation is per FILE.
//
// The menu that opens this dialog, and everything about a name row that does not
// need the picker, are in `KitchenToolsPage.test.ts`.

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
import { addToast } from '../src/lib/toastStore.js';
import {
  initKitchenToolSync,
  __resetKitchenToolServiceForTest,
} from '../src/lib/kitchenToolService.js';
import KitchenToolsPage from '../src/routes/admin/KitchenToolsPage.svelte';

function tool(id: string, label: string, matchers: string[] = []): KitchenToolDoc {
  return {
    id,
    schemaVersion: 1,
    label,
    matchers,
    thumbnail: `https://example.com/kit/${id}.webp`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const MASHER = tool('potato-masher', 'Potato masher', ['ricer']);
const WHISK = tool('whisk', 'Whisk');

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = { email: 'admin@e.org' };
  mockIsLoading._set(false);
  mockMembers._set([{ email: 'admin@e.org', admin: true }]);
  mockRecipes._set([]);
  initKitchenToolSync();
});

afterEach(() => {
  cleanup();
  __resetKitchenToolServiceForTest();
  toolSink.push = null;
  document.body.innerHTML = '';
});

/** Open the editor on the masher, open "ricer"'s menu, choose Move. */
async function openMoveDialog(): Promise<HTMLElement> {
  render(KitchenToolsPage, { props: { params: { id: 'potato-masher' } } });
  toolSink.push?.([MASHER, WHISK]);
  await userEvent.click(await screen.findByTestId('kitchen-tool-editor-name-menu'));
  await userEvent.click(await screen.findByTestId('kitchen-tool-editor-name-move'));
  return screen.findByTestId('kitchen-tool-move-dialog');
}

describe('KitchenToolsPage — moving a name to another tool', () => {
  it('hands the phrase over in two writes, destination first, and draws nothing', async () => {
    const dialog = await openMoveDialog();
    await userEvent.click(within(dialog).getByRole('combobox'));
    // The tool the phrase is already on is not offered — moving it to itself is
    // not a move.
    expect(screen.queryByRole('option', { name: 'Potato masher' })).toBeNull();
    await userEvent.click(await screen.findByRole('option', { name: 'Whisk' }));

    const confirm = screen.getByTestId('kitchen-tool-move-confirm');
    // The confirm button is the readout of the combobox's committed value, so
    // waiting for it to enable is waiting for the selection to have landed.
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(confirm);

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(2));
    const written = vi.mocked(upsertKitchenTool).mock.calls.map((c) => c[0]);
    // Gaining write first: the destination gains the phrase before the source
    // loses it, so a refused second write duplicates rather than destroys.
    expect(written[0]).toMatchObject({
      id: 'whisk',
      matchers: ['ricer'],
      // No document is minted, so no trigger fires and no image is spent.
      thumbnail: 'https://example.com/kit/whisk.webp',
    });
    expect(written[1]).toMatchObject({ id: 'potato-masher', matchers: [] });
    expect(vi.mocked(addToast).mock.calls.at(-1)![0]).toContain('now shows the Whisk');
  });

  it('writes nothing, closes and says so when the chosen tool has left the vocabulary under the dialog', async () => {
    // A real race rather than a contrivance: the vocabulary is a live
    // subscription, so the tool picked a moment ago can be gone by the time the
    // press lands. Doing half a move then would be worse than doing none — and
    // silence would be worse still: before the fix, this path left the dialog
    // open with "Move it" enabled over a selection with nothing behind it.
    const dialog = await openMoveDialog();
    await userEvent.click(within(dialog).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Whisk' }));

    const confirm = screen.getByTestId('kitchen-tool-move-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    toolSink.push?.([MASHER]);
    await userEvent.click(confirm);

    expect(vi.mocked(upsertKitchenTool)).not.toHaveBeenCalled();
    await waitFor(() => expect(vi.mocked(addToast)).toHaveBeenCalled());
    const [message, variant] = vi.mocked(addToast).mock.calls.at(-1)!;
    expect(variant).toBe('destructive');
    expect(message).toContain('ricer');
    await waitFor(() =>
      expect(screen.queryByTestId('kitchen-tool-move-dialog')).not.toBeInTheDocument(),
    );
  });
});
