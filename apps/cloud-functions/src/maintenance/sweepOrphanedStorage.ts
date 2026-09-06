import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions';
import { flushServerObservability } from '@salt/observability/server';
import { reportServerError } from '../observability/reportServerError.js';
import { SWEEPS, NESTED_SWEEPS } from './storageSweepTargets.js';

// Weekly sweep of artefacts whose owning Firestore doc is gone (issues #620, #789).
//
// WHY THIS EXISTS — nothing else in this codebase deletes a Storage object.
// `canon-icons/{canonId}.webp`, `recipe-images/{recipeId}.webp` and
// `product-form-icons/{formId}.webp` are all keyed off a deterministic doc id, so
// deleting the doc (or splitting a canon item) strands the object: no doc, no
// reference, nothing that would ever remove it.
// Staging reached 165 orphans out of 168 objects before anyone noticed.
//
// A GCS lifecycle rule cannot express this — orphan-ness depends on Firestore,
// not on object age — so the join has to be code.
//
// The same split that strands an icon strands the canon item's embedding vector
// in `canonEmbeddings/{canonId}` (#789), and there the client cannot possibly
// clean up after itself: `firestore.rules` denies it read AND write. So the
// sweep also runs one Firestore→Firestore pass, sharing every guard below.
//
// COST SHAPE — per pass: one candidate listing (a bucket list, or an id-only
// collection scan), plus one id-only scan of the owning collection (`.select()`
// fetches no field data). No per-candidate `get`. At Salt's scale this is a few
// hundred names a week.
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

/** Object age below which an orphan is left alone. See selectOrphanedObjects. */
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Upper bound on deletions per run — blast-radius cap, not a pagination limit. */
const MAX_DELETIONS_PER_RUN = 500;

// SWEEPS / UNSWEPT live in their own module so the coverage guard can import the
// real values instead of regexing this file, and can do it without paying for
// firebase-admin, firebase-functions and Genkit at module init.

/** A candidate artefact, reduced to just what the decision needs. */
export interface SweepCandidate {
  /** Full path, e.g. `canon-icons/abc.webp` or `canonEmbeddings/abc`. */
  path: string;
  /** The doc id the path is keyed by. */
  id: string;
  /** When the artefact last came into being, in epoch ms. */
  createdAt: number;
}

/**
 * Pure selection: which candidates are orphans old enough to delete.
 *
 * Two guards, both deliberate:
 *
 *  - **Age grace.** A doc is always written before the trigger generates its
 *    object, so an object appearing between the bucket list and the id scan is
 *    already near-impossible. The grace closes that window for good AND absorbs
 *    the more realistic hazard: a partial or failed Firestore scan making live
 *    ids look absent. A young orphan simply waits for next week.
 *  - **Cap.** If the join is ever wrong, it is wrong at most `limit` objects at a
 *    time, with six days to notice before the next run.
 */
export function selectOrphanedObjects({
  candidates,
  liveIds,
  now,
  graceMs = GRACE_MS,
  limit = MAX_DELETIONS_PER_RUN,
}: {
  candidates: readonly SweepCandidate[];
  liveIds: ReadonlySet<string>;
  now: number;
  graceMs?: number;
  limit?: number;
}): SweepCandidate[] {
  return candidates
    .filter((c) => !liveIds.has(c.id) && now - c.createdAt >= graceMs)
    .slice(0, limit);
}

/** `canon-icons/abc123.webp` → `abc123`. Returns null for a nested or bare path. */
export function idFromObjectPath(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  // Nested paths are NOT unwritten — `batch-images/` is nested, and #968 gave it
  // its own pass and its own key function (`nestedKeyFromObjectPath`). This one
  // stays strictly single-segment: the two SHAPES must not be conflated, because
  // a nested path fed to a flat join produces a key no document can match, and a
  // key nothing matches is a deletion.
  if (name.includes('/')) return null;
  const dot = name.lastIndexOf('.');
  const id = dot === -1 ? name : name.slice(0, dot);
  return id.length > 0 ? id : null;
}

/**
 * `batch-images/b1/obs1.webp` → `b1/obs1`. Null for any other shape (issue #968).
 *
 * The twin of `idFromObjectPath` for two-segment objects, and deliberately strict
 * in the same direction: EXACTLY two segments, both non-empty. One segment, three
 * segments or an empty half all return null and the object is left alone forever,
 * because a key this function is not certain of is a key no live document will
 * match — and an unmatched key is a deleted photograph.
 */
