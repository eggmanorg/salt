import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { checkInTimerId } from '@salt/domain';
import type { CookSessionDoc, IngredientDoc, RecipeDoc } from '@salt/domain/schemas';

// Cook mode is the only full-viewport page in the app and the only one that owns its
// own gesture layer, so these tests deliberately draw a line: everything the cook can
// DO is exercised here (ticking, advancing, timers, restart, finish), and everything
// that depends on the browser having laid something out is not. jsdom measures every
// box as 0, which means `visibleStepId` never resolves from a probe and `stops` is
// always `[0]` — so the tests are written to work WITH that, never around it. Chip
// clipping, peek height and fade height belong to the Playwright pass.

const {
  mockAuth,
  mockRecipes,
  mockIsLoadingRecipes,
  mockCookSession,
  mockCookSessionEnded,
  mockIsLoadingCookSession,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockAuth: { user: { uid: 'user-1' } as { uid: string } | null },
    mockRecipes: makeStore<RecipeDoc[]>([]),
    mockIsLoadingRecipes: makeStore<boolean>(false),
    mockCookSession: makeStore<CookSessionDoc | null>(null),
    mockCookSessionEnded: makeStore<boolean>(false),
    mockIsLoadingCookSession: makeStore<boolean>(false),
  };
});

const { mockCanonItems, mockProductForms, mockWakeLock, mockChime } = vi.hoisted(() => ({
  mockCanonItems: (() => {
    // Settable since issue #871: proving the icon SWAPS from the parent's to the
    // form's needs a canon item that actually has an icon to swap away from.
    let value: unknown[] = [];
    const subs = new Set<(v: unknown[]) => void>();
    return {
      subscribe(fn: (v: unknown[]) => void) {
        subs.add(fn);
        fn(value);
        return () => {
          subs.delete(fn);
        };
      },
      _set(v: unknown[]) {
        value = v;
        subs.forEach((sub) => sub(v));
      },
    };
  })(),
  // The page prefers a product form's own icon over its parent's (issue #871).
  // Settable so a test can put a form in front of it; empty by default, which is
  // what every pre-existing assertion (all about the canon fallback) needs.
  mockProductForms: (() => {
    let value: unknown[] = [];
    const subs = new Set<(v: unknown[]) => void>();
    return {
      subscribe(fn: (v: unknown[]) => void) {
        subs.add(fn);
        fn(value);
        return () => {
          subs.delete(fn);
        };
      },
      _set(v: unknown[]) {
        value = v;
        subs.forEach((sub) => sub(v));
      },
    };
  })(),
  mockWakeLock: { enable: vi.fn(async () => true), disable: vi.fn(async () => {}) },
  // jsdom has no AudioContext, so the real chime is already a silent no-op — but
  // it is a no-op we cannot observe. Mocked so the gating around WHEN it fires is
  // testable at all.
  mockChime: { primeChime: vi.fn(), playChime: vi.fn() },
}));

// The audible alert lives in the app-level watcher (cookTimerAlerts), not here —
// this page only unlocks the audio context on the start gesture. `playChime` is
// mocked alongside it purely so a re-added chime on this page would show up as a
// failure rather than passing unnoticed.

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));
vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));
vi.mock('../src/lib/productFormService.js', () => ({ productForms: mockProductForms }));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  isLoadingRecipes: mockIsLoadingRecipes,
}));
vi.mock('../src/lib/wakeLock.js', () => ({
  isWakeLockSupported: vi.fn(() => true),
  createWakeLock: vi.fn(() => mockWakeLock),
}));
vi.mock('../src/lib/chime.js', () => mockChime);
// `persistCookSession` echoes into the session store exactly as the real service does
// (it sets the store optimistically before the write lands), because several flows here
// depend on the round-trip: a step only collapses once its completion is back in the
// store, and the bootstrap effect only stops re-firing once the store is non-null. The
// echo is deferred by a microtask so it never lands inside the synchronous body of the
// effect that triggered it.
//
// `removeCookSession` likewise clears the store SYNCHRONOUSLY, as the real one does
// before it awaits the delete. That gap is load-bearing (issue #559): it is the window
// in which the bootstrap effect can see a null store and write a replacement session
// over the top of a Complete or Restart. A mock that left the store alone hid it.
vi.mock('../src/lib/cookSessionService.js', () => ({
  cookSession: mockCookSession,
  cookSessionEnded: mockCookSessionEnded,
  isLoadingCookSession: mockIsLoadingCookSession,
  initCookSessionSync: vi.fn(() => () => {}),
  getCookSessionSnapshot: vi.fn(() => mockCookSession._get()),
  persistCookSession: vi.fn(async (session: CookSessionDoc) => {
    await Promise.resolve();
    mockCookSession._set(session);
    return { kind: 'ok' as const, value: undefined };
  }),
  removeCookSession: vi.fn(async () => {
    mockCookSession._set(null);
    await Promise.resolve();
    return { kind: 'ok' as const, value: undefined };
  }),
}));

import CookModePage from '../src/routes/recipes/CookModePage.svelte';
import { push } from 'svelte-spa-router';
import { addToast } from '../src/lib/toastStore.js';
import {
  initCookSessionSync,
  persistCookSession,
  removeCookSession,
} from '../src/lib/cookSessionService.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────────
const RECIPE_ID = 'recipe-1';
const UID = 'user-1';
const SESSION_ID = `${RECIPE_ID}_${UID}`;
const RECIPE_UPDATED_AT = '2026-07-01T10:00:00.000Z';
const RECIPE_EDITED_AT = '2026-07-02T18:30:00.000Z';

function makeIngredient(over: Partial<IngredientDoc> = {}): IngredientDoc {
  return {
    id: 'ing-1',
    rawText: '2 onions',
    parsed: null,
    canonId: null,
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: 'step-1',
    ...over,
  };
}

function makeRecipe(over: Partial<RecipeDoc> = {}): RecipeDoc {
  return {
    lastEditedBy: '',
    createdBy: '',
    kit: [],
    componentRecipeIds: [],
    kind: 'recipe',
    id: RECIPE_ID,
    schemaVersion: 1,
    title: 'Weeknight ragù',
    description: null,
    ingredients: [
      {
        id: 'group-1',
        name: 'For the sauce',
        items: [
          makeIngredient({ id: 'ing-1', rawText: '2 onions', firstUsedInStepId: 'step-1' }),
          makeIngredient({
            id: 'ing-2',
            rawText: '400g tinned tomatoes',
            firstUsedInStepId: 'step-2',
          }),
        ],
      },
    ],
    steps: [
      { id: 'step-1', text: 'Soften the onions.', timer: null, note: null },
      {
        id: 'step-2',
        text: 'Simmer the sauce.',
        timer: { durationMinutes: 20, description: null },
        note: null,
      },
    ],
    metadata: {
      servings: 2,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    image: null,
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: RECIPE_UPDATED_AT,
    ...over,
  };
}

function makeCookSession(over: Partial<CookSessionDoc> = {}): CookSessionDoc {
  return {
    id: SESSION_ID,
    schemaVersion: 1,
    ownerUid: UID,
    recipeId: RECIPE_ID,
    recipeUpdatedAtAtStart: RECIPE_UPDATED_AT,
    checkedIngredientIds: [],
    // Guided cook's own tick lists (issues #751, #761). Present on the fixture so
    // normal cook mode is exercised against the document shape it will actually
    // meet — it writes neither, and must not read either as its own.
    checkedPrepIds: [],
    completedStepIds: [],
    activeTimers: [],
    serveAt: null,
    createdAt: '2026-07-01T11:00:00.000Z',
    updatedAt: '2026-07-01T11:00:00.000Z',
    ...over,
  };
}

// ─── Harness ───────────────────────────────────────────────────────────────────
function renderCookMode() {
  return render(CookModePage, { props: { params: { id: RECIPE_ID } } });
}

/** The session as it was handed to the most recent write. */
function lastPersisted(): CookSessionDoc {
  const calls = vi.mocked(persistCookSession).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1]![0];
}

/** Open an existing session straight into the guided-steps stage. */
async function enterSteps() {
  await userEvent.click(screen.getByTestId('cook-stage-toggle'));
  await screen.findByTestId('cook-steps-view');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = { uid: UID };
  mockCanonItems._set([]);
  mockProductForms._set([]);
  mockRecipes._set([makeRecipe()]);
  mockIsLoadingRecipes._set(false);
  mockCookSession._set(makeCookSession());
  mockCookSessionEnded._set(false);
  mockIsLoadingCookSession._set(false);
});

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.innerHTML = '';
});

