import {
  subscribeCanonItems,
  upsertCanonItem,
  deleteCanonItem as deleteCanonItemDoc,
  subscribeAisles,
  loadCanonPurchaseCounts,
  callMatchOrCreate,
  callRegenerateCanonIcon,
} from '@salt/firebase-sync';
import {
  createObservabilityErrorReportingAdapter,
  createObservabilityMatchLoggingAdapter,
  startSpan,
} from '@salt/observability';
import {
  approveCanonItem,
  appendCanonSynonym,
  createCanonItem,
  findClosestMatch,
  MatchLogBuilder,
  normaliseName,
  renameCanonItem,
  resolveProductForm,
  setCanonItemAisle,
  setCanonItemSynonyms,
  setCanonItemShoppingBehavior,
  setCanonItemThreshold,
  setCanonItemUnit,
  setCanonItemGramsPerItem,
  setCanonItemThumbnail,
  CANON_ICON_HIDDEN,
} from '@salt/domain';
import { getProductFormsSnapshot } from './productFormService.js';
import type {
  Aisle,
  ApproveCanonItemOverrides,
  CanonItem,
  CanonItemUnit,
  CanonLocalStorePort,
  AisleLocalStorePort,
  MatchOrCreateResult,
  ShoppingBehavior,
} from '@salt/domain';
import {
  ErrorCode,
  failure,
  success,
  type DomainError,
  type ReadResult,
  type Result,
} from '@salt/shared-types';
import { writable, get } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { reportIfFailed, reportSubscriptionError, reportWriteError } from './errorReporting.js';

export type { MatchOrCreateResult };

// ─── Reactive stores ────────────────────────────────────────────────────────────

const _canonItems = writable<readonly CanonItem[]>([]);
export const canonItems: Readable<readonly CanonItem[]> = _canonItems;

const _aisles = writable<readonly Aisle[]>([]);
export const aisles: Readable<readonly Aisle[]> = _aisles;

const _aisleUsage = writable<Map<string, number>>(new Map());
export const aisleUsage: Readable<Map<string, number>> = _aisleUsage;

const _isLoadingAisles = writable(false);
export const isLoadingAisles: Readable<boolean> = _isLoadingAisles;

// How many times the household has ticked each canon item off (issue #726).
// Read ONCE at startup rather than subscribed: it only reorders the add field's
// suggestions, so a live listener on a document written by every shop would be
// paying realtime cost for an ordering hint. This session's own ticks are
// applied optimistically by bumpPurchaseCounts, so the field reorders as you
// shop without waiting for a reload.
const _purchaseCounts = writable<Readonly<Record<string, number>>>({});
export const purchaseCounts: Readable<Readonly<Record<string, number>>> = _purchaseCounts;

// ─── Error reporting ────────────────────────────────────────────────────────────

let _errorReporter: ReturnType<typeof createObservabilityErrorReportingAdapter> | null = null;
function getErrorReporter() {
  if (!_errorReporter) _errorReporter = createObservabilityErrorReportingAdapter();
  return _errorReporter;
}

// ─── Internal loading state ─────────────────────────────────────────────────────

let _receivedItems = false;
let _receivedAisles = false;

function markLoaded(scope: 'items' | 'aisles'): void {
  if (scope === 'items') _receivedItems = true;
  if (scope === 'aisles') _receivedAisles = true;
  if (_receivedItems && _receivedAisles) _isLoadingAisles.set(false);
}

// ─── Aisle usage ─────────────────────────────────────────────────────────────────

function recomputeAisleUsage(): void {
  const items = get(_canonItems);
  const currentAisles = get(_aisles);
  const usage = new Map<string, number>(currentAisles.map((a) => [a.id, 0]));
  for (const item of items) {
    if (item.aisleId !== null && usage.has(item.aisleId)) {
      usage.set(item.aisleId, (usage.get(item.aisleId) ?? 0) + 1);
    }
  }
  _aisleUsage.set(usage);
}

// ─── In-memory store adapters ───────────────────────────────────────────────────
// Used by aisleService for delete/merge flows that still run in the client.
// The canon match/create path runs in the CF and no longer touches these.

export function memAisleStore(seed: readonly Aisle[]) {
  let written: readonly Aisle[] | null = null;
  const store: AisleLocalStorePort = {
    async load() {
      return { kind: 'ok', value: written ?? seed };
    },
    async save(aisles) {
      written = aisles;
      return { kind: 'ok', value: undefined };
    },
  };
  return { store, getWritten: () => written };
}

