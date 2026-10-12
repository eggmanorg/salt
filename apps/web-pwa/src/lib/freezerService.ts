import { subscribeFreezerConfig, saveFreezerConfig } from '@salt/firebase-sync';
import {
  addFreezer as addFreezerCommand,
  emptyFreezerConfig,
  removeFreezer as removeFreezerCommand,
  renameFreezer as renameFreezerCommand,
  setShelves,
  type FreezerConfig,
  type FreezerIdGenerator,
} from '@salt/domain';
import { failure, type DomainError, type ReadResult } from '@salt/shared-types';
import { get, writable, type Readable } from 'svelte/store';
import { getErrorReporter } from './errorReporter.js';
import { reportIfFailed, reportSubscriptionError } from './errorReporting.js';

// The freezer service (issue #1682, epic #795) — the store over
// `freezerConfig/current` and the ONE WRITE PATH for it.
//
// It is where the two things the domain will not supply are minted: a freezer's
// id (`crypto.randomUUID()`) and the clock. Each write runs the pure domain
// command and, on success, applies it to the store and saves the whole document.
//
// The subscription is NOT started at app boot. The freezer page owns its
// lifecycle (`$effect(() => initFreezerSync())`), so the listener is open only
// while that page is mounted. A person the `freezer` flag hides the feature from
// has no nav entry to it; typing `#/freezer` does mount the page, and so opens
// the listener, until the guard sends them home. The data is family-shared, so
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

const ids: FreezerIdGenerator = { newFreezerId: () => crypto.randomUUID() };

// ─── Init / cleanup ──────────────────────────────────────────────────────────

/** Subscribe to the freezer config, for as long as the caller keeps the unsub. */
export function initFreezerSync(): () => void {
  _state.set({ status: 'loading' });
  return subscribeFreezerConfig(
    (config) => _state.set({ status: 'loaded', config }),
    (err, rawError) => {
      reportSubscriptionError(getErrorReporter(), err, rawError);
      _state.set({ status: 'failed' });
    },
  );
}

// ─── Writes ──────────────────────────────────────────────────────────────────

type Command = (config: FreezerConfig, now: string) => ReadResult<FreezerConfig, DomainError>;

// The body every write shares. The store is updated BEFORE the save and left
// updated if the save is refused: the subscription is the authority and corrects
// it on its next snapshot, while the caller hears the refusal from the result.
async function run(command: Command): Promise<ReadResult<FreezerConfig, DomainError>> {
  const state = get(_state);
  if (state.status !== 'loaded') {
    return failure({ kind: 'NetworkError', reason: 'transient' });
  }
  const now = new Date().toISOString();
  const result = command(state.config ?? emptyFreezerConfig(now), now);
  if (result.kind !== 'ok') return result;
  _state.set({ status: 'loaded', config: result.value });
  const written = reportIfFailed(getErrorReporter(), await saveFreezerConfig(result.value));
  return written.kind === 'err' ? written : result;
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
