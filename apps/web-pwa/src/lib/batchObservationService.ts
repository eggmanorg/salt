import {
  subscribeBatchObservations,
  addBatchObservation,
  callSetObservationImageUpload,
} from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter } from '@salt/observability';
import type { BatchObservationDoc } from '@salt/domain/schemas';
import { reportIfFailed, reportSubscriptionError } from './errorReporting.js';
import { ErrorCode, failure, success, type DomainError, type ReadResult } from '@salt/shared-types';
import { writable } from 'svelte/store';
import type { Readable } from 'svelte/store';

// The observation log (issue #812, phase 4 of epic #778) — the store over
// `batches/{batchId}/observations` and the ONE WRITE PATH into it.
//
// Its own service rather than four more exports on `batchService`, for the reason
// the log is its own subcollection: a batch document and its log have different
// lifetimes and different write shapes. A run is one document rewritten whole under
// LWW; the log is many documents, each written once by whoever was holding the
// scale. Keeping them apart means the log's subscription can be opened, closed and
// reasoned about without going anywhere near the run's optimistic-write guards —
// which exist to stop a stale snapshot un-marking a stage and have nothing to say
// about an append-only list.
//
// IT MINTS ONE THING, and used to mint two. THE ID: `crypto.randomUUID()`, once,
// here and not in the domain (CLAUDE.md Rule 1), exactly as `batchService` mints the
// run's. It is also the document id, which is what makes correcting an entry a
// re-write of the same id rather than a delete-and-re-add (there is no delete — see
// `batchObservationSync.ts`).
//
// THE INSTANT IS NO LONGER READ HERE (issue #1276). `at` is WHEN THE READING WAS
// TAKEN and the log is ordered by it, so a weight read at eight and typed at nine
// belongs at eight — which means the screen, not this service, is the only thing
// that knows it. The sheet has to read the clock anyway to seed its `datetime-local`
// box; a second read here would be a second answer to one question, and the one that
// reached Firestore would be the later of the two. So `at` arrives on the input,
// already an instant, and this service writes the moment it was handed — canonicalised
// to UTC, for the ordering reason given at the field, and otherwise untouched. The
// same goes for `stageId`: which stage a reading is about is a thing a person chose.
//
// THAT SENTENCE USED TO BE A PROMISE AND NOTHING MORE (issue #1292, CLAUDE.md Rule
// 12). "`at` arrives already an instant" was asserted right here and enforced only by
// one component's `canSave` — so the invariant held for exactly as long as this path
// had one caller, and #1280 gave it more. `logObservation` now REFUSES an `at` it
// cannot read, the same refusal `withStageStarted` and `withStageAdvanced` make in
// the domain, and `batchObservationService.test.ts` goes red if that stops being
// true. The sheet still blocks Save on the field: this is the rail behind the
// screen, not a second opinion offered to the person typing.
//
// ─── THE ORDER OF THE TWO WRITES IS NOT A DETAIL ───────────────────────────────
//
// The entry is written FIRST and the photo attached SECOND, because the callable
// finishes with a PARTIAL update (so a photo cannot clobber the note it belongs to)
// and a partial update of an absent document fails. That ordering also decides what
// a failure costs: once the entry has landed, the reading is safe, and a photo that
// will not upload costs the photo alone. `logObservation` says so in its return
// type rather than leaving the caller to guess — a failed upload is a `photo:
// failed` inside a SUCCESSFUL result, never an error that implies the weight was
// lost.

// ─── Reactive store ─────────────────────────────────────────────────────────────

// One run's log. TWO states only (`undefined` = not loaded, then an array): an empty
// log IS the loaded-and-nothing-recorded state, which is what most runs are, so
// there is no third case to distinguish.
//
// OLDEST FIRST, exactly as the adapter delivers it — `orderBy('at', 'asc')`, over
// the observed instant and never over arrival. Ordering is not re-done here and must
// not be: a screen that wants newest-first reverses a list it knows is sorted.
const _observations = writable<BatchObservationDoc[] | undefined>(undefined);
export const observations: Readable<BatchObservationDoc[] | undefined> = _observations;