describe('CookModePage — starting a cook', () => {
  it('subscribes to the one session that belongs to this cook and this recipe', () => {
    renderCookMode();
    expect(vi.mocked(initCookSessionSync)).toHaveBeenCalledWith(SESSION_ID);
  });

  it('opens a fresh session stamped with the recipe as it stands right now', async () => {
    mockCookSession._set(null);
    renderCookMode();

    await waitFor(() => expect(vi.mocked(persistCookSession)).toHaveBeenCalled());
    expect(lastPersisted()).toMatchObject({
      id: SESSION_ID,
      ownerUid: UID,
      recipeId: RECIPE_ID,
      recipeUpdatedAtAtStart: RECIPE_UPDATED_AT,
      checkedIngredientIds: [],
      completedStepIds: [],
      activeTimers: [],
    });
  });

  it('resumes the session already open rather than starting a second one', async () => {
    renderCookMode();
    await screen.findByTestId('cook-mode-page');
    expect(vi.mocked(persistCookSession)).not.toHaveBeenCalled();
  });

  it('says so when the session could not be started', async () => {
    mockCookSession._set(null);
    vi.mocked(persistCookSession).mockImplementationOnce(async (session) => {
      await Promise.resolve();
      mockCookSession._set(session);
      return { kind: 'err' as const, error: { kind: 'NetworkError', reason: 'transient' } };
    });

    renderCookMode();

    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('Failed to start cooking.', 'destructive'),
    );
  });

  it('opens on mise en place, and moves to the guided steps on demand', async () => {
    renderCookMode();

    expect(screen.getAllByTestId('cook-mise-row')).toHaveLength(2);
    expect(screen.getByTestId('cook-mode-title')).toHaveTextContent('Weeknight ragù');
    expect(screen.getByTestId('cook-stage-toggle')).toHaveTextContent('Start cooking');

    await enterSteps();
    expect(screen.getByTestId('cook-timeline')).toBeInTheDocument();
    expect(screen.queryByTestId('cook-mise-row')).not.toBeInTheDocument();
  });

  it('drops a half-cooked recipe straight back into the steps', async () => {
    mockCookSession._set(makeCookSession({ completedStepIds: ['step-1'] }));
    renderCookMode();

    await screen.findByTestId('cook-steps-view');
    expect(screen.queryByTestId('cook-mise-row')).not.toBeInTheDocument();
  });

  it('offers to continue rather than to start once a step is already ticked', async () => {
    mockCookSession._set(makeCookSession({ completedStepIds: ['step-1'] }));
    renderCookMode();

    await userEvent.click(await screen.findByTestId('cook-stage-back'));
    expect(await screen.findByTestId('cook-stage-toggle')).toHaveTextContent('Continue cooking');
  });

  it('leaves the session behind when cook mode is merely closed', async () => {
    renderCookMode();
    await userEvent.click(screen.getByTestId('cook-mode-close'));

    expect(vi.mocked(push)).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}`);
    expect(vi.mocked(removeCookSession)).not.toHaveBeenCalled();
  });
});

describe('CookModePage — mise en place', () => {
  it('records exactly the ingredient that was ticked', async () => {
    renderCookMode();
    await userEvent.click(screen.getAllByTestId('cook-mise-row')[0]!);

    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual(['ing-1']));
  });

  it('clears an ingredient that is ticked a second time', async () => {
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1'] }));
    renderCookMode();

    await userEvent.click(screen.getAllByTestId('cook-mise-row')[0]!);
    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual([]));
  });

  it('ticks every ingredient in the recipe in one go', async () => {
    renderCookMode();
    await userEvent.click(screen.getByTestId('cook-mise-check-all'));

    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual(['ing-1', 'ing-2']));
    expect(await screen.findByTestId('cook-mise-check-all')).toHaveTextContent('Uncheck all');
  });

  it('clears the lot when everything is already ticked', async () => {
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1', 'ing-2'] }));
    renderCookMode();

    expect(screen.getByTestId('cook-mise-check-all')).toHaveTextContent('Uncheck all');
    await userEvent.click(screen.getByTestId('cook-mise-check-all'));
    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual([]));
  });

  it('counts progress over the recipe, so a tick left by a deleted ingredient cannot inflate it', () => {
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1', 'ing-gone'] }));
    renderCookMode();

    expect(screen.getByText(/1\/2 ready/)).toBeInTheDocument();
  });
});

describe('CookModePage — mise sections', () => {
  // A recipe with real sections: the two controls only exist for these.
  const SECTIONED = makeRecipe({
    ingredients: [
      {
        id: 'group-1',
        name: 'For the sauce',
        items: [makeIngredient({ id: 'ing-1' }), makeIngredient({ id: 'ing-2' })],
      },
      {
        id: 'group-2',
        name: 'To serve',
        items: [makeIngredient({ id: 'ing-3' })],
      },
    ],
  });

  it('folds a section away, and brings it back', async () => {
    mockRecipes._set([SECTIONED]);
    renderCookMode();
    expect(screen.getAllByTestId('cook-mise-row')).toHaveLength(3);

    const [sauce] = screen.getAllByTestId('cook-mise-group-toggle');
    await userEvent.click(sauce!);

    // Only the folded section's rows go; the other section is untouched.
    expect(screen.getAllByTestId('cook-mise-row')).toHaveLength(1);
    expect(sauce!).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(sauce!);
    expect(screen.getAllByTestId('cook-mise-row')).toHaveLength(3);
    expect(sauce!).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the section header — and its bulk tick — reachable while folded', async () => {
    mockRecipes._set([SECTIONED]);
    renderCookMode();

    await userEvent.click(screen.getAllByTestId('cook-mise-group-toggle')[0]!);
    await userEvent.click(screen.getAllByTestId('cook-mise-group-check-all')[0]!);

    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual(['ing-1', 'ing-2']));
  });

  it('ticks one section without touching the ticks in another', async () => {
    mockRecipes._set([SECTIONED]);
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-3'] }));
    renderCookMode();

    await userEvent.click(screen.getAllByTestId('cook-mise-group-check-all')[0]!);

    await waitFor(() =>
      expect(lastPersisted().checkedIngredientIds).toEqual(['ing-3', 'ing-1', 'ing-2']),
    );
  });

  it('clears just that section when the whole section is already ticked', async () => {
    mockRecipes._set([SECTIONED]);
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1', 'ing-2', 'ing-3'] }));
    renderCookMode();

    const [sauceCheckAll] = screen.getAllByTestId('cook-mise-group-check-all');
    expect(sauceCheckAll!).toHaveTextContent('Uncheck');
    await userEvent.click(sauceCheckAll!);

    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual(['ing-3']));
  });

  it('shows each section its own progress, not the recipe’s', async () => {
    mockRecipes._set([SECTIONED]);
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1'] }));
    renderCookMode();

    // Spelled out, not `n/m`: this is a heading, not the page header's status line.
    const headers = screen.getAllByTestId('cook-mise-group-toggle');
    expect(headers[0]!).toHaveTextContent('1 of 2');
    expect(headers[1]!).toHaveTextContent('0 of 1');
  });

  // An unnamed single group is not a section, it's the ingredient list: folding it
  // would leave an empty screen and the footer's Check all already ticks that exact
  // set, so the header stays off.
  it('leaves a recipe with one unnamed group as a plain list', () => {
    mockRecipes._set([
      makeRecipe({
        ingredients: [{ id: 'group-1', name: null, items: [makeIngredient({ id: 'ing-1' })] }],
      }),
    ]);
    renderCookMode();

    expect(screen.getByTestId('cook-mise-row')).toBeInTheDocument();
    expect(screen.queryByTestId('cook-mise-group-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cook-mise-group-check-all')).not.toBeInTheDocument();
    expect(screen.getByTestId('cook-mise-check-all')).toBeInTheDocument();
  });
});

// A section that is entirely on the bench folds itself away, so what is left on
// screen is what is left to find. Real timers throughout: the fold waits out the
// tick beat, and the point of every one of these is WHEN it fires (or doesn't),
// which a mocked clock would only let us assert against itself.
describe('CookModePage — a gathered section folding itself away', () => {
  const SECTIONED = makeRecipe({
    ingredients: [
      {
        id: 'group-1',
        name: 'For the sauce',
        items: [makeIngredient({ id: 'ing-1' }), makeIngredient({ id: 'ing-2' })],
      },
      { id: 'group-2', name: 'To serve', items: [makeIngredient({ id: 'ing-3' })] },
    ],
  });

  /** Well past the tick beat the fold waits out, so "still open" means still open. */
  function afterTheBeat(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 800));
  }

  function sauceIsOpen(): boolean {
    return (
      screen.getAllByTestId('cook-mise-group-toggle')[0]!.getAttribute('aria-expanded') === 'true'
    );
  }

  it('folds a section once its last ingredient is ticked', async () => {
    mockRecipes._set([SECTIONED]);
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1'] }));
    renderCookMode();

    await userEvent.click(screen.getAllByTestId('cook-mise-row')[1]!);

    // Only that section's rows go — "To serve" is still there to be found.
    await waitFor(() => expect(screen.getAllByTestId('cook-mise-row')).toHaveLength(1), {
      timeout: 2000,
    });
    expect(sauceIsOpen()).toBe(false);
    // The heading stays, and keeps saying how much of it is done.
    expect(screen.getAllByTestId('cook-mise-group-toggle')[0]!).toHaveTextContent('2 of 2');
  });

  it('folds a section its own bulk tick finished off', async () => {
    mockRecipes._set([SECTIONED]);
    renderCookMode();

    await userEvent.click(screen.getAllByTestId('cook-mise-group-check-all')[0]!);

    await waitFor(() => expect(sauceIsOpen()).toBe(false), { timeout: 2000 });
    expect(screen.getAllByTestId('cook-mise-row')).toHaveLength(1);
  });

  // A first look at the list shows the list. Opening a cook that was already
  // half-gathered elsewhere folds nothing — you haven't stood in front of it yet.
  it('opens an already-gathered section unfolded', async () => {
    mockRecipes._set([SECTIONED]);
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1', 'ing-2'] }));
    renderCookMode();

    await afterTheBeat();
    expect(sauceIsOpen()).toBe(true);
    expect(screen.getAllByTestId('cook-mise-row')).toHaveLength(3);
  });

  // Being gathered is not the trigger — BECOMING gathered is. Otherwise opening a
  // finished section to double-check it would snap shut in the chef's face.
  it('leaves a gathered section open once the chef has opened it back up', async () => {
    mockRecipes._set([SECTIONED]);
    renderCookMode();

    await userEvent.click(screen.getAllByTestId('cook-mise-group-check-all')[0]!);
    await waitFor(() => expect(sauceIsOpen()).toBe(false), { timeout: 2000 });

    await userEvent.click(screen.getAllByTestId('cook-mise-group-toggle')[0]!);
    await afterTheBeat();
    expect(sauceIsOpen()).toBe(true);
  });

  it('calls the fold off when something is unticked while the beat is still playing', async () => {
    mockRecipes._set([SECTIONED]);
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1'] }));
    renderCookMode();

    await userEvent.click(screen.getAllByTestId('cook-mise-row')[1]!);
    // Straight back off again, inside the beat the fold is waiting out.
    await userEvent.click(screen.getAllByTestId('cook-mise-row')[1]!);
    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual(['ing-1']));

    await afterTheBeat();
    expect(sauceIsOpen()).toBe(true);
    expect(screen.getAllByTestId('cook-mise-row')).toHaveLength(3);
  });

  // An unnamed single group has no heading, so a fold would leave an empty screen
  // and nothing to tap to get the list back.
  it('never folds an unsectioned list', async () => {
    mockRecipes._set([
      makeRecipe({
        ingredients: [{ id: 'group-1', name: null, items: [makeIngredient({ id: 'ing-1' })] }],
      }),
    ]);
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-mise-row'));
    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual(['ing-1']));

    await afterTheBeat();
    expect(screen.getByTestId('cook-mise-row')).toBeInTheDocument();
  });
});

// Ticking a mise row celebrates the way ticking a shopping item does — a haptic
// tick, the sage wash over the row, the tile springing in. These pin the two
// things that make it read as the tap's own acknowledgement rather than as
// decoration: it fires ONLY for the rows a tap actually changes, and ONLY on the
// way in. How long the beat lasts is `createCheckOffHold`'s own timer, covered in
// checkOffHold.test.ts.
describe('CookModePage — ticking an ingredient off', () => {
  // jsdom ships no `navigator.vibrate` (nor does iOS Safari — the absent case is
  // real for one in five of this app's users, and `tick()` is a silent no-op there).
  // Installed here so the gating around WHEN it fires is observable at all.
  function installVibrate(): ReturnType<typeof vi.fn> {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    return vibrate;
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'vibrate');
  });

  function tiles(): HTMLElement[] {
    return screen.getAllByTestId('cook-mise-check');
  }

  function rows(): HTMLElement[] {
    return screen.getAllByTestId('cook-mise-row');
  }

  it('washes the ticked row and springs its tile in, leaving the rest of the list still', async () => {
    renderCookMode();
    await userEvent.click(rows()[0]!);

    // The beat is on the ROW, not only on the 28px tile — that is what makes it
    // visible as anything at all.
    await waitFor(() => expect(rows()[0]!).toHaveClass('salt-tick-row'));
    expect(tiles()[0]!).toHaveClass('salt-check-pop');
    expect(rows()[1]!).not.toHaveClass('salt-tick-row');
    expect(tiles()[1]!).not.toHaveClass('salt-check-pop');
  });

  // The beat belongs to the tap. A session that arrives already carrying ticks — a
  // cook resumed, a device switched, a return from the steps stage — renders them
  // settled, or the list would celebrate its way down the screen every time it
  // mounted.
  it('opens a half-ticked list settled, with nothing celebrating', () => {
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1'] }));
    renderCookMode();

    expect(rows()[0]!).not.toHaveClass('salt-tick-row');
    expect(tiles()[0]!).not.toHaveClass('salt-check-pop');
    expect(rows()[1]!).not.toHaveClass('salt-tick-row');
  });

  it('ticks the phone once on the way in, and stays quiet on the way out', async () => {
    const vibrate = installVibrate();
    renderCookMode();

    await userEvent.click(screen.getAllByTestId('cook-mise-row')[0]!);
    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual(['ing-1']));
    expect(vibrate).toHaveBeenCalledTimes(1);

    // Unticking is undoing a mistake, not an accomplishment.
    await userEvent.click(rows()[0]!);
    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual([]));
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(rows()[0]!).not.toHaveClass('salt-tick-row');
  });

  it('celebrates what a bulk tick actually changes, and nothing already on the bench', async () => {
    const vibrate = installVibrate();
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1'] }));
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-mise-check-all'));

    await waitFor(() => expect(rows()[1]!).toHaveClass('salt-tick-row'));
    expect(rows()[0]!).not.toHaveClass('salt-tick-row');
    // One tick for the action, not one per row it moved.
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('celebrates a section the same way its own bulk tick does the writing', async () => {
    const vibrate = installVibrate();
    renderCookMode();

    await userEvent.click(screen.getAllByTestId('cook-mise-group-check-all')[0]!);

    await waitFor(() => expect(rows()[0]!).toHaveClass('salt-tick-row'));
    expect(rows()[1]!).toHaveClass('salt-tick-row');
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('clears the lot without a tick or a wash', async () => {
    const vibrate = installVibrate();
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1', 'ing-2'] }));
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-mise-check-all'));

    await waitFor(() => expect(lastPersisted().checkedIngredientIds).toEqual([]));
    expect(vibrate).not.toHaveBeenCalled();
    expect(rows()[0]!).not.toHaveClass('salt-tick-row');
  });
});

describe('CookModePage — working through the steps', () => {
  it('ticks the step being cooked and moves the footer on to the next one outstanding', async () => {
    renderCookMode();
    await enterSteps();

    expect(screen.getByTestId('cook-step-done')).toHaveTextContent('Done · next');
    await userEvent.click(screen.getByTestId('cook-step-done'));

    await waitFor(() => expect(lastPersisted().completedStepIds).toEqual(['step-1']));
    // Step 2 is the last one, so there is nothing left to advance to.
    expect(await screen.findByTestId('cook-step-done')).toHaveTextContent(/^Done$/);
  });

  it('collapses a ticked step to a row that can be re-read without unticking it', async () => {
    renderCookMode();
    await enterSteps();
    await userEvent.click(screen.getByTestId('cook-step-done'));

    const collapsed = await screen.findByTestId('cook-step-collapsed');
    vi.mocked(persistCookSession).mockClear();
    await userEvent.click(collapsed);

    expect(await screen.findByTestId('cook-step-done-badge')).toBeInTheDocument();
    expect(screen.getByTestId('cook-step-untick')).toBeInTheDocument();
    expect(vi.mocked(persistCookSession)).not.toHaveBeenCalled();
  });

  // `CookStepCollapsed` is shared with guided cook and takes its colours as PROPS
  // (issue #994) — the one place the two decks deliberately differ. Nothing pinned
  // which mode passed which, so the two call sites could be swapped and the whole
  // suite stayed green. This is plain cook mode's half of the pin: the teal primary.
  // Its opposite number is the same assertion in GuidedCookPage.test.ts.
  it('tints a collapsed step with plain cook mode’s own teal accent', async () => {
    mockCookSession._set(makeCookSession({ completedStepIds: ['step-1'] }));
    renderCookMode();

    const collapsed = await screen.findByTestId('cook-step-collapsed');
    expect(collapsed).toHaveClass('border-primary/40', 'bg-primary/5');
    expect(within(collapsed).getByText('Step 1')).toHaveClass('text-muted-foreground');
  });

  it('unticks a step only from the expanded view it was deliberately re-opened into', async () => {
    mockCookSession._set(makeCookSession({ completedStepIds: ['step-1'] }));
    renderCookMode();

    await userEvent.click(await screen.findByTestId('cook-step-collapsed'));
    await userEvent.click(await screen.findByTestId('cook-step-untick'));

    await waitFor(() => expect(lastPersisted().completedStepIds).toEqual([]));
  });

  it('offers to resume the earliest outstanding step when the cook is re-reading a done one', async () => {
    mockCookSession._set(makeCookSession({ completedStepIds: ['step-1'] }));
    renderCookMode();

    await userEvent.click(await screen.findByTestId('cook-step-collapsed'));
    expect(await screen.findByTestId('cook-step-resume')).toHaveTextContent('Resume · step 2');
  });

  it('marks the timeline as steps are ticked and makes a tapped segment the current one', async () => {
    mockCookSession._set(makeCookSession({ completedStepIds: ['step-1'] }));
    renderCookMode();

    const segments = await screen.findAllByTestId('cook-timeline-step');
    expect(segments[0]).toHaveAttribute('data-complete', 'true');
    expect(segments[1]).toHaveAttribute('data-current', 'true');

    await userEvent.click(segments[0]!);
    await waitFor(() =>
      expect(screen.getAllByTestId('cook-timeline-step')[0]).toHaveAttribute(
        'data-current',
        'true',
      ),
    );
  });

  it('turns the footer into finish cooking only once every step is ticked', async () => {
    renderCookMode();
    await enterSteps();

    await userEvent.click(screen.getByTestId('cook-step-done'));
    expect(screen.queryByTestId('cook-mode-complete')).not.toBeInTheDocument();

    await userEvent.click(await screen.findByTestId('cook-step-done'));
    expect(await screen.findByTestId('cook-mode-complete')).toHaveTextContent('Finish cooking');
  });

  it('finishing clears the session and returns to the recipe', async () => {
    mockCookSession._set(makeCookSession({ completedStepIds: ['step-1', 'step-2'] }));
    renderCookMode();

    await userEvent.click(await screen.findByTestId('cook-mode-complete'));

    await waitFor(() => expect(vi.mocked(removeCookSession)).toHaveBeenCalledWith(SESSION_ID));
    expect(vi.mocked(push)).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}`);
  });

  // Issue #559. removeCookSession empties the store before the navigation lands, and
  // an empty store is also what "this cook has never been started" looks like — so the
  // bootstrap effect has to be held off, or finishing writes the session back.
  it('finishing does not open a replacement session on its way out', async () => {
    mockCookSession._set(makeCookSession({ completedStepIds: ['step-1', 'step-2'] }));
    renderCookMode();

    await userEvent.click(await screen.findByTestId('cook-mode-complete'));
    await waitFor(() => expect(vi.mocked(push)).toHaveBeenCalled());

    expect(vi.mocked(persistCookSession)).not.toHaveBeenCalled();
  });

  it('shows each step the ingredients it is the first to call for', async () => {
    renderCookMode();
    await enterSteps();

    const chipLists = screen.getAllByTestId('cook-step-firstuse');
    expect(chipLists).toHaveLength(2);
    expect(chipLists[0]).toHaveTextContent('2 onions');
    expect(chipLists[1]).toHaveTextContent('400g tinned tomatoes');
  });
});

