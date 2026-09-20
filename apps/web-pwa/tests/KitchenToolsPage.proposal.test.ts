import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { normaliseMemberEmail } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { KitchenToolDoc, KitchenToolProposal } from '@salt/domain/schemas';

// Salt's proposal on a "Not drawn yet" row (issue #1458, Phase 2).
//
// WHAT THIS PHASE ADDED IS A SENTENCE. The row's two verbs, its menu and its
// ranking are #1489 Phase 3's and are covered by that issue's tests; what is
// asserted here is that the sentence arrives, that it replaces the head-noun
// guess IN PLACE rather than beside it, that the sentence and the button beneath
// it can never disagree, and — the one that matters most — that a row is fully
// usable when no proposal ever comes.

const { mockRecipes, mockMembers, mockIsLoading, mockAuth, toolSink, proposalSink } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockRecipes: makeStore<readonly Recipe[]>([]),
      mockMembers: makeStore<{ email: string; admin: boolean }[]>([]),
      mockIsLoading: makeStore<boolean>(false),
      mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
      toolSink: { push: null as null | ((tools: readonly unknown[]) => void) },
      proposalSink: {
        answer: { kind: 'ok', value: { proposals: [] } } as
          | { kind: 'ok'; value: { proposals: KitchenToolProposal[] } }
          | { kind: 'err'; error: { kind: string } },
      },
    };
  });

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
  callProposeKitchenTools: vi.fn(async () => proposalSink.answer),
}));

import { upsertKitchenTool, callProposeKitchenTools } from '@salt/firebase-sync';
import {
  initKitchenToolSync,
  __resetKitchenToolServiceForTest,
} from '../src/lib/kitchenToolService.js';
import KitchenToolsPage from '../src/routes/admin/KitchenToolsPage.svelte';
import KitchenToolGapRow from '../src/routes/admin/KitchenToolGapRow.svelte';

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
    metadata: { servings: null, tags: [] },
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

// Two bowls, so the head-noun guess and Salt's answer can be DIFFERENT tools and
// "it replaced the guess" is a claim the assertion can actually distinguish from
// "it agreed with the guess". `suggestKitchenToolParent` breaks the one-shared-
// word tie by the shorter phrase, so it picks the salad bowl for "spinner bowl".
const MIXING = tool('mixing-bowl', 'Mixing bowl');
const SALAD = tool('salad-bowl', 'Salad bowl');

