import {
  subscribeFreezerConfig,
  saveFreezerConfig,
  subscribeFreezerItems,
  saveFreezerItem,
  deleteFreezerItem,
} from '@salt/firebase-sync';
import {
  addFreezer as addFreezerCommand,
  addFreezerItem as addFreezerItemCommand,
  editFreezerItem,
  emptyFreezerConfig,
  moveFreezerItem,
  removeFreezer as removeFreezerCommand,
  removeFreezerItem as removeFreezerItemCommand,
  renameFreezer as renameFreezerCommand,
  setShelves,
  type AddFreezerItemInput,
  type FreezerConfig,
  type FreezerIdGenerator,
  type FreezerItem,
} from '@salt/domain';
import { failure, type DomainError, type ReadResult } from '@salt/shared-types';
import { get, writable, type Readable } from 'svelte/store';
import { getErrorReporter } from './errorReporter.js';
import { reportIfFailed, reportSubscriptionError } from './errorReporting.js';

// The freezer service (issue #1682, epic #795) — the stores over
// `freezerConfig/current` and `freezerItems` (issue #1684), and the ONE WRITE
// PATH for each.
//
// It is where the two things the domain will not supply are minted: a freezer's
// id (`crypto.randomUUID()`) and the clock. Each write runs the pure domain
// command and, on success, applies it to the store and saves the whole document.
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
function saveItem(items: readonly FreezerItem[], item: FreezerItem): void {
  _items.set({
    status: 'loaded',
    items: [...items.filter((i) => i.number !== item.number), item],
  });
  void saveFreezerItem(item).then((written) => reportIfFailed(getErrorReporter(), written));
}

/**
 * Put something in the freezer at `input.number`. The number is checked against
 * the items this device holds; an add on another device it has not yet seen is
 * invisible to the check (docs/data-model.md → `freezerItems/{number}`).
 */
export async function addFreezerItem(
  input: Omit<AddFreezerItemInput, 'now'>,
): Promise<ReadResult<FreezerItem, DomainError>> {
  const ready = itemsAndConfig();
  if (!ready) return NOT_READY;
  const result = addFreezerItemCommand(ready.items, ready.config, {
    ...input,
    now: new Date().toISOString(),
  });
  if (result.kind !== 'ok') return result;
  saveItem(ready.items, result.value);
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
}

/** Save the edit sheet: rename, re-source and, if the place changed, move — one write. */
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
    purchasedFrom: changes.purchasedFrom,
    now,
  });
  if (edited.kind !== 'ok') return edited;
  const place = changes.place;
  const moves =
    place !== null &&
    (place.freezerId !== edited.value.freezerId || place.shelf !== edited.value.shelf);
  const result = moves
    ? moveFreezerItem([edited.value], ready.config, { number, ...place, now })
    : edited;
  if (result.kind !== 'ok') return result;
  saveItem(ready.items, result.value);
  return result;
}

/** Take an item out of the record. Its number is free again. */
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