// ─── MANY RUNS' LOGS AT ONCE (issue #1407, phase 2) ───────────────────────────
//
// The in-flight list carries each run's percent-lost figure, and that figure is
// arithmetic over the LOG — which lives in a subcollection the list has no other
// path to. Three routes existed and two were shut:
//
//   • a collection-group query over `observations` would need a
//     `match /{path=**}/observations/{id}` clause in `firestore.rules` and an
//     index; #1407 states outright that the rules and `@salt/firebase-sync` are
//     untouched, and widening a read rule to serve a display figure is not a
//     trade this feature is worth;
//   • denormalising the latest weight onto the batch document would put a second,
//     derived copy of a reading on a whole-document-LWW record whose entire point
//     is that it is frozen — precisely the drift `BatchSchema`'s header exists to
//     prevent.
//
// So: ONE `subscribeBatchObservations` PER RUN, reusing the adapter unchanged, and
// **only for runs that are IN FLIGHT and name a WEIGHT-LOSS target** — the two
// conditions `BatchListPage` actually needs before it opens a listener. A
// household with nothing but bread opens not a single extra listener, which is
// also what keeps this feature genuinely dark.
//
// THE BOUND IS ENFORCED AT THE CALL SITE, NOT HERE (#1426 review, blocking 1).
// This sentence used to say the bound was "the number of cures on the go — a
// handful" while the caller filtered on `target !== null` alone, over the WHOLE
// `batches` collection (`subscribeBatches` carries no `where`/`limit`) with ended
// runs still in it (`orderBatches` keeps them). The true set was every batch ever
// written that named a target, not the ones in flight — unbounded by history.
// `BatchListPage.svelte`'s own comment states the narrower gate it applies before
// calling in here, and `BatchListPage.test.ts` pins it: a done run, an abandoned
// run and a pH-only run each open no listener despite carrying a target. This
// module makes no assumption about the gate — see `initBatchObservationLogsSync`
// below — so the bound lives at exactly one call site, not two.
//
// A MAP, keyed by batch id. A run whose key is absent has not loaded yet and shows
// no figure; an empty array is loaded-and-nothing-recorded. Oldest first within
// each entry, exactly as the adapter delivers it.
const _logsByBatch = writable<ReadonlyMap<string, readonly BatchObservationDoc[]>>(new Map());
export const observationLogs: Readable<ReadonlyMap<string, readonly BatchObservationDoc[]>> =
  _logsByBatch;

// ─── Error reporting ────────────────────────────────────────────────────────────

let _errorReporter: ReturnType<typeof createObservabilityErrorReportingAdapter> | null = null;
function getErrorReporter() {
  if (!_errorReporter) _errorReporter = createObservabilityErrorReportingAdapter();
  return _errorReporter;
}

// ─── Init / cleanup ─────────────────────────────────────────────────────────────

/**
 * Subscribe to ONE run's log. Returns the unsub.
 *
 * Resets the store to the not-loaded state first, so moving between runs can never
 * show the previous one's readings — the same reset `initBatchSync` does, and for
 * the same reason.
 */
export function initBatchObservationsSync(batchId: string): () => void {
  _observations.set(undefined);
  const errors = getErrorReporter();
  return subscribeBatchObservations(
    batchId,
    (incoming) => _observations.set(incoming),
    (err, rawError) => reportSubscriptionError(errors, err, rawError),
  );
}

/**
 * Subscribe to several runs' logs at once, and return the unsub for all of them.
 *
 * Idempotent in the sense that matters: the store is RESET both on init AND on
 * teardown, so a departed run's readings can never outlive it — across a re-init
 * with a different set of runs, AND across a re-mount (#1426 review, should-fix
 * 6: the teardown used to only unsubscribe, leaving the map exactly as the
 * previous visit left it until the next effect ran, so the first render after
 * re-entering `/batches` could draw a meter from readings taken before whatever
 * was logged while the page was closed). That is the same reset
 * `initBatchObservationsSync` above does on init and for the same reason.
 *
 * The caller decides which runs are worth a listener — see the note above: today
 * that is the runs in flight with a weight-loss target, and nothing here assumes
 * it.
 */