describe('CookModePage — a step note', () => {
  /** Step 1 carries a note; step 2 deliberately does not. */
  function recipeWithNote(note: string): RecipeDoc {
    const base = makeRecipe();
    return makeRecipe({
      steps: [{ ...base.steps[0]!, note }, base.steps[1]!],
    });
  }

  // Issue #736. The note used to be a grey paragraph dimmer than the instruction
  // above it — at arm's length it read as a second sentence of the step. It now
  // carries the same `warning`-callout marker the recipe detail page uses.
  it('marks a note as a note, in the same role the recipe page uses', async () => {
    mockRecipes._set([recipeWithNote('Do not let the garlic brown.')]);
    renderCookMode();
    await enterSteps();

    const notes = screen.getAllByTestId('cook-step-note');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent('Do not let the garlic brown.');
    expect(notes[0]).toHaveClass('border-warning/40', 'bg-warning/10', 'text-warning-text');
  });

  // Cook mode is read at arm's length, so the box grows but the words do not shrink.
  it('holds the note at the size it is read across a worktop', async () => {
    mockRecipes._set([recipeWithNote('Do not let the garlic brown.')]);
    renderCookMode();
    await enterSteps();

    const text = screen.getByText('Do not let the garlic brown.');
    expect(text).toHaveClass('text-lg');
  });

  it('keeps line breaks the author typed, as the recipe page already does', async () => {
    mockRecipes._set([recipeWithNote('Do not let the garlic brown.\nIt turns bitter fast.')]);
    renderCookMode();
    await enterSteps();

    const text = screen.getByText(/It turns bitter fast\./);
    expect(text).toHaveClass('whitespace-pre-wrap');
    expect(text.textContent).toContain('\n');
  });

  it('leaves a step that has no note exactly as it was', async () => {
    renderCookMode();
    await enterSteps();

    expect(screen.queryByTestId('cook-step-note')).not.toBeInTheDocument();
  });

  it('shows no note on a ticked step, which stays a one-line summary', async () => {
    mockRecipes._set([recipeWithNote('Do not let the garlic brown.')]);
    mockCookSession._set(makeCookSession({ completedStepIds: ['step-1'] }));
    renderCookMode();

    await screen.findByTestId('cook-step-collapsed');
    expect(screen.queryByTestId('cook-step-note')).not.toBeInTheDocument();
  });
});

