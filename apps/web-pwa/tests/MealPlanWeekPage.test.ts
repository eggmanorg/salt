import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import {
  emptyRecipe,
  emptyWeek,
  templateWeekStarts,
  weekDates,
  weekdayOf,
  type Day,
  type MealPlanWeek,
  type Member,
  type Recipe,
  type RecipeKind,
} from '@salt/domain';
import { formatDayKey } from '../src/lib/dateFormat.js';

const NOW = '2026-01-01T00:00:00.000Z';

/** A recipe of the given kind, with the servings the add-to-shop sheet seeds from. */
function entry(
  id: string,
  title: string,
  servings: number | null,
  kind: RecipeKind = 'recipe',
): Recipe {
  const base = emptyRecipe(id, NOW, kind);
  return { ...base, title, metadata: { ...base.metadata, servings } };
}

// MealDayEditor's picker/auto-fill read `id`/`title`; the add-to-shop sheet also
// reads `metadata.servings` — the plan builder is mocked, so the ingredient
// detail is irrelevant here.
const RECIPE = entry('r1', 'Spaghetti Bolognese', 2);

// The other two kinds (#637). Neither carries ingredients or steps: what the
// planner does with them is decided by the domain capability predicates, not by
// their contents.
//
// RECIPE above used to be a `kind`-less literal, to stand for a pre-#637
// document. It cannot be one now that these fixtures are typechecked (#942):
// `RecipeSchema.kind` is `.default('recipe')`, so `z.infer` makes it required,
// and the subscription parses every document before the planner sees it — a
// `kind`-less doc never reaches this page. The default itself is pinned where it
// belongs, in `packages/domain/tests/recipe/recipe.schema.test.ts`.
const OUTING = entry('o1', 'Takeaway — Indian', 2, 'outing');
const COCKTAIL = entry('c1', 'Negroni', 1, 'cocktail');

// ─── Hoisted reactive stubs ────────────────────────────────────────────────
const {
  mockMembers,
  mockWeek,
  mockStart,
  mockLoading,
  mockFirstDay,
  mockExtensionWeek,
  mockExtensionStart,
  mockSetExtensionWeek,
  mockRecipes,
  mockCanonItems,
  mockDefaultListId,
  mockShopDay,
  mockExtensionShopDay,
  mockBuildRecipeAddPlan,
  mockCommitRecipeAddPlan,
  mockRecipeAddPlanItemCount,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  // Start date of the second week the planner is holding, '' for none. The real
  // service owns this; here `setExtensionWeek` drives it, so the page's own
  // request for a second week is what makes one appear — exactly the loop the
  // feature runs on.
  const extensionStart = makeStore<string>('');
  return {
    mockMembers: makeStore<Member[]>([]),
    mockWeek: makeStore<MealPlanWeek>({
      id: '',
      schemaVersion: 1,
      startDate: '',
      days: {},
      updatedAt: '',
    }),
    mockStart: makeStore<string>('2026-06-08'),
    mockLoading: makeStore<boolean>(false),
    // The household's first day of the week — what makes "the last two days of
    // the cycle" land on a Wednesday in production.
    mockFirstDay: makeStore<string>('mon'),
    mockExtensionWeek: makeStore<MealPlanWeek | null>(null),
    mockExtensionStart: extensionStart,
    mockSetExtensionWeek: vi.fn((start: string | null) => extensionStart._set(start ?? '')),
    // Empty here — `vi.hoisted` runs before the imports `entry` needs. Every test
    // gets `[RECIPE]` from the beforeEach below, which is what the seed was for.
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockCanonItems: makeStore<unknown[]>([]),
    mockDefaultListId: makeStore<string | null>('list-1'),
    // The week's shop day (issue #629) — null unless a test marks one.
    mockShopDay: makeStore<{ date: string; slot: 'am' | 'pm' } | null>(null),
    // Next week's shop day, when the planner is showing next week too (#639).
    mockExtensionShopDay: makeStore<{ date: string; slot: 'am' | 'pm' } | null>(null),
    // A one-row plan is enough for the sheet to render and confirm.
    mockBuildRecipeAddPlan: vi.fn((_recipe: Recipe, _servings: number) => [
      {
        ingredientId: 'i1',
        name: 'Spaghetti',
        fromCanon: false,
        amount: undefined,
        unit: undefined,
        isOptional: false,
        make: false,
        producers: [],
        producerId: null,
        madeServings: 1,
        add: true,
        check: false,
        subRows: null,
      },
    ]),
    mockCommitRecipeAddPlan: vi.fn(async (_recipe: Recipe, ..._rest: unknown[]) => ({
      kind: 'ok' as const,
      value: undefined,
    })),
    mockRecipeAddPlanItemCount: vi.fn(() => 1),
  };
});

vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/membersService.js', () => ({ members: mockMembers }));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  // The id index the planner resolves `recipeIds` through (#940). Derived from
  // the same stub, so a test that seeds `mockRecipes` needs no second seed.
  recipesById: {
    subscribe: (run: (m: ReadonlyMap<string, Recipe>) => void) =>
      mockRecipes.subscribe((list: readonly Recipe[]) => run(new Map(list.map((r) => [r.id, r])))),
  },
  buildRecipeAddPlan: mockBuildRecipeAddPlan,
  buildMadeSubRows: vi.fn(() => []),
  commitRecipeAddPlan: mockCommitRecipeAddPlan,
  recipeAddPlanItemCount: mockRecipeAddPlanItemCount,
}));
vi.mock('../src/lib/canonService.js', () => ({ canonItems: mockCanonItems }));
vi.mock('../src/lib/shoppingListService.svelte.js', () => ({ defaultListId: mockDefaultListId }));
vi.mock('../src/lib/shoppingDayService.js', () => ({
  weekShopDay: mockShopDay,
  extensionWeekShopDay: mockExtensionShopDay,
  setShopDay: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  clearShopDay: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/mealPlanService.js', () => ({
  flushMealPlanWrites: vi.fn().mockResolvedValue(undefined),
  currentWeek: mockWeek,
  selectedStartDate: mockStart,
  isLoadingMealPlanWeek: mockLoading,
  firstDayOfWeek: mockFirstDay,
  extensionWeek: mockExtensionWeek,
  extensionStartDate: mockExtensionStart,
  setExtensionWeek: mockSetExtensionWeek,
  nextWeek: vi.fn(),
  prevWeek: vi.fn(),
  thisWeek: vi.fn(),
  goToWeek: vi.fn(),
  loadTemplateIntoWeek: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  // "Does that week already hold edits?", asked once per offered week when the
  // load-template picker opens. Clear by default; tests that care override it.
  weekHasEdits: vi.fn().mockResolvedValue({ kind: 'ok', value: false }),
  setWeekDayNote: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  setWeekDayChefs: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  setWeekDayRecipes: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  setWeekDayGuests: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  addWeekAttendee: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  removeWeekAttendee: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  setWeekAttendeeHomeTime: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  setWeekAttendeeNote: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import MealPlanWeekPage from '../src/routes/mealplan/MealPlanWeekPage.svelte';
import {
  nextWeek,
  prevWeek,
  goToWeek,
  loadTemplateIntoWeek,
  weekHasEdits,
  setWeekDayNote,
  setWeekDayGuests,
  setWeekDayChefs,
  setWeekDayRecipes,
  addWeekAttendee,
  setWeekAttendeeHomeTime,
  setWeekAttendeeNote,
  flushMealPlanWrites,
} from '../src/lib/mealPlanService.js';
import { addToast } from '../src/lib/toastStore.js';
import { setShopDay, clearShopDay } from '../src/lib/shoppingDayService.js';

// A week whose single day already has recipe r1 attached, so its detail renders a
// recipe row (with the per-row "Add to shop" action) without going through the
// picker (setWeekDayRecipes is a no-op mock and never updates the store).
function weekWithRecipe(date: string): MealPlanWeek {
  return {
    ...emptyWeek(date),
    days: {
      ...emptyWeek(date).days,
      [date]: { note: '', recipeIds: ['r1'], chefs: [], attendees: [], guests: 0 },
    },
  };
}

// Tapping a day's row raises its sheet (#640). The row is still the trigger and
// still carries the same testid; what changed is where the detail lands — in a
// portalled dialog on <body>, which `screen` queries reach exactly as before.
async function openDay(date: string): Promise<void> {
  await userEvent.click(screen.getByTestId(`day-${date}-summary`));
  // …and then WAIT for bits-ui's focus scope to take the dialog, which it does on
  // a tick of its own. Until it lands, `document.activeElement` is still the row
  // that opened the sheet — a row that lives inside the deck — so anything typed
  // in that window is dispatched from INSIDE the deck and runs the deck's own
  // keydown handler on its way up. Whether that window is still open by the time
  // the next line runs is a matter of host scheduling, which is exactly how the
  // planner's Escape tests came to cover a branch of `deck.svelte.ts` on one
  // machine and not another (#967).
  const detail = await screen.findByTestId(`day-${date}-detail`);
  const dialog = detail.closest('[role="dialog"]') ?? detail;
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
}

// The week's shop-day picker (#640, Phase 4): a header button that says the
// current answer, opening the whole week's choice — the same shape as "Load
// template", and reached the same way.
async function openShopPicker(): Promise<void> {
  // Two doors to the same picker (#640): the header trigger exists only
  // while the week has NO shop day — once one is set, the rule across the list is
  // the control, and the header row is gone. Open whichever this week has.
  const trigger =
    screen.queryByTestId('week-shop-trigger') ?? screen.getAllByTestId(/-shop-marker$/)[0]!;
  await userEvent.click(trigger);
  await waitFor(() => screen.getByTestId('week-shop-picker'));
}

// Close it the way a user would. A test that ENDS with the dialog open is torn
// down mid-modal, and bits-ui's focus scope is module-level state: the abandoned
// scope outlives the unmount and fights the next test's sheet for focus, which
// shows up as keystrokes landing nowhere in a later, unrelated test. Picking a
// day closes the dialog by itself; the tests that only look must close it.
async function closeShopPicker(): Promise<void> {
  await userEvent.click(screen.getByTestId('week-shop-done'));
  await waitFor(() => expect(screen.queryByTestId('week-shop-picker')).not.toBeInTheDocument());
}

function member(id: string, name: string): Member {
  return {
    id,
    schemaVersion: 1,
    name,
    email: id,
    admin: false,
    sortOrder: 0,
    icon: null,
    cookMode: 'standard',
    updatedAt: '2026-06-07T00:00:00.000Z',
  };
}

const ALICE = member('alice@e.org', 'Alice');
const BOB = member('bob@e.org', 'Bob');

// ─── Landing on today (#639, Phase 2) ──────────────────────────────────────
// "Today" comes from the real clock inside the component, so instead of freezing
// time these helpers build a week AROUND today at a known offset — deterministic
// on any day the suite happens to run.
const TODAY = new Date().toLocaleDateString('en-CA');

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Make a week start `offset` days before today, so today is the (offset+1)th row
// and there are exactly `offset` earlier days above it. `firstDayOfWeek` is set to
// match, so the displayed week really IS today's cycle — which is what decides
// whether next week is appended (#639, Phase 6).
function weekAroundToday(offset: number): string {
  const start = addDays(TODAY, -offset);
  mockStart._set(start);
  mockWeek._set(emptyWeek(start));
  mockFirstDay._set(weekdayOf(start));
  return start;
}

// The same, plus next week seeded and ready for the page to ask for it. Returns
// both start dates.
function weekAroundTodayWithNext(offset: number): { start: string; next: string } {
  const start = weekAroundToday(offset);
  const next = addDays(start, 7);
  mockExtensionWeek._set(emptyWeek(next));
  return { start, next };
}

// ─── A fake layout for the deck (#639, Phase 4) ────────────────────────────
// The planner is no longer a scroller: it is a deck that moves a column by a
// transform. jsdom lays nothing out, so left alone the deck measures zeros —
// every stop collapses to 0 and it can never move, which would make the anchor,
// the cue and the stops all untestable (and, worse, make them look tested).
//
// So these tests install a plausible layout: a 700px viewport over seven 200px
// day cards 24px apart. Row positions are derived from the transform ACTUALLY
// applied to the column, exactly as a browser would compute them, so the real
// arithmetic in `cookDeck` runs for real against believable numbers.
const ROW_H = 200;
const ROW_GAP = 24;
const ROW_PITCH = ROW_H + ROW_GAP;
const VIEWPORT_H = 700;
// The deck rests a row-gap ABOVE the day it lands on, so the previous day's bottom
// edge sits just off the top rather than the card starting at the screen's first
// pixel. Every landing below is therefore a pitch multiple minus this lead — except
// the very top, which has nothing above it to show and clamps to 0.
const LEAD = ROW_GAP;

function fakeRect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    y: top,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/** How far the column is currently pushed up, read back off its transform. */
function deckOffset(): number {
  const column = document.querySelector<HTMLElement>('[style*="translate3d"]');
  const match = column && /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(column.style.transform);
  // `|| 0` normalises the -0 that negating "0" produces, which `toBe(0)` rejects.
  return match ? -Number(match[1]) || 0 : 0;
}

// `dates` is every row the deck holds, in VISUAL order — one week normally, and
// this week followed by next week once the planner extends (#639, Phase 6). The
// column's height follows from the count, so the appended week genuinely gives the
// deck further to travel, which is the whole reason today's row can reach the top
// at the end of a cycle.
function installDeckLayout(dates: string[]): void {
  const contentH = dates.length * ROW_H + (dates.length - 1) * ROW_GAP;
  const realRect = Element.prototype.getBoundingClientRect;
  const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
  const realClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!;

  // A row wrapper is identified by the day editor it wraps — found among its
  // children rather than assumed to be the first of them: a row also carries the
  // marks that belong to its day (the shop rule, the next-week mark), and both
  // render ABOVE the editor. The match is the bare `day-{date}` id, since the shop
  // marker's own testid is `day-{date}-shop-marker` and would otherwise answer
  // first with a date that is in no list.
  const rowIndex = (el: Element): number => {
    const editor = Array.from(el.children).find((c) =>
      /^day-\d{4}-\d{2}-\d{2}$/.test(c.getAttribute('data-testid') ?? ''),
    );
    return editor ? dates.indexOf(editor.getAttribute('data-testid')!.slice(4)) : -1;
  };
  const isViewport = (el: Element): boolean => el.getAttribute?.('data-testid') === 'week-deck';
  const isColumn = (el: Element): boolean =>
    el instanceof HTMLElement && el.style.transform.includes('translate3d');

  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (isViewport(this)) return fakeRect(0, VIEWPORT_H);
    const i = rowIndex(this);
    if (i >= 0) return fakeRect(i * ROW_PITCH - deckOffset(), ROW_H);
    return realRect.call(this);
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (rowIndex(this) >= 0) return ROW_H;
      return isColumn(this) ? contentH : 0;
    },
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get(this: Element) {
      return isViewport(this) ? VIEWPORT_H : 0;
    },
  });

  restoreLayout = () => {
    Element.prototype.getBoundingClientRect = realRect;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realOffsetHeight);
    Object.defineProperty(Element.prototype, 'clientHeight', realClientHeight);
    restoreLayout = null;
  };
}