export function nestedKeyFromObjectPath(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  const slash = name.indexOf('/');
  // `<= 0` covers both "no slash at all" (a flat path) and an empty first
  // segment, which is the whole of the parent half being absent.
  if (slash <= 0) return null;
  const parent = name.slice(0, slash);
  const leaf = name.slice(slash + 1);
  // A third segment. Deeper nesting is a shape this join has no key for.
  if (leaf.includes('/')) return null;
  const dot = leaf.lastIndexOf('.');
  const id = dot === -1 ? leaf : leaf.slice(0, dot);
  return id.length > 0 ? `${parent}/${id}` : null;
}

/** One leaf document of a nested sweep, reduced to just what the join needs. */
export interface NestedLeaf {
  /** The leaf doc id — an observation id. */
  id: string;
  /** Its parent doc id (`ref.parent.parent?.id`), or null if it is not nested. */
  parentId: string | null;
  /** The collection that parent lives in (`ref.parent.parent?.parent.id`). */
  parentCollection: string | null;
  /** The claim field's RAW value, unvalidated and unparsed. See below. */
  claim: unknown;
}

/**
 * Pure join: which `{parentId}/{leafId}` keys are claimed by a live document.
 *
 * Extracted from the pass so the half of this feature that can delete a
 * photograph is testable without an emulator, exactly as `selectOrphanedObjects`
 * is. Three conditions, and a key is live only if all three hold:
 *
 *  - the leaf is nested under `parentCollection`. A collection group matches the
 *    NAME anywhere in the tree; nothing else in this codebase nests an
 *    `observations` collection, and this says so rather than trusting it.
 *  - its parent still exists. Deleting a Firestore document does not delete its
 *    subcollection, so a parent deleted without a cascade leaves leaves behind
 *    that would otherwise claim their objects forever.
 *  - the leaf CLAIMS the object — its claim field is present.
 *
 * THE CLAIM CHECK IS PRESENCE, NOT VALIDITY, and the asymmetry is the point. A
 * claim field that is there but malformed is a document we do not understand,
 * and the safe reading of "do not understand" is claimed: `{}`, `0`, `''` and a
 * bare string all keep the object. Only `null` and `undefined` — the two values
 * that positively mean "no object attached" — release it. Parsing here would let
 * a schema change delete photographs a person took.
 */
export function liveNestedKeys({
  leaves,
  liveParentIds,
  parentCollection,
}: {
  leaves: readonly NestedLeaf[];
  liveParentIds: ReadonlySet<string>;
  parentCollection: string;
}): Set<string> {
  return new Set(
    leaves.flatMap((leaf) => {
      if (leaf.parentId === null || leaf.parentCollection !== parentCollection) return [];
      if (!liveParentIds.has(leaf.parentId)) return [];
      if (leaf.claim === null || leaf.claim === undefined) return [];
      return [`${leaf.parentId}/${leaf.id}`];
    }),
  );
}

/**
 * The two-segment twin of `sweepPrefix` (issue #968), for `batch-images/`.
 *
 * A batch observation photo lives at `batch-images/{batchId}/{observationId}.webp`
 * — nested, because an observation is nested — so there is no single doc id to
 * join on. The key is the pair, and a key is LIVE only when both halves hold:
 *
 *  - the leaf document exists AND carries its claim field. This is the half that
 *    earns the pass its keep today: `setObservationImageUpload` saves the object
 *    and THEN stamps the URL onto the observation, so a failed stamp leaves an
 *    object no document references while the document itself is very much alive.
 *    Joining on document existence alone would read that object as claimed.
 *  - its parent document exists. Deleting a Firestore document does NOT delete
 *    its subcollection, so a future `deleteBatch` that removes only
 *    `batches/{batchId}` leaves its observations behind, still claiming their
 *    photos forever. Intersecting with the live parents closes that in advance.
 *
 * PRESENCE, NOT A PARSE. The claim check reads the raw field and asks only
 * whether it is there. A malformed `image` is a document we do not understand,
 * and the safe reading of "do not understand" is CLAIMED — the same posture
 * `embeddingCandidate` takes with an undated row. Validating here would turn a
 * schema bug into photo loss, and this is the one pass whose objects are
 * photographs a person took rather than pictures a model drew.
 *
 * Everything else is shared, not re-implemented: `selectOrphanedObjects` and with
 * it the seven-day grace and the 500-object cap, the log shape, and the
 * never-throw handler this runs inside.
 */