describe('CookModePage — step timers', () => {
  it('starts a countdown as an absolute end time, so a reload can rebuild it', async () => {
    renderCookMode();
    await enterSteps();

    const before = Date.now();
    await userEvent.click(screen.getByTestId('cook-step-timer-start'));

    await waitFor(() => expect(lastPersisted().activeTimers).toHaveLength(1));
    const timer = lastPersisted().activeTimers[0]!;
    // A step timer's identity IS its step id (#748) — nothing is minted here.
    expect(timer.id).toBe('step-2');
    expect(timer.stepId).toBe('step-2');
    // The duration it was ACTUALLY started for is stored, so an edit to the
    // recipe afterwards cannot restate this run.
    expect(timer.durationMinutes).toBe(20);
    // The default recipe's step-2 timer has description: null.
    expect(timer.label).toBeNull();
    const runsFor = new Date(timer.endsAt).getTime() - before;
    expect(runsFor).toBeGreaterThanOrEqual(20 * 60_000 - 1_000);
    expect(runsFor).toBeLessThanOrEqual(20 * 60_000 + 10_000);
  });

  it("stores the step's description as the timer's own label (#748)", async () => {
    mockRecipes._set([
      makeRecipe({
        steps: [
          { id: 'step-1', text: 'Soften the onions.', timer: null, note: null },
          {
            id: 'step-2',
            text: 'Rest the sauce.',
            timer: { durationMinutes: 5, description: 'Simmer the sauce' },
            note: null,
          },
        ],
      }),
    ]);
    renderCookMode();
    await enterSteps();
    await userEvent.click(screen.getByTestId('cook-step-timer-start'));

    await waitFor(() => expect(lastPersisted().activeTimers).toHaveLength(1));
    const timer = lastPersisted().activeTimers[0]!;
    expect(timer.label).toBe('Simmer the sauce');
    expect(timer.durationMinutes).toBe(5);
  });

  it('arms the push backstop on a timer long enough to deliver on time', async () => {
    renderCookMode();
    await enterSteps();
    await userEvent.click(screen.getByTestId('cook-step-timer-start'));

    await waitFor(() => expect(lastPersisted().activeTimers[0]?.notify).toBe(true));
  });

  // Starting a timer is the only gesture guaranteed to precede a chime, and iOS
  // Safari only permits audio unlocked from one — so the unlock has to happen
  // here even though the chime itself fires from the app-level watcher.
  it('unlocks the audio context on the start gesture, and never chimes itself', async () => {
    renderCookMode();
    await enterSteps();
    await userEvent.click(screen.getByTestId('cook-step-timer-start'));

    await waitFor(() => expect(mockChime.primeChime).toHaveBeenCalled());
    expect(mockChime.playChime).not.toHaveBeenCalled();
  });

  // A few minutes is well inside the floor now — this is the case the old
  // five-minute threshold left with no alert at all once the screen locked.
  it('arms the push backstop on a middling timer too', async () => {
    mockRecipes._set([
      makeRecipe({
        steps: [
          { id: 'step-1', text: 'Soften the onions.', timer: null, note: null },
          {
            id: 'step-2',
            text: 'Rest the sauce.',
            timer: { durationMinutes: 3, description: null },
            note: null,
          },
        ],
      }),
    ]);
    renderCookMode();
    await enterSteps();
    await userEvent.click(screen.getByTestId('cook-step-timer-start'));

    await waitFor(() => expect(lastPersisted().activeTimers[0]?.notify).toBe(true));
  });

  // Below the floor a queued push could land later than the chime, so the chef
  // standing at the hob gets the chime alone.
  it('leaves a timer too short to deliver a punctual push as silent', async () => {
    mockRecipes._set([
      makeRecipe({
        steps: [
          { id: 'step-1', text: 'Soften the onions.', timer: null, note: null },
          {
            id: 'step-2',
            text: 'Blanch the beans.',
            timer: { durationMinutes: 1, description: null },
            note: null,
          },
        ],
      }),
    ]);
    renderCookMode();
    await enterSteps();
    await userEvent.click(screen.getByTestId('cook-step-timer-start'));

    await waitFor(() => expect(lastPersisted().activeTimers[0]?.notify).toBe(false));
  });

  it('keeps a running timer on screen whichever stage the cook is looking at', async () => {
    mockCookSession._set(
      makeCookSession({
        activeTimers: [
          {
            id: 'step-2',
            stepId: 'step-2',
            label: null,
            durationMinutes: null,
            endsAt: new Date(Date.now() + 300_000).toISOString(),
            notify: true,
          },
        ],
      }),
    );
    renderCookMode();

    // Stage 1 — the bar is above the stage, so it is there before cooking even starts.
    expect(screen.getByTestId('cook-timers-bar')).toBeInTheDocument();
    // Identity is the timer's own id (#748) — a chip keyed by step could not
    // address a timer that has no step.
    expect(screen.getByTestId('cook-timer-chip')).toHaveAttribute('data-timer-id', 'step-2');
    expect(screen.getByTestId('cook-timer-chip-time')).toHaveTextContent(/^(4:5\d|5:00)$/);

    await enterSteps();
    expect(screen.getByTestId('cook-timers-bar')).toBeInTheDocument();
  });

  it('reads a timer whose end time has passed as finished, still dismissable', async () => {
    mockCookSession._set(
      makeCookSession({
        activeTimers: [
          {
            id: 'step-2',
            stepId: 'step-2',
            label: null,
            durationMinutes: null,
            endsAt: new Date(Date.now() - 30_000).toISOString(),
            notify: true,
          },
        ],
      }),
    );
    renderCookMode();

    expect(screen.getByTestId('cook-timer-chip')).toHaveAttribute('data-fired', 'true');
    expect(screen.getByTestId('cook-timer-chip-time')).toHaveTextContent('Finished');
    expect(screen.getByTestId('cook-timer-chip-dismiss')).toHaveTextContent('Dismiss');
  });

  it('leads the timer chip with the step timer label when present (#554)', async () => {
    mockRecipes._set([
      makeRecipe({
        steps: [
          { id: 'step-1', text: 'Soften the onions.', timer: null, note: null },
          {
            id: 'step-2',
            text: 'Rest the sauce.',
            timer: { durationMinutes: 5, description: 'Simmer the sauce' },
            note: null,
          },
        ],
      }),
    ]);
    mockCookSession._set(
      makeCookSession({
        activeTimers: [
          {
            id: 'step-2',
            stepId: 'step-2',
            label: null,
            durationMinutes: null,
            endsAt: new Date(Date.now() + 300_000).toISOString(),
            notify: true,
          },
        ],
      }),
    );
    renderCookMode();

    // The chip leads with the human label, not "Step 2"; the step number stays
    // reachable as a tooltip so the step is still locatable.
    const label = screen.getByTestId('cook-timer-chip-label');
    expect(label).toHaveTextContent('Simmer the sauce');
    expect(label).toHaveAttribute('title', 'Step 2');
  });

  it('falls back to Step N on the chip when the timer has no label (#554)', async () => {
    mockCookSession._set(
      makeCookSession({
        activeTimers: [
          {
            id: 'step-2',
            stepId: 'step-2',
            label: null,
            durationMinutes: null,
            endsAt: new Date(Date.now() + 300_000).toISOString(),
            notify: true,
          },
        ],
      }),
    );
    renderCookMode();

    // Default recipe's step-2 timer has description: null → the fallback label,
    // and no tooltip (nothing is being hidden behind the lead).
    const label = screen.getByTestId('cook-timer-chip-label');
    expect(label).toHaveTextContent('Step 2');
    expect(label).not.toHaveAttribute('title');
  });

  // The label belongs to the timer, not to the step — so it rides inside the bar,
  // leading, as it does on the persistent chip. Underneath, it read as a caption on
  // the step itself.
  it('carries the timer label inside the step timer bar, beside the countdown', async () => {
    mockRecipes._set([
      makeRecipe({
        steps: [
          { id: 'step-1', text: 'Soften the onions.', timer: null, note: null },
          {
            id: 'step-2',
            text: 'Rest the sauce.',
            timer: { durationMinutes: 5, description: 'Simmer the sauce' },
            note: null,
          },
        ],
      }),
    ]);
    mockCookSession._set(
      makeCookSession({
        activeTimers: [
          {
            id: 'step-2',
            stepId: 'step-2',
            label: null,
            durationMinutes: null,
            endsAt: new Date(Date.now() + 300_000).toISOString(),
            notify: true,
          },
        ],
      }),
    );
    renderCookMode();
    await enterSteps();

    const bar = screen.getByTestId('cook-step-timer');
    const label = screen.getByTestId('cook-step-timer-label');
    expect(label).toHaveTextContent('Simmer the sauce');
    // Inside the bordered row that also holds the countdown, not a sibling of it.
    expect(label.closest('div')).toContainElement(screen.getByTestId('cook-step-timer-countdown'));
    expect(bar).toHaveTextContent(/Simmer the sauce\s*(4:5\d|5:00)/);
  });

  it('shortens the fired status to Finished once a label leads the bar', async () => {
    mockRecipes._set([
      makeRecipe({
        steps: [
          { id: 'step-1', text: 'Soften the onions.', timer: null, note: null },
          {
            id: 'step-2',
            text: 'Rest the sauce.',
            timer: { durationMinutes: 5, description: 'Simmer the sauce' },
            note: null,
          },
        ],
      }),
    ]);
    mockCookSession._set(
      makeCookSession({
        activeTimers: [
          {
            id: 'step-2',
            stepId: 'step-2',
            label: null,
            durationMinutes: null,
            endsAt: new Date(Date.now() - 30_000).toISOString(),
            notify: true,
          },
        ],
      }),
    );
    renderCookMode();
    await enterSteps();

    expect(screen.getByTestId('cook-step-timer-label')).toHaveTextContent('Simmer the sauce');
    expect(screen.getByTestId('cook-step-timer-countdown')).toHaveTextContent('Finished');
  });

  // No label, nothing to lead with: the countdown keeps the bar to itself and the
  // "Step N" fallback the chip needs would only state the obvious here.
  it('leaves an unlabelled step timer as the countdown alone', async () => {
    mockCookSession._set(
      makeCookSession({
        activeTimers: [
          {
            id: 'step-2',
            stepId: 'step-2',
            label: null,
            durationMinutes: null,
            endsAt: new Date(Date.now() + 300_000).toISOString(),
            notify: true,
          },
        ],
      }),
    );
    renderCookMode();
    await enterSteps();

    expect(screen.queryByTestId('cook-step-timer-label')).not.toBeInTheDocument();
    expect(screen.getByTestId('cook-step-timer-countdown')).toHaveTextContent(/^(4:5\d|5:00)$/);
  });

  // The label is never a caption hanging underneath, in any state — unstarted, it is
  // part of the start button's own line, in brackets after the duration.
  it('carries the label inside the start button while the timer is unstarted', async () => {
    mockRecipes._set([
      makeRecipe({
        steps: [
          { id: 'step-1', text: 'Soften the onions.', timer: null, note: null },
          {
            id: 'step-2',
            text: 'Rest the sauce.',
            timer: { durationMinutes: 5, description: 'Simmer the sauce' },
            note: null,
          },
        ],
      }),
    ]);
    renderCookMode();
    await enterSteps();

    expect(screen.getByTestId('cook-step-timer-start')).toHaveTextContent(
      'Start 5 minute timer (Simmer the sauce)',
    );
  });

  it('leaves the brackets off the start button when the timer has no label', async () => {
    renderCookMode();
    await enterSteps();

    // The default recipe's step-2 timer is 20 minutes, description: null.
    expect(screen.getByTestId('cook-step-timer-start')).toHaveTextContent(
      /^Start 20 minute timer$/,
    );
  });

  it('cancelling from the persistent bar takes the timer off the session', async () => {
    mockCookSession._set(
      makeCookSession({
        activeTimers: [
          {
            id: 'step-2',
            stepId: 'step-2',
            label: null,
            durationMinutes: null,
            endsAt: new Date(Date.now() + 300_000).toISOString(),
            notify: true,
          },
        ],
      }),
    );
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-timer-chip-dismiss'));
    await waitFor(() => expect(lastPersisted().activeTimers).toEqual([]));
    expect(screen.queryByTestId('cook-timers-bar')).not.toBeInTheDocument();
  });

  it('cancelling from the step itself takes the timer off the session too', async () => {
    mockCookSession._set(
      makeCookSession({
        activeTimers: [
          {
            id: 'step-2',
            stepId: 'step-2',
            label: null,
            durationMinutes: null,
            endsAt: new Date(Date.now() + 300_000).toISOString(),
            notify: true,
          },
        ],
      }),
    );
    renderCookMode();
    await enterSteps();

    await userEvent.click(screen.getByTestId('cook-step-timer-dismiss'));
    await waitFor(() => expect(lastPersisted().activeTimers).toEqual([]));
    expect(await screen.findByTestId('cook-step-timer-start')).toBeInTheDocument();
  });
});