let restoreLayout: (() => void) | null = null;

/**
 * Render with a believable layout already in place, so the mount-time anchor
 * measures. Pass `extensionStart` when the run of days is expected to continue
 * into next week, so the fake column is as tall as the real one would be.
 */
function renderLaidOut(startDate: string, extensionStart?: string): void {
  installDeckLayout([
    ...weekDates(startDate),
    ...(extensionStart ? weekDates(extensionStart) : []),
  ]);
  render(MealPlanWeekPage);
}

/** Move the deck the way a keyboard user would, and wait for the spring to settle. */
async function pressDeck(key: string): Promise<void> {
  const deck = screen.getByTestId('week-deck');
  deck.focus();
  await userEvent.keyboard(`{${key}}`);
  await waitFor(() => expect(deckOffset()).toBeGreaterThan(8));
}

afterEach(() => {
  cleanup();
  restoreLayout?.();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockMembers._set([ALICE, BOB]);
  mockStart._set('2026-06-08');
  mockLoading._set(false);
  mockWeek._set(emptyWeek('2026-06-08'));
  mockFirstDay._set('mon');
  mockExtensionWeek._set(null);
  mockExtensionStart._set('');
  mockRecipes._set([RECIPE]);
  mockCanonItems._set([]);
  mockDefaultListId._set('list-1');
  mockShopDay._set(null);
  mockExtensionShopDay._set(null);
  // clearAllMocks keeps implementations, so a per-test override would leak into
  // the next test; the picker's default answer is re-stated here.
  vi.mocked(weekHasEdits).mockResolvedValue({ kind: 'ok', value: false });
  vi.mocked(loadTemplateIntoWeek).mockResolvedValue({ kind: 'ok', value: undefined });
});

// Attach a recipe through the day's real recipe-picker Combobox: open the
// listbox from the input, then pick the option by its title. `title` accepts a
// RegExp because a "When you CBA" option carries its kind badge INSIDE the
// option, so its accessible name is the title plus the badge (#637).
//
// Both taps are dispatched with `fireEvent` rather than `userEvent` on purpose.
// `userEvent.click` emulates the browser's focus-on-pointerdown, and the
// combobox closes on input blur (in a microtask) — so a synthetic focus shuffle
// can tear the listbox down before the click lands, and the test then depends on
// timing and on how many bits-ui dialogs have been mounted in the document. That
// race is a jsdom/user-event artifact, not the component's behaviour, and
// `fireEvent` dispatches exactly the `click` the input and the option listen for.
// That the option is genuinely REACHABLE over the sheet — the real risk in a
// modal, where <body> is inert — is asserted directly in
// MealDayEditor.recipePicker.test.ts.
async function attachRecipe(date: string, title: string | RegExp): Promise<void> {
  await fireEvent.click(screen.getByTestId(`day-${date}-recipe-picker`));
  await fireEvent.click(await screen.findByRole('option', { name: title }));
}

// Open a day's picker without choosing anything, so the offered options can be
// inspected.
//
// `fireEvent`, for the reason given above `attachRecipe`: `userEvent.click`'s
// focus-on-pointerdown can blur the input and close the combobox before the click
// lands, and the listbox then never appears — so `findAllByRole('option')` burns
// its whole budget and fails. That presents as a slow timeout but is not one, which
// is why raising the wait budget does not fix it (#793). This helper was the odd one
// out: `attachRecipe` has always used `fireEvent`, and these three tests are the ones
// that failed in CI on PR #792.
async function openPicker(date: string): Promise<void> {
  await fireEvent.click(screen.getByTestId(`day-${date}-recipe-picker`));
  await screen.findAllByRole('option');
}

// A week whose single day already holds the given entries, so its detail renders
// their rows (with the per-row "Add to shop" action) without going through the
// picker (setWeekDayRecipes is a no-op mock and never updates the store).
function weekWith(date: string, recipeIds: string[]): MealPlanWeek {
  return {
    ...emptyWeek(date),
    days: {
      ...emptyWeek(date).days,
      [date]: { note: '', recipeIds, chefs: [], attendees: [], guests: 0 },
    },
  };
}

