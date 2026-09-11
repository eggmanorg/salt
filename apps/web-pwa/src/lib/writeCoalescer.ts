import type { DomainError, ReadResult } from '@salt/shared-types';

// ─── Write coalescing (issue #940, promoted by #1319) ─────────────────────────
//
// A debounced, document-keyed writer. It was written for the meal planner, where
// a note typed a character at a time used to issue a full-document `setDoc` of
// the whole seven-day week per keystroke — nineteen writes for "Spaghetti
// bolognese", each fanned out to every family device's realtime listener. The
// recipe page's in-place editing (issue #1319) has exactly that shape, so this
// module is the ONE implementation both services call rather than a second copy.
//
// What a caller must keep on its own side of the boundary:
//
// The OPTIMISTIC STORE APPLY stays synchronous and only the `setDoc` is deferred.
// Both services rebuild the whole document from their store on every mutation, so
// a deferred apply would let two edits to different fields both build on the same
// stale document and the second silently discard the first.
//
// What this does and does not guarantee:
//  - Edits made inside one window are NOT lost: each apply rebuilds from the
//    store, so the last pending document contains all of them.
//  - Pending writes live in memory only; persisting them would need browser
//    storage, which CLAUDE.md Rule 3 forbids. The flush points are therefore what
//    bound the loss: blur, teardown, and `pagehide`/tab-hide. A reload or a
//    closed tab is ordinary and is covered; a tab the OS kills between the
//    `pagehide` flush and the SDK persisting the mutation is not, and nothing
//    in-memory can cover it.
//  - A dropped connection loses nothing extra: the flush still calls `setDoc`,
//    and Firestore's `persistentLocalCache` queues it like any other write.
//  - Two devices editing the SAME document inside the same window still resolve
//    by document-level LWW — whichever flush reaches the server last replaces
//    the whole document, including fields the other device changed. That is the
//    pre-existing contract (see docs/data-model.md), but coalescing WIDENS the
//    window in which it can bite, from "the round trip" to "the round trip plus
//    up to WRITE_DEBOUNCE_MS".
export const WRITE_DEBOUNCE_MS = 400;

type WriteResult = ReadResult<void, DomainError>;

interface PendingWrite<T> {
  // The newest whole document to write. REPLACED on each edit, never merged:
  // the write shape stays a full-document LWW `setDoc`, only its timing moves.
  //
  // Held here rather than re-read from the caller's store at flush time, because
  // the store is not the whole story — `addRecipeToDay` persists a week it read
  // one-shot and deliberately did NOT put in `_weeks` (see `weekIsKnown`), so a
  // store-reading flush would have nothing to write for it.
  doc: T;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<WriteResult>;
  settle: (result: WriteResult) => void;
}