export async function sweepNestedPrefix(
  { prefix, collectionGroup, parentCollection, claimField }: (typeof NESTED_SWEEPS)[number],
  now: number,
): Promise<void> {
  const bucket = getStorage().bucket();
  const db = getFirestore();

  // Three id-only reads in parallel. `.select(claimField)` projects the one field
  // the claim check needs; `.select()` on the parents fetches no field data at
  // all. A bare collection-group scan with no `where`/`orderBy` needs no
  // composite index — adding a filter here would.
  const [files, leafSnap, parentSnap] = await Promise.all([
    bucket.getFiles({ prefix }),
    db.collectionGroup(collectionGroup).select(claimField).get(),
    db.collection(parentCollection).select().get(),
  ]);

  const liveKeys = liveNestedKeys({
    leaves: leafSnap.docs.map((doc) => {
      const parentRef = doc.ref.parent.parent;
      return {
        id: doc.id,
        parentId: parentRef?.id ?? null,
        parentCollection: parentRef?.parent.id ?? null,
        claim: doc.get(claimField) as unknown,
      };
    }),
    liveParentIds: new Set(parentSnap.docs.map((d) => d.id)),
    parentCollection,
  });

  const candidates = files[0].flatMap((file) => {
    const id = nestedKeyFromObjectPath(file.name, prefix);
    if (id === null) return [];
    // timeCreated restarts on overwrite, exactly as in sweepPrefix — retaking a
    // photo restarts its grace, which only ever delays a deletion.
    const createdAt = Date.parse(String(file.metadata.timeCreated ?? ''));
    if (Number.isNaN(createdAt)) return [];
    return [{ path: file.name, id, createdAt }];
  });

  const doomed = selectOrphanedObjects({ candidates, liveIds: liveKeys, now });

  for (const orphan of doomed) {
    await bucket.file(orphan.path).delete();
    logger.info('sweepOrphanedStorage: deleted orphan', {
      path: orphan.path,
      ageDays: Math.floor((now - orphan.createdAt) / 86_400_000),
    });
  }

  logger.info('sweepOrphanedStorage: swept prefix', {
    prefix,
    objects: candidates.length,
    liveDocs: liveKeys.size,
    deleted: doomed.length,
    capped: doomed.length === MAX_DELETIONS_PER_RUN,
  });
}

async function sweepPrefix(prefix: string, collection: string, now: number): Promise<void> {
  const bucket = getStorage().bucket();
  const db = getFirestore();

  // getFiles auto-paginates. `.select()` with no fields returns id-only docs —
  // the whole point is to avoid pulling canon/recipe payloads across the wire.
  const [files, liveSnap] = await Promise.all([
    bucket.getFiles({ prefix }),
    db.collection(collection).select().get(),
  ]);

  const liveIds = new Set(liveSnap.docs.map((d) => d.id));

  const candidates = files[0].flatMap((file) => {
    const id = idFromObjectPath(file.name, prefix);
    if (id === null) return [];
    // timeCreated is set on every new generation, so an overwrite (e.g. the
    // reframe script) restarts the grace. That only ever delays a deletion.
    const createdAt = Date.parse(String(file.metadata.timeCreated ?? ''));
    if (Number.isNaN(createdAt)) return [];
    return [{ path: file.name, id, createdAt }];
  });

  const doomed = selectOrphanedObjects({ candidates, liveIds, now });

  for (const orphan of doomed) {
    await bucket.file(orphan.path).delete();
    logger.info('sweepOrphanedStorage: deleted orphan', {
      path: orphan.path,
      ageDays: Math.floor((now - orphan.createdAt) / 86_400_000),
    });
  }

  logger.info('sweepOrphanedStorage: swept prefix', {
    prefix,
    objects: candidates.length,
    liveDocs: liveIds.size,
    deleted: doomed.length,
    // Surfaces the cap actually biting, rather than a silent truncation.
    capped: doomed.length === MAX_DELETIONS_PER_RUN,
  });
}

/**
 * `canonEmbeddings/{canonId}` → sweep candidate. Null when the doc carries no
 * usable timestamp, which leaves it alone forever rather than guessing its age.
 *
 * `updatedAt` is `.optional()` on `CanonEmbeddingSchema` — rows written before
 * it was added have none — so "undated" is a real state, not a corruption, and
 * the safe reading of an unknown age is "too young to touch". The count is
 * logged so a permanently unsweepable row is visible rather than silent.
 */