describe('MealPlanWeekPage', () => {
  it('renders seven collapsed day rows and the week range', () => {
    render(MealPlanWeekPage);
    expect(screen.getByTestId('day-2026-06-08')).toBeInTheDocument();
    expect(screen.getByTestId('day-2026-06-14')).toBeInTheDocument();
    expect(screen.getByTestId('week-range').textContent).toContain('Jun');
    // No day is open: the week is a list of rows and nothing else. The detail
    // lives in a sheet now (#640), so "collapsed" means "no dialog mounted".
    expect(screen.queryByTestId('day-2026-06-08-detail')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('navigates with prev/next', async () => {
    render(MealPlanWeekPage);
    await userEvent.click(screen.getByLabelText('Next week'));
    expect(vi.mocked(nextWeek)).toHaveBeenCalled();
    await userEvent.click(screen.getByLabelText('Previous week'));
    expect(vi.mocked(prevWeek)).toHaveBeenCalled();
  });

  it('edits a meal note through the service after expanding the day', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    // Same atomic-input reason as the next-week sibling below (#793): the Sheet's
    // focus trap can swallow a keystroke stream whole. Fixed here too rather than
    // waiting for the soak to catch this copy — it is one defect, not two.
    await fireEvent.input(screen.getByTestId('day-2026-06-08-note'), {
      target: { value: 'Pasta' },
    });
    await waitFor(() => expect(vi.mocked(setWeekDayNote)).toHaveBeenCalled());
    expect(vi.mocked(setWeekDayNote).mock.calls[0]![0]).toBe('2026-06-08');
  });

  // Write coalescing (issue #940) defers the `setDoc`, so the two moments the
  // SERVICE cannot see — the caret leaving a field, and the sheet going away —
  // have to be signalled from here. Without these the last thing typed sits in
  // a 400 ms timer that a dismissal throws away. The service-level tests prove
  // the flush works; these prove it is actually called.
  it('flushes the coalesced write when the meal field is blurred', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    const note = screen.getByTestId('day-2026-06-08-note');
    await fireEvent.input(note, { target: { value: 'Pasta' } });
    expect(vi.mocked(flushMealPlanWrites)).not.toHaveBeenCalled();

    await fireEvent.blur(note);

    expect(vi.mocked(flushMealPlanWrites)).toHaveBeenCalled();
  });

  it('flushes the coalesced write when an attendee note is blurred', async () => {
    mockWeek._set(dayWithAliceNote(''));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await fireEvent.click(screen.getByTestId('day-2026-06-08-attnote-toggle-alice@e.org'));
    const note = await screen.findByTestId('day-2026-06-08-attnote-alice@e.org');
    await fireEvent.input(note, { target: { value: 'late' } });
    expect(vi.mocked(flushMealPlanWrites)).not.toHaveBeenCalled();

    await fireEvent.blur(note);

    expect(vi.mocked(flushMealPlanWrites)).toHaveBeenCalled();
  });

  it('flushes the coalesced write when the day sheet is torn down', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await fireEvent.input(screen.getByTestId('day-2026-06-08-note'), {
      target: { value: 'Pasta' },
    });
    expect(vi.mocked(flushMealPlanWrites)).not.toHaveBeenCalled();

    cleanup();

    expect(vi.mocked(flushMealPlanWrites)).toHaveBeenCalled();
  });

  it('toggles an attendee and reveals a savable blank home-time', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    const attendWrap = screen.getByTestId('day-2026-06-08-attend-alice@e.org');
    await userEvent.click(within(attendWrap).getByRole('checkbox'));
    expect(vi.mocked(addWeekAttendee)).toHaveBeenCalledWith(
      '2026-06-08',
      expect.objectContaining({ memberId: 'alice@e.org', homeTime: null }),
    );

    // With Alice attending, the home-time input appears; leaving it blank saves null.
    mockWeek._set({
      ...emptyWeek('2026-06-08'),
      days: {
        ...emptyWeek('2026-06-08').days,
        '2026-06-08': {
          note: '',
          recipeIds: [],
          chefs: [],
          attendees: [{ memberId: 'alice@e.org', homeTime: '18:00', note: '' }],
          guests: 0,
        },
      },
    });
    // The home-time picker is a Select; choosing "No time" clears it to null.
    const timeTrigger = await screen.findByTestId('day-2026-06-08-time-alice@e.org');
    await userEvent.click(timeTrigger);
    await waitFor(() => screen.getByRole('option', { name: 'No time' }));
    await userEvent.click(screen.getByRole('option', { name: 'No time' }));
    await waitFor(() =>
      expect(vi.mocked(setWeekAttendeeHomeTime)).toHaveBeenCalledWith(
        '2026-06-08',
        'alice@e.org',
        null,
      ),
    );
  });

  // ─── Load template asks which week (#639, Phase 7) ───────────────────────
  // The offered weeks are anchored on the REAL today (the page reads the clock),
  // so the expectations are derived the same way rather than hard-coded — the
  // household's first day is 'mon' in these tests.
  const offered = () => templateWeekStarts(TODAY, 'mon');

  async function openLoadPicker(): Promise<void> {
    await userEvent.click(screen.getByTestId('load-template'));
    await waitFor(() => screen.getByTestId('load-template-picker'));
  }

  it('asks which of three weeks to fill instead of silently taking the displayed one', async () => {
    render(MealPlanWeekPage);
    await openLoadPicker();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    // Each option names its week and shows that week's dates.
    const commencing = screen.getByRole('radio', { name: /Week commencing/ });
    expect(screen.getByRole('radio', { name: /This week/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Next week/ })).toBeInTheDocument();
    expect(commencing.textContent).toMatch(/\d/);
    // Nothing is written until a week is chosen and confirmed.
    expect(vi.mocked(loadTemplateIntoWeek)).not.toHaveBeenCalled();
  });

  it('fills the week you chose, not the week on screen', async () => {
    const [, , commencingStart] = offered();
    render(MealPlanWeekPage);
    await openLoadPicker();
    await userEvent.click(screen.getByRole('radio', { name: /Week commencing/ }));
    await userEvent.click(screen.getByTestId('load-template-confirm-btn'));
    await waitFor(() =>
      expect(vi.mocked(loadTemplateIntoWeek)).toHaveBeenCalledWith(commencingStart),
    );
    // …and takes you to it, so the week that changed is the week you can see.
    expect(vi.mocked(goToWeek)).toHaveBeenCalledWith(commencingStart);
  });

  it('warns inline against exactly the offered weeks that already hold edits', async () => {
    const [thisStart, nextStart] = offered();
    vi.mocked(weekHasEdits).mockImplementation((date: string) =>
      Promise.resolve({ kind: 'ok', value: date === nextStart }),
    );
    render(MealPlanWeekPage);
    await openLoadPicker();
    const warning = await screen.findByTestId(`load-template-warning-${nextStart}`);
    // The caution is part of that option's own label, not a separate dialog.
    expect(screen.getByRole('radio', { name: /Next week/ })).toContainElement(warning);
    expect(screen.queryByTestId(`load-template-warning-${thisStart}`)).not.toBeInTheDocument();
  });

  it('says a week could not be checked rather than implying it is empty', async () => {
    const [thisStart] = offered();
    vi.mocked(weekHasEdits).mockResolvedValue({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'corruption' },
    });
    render(MealPlanWeekPage);
    await openLoadPicker();
    await screen.findByTestId(`load-template-unknown-${thisStart}`);
    expect(screen.queryByTestId(`load-template-warning-${thisStart}`)).not.toBeInTheDocument();
  });

  it('toasts when the load itself fails', async () => {
    vi.mocked(loadTemplateIntoWeek).mockResolvedValue({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
    render(MealPlanWeekPage);
    await openLoadPicker();
    await userEvent.click(screen.getByTestId('load-template-confirm-btn'));
    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith(
        'Failed to load the template.',
        'destructive',
      ),
    );
    expect(vi.mocked(goToWeek)).not.toHaveBeenCalled();
  });

  it('renders an unknown attendee as removable in the detail panel', async () => {
    mockWeek._set({
      ...emptyWeek('2026-06-08'),
      days: {
        ...emptyWeek('2026-06-08').days,
        '2026-06-08': {
          note: '',
          recipeIds: [],
          chefs: [],
          attendees: [{ memberId: 'gone@e.org', homeTime: null, note: '' }],
          guests: 0,
        },
      },
    });
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    expect(screen.getByTestId('day-2026-06-08-unknown-gone@e.org')).toBeInTheDocument();
  });

  it('reads the cook, the head count and any home time off the collapsed row (#640)', () => {
    mockWeek._set({
      ...emptyWeek('2026-06-08'),
      days: {
        ...emptyWeek('2026-06-08').days,
        '2026-06-08': {
          note: 'Roast',
          recipeIds: [],
          chefs: ['bob@e.org'],
          attendees: [
            { memberId: 'alice@e.org', homeTime: '18:00', note: 'late' },
            { memberId: 'bob@e.org', homeTime: null, note: '' },
          ],
          guests: 0,
        },
      },
    });
    render(MealPlanWeekPage);
    const meta = screen.getByTestId('day-2026-06-08-meta');
    // The cook is named — it is the fact the row is answering.
    expect(meta.textContent).toContain('Bob');
    // The table names its eaters whenever the line can hold them; "Alice & Bob"
    // with one home time is well inside the budget, so this row gets names.
    expect(meta.textContent).toContain('Alice, Bob');
    expect(meta.textContent).not.toContain('Everyone');
    // …and only Alice's time is set, so only Alice's shows.
    expect(meta.textContent).toContain('Alice 18:00');
    expect(meta.textContent).not.toContain('Bob 1');
  });

  it('marks the shop day with a labelled rule across the list (#639)', () => {
    mockShopDay._set({ date: '2026-06-10', slot: 'am' });
    render(MealPlanWeekPage);
    const rule = screen.getByTestId('day-2026-06-10-shop-marker');
    expect(rule).toHaveTextContent('Shop');
    expect(rule).toHaveTextContent('am');
    // Exactly one rule, on the shop day only.
    expect(screen.queryByTestId('day-2026-06-08-shop-marker')).not.toBeInTheDocument();
    // …and the rule is a sibling of the rows, not a badge inside one.
    expect(screen.getByTestId('day-2026-06-10').contains(rule)).toBe(false);
  });

  it('draws no rule when the week has no shop day', () => {
    render(MealPlanWeekPage);
    expect(screen.queryByTestId('day-2026-06-10-shop-marker')).not.toBeInTheDocument();
  });

  // ─── The shop day is chosen at the WEEK (#640, Phase 4) ───────────────────
  // Which day you shop is a fact about the week, so it is set once beside the
  // week's own dates — never by opening a day. The rule across the list keeps
  // displaying the answer (asserted above, unchanged).

  it('gives the header back once the shop day is set — the rule says it instead', async () => {
    mockShopDay._set({ date: '2026-06-10', slot: 'am' });
    render(MealPlanWeekPage);
    // The answer is already on the list, in place, so a header row repeating it
    // was the most expensive line on the page.
    expect(screen.queryByTestId('week-shop')).not.toBeInTheDocument();
    // …and the rule it is displayed on is the way back to the picker.
    await userEvent.click(screen.getByTestId('day-2026-06-10-shop-marker'));
    await waitFor(() => expect(screen.getByTestId('week-shop-picker')).toBeInTheDocument());
    await closeShopPicker();
  });

  it('keeps a header control while there is no shop day to tap', () => {
    // The rule cannot be the control when there is no rule — an unset week would
    // otherwise have nowhere at all to say so from.
    render(MealPlanWeekPage);
    expect(screen.getByTestId('week-shop-trigger')).toHaveTextContent('Set a shop day');
  });

  it('sets the day and the slot in one tap, without opening a day', async () => {
    render(MealPlanWeekPage);
    await openShopPicker();
    await userEvent.click(screen.getByTestId('week-shop-2026-06-10-pm'));

    expect(vi.mocked(setShopDay)).toHaveBeenCalledWith('2026-06-10', 'pm');
    // The choice was the whole question, so the dialog closes on it.
    await waitFor(() => expect(screen.queryByTestId('week-shop-picker')).not.toBeInTheDocument());
  });

  it('offers the week’s own seven days, in the household’s week order', async () => {
    // `firstDayOfWeek` is a setting ('fri' in production), so the list follows
    // `weekDates` rather than a hard-coded Mon–Sun.
    mockFirstDay._set('fri');
    mockStart._set('2026-06-12');
    mockWeek._set(emptyWeek('2026-06-12'));
    render(MealPlanWeekPage);
    await openShopPicker();

    const rows = screen.getAllByTestId(/^week-shop-row-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(
      weekDates('2026-06-12').map((d) => `week-shop-row-${d}`),
    );
    await closeShopPicker();
  });

  it('shows which slot is set, and moves the shop to another day', async () => {
    mockShopDay._set({ date: '2026-06-10', slot: 'am' });
    render(MealPlanWeekPage);
    await openShopPicker();
    // The marked day reads as chosen — at its slot only.
    expect(screen.getByTestId('week-shop-2026-06-10-am')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('week-shop-2026-06-10-pm')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('week-shop-2026-06-12-am')).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(screen.getByTestId('week-shop-2026-06-12-am'));
    expect(vi.mocked(setShopDay)).toHaveBeenCalledWith('2026-06-12', 'am');
    // Moving it is one write: the service owns the one-shop-per-week clear, and
    // this phase must not reopen that.
    expect(vi.mocked(clearShopDay)).not.toHaveBeenCalled();
  });

  it('clears the week’s shop day', async () => {
    mockShopDay._set({ date: '2026-06-10', slot: 'am' });
    render(MealPlanWeekPage);
    await openShopPicker();
    await userEvent.click(screen.getByTestId('week-shop-clear-2026-06-08'));

    expect(vi.mocked(clearShopDay)).toHaveBeenCalledWith('2026-06-10');
    expect(vi.mocked(setShopDay)).not.toHaveBeenCalled();
  });

  it('offers nothing to clear on a week with no shop day', async () => {
    render(MealPlanWeekPage);
    await openShopPicker();
    expect(screen.queryByTestId('week-shop-clear-2026-06-08')).not.toBeInTheDocument();
    await closeShopPicker();
  });

  it('offers no shop control inside a day any more', async () => {
    mockShopDay._set({ date: '2026-06-10', slot: 'am' });
    render(MealPlanWeekPage);
    await openDay('2026-06-10');

    expect(screen.getByTestId('day-2026-06-10-detail')).toBeInTheDocument();
    expect(screen.queryByTestId('day-2026-06-10-shop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('day-2026-06-10-shop-am')).not.toBeInTheDocument();
    expect(screen.queryByTestId('day-2026-06-10-shop-pm')).not.toBeInTheDocument();
  });

  it('surfaces a failed shop-day save as a toast (Rule 10)', async () => {
    vi.mocked(setShopDay).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', code: 'nope', message: 'nope' },
    } as never);
    render(MealPlanWeekPage);
    await openShopPicker();
    await userEvent.click(screen.getByTestId('week-shop-2026-06-10-am'));

    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith(
        'Failed to save the shopping day.',
        'destructive',
      ),
    );
  });

  // ─── Home time is one control (#640, Phase 2) ────────────────────────────
  // Taps go through `fireEvent`, not `userEvent`, for the reason spelled out
  // above `attachRecipe`: `userEvent` focuses on pointerdown and the popover can
  // be torn down before the click lands.
  const dayWithAlice = (homeTime: string | null) => ({
    ...emptyWeek('2026-06-08'),
    days: {
      ...emptyWeek('2026-06-08').days,
      '2026-06-08': {
        note: '',
        recipeIds: [],
        chefs: [],
        attendees: [{ memberId: 'alice@e.org', homeTime, note: '' }],
        guests: 0,
      },
    },
  });

  it('picks a home time in one tap from the dinner window on the quarter hour', async () => {
    mockWeek._set(dayWithAlice(null));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    const trigger = screen.getByTestId('day-2026-06-08-time-alice@e.org');
    // One control, not an hour + a minute: the second trigger is gone.
    expect(screen.queryByTestId('day-2026-06-08-time-min-alice@e.org')).not.toBeInTheDocument();
    // A blank home time reads as "No time"; nothing is persisted until a pick.
    expect(trigger).toHaveTextContent('No time');
    expect(vi.mocked(setWeekAttendeeHomeTime)).not.toHaveBeenCalled();

    // On offer: whole quarter-hours inside the dinner window, plus the clear.
    await fireEvent.click(trigger);
    await waitFor(() => screen.getByRole('option', { name: '19:15' }));
    expect(screen.getByRole('option', { name: 'No time' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '17:00' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '22:45' })).toBeInTheDocument();
    // No off-quarter values, and nothing outside 17:00–22:45.
    expect(screen.queryByRole('option', { name: '19:10' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '16:00' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '23:00' })).not.toBeInTheDocument();

    // One choice saves the whole "HH:mm" — no second dropdown, no seeded half.
    await fireEvent.click(screen.getByRole('option', { name: '19:15' }));
    await waitFor(() =>
      expect(vi.mocked(setWeekAttendeeHomeTime)).toHaveBeenCalledWith(
        '2026-06-08',
        'alice@e.org',
        '19:15',
      ),
    );
  });

  it('displays a stored home time verbatim, including one off the quarter hour', async () => {
    // `homeTime` is a free string in the schema, so production may hold a value
    // that is not on the list. It must still show, never silently blank or reset.
    mockWeek._set(dayWithAlice('19:10'));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    expect(screen.getByTestId('day-2026-06-08-time-alice@e.org')).toHaveTextContent('19:10');
    expect(vi.mocked(setWeekAttendeeHomeTime)).not.toHaveBeenCalled();
  });

  // ─── A member is one line (#640, Phase 3) ────────────────────────────────
  // Avatar, name, home time and chef hat share ONE row; the free-text personal
  // note hides behind an affordance on that row and drops below it when opened.
  const dayWithAliceNote = (note: string) => ({
    ...emptyWeek('2026-06-08'),
    days: {
      ...emptyWeek('2026-06-08').days,
      '2026-06-08': {
        note: '',
        recipeIds: [],
        chefs: [],
        attendees: [{ memberId: 'alice@e.org', homeTime: '18:00', note }],
        guests: 0,
      },
    },
  });

  it('puts a member on one line — avatar, name, time and chef hat together', async () => {
    mockWeek._set(dayWithAlice('18:00'));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    const row = screen.getByTestId('day-2026-06-08-attendee-alice@e.org');
    const line = row.firstElementChild!;
    expect(line).toContainElement(screen.getByTestId('day-2026-06-08-attend-alice@e.org'));
    expect(line).toContainElement(screen.getByTestId('day-2026-06-08-time-alice@e.org'));
    expect(line).toContainElement(screen.getByTestId('day-2026-06-08-chef-alice@e.org'));
    expect(line).toContainElement(screen.getByTestId('day-2026-06-08-attnote-toggle-alice@e.org'));
    // The eating toggle is still the accessible checkbox the roster is driven by.
    expect(
      within(screen.getByTestId('day-2026-06-08-attend-alice@e.org')).getByRole('checkbox'),
    ).toBeInTheDocument();
  });

  it('keeps an unwritten note behind its affordance until it is asked for', async () => {
    mockWeek._set(dayWithAliceNote(''));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    // Nothing to say about Alice tonight: no field, no wasted line.
    expect(screen.queryByTestId('day-2026-06-08-attnote-alice@e.org')).not.toBeInTheDocument();
    const toggle = screen.getByTestId('day-2026-06-08-attnote-toggle-alice@e.org');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // One tap reveals it, and typing reaches the service per keystroke — it is
    // the service that coalesces those into one document write (issue #940).
    await fireEvent.click(toggle);
    expect(await screen.findByTestId('day-2026-06-08-attnote-alice@e.org')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // `fireEvent.input` on a node queried in the SAME expression, not
    // `userEvent.type` on one held from a previous await. This field is created
    // by the tap above, and userEvent's click-then-keystroke round trip leaves
    // the sheet a window to re-render it: under load the keystrokes then land on
    // a node Svelte's delegated handler no longer reaches and NOTHING is saved —
    // a ~50% flake under the full suite, silent when the file runs alone.
    await fireEvent.input(screen.getByTestId('day-2026-06-08-attnote-alice@e.org'), {
      target: { value: 'late' },
    });
    await waitFor(() =>
      expect(vi.mocked(setWeekAttendeeNote)).toHaveBeenCalledWith(
        '2026-06-08',
        'alice@e.org',
        'late',
      ),
    );

    // Tapping again puts it away.
    await fireEvent.click(toggle);
    expect(screen.queryByTestId('day-2026-06-08-attnote-alice@e.org')).not.toBeInTheDocument();
  });

  it('shows a note that is already written without a tap, and flags it on the line', async () => {
    mockWeek._set(dayWithAliceNote('portion for tomorrow'));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    expect(screen.getByTestId('day-2026-06-08-attnote-alice@e.org')).toHaveValue(
      'portion for tomorrow',
    );
    // …and the affordance itself carries the note, so a collapsed row still says
    // that something was written.
    const toggle = screen.getByTestId('day-2026-06-08-attnote-toggle-alice@e.org');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName('Alice note: portion for tomorrow');
    await fireEvent.click(toggle);
    expect(screen.queryByTestId('day-2026-06-08-attnote-alice@e.org')).not.toBeInTheDocument();
    expect(toggle).toHaveAccessibleName('Alice note: portion for tomorrow');
  });

  it('offers no note affordance to a member who is not eating', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    expect(
      screen.queryByTestId('day-2026-06-08-attnote-toggle-alice@e.org'),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('day-2026-06-08-attnote-alice@e.org')).not.toBeInTheDocument();
  });

  it('lets a non-attending member be set as chef', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    // Alice is not attending; the Chef toggle is still present and works.
    await userEvent.click(screen.getByTestId('day-2026-06-08-chef-alice@e.org'));
    expect(vi.mocked(setWeekDayChefs)).toHaveBeenCalledWith('2026-06-08', ['alice@e.org']);
  });

  it('chef toggle styling reacts to selection state', async () => {
    const chefDay = (chefs: string[]) => ({
      ...emptyWeek('2026-06-08'),
      days: {
        ...emptyWeek('2026-06-08').days,
        '2026-06-08': { note: '', recipeIds: [], chefs, attendees: [], guests: 0 },
      },
    });
    mockWeek._set(chefDay(['alice@e.org']));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    const btn = screen.getByTestId('day-2026-06-08-chef-alice@e.org');
    expect(btn.className).toContain('bg-tertiary-tint');

    // Deselecting (chefs back to empty) must drop the selected colour.
    mockWeek._set(chefDay([]));
    await waitFor(() => expect(btn.className).not.toContain('bg-tertiary-tint'));
  });

  it('adjusts the guest count through the service', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await userEvent.click(screen.getByTestId('day-2026-06-08-guests-inc'));
    expect(vi.mocked(setWeekDayGuests)).toHaveBeenCalledWith('2026-06-08', 1);
  });

  it('auto-fills an empty meal with the attached recipe title (Phase 3, #469)', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await attachRecipe('2026-06-08', 'Spaghetti Bolognese');
    // The recipe is stored…
    expect(vi.mocked(setWeekDayRecipes)).toHaveBeenCalledWith('2026-06-08', ['r1']);
    // …and the empty meal note is auto-filled with the recipe's title.
    await waitFor(() =>
      expect(vi.mocked(setWeekDayNote)).toHaveBeenCalledWith('2026-06-08', 'Spaghetti Bolognese'),
    );
  });

  it('does not overwrite a non-empty meal when a recipe is attached (Phase 3, #469)', async () => {
    mockWeek._set({
      ...emptyWeek('2026-06-08'),
      days: {
        ...emptyWeek('2026-06-08').days,
        '2026-06-08': {
          note: 'My own dinner',
          recipeIds: [],
          chefs: [],
          attendees: [],
          guests: 0,
        },
      },
    });
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await attachRecipe('2026-06-08', 'Spaghetti Bolognese');
    // The recipe still attaches…
    expect(vi.mocked(setWeekDayRecipes)).toHaveBeenCalledWith('2026-06-08', ['r1']);
    // …but the typed meal is left untouched — the note is never rewritten.
    expect(vi.mocked(setWeekDayNote)).not.toHaveBeenCalled();
  });

  it('adds an attached recipe to the shopping list from the day detail (Phase 4, #469)', async () => {
    mockWeek._set(weekWith('2026-06-08', ['r1']));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');

    // The attached recipe row carries a per-row "Add to shop" action.
    await userEvent.click(screen.getByTestId('day-2026-06-08-recipe-addshop-r1'));

    // The familiar review sheet opens for that recipe…
    const confirm = await screen.findByTestId('recipe-add-to-list-confirm');
    expect(screen.getByTestId('recipe-add-review-list')).toBeInTheDocument();

    // …and confirming commits the plan to the default list via the shared writer.
    await userEvent.click(confirm);
    await waitFor(() => expect(vi.mocked(mockCommitRecipeAddPlan)).toHaveBeenCalled());
    const [recipeArg, listIdArg] = vi.mocked(mockCommitRecipeAddPlan).mock.calls[0]!;
    expect(recipeArg.id).toBe('r1');
    expect(listIdArg).toBe('list-1');
  });

  it('shows the friendly toast and does not open the sheet with no default list (Phase 4, #469)', async () => {
    mockDefaultListId._set(null);
    mockWeek._set(weekWith('2026-06-08', ['r1']));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');

    await userEvent.click(screen.getByTestId('day-2026-06-08-recipe-addshop-r1'));

    expect(vi.mocked(addToast)).toHaveBeenCalledWith(
      'No shopping list found. Create one first.',
      'destructive',
    );
    // The guard blocks the sheet: no review list is mounted, nothing is committed.
    expect(screen.queryByTestId('recipe-add-review-list')).not.toBeInTheDocument();
    expect(vi.mocked(mockCommitRecipeAddPlan)).not.toHaveBeenCalled();
  });

  // The rail is a continuous EDGE, not merely a column of dates (#639): the week
  // draws one line down its whole run of days. Next week recolours this same
  // element, so with only next week's stem drawn the current week looked as though
  // it had no rail at all.
  it('draws a continuous rail stem down the displayed week', () => {
    render(MealPlanWeekPage);
    const stem = screen.getByTestId('this-week-rail');
    // Spans the run of days, and is the quiet border ink — next week's job is to
    // differ from this, not the other way round.
    expect(stem.className).toContain('inset-y-0');
    expect(stem.className).toContain('border-border');
    // Decorative: the dates beside it already say what it says.
    expect(stem).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows a spinner while the week is loading', () => {
    mockLoading._set(true);
    render(MealPlanWeekPage);
    // ListPage renders its loading state; the day rows are absent.
    expect(screen.queryByTestId('day-2026-06-08')).not.toBeInTheDocument();
  });
});

