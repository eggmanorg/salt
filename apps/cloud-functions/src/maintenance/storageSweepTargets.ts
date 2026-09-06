// The prefix→collection table the weekly orphan sweep works from, plus the
// prefixes it deliberately does not (issue #919).
//
// Its own module, with no Firebase imports, for one reason: the coverage guard
// (`tests/maintenance/storageSweepCoverage.test.ts`) derives the full set of
// prefixes from `storage.rules` and checks every one appears here. Importing the
// real values beats regexing the sweep's source — a table read is exact where a
// regex is a second, weaker copy of the parser — and this module can be imported
// without paying for firebase-admin, firebase-functions and Genkit at module
// init, which is what kept the sweep's other guards to source scans.

export const SWEEPS = [
  { prefix: 'canon-icons/', collection: 'canonItems' },
  { prefix: 'recipe-images/', collection: 'recipes' },
  // Product-form pictograms (issue #871). Same deterministic keying as the two
  // above — `product-form-icons/{formId}.webp` — so deleting a form strands its
  // icon identically, and the join is the same join.
  { prefix: 'product-form-icons/', collection: 'productForms' },
  // Equipment pictograms (issue #877). Same deterministic-id shape as canon
  // icons: `equipment-icons/{itemId}.webp` beside `equipmentIcons/{itemId}`.
  // This pass only works because `onEquipmentManifestWritten` deletes the icon
  // DOC when its item leaves the manifest — otherwise the join below would find
  // the doc still present and correctly conclude the object is not orphaned.
  { prefix: 'equipment-icons/', collection: 'equipmentIcons' },
  // Generic kitchen-tool pictograms (issue #882). Same deterministic keying
  // again — `kit-icons/{toolId}.webp` beside `kitchenTools/{toolId}` — so
  // retiring a tool from the curated vocabulary strands its icon identically.
  { prefix: 'kit-icons/', collection: 'kitchenTools' },
] as const;

/**
 * Prefixes whose objects are keyed by a PAIR of ids, not one (issue #968).
 *
 * `SWEEPS` rows join `{prefix}{docId}.ext` against one collection. A nested
 * object — `batch-images/{batchId}/{observationId}.webp` — has no single doc id,
 * so it needs its own join: a collection-group scan of the leaf documents, keyed
 * `{parentId}/{leafId}`, intersected with the live parent collection so that a
 * parent deleted WITHOUT cascading its subcollection still frees its objects.
 *
 * Kept in a table rather than hardcoded in the pass for one reason: the coverage
 * guard below derives the authoritative prefix set from `storage.rules`, and a
 * prefix that is not in a table here is a prefix it cannot see.
 */
export const NESTED_SWEEPS = [
  {
    prefix: 'batch-images/',
    // Only `batches/{batchId}/observations/{observationId}` uses this group name,
    // and the pass asserts that rather than assuming it.
    collectionGroup: 'observations',
    parentCollection: 'batches',
    // The field whose PRESENCE means the leaf document claims its object. An
    // observation with no photo attached does not claim one, which is what makes
    // this pass reclaim the object a failed `setObservationImageUpload` stamp
    // leaves behind — the orphan reachable today, with no deleter involved.
    claimField: 'image',
  },
] as const;

/**
 * Storage prefixes this sweep deliberately does NOT cover, and why (issue #919).
 *
 * `SWEEPS` is a list of what IS swept, and a list like that says nothing about
 * what it omits — `batch-images/` was missing for no recorded reason and nobody
 * could tell whether that was a decision or an oversight. So the omissions are
 * now written down, and `tests/maintenance/storageSweepCoverage.test.ts` derives
 * the full prefix set from `storage.rules` and fails on any prefix that appears
 * in none of the three tables. A new prefix is a red test until somebody says
 * which one it belongs in; it can no longer be silently uncovered.
 *
 * EMPTY IS THE CORRECT STATE, and it is the state as of #968 — every prefix
 * `storage.rules` serves is now swept. This map stays because the guard needs
 * somewhere to put the next deliberate omission, not because one is expected.
 */
export const UNSWEPT: Readonly<Record<string, string>> = {};