export interface WriteCoalescer<T> {
  /** Queue `doc` for `key`, replacing anything already pending for that key. */
  queue(key: string, doc: T): Promise<WriteResult>;
  /** Write this key's pending document now. No-op when nothing is pending. */
  flush(key: string): Promise<void>;
  /** Write every pending document now. */
  flushAll(): Promise<void>;
  /**
   * Drop a pending write for `key` WITHOUT ever issuing it, settling its
   * promise with `result` instead of a real write outcome — UNLESS the pending
   * entry carries an edit newer than `supersededBy`, the document the caller's
   * own immediate write actually sent, in which case this is a no-op and the
   * pending entry is left to flush on its own.
   *
   * For a caller whose own IMMEDIATE write to the same key already carries
   * every edit the pending one would have (issue #1324 review, finding 2): the
   * pending entry holds a whole-document snapshot captured at queue time and
   * does not re-read anything at flush time, so left alone it fires LATER and
   * overwrites the immediate write with that stale snapshot — silently, since
   * the flushed write's `updatedAt` then loses to the immediate write's newer
   * one at the echo guard in `recipeService.ts`'s `applySnapshot`, and the
   * device that made the immediate write never sees the revert. Cancelling the
   * pending entry once the immediate write it would otherwise clobber has
   * landed removes the write that could do that, rather than requiring every
   * such caller to get an ordering (flush-then-write) right on its own.
   *
   * The guard (issue #1324 review, ROUND 2): `persistRecipe` stamps and applies
   * its document BEFORE awaiting the immediate write, so the gap between
   * "composed" and "this call" is a full network round trip — unbounded
   * offline. An edit CAN be queued inside that gap, opening a pending entry
   * newer than the immediate write the caller is here to cancel against.
   * Cancelling unconditionally would delete that entry — and the characters it
   * holds — having issued no write for them at all: the original defect
   * (a stale write clobbering a fresh one) with the arrow reversed (a fresh
   * write dropped in favour of a stale one that never landed). So `cancel` only
   * drops an entry that is NOT newer than `supersededBy` (`pending.doc.updatedAt
   * <= supersededBy.updatedAt`); a genuinely newer entry is left queued to
   * flush on its own timer, which is exactly what would have happened had this
   * `cancel` call never been made. The comparison is duck-typed on an
   * `updatedAt: string` field rather than a generic constraint on `T`, because
   * not every `T` a coalescer is created for carries one (`MealPlanTemplate`
   * does not) — a `T` with no comparable timestamp falls back to the
   * unconditional drop above, which is the ONLY behaviour it ever had, since
   * nothing but `recipeService` calls `cancel` today. Guarding lives HERE,
   * inside the coalescer, rather than at the `persistRecipe` call site, so a
   * future caller of `cancel` cannot forget to make this comparison itself.
   *
   * THE BOUNDARY (issue #1330 — stated so this is not read as an unqualified
   * guarantee, per CLAUDE.md Rule 12): the comparison trusts `supersededBy
   * .updatedAt` to be the moment the caller's OWN write actually went out.
   * That holds for a caller that stamps `updatedAt` immediately before the
   * write it will later pass here — `persistRecipe` does, so the guard is
   * sound for it. It does NOT hold for a caller that stamps `updatedAt`
   * EARLIER than the write itself (e.g. at the start of a round trip rather
   * than just before sending): such a caller's `supersededBy` can be older
   * than a pending entry even though its own write is the one landing later,
   * so the comparison cannot tell that case apart from a pending entry that
   * is genuinely newer, and this guard protects neither ordering for it.
   * `recipeAmend.ts`'s `applyRecipeAmendment` used to stamp this way
   * (`updatedAt` set when the AI call starts, never re-stamped before its own
   * direct `saveRecipeDoc`); #1330 changed it to flush first and stamp at write
   * time through `applyRecipeOptimistically`, so it is no longer an example of
   * this. It still does not call `cancel`, deliberately — after its flush the
   * only entries that can be pending are ones queued DURING that flush: either
   * during its own round trip (a keystroke landing while the amendment's write
   * is out) or during the flush's own await (`flushKey` deletes a key's entry
   * before awaiting its write, so a keystroke arriving in that gap opens a
   * fresh one before the flush call even returns) — the wider of the two
   * windows, and either way something must be left to flush on its own. No
   * caller of `cancel` stamps early today; this paragraph states the boundary
   * for the next one that might.
   *
   * A no-op when nothing is pending for `key`.
   */
  cancel(key: string, result: WriteResult, supersededBy: T): void;
  /** Drop pending writes without issuing them — test teardown only. */
  discardAll(): void;
}

// Every coalescer ever created, so the unload handlers below flush all of them.
// A `Set` of live objects and nothing else: coalescers are module-level
// singletons that live as long as the document, so there is nothing to evict.
const coalescers = new Set<WriteCoalescer<never>>();

// Duck-typed rather than a generic constraint on `T`: `cancel`'s guard needs a
// comparable timestamp, but not every `T` a coalescer is created for has one
// (`MealPlanTemplate` is a singleton document with no `updatedAt`). A `T`
// without one simply never compares as newer, below.
function hasUpdatedAt(doc: unknown): doc is { updatedAt: string } {
  return (
    typeof doc === 'object' &&
    doc !== null &&
    typeof (doc as { updatedAt?: unknown }).updatedAt === 'string'
  );
}

// Whether `pending` was queued after `supersededBy` was composed — the guard
// `cancel` uses to tell an edit its caller's immediate write already carries
// from one it does not (issue #1324 review, round 2). `false` whenever either
// side has no comparable `updatedAt`, which preserves `cancel`'s original
// unconditional behaviour for any `T` that carries none.
function isNewerThan<T>(pending: T, supersededBy: T): boolean {
  return (
    hasUpdatedAt(pending) &&
    hasUpdatedAt(supersededBy) &&
    pending.updatedAt > supersededBy.updatedAt
  );
}