// ─── The day opens in a sheet (#640, Phase 1) ──────────────────────────────
// The detail used to be a panel pushed in under the row, which shoved the rest
// of the week down the deck and lost its place. It is now a bottom sheet over a
// dimmed week, owned by the PAGE — so a snapshot landing mid-edit cannot close
// it, and only one day is ever open.
describe('MealPlanWeekPage — the day opens in a sheet (#640, Phase 1)', () => {
  it('raises the day in a dialog titled with its full date', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');

    const dialog = screen.getByRole('dialog');
    expect(dialog).toContainElement(screen.getByTestId('day-2026-06-08-detail'));
    // Written out in full — the rail's "MON / 8" is too terse to title a sheet.
    expect(screen.getByRole('heading', { name: 'Monday 8 June' })).toBeInTheDocument();
  });

  it('lifts the detail out of the row rather than nesting it under one', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');

    // Portalled to <body>: reachable by testid exactly as before, but no longer
    // inside the row — which is what stops it displacing the deck.
    const row = screen.getByTestId('day-2026-06-08');
    expect(row.contains(screen.getByTestId('day-2026-06-08-detail'))).toBe(false);
    // The row itself is unchanged, and says nothing about being expanded.
    expect(screen.getByTestId('day-2026-06-08-summary')).not.toHaveAttribute('aria-expanded');
  });

  it('dismisses on Escape, leaving the week untouched', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await userEvent.keyboard('{Escape}');

    await waitFor(() =>
      expect(screen.queryByTestId('day-2026-06-08-detail')).not.toBeInTheDocument(),
    );
    // The week is still there, in the same order — the sheet never replaced it.
    expect(screen.getByTestId('day-2026-06-08')).toBeInTheDocument();
    expect(screen.getByTestId('day-2026-06-14')).toBeInTheDocument();
  });

  it('closes from the footer control', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByTestId('day-2026-06-08-detail')).not.toBeInTheDocument(),
    );
  });

  it('opens one day at a time — the week owns which', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByTestId('day-2026-06-08-detail')).not.toBeInTheDocument(),
    );
    // The modal makes the week inert while it is up; wait for it to hand the
    // page back before tapping another row (bits-ui restores this on a timer).
    await waitFor(() => expect(document.body.style.pointerEvents).toBe(''));

    await openDay('2026-06-10');
    expect(screen.getByTestId('day-2026-06-10-detail')).toBeInTheDocument();
    expect(screen.queryByTestId('day-2026-06-08-detail')).not.toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('survives the week re-emitting mid-edit — the page owns the open day', async () => {
    render(MealPlanWeekPage);
    await openDay('2026-06-08');

    // A Firestore snapshot lands while the day is open. Under row-local state
    // this remounted the row and closed the day underneath the user (the reason
    // the e2e spec carried a re-open retry loop).
    mockWeek._set({
      ...emptyWeek('2026-06-08'),
      days: {
        ...emptyWeek('2026-06-08').days,
        '2026-06-08': { note: 'Roast', recipeIds: [], chefs: [], attendees: [], guests: 0 },
      },
    });

    await waitFor(() =>
      expect((screen.getByTestId('day-2026-06-08-note') as HTMLTextAreaElement).value).toBe(
        'Roast',
      ),
    );
    expect(screen.getByTestId('day-2026-06-08-detail')).toBeInTheDocument();
  });
});

