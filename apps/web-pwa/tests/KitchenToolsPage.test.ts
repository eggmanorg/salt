import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { normaliseMemberEmail } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { KitchenToolDoc, GuidedPlanDoc } from '@salt/domain/schemas';

// The kitchen-tool admin page (issue #882 Phase 4, redesigned in #1489).
//
// It drives the REAL `kitchenToolService` and the REAL domain commands through a
// mocked `@salt/firebase-sync`, exactly as `RecipeViewPage.kit.test.ts` does. That
// is the point rather than a convenience: the promise being tested is that adding
// a name makes existing content resolve, and it is only true if the queue, the
// resolver and the write are the same code the app runs. Assertions land on the
// WRITE that reaches the adapter, which is the boundary that matters.
//
// THE EDITOR IS REACHED BY THE ROUTE, not by clicking a row. jsdom ships no
// `matchMedia`, so `docked` is false and choosing a row navigates rather than
// docking — which is the phone path and is correct. Rendering with
// `params: { id }` is therefore the honest way in, and it exercises the
// `/admin/kitchen-tools/:id` entry #1489 added at the same time. The docked half
// of that gate has its own file (`KitchenToolsPage.docked.test.ts`).

const { mockRecipes, mockMembers, mockIsLoading, mockAuth, toolSink, plansResult } =
  await vi.hoisted(async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockRecipes: makeStore<readonly Recipe[]>([]),
      // AdminGuard reads these.
      mockMembers: makeStore<{ email: string; admin: boolean }[]>([]),
      mockIsLoading: makeStore<boolean>(false),
      mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
      // The one seam the vocabulary arrives through, as in the kit test.
      toolSink: { push: null as null | ((tools: readonly unknown[]) => void) },
      plansResult: { value: [] as GuidedPlanDoc[] },
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
  loadAllGuidedPlansForCuration: vi.fn(async () => ({ kind: 'ok', value: plansResult.value })),
}));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: () => ({ reportError: vi.fn() }),
}));
vi.mock('@salt/firebase-sync', () => ({
  subscribeKitchenTools: vi.fn((onTools: (tools: readonly unknown[]) => void) => {
    toolSink.push = onTools;
    return () => {};
  }),
  upsertKitchenTool: vi.fn(async () => ({ kind: 'ok' as const, value: undefined })),
  deleteKitchenTool: vi.fn(async () => ({ kind: 'ok', value: undefined })),
}));

import { upsertKitchenTool, deleteKitchenTool } from '@salt/firebase-sync';
import { push } from 'svelte-spa-router';
import { addToast } from '../src/lib/toastStore.js';
import {
  initKitchenToolSync,
  __resetKitchenToolServiceForTest,
} from '../src/lib/kitchenToolService.js';
import KitchenToolsPage from '../src/routes/admin/KitchenToolsPage.svelte';

function setTools(tools: readonly KitchenToolDoc[]): void {
  toolSink.push?.(tools);
}