/**
 * A debounced, document-keyed writer. One key, one in-flight document: every
 * field edited inside the window coalesces into a single write, which is exactly
 * the granularity LWW already works at.
 *
 * `queue` returns the promise of the write that will carry the edit, so callers
 * keep the `ReadResult` they need for their failure toast (CLAUDE.md Rule 10).
 * Sharing that promise makes "at most one toast per burst" POSSIBLE — every edit
 * inside one window resolves the exact same promise, so a caller CAN reduce a
 * burst to one message by comparing each result against the last promise it
 * already toasted (the recipe page's `lastFailureToasted` does this; see
 * `RecipeViewPage.reviewFlag.test.ts`). The module does not guarantee this on
 * its own: the shared promise is the burst's identity, not its message count, so
 * a caller with no such comparison still raises one toast per failed edit — the
 * meal planner has none today and does exactly that (pre-existing, out of
 * scope here; CLAUDE.md Rule 12 is why this sentence names the boundary rather
 * than the caller-specific case).
 *
 * `onWritten` fires once per successful coalesced burst — the hook the planner's
 * `plan.edited` usage event rides on (issues #684, #940). It is deliberately not
 * folded into `write`: the event is about the burst, not about the write.
 */
export function createWriteCoalescer<T>(
  write: (doc: T) => Promise<WriteResult>,
  options: { onWritten?: (doc: T) => void } = {},
): WriteCoalescer<T> {
  const pending = new Map<string, PendingWrite<T>>();

  async function flushKey(key: string): Promise<void> {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    // Delete BEFORE awaiting: an edit arriving while this write is in flight
    // must open a fresh pending entry rather than join one already committed to
    // the wire, which would drop it.
    pending.delete(key);
    const result = await write(entry.doc);
    if (result.kind === 'ok') options.onWritten?.(entry.doc);
    entry.settle(result);
  }

  const api: WriteCoalescer<T> = {
    queue(key: string, doc: T): Promise<WriteResult> {
      const existing = pending.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        existing.doc = doc;
        existing.timer = setTimeout(() => void flushKey(key), WRITE_DEBOUNCE_MS);
        return existing.promise;
      }
      let settle!: (result: WriteResult) => void;
      const promise = new Promise<WriteResult>((resolve) => {
        settle = resolve;
      });
      pending.set(key, {
        doc,
        timer: setTimeout(() => void flushKey(key), WRITE_DEBOUNCE_MS),
        promise,
        settle,
      });
      return promise;
    },
    flush(key: string): Promise<void> {
      return flushKey(key);
    },
    flushAll(): Promise<void> {
      return Promise.all([...pending.keys()].map(flushKey)).then(() => undefined);
    },
    cancel(key: string, result: WriteResult, supersededBy: T): void {
      const entry = pending.get(key);
      if (!entry) return;
      if (isNewerThan(entry.doc, supersededBy)) {
        // The pending edit was queued AFTER the document the immediate write
        // actually sent (issue #1324 review, round 2) — dropping it here would
        // lose characters no write has ever carried. Leave it queued; it
        // fires on its own timer exactly as it would have without this call.
        return;
      }
      clearTimeout(entry.timer);
      pending.delete(key);
      entry.settle(result);
    },
    /**
     * Drop pending writes without issuing them — test teardown only.
     * A discarded entry's promise never settles; nothing awaits one, and it is
     * collected with the test that made it.
     */
    discardAll(): void {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    },
  };

  coalescers.add(api as unknown as WriteCoalescer<never>);
  return api;
}

/** Write out every pending document of every coalescer. */
export function flushAllCoalescedWrites(): Promise<void> {
  return Promise.all([...coalescers].map((c) => c.flushAll())).then(() => undefined);
}

// A reload or a closed tab is ORDINARY, not a crash, and it must not cost the
// user the sentence they just typed. `pagehide` is the event that fires for all
// of them (reload, navigation, tab close, and iOS Safari's bfcache freeze, where
// `beforeunload` does not); `visibilitychange` covers a backgrounded phone,
// which on mobile is where a tab most often dies without ever firing `pagehide`.
//
// Registered once, HERE, rather than once per service: the two handlers would be
// identical, and one registration cannot drift from another that does not exist.
// A flush with nothing pending is a no-op, so this costs nothing on a page that
// never edited anything.
//
// The honest limit: this hands the write to the Firestore SDK, which enqueues it
// in `persistentLocalCache` and replays it on the next load. It does NOT wait for
// the server, and nothing here can — an unload handler cannot hold the page open.
// A tab killed by the OS between the enqueue and the SDK's own persistence still
// loses the edit. That window is far smaller than the debounce it replaces, but
// it is not zero, and no in-memory design can make it zero (Rule 3 forbids the
// storage that could).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushAllCoalescedWrites());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushAllCoalescedWrites();
  });
}