// The sheet is one component serving four cases — a step timer, an adjusted step
// timer, a timer already running, and a timer for something the recipe never
// mentioned. What is asserted here is the WIRING: which case prefills with what,
// and what each one writes. The −/+ arithmetic itself is unit tested next door in
// `cookTimerDuration.test.ts`, against the function rather than through the DOM.
describe('CookModePage — adjusting a timer, and setting your own (#748)', () => {
  /** The sheet's name field, once the sheet is actually open. */
  function sheetName(): HTMLInputElement {
    return screen.getByTestId('cook-timer-sheet-name') as HTMLInputElement;
  }
  function sheetMinutes(): HTMLInputElement {
    return screen.getByTestId('cook-timer-sheet-minutes') as HTMLInputElement;
  }

  // Put a whole value into one of the sheet's fields in a single `input` event.
  //
  // NOT `userEvent.type`, which delivers one keystroke at a time. These are
  // CONTROLLED inputs — `TextField` renders `value={value}` and writes back from
  // `oninput` — and per-keystroke typing intermittently loses the LAST character
  // on the way to the component's state: the field reads "Rice" in the DOM while
  // `label`, and so the persisted timer, holds "Ric". Measured under #793 on this
  // file: "Rice" persisted as "Ric" and `setMinutes('45')` persisted as `4`.
  //
  // No wait can rescue it. The sheet persists exactly once, on confirm, so the
  // truncated value is final — `:1412`'s assertion is already inside its `waitFor`
  // and still failed with `4` for `45` after the full budget. One `input` event
  // carries the entire value and cannot interleave with a pending Svelte flush,
  // which is the same reason `MealPlanWeekPage.test.ts:440-449` prefers `fireEvent`
  // for the recipe picker. What a real keystroke stream does to this field belongs
  // to Playwright, not jsdom.
  async function setField(el: HTMLInputElement, value: string): Promise<void> {
    await fireEvent.input(el, { target: { value } });
  }

  async function setMinutes(value: string): Promise<void> {
    await setField(sheetMinutes(), value);
  }

  function runningTimer(over: Partial<CookSessionDoc['activeTimers'][number]> = {}) {
    return {
      id: 'step-2',
      stepId: 'step-2' as string | null,
      label: 'Simmer the sauce' as string | null,
      durationMinutes: 20 as number | null,
      endsAt: new Date(Date.now() + 300_000).toISOString(),
      notify: true,
      ...over,
    };
  }

  it("prefills a step's own name and duration when its pencil is tapped", async () => {
    mockRecipes._set([
      makeRecipe({
        steps: [
          { id: 'step-1', text: 'Soften the onions.', timer: null, note: null },
          {
            id: 'step-2',
            text: 'Simmer the sauce.',
            timer: { durationMinutes: 20, description: 'Simmer the sauce' },
            note: null,
          },
        ],
      }),
    ]);
    renderCookMode();
    await enterSteps();

    await userEvent.click(screen.getByTestId('cook-step-timer-adjust'));

    expect(await screen.findByTestId('cook-timer-sheet-name')).toHaveValue('Simmer the sauce');
    expect(sheetMinutes()).toHaveValue('20');
    // Not running yet — the copy says what the button will do.
    expect(screen.getByTestId('cook-timer-sheet-confirm')).toHaveTextContent('Start timer');
  });

  it('starts the step timer for the duration the cook chose, not the recipe’s', async () => {
    renderCookMode();
    await enterSteps();

    await userEvent.click(screen.getByTestId('cook-step-timer-adjust'));
    await screen.findByTestId('cook-timer-sheet-name');
    await setMinutes('7');
    const before = Date.now();
    await userEvent.click(screen.getByTestId('cook-timer-sheet-confirm'));

    await waitFor(() => expect(lastPersisted().activeTimers).toHaveLength(1));
    const timer = lastPersisted().activeTimers[0]!;
    // Still the step's timer — same identity, same link, just a different length.
    expect(timer.id).toBe('step-2');
    expect(timer.stepId).toBe('step-2');
    expect(timer.durationMinutes).toBe(7);
    const runsFor = new Date(timer.endsAt).getTime() - before;
    expect(runsFor).toBeGreaterThanOrEqual(7 * 60_000 - 1_000);
    expect(runsFor).toBeLessThanOrEqual(7 * 60_000 + 10_000);
  });

  it('still starts the recipe’s own timer in a single tap, with no sheet in the way', async () => {
    renderCookMode();
    await enterSteps();

    await userEvent.click(screen.getByTestId('cook-step-timer-start'));

    await waitFor(() => expect(lastPersisted().activeTimers).toHaveLength(1));
    expect(lastPersisted().activeTimers[0]!.durationMinutes).toBe(20);
    expect(screen.queryByTestId('cook-timer-sheet-confirm')).not.toBeInTheDocument();
  });

  it('opens the header timer on "Salt Timer" and ten minutes', async () => {
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-mode-timer'));

    expect(await screen.findByTestId('cook-timer-sheet-name')).toHaveValue('Salt Timer');
    expect(sheetMinutes()).toHaveValue('10');
  });

  it('starts a timer of its own, named, belonging to no step', async () => {
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-mode-timer'));
    await screen.findByTestId('cook-timer-sheet-name');
    await setField(sheetName(), 'Rice');
    await setMinutes('12');
    await userEvent.click(screen.getByTestId('cook-timer-sheet-confirm'));

    await waitFor(() => expect(lastPersisted().activeTimers).toHaveLength(1));
    const timer = lastPersisted().activeTimers[0]!;
    // A minted id, because there is no step to borrow one from — and a null
    // `stepId`, which is what keeps it out of every step's inline slot.
    expect(timer.stepId).toBeNull();
    expect(timer.id).not.toBe('');
    expect(timer.label).toBe('Rice');
    expect(timer.durationMinutes).toBe(12);
    // Long enough to be worth a push, derived from the duration actually started.
    expect(timer.notify).toBe(true);

    // It behaves like any other timer: the persistent bar carries it, under the
    // name the cook gave it.
    expect(await screen.findByTestId('cook-timers-bar')).toBeInTheDocument();
    expect(screen.getByTestId('cook-timer-chip-label')).toHaveTextContent('Rice');
  });

  it('leaves the step’s own inline slot alone — an ad-hoc timer is not its timer', async () => {
    mockCookSession._set(
      makeCookSession({
        activeTimers: [runningTimer({ id: 'ad-hoc-1', stepId: null, label: 'Rice' })],
      }),
    );
    renderCookMode();
    await enterSteps();

    expect(screen.getByTestId('cook-timer-chip-label')).toHaveTextContent('Rice');
    // Step 2 has a timer of its own and it has NOT started — the slot still offers
    // to start it rather than showing someone else's countdown.
    expect(screen.getByTestId('cook-step-timer-start')).toBeInTheDocument();
  });

  it('re-opens a running timer on its current name and the length it was set for', async () => {
    mockCookSession._set(makeCookSession({ activeTimers: [runningTimer()] }));
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-timer-chip-edit'));

    expect(await screen.findByTestId('cook-timer-sheet-name')).toHaveValue('Simmer the sauce');
    // What it was SET for (20), not the 5 minutes left on it.
    expect(sheetMinutes()).toHaveValue('20');
    expect(screen.getByTestId('cook-timer-sheet-confirm')).toHaveTextContent('Update timer');
  });

  it('re-times a running timer through the same entry, moving its end', async () => {
    mockCookSession._set(makeCookSession({ activeTimers: [runningTimer()] }));
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-timer-chip-edit'));
    await screen.findByTestId('cook-timer-sheet-name');
    await setMinutes('45');
    const before = Date.now();
    await userEvent.click(screen.getByTestId('cook-timer-sheet-confirm'));

    await waitFor(() => expect(lastPersisted().activeTimers[0]?.durationMinutes).toBe(45));
    // One timer still, not two: adjusting is the same producer keyed on the same id.
    expect(lastPersisted().activeTimers).toHaveLength(1);
    const timer = lastPersisted().activeTimers[0]!;
    expect(timer.id).toBe('step-2');
    const runsFor = new Date(timer.endsAt).getTime() - before;
    expect(runsFor).toBeGreaterThanOrEqual(45 * 60_000 - 1_000);
  });

  it('drops a timer’s name back to its step when the cook empties it', async () => {
    mockCookSession._set(makeCookSession({ activeTimers: [runningTimer()] }));
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-timer-chip-edit'));
    await screen.findByTestId('cook-timer-sheet-name');
    await userEvent.clear(sheetName());
    await userEvent.click(screen.getByTestId('cook-timer-sheet-confirm'));

    await waitFor(() => expect(lastPersisted().activeTimers[0]?.label).toBeNull());
  });

  it('refuses to start a timer with no duration typed into it', async () => {
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-mode-timer'));
    await screen.findByTestId('cook-timer-sheet-name');
    await userEvent.clear(sheetMinutes());

    expect(screen.getByTestId('cook-timer-sheet-confirm')).toBeDisabled();
  });

  // Ad-hoc timers live on the session doc like any other, and Finish deletes the
  // doc — so they clear with the cook for free. Asserted rather than assumed.
  it('clears a timer of its own when the cook is finished', async () => {
    mockCookSession._set(
      makeCookSession({
        completedStepIds: ['step-1', 'step-2'],
        activeTimers: [runningTimer({ id: 'ad-hoc-1', stepId: null, label: 'Rice' })],
      }),
    );
    renderCookMode();
    expect(screen.getByTestId('cook-timers-bar')).toBeInTheDocument();

    await userEvent.click(await screen.findByTestId('cook-mode-complete'));

    await waitFor(() => expect(removeCookSession).toHaveBeenCalledWith(SESSION_ID));
    expect(screen.queryByTestId('cook-timers-bar')).not.toBeInTheDocument();
  });
});

