import {
  subscribeFreezerConfig,
  saveFreezerConfig,
  subscribeFreezerItems,
  saveFreezerItem,
  deleteFreezerItem,
  takeFreezerItemAmount,
  subscribeDefrosts,
  commitFromFreezer,
  saveDefrost,
  deleteDefrost,
} from '@salt/firebase-sync';
import {
  addFreezer as addFreezerCommand,
  addFreezerItem as addFreezerItemCommand,
  editFreezerItem,
  emptyFreezerConfig,
  forgetSupplier as forgetSupplierCommand,
  moveFreezerItem,
  recordBagNumber,
  rememberSupplier,
  removeFreezer as removeFreezerCommand,
  removeFreezerItem as removeFreezerItemCommand,
  renameFreezer as renameFreezerCommand,
  setFreezerItemAmount,
  setShelves,
  supplierSpelling,
  takeFreezerPacks,
  commitDefrost,
  nextPlannedNight,
  type AddFreezerItemInput,
  type Defrost,
  type FreezerConfig,
  type FreezerIdGenerator,
  type FreezerItem,
  type TakenPacks,
} from '@salt/domain';
import { defrostDocId } from '@salt/domain/schemas';
import { failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import { get, writable, type Readable } from 'svelte/store';
import { getErrorReporter } from './errorReporter.js';
import {
  kitchenAnchorDate,
  kitchenWeeks,
  kitchenWeeksLoaded,
  reanchorKitchenWeeks,
} from './mealPlanService.js';
import { todayIso } from './today.js';
import { reportIfFailed, reportSubscriptionError } from './errorReporting.js';

// The freezer service (issue #1682, epic #795) — the stores over
// `freezerConfig/current` and `freezerItems` (issue #1684), and the ONE WRITE
// PATH for each.
//
// It is where the two things the domain will not supply are minted: a freezer's
// id (`crypto.randomUUID()`) and the clock. Each write runs the pure domain
// command and, on success, applies it to the store and saves the whole document
// — except taking a pack, which sends the command's delta as an `increment`
// (`takeOneFreezerPack`) so takes on two phones both count.
//
// The subscriptions are NOT started at app boot. The freezer page owns their
// lifecycle (`$effect(() => initFreezerSync())`), so the listeners are open only
// while that page is mounted. A person the `freezer` flag hides the feature from
// has no nav entry to it; typing `#/freezer` does mount the page, and so opens
// the listeners, until the guard sends them home. The data is family-shared, so
// that costs a read and nothing more.

// ─── Reactive store ──────────────────────────────────────────────────────────

/**
 * Three states, because a write needs to tell them apart:
 *
 * - `loading` — no snapshot yet. Nothing may be written: an empty config written
 *   now would replace a real setup the snapshot has not delivered.
 * - `loaded` — `config` is the document, or `null` when nobody has set up a
 *   freezer yet. A write on `null` starts from an empty config.
 * - `failed` — the listener died (a corrupt document, a rules refusal). Also not
 *   writable, for the same reason as `loading`: what is actually stored is
 *   unknown, and writing over it would lose the household's setup.
 */
export type FreezerConfigState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly config: FreezerConfig | null }
  | { readonly status: 'failed' };

const _state = writable<FreezerConfigState>({ status: 'loading' });
export const freezerConfigState: Readable<FreezerConfigState> = _state;

/**
 * The stock, in the same three states and for the same reason: an item write is
 * checked against the items this device holds (a number already in use), so
 * nothing is written before the first snapshot or after the listener has died.
 */
export type FreezerItemsState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly items: readonly FreezerItem[] }
  | { readonly status: 'failed' };

const _items = writable<FreezerItemsState>({ status: 'loading' });
export const freezerItemsState: Readable<FreezerItemsState> = _items;

const ids: FreezerIdGenerator = { newFreezerId: () => crypto.randomUUID() };

// ─── Init / cleanup ──────────────────────────────────────────────────────────