function tool(over: Partial<KitchenToolDoc> & { id: string; label: string }): KitchenToolDoc {
  return {
    schemaVersion: 1,
    matchers: [],
    thumbnail: 'https://example.com/kit/x.webp',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as KitchenToolDoc;
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

function planWithContainers(id: string, prep: (string | null)[], notes: (string | null)[] = []) {
  return {
    id,
    schemaVersion: 1,
    recipeId: id,
    recipeUpdatedAtAtSave: '2026-01-01T00:00:00.000Z',
    prep: prep.map((container, i) => ({
      id: `p${i}`,
      text: 'do a thing',
      container,
      ingredientIds: [],
    })),
    stepNotes: notes.map((container, i) => ({
      stepId: `step-${i}`,
      container,
      setup: null,
      cue: null,
      checkIns: [],
      lookahead: null,
      getAhead: null,
    })),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as GuidedPlanDoc;
}

afterEach(() => {
  cleanup();
  __resetKitchenToolServiceForTest();
  toolSink.push = null;
  // bits-ui Dialog toggles body styles via rAF, which jsdom never fires.
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  // bits-ui's scroll lock is body-global and its release is rAF-driven, which
  // jsdom never runs — so a dialog opened by one test leaves `pointer-events:
  // none` behind and the next test's clicks land on nothing. Cleared on the way
  // in as well as on the way out.
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
  document.body.style.paddingRight = '';
  mockAuth.user = { email: 'admin@e.org' };
  mockIsLoading._set(false);
  mockMembers._set([{ email: 'admin@e.org', admin: true }]);
  mockRecipes._set([]);
  plansResult.value = [];
  initKitchenToolSync();
  // The subscription's first delivery, which is what clears the page's loading
  // state — an empty vocabulary is a real answer, not a still-loading one. Tests
  // that want tools push them over the top of this.
  setTools([]);
});

/** The queue rows, in the order they are drawn. */
function queueRows(): { label: string; count: string }[] {
  return screen.queryAllByTestId('kitchen-tool-queue-row').map((row) => ({
    label: row.getAttribute('data-kit-label') ?? '',
    count: within(row).getByTestId('kitchen-tool-queue-count').textContent?.trim() ?? '',
  }));
}

/**
 * The vocabulary rows, wide copy. `EditableRow` renders the narrow and the wide
 * snippet BOTH into the DOM and hides one with CSS, so a query that did not name
 * a copy would return every row twice.
 */
function toolRows(): HTMLElement[] {
  return screen.queryAllByTestId('kitchen-tool-row-wide');
}

/** Render with the editor already open on `id` — the `/admin/kitchen-tools/:id` door. */
function renderOn(id: string) {
  return render(KitchenToolsPage, { props: { params: { id } } });
}

describe('KitchenToolsPage — the vocabulary list', () => {
  it('lists every tool with its pictogram, cache-busted', async () => {
    render(KitchenToolsPage);
    setTools([
      tool({
        id: 'whisk',
        label: 'Whisk',
        thumbnail: 'https://example.com/kit/whisk.webp',
        updatedAt: '2026-02-02T00:00:00.000Z',
      }),
      tool({ id: 'colander', label: 'Colander', thumbnail: null }),
    ]);

    await waitFor(() => expect(toolRows()).toHaveLength(2));
    expect(toolRows().map((r) => r.getAttribute('data-kit-tool-id'))).toEqual([
      'colander',
      'whisk',
    ]);

    // The nonce is what makes a regenerated icon show up at all: the URL is
    // byte-identical and served `immutable` (ui-spec-v04 §14.4).
    const img = within(toolRows()[1]!).getByTestId('canon-icon-img');
    expect(img).toHaveAttribute(
      'src',
      'https://example.com/kit/whisk.webp?v=2026-02-02T00:00:00.000Z',
    );
    // A tool with no drawing yet still holds its row — the bare tile keeps the
    // text column straight while the trigger works.
    expect(within(toolRows()[0]!).queryByTestId('canon-icon-img')).toBeNull();
  });

  it('prefers the regenerate nonce over updatedAt for the cache-bust', async () => {
    render(KitchenToolsPage);
    setTools([
      tool({
        id: 'whisk',
        label: 'Whisk',
        thumbnail: 'https://example.com/kit/whisk.webp',
        updatedAt: '2026-02-02T00:00:00.000Z',
        iconRequestedAt: 1750000000000,
      }),
    ]);

    await waitFor(() => expect(toolRows()).toHaveLength(1));
    const img = within(toolRows()[0]!).getByTestId('canon-icon-img');
    expect(img).toHaveAttribute('src', 'https://example.com/kit/whisk.webp?v=1750000000000');
  });

  it('carries NOTHING on the row but the picture, the name and the count', async () => {
    // The complaint this redesign exists to answer: six bare icon buttons on
    // every line. None of them is on a row any more — every picture control is a
    // labelled button in the editor's Picture section.
    render(KitchenToolsPage);
    setTools([tool({ id: 'whisk', label: 'Whisk', matchers: ['balloon whisk'] })]);

    await waitFor(() => expect(toolRows()).toHaveLength(1));
    const row = toolRows()[0]!;
    expect(within(row).getByTestId('kitchen-tool-row-count-wide')).toHaveTextContent(
      '1 other name',
    );
    for (const gone of [
      'kitchen-tool-icon-regenerate',
      'kitchen-tool-icon-prompt',
      'kitchen-tool-icon-upload',
      'kitchen-tool-icon-hide',
      'kitchen-tool-edit',
    ]) {
      expect(within(row).queryByTestId(gone)).toBeNull();
    }
  });

  it('opens a row onto every name it answers to, one per line', async () => {
    render(KitchenToolsPage);
    setTools([
      tool({ id: 'potato-masher', label: 'Potato masher', matchers: ['masher', 'ricer'] }),
    ]);

    await waitFor(() => expect(toolRows()).toHaveLength(1));
    expect(screen.queryByTestId('kitchen-tool-row-body')).toBeNull();
    await userEvent.click(screen.getByTestId('kitchen-tool-row-disclosure-wide'));

    const body = await screen.findByTestId('kitchen-tool-row-body');
    // One line each, in the stored order — never a truncated comma list.
    expect(
      within(body)
        .getAllByTestId('kitchen-tool-list-name-row')
        .map((r) => r.getAttribute('data-kit-matcher')),
    ).toEqual(['masher', 'ricer']);
  });

  it('removes one name from an expanded row, leaving the others', async () => {
    render(KitchenToolsPage);
    setTools([
      tool({ id: 'potato-masher', label: 'Potato masher', matchers: ['masher', 'ricer'] }),
    ]);

    await waitFor(() => expect(toolRows()).toHaveLength(1));
    await userEvent.click(screen.getByTestId('kitchen-tool-row-disclosure-wide'));
    const body = await screen.findByTestId('kitchen-tool-row-body');
    await userEvent.click(within(body).getAllByTestId('kitchen-tool-list-name-remove')[0]!);

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    const written = vi.mocked(upsertKitchenTool).mock.calls[0]![0];
    expect(written.id).toBe('potato-masher');
    expect(written.matchers).toEqual(['ricer']);
  });

  it('filters on a name as well as on the tool’s own label', async () => {
    render(KitchenToolsPage);
    setTools([
      tool({ id: 'potato-masher', label: 'Potato masher', matchers: ['ricer'] }),
      tool({ id: 'whisk', label: 'Whisk' }),
    ]);

    await waitFor(() => expect(toolRows()).toHaveLength(2));
    await fireEvent.input(screen.getByTestId('kitchen-tool-filter-text'), {
      target: { value: 'ricer' },
    });

    await waitFor(() => expect(toolRows()).toHaveLength(1));
    expect(toolRows()[0]).toHaveAttribute('data-kit-tool-id', 'potato-masher');
  });

  it('the “Has other names” pill leaves only tools that answer to more than one word', async () => {
    render(KitchenToolsPage);
    setTools([
      tool({ id: 'potato-masher', label: 'Potato masher', matchers: ['ricer'] }),
      tool({ id: 'whisk', label: 'Whisk' }),
    ]);

    await waitFor(() => expect(toolRows()).toHaveLength(2));
    await userEvent.click(screen.getByTestId('kitchen-tool-filter-has-names'));

    await waitFor(() => expect(toolRows()).toHaveLength(1));
    expect(toolRows()[0]).toHaveAttribute('data-kit-tool-id', 'potato-masher');
  });
});

describe('KitchenToolsPage — the unresolved queue', () => {
  it('ranks by frequency and leaves out anything the vocabulary already names', async () => {
    mockRecipes._set([
      recipeWithKit('r1', 'tagine', 'colander'),
      recipeWithKit('r2', 'tagine', 'mandoline'),
      recipeWithKit('r3', 'Tagine'),
    ]);
    setTools([tool({ id: 'colander', label: 'Colander' })]);
    render(KitchenToolsPage);

    await waitFor(() => expect(queueRows().length).toBe(2));
    // Three mentions of one word in two spellings, one row. "colander" is absent
    // because it already draws — which is the queue agreeing with the screen.
    expect(queueRows()).toEqual([
      { label: 'tagine', count: '3' },
      { label: 'mandoline', count: '1' },
    ]);
  });

  it('counts guided-plan containers alongside the recipe kit labels', async () => {
    mockRecipes._set([recipeWithKit('r1', 'tagine')]);
    plansResult.value = [planWithContainers('r1', [null, 'tagine'], ['  '])];
    render(KitchenToolsPage);

    await waitFor(() => expect(queueRows()).toEqual([{ label: 'tagine', count: '2' }]));
  });

  it('drops a row the moment the vocabulary can name it — no reread, no rewrite', async () => {
    mockRecipes._set([recipeWithKit('r1', 'tagine')]);
    render(KitchenToolsPage);

    await waitFor(() => expect(queueRows()).toHaveLength(1));
    setTools([tool({ id: 'tagine', label: 'Tagine' })]);
    await waitFor(() => expect(queueRows()).toHaveLength(0));
    // Nothing was written to the recipe to make that happen.
    expect(vi.mocked(upsertKitchenTool)).not.toHaveBeenCalled();
  });

  it('pre-fills the add form with the unresolved name', async () => {
    mockRecipes._set([recipeWithKit('r1', 'potato masher')]);
    render(KitchenToolsPage);

    await waitFor(() => expect(queueRows()).toHaveLength(1));
    await userEvent.click(screen.getByTestId('kitchen-tool-queue-new'));

    const input = await screen.findByTestId('kitchen-tool-label-input');
    expect(input).toHaveValue('potato masher');
    // One field. The comma-separated "Also called" box is gone: names are added
    // one at a time in the editor, and two editors over one value drift.
    expect(screen.queryByTestId('kitchen-tool-matchers-input')).toBeNull();

    // Closed on the way out. A bits-ui dialog torn down while still open leaves
    // its layer on the library's global stack, and the NEXT test's dialog is then
    // never the topmost one — its clicks are swallowed and it fails looking like a
    // page bug. Cheap to avoid, expensive to diagnose.
    await userEvent.click(screen.getByText('Cancel'));
  });

  it('adding from the queue mints a slug id, a blank thumbnail, and lands on the editor', async () => {
    mockRecipes._set([recipeWithKit('r1', 'potato masher')]);
    render(KitchenToolsPage);

    await waitFor(() => expect(queueRows()).toHaveLength(1));
    await userEvent.click(screen.getByTestId('kitchen-tool-queue-new'));
    await screen.findByTestId('kitchen-tool-label-input');
    await userEvent.click(screen.getByTestId('kitchen-tool-save'));

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(upsertKitchenTool).mock.calls[0]![0]).toMatchObject({
      id: 'potato-masher',
      label: 'potato masher',
      // The trigger's edge guard reads exactly this null to decide to draw.
      thumbnail: null,
    });
    // ...and the editor opens on what was just made, rather than dropping the
    // reader back on the list to find it.
    await waitFor(() =>
      expect(vi.mocked(push)).toHaveBeenCalledWith('/admin/kitchen-tools/potato-masher'),
    );

    // Wait for the dialog to finish closing before the test ends, so its teardown
    // is not racing the next test's render.
    await waitFor(() => expect(screen.queryByTestId('kitchen-tool-add-dialog')).toBeNull());
  });

  it('leads with a one-click alias when the row has a likely parent', async () => {
    // Production's real drift, reproduced: a `Large mixing bowl` document minted
    // from the queue one row at a time, which then cannot name plain "mixing
    // bowl" — the commonest kit label in the library. Curated a row at a time
    // that is a second document and a second AI drawing of a bowl.
    mockRecipes._set([recipeWithKit('r1', 'mixing bowl')]);
    setTools([tool({ id: 'large-mixing-bowl', label: 'Large mixing bowl' })]);
    render(KitchenToolsPage);

    await waitFor(() => expect(queueRows()).toHaveLength(1));
    const suggest = screen.getByTestId('kitchen-tool-queue-suggest');
    // The button NAMES the tool, so accepting it is not a leap of faith.
    expect(suggest).toHaveTextContent('Alias to Large mixing bowl');
    // ...and the two expensive-or-slow actions are demoted behind it.
    expect(screen.getByTestId('kitchen-tool-queue-new').className).toContain('salt-button--ghost');

    await userEvent.click(suggest);

    // ONE write, to the tool that already exists, and it is the matcher append —
    // no second document, no second drawing.
    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    const written = vi.mocked(upsertKitchenTool).mock.calls[0]![0];
    expect(written).toMatchObject({
      id: 'large-mixing-bowl',
      matchers: ['mixing bowl'],
      thumbnail: 'https://example.com/kit/x.webp',
    });
  });

  it('keeps "New tool" the first move when nothing looks like a parent', async () => {
    mockRecipes._set([recipeWithKit('r1', 'pasta machine')]);
    setTools([tool({ id: 'large-mixing-bowl', label: 'Large mixing bowl' })]);
    render(KitchenToolsPage);

    await waitFor(() => expect(queueRows()).toHaveLength(1));
    expect(screen.queryByTestId('kitchen-tool-queue-suggest')).toBeNull();
    // A pasta machine is genuinely a new object; minting one is the right call and
    // the row says so.
    expect(screen.getByTestId('kitchen-tool-queue-new').className).toContain('salt-button--solid');
  });

  it('warns that a new name already belongs to a drawn tool — and still saves', async () => {
    // The `Large frying pan` accident: a second document, a second image, and
    // plain "frying pan" STILL undrawn, because a specific tool covers nothing but
    // itself. The warning is the only thing in the flow that says so.
    //
    // It must not refuse. `Small bowl` beside `Mixing bowl` is a deliberate second
    // tool that the seeded vocabulary itself contains, and a hard guard would
    // forbid its own contents.
    setTools([tool({ id: 'frying-pan', label: 'Frying pan' })]);
    render(KitchenToolsPage);

    await userEvent.click(screen.getByTestId('kitchen-tool-add'));
    const input = await screen.findByTestId('kitchen-tool-label-input');
    // `fireEvent.input`, not `userEvent.type`: a bits-ui dialog's focus trap eats
    // per-keystroke events in jsdom once another dialog has been opened earlier in
    // the file, and the field then stays empty while the test reads like a broken
    // warning. Nothing here is testing the keyboard.
    await fireEvent.input(input, { target: { value: 'Large frying pan' } });

    const warning = await screen.findByTestId('kitchen-tool-duplicate-warning');
    expect(warning).toHaveTextContent('Frying pan');

    await userEvent.click(screen.getByTestId('kitchen-tool-save'));
    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(upsertKitchenTool).mock.calls[0]![0]).toMatchObject({
      id: 'large-frying-pan',
      label: 'Large frying pan',
    });

    await waitFor(() => expect(screen.queryByTestId('kitchen-tool-add-dialog')).toBeNull());
  });

  // The queue's OTHER action — aliasing onto an existing tool — lives in
  // `KitchenToolsPage.alias.test.ts`. It needs a combobox inside a dialog, and a
  // bits-ui combobox only commits a selection while its layer is the topmost one
  // on the library's GLOBAL stack; a dialog opened and closed earlier in the same
  // file leaves that stack a layer deep and the selection silently never lands.
  // The isolation that fixes it is per-FILE, not per-test — hence the second file
  // rather than a reordering that would rot the moment a test is inserted.
});

describe('KitchenToolsPage — the editor', () => {
  it('renames on Enter, with no Save button anywhere', async () => {
    setTools([tool({ id: 'whisk', label: 'Whisk' })]);
    renderOn('whisk');

    await userEvent.click(await screen.findByLabelText('Edit name'));
    const input = await screen.findByTestId('kitchen-tool-name-input');
    await fireEvent.input(input, { target: { value: 'Balloon whisk' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    const written = vi.mocked(upsertKitchenTool).mock.calls[0]![0];
    // The id does NOT move with the label — it is the Storage key for the
    // drawing, so the tool keeps the picture it already had.
    expect(written.id).toBe('whisk');
    expect(written.label).toBe('Balloon whisk');
  });

  it('never throws away a rename that ended with a click somewhere else', async () => {
    setTools([tool({ id: 'whisk', label: 'Whisk' })]);
    renderOn('whisk');

    await userEvent.click(await screen.findByLabelText('Edit name'));
    const input = await screen.findByTestId('kitchen-tool-name-input');
    await fireEvent.input(input, { target: { value: 'Balloon whisk' } });
    await fireEvent.blur(input);

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(upsertKitchenTool).mock.calls[0]![0].label).toBe('Balloon whisk');
  });

  it('adds one name at a time, on Enter, and clears the field', async () => {
    setTools([tool({ id: 'potato-masher', label: 'Potato masher', matchers: ['ricer'] })]);
    renderOn('potato-masher');

    const input = await screen.findByTestId('kitchen-tool-add-name-input');
    await fireEvent.input(input, { target: { value: 'masher' } });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    const written = vi.mocked(upsertKitchenTool).mock.calls[0]![0];
    expect(written.id).toBe('potato-masher');
    // Appended, never a rewrite of the whole list — the comma field that did that
    // is what this replaces.
    expect(written.matchers).toEqual(['ricer', 'masher']);
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('removes a name from the editor’s own list', async () => {
    setTools([
      tool({ id: 'potato-masher', label: 'Potato masher', matchers: ['masher', 'ricer'] }),
    ]);
    renderOn('potato-masher');

    const rows = await screen.findAllByTestId('kitchen-tool-editor-name-row');
    expect(rows.map((r) => r.getAttribute('data-kit-matcher'))).toEqual(['masher', 'ricer']);
    await userEvent.click(screen.getAllByTestId('kitchen-tool-editor-name-remove')[1]!);

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(upsertKitchenTool).mock.calls[0]![0].matchers).toEqual(['masher']);
  });

  it('deletes behind an undo toast with no "are you sure?", and Undo really keeps it', async () => {
    setTools([tool({ id: 'whisk', label: 'Whisk' })]);
    renderOn('whisk');

    await userEvent.click(await screen.findByTestId('kitchen-tool-delete'));

    // No confirm dialog — Salt records, it does not police.
    expect(screen.queryByTestId('kitchen-tool-delete-dialog')).toBeNull();
    // Nothing is written until the toast lapses, so there is no un-delete path to
    // invent and no tombstone.
    expect(vi.mocked(deleteKitchenTool)).not.toHaveBeenCalled();

    const toast = vi.mocked(addToast).mock.calls.at(-1)!;
    expect(toast[0]).toContain('keeps its words and loses the picture');
    const opts = toast[2] as { action: { label: string; onClick: () => void } };
    expect(opts.action.label).toBe('Undo');

    // Hidden while pending, and back the moment Undo is pressed.
    await waitFor(() => expect(toolRows()).toHaveLength(0));
    opts.action.onClick();
    await waitFor(() => expect(toolRows()).toHaveLength(1));
    expect(vi.mocked(deleteKitchenTool)).not.toHaveBeenCalled();
  });
});

describe('KitchenToolsPage — the Picture section', () => {
  it('regenerate clears the thumbnail AND bumps the nonce', async () => {
    // The nonce is the load-bearing half: a tool whose drawing never arrived
    // already has `thumbnail: null`, so writing null again mutates nothing,
    // Firestore emits no event and the trigger never runs.
    setTools([tool({ id: 'whisk', label: 'Whisk', thumbnail: null })]);
    renderOn('whisk');

    await userEvent.click(await screen.findByTestId('kitchen-tool-icon-regenerate'));
    await userEvent.click(await screen.findByTestId('kitchen-tool-regenerate-confirm'));

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    const written = vi.mocked(upsertKitchenTool).mock.calls[0]![0];
    expect(written.thumbnail).toBeNull();
    expect(typeof written.iconRequestedAt).toBe('number');
    // No hint typed → any stale steer is dropped rather than silently inherited.
    expect(written.iconHint).toBeUndefined();
  });

  it('hide writes the shared sentinel so the trigger skips it forever', async () => {
    setTools([tool({ id: 'whisk', label: 'Whisk' })]);
    renderOn('whisk');

    await userEvent.click(await screen.findByTestId('kitchen-tool-icon-hide'));

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(upsertKitchenTool).mock.calls[0]![0].thumbnail).toBe('hidden');
  });

  it('a hidden tool offers un-hide, which goes back through the regenerate write', async () => {
    setTools([tool({ id: 'whisk', label: 'Whisk', thumbnail: 'hidden' })]);
    renderOn('whisk');

    expect(screen.queryByTestId('kitchen-tool-icon-hide')).toBeNull();
    await userEvent.click(await screen.findByTestId('kitchen-tool-icon-unhide'));

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    const written = vi.mocked(upsertKitchenTool).mock.calls[0]![0];
    expect(written.thumbnail).toBeNull();
    expect(typeof written.iconRequestedAt).toBe('number');
  });

  it('gives all four controls words rather than a bare glyph', async () => {
    setTools([tool({ id: 'whisk', label: 'Whisk' })]);
    renderOn('whisk');

    const section = await screen.findByTestId('kitchen-tool-icon-section');
    for (const word of ['Regenerate', 'Prompt', 'Upload', 'Hide']) {
      expect(within(section).getByText(word)).toBeInTheDocument();
    }
  });
});

// The dialog's own surface, characterized (issue #930, Phase 1). Phase 7 folds
// this dialog and `RecordEditor`'s near-identical copy into one component; what
// differs between the two — placeholder wording, test-id prefix, busy source,
// open binding — must survive as per-site props rather than be harmonised away,
// and these are the assertions that say so. The matching pins for the other
// copy live in `CatalogPage.icon.test.ts`.
describe('KitchenToolsPage — the regenerate dialog’s own surface', () => {
  async function openDialog() {
    setTools([tool({ id: 'whisk', label: 'Whisk' })]);
    renderOn('whisk');
    await userEvent.click(await screen.findByTestId('kitchen-tool-icon-regenerate'));
    return screen.findByTestId('kitchen-tool-regenerate-dialog');
  }

  it('is titled and framed as an optional steer, not a confirmation', async () => {
    const q = within(await openDialog());
    expect(q.getByText('Regenerate icon')).toBeInTheDocument();
    expect(
      q.getByText('Optionally add guidance for the new icon. Leave blank to just try again.'),
    ).toBeInTheDocument();
    expect(q.getByText('Extra guidance (optional)')).toBeInTheDocument();
    expect(q.getByText('Regenerate')).toBeInTheDocument();
    expect(q.getByText('Cancel')).toBeInTheDocument();
  });

  it('carries the kitchen-tool placeholder, which is not the canon one', async () => {
    await openDialog();
    expect(screen.getByTestId('kitchen-tool-regenerate-hint')).toHaveAttribute(
      'placeholder',
      'e.g. show it from the side, wooden handle',
    );
  });

  it('prefixes all three of its test ids with the page’s own fixed prefix', async () => {
    await openDialog();
    for (const suffix of ['dialog', 'hint', 'confirm']) {
      expect(screen.getByTestId(`kitchen-tool-regenerate-${suffix}`)).toBeInTheDocument();
    }
  });

  it('Enter in the hint field regenerates without reaching the confirm button', async () => {
    await openDialog();
    const hint = screen.getByTestId('kitchen-tool-regenerate-hint');
    // fireEvent, not userEvent: the field sits inside a bits-ui focus trap
    // (docs/unit-test-spec.md UT-F2).
    await fireEvent.input(hint, { target: { value: 'wooden handle' } });
    await fireEvent.keyDown(hint, { key: 'Enter' });

    await waitFor(() => expect(vi.mocked(upsertKitchenTool)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(upsertKitchenTool).mock.calls[0]![0].iconHint).toBe('wooden handle');
  });
});
