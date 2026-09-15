import { subscribeLibraryPages, saveLibraryPage, deleteLibraryPage } from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter } from '@salt/observability';
import {
  LIBRARY_PAGE_BODY_MAX,
  LIBRARY_PAGE_REVISION_CAP,
  pushRevision,
  type LibraryPageDoc,
  type LibraryPageRevisionDoc,
} from '@salt/domain/schemas';
import { ErrorCode, failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import { appendedBody } from './libraryImport.js';
import { writable, get } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { reportIfFailed, reportSubscriptionError } from './errorReporting.js';
import { currentMember } from './membersService.js';
import { createWriteCoalescer } from './writeCoalescer.js';

// The library service (epic #1372, Phase 1) — the store over `libraryPages` and the
// ONE WRITE PATH for it.
//
// It is also where the two things the adapter cannot supply are minted: a page's id
// (`crypto.randomUUID()`, as batchService and kitchenMemoryService mint theirs) and
// the clock. Nothing below this line reads a clock and nothing above it invents an
// id.
//
// The subscription is NOT started at app boot. The pages that show the library own
// its lifecycle (`$effect(() => initLibrarySync())`), which is the house pattern —
// see BatchListPage. Nothing else in the app reads these documents, so paying for a
// collection listener on every session to serve one screen would be the wrong
// default.
//
// NO AI ANYWHERE in Phase 1. Writing a page is a `setDoc`; there is no flow and no
// callable, which is what lets an edit land instantly and offline.

// ─── Reactive stores ─────────────────────────────────────────────────────────

// `undefined` is the NOT-LOADED state; an empty array is loaded-and-empty, which is
// a different sentence and gets the empty state rather than the spinner.
const _pages = writable<readonly LibraryPageDoc[] | undefined>(undefined);
export const libraryPages: Readable<readonly LibraryPageDoc[] | undefined> = _pages;

// ─── Error reporting ─────────────────────────────────────────────────────────

let _errorReporter: ReturnType<typeof createObservabilityErrorReportingAdapter> | null = null;
function getErrorReporter() {
  if (!_errorReporter) _errorReporter = createObservabilityErrorReportingAdapter();
  return _errorReporter;
}

// ─── Init / cleanup ──────────────────────────────────────────────────────────

/** Subscribe to every library page, for as long as the caller keeps the unsub. */
export function initLibrarySync(): () => void {
  return subscribeLibraryPages(
    (incoming) => _pages.set(incoming),
    (err, rawError) => {
      // A stream-level error leaves the list empty rather than absent, so the page
      // settles on its empty state instead of hanging on a loader forever.
      reportSubscriptionError(getErrorReporter(), err, rawError);
      _pages.set([]);
    },
  );
}

// ─── Writes ──────────────────────────────────────────────────────────────────

// Same debounce the recipe page's in-place editing uses, and for the same reason:
// a body typed a character at a time would otherwise issue one full-document
// `setDoc` per keystroke, each fanned out to every family device's listener.
//
// The optimistic store apply stays SYNCHRONOUS and only the `setDoc` is deferred —
// every mutation below rebuilds the whole document from the store, so a deferred
// apply would let two edits build on the same stale page and the second silently
// discard the first.
const pageWrites = createWriteCoalescer<LibraryPageDoc>(saveLibraryPage);

/**
 * Who is editing, in the words a screen can show: the signed-in member's display
 * name, denormalised onto the page at write time.
 *
 * NEVER a uid — uids appear nowhere in the family-shared data model, and one would
 * be unreadable in the single place this field exists to be read.
 */
function authorName(): string {
  return get(currentMember)?.name ?? 'Someone';
}

/** The page as the store currently holds it, or `undefined` if it is not there. */
export function libraryPageById(id: string): LibraryPageDoc | undefined {
  return get(_pages)?.find((p) => p.id === id);
}

function applyOptimistically(page: LibraryPageDoc): LibraryPageDoc {
  const stamped: LibraryPageDoc = {
    ...page,
    updatedAt: new Date().toISOString(),
    lastEditedBy: authorName(),
  };
  _pages.update((current) =>
    (current ?? []).some((p) => p.id === stamped.id)
      ? (current ?? []).map((p) => (p.id === stamped.id ? stamped : p))
      : [...(current ?? []), stamped],
  );
  return stamped;
}

// ─── Revision capture ────────────────────────────────────────────────────────

// A revision is captured ONCE PER EDITING SESSION, not once per write. Writes are
// debounced, so snapshotting inside `queueLibraryEdit` would push a revision per
// keystroke burst and a ten-deep history would hold ten versions of the same
// paragraph — a history that can restore nothing.
//
// So the pre-edit state is held HERE, in memory, from the moment an editor opens
// until the first edit of that session actually queues, and rides into the document
// on that write rather than costing a write of its own. In memory and not in
// browser storage: Rule 3, and the loss if the tab dies mid-edit is one undo step
// on a page whose own text was never changed.
const pendingSnapshots = new Map<string, LibraryPageRevisionDoc>();

/**
 * Mark the start of an editing session on `id`, capturing what the page says NOW
 * as the version a later restore would return to.
 *
 * Idempotent within a session: a second call while a snapshot is still pending
 * keeps the FIRST one, so opening the title editor, then the body editor, then the
 * title again is one version and not three.
 */
export function beginLibraryEdit(id: string): void {
  if (pendingSnapshots.has(id)) return;
  const page = libraryPageById(id);
  if (page === undefined) return;
  pendingSnapshots.set(id, {
    title: page.title,
    body: page.body,
    savedAt: new Date().toISOString(),
    savedBy: authorName(),
  });
}

/**
 * Abandon a pending snapshot without recording it — for an editing session that
 * ended having changed nothing.
 *
 * `pushRevision` would drop such a snapshot anyway (it deduplicates against the
 * newest revision), so this is not what makes the history honest; it is what stops
 * a stale snapshot from an abandoned session attaching itself to an unrelated edit
 * made minutes later.
 */
export function endLibraryEdit(id: string): void {
  pendingSnapshots.delete(id);
}

/**
 * The version this write is about to REPLACE — which is not always the version the
 * editor opened on (issue #1392).
 *
 * The pending snapshot decides WHETHER a revision is captured at all: once per
 * editing session, for the reason above. It is no longer the only source of WHAT is
 * captured, because between the editor opening and this write landing another
 * writer can have saved the page — a person on a second device, or the chef's
 * `writeKitchenNoteForChef` Cloud Function. The store is the live view of what is
 * in Firestore, and this runs BEFORE `applyOptimistically`, so it still holds the
 * outgoing version at this point. Filing the snapshot instead would file a version
 * that is already sitting in `revisions[0]` — the other writer put it there when it
 * wrote — where `pushRevision`'s dedup correctly drops it as a duplicate, and the
 * version actually being overwritten would leave no trace anywhere.
 *
 * When nobody else wrote, the stored version IS the snapshot and this returns it
 * unchanged, so ordinary editing records exactly what it recorded before. When they
 * differ, the difference is itself the evidence of a second writer: the store can
 * only have moved while an editor was open for that reason.
 *
 * `savedBy` stays the SESSION'S author rather than becoming the other writer's name
 * — the field is rendered as "replaced by …" and this write is the replacement.
 * `savedAt` moves to the clock, because a version that arrived after the editor
 * opened stopped being current now, not then.
 */
function replacedVersion(id: string, snapshot: LibraryPageRevisionDoc): LibraryPageRevisionDoc {
  const stored = libraryPageById(id);
  if (stored === undefined) return snapshot;
  if (stored.title === snapshot.title && stored.body === snapshot.body) return snapshot;
  return {
    ...snapshot,
    title: stored.title,
    body: stored.body,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Queue an in-place edit to a page. The store is updated synchronously; the write
 * lands at the end of the debounce window, or sooner if something flushes it.
 *
 * The returned promise is the write that will carry this edit, so a caller keeps
 * the `ReadResult` its failure toast needs (Rule 10) — and every edit in one window
 * shares one promise, so a burst can raise at most one toast.
 *
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT (CLAUDE.md Rule 12). A version another
 * writer landed between an editor opening and that session's FIRST write is filed
 * into `revisions` rather than lost — pinned by `libraryService.test.ts` → "a second
 * writer's version reached the store". It does NOT stop the clobber: the
 * full-document `setDoc` still overwrites that writer's text, which is the LWW
 * contract and deliberate. And it covers the first write of a session only: once the
 * snapshot is spent, a second writer landing later in the same session is
 * overwritten with no revision recorded, because nothing here can then tell "someone
 * else changed the body" from "this tab changed it". Closing that needs the tab to
 * remember what it last wrote, and it is not closed today.
 */
export function queueLibraryEdit(page: LibraryPageDoc): Promise<ReadResult<void, DomainError>> {
  const snapshot = pendingSnapshots.get(page.id);
  const withHistory: LibraryPageDoc =
    snapshot === undefined
      ? page
      : { ...page, revisions: pushRevision(page.revisions, replacedVersion(page.id, snapshot)) };
  pendingSnapshots.delete(page.id);
  const stamped = applyOptimistically(withHistory);
  return pageWrites.queue(stamped.id, stamped);
}

/**
 * Write out every pending library edit now.
 *
 * Called when a field is left and when a page is navigated away from: the debounce
 * alone would lose the last edit made inside its window, and blur alone never fires
 * for `page.fill()` in the e2e. Both, not either. The tab going away is covered by
 * `writeCoalescer`'s own `pagehide`/`visibilitychange` handlers.
 */
export function flushLibraryWrites(): Promise<void> {
  return pageWrites.flushAll();
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * Mint a new page and write it immediately — not through the coalescer, because
 * the caller navigates to it and the page has to exist by the time it lands.
 *
 * Returns the document rather than just the id: the caller needs the id to
 * navigate, and the store has it either way.
 */
export async function createLibraryPage(
  title: string,
  /** Starting text, for a page minted from an import. Blank for a hand-written one. */
  body = '',
): Promise<ReadResult<LibraryPageDoc, DomainError>> {
  // THE SAME RAIL `appendToLibraryPage` STANDS ON, and the same arithmetic: an
  // import can mint a page from a body of any length, and a body past
  // `LIBRARY_PAGE_BODY_MAX` is a Zod `.max()` violation, so a page written past it
  // fails to parse on the next read and disappears from the list — the exact
  // failure `LIBRARY_PAGE_TOO_LONG` exists for. `appendedBody('', body)` against
  // an empty existing body is just `body`, but going through it rather than
  // checking `body.length` directly is what keeps `appendedBody` the ONE place
  // this arithmetic lives, the way the import sheet's own refusal already does.
  if (appendedBody('', body).length > LIBRARY_PAGE_BODY_MAX) {
    return failure({
      kind: 'ValidationError',
      code: ErrorCode.LIBRARY_PAGE_TOO_LONG,
      message: 'That would make the page too long.',
    });
  }
  const now = new Date().toISOString();
  const author = authorName();
  const page: LibraryPageDoc = {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    kind: 'note',
    title: title.trim(),
    body,
    tags: [],
    createdAt: now,
    updatedAt: now,
    createdBy: author,
    lastEditedBy: author,
    revisions: [],
  };
  // Optimistic first, so the list and the page itself have the document before the
  // write comes back — offline, it may not come back for a while.
  _pages.update((current) => [...(current ?? []), page]);
  const result = reportIfFailed(getErrorReporter(), await saveLibraryPage(page));
  return result.kind === 'ok' ? success(page) : result;
}

/**
 * Put `revision` of page `id` back — its title and its body — as an ordinary
 * edit.
 *
 * KEYED ON THE REVISION ITSELF, not its position in the array. The sheet that
 * calls this previews a revision by VALUE (`page.revisions`, read once when the
 * preview opened) and used to hand back the INDEX it was previewed at, re-read
 * against a live array at write time — so a concurrent write from another
 * device, landing between the preview and the tap, shifts every index by one and
 * silently restores a different version than the one shown, while still
 * reporting success. Family-shared data has no "nobody else is editing this"
 * guarantee, so that window is not an edge case. Matching on the whole snapshot
 * finds the SAME entry regardless of where it now sits — or reports `NotFound`
 * if that concurrent write was the one that evicted it past the cap, rather than
 * restoring whatever happens to be sitting at the old index.
 *
 * ROUTED THROUGH THE SESSION MACHINERY, not around it. `beginLibraryEdit` first,
 * so the version being replaced is snapshotted and rides into `revisions` on the
 * write `queueLibraryEdit` makes. Calling `saveLibraryPage` (or `queueLibraryEdit`
 * alone) would discard the text the restore is overwriting — the one thing a
 * history feature must never do — and a restore made by mistake would be final.
 *
 * Which is also why a restore is undoable by restoring again: what was showing
 * becomes revision 0, so restoring that puts it back.
 *
 * A RESTORE THAT CHANGES NOTHING WRITES NOTHING — the guard below, and not
 * `pushRevision`'s dedup, is what makes that true. The dedup compares the incoming
 * snapshot against `revisions[0]`, so restoring version 3 while version 3's text
 * is already on screen would snapshot that same text, find `revisions[0]`
 * different, and record an eleventh copy of what is showing. Short-circuiting here
 * is the only place that can see the comparison that actually matters.
 *
 * The cap stays enforced in `pushRevision` and only there.
 *
 * `NotFound` rather than a thrown error for a page the store does not hold, or a
 * revision no longer in it — deleted, or restored past, on another device while
 * the sheet was open (Rule 10).
 */
export function restoreLibraryRevision(
  id: string,
  revision: LibraryPageRevisionDoc,
): Promise<ReadResult<void, DomainError>> {
  const page = libraryPageById(id);
  const stillThere = page?.revisions.some(
    (r) =>
      r.title === revision.title &&
      r.body === revision.body &&
      r.savedAt === revision.savedAt &&
      r.savedBy === revision.savedBy,
  );
  if (page === undefined || !stillThere) {
    return Promise.resolve(failure({ kind: 'NotFound', resource: 'libraryPage', id }));
  }
  if (revision.title === page.title && revision.body === page.body) {
    return Promise.resolve(success(undefined));
  }
  beginLibraryEdit(id);
  return queueLibraryEdit({ ...page, title: revision.title, body: revision.body });
}

/**
 * Add `markdown` to the end of page `id`'s body, as an ordinary edit.
 *
 * FLUSHES FIRST, and the flush belongs to the command rather than to its caller.
 * The page may have a body open in a `Textarea` when the import sheet is used, and
 * the safe order is "land what is typed, then append to it". The optimistic apply
 * is synchronous, so the store already holds the typed text either way — what the
 * flush buys is that the caller cannot get the order wrong. ONE caller today
 * (`LibraryPageDocument.handleImport` — the list page mints a new page instead,
 * through `createLibraryPage`), but the ordering belongs to the command rather
 * than to it: a second caller that forgot to flush first would append onto stale
 * text, silently.
 *
 * REFUSES rather than truncates when the result would pass `LIBRARY_PAGE_BODY_MAX`
 * — and the refusal is not cosmetic: that maximum is a Zod `.max()` on the body, so
 * a document written past it fails to parse on the next read and the page vanishes
 * from the list. The import sheet measures the same sum through `appendedBody` and
 * refuses first, so this is the rail behind the screen — and `createLibraryPage`
 * stands on the same rail, through the same function, for the path that mints a
 * page rather than appending to one.
 */
export async function appendToLibraryPage(
  id: string,
  markdown: string,
): Promise<ReadResult<void, DomainError>> {
  await flushLibraryWrites();
  const page = libraryPageById(id);
  if (page === undefined) {
    return failure({ kind: 'NotFound', resource: 'libraryPage', id });
  }
  const body = appendedBody(page.body, markdown);
  if (body.length > LIBRARY_PAGE_BODY_MAX) {
    return failure({
      kind: 'ValidationError',
      code: ErrorCode.LIBRARY_PAGE_TOO_LONG,
      message: 'That would make the page too long.',
    });
  }
  beginLibraryEdit(id);
  return queueLibraryEdit({ ...page, body });
}

/**
 * Delete a page, and its history with it. A real delete — Salt has no soft-delete
 * and no tombstones.
 *
 * A pending edit to that page is FLUSHED FIRST rather than discarded, and the
 * ordering is what matters rather than the write: the coalescer holds a whole
 * document captured before the delete, so an entry left on its own timer would
 * issue that `setDoc` afterwards and silently resurrect the page. Flushing puts it
 * into Firestore's mutation queue ahead of the `deleteDoc` below, which is the
 * order that leaves the page deleted. Discarding it instead would be wrong for a
 * different reason — `discardAll()` is coalescer-wide, so deleting one page would
 * drop an unrelated edit to another.
 */
export async function removeLibraryPage(id: string): Promise<ReadResult<void, DomainError>> {
  pendingSnapshots.delete(id);
  await pageWrites.flush(id);
  _pages.update((current) => (current ?? []).filter((p) => p.id !== id));
  return reportIfFailed(getErrorReporter(), await deleteLibraryPage(id));
}

/** How many previous versions a page keeps. Re-exported for the surfaces to say so. */
export { LIBRARY_PAGE_REVISION_CAP };