/** Subscribe to the config and the stock, for as long as the caller keeps the unsub. */
export function initFreezerSync(): () => void {
  _state.set({ status: 'loading' });
  _items.set({ status: 'loading' });
  const stopConfig = subscribeFreezerConfig(
    (config) => _state.set({ status: 'loaded', config }),
    (err, rawError) => {
      reportSubscriptionError(getErrorReporter(), err, rawError);
      _state.set({ status: 'failed' });
    },
  );
  const stopItems = subscribeFreezerItems(
    (items) => _items.set({ status: 'loaded', items }),
    (err, rawError) => {
      reportSubscriptionError(getErrorReporter(), err, rawError);
      _items.set({ status: 'failed' });
    },
  );
  return () => {
    stopConfig();
    stopItems();
  };
}

// ─── Writes ──────────────────────────────────────────────────────────────────

type Command = (config: FreezerConfig, now: string) => ReadResult<FreezerConfig, DomainError>;

// The body every write shares. The store is updated BEFORE the save, and the
// caller gets the domain verdict as soon as it is: the save runs on in the
// background, because offline `setDoc` does not settle until the connection
// returns and a caller awaiting it would hang (drafts never cleared, a second tap
// meeting a "duplicate" refusal). A refused save is reported, and the
// subscription is the authority that rolls the store back on its next snapshot.
async function run(command: Command): Promise<ReadResult<FreezerConfig, DomainError>> {
  const state = get(_state);
  if (state.status !== 'loaded') {
    return failure({ kind: 'NetworkError', reason: 'transient' });
  }
  const now = new Date().toISOString();
  const result = command(state.config ?? emptyFreezerConfig(now), now);
  if (result.kind !== 'ok') return result;
  _state.set({ status: 'loaded', config: result.value });
  void saveFreezerConfig(result.value).then((written) =>
    reportIfFailed(getErrorReporter(), written),
  );
  return result;
}

/** Add a freezer by name, with its shelves if given. */
export function addFreezer(
  name: string,
  shelves: readonly string[] = [],
): Promise<ReadResult<FreezerConfig, DomainError>> {
  return run((config, now) => addFreezerCommand(config, { name, shelves, now }, ids));
}

/** Rename a freezer. Its id — what stock will point at — does not change. */
export function renameFreezer(
  id: string,
  name: string,
): Promise<ReadResult<FreezerConfig, DomainError>> {
  return run((config, now) => renameFreezerCommand(config, { id, name, now }));
}

/** Replace a freezer's whole shelf list — adding and removing a shelf are both this. */
export function setFreezerShelves(
  id: string,
  shelves: readonly string[],
): Promise<ReadResult<FreezerConfig, DomainError>> {
  return run((config, now) => setShelves(config, { id, shelves, now }));
}

/** Remove a freezer and its shelves. */
export function removeFreezer(id: string): Promise<ReadResult<FreezerConfig, DomainError>> {
  return run((config, now) => removeFreezerCommand(config, { id, now }));
}

/** Take a place off the remembered supplier list. No item changes. */
export function forgetSupplier(supplier: string): Promise<ReadResult<FreezerConfig, DomainError>> {
  return run((config, now) => forgetSupplierCommand(config, { supplier, now }));
}

// ─── Item writes (issue #1684) ───────────────────────────────────────────────

const NOT_READY: ReadResult<never, DomainError> = failure({
  kind: 'NetworkError',
  reason: 'transient',
});

/** The items, and the config an add or a move is checked against — or null while either is unusable. */
function itemsAndConfig(): { items: readonly FreezerItem[]; config: FreezerConfig } | null {
  const items = get(_items);
  const state = get(_state);
  if (items.status !== 'loaded' || state.status !== 'loaded') return null;
  return {
    items: items.items,
    config: state.config ?? emptyFreezerConfig(new Date().toISOString()),
  };
}

// Same shape as `run` above: the store first, the verdict at once, the save in
// the background — an add at the garage freezer with no signal must not hang.
// `config` is what the item's save leaves the config as: written only when it is
// not the object `ready` held.
function saveItem(
  ready: { items: readonly FreezerItem[]; config: FreezerConfig },
  item: FreezerItem,
  config: FreezerConfig,
): void {
  showItem(ready.items, item);
  void saveFreezerItem(item).then((written) => reportIfFailed(getErrorReporter(), written));
  if (config === ready.config) return;
  _state.set({ status: 'loaded', config });
  void saveFreezerConfig(config).then((written) => reportIfFailed(getErrorReporter(), written));
}

