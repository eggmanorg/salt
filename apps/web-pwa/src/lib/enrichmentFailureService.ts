import { subscribeEnrichmentFailures } from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter } from '@salt/observability';
import { enrichmentFailureId, type EnrichmentFailureDoc } from '@salt/domain/schemas';
import type { EnrichmentKind } from '@salt/domain/schemas';
import { writable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import { reportSubscriptionError } from './errorReporting.js';

// Background-enrichment failures (issue #1419), app-wide.
//
// App-wide rather than page-local for the same reason `kitchenTools` is: it is a
// lookup table, not a page's data. The recipe page asks "did this recipe's kit
// inference fail?", and Phase 2's surfaces ask the same question of a hero
// image, a timing strip and four kinds of icon — one small collection answers
// all of them, and a page-local subscription per surface would be six listeners
// on the same handful of documents.
//
// ─── THE ONE RULE THIS FILE EXISTS UNDER ────────────────────────────────────
// **Salt records, never polices.** A record here is information. It must never
// gate cooking, planning, editing or shopping, and it must never produce a
// confirmation dialog. Everything below is a read; there is nothing to write,
// because `enrichmentFailures` is client-write-denied in `firestore.rules`.

// ─── Reactive store ─────────────────────────────────────────────────────────

const _enrichmentFailures = writable<ReadonlyMap<string, EnrichmentFailureDoc>>(new Map());

/**
 * Every recorded failure, keyed by `enrichmentFailureId(kind, subjectId)`.
 *
 * Empty until `initEnrichmentFailureSync` runs and until the first snapshot
 * lands — and an empty map is indistinguishable from "nothing has failed", which
 * is the correct default: before the records arrive, every surface renders
 * exactly as it did before this collection existed.
 */
export const enrichmentFailures: Readable<ReadonlyMap<string, EnrichmentFailureDoc>> =
  _enrichmentFailures;

// ─── Error reporting ────────────────────────────────────────────────────────

let _errorReporter: ReturnType<typeof createObservabilityErrorReportingAdapter> | null = null;
function getErrorReporter() {
  if (!_errorReporter) _errorReporter = createObservabilityErrorReportingAdapter();
  return _errorReporter;
}

// ─── Init / cleanup ─────────────────────────────────────────────────────────

export function initEnrichmentFailureSync(): () => void {
  const errors = getErrorReporter();
  return subscribeEnrichmentFailures(
    (failures) => _enrichmentFailures.set(failures),
    (err, rawError) => reportSubscriptionError(errors, err, rawError),
  );
}

// ─── The one shared lookup ──────────────────────────────────────────────────

/**
 * Did this background job give up on this subject?
 *
 * A pure function of a delivered map, so a surface can ask it inside a `$derived`
 * and re-render the moment a redo clears the record. The key is built by
 * `@salt/domain`'s `enrichmentFailureId`, which is also what the Cloud Function
 * writes under — one definition, so the read and the write cannot drift.
 */
export function hasEnrichmentFailure(
  failures: ReadonlyMap<string, EnrichmentFailureDoc>,
  enrichment: EnrichmentKind,
  subjectId: string,
): boolean {
  return failures.has(enrichmentFailureId(enrichment, subjectId));
}

// ─── Test helpers ───────────────────────────────────────────────────────────
//
// No `get…Snapshot()` here, unlike its sibling services: nothing imperative
// reads this collection. Every consumer is a `$derived` over the store, which is
// what makes a marker clear the instant a redo lands.

export function __resetEnrichmentFailureServiceForTest(): void {
  _enrichmentFailures.set(new Map());
  _errorReporter = null;
}