export function embeddingCandidate(id: string, updatedAt: unknown): SweepCandidate | null {
  // Both writers (`onCanonItemWritten` and the #410 migration) write an ISO
  // string; anything else is not a timestamp we are entitled to interpret.
  if (typeof updatedAt !== 'string') return null;
  const createdAt = Date.parse(updatedAt);
  if (Number.isNaN(createdAt)) return null;
  return { path: `canonEmbeddings/${id}`, id, createdAt };
}

/**
 * The Firestore twin of `sweepPrefix` (issue #789): same join, same guards,
 * different storage. A vector is keyed by canon id exactly as an icon is, so
 * deleting or splitting a canon item strands it identically — but a vector is
 * more expensive to recreate than an icon (a Gemini embedding call), so the
 * grace and the cap earn their keep here more, not less.
 *
 * A regenerated embedding restarts the grace via `updatedAt`, which — exactly as
 * with a Storage overwrite — only ever delays a deletion.
 */
async function sweepCanonEmbeddings(now: number): Promise<void> {
  const db = getFirestore();

  // `.select('updatedAt')` projects the one field the age guard needs; the
  // ~3072-float vectors stay on the server, unread. The `canonItems` scan is the
  // same id-only scan the `canon-icons/` pass performs, repeated rather than
  // shared so that pass keeps its own self-contained join.
  const [embeddingSnap, liveSnap] = await Promise.all([
    db.collection('canonEmbeddings').select('updatedAt').get(),
    db.collection('canonItems').select().get(),
  ]);

  const liveIds = new Set(liveSnap.docs.map((d) => d.id));

  const candidates = embeddingSnap.docs.flatMap((doc) => {
    const candidate = embeddingCandidate(doc.id, doc.get('updatedAt'));
    return candidate === null ? [] : [candidate];
  });

  const doomed = selectOrphanedObjects({ candidates, liveIds, now });

  for (const orphan of doomed) {
    await db.doc(orphan.path).delete();
    logger.info('sweepOrphanedStorage: deleted orphan', {
      path: orphan.path,
      ageDays: Math.floor((now - orphan.createdAt) / 86_400_000),
    });
  }

  logger.info('sweepOrphanedStorage: swept collection', {
    collection: 'canonEmbeddings',
    objects: candidates.length,
    liveDocs: liveIds.size,
    deleted: doomed.length,
    // Surfaces the cap actually biting, rather than a silent truncation.
    capped: doomed.length === MAX_DELETIONS_PER_RUN,
    // Docs with no usable `updatedAt`: scanned, never sweepable, otherwise unseen.
    undated: embeddingSnap.size - candidates.length,
  });
}

export const sweepOrphanedStorage = onSchedule(
  {
    // Sunday 03:00 — well clear of any waking usage.
    schedule: '0 3 * * 0',
    timeZone: 'Europe/London',
    region: 'europe-west2',
    memory: '512MiB',
    secrets: [posthogApiKey],
    // The sweep is idempotent and weekly; a retry storm on a broken run buys
    // nothing that next Sunday would not.
    retryCount: 0,
    // Listing three prefixes and one collection, id-only scans, then serial
    // deletes. The export name stays `sweepOrphanedStorage` after #789 widened
    // its remit: renaming it would tear down and recreate the schedule.
    timeoutSeconds: 540,
  },
  async () => {
    const now = Date.now();
    try {
      // Serial, not parallel: the passes are independent and there is no
      // deadline pressure, so this keeps memory and Storage QPS flat.
      for (const { prefix, collection } of SWEEPS) {
        await sweepPrefix(prefix, collection, now);
      }
      // Not a SWEEPS row: that table is prefix→collection, and this pass has no
      // prefix, no bucket and a different deleter. It shares what actually
      // matters — the schedule, the guards, and this never-throw handler.
      // Not a SWEEPS row either: these prefixes key on a PAIR of ids and join
      // against a collection group, so the table shape differs — everything that
      // matters (grace, cap, log shape, this handler) is still shared.
      for (const nested of NESTED_SWEEPS) {
        await sweepNestedPrefix(nested, now);
      }
      await sweepCanonEmbeddings(now);
    } catch (err) {
      // Never throw out of a scheduled handler: it is a StorageError/SyncError
      // class of failure with no caller to surface to, and Scheduler would just
      // replay a deterministic failure. Report it and let next week try again.
      logger.error('sweepOrphanedStorage: sweep failed', { error: String(err) });
      // StorageError: a Firestore scan or Storage list/delete failing is exactly
      // the unexpected-infrastructure class the reporting policy says to surface.
      reportServerError(err, 'StorageError');
    } finally {
      await flushServerObservability();
    }
  },
);