afterEach(() => {
  cleanup();
  __resetKitchenToolServiceForTest();
  toolSink.push = null;
  proposalSink.answer = { kind: 'ok', value: { proposals: [] } };
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

describe('KitchenToolsPage — Salt proposes an answer for each undrawn word', () => {
  it('replaces the head-noun guess in place, and the sentence names the same tool', async () => {
    proposalSink.answer = {
      kind: 'ok',
      value: { proposals: [{ kind: 'alias', label: 'spinner bowl', toolId: 'mixing-bowl' }] },
    };
    mockRecipes._set([recipeWithKit('r1', 'spinner bowl')]);
    setTools([MIXING, SALAD]);
    render(KitchenToolsPage);

    const row = await screen.findByTestId('kitchen-tool-gap-row');
    // Before the answer: the pure head-noun guess, and no sentence.
    expect(within(row).getByTestId('kitchen-tool-gap-suggest')).toHaveTextContent(
      'Also call it Salad bowl',
    );

    const sentence = await within(row).findByTestId('kitchen-tool-gap-proposal');
    expect(sentence).toHaveTextContent('Salt thinks this is another name for Mixing bowl.');
    // IN PLACE, not beside: the one press is now Salt's answer, and there is only
    // ever one of it.
    expect(within(row).getByTestId('kitchen-tool-gap-suggest')).toHaveTextContent(
      'Also call it Mixing bowl',
    );
  });

  it('writes the alias onto the tool Salt named, not the one the head noun guessed', async () => {
    proposalSink.answer = {
      kind: 'ok',
      value: { proposals: [{ kind: 'alias', label: 'spinner bowl', toolId: 'mixing-bowl' }] },
    };
    mockRecipes._set([recipeWithKit('r1', 'spinner bowl')]);
    setTools([MIXING, SALAD]);
    render(KitchenToolsPage);

    const row = await screen.findByTestId('kitchen-tool-gap-row');
    await within(row).findByTestId('kitchen-tool-gap-proposal');
    await userEvent.click(within(row).getByTestId('kitchen-tool-gap-suggest'));

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    const written = vi.mocked(upsertKitchenTool).mock.calls[0]![0];
    expect(written.id).toBe('mixing-bowl');
    expect(written.matchers).toEqual(['spinner bowl']);
    // The same document, so no second pictogram is ever drawn.
    expect(written.thumbnail).toBe('https://example.com/kit/mixing-bowl.webp');
  });

  it('offers a proposed new tool under the name Salt chose, pre-filled', async () => {
    proposalSink.answer = {
      kind: 'ok',
      value: {
        proposals: [{ kind: 'new', label: 'tagine dish', suggestedLabel: 'Tagine' }],
      },
    };
    mockRecipes._set([recipeWithKit('r1', 'tagine dish')]);
    setTools([MIXING]);
    render(KitchenToolsPage);

    const row = await screen.findByTestId('kitchen-tool-gap-row');
    expect(await within(row).findByTestId('kitchen-tool-gap-proposal')).toHaveTextContent(
      'Salt thinks this is a new tool — call it Tagine.',
    );
    // Salt saying "this is its own object" clears the free alias press, because
    // there is no tool to hand it to.
    expect(within(row).queryByTestId('kitchen-tool-gap-suggest')).toBeNull();
    await userEvent.click(within(row).getByTestId('kitchen-tool-gap-new'));

    // The SAME pre-filled Add dialog, which is where #956's near-duplicate
    // warning lives — nothing is written by the proposal itself.
    const dialog = await screen.findByTestId('kitchen-tool-add-dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Tagine');
    expect(vi.mocked(upsertKitchenTool)).not.toHaveBeenCalled();
  });

  it('carries the word into matchers when a new proposal renamed it, so accepting it closes the gap row — #1525 blocking finding 2', async () => {
    // A `new` proposal that renames ("cocotte" → "Casserole dish") used to mint a
    // document under the SUGGESTED name alone: the create dialog has no matchers
    // field, so `resolveKitchenTool('cocotte', ...)` still answered null after the
    // write and the gap row it was minted from never closed. The word the dialog
    // was opened for rides along as a matcher instead.
    proposalSink.answer = {
      kind: 'ok',
      value: {
        proposals: [{ kind: 'new', label: 'cocotte', suggestedLabel: 'Casserole dish' }],
      },
    };
    mockRecipes._set([recipeWithKit('r1', 'cocotte')]);
    setTools([MIXING]);
    render(KitchenToolsPage);

    const row = await screen.findByTestId('kitchen-tool-gap-row');
    await within(row).findByTestId('kitchen-tool-gap-proposal');
    await userEvent.click(within(row).getByTestId('kitchen-tool-gap-new'));

    const dialog = await screen.findByTestId('kitchen-tool-add-dialog');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Casserole dish');
    await userEvent.click(within(dialog).getByTestId('kitchen-tool-save'));

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    const written = vi.mocked(upsertKitchenTool).mock.calls[0]![0];
    expect(written.label).toBe('Casserole dish');
    expect(written.matchers).toEqual(['cocotte']);
  });

  it('says so when a word is not kit at all, and still leaves the row actionable', async () => {
    proposalSink.answer = {
      kind: 'ok',
      value: { proposals: [{ kind: 'not-kit', label: 'spinner bowl' }] },
    };
    mockRecipes._set([recipeWithKit('r1', 'spinner bowl')]);
    setTools([MIXING, SALAD]);
    render(KitchenToolsPage);

    const row = await screen.findByTestId('kitchen-tool-gap-row');
    expect(await within(row).findByTestId('kitchen-tool-gap-proposal')).toHaveTextContent(
      'Salt thinks this is not a piece of kit at all.',
    );
    // No verb is taken away and none is added: this page records what Salt thinks
    // and gates nothing on it.
    expect(within(row).getByTestId('kitchen-tool-gap-suggest')).toHaveTextContent(
      'Also call it Salad bowl',
    );
    expect(within(row).getByTestId('kitchen-tool-gap-menu')).toBeInTheDocument();
  });

  it('leaves every row fully usable when the model is unavailable', async () => {
    proposalSink.answer = { kind: 'err', error: { kind: 'NetworkError' } };
    mockRecipes._set([recipeWithKit('r1', 'spinner bowl')]);
    setTools([MIXING, SALAD]);
    render(KitchenToolsPage);

    const row = await screen.findByTestId('kitchen-tool-gap-row');
    await waitFor(() => expect(vi.mocked(callProposeKitchenTools)).toHaveBeenCalledTimes(1));
    // No sentence, no spinner, no toast — the row is exactly what it was before
    // this phase existed, and the press still writes.
    expect(within(row).queryByTestId('kitchen-tool-gap-proposal')).toBeNull();
    await userEvent.click(within(row).getByTestId('kitchen-tool-gap-suggest'));
    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(upsertKitchenTool).mock.calls[0]![0].id).toBe('salad-bowl');
  });

  it('falls back to the head noun when Salt names a tool that has since gone', async () => {
    // The vocabulary is a live subscription and the answer is a page-load old, so
    // the tool Salt named can be deleted before the sentence is read. The row says
    // nothing rather than naming one tool and offering another.
    proposalSink.answer = {
      kind: 'ok',
      value: { proposals: [{ kind: 'alias', label: 'spinner bowl', toolId: 'gone-tool' }] },
    };
    mockRecipes._set([recipeWithKit('r1', 'spinner bowl')]);
    setTools([MIXING, SALAD]);
    render(KitchenToolsPage);

    const row = await screen.findByTestId('kitchen-tool-gap-row');
    await waitFor(() => expect(vi.mocked(callProposeKitchenTools)).toHaveBeenCalledTimes(1));
    expect(within(row).queryByTestId('kitchen-tool-gap-proposal')).toBeNull();
    expect(within(row).getByTestId('kitchen-tool-gap-suggest')).toHaveTextContent(
      'Also call it Salad bowl',
    );
  });

  it('spends nothing on a vocabulary that has caught up', async () => {
    // Every word resolves, so there is no group and no question — and an admin
    // opening this page is the common case, not the curating one.
    mockRecipes._set([recipeWithKit('r1', 'mixing bowl')]);
    setTools([MIXING, SALAD]);
    render(KitchenToolsPage);

    await screen.findByTestId('kitchen-tool-list');
    await waitFor(() => expect(screen.queryByTestId('kitchen-tool-gap-row')).toBeNull());
    expect(vi.mocked(callProposeKitchenTools)).not.toHaveBeenCalled();
  });

  it('waits for the vocabulary to finish loading before it asks — #1525 should-fix 3', async () => {
    // A not-yet-loaded `$kitchenTools` sends the model `tools: []`, under which
    // every word comes back `new` and every row loses its free alias press. The
    // tool subscription has not delivered when the page first mounts here (it is
    // never told to, unlike every other test in this file), so the effect must
    // not ask yet even once the plans promise has settled.
    mockRecipes._set([recipeWithKit('r1', 'potato masher')]);
    render(KitchenToolsPage);

    // `ListPage` shows its own loading state while `$isLoadingKitchenTools` is
    // true, so the row itself is not in the DOM yet either — the list and the
    // effect are both waiting on the same store.
    await screen.findByRole('status', { name: 'Loading' });
    expect(vi.mocked(callProposeKitchenTools)).not.toHaveBeenCalled();

    // The vocabulary arrives. Salad bowl names nothing about "potato masher", so
    // the row stays a gap and the effect re-evaluates now loading has cleared.
    setTools([SALAD]);
    await waitFor(() => expect(vi.mocked(callProposeKitchenTools)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(callProposeKitchenTools).mock.calls[0]![0].labels).toEqual(['potato masher']);
  });

  it('re-arms when a gap row arrives after the queue was first found empty — #1525 should-fix 3', async () => {
    // Nothing unresolved when the page's queue is first computed: no recipe holds
    // a kit label at all. The empty-queue return must not latch `askedProposals`,
    // or a kit word saved onto a recipe while this page sits open would never be
    // asked about.
    mockRecipes._set([]);
    setTools([MIXING, SALAD]);
    render(KitchenToolsPage);

    await screen.findByTestId('kitchen-tool-list');
    await waitFor(() => expect(screen.queryByTestId('kitchen-tool-gap-row')).toBeNull());
    expect(vi.mocked(callProposeKitchenTools)).not.toHaveBeenCalled();

    // A gap word arrives on the live `$recipes` subscription.
    mockRecipes._set([recipeWithKit('r1', 'tagine dish')]);
    await screen.findByTestId('kitchen-tool-gap-row');
    await waitFor(() => expect(vi.mocked(callProposeKitchenTools)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(callProposeKitchenTools).mock.calls[0]![0].labels).toEqual(['tagine dish']);
  });

  it('asks once for the whole group, and does not ask again after a row is curated', async () => {
    proposalSink.answer = {
      kind: 'ok',
      value: { proposals: [{ kind: 'alias', label: 'spinner bowl', toolId: 'mixing-bowl' }] },
    };
    mockRecipes._set([recipeWithKit('r1', 'spinner bowl', 'tagine dish')]);
    setTools([MIXING, SALAD]);
    render(KitchenToolsPage);

    await screen.findAllByTestId('kitchen-tool-gap-row');
    await waitFor(() => expect(vi.mocked(callProposeKitchenTools)).toHaveBeenCalledTimes(1));
    const asked = vi.mocked(callProposeKitchenTools).mock.calls[0]![0];
    expect(asked.labels).toEqual(['spinner bowl', 'tagine dish']);

    // Curating one row leaves the other's answer alone and buys no second call.
    setTools([MIXING, SALAD, tool('tagine', 'Tagine', ['tagine dish'])]);
    await waitFor(() => expect(screen.getAllByTestId('kitchen-tool-gap-row')).toHaveLength(1));
    expect(vi.mocked(callProposeKitchenTools)).toHaveBeenCalledTimes(1);
  });
});

// The row on its own, for the one state the page cannot produce. Rendered
// directly rather than through the page because the page's whole job here is to
// make this state unreachable — it drops an alias whose tool it cannot find — and
// a component that would print "another name for undefined" if that guarantee
// ever moved is worth pinning where the guarantee is not in force.
describe('KitchenToolGapRow — the sentence and the button are one statement', () => {
  it('says nothing about an alias it has no tool for', () => {
    render(KitchenToolGapRow, {
      props: {
        label: 'spinner bowl',
        count: 2,
        suggestion: null,
        proposal: { kind: 'alias', label: 'spinner bowl', toolId: 'gone-tool' },
        suggestBusy: false,
        suggestDisabled: false,
        onAcceptSuggestion: () => {},
        onMakeTool: () => {},
        onAlias: () => {},
      },
    });
    expect(screen.queryByTestId('kitchen-tool-gap-proposal')).toBeNull();
    // And the row is still a row: the expensive verb leads, because there is no
    // tool to hand the word to.
    expect(screen.getByTestId('kitchen-tool-gap-new')).toHaveTextContent('Make it a tool');
  });
});
