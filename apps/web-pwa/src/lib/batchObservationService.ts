import {
  subscribeBatchObservations,
  addBatchObservation,
  callSetObservationImageUpload,
} from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter } from '@salt/observability';
import type { BatchObservationDoc } from '@salt/domain/schemas';
import { reportIfFailed, reportSubscriptionError } from './errorReporting.js';
import { success, type DomainError, type ReadResult } from '@salt/shared-types';
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
// already an instant, and this service writes exactly what it was handed. The same
// goes for `stageId`: which stage a reading is about is a thing a person chose.
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

// ─── Commands ─────────────────────────────────────────────────────────────────

/** What the log screen collects. Everything is optional except which run it is. */
export interface LogObservationInput {
  batchId: string;
  /**
   * WHEN THE READING WAS TAKEN, ISO. Not when it was typed, and not read from a
   * clock here — the screen owns it, because it is the only thing that can be told
   * "this was yesterday evening". The log is ordered by it.
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
 * `ph` IS still written null, and deliberately: it is a ferment's measurement rather
 * than a bake's or a cure's, and phase 03 of the epic is where it earns a control
 * (docs/formulas-schedules-batches.md). Null is what "not measured" is, so nothing
 * here has to be revisited when a screen does ask.
 */
export async function logObservation(
  input: LogObservationInput,
): Promise<ReadResult<{ observationId: string; photo: PhotoOutcome }, DomainError>> {
  const observation: BatchObservationDoc = {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    at: input.at,
    stageId: input.stageId,
    weightGrams: input.weightGrams,
    ph: null,
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