function showItem(items: readonly FreezerItem[], item: FreezerItem): void {
  _items.set({
    status: 'loaded',
    items: [...items.filter((i) => i.number !== item.number), item],
  });
}

// A saved item's supplier goes on the remembered list — the same config back when
// the list already had it, so nothing is written.
function remember(config: FreezerConfig, purchasedFrom: string | null, now: string): FreezerConfig {
  const result = rememberSupplier(config, purchasedFrom, now);
  return result.kind === 'ok' ? result.value : config;
}

/**
 * Put something in the freezer at `input.number`. The number is checked against
 * the items this device holds; an add on another device it has not yet seen is
 * invisible to the check (docs/data-model.md → `freezerItems/{number}`).
 *
 * The add's two config changes — a new supplier, and the number moving the
 * `highestNumber` mark up — are composed onto ONE config value and saved once:
 * two background saves built from the same starting copy would each drop the
 * other's change.
 */
export async function addFreezerItem(
  input: Omit<AddFreezerItemInput, 'now'>,
): Promise<ReadResult<FreezerItem, DomainError>> {
  const ready = itemsAndConfig();
  if (!ready) return NOT_READY;
  const now = new Date().toISOString();
  const result = addFreezerItemCommand(ready.items, ready.config, {
    ...input,
    purchasedFrom: supplierSpelling(ready.config, input.purchasedFrom ?? null),
    now,
  });
  if (result.kind !== 'ok') return result;
  const item = result.value;
  saveItem(
    ready,
    item,
    recordBagNumber(remember(ready.config, item.purchasedFrom, now), item.number, now),
  );
  return result;
}

export interface FreezerItemChanges {
  readonly name: string;
  readonly purchasedFrom: string | null;
  /**
   * Where it should be, or `null` to leave its place alone — which is how an item
   * under Not placed can be renamed without being filed somewhere first.
   */
  readonly place: { readonly freezerId: string; readonly shelf: string | null } | null;
  /**
   * A corrected pack count; omitted keeps the count this device holds at save
   * time. Either way the save is whole-document, so a take from another device
   * that this one has not yet seen is overwritten (LWW).
   */
  readonly amount?: number;
  /** The ingredient and the recipe it links to, `null` for none; omitted leaves them. */
  readonly canonId?: string | null;
  readonly recipeId?: string | null;
}

/**
 * Save the edit sheet: rename, re-source, relink and, if they changed, move and
 * recount — one write.
 */
export async function updateFreezerItem(
  number: number,
  changes: FreezerItemChanges,
): Promise<ReadResult<FreezerItem, DomainError>> {
  const ready = itemsAndConfig();
  if (!ready) return NOT_READY;
  const now = new Date().toISOString();
  const edited = editFreezerItem(ready.items, {
    number,
    name: changes.name,
    purchasedFrom: supplierSpelling(ready.config, changes.purchasedFrom),
    canonId: changes.canonId,
    recipeId: changes.recipeId,
    now,
  });
  if (edited.kind !== 'ok') return edited;
  const place = changes.place;
  const moves =
    place !== null &&
    (place.freezerId !== edited.value.freezerId || place.shelf !== edited.value.shelf);
  const moved = moves
    ? moveFreezerItem([edited.value], ready.config, { number, ...place, now })
    : edited;
  if (moved.kind !== 'ok') return moved;
  const result =
    changes.amount === undefined
      ? moved
      : setFreezerItemAmount([moved.value], { number, amount: changes.amount, now });
  if (result.kind !== 'ok') return result;
  saveItem(ready, result.value, remember(ready.config, result.value.purchasedFrom, now));
  return result;
}

/**
 * Take one pack out. The count drops on this device at once; the decrement is
 * sent in the background and not awaited (offline it settles only on
 * reconnect), and a refusal is reported — an item another device has removed
 * comes back NotFound, which is not. `last` is the page's cue to offer removing
 * the entry. An item already showing none takes nothing and writes nothing.
 */