// Plain cook mode NEVER arms a check-in — that belongs to guided cook, the only
// mode holding the plan. But it shares the SAME session document with it, so a
// cook who switches modes mid-braise finds them here and this page has to leave
// them alone sensibly.
describe('CookModePage — check-ins armed by the guided cook (#751)', () => {
  function braising() {
    const startMs = Date.now();
    const at = (m: number) => new Date(startMs + m * 60_000).toISOString();
    return [
      {
        id: 'step-2',
        stepId: 'step-2',
        label: 'Braise',
        durationMinutes: 180,
        endsAt: at(180),
        notify: true,
      },
      {
        id: checkInTimerId('step-2', 20),
        stepId: 'step-2',
        label: 'Check the heat',
        durationMinutes: 20,
        endsAt: at(20),
        notify: true,
      },
    ];
  }

  it("leaves the step's inline slot on the step's OWN timer, not on a reminder", async () => {
    mockCookSession._set(
      makeCookSession({ completedStepIds: ['step-1'], activeTimers: braising() }),
    );
    renderCookMode();
    await screen.findByTestId('cook-steps-view');

    // Without this the last entry naming the step would win, and the inline
    // countdown would show 20 minutes while its Cancel called off the reminder.
    await userEvent.click(screen.getByTestId('cook-step-timer-dismiss'));
    await waitFor(
      () => expect(lastPersisted().activeTimers).toEqual([]), // the braise takes its reminder with it
    );
  });

  it('offers no way to re-time a reminder from here either', async () => {
    mockCookSession._set(makeCookSession({ activeTimers: braising() }));
    renderCookMode();

    const chips = await screen.findAllByTestId('cook-timer-chip');
    const reminder = chips.find((c) => c.dataset['timerId'] === checkInTimerId('step-2', 20))!;
    expect(reminder).toHaveTextContent('Check the heat');
    expect(reminder.querySelector('[data-testid="cook-timer-chip-edit"]')).toBeNull();
  });

  it('lets a fired reminder leave the bar on its own', async () => {
    const timers = braising();
    timers[1]!.endsAt = new Date(Date.now() - 5_000).toISOString();
    mockCookSession._set(makeCookSession({ activeTimers: timers }));
    renderCookMode();

    const chips = await screen.findAllByTestId('cook-timer-chip');
    expect(chips.map((c) => c.dataset['timerId'])).toEqual(['step-2']);
  });

  it('never arms one of its own', async () => {
    renderCookMode();
    await enterSteps();
    await userEvent.click(screen.getByTestId('cook-step-timer-start'));

    await waitFor(() => expect(lastPersisted().activeTimers).toHaveLength(1));
  });
});