describe('MealPlanWeekPage — landing on today (#639, Phases 2 & 4)', () => {
  it("opens with today's row at the top of the deck", async () => {
    const start = weekAroundToday(3);
    renderLaidOut(start);

    // Today is the fourth row, so the deck starts three pitches down — less the
    // lead, which keeps yesterday's bottom edge just above today's card.
    await waitFor(() => expect(deckOffset()).toBe(3 * ROW_PITCH - LEAD));
  });

  it('lands another week at the top, with no cue until it is moved', async () => {
    const start = addDays(TODAY, -30);
    mockStart._set(start);
    mockWeek._set(emptyWeek(start));
    renderLaidOut(start);

    expect(screen.getByTestId(`day-${start}`)).toBeInTheDocument();
    expect(deckOffset()).toBe(0);
    expect(screen.queryByTestId('scroll-shadow')).not.toBeInTheDocument();

    // The shadow is about position in the list, not about today — so a week
    // without today earns it just the same once the deck moves.
    await pressDeck('ArrowDown');
    await waitFor(() => expect(screen.getByTestId('scroll-shadow')).toBeInTheDocument());
  });

  it('shows the cue on arrival when the landing is mid-list', async () => {
    const start = weekAroundToday(3);
    renderLaidOut(start);

    // Landing three days down IS the reason the cue exists: nothing else says
    // there is anything above today.
    await waitFor(() => expect(screen.getByTestId('scroll-shadow')).toBeInTheDocument());
  });

  it('withdraws the cue once the deck is back at the top', async () => {
    const start = weekAroundToday(2);
    renderLaidOut(start);
    await waitFor(() => expect(screen.getByTestId('scroll-shadow')).toBeInTheDocument());

    await pressDeck('Home');

    // The spring carries it home, and the cue withdraws once it arrives.
    await waitFor(() => expect(deckOffset()).toBe(0));
    await waitFor(() => expect(screen.queryByTestId('scroll-shadow')).not.toBeInTheDocument());
  });

  it('shows no cue when today is the first day of the week', () => {
    const start = weekAroundToday(0);
    renderLaidOut(start);

    expect(deckOffset()).toBe(0);
    expect(screen.queryByTestId('scroll-shadow')).not.toBeInTheDocument();
  });

  it('moves day to day under the arrow keys', async () => {
    const start = weekAroundToday(0);
    renderLaidOut(start);

    await pressDeck('ArrowDown');
    // One press, one day — the stops are the day headers, not arbitrary pixels.
    await waitFor(() => expect(deckOffset()).toBe(ROW_PITCH - LEAD));
  });

  it('leaves a key it does not own to whatever is underneath', async () => {
    const start = weekAroundToday(0);
    renderLaidOut(start);

    const deck = screen.getByTestId('week-deck');
    deck.focus();
    // The deck owns six navigation keys and nothing else. Everything the deck
    // wraps — note fields, buttons, the day sheets — is typed into through it, so
    // a key it does not own must come back unclaimed: no `preventDefault`, no
    // travel. `fireEvent` returns false once a handler has prevented the default,
    // which is the assertion this hangs on.
    expect(await fireEvent.keyDown(deck, { key: 'a' })).toBe(true);
    expect(deckOffset()).toBe(0);
  });

  it('renders the days already behind us a step quieter', () => {
    const start = weekAroundToday(3);
    renderLaidOut(start);

    const quietness = (date: string): string =>
      screen.getByTestId(`day-${date}`).parentElement?.className ?? '';
    const dates = weekDates(start);
    // The three days before today read as looking backwards…
    expect(quietness(dates[0]!)).toContain('opacity-60');
    expect(quietness(dates[2]!)).toContain('opacity-60');
    // …today and everything ahead of it stay at full strength.
    expect(quietness(TODAY)).not.toContain('opacity-60');
    expect(quietness(dates[6]!)).not.toContain('opacity-60');
  });

  it('leaves every day at full strength in a week that is not this one', () => {
    const start = addDays(TODAY, -30);
    mockStart._set(start);
    mockWeek._set(emptyWeek(start));
    renderLaidOut(start);

    for (const date of weekDates(start)) {
      expect(screen.getByTestId(`day-${date}`).parentElement?.className ?? '').not.toContain(
        'opacity-60',
      );
    }
  });
});