export async function takeOneFreezerPack(
  number: number,
): Promise<ReadResult<TakenPacks, DomainError>> {
  const items = get(_items);
  if (items.status !== 'loaded') return NOT_READY;
  const result = takeFreezerPacks(items.items, {
    number,
    count: 1,
    now: new Date().toISOString(),
  });
  if (result.kind !== 'ok' || result.value.delta === 0) return result;
  showItem(items.items, result.value.item);
  void takeFreezerItemAmount(number, result.value.delta).then((written) =>
    reportIfFailed(getErrorReporter(), written),
  );
  return result;
}

/**
 * Take an item out of the record. The config's `highestNumber` is left alone, so
 * the next suggestion still counts on past this number.
 */
export async function removeFreezerItem(
  number: number,
): Promise<ReadResult<FreezerItem, DomainError>> {
  const items = get(_items);
  if (items.status !== 'loaded') return NOT_READY;
  const result = removeFreezerItemCommand(items.items, { number });
  if (result.kind !== 'ok') return result;
  _items.set({ status: 'loaded', items: items.items.filter((i) => i.number !== number) });
  void deleteFreezerItem(number).then((written) => reportIfFailed(getErrorReporter(), written));
  return result;
}

// ─── Using packs from the freezer (issue #1685) ─────────────────────────────
//
// `defrosts` — what Kitchen lists under To do until somebody gets it out. Its
// listener, like the two above, is page-owned (`initDefrostSync`): Kitchen opens
// it, and so does the shopping list, whose commit sums onto an existing document
// read from this store. Both open it only for a person the `freezer` flag shows
// the feature to.

/** Same three states as the stock, for the same reason: a commit reads the existing document. */
export type DefrostsState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly defrosts: readonly Defrost[] }
  | { readonly status: 'failed' };

const _defrosts = writable<DefrostsState>({ status: 'loading' });
export const defrostsState: Readable<DefrostsState> = _defrosts;

/** Subscribe to the Kitchen items, for as long as the caller keeps the unsub. */
export function initDefrostSync(): () => void {
  _defrosts.set({ status: 'loading' });
  return subscribeDefrosts(
    (defrosts) => _defrosts.set({ status: 'loaded', defrosts }),
    (err, rawError) => {
      reportSubscriptionError(getErrorReporter(), err, rawError);
      _defrosts.set({ status: 'failed' });
    },
  );
}

/** Where an item is, as its freezer's name and shelf — or null when the setup no longer has its place. */
export function freezerPlace(
  config: FreezerConfig | null,
  item: FreezerItem,
): { readonly freezer: string; readonly shelf: string | null } | null {
  const freezer = config?.freezers.find((f) => f.id === item.freezerId);
  if (!freezer) return null;
  return { freezer: freezer.name, shelf: item.shelf };
}

/** The place as Kitchen stores and shows it: `Garage · shelf B`. */
function locationOf(config: FreezerConfig | null, item: FreezerItem): string {
  const place = freezerPlace(config, item);
  if (place === null) return 'Not placed';
  return place.shelf === null ? place.freezer : `${place.freezer} · shelf ${place.shelf}`;
}

export interface UseFromFreezerInput {
  /** The bag number the packs come out of. */
  readonly number: number;
  /** Whole packs, 1 or more. */
  readonly count: number;
  /** The recipe the row is for — a "make it yourself" row's producer — or null for a hand-added row. */
  readonly recipe: { readonly id: string; readonly title: string | null } | null;
  /** The ONE shopping row this replaces. */
  readonly shoppingRow: { readonly listId: string; readonly itemId: string };
}

export interface UsedFromFreezer {
  readonly defrost: Defrost;
  /** The entry's last packs went: it is removed. */
  readonly last: boolean;
  /**
   * The batch, settling when the server answers (offline, on reconnect). A
   * NotFound here means another phone removed the bag first and NOTHING applied
   * — the row is back and there is no Kitchen item; the page says so.
   */
  readonly written: Promise<ReadResult<void, DomainError>>;
}

/**
 * Use packs from the freezer instead of buying them: the count drops (the entry
 * goes with its last pack), Kitchen gains an item, and the one shopping row goes
 * — one atomic batch (`commitFromFreezer`). The stores change at once; the batch
 * is not awaited, like every freezer write, and a refusal is reported (a
 * NotFound is not).
 *
 * The Kitchen item is dated here, once (#1696): the recipe's next planned night
 * in the Kitchen weeks, which the caller's page must be holding
 * (`subscribeKitchenWeeks`). A recipe row is refused as not ready until those
 * weeks have loaded — a night computed from a half-read planner would be stored
 * undated for good.
 */