export function memCanonStore(seed: readonly CanonItem[]) {
  const items = new Map(seed.map((i) => [i.id, i]));
  const upserted: CanonItem[] = [];
  const store: CanonLocalStorePort = {
    async upsert(item) {
      items.set(item.id, item);
      upserted.push(item);
      return { kind: 'ok', value: item };
    },
    async load(id) {
      return { kind: 'ok', value: items.get(id) ?? null };
    },
    async list() {
      return { kind: 'ok', value: [...items.values()] };
    },
    async delete(id) {
      items.delete(id);
      return { kind: 'ok', value: undefined };
    },
  };
  return { store, getUpserted: () => [...upserted] };
}

// ─── Snapshots (used by aisleService) ───────────────────────────────────────────

export function getAislesSnapshot(): readonly Aisle[] {
  return get(_aisles);
}

export function getCanonItemsSnapshot(): readonly CanonItem[] {
  return get(_canonItems);
}

// ─── Purchase counts ────────────────────────────────────────────────────────────

/**
 * Apply a tick-off gesture to the in-memory counts, mirroring the `increment`
 * transforms the adapter just queued. Called at write time, not on
 * confirmation: the transform lands eventually even from a supermarket with no
 * signal, and the shopper should see the field reorder now.
 *
 * Ids repeat when two rows resolved to the same canon item — the same genuine
 * double purchase the stored count records.
 */
export function bumpPurchaseCounts(canonIds: readonly string[]): void {
  if (canonIds.length === 0) return;
  _purchaseCounts.update((current) => {
    const next = { ...current };
    for (const id of canonIds) next[id] = (next[id] ?? 0) + 1;
    return next;
  });
}

// ─── Init / cleanup ─────────────────────────────────────────────────────────────

export function initCanonSync(): () => void {
  _isLoadingAisles.set(true);
  _receivedItems = false;
  _receivedAisles = false;

  const errors = getErrorReporter();

  const unsubItems = subscribeCanonItems(
    (items) => {
      _canonItems.set(items);
      recomputeAisleUsage();
      markLoaded('items');
    },
    (err, rawError) => reportSubscriptionError(errors, err, rawError),
  );

  const unsubAisles = subscribeAisles(
    (newAisles) => {
      _aisles.set([...newAisles].sort((a, b) => a.order - b.order));
      recomputeAisleUsage();
      markLoaded('aisles');
    },
    (err, rawError) => reportSubscriptionError(errors, err, rawError),
  );

  // One-shot, and deliberately NOT part of markLoaded: purchase counts only
  // reorder suggestions, so a slow or failed read costs alphabetical ordering,
  // never a spinner. isLoadingAisles stays pinned to items + aisles (§7.3).
  void loadCanonPurchaseCounts().then((result) => {
    if (result.kind === 'ok') _purchaseCounts.set(result.value.counts);
    else reportWriteError(errors, result.error);
  });

  return () => {
    unsubItems();
    unsubAisles();
  };
}

// ─── Canon item commands ─────────────────────────────────────────────────────────

export async function addCanonItem(
  rawName: string,
  selectedAisleId?: string | null,
  forceCreate?: boolean,
): Promise<Result<MatchOrCreateResult, DomainError>> {
  const span = startSpan(`canon.add: ${rawName}`);
  try {
    // Fast-path: stages 1–4 against the in-memory canon. Only a clear 'match'
    // short-circuits — 'ambiguous' and 'none' must escalate to the CF, which
    // owns AI arbitration. forceCreate also bypasses (CF runs aisle arbitration).
    if (!forceCreate) {
      const localItems = get(_canonItems);
      const normalised = normaliseName(rawName);
      const logBuilder = new MatchLogBuilder();
      logBuilder.start(rawName, normalised);
      logBuilder.setInputItemCount(localItems.length);
      const local = findClosestMatch(localItems, rawName, logBuilder);
      if (local.kind === 'match') {
        // The fast path has no product-form step of its own — it answers from the
        // canon list alone — so without this guard it is the one route that can
        // still write a derivation into the identity field: type "lime zest" and
        // a stage-3 synonym hit binds it to Lime, losing the yield. The snapshot
        // is whatever the subscription currently holds; empty (not yet synced)
        // means "no opinion" and the append proceeds as before.
        const updated = appendCanonSynonym(local.candidate.item, rawName, {
          // `localItems` is the canon snapshot this fast path just matched
          // against, so the contested-phrase rule (issue #1180) sees exactly the
          // canon the match saw. Empty (not yet synced) leaves that rule inert —
          // the same "no opinion" degrade the note above describes.
          isDerivedName: (name) =>
            resolveProductForm(name, getProductFormsSnapshot(), localItems) !== null,
        });
        if (updated !== local.candidate.item) {
          const written = await commitCanonItemUpdate(updated);
          if (written.kind === 'err') return written;
        }
        span.setAttribute('canon.outcome', 'matched');
        span.setAttribute('canon.path', 'fast');
        span.setAttribute('canon.result', updated.name);
        const entry = logBuilder.complete(crypto.randomUUID(), 'matched', updated.id, updated.name);
        void createObservabilityMatchLoggingAdapter('fast', span)
          .write(entry)
          .catch(() => {});
        return success({ decision: 'matched' as const, item: updated });
      }
    }
    // No browser→CF trace headers are sent. Server-side trace unification reads
    // the inbound W3C trace context off the request at the callable entrypoint
    // (see apps/cloud-functions/src/index.ts); browser→CF trace minting stays
    // deferred.
    const result = await callMatchOrCreate({
      rawName,
      selectedAisleId,
      ...(forceCreate !== undefined && { forceCreate }),
    });
    if (result.kind === 'ok') {
      span.setAttribute('canon.outcome', result.value.decision);
      span.setAttribute('canon.path', 'cf');
      span.setAttribute('canon.result', result.value.item.name);
    } else {
      span.setAttribute('canon.error', result.error.kind);
      // AI-callable (matchOrCreateCanon) failure: report the unexpected
      // (StorageError/SyncError/Auth/unknown); the gate drops NetworkError etc.
      reportWriteError(getErrorReporter(), result.error);
    }
    return result;
  } finally {
    span.end();
  }
}