// ─── Next week appears from Tuesday (#639, Phase 6) ────────────────────────
// The trigger is the last three days of the CYCLE, so these tests place today at
// index 4, 5 or 6 of the displayed week rather than naming a weekday —
// `firstDayOfWeek` is a configurable setting, and Tuesday is only its consequence
// in production.
describe('MealPlanWeekPage — next week appears from Tuesday (#639, Phase 6)', () => {
  it('appends the whole of next week under a dated mark on the first day it triggers', async () => {
    const { start, next } = weekAroundTodayWithNext(4);
    renderLaidOut(start, next);

    // The page asked the service for exactly next week — not for "some week".
    await waitFor(() => expect(vi.mocked(mockSetExtensionWeek)).toHaveBeenCalledWith(next));

    // All fourteen days are in one deck: this week's seven and next week's seven.
    for (const date of [...weekDates(start), ...weekDates(next)]) {
      expect(screen.getByTestId(`day-${date}`)).toBeInTheDocument();
    }
    // …and next week names its own dates, so "next week" is a fact not a direction.
    const mark = screen.getByTestId('next-week-mark');
    expect(mark).toHaveTextContent('Next week');
    expect(mark.textContent).toContain(
      new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }).format(new Date(`${next}T00:00:00.000Z`)),
    );
  });

  it('appends it on the last day of the cycle too', async () => {
    const { start, next } = weekAroundTodayWithNext(6);
    renderLaidOut(start, next);
    await waitFor(() => expect(screen.getByTestId('next-week-mark')).toBeInTheDocument());
    expect(screen.getByTestId(`day-${weekDates(next)[6]}`)).toBeInTheDocument();
  });

  it('shows this week alone before the last three days of the cycle', async () => {
    const { start, next } = weekAroundTodayWithNext(3);
    renderLaidOut(start);

    await waitFor(() => expect(vi.mocked(mockSetExtensionWeek)).toHaveBeenCalledWith(null));
    expect(screen.queryByTestId('next-week-mark')).not.toBeInTheDocument();
    expect(screen.queryByTestId(`day-${weekDates(next)[0]}`)).not.toBeInTheDocument();
  });

  it('never extends a week that is not the one today falls in', async () => {
    // A far-away week, viewed on any day: the extension belongs to today's week.
    const start = addDays(TODAY, -30);
    mockStart._set(start);
    mockWeek._set(emptyWeek(start));
    mockFirstDay._set(weekdayOf(TODAY));
    mockExtensionWeek._set(emptyWeek(addDays(start, 7)));
    renderLaidOut(start);

    await waitFor(() => expect(vi.mocked(mockSetExtensionWeek)).toHaveBeenCalledWith(null));
    expect(screen.queryByTestId('next-week-mark')).not.toBeInTheDocument();
    // …and it lands at the top of that week, not mid-list.
    expect(deckOffset()).toBe(0);
  });

  it('keeps the header range on the primary week — prev/next still mean one week', async () => {
    const { start, next } = weekAroundTodayWithNext(5);
    renderLaidOut(start, next);
    await waitFor(() => expect(screen.getByTestId('next-week-mark')).toBeInTheDocument());

    const primaryEnd = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${weekDates(start)[6]}T00:00:00.000Z`));
    expect(screen.getByTestId('week-range').textContent).toContain(primaryEnd);
    // The label stops at this week: next week's last day is not in it.
    const nextEnd = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(`${weekDates(next)[6]}T00:00:00.000Z`));
    expect(screen.getByTestId('week-range').textContent).not.toContain(nextEnd);
  });

  it("shows both weeks' shop rules in the same scroll", async () => {
    const { start, next } = weekAroundTodayWithNext(5);
    const thisShop = weekDates(start)[6]!;
    const nextShop = weekDates(next)[1]!;
    mockShopDay._set({ date: thisShop, slot: 'pm' });
    mockExtensionShopDay._set({ date: nextShop, slot: 'am' });
    renderLaidOut(start, next);

    await waitFor(() => expect(screen.getByTestId('next-week-mark')).toBeInTheDocument());
    expect(screen.getByTestId(`day-${thisShop}-shop-marker`)).toHaveTextContent('pm');
    expect(screen.getByTestId(`day-${nextShop}-shop-marker`)).toHaveTextContent('am');
  });

  it("offers next week's days in the shop picker, and leaves this week's shop alone", async () => {
    // On a Wednesday the week you are provisioning IS next week, so the days on
    // the deck are the days on offer. Marking one is week-scoped by the service.
    const { start, next } = weekAroundTodayWithNext(5);
    const thisShop = weekDates(start)[6]!;
    mockShopDay._set({ date: thisShop, slot: 'pm' });
    renderLaidOut(start, next);
    await waitFor(() => expect(screen.getByTestId('next-week-mark')).toBeInTheDocument());

    await openShopPicker();
    const nextShop = weekDates(next)[1]!;
    await userEvent.click(screen.getByTestId(`week-shop-${nextShop}-am`));

    expect(vi.mocked(setShopDay)).toHaveBeenCalledWith(nextShop, 'am');
    // Nothing here clears anything: one shop per week is the service's rule, and
    // this week's rule is still drawn.
    expect(vi.mocked(clearShopDay)).not.toHaveBeenCalled();
    expect(screen.getByTestId(`day-${thisShop}-shop-marker`)).toBeInTheDocument();
  });

  it("marks next week's rows for the terracotta rail, and leaves this week's alone", async () => {
    const { start, next } = weekAroundTodayWithNext(5);
    renderLaidOut(start, next);
    await waitFor(() => expect(screen.getByTestId('next-week-mark')).toBeInTheDocument());

    const railOf = (date: string): string =>
      screen.getByTestId(`day-${date}`).parentElement?.className ?? '';
    for (const date of weekDates(next)) expect(railOf(date)).toContain('planner-next-week-row');
    for (const date of weekDates(start)) {
      expect(railOf(date)).not.toContain('planner-next-week-row');
    }
    // The colour is week-scoped on the block, not a prop on MealDayEditor.
    expect(screen.getByTestId('next-week-block').getAttribute('style')).toContain(
      '--planner-rail-ink',
    );
  });

  it('leaves today its filled teal disc even with next week on screen', async () => {
    const { start, next } = weekAroundTodayWithNext(5);
    renderLaidOut(start, next);
    await waitFor(() => expect(screen.getByTestId('next-week-mark')).toBeInTheDocument());

    // Today outranks which week it is in: the disc is untouched, and today's row
    // never carries the next-week rail class.
    expect(screen.getByTestId(`day-${TODAY}-date`).className).toContain('bg-primary');
    expect(screen.getByTestId(`day-${TODAY}`).parentElement?.className ?? '').not.toContain(
      'planner-next-week-row',
    );
  });

  it('puts today at the top with next week below it — the appended days are what let it', async () => {
    const { start, next } = weekAroundTodayWithNext(5);
    renderLaidOut(start, next);

    // Today is the sixth row. With one week (7 rows over a 700px viewport) the
    // deck could only travel 844px and today would land clamped short of the top;
    // with next week appended it reaches its own pitch exactly.
    await waitFor(() => expect(deckOffset()).toBe(5 * ROW_PITCH - LEAD));
  });

  it('reaches next week by gesture — one deck, not two lists', async () => {
    const { start, next } = weekAroundTodayWithNext(5);
    renderLaidOut(start, next);
    await waitFor(() => expect(deckOffset()).toBe(5 * ROW_PITCH - LEAD));

    // Two days on from today is the first day of NEXT week, and the deck stops on
    // it: next week's rows are stops in the same deck, not a separate scroller.
    const deck = screen.getByTestId('week-deck');
    deck.focus();
    // One press, one day — and the spring must land before the next press, or the
    // second stop is measured from mid-flight.
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(deckOffset()).toBe(6 * ROW_PITCH - LEAD));
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(deckOffset()).toBe(7 * ROW_PITCH - LEAD));
  });

  it('edits a day in next week under that day’s own date key', async () => {
    const { start, next } = weekAroundTodayWithNext(5);
    renderLaidOut(start, next);
    await waitFor(() => expect(screen.getByTestId('next-week-mark')).toBeInTheDocument());

    const nextDay = weekDates(next)[2]!;
    await openDay(nextDay);
    // One atomic `input`, not a keystroke stream (#793). The day opens in a Sheet,
    // and bits-ui traps focus into the dialog in an effect. `userEvent.type` focuses
    // the textarea by clicking it and then types into whatever is focused *now*, so
    // when that trap lands between the click and the first keystroke — which is what
    // a loaded machine makes likely — every character goes to the dialog container
    // and NOT ONE `input` event reaches the textarea. `setWeekDayNote` is called
    // straight from `oninput` with no debounce and no readiness gate, so zero events
    // means the wait below can never come true and burns the whole budget: it failed
    // at ~1095ms on a 1000ms budget and ~5105ms on a 5000ms one, the signature of a
    // condition that never holds rather than one that needs longer. `fireEvent.input`
    // depends on no focus at all, and this test is about where the edit is ROUTED.
    await fireEvent.input(screen.getByTestId(`day-${nextDay}-note`), {
      target: { value: 'Roast' },
    });

    // The date key IS the routing (Phase 5): no week argument, and never this
    // week's date for a day that belongs to next week.
    await waitFor(() => expect(vi.mocked(setWeekDayNote)).toHaveBeenCalled());
    expect(vi.mocked(setWeekDayNote).mock.calls[0]![0]).toBe(nextDay);
  });

  it('surfaces a refused save instead of swallowing it', async () => {
    // A week the service has not read is one it refuses to overwrite. With two
    // weeks on screen a silent refusal would look exactly like a saved edit.
    vi.mocked(setWeekDayGuests).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'ValidationError', code: 'WEEK_NOT_LOADED', message: 'nope' },
    } as never);
    const { start, next } = weekAroundTodayWithNext(5);
    renderLaidOut(start, next);
    await waitFor(() => expect(screen.getByTestId('next-week-mark')).toBeInTheDocument());

    const nextDay = weekDates(next)[2]!;
    await openDay(nextDay);
    await userEvent.click(screen.getByTestId(`day-${nextDay}-guests-inc`));

    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('Failed to save the day.', 'destructive'),
    );
  });

  it('drops next week when the planner is left', async () => {
    const { start, next } = weekAroundTodayWithNext(5);
    renderLaidOut(start, next);
    await waitFor(() => expect(vi.mocked(mockSetExtensionWeek)).toHaveBeenCalledWith(next));

    cleanup();
    // The service is a module singleton; leaving must not leave a second week
    // (and a second shop-day range read) subscribed behind us.
    expect(vi.mocked(mockSetExtensionWeek)).toHaveBeenLastCalledWith(null);
  });
});

// ─── "When you CBA" in the planner (#637, Phase 4) ─────────────────────────
// An outing fills a dinner slot like any other entry — same picker, same note
// auto-fill, same hero thumbnail — and offers nothing that does not apply to it.
// A cocktail is not dinner and is never offered at all. Every one of these is a
// consequence of the DOMAIN predicates (`isPlannable`, `takesIngredients`), so
// the assertions are about what the screen offers, not about the kind string.
describe('MealPlanWeekPage — when you CBA (#637, Phase 4)', () => {
  it('offers CBA options alongside recipes, and never a cocktail', async () => {
    mockRecipes._set([RECIPE, OUTING, COCKTAIL]);
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await openPicker('2026-06-08');

    expect(screen.getByRole('option', { name: 'Spaghetti Bolognese' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Takeaway — Indian/ })).toBeInTheDocument();
    // `isPlannable('cocktail')` is false, so it is not on the menu for a dinner.
    expect(screen.queryByRole('option', { name: /Negroni/ })).not.toBeInTheDocument();
  });

  it('drops an already-attached CBA option from the picker', async () => {
    mockRecipes._set([RECIPE, OUTING]);
    mockWeek._set(weekWith('2026-06-08', ['o1']));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await openPicker('2026-06-08');

    // Attached once is enough — the same night out can't be added twice.
    expect(screen.queryByRole('option', { name: /Takeaway — Indian/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Spaghetti Bolognese' })).toBeInTheDocument();
  });

  it('badges a CBA option and leaves a recipe unmarked', async () => {
    mockRecipes._set([RECIPE, OUTING]);
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await openPicker('2026-06-08');

    const outing = screen.getByRole('option', { name: /Takeaway — Indian/ });
    expect(within(outing).getByText('When you CBA')).toBeInTheDocument();

    // The default kind wears nothing: the picker looks exactly as it does today
    // for anyone who never adds an alternative.
    const recipe = screen.getByRole('option', { name: 'Spaghetti Bolognese' });
    expect(recipe.textContent?.trim()).toBe('Spaghetti Bolognese');
  });

  it('auto-fills an empty meal with a CBA title exactly as with a recipe', async () => {
    mockRecipes._set([RECIPE, OUTING]);
    render(MealPlanWeekPage);
    await openDay('2026-06-08');
    await attachRecipe('2026-06-08', /Takeaway — Indian/);

    // Attaching is attaching: `addRecipe` deliberately does NOT branch on kind,
    // so the day gets its title just as a recipe night would.
    expect(vi.mocked(setWeekDayRecipes)).toHaveBeenCalledWith('2026-06-08', ['o1']);
    await waitFor(() =>
      expect(vi.mocked(setWeekDayNote)).toHaveBeenCalledWith('2026-06-08', 'Takeaway — Indian'),
    );
  });

  it('offers no "Add to shop" on an attached CBA night, but still does on a recipe', async () => {
    mockRecipes._set([RECIPE, OUTING]);
    mockWeek._set(weekWith('2026-06-08', ['r1', 'o1']));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');

    // Both rows render — the outing is a first-class night, not a lesser one…
    expect(screen.getByTestId('day-2026-06-08-recipe-row-o1')).toBeInTheDocument();
    expect(screen.getByTestId('day-2026-06-08-recipe-row-r1')).toBeInTheDocument();
    // …but a takeaway has nothing to buy, so the action simply isn't there.
    expect(screen.queryByTestId('day-2026-06-08-recipe-addshop-o1')).not.toBeInTheDocument();
    expect(screen.getByTestId('day-2026-06-08-recipe-addshop-r1')).toBeInTheDocument();
    // Removing works on either, so a wrongly-attached outing is not stuck.
    expect(screen.getByTestId('day-2026-06-08-recipe-remove-o1')).toBeInTheDocument();
  });

  it('wears the kind pictogram when a CBA option has no hero image', async () => {
    mockRecipes._set([RECIPE, OUTING]);
    mockWeek._set(weekWith('2026-06-08', ['o1']));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');

    // No image on the fixture, so the row falls back to the kind's own glyph
    // rather than a cooking pot.
    const fallback = screen.getByTestId('day-2026-06-08-recipe-thumb-fallback-o1');
    expect(fallback.querySelector('.lucide-hand-platter')).not.toBeNull();
  });

  it('shows the hero thumbnail even on a document still carrying legacy imageHidden', async () => {
    // `imageHidden` is retired and no longer read anywhere in web-pwa; a stale
    // `true` must not blank the planner thumbnail while the same photo shows on
    // the recipe list and view pages.
    mockRecipes._set([
      {
        ...OUTING,
        image: { url: 'https://example.test/curry.webp', source: 'ai' },
        imageHidden: true,
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    ]);
    mockWeek._set(weekWith('2026-06-08', ['o1']));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');

    const thumb = screen.getByTestId('day-2026-06-08-recipe-thumb-o1');
    expect(thumb.getAttribute('src')).toContain('https://example.test/curry.webp');
    expect(screen.queryByTestId('day-2026-06-08-recipe-thumb-fallback-o1')).not.toBeInTheDocument();
  });
});

// ─── Shop the week (#724, Phase 1) ─────────────────────────────────────────
// The header's cart offers the whole week at once and then drives the EXISTING
// review sheet, once per pick, in day order. What is worth testing here is
// therefore not the review — that is covered where it lives — but the four
// decisions this page makes: which week the deck is on, which nights are still
// ahead, which entries can be shopped for at all, and how the queue advances.
describe('MealPlanWeekPage — shop the week (#724, Phase 1)', () => {
  // A second dish, so a sequence has somewhere to go.
  const RECIPE_2 = entry('r2', 'Chilli con carne', 4);

  /** A week whose days carry the given recipe ids. */
  function planned(start: string, plan: Record<string, string[]>): MealPlanWeek {
    const base = emptyWeek(start);
    const days = { ...base.days };
    for (const [date, recipeIds] of Object.entries(plan)) {
      days[date] = { note: '', recipeIds, chefs: [], attendees: [], guests: 0 };
    }
    return { ...base, days };
  }

  async function openShopWeek(): Promise<void> {
    await userEvent.click(screen.getByTestId('shop-week-trigger'));
    await screen.findByTestId('shop-week-list');
  }

  /** Dismiss the selection sheet the way a user would (see closeShopPicker). */
  async function cancelShopWeek(): Promise<void> {
    await userEvent.click(screen.getByTestId('shop-week-cancel'));
    await waitFor(() => expect(screen.queryByTestId('shop-week-list')).not.toBeInTheDocument());
  }

  /** Confirm whichever review sheet is currently open. */
  async function confirmReview(): Promise<void> {
    await userEvent.click(await screen.findByTestId('recipe-add-to-list-confirm'));
  }

  const YESTERDAY = addDays(TODAY, -1);
  const TOMORROW = addDays(TODAY, 1);

  it('offers every recipe planned from today onward, one row per recipe', async () => {
    mockRecipes._set([RECIPE, COCKTAIL]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: ['r1', 'c1'], [TOMORROW]: ['r1'] }));
    renderLaidOut(start);

    await openShopWeek();

    // A night with two entries lists both, and a cocktail is offered — it takes
    // ingredients, so it can be shopped for even though it is not dinner.
    expect(screen.getByTestId(`shop-week-row-${TODAY}-r1`)).toBeInTheDocument();
    expect(screen.getByTestId(`shop-week-row-${TODAY}-c1`)).toBeInTheDocument();
    // The same recipe on a second night is its own row, under its own night.
    expect(screen.getByTestId(`shop-week-row-${TOMORROW}-r1`)).toBeInTheDocument();
    expect(screen.getByTestId(`shop-week-night-${TODAY}`)).toBeInTheDocument();
    // All of them start ticked, and the confirm names the count.
    expect(screen.getByTestId('shop-week-confirm')).toHaveTextContent('Review 3 recipes');

    await cancelShopWeek();
  });

  it('leaves out a takeaway, a note-only placeholder and a night already behind us', async () => {
    const PLACEHOLDER = entry('p1', 'A good dinner', null, 'placeholder');
    mockRecipes._set([RECIPE, OUTING, PLACEHOLDER]);
    const start = weekAroundToday(2);
    mockWeek._set(
      planned(start, {
        [YESTERDAY]: ['r1'],
        [TODAY]: ['r1', 'o1', 'p1'],
      }),
    );
    renderLaidOut(start);

    await openShopWeek();

    // `takesIngredients` is the gate, never a `kind ===` comparison: neither an
    // outing nor a placeholder has anything to buy.
    expect(screen.getByTestId(`shop-week-row-${TODAY}-r1`)).toBeInTheDocument();
    expect(screen.queryByTestId(`shop-week-row-${TODAY}-o1`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`shop-week-row-${TODAY}-p1`)).not.toBeInTheDocument();
    // Yesterday's dinner has been and gone — not listed unticked, not listed at all.
    expect(screen.queryByTestId(`shop-week-night-${YESTERDAY}`)).not.toBeInTheDocument();
    expect(screen.getByTestId('shop-week-confirm')).toHaveTextContent('Review 1 recipe');

    await cancelShopWeek();
  });

  it('says a week with nothing left has nothing to shop for', async () => {
    mockRecipes._set([RECIPE]);
    // A week entirely behind us: every night is in the past, so nothing is offered.
    const start = addDays(TODAY, -30);
    mockStart._set(start);
    mockWeek._set(planned(start, { [addDays(start, 3)]: ['r1'] }));
    renderLaidOut(start);

    await openShopWeek();

    expect(screen.getByTestId('shop-week-empty')).toBeInTheDocument();
    expect(screen.getByTestId('shop-week-confirm')).toBeDisabled();

    await cancelShopWeek();
  });

  it("offers next week's nights once the deck is scrolled into them", async () => {
    mockRecipes._set([RECIPE, RECIPE_2]);
    const { start, next } = weekAroundTodayWithNext(5);
    const nextDay = weekDates(next)[2]!;
    mockWeek._set(planned(start, { [TODAY]: ['r1'] }));
    mockExtensionWeek._set(planned(next, { [nextDay]: ['r2'] }));
    renderLaidOut(start, next);
    await waitFor(() => expect(screen.getByTestId('next-week-mark')).toBeInTheDocument());

    // The week shopped follows the deck, not the header range: scroll down past
    // the "Next week" mark and it is next week's nights that are offered.
    const deck = screen.getByTestId('week-deck');
    deck.focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(deckOffset()).toBeGreaterThanOrEqual(7 * ROW_PITCH - LEAD));

    await openShopWeek();

    expect(screen.getByTestId(`shop-week-row-${nextDay}-r2`)).toBeInTheDocument();
    expect(screen.queryByTestId(`shop-week-row-${TODAY}-r1`)).not.toBeInTheDocument();

    await cancelShopWeek();
  });

  it('reviews each ticked recipe in turn, committing as each is confirmed', async () => {
    mockRecipes._set([RECIPE, RECIPE_2]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: ['r1'], [TOMORROW]: ['r2'] }));
    renderLaidOut(start);

    await openShopWeek();
    await userEvent.click(screen.getByTestId('shop-week-confirm'));

    // The selection sheet is gone before the first review sheet appears — the two
    // never stack.
    await waitFor(() => expect(screen.queryByTestId('shop-week-list')).not.toBeInTheDocument());

    // First recipe, in day order.
    await confirmReview();
    await waitFor(() => expect(vi.mocked(mockCommitRecipeAddPlan)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(mockCommitRecipeAddPlan).mock.calls[0]![0].id).toBe('r1');

    // …then the next one's sheet opens in its place.
    await confirmReview();
    await waitFor(() => expect(vi.mocked(mockCommitRecipeAddPlan)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(mockCommitRecipeAddPlan).mock.calls[1]![0].id).toBe('r2');
    expect(vi.mocked(mockCommitRecipeAddPlan).mock.calls[1]![1]).toBe('list-1');

    // The last one done, nothing is left open.
    await waitFor(() =>
      expect(screen.queryByTestId('recipe-add-review-list')).not.toBeInTheDocument(),
    );
  });

  it('reviews only the nights left ticked', async () => {
    mockRecipes._set([RECIPE, RECIPE_2]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: ['r1'], [TOMORROW]: ['r2'] }));
    renderLaidOut(start);

    await openShopWeek();
    // The testid lands on the primitive's wrapper; the control inside it is what
    // a user actually presses.
    await userEvent.click(
      within(screen.getByTestId(`shop-week-tick-${TODAY}-r1`)).getByRole('checkbox'),
    );
    expect(screen.getByTestId('shop-week-confirm')).toHaveTextContent('Review 1 recipe');
    await userEvent.click(screen.getByTestId('shop-week-confirm'));

    await confirmReview();
    await waitFor(() => expect(vi.mocked(mockCommitRecipeAddPlan)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(mockCommitRecipeAddPlan).mock.calls[0]![0].id).toBe('r2');
    await waitFor(() =>
      expect(screen.queryByTestId('recipe-add-review-list')).not.toBeInTheDocument(),
    );
  });

  it('skips a recipe whose sheet is dismissed and opens the next', async () => {
    mockRecipes._set([RECIPE, RECIPE_2]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: ['r1'], [TOMORROW]: ['r2'] }));
    renderLaidOut(start);

    await openShopWeek();
    await userEvent.click(screen.getByTestId('shop-week-confirm'));
    await screen.findByTestId('recipe-add-review-list');

    // Closing without confirming is a skip, not an abort: the next recipe opens
    // and nothing was written for the one dismissed. In a sequence the dismiss
    // control says exactly that (#724, Phase 2).
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await confirmReview();
    await waitFor(() => expect(vi.mocked(mockCommitRecipeAddPlan)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(mockCommitRecipeAddPlan).mock.calls[0]![0].id).toBe('r2');
  });

  it('stops the sequence on a failed write instead of rolling on', async () => {
    vi.mocked(mockCommitRecipeAddPlan).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'write-failed', message: 'nope' },
    } as never);
    mockRecipes._set([RECIPE, RECIPE_2]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: ['r1'], [TOMORROW]: ['r2'] }));
    renderLaidOut(start);

    await openShopWeek();
    await userEvent.click(screen.getByTestId('shop-week-confirm'));

    await confirmReview();
    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith(
        'Failed to add to shopping list.',
        'destructive',
      ),
    );

    // The failed recipe's sheet is still the one on screen — the sequence has not
    // moved on. Confirming again retries THAT recipe, not the next one.
    await confirmReview();
    await waitFor(() => expect(vi.mocked(mockCommitRecipeAddPlan)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(mockCommitRecipeAddPlan).mock.calls[1]![0].id).toBe('r1');
  });

  it('shows the friendly toast and opens nothing with no default list', async () => {
    mockDefaultListId._set(null);
    mockRecipes._set([RECIPE]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: ['r1'] }));
    renderLaidOut(start);

    await userEvent.click(screen.getByTestId('shop-week-trigger'));

    // Guarded ONCE, before the selection sheet — not per recipe.
    expect(vi.mocked(addToast)).toHaveBeenCalledWith(
      'No shopping list found. Create one first.',
      'destructive',
    );
    expect(screen.queryByTestId('shop-week-list')).not.toBeInTheDocument();
    expect(vi.mocked(mockCommitRecipeAddPlan)).not.toHaveBeenCalled();
  });

  // ─── Resolving the ids a day holds (issue #1055 characterisation) ────────────
  // `shopWeekEntries` resolves each night's `recipeIds` against the store and
  // silently skips an id with no matching document — a recipe deleted since it
  // was attached. Nothing asserted that: every `recipeIds` fixture in this file
  // resolves, so deleting the skip failed no test here.
  //
  // The eligibility predicate rides in the same filter, and the two are about to
  // be separated so the resolution can be shared. These rows are what says the
  // result set did not move: a dead id and an ineligible recipe are BOTH absent,
  // and they are absent for different reasons.
  it('skips an id whose recipe is gone, and still offers the ones beside it', async () => {
    mockRecipes._set([RECIPE, RECIPE_2]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: ['ghost', 'r1', 'r2'] }));
    renderLaidOut(start);

    await openShopWeek();

    // Never a blank row: the id resolves to nothing and drops out entirely.
    expect(screen.queryByTestId(`shop-week-row-${TODAY}-ghost`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`shop-week-row-${TODAY}-r1`)).toBeInTheDocument();
    expect(screen.getByTestId(`shop-week-row-${TODAY}-r2`)).toBeInTheDocument();
    expect(screen.getByTestId('shop-week-confirm')).toHaveTextContent('Review 2 recipes');

    await cancelShopWeek();
  });

  it('leaves a night whose every id is dead out of the list altogether', async () => {
    mockRecipes._set([RECIPE]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: ['ghost', 'also-ghost'], [TOMORROW]: ['r1'] }));
    renderLaidOut(start);

    await openShopWeek();

    expect(screen.queryByTestId(`shop-week-night-${TODAY}`)).not.toBeInTheDocument();
    expect(screen.getByTestId(`shop-week-night-${TOMORROW}`)).toBeInTheDocument();
    expect(screen.getByTestId('shop-week-confirm')).toHaveTextContent('Review 1 recipe');

    await cancelShopWeek();
  });
});

// ─── The sequence knows where it is (#724, Phase 2) ────────────────────────
// Three optional props on the review sheet, and the two facts the planner is
// uniquely able to supply: which of how many this recipe is, and how many people
// are actually eating that night.
describe('MealPlanWeekPage — shop the week, in sequence (#724, Phase 2)', () => {
  const RECIPE_2 = entry('r2', 'Chilli con carne', 4);

  function planned(start: string, plan: Record<string, Day>): MealPlanWeek {
    const base = emptyWeek(start);
    return { ...base, days: { ...base.days, ...plan } };
  }

  function night(recipeIds: string[], attendees: string[] = [], guests = 0): Day {
    return {
      note: '',
      recipeIds,
      chefs: [],
      attendees: attendees.map((memberId) => ({ memberId, homeTime: null, note: '' })),
      guests,
    };
  }

  const TOMORROW = addDays(TODAY, 1);

  // `clearAllMocks` keeps implementations, so a per-test item count would leak
  // into whatever is written after this block. Put the file's default back.
  afterEach(() => {
    mockRecipeAddPlanItemCount.mockReturnValue(1);
  });

  async function runShopWeek(): Promise<void> {
    await userEvent.click(screen.getByTestId('shop-week-trigger'));
    await screen.findByTestId('shop-week-list');
    await userEvent.click(screen.getByTestId('shop-week-confirm'));
    await screen.findByTestId('recipe-add-review-list');
  }

  it('names each recipe and its place in the run, and offers Skip rather than Cancel', async () => {
    mockRecipes._set([RECIPE, RECIPE_2]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: night(['r1']), [TOMORROW]: night(['r2']) }));
    renderLaidOut(start);

    await runShopWeek();

    expect(screen.getByText('Spaghetti Bolognese')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-add-sequence')).toHaveTextContent('1 of 2');
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('recipe-add-to-list-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('recipe-add-sequence')).toHaveTextContent('2 of 2'),
    );
    expect(screen.getByText('Chilli con carne')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('recipe-add-to-list-confirm'));
  });

  it("opens at the night's headcount, and at the recipe's own servings when nobody is marked", async () => {
    mockRecipes._set([RECIPE, RECIPE_2]);
    const start = weekAroundToday(2);
    mockWeek._set(
      planned(start, {
        // Two eating plus a guest…
        [TODAY]: night(['r1'], [ALICE.id, BOB.id], 1),
        // …and a night nobody has filled in.
        [TOMORROW]: night(['r2']),
      }),
    );
    renderLaidOut(start);

    await runShopWeek();

    // The planner's number, not the recipe's own 2.
    await waitFor(() =>
      expect(screen.getByTestId('recipe-servings-value')).toHaveTextContent('3 servings'),
    );
    // And it is what the plan is actually built at.
    expect(vi.mocked(mockBuildRecipeAddPlan).mock.calls.at(-1)![1]).toBe(3);

    // The stepper still moves freely from there.
    await userEvent.click(screen.getByTestId('recipe-servings-increase'));
    await waitFor(() =>
      expect(screen.getByTestId('recipe-servings-value')).toHaveTextContent('4 servings'),
    );

    await userEvent.click(screen.getByTestId('recipe-add-to-list-confirm'));

    // A night with nobody marked falls back to the recipe's own servings — a
    // headcount of zero would otherwise scale it to nothing.
    await waitFor(() =>
      expect(screen.getByTestId('recipe-servings-value')).toHaveTextContent('4 servings'),
    );
    expect(vi.mocked(mockBuildRecipeAddPlan).mock.calls.at(-1)![1]).toBe(4);
  });

  it('says how much went on the list once, at the end', async () => {
    mockRecipeAddPlanItemCount.mockReturnValue(3);
    mockRecipes._set([RECIPE, RECIPE_2]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: night(['r1']), [TOMORROW]: night(['r2']) }));
    renderLaidOut(start);

    await runShopWeek();
    await userEvent.click(screen.getByTestId('recipe-add-to-list-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('recipe-add-sequence')).toHaveTextContent('2 of 2'),
    );
    // Nothing said yet — the run is still going.
    expect(vi.mocked(addToast)).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('recipe-add-to-list-confirm'));

    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('Added 6 items to the list.', 'success'),
    );
    expect(vi.mocked(addToast)).toHaveBeenCalledTimes(1);
  });

  it('counts only what was confirmed when a recipe is skipped', async () => {
    mockRecipeAddPlanItemCount.mockReturnValue(2);
    mockRecipes._set([RECIPE, RECIPE_2]);
    const start = weekAroundToday(2);
    mockWeek._set(planned(start, { [TODAY]: night(['r1']), [TOMORROW]: night(['r2']) }));
    renderLaidOut(start);

    await runShopWeek();
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await userEvent.click(await screen.findByTestId('recipe-add-to-list-confirm'));

    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('Added 2 items to the list.', 'success'),
    );
  });

  it('leaves the per-day add exactly as it was — one recipe, its own toast', async () => {
    mockRecipeAddPlanItemCount.mockReturnValue(1);
    mockRecipes._set([RECIPE]);
    mockWeek._set(weekWith('2026-06-08', ['r1']));
    render(MealPlanWeekPage);
    await openDay('2026-06-08');

    await userEvent.click(screen.getByTestId('day-2026-06-08-recipe-addshop-r1'));
    // No sequence, no override: the action names itself and the dismiss is a
    // Cancel, exactly as on a recipe's own page.
    await screen.findByTestId('recipe-add-review-list');
    expect(screen.queryByTestId('recipe-add-sequence')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByTestId('recipe-servings-value')).toHaveTextContent('2 servings');

    await userEvent.click(screen.getByTestId('recipe-add-to-list-confirm'));
    await waitFor(() =>
      expect(vi.mocked(addToast)).toHaveBeenCalledWith('Added 1 item to the list.', 'success'),
    );
  });
});

// Issue #933 characterisation net. `MealPlanWeekPage` carries a guarded
// `matchMedia` `$effect` (byte-identical to the one in `CatalogPage` and
// `RecipeViewPage`) that a later phase will extract into one shared helper.
// This file pins every failure path the extraction must preserve — today none
// of them is tested anywhere.
//
// Asserted through rendered output: `isSplit` gates whether `<aside
// data-testid="day-pane">` gets CONTENT — `paneDate = isSplit ? openDay :
// null`, and `openDay` seeds itself to the week's first day (`todayIndex < 0`
// here, since the fixture week is not the real calendar week) the instant
// `isSplit` goes true, with no click required. `day-pane-title` is therefore
// present iff the query reads as split.
describe('MealPlanWeekPage — the split-pane media query, failure paths (#933)', () => {
  const realMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  /** A complete `MediaQueryList` stub — the shape the house pattern expects. */
  function fullStub(
    matches: boolean,
    addEventListener: (type: string, fn: (e: MediaQueryListEvent) => void) => void = () => {},
    removeEventListener: (type: string, fn: (e: MediaQueryListEvent) => void) => void = () => {},
  ): typeof window.matchMedia {
    return ((query: string) => ({
      media: query,
      matches,
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  const expectedPaneTitle = formatDayKey('2026-06-08', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  // UT-D1/D2: these four differ only in the `matchMedia` stub, and each row
  // names the failure path it stands for.
  it.each([
    [
      'matches: true, full listener API — the pane shows the day (the positive control every other row depends on)',
      () => {
        window.matchMedia = fullStub(true);
      },
      true,
    ],
    [
      'matchMedia missing entirely — falls back to the phone layout, no throw',
      () => {
        window.matchMedia = undefined as unknown as typeof window.matchMedia;
      },
      false,
    ],
    [
      'matchMedia throws on call — falls back to the phone layout, no throw',
      () => {
        window.matchMedia = (() => {
          throw new Error('matchMedia is not supported here');
        }) as unknown as typeof window.matchMedia;
      },
      false,
    ],
    [
      'MediaQueryList with no addEventListener, matches: true — the one-shot read still splits',
      () => {
        window.matchMedia = ((query: string) => ({
          media: query,
          matches: true,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
      },
      true,
    ],
  ] as const)('%s', async (_label, setUp, expectSplit) => {
    setUp();
    render(MealPlanWeekPage);

    // `week-deck` always mounts; waiting on it settles the initial render before
    // asserting the pane one way or the other.
    await waitFor(() => expect(screen.getByTestId('week-deck')).toBeInTheDocument());

    if (expectSplit) {
      await waitFor(() => {
        expect(screen.getByTestId('day-pane-title')).toHaveTextContent(expectedPaneTitle);
      });
    } else {
      expect(screen.queryByTestId('day-pane-title')).toBeNull();
    }
  });

  it('subscribes the query’s change listener, follows it live, and unsubscribes the SAME handler on unmount', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    // Starts unsplit so the live flip (not just the initial read) is what
    // proves the listener works.
    window.matchMedia = fullStub(false, addEventListener, removeEventListener);

    const { unmount } = render(MealPlanWeekPage);

    await waitFor(() =>
      expect(addEventListener).toHaveBeenCalledWith('change', expect.any(Function)),
    );
    const onChange = addEventListener.mock.calls[0]![1] as (e: MediaQueryListEvent) => void;

    expect(screen.queryByTestId('day-pane-title')).toBeNull();

    // Fire the captured handler — the observable fact is the rendering flips,
    // with no remount.
    onChange({ matches: true } as MediaQueryListEvent);
    await waitFor(() => {
      expect(screen.getByTestId('day-pane-title')).toHaveTextContent(expectedPaneTitle);
    });

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith('change', onChange);
  });
});