describe('CookModePage — the recipe changing under an in-progress cook', () => {
  it('says nothing while the recipe is the one the cook started from', () => {
    renderCookMode();
    expect(screen.queryByTestId('cook-mode-recipe-changed')).not.toBeInTheDocument();
  });

  it('warns the cook when the recipe is edited mid-cook', async () => {
    renderCookMode();
    mockRecipes._set([makeRecipe({ updatedAt: RECIPE_EDITED_AT })]);

    expect(await screen.findByTestId('cook-mode-recipe-changed')).toHaveTextContent(
      /updated since you started cooking/i,
    );
  });

  it('restarting discards the session and re-baselines against the edited recipe', async () => {
    mockCookSession._set(makeCookSession({ checkedIngredientIds: ['ing-1'] }));
    renderCookMode();
    mockRecipes._set([makeRecipe({ updatedAt: RECIPE_EDITED_AT })]);

    await userEvent.click(await screen.findByTestId('cook-mode-restart'));

    await waitFor(() => expect(vi.mocked(removeCookSession)).toHaveBeenCalledWith(SESSION_ID));
    expect(lastPersisted()).toMatchObject({
      id: SESSION_ID,
      recipeUpdatedAtAtStart: RECIPE_EDITED_AT,
      checkedIngredientIds: [],
      completedStepIds: [],
      activeTimers: [],
    });
    expect(vi.mocked(addToast)).toHaveBeenCalledWith(
      'Started fresh with the updated recipe.',
      'success',
    );
    // The new baseline matches the live recipe, so the warning has nothing left to say.
    await waitFor(() =>
      expect(screen.queryByTestId('cook-mode-recipe-changed')).not.toBeInTheDocument(),
    );
  });

  it('says so when the restart could not be written', async () => {
    renderCookMode();
    mockRecipes._set([makeRecipe({ updatedAt: RECIPE_EDITED_AT })]);
    vi.mocked(persistCookSession).mockImplementationOnce(async () => ({
      kind: 'err' as const,
      error: { kind: 'NetworkError', reason: 'transient' },
    }));

    await userEvent.click(await screen.findByTestId('cook-mode-restart'));

    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('Failed to restart.', 'destructive'),
    );
    expect(vi.mocked(addToast)).not.toHaveBeenCalledWith(
      'Started fresh with the updated recipe.',
      'success',
    );
  });

  // Issue #559, the restart half: the discard empties the store before the fresh
  // session is written, so the bootstrap effect must not race in and write its own.
  it('restarting opens exactly one fresh session, not two', async () => {
    renderCookMode();
    mockRecipes._set([makeRecipe({ updatedAt: RECIPE_EDITED_AT })]);

    await userEvent.click(await screen.findByTestId('cook-mode-restart'));

    await waitFor(() => expect(vi.mocked(persistCookSession)).toHaveBeenCalled());
    expect(vi.mocked(persistCookSession)).toHaveBeenCalledTimes(1);
  });
});