// The write half of every canon edit (#931). It hands back the persistence
// outcome instead of discarding it, so a command that produced a perfectly valid
// item still answers `err` when the document never landed — and the §7.6 gate
// sees the failure once, here, rather than at each of the eight call sites.
async function commitCanonItemUpdate(item: CanonItem): Promise<ReadResult<void, DomainError>> {
  return reportIfFailed(getErrorReporter(), await upsertCanonItem(item));
}

export async function updateCanonItemName(
  item: CanonItem,
  newName: string,
): Promise<Result<CanonItem, DomainError>> {
  const result = renameCanonItem(item, newName);
  if (result.kind !== 'ok') return result;
  const written = await commitCanonItemUpdate(result.value);
  return written.kind === 'err' ? written : result;
}

export async function updateCanonItemAisle(
  item: CanonItem,
  aisleId: string | null,
): Promise<Result<CanonItem, DomainError>> {
  const result = setCanonItemAisle(item, aisleId);
  if (result.kind !== 'ok') return result;
  const written = await commitCanonItemUpdate(result.value);
  return written.kind === 'err' ? written : result;
}

export async function updateCanonItemSynonyms(
  item: CanonItem,
  synonyms: readonly string[],
): Promise<Result<CanonItem, DomainError>> {
  const result = setCanonItemSynonyms(item, synonyms);
  if (result.kind !== 'ok') return result;
  const written = await commitCanonItemUpdate(result.value);
  return written.kind === 'err' ? written : result;
}

export async function updateCanonItemShoppingBehavior(
  item: CanonItem,
  shoppingBehavior: ShoppingBehavior,
): Promise<Result<CanonItem, DomainError>> {
  const result = setCanonItemShoppingBehavior(item, shoppingBehavior);
  if (result.kind !== 'ok') return result;
  const written = await commitCanonItemUpdate(result.value);
  return written.kind === 'err' ? written : result;
}

export async function updateCanonItemThreshold(
  item: CanonItem,
  largeQuantityThreshold: number | undefined,
): Promise<Result<CanonItem, DomainError>> {
  const result = setCanonItemThreshold(item, largeQuantityThreshold);
  if (result.kind !== 'ok') return result;
  const written = await commitCanonItemUpdate(result.value);
  return written.kind === 'err' ? written : result;
}

// The unit the item is bought in (issue #1651). `undefined` clears it.
export async function updateCanonItemUnit(
  item: CanonItem,
  unit: CanonItemUnit | undefined,
): Promise<Result<CanonItem, DomainError>> {
  const result = setCanonItemUnit(item, unit);
  if (result.kind !== 'ok') return result;
  const written = await commitCanonItemUpdate(result.value);
  return written.kind === 'err' ? written : result;
}

// The weight of one item (issue #1643). `undefined` clears it.
export async function updateCanonItemGramsPerItem(
  item: CanonItem,
  gramsPerItem: number | undefined,
): Promise<Result<CanonItem, DomainError>> {
  const result = setCanonItemGramsPerItem(item, gramsPerItem);
  if (result.kind !== 'ok') return result;
  const written = await commitCanonItemUpdate(result.value);
  return written.kind === 'err' ? written : result;
}