export function initBatchObservationLogsSync(batchIds: readonly string[]): () => void {
  _logsByBatch.set(new Map());
  const errors = getErrorReporter();
  const unsubs = batchIds.map((batchId) =>
    subscribeBatchObservations(
      batchId,
      (incoming) =>
        _logsByBatch.update((current) => {
          const next = new Map(current);
          next.set(batchId, incoming);
          return next;
        }),
      (err, rawError) => reportSubscriptionError(errors, err, rawError),
    ),
  );
  return () => {
    for (const unsub of unsubs) unsub();
    _logsByBatch.set(new Map());
  };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** What the log screen collects. Everything is optional except which run it is. */
export interface LogObservationInput {
  batchId: string;
  /**
   * WHEN THE READING WAS TAKEN, ISO. Not when it was typed, and not read from a
   * clock here — the screen owns it, because it is the only thing that can be told
   * "this was yesterday evening". The log is ordered by it.
   *
   * Must be readable as an instant; anything else is refused (see the header). No
   * format beyond that is required — `Date.parse` is the bar, exactly as it is in
   * the domain's own stage transitions.
   */
  at: string;
  /**
   * Which stage of the run the reading is about, or `null` for one about the run as
   * a whole. Written through untouched: nothing here checks that it names a stage,
   * for the reason `BatchObservationSchema.stageId` gives.
   */
  stageId: string | null;
  /** Grams on the scale, or null when the entry is a note or a photo. */
  weightGrams: number | null;
  /**
   * The pH reading, 0–14, or null when it was not taken (issue #1407).
   *
   * `BatchObservationSchema.ph` has carried the field since the log was built and
   * was only ever missing a box; a fermented salami's weekly reading is a weight
   * AND a pH, so the sheet grew one and this passes it on untouched. The sheet
   * refuses an out-of-range figure on the field rather than handing one over, so
   * nothing here re-checks it — the schema is the rail either way, exactly as it is
   * for the humidity beside it.
   */
  ph: number | null;
  /**
   * Degrees Celsius at the instant of the reading, or null when it was not taken
   * (issue #1286). Unbounded below zero — a garage in January is a real place a
   * batch sits.
   */
  temperatureC: number | null;
  /**
   * Relative humidity, 0–100, or null when it was not taken. The sheet refuses an
   * out-of-range figure on the field rather than handing one over, so nothing here
   * re-checks it — `BatchObservationSchema` is the rail either way.
   */
  relativeHumidityPercent: number | null;
  /** Free text. `''` is "none" — the schema spells the absent state that way. */
  note: string;
  /**
   * The photo, bare base64 straight from `ImageCropper.getCroppedBase64()` (WebP,
   * no `data:` prefix). Omitted or null → no photo, and no callable is called.
   */
  photoBase64?: string | null;
}

/**
 * What became of the photo. Only ever read on a SUCCESSFUL log — the reading is
 * already saved by the time any of these is decided.
 */
export type PhotoOutcome =
  { kind: 'none' } | { kind: 'attached' } | { kind: 'failed'; error: DomainError };

/**
 * Append one reading to a run's log. THE ONLY PLACE AN OBSERVATION IS WRITTEN.
 *
 * Two writes, in the one order that works (see the header). The result is the
 * READING's: `err` means nothing was recorded and the user still has everything
 * they typed; `ok` means the entry is on the document, and `photo` says separately
 * whether the picture made it.
 *
 * `temperatureC` and `relativeHumidityPercent` are written THROUGH from the sheet
 * (issue #1286). They used to be written null with a note saying the screen offered
 * neither; the curing chamber made that false — a cure's weekly reading is a weight,
 * a temperature and a humidity — so the sheet grew both boxes and this passes them
 * on untouched. Null still means "not measured", which is most bakes.
 *
 * `ph` JOINED THEM in issue #1407, for the same reason and by the same route: a
 * fermented salami is finished when it has dropped below a pH, and a target nothing
 * can be measured against is half a feature. It is asked for on EVERY run rather
 * than only where the frozen target names a pH — the field has been on the document
 * since the log was built, and hiding a measurement behind an intention is the wrong
 * way round. Null still means "not measured", which is most bakes.
 */
export async function logObservation(
  input: LogObservationInput,
): Promise<ReadResult<{ observationId: string; photo: PhotoOutcome }, DomainError>> {
  // A refusal, not a substituted clock. Stamping "now" over an instant the caller
  // got wrong would file the reading at the wrong point in the very ordering this
  // field exists to carry, and do it silently — the caller has the box the person
  // typed into and is the only thing that can ask again.
  const at = Date.parse(input.at);
  if (!Number.isFinite(at)) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_OBSERVATION_TIME });
  }

  const observation: BatchObservationDoc = {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    // CANONICAL UTC, and that is not tidying. The log is ordered by a Firestore
    // `orderBy('at', 'asc')` over a STRING, so the sort is the instant's sort only
    // while every stored value is in one form. `2026-08-11T21:40:00+01:00` and
    // `2026-08-11T20:40:00.000Z` are the same moment and sort as if they were an hour
    // apart. Normalising costs nothing — the instant is identical either way — and it
    // is what makes "the log is ordered by `at`" true of every caller rather than of
    // the one that happened to call `toISOString()` first.
    at: new Date(at).toISOString(),
    stageId: input.stageId,
    weightGrams: input.weightGrams,
    ph: input.ph,
    temperatureC: input.temperatureC,
    relativeHumidityPercent: input.relativeHumidityPercent,
    note: input.note,
    // Null on the way in, always. The callable stamps the URL on afterwards with a
    // partial update; the bytes never travel through the document.
    image: null,
  };

  const written = reportIfFailed(
    getErrorReporter(),
    await addBatchObservation(input.batchId, observation),
  );
  if (written.kind !== 'ok') return written;

  const photo = input.photoBase64;
  if (photo === undefined || photo === null || photo === '') {
    return success({ observationId: observation.id, photo: { kind: 'none' } });
  }

  // `image/webp` is not a guess: the cropper's canvas path IS the encoder, and it
  // emits WebP. The callable auto-detects the real format from the bytes anyway —
  // this is a hint, not a contract (see `SetObservationImageUploadInputSchema`).
  const uploaded = reportIfFailed(
    getErrorReporter(),
    await callSetObservationImageUpload(input.batchId, observation.id, photo, 'image/webp'),
  );
  return success({
    observationId: observation.id,
    photo:
      uploaded.kind === 'ok' ? { kind: 'attached' } : { kind: 'failed', error: uploaded.error },
  });
}