// Issue #559. Finishing a cook on the phone used to leave it on screen on the tablet
// until the page was re-entered. Now the service says the session ENDED rather than
// merely reading empty, which is the distinction the bootstrap effect needs: without
// it, clearing the store would just make the tablet write the session back.
describe('CookModePage — the cook ending on another device', () => {
  it('tells the cook and returns to the recipe', async () => {
    renderCookMode();
    await screen.findByTestId('cook-mode-page');

    mockCookSession._set(null);
    mockCookSessionEnded._set(true);

    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('This cook was finished on another device.'),
    );
    expect(vi.mocked(push)).toHaveBeenCalledWith(`/recipes/${RECIPE_ID}`);
  });

  it('does not answer the deletion by starting the cook over', async () => {
    renderCookMode();
    await screen.findByTestId('cook-mode-page');

    mockCookSession._set(null);
    mockCookSessionEnded._set(true);

    await waitFor(() => expect(vi.mocked(push)).toHaveBeenCalled());
    expect(vi.mocked(persistCookSession)).not.toHaveBeenCalled();
  });
});

describe('CookModePage — a recipe deleted mid-cook', () => {
  it('waits for the recipes to load before calling a missing recipe deleted', async () => {
    mockRecipes._set([]);
    mockIsLoadingRecipes._set(true);
    renderCookMode();

    // Settle first: the orphan cleanup is fire-and-forget, so asserting it never ran
    // has to outlive the tick it would have run on.
    await waitFor(() => expect(screen.getByText('Loading…')).toBeInTheDocument());
    expect(screen.queryByTestId('cook-mode-orphan')).not.toBeInTheDocument();
    expect(vi.mocked(removeCookSession)).not.toHaveBeenCalled();
  });

  it('explains the deletion and clears the session it stranded', async () => {
    mockRecipes._set([]);
    renderCookMode();

    expect(screen.getByTestId('cook-mode-orphan')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(removeCookSession)).toHaveBeenCalledWith(SESSION_ID));
  });

  it('sends the cook back to the recipe list', async () => {
    mockRecipes._set([]);
    renderCookMode();

    await userEvent.click(screen.getByTestId('cook-mode-orphan-back'));
    expect(vi.mocked(push)).toHaveBeenCalledWith('/recipes');
  });
});

describe('CookModePage — keeping the screen awake', () => {
  it('confirms the lock only once the browser has actually granted it', async () => {
    renderCookMode();
    await userEvent.click(screen.getByTestId('cook-mode-wakelock'));

    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('Screen will stay awake', 'success'),
    );
    expect(screen.getByTestId('cook-mode-wakelock')).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not claim a lock the browser refused', async () => {
    mockWakeLock.enable.mockResolvedValueOnce(false);
    renderCookMode();
    await userEvent.click(screen.getByTestId('cook-mode-wakelock'));

    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith(
        "Your browser wouldn't let the screen stay awake.",
        'destructive',
      ),
    );
    expect(screen.getByTestId('cook-mode-wakelock')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('CookModePage — accessibility', () => {
  it('mise en place has no axe violations', async () => {
    const { container } = renderCookMode();
    await screen.findByTestId('cook-mise-check-all');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('the guided steps have no axe violations', async () => {
    mockCookSession._set(
      makeCookSession({
        completedStepIds: ['step-1'],
        activeTimers: [
          {
            id: 'step-2',
            stepId: 'step-2',
            label: null,
            durationMinutes: null,
            endsAt: new Date(Date.now() + 300_000).toISOString(),
            notify: true,
          },
        ],
      }),
    );
    const { container } = renderCookMode();
    await screen.findByTestId('cook-steps-view');

    expect(await axe(container)).toHaveNoViolations();
  });
});

// ─── Product-form icons (issue #871) ──────────────────────────────────────────
// A mise row whose ingredient names a PRODUCT FORM shows the form's own picture
// rather than the parent canon item's: "lime juice" is a bottle, not a lime.
describe('CookModePage — product-form icons in mise en place', () => {
  const CANON_ICON = 'https://example.com/lime.webp';
  const FORM_ICON = 'https://example.com/lime-juice.webp';

  const limeCanon = {
    id: 'c-lime',
    schemaVersion: 5,
    name: 'Lime',
    synonyms: [],
    aisleId: null,
    thumbnail: CANON_ICON,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };

  function limeJuiceForm(over: Record<string, unknown> = {}) {
    return {
      id: 'f-lime-juice',
      schemaVersion: 1,
      matchers: [],
      parentCanonId: 'c-lime',
      label: 'lime juice',
      yield: { formUnit: 'ml', amountPerParent: 30 },
      updatedAt: '2026-07-01T00:00:00.000Z',
      thumbnail: FORM_ICON,
      ...over,
    };
  }

  /** One mise row, for an ingredient matched to the lime canon item. */
  function recipeNaming(item: string) {
    return makeRecipe({
      ingredients: [
        {
          id: 'group-1',
          name: null,
          items: [
            makeIngredient({
              id: 'ing-1',
              rawText: `30ml ${item}`,
              parsed: {
                quantity: { type: 'single' as const, value: 30 },
                unit: 'ml' as const,
                item,
                preparation: [],
                notes: null,
                displayText: null,
              },
              canonId: 'c-lime',
            }),
          ],
        },
      ],
    });
  }

  function iconSrcs(): string[] {
    return screen
      .getAllByTestId('canon-icon-img')
      .map((el) => (el as HTMLImageElement).getAttribute('src') ?? '');
  }

  beforeEach(() => {
    mockCanonItems._set([limeCanon]);
  });

  it('shows the form’s own icon when the ingredient names a form', async () => {
    mockProductForms._set([limeJuiceForm()]);
    mockRecipes._set([recipeNaming('lime juice')]);
    renderCookMode();
    await screen.findByTestId('cook-mise-row');
    expect(iconSrcs().some((src) => src.startsWith(FORM_ICON))).toBe(true);
    expect(iconSrcs().some((src) => src.startsWith(CANON_ICON))).toBe(false);
  });

  it('keeps the parent canon icon when the ingredient names no form', async () => {
    mockProductForms._set([limeJuiceForm()]);
    mockRecipes._set([recipeNaming('lime')]);
    renderCookMode();
    await screen.findByTestId('cook-mise-row');
    expect(iconSrcs().some((src) => src.startsWith(CANON_ICON))).toBe(true);
  });

  // The guard: a form repointed at some other parent did not produce THIS
  // ingredient, so it must not supply its picture.
  it('ignores a form whose parent is a different canon item', async () => {
    mockProductForms._set([limeJuiceForm({ parentCanonId: 'c-lemon' })]);
    mockRecipes._set([recipeNaming('lime juice')]);
    renderCookMode();
    await screen.findByTestId('cook-mise-row');
    expect(iconSrcs().some((src) => src.startsWith(CANON_ICON))).toBe(true);
    expect(iconSrcs().some((src) => src.startsWith(FORM_ICON))).toBe(false);
  });

  // Every form that existed before #871 shipped has a null thumbnail until it is
  // regenerated, so without this fallback the feature would BLANK icons that show
  // a picture today.
  it('falls back to the parent icon when the form has no icon yet', async () => {
    mockProductForms._set([limeJuiceForm({ thumbnail: null })]);
    mockRecipes._set([recipeNaming('lime juice')]);
    renderCookMode();
    await screen.findByTestId('cook-mise-row');
    expect(iconSrcs().some((src) => src.startsWith(CANON_ICON))).toBe(true);
  });

  it('falls back to the parent icon when the form’s icon is hidden', async () => {
    mockProductForms._set([limeJuiceForm({ thumbnail: 'hidden' })]);
    mockRecipes._set([recipeNaming('lime juice')]);
    renderCookMode();
    await screen.findByTestId('cook-mise-row');
    expect(iconSrcs().some((src) => src.startsWith(CANON_ICON))).toBe(true);
  });
});