export async function approveCanonItemWithOverrides(
  item: CanonItem,
  overrides?: ApproveCanonItemOverrides,
): Promise<Result<CanonItem, DomainError>> {
  const result = approveCanonItem(item, overrides);
  if (result.kind !== 'ok') return result;
  const written = await commitCanonItemUpdate(result.value);
  return written.kind === 'err' ? written : result;
}

// Bulk approve. A missing item and a command that refuses are both no-ops, as
// they always were — what is new is that a REFUSED WRITE is answered for: every
// id is still attempted, and the first document that failed to land is what the
// caller hears about (#931).
export async function approveCanonItems(ids: string[]): Promise<ReadResult<void, DomainError>> {
  const items = get(_canonItems);
  const written = await Promise.all(
    ids.map((id): Promise<ReadResult<void, DomainError>> => {
      const item = items.find((i) => i.id === id);
      if (!item) return Promise.resolve(success(undefined));
      const result = approveCanonItem(item);
      if (result.kind === 'ok') return commitCanonItemUpdate(result.value);
      return Promise.resolve(success(undefined));
    }),
  );
  return written.find((w) => w.kind === 'err') ?? success(undefined);
}

export async function splitMostRecentSynonym(
  item: CanonItem,
): Promise<Result<CanonItem, DomainError>> {
  if (item.synonyms.length === 0) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_CANON_NAME });
  }
  const synonym = item.synonyms[item.synonyms.length - 1]!;
  const created = createCanonItem(
    // rawInput is the promoted synonym. Identical to the name today, so the
    // omission rule drops it — kept because it is self-documenting and stays
    // correct if split ever mints a differently-named item.
    { name: synonym, needs_approval: true, rawInput: synonym },
    { newCanonId: () => crypto.randomUUID(), newAisleId: () => crypto.randomUUID() },
  );
  if (created.kind !== 'ok') return created;
  // Route the trimmed item through the command, not a hand-spread: it also
  // drops the now-stale `synonym_added` record for the synonym we just promoted
  // away (issue #193).
  const trimmedResult = setCanonItemSynonyms(item, item.synonyms.slice(0, -1));
  if (trimmedResult.kind !== 'ok') return trimmedResult;
  const trimmed = trimmedResult.value;
  // The promoted item first: if the second write is refused the synonym is
  // duplicated rather than lost, which is the recoverable half of the split.
  const wroteCreated = await commitCanonItemUpdate(created.value);
  if (wroteCreated.kind === 'err') return wroteCreated;
  const wroteTrimmed = await commitCanonItemUpdate(trimmed);
  if (wroteTrimmed.kind === 'err') return wroteTrimmed;
  return created;
}

export async function deleteCanonItem(id: string): Promise<Result<void, DomainError>> {
  return reportIfFailed(getErrorReporter(), await deleteCanonItemDoc(id));
}

// ─── Icon (Tier-1 pictogram) escape hatch (issue #148) ───────────────────────────

/**
 * Regenerate a canon item's icon: clears `thumbnail` server-side (auth'd
 * callable), re-firing the trigger so the icon branch regenerates. An optional
 * `hint` is a one-shot additive steer for the next generation.
 */
export async function regenerateCanonIcon(
  id: string,
  hint?: string,
): Promise<Result<void, DomainError>> {
  return reportIfFailed(getErrorReporter(), await callRegenerateCanonIcon(id, hint));
}

/** Hide a canon item's icon: sets `thumbnail` to the "hidden" sentinel so the
 *  trigger never regenerates it and the UI shows the bare tile. */
export async function hideCanonIcon(item: CanonItem): Promise<Result<CanonItem, DomainError>> {
  const result = setCanonItemThumbnail(item, CANON_ICON_HIDDEN);
  if (result.kind === 'ok') await commitCanonItemUpdate(result.value);
  return result;
}

/** Un-hide a canon item's icon: clears the "hidden" sentinel (→ null) via the
 *  regenerate callable, which re-triggers generation. */
export async function unhideCanonIcon(id: string): Promise<Result<void, DomainError>> {
  return reportIfFailed(getErrorReporter(), await callRegenerateCanonIcon(id));
}

// ─── Test helpers ────────────────────────────────────────────────────────────────

export function __resetCanonServiceForTest(): void {
  _canonItems.set([]);
  _aisles.set([]);
  _aisleUsage.set(new Map());
  _purchaseCounts.set({});
  _isLoadingAisles.set(false);
  _receivedItems = false;
  _receivedAisles = false;
  _errorReporter = null;
}