export async function useFromFreezer(
  input: UseFromFreezerInput,
): Promise<ReadResult<UsedFromFreezer, DomainError>> {
  const ready = itemsAndConfig();
  const defrosts = get(_defrosts);
  if (!ready || defrosts.status !== 'loaded') return NOT_READY;
  const recipeId = input.recipe?.id ?? null;
  // A hand-added row has no night to look up, so it never waits on the planner.
  if (recipeId !== null && !get(kitchenWeeksLoaded)) return NOT_READY;
  // `kitchenWeeksLoaded` stays true over a stale anchor (a page left open past
  // midnight): re-anchor, and refuse this attempt rather than store a night that
  // has already passed.
  if (recipeId !== null && get(kitchenAnchorDate) !== todayIso()) {
    reanchorKitchenWeeks();
    return NOT_READY;
  }
  const forDate =
    recipeId === null
      ? null
      : nextPlannedNight(get(kitchenWeeks), recipeId, get(kitchenAnchorDate));
  const now = new Date().toISOString();
  const taken = takeFreezerPacks(ready.items, { number: input.number, count: input.count, now });
  if (taken.kind !== 'ok') return taken;
  const item = taken.value.item;
  const id = defrostDocId(input.number, recipeId);
  const existing =
    defrosts.defrosts.find((d) => defrostDocId(d.freezerNumber, d.recipeId) === id) ?? null;
  const committed = commitDefrost(
    existing,
    {
      freezerNumber: input.number,
      name: item.name,
      location: locationOf(ready.config, item),
      recipeId,
      recipeTitle: input.recipe?.title ?? null,
      // Zero for a bag already showing none (two phones took its last pack), which
      // `commitDefrost` refuses: nothing is written.
      amount: -taken.value.delta,
      forDate,
    },
    now,
  );
  if (committed.kind !== 'ok') return committed;
  const defrost = committed.value;
  const last = taken.value.last;

  _items.set({
    status: 'loaded',
    items: last
      ? ready.items.filter((i) => i.number !== input.number)
      : [...ready.items.filter((i) => i.number !== input.number), item],
  });
  showDefrost(defrosts.defrosts, defrost);
  const written = commitFromFreezer({
    itemNumber: input.number,
    take: taken.value.delta,
    removeItem: last,
    defrost,
    shoppingRow: input.shoppingRow,
  }).then((result) => reportIfFailed(getErrorReporter(), result));
  return success({ defrost, last, written });
}

function showDefrost(defrosts: readonly Defrost[], defrost: Defrost): void {
  const id = defrostDocId(defrost.freezerNumber, defrost.recipeId);
  _defrosts.set({
    status: 'loaded',
    defrosts: [
      ...defrosts.filter((d) => defrostDocId(d.freezerNumber, d.recipeId) !== id),
      defrost,
    ],
  });
}

/** Got it out: the Kitchen item goes, for everybody. The freezer count is untouched — it moved at commit. */
export function tickOffDefrost(defrost: Defrost): Promise<ReadResult<void, DomainError>> {
  const id = defrostDocId(defrost.freezerNumber, defrost.recipeId);
  const state = get(_defrosts);
  if (state.status === 'loaded') {
    _defrosts.set({
      status: 'loaded',
      defrosts: state.defrosts.filter((d) => defrostDocId(d.freezerNumber, d.recipeId) !== id),
    });
  }
  return deleteDefrost(id).then((result) => reportIfFailed(getErrorReporter(), result));
}

/** Got it out's Undo: the same document back, whole, at the same id. */
export function undoTickOff(defrost: Defrost): Promise<ReadResult<void, DomainError>> {
  const state = get(_defrosts);
  if (state.status === 'loaded') showDefrost(state.defrosts, defrost);
  return saveDefrost(defrost).then((result) => reportIfFailed(getErrorReporter(), result));
}

/** The Kitchen items as this device holds them — the e2e bridge's read. */
export function getDefrostsSnapshot(): readonly Defrost[] {
  const state = get(_defrosts);
  return state.status === 'loaded' ? state.defrosts : [];
}
