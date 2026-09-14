// PostHog feature-flag keys, shared across both runtimes (issue #1054).
//
// A flag key is an identifier owned by an external analytics system, and a gate
// is only a gate while both halves spell it the same way. The bread gate is
// evaluated in the browser (`web-pwa`'s `featureGate.ts`) and again on the
// server (`onBatchWritten`, deciding whose reminders to enqueue) — two apps that
// cannot import each other, so until now a rename in PostHog had to be applied
// twice by hand and a missed one would read as "off" and look exactly like a
// working gate.
//
// Same reason `matchOutcomeEvent.ts` exists beside this file: one external
// system's name, two emitters, and no way for the compiler to see both. Runtime-
// neutral, so it is re-exported from `src/index.ts` and `src/server/index.ts`
// alike.

/**
 * The PostHog flag gating everything epic #778 is still building.
 *
 * The VALUE is what PostHog knows. Live targeting, cohorts and the audiences
 * already frozen into `batchStage` task payloads all key off it, so changing the
 * string here changes who sees the feature — it is not a local rename.
 */
export const BREAD_FLAG_KEY = 'bread' as const;

/**
 * The PostHog flag gating the library — the kitchen facts that are not recipes
 * (epic #1372).
 *
 * MOVED HERE BY #1377, the phase that gave the chef tools over those pages. Until
 * then the library was browser-only and the key was a literal in `featureGate.ts`;
 * the moment a Cloud Function can read a page and answer out of it the gate has a
 * server half, and a page written under the flag would otherwise reach a household
 * member the feature is hidden from, through an answer no browser gate can reach
 * (issue #831). Same reasoning, same file, same shape as `BREAD_FLAG_KEY`.
 *
 * The VALUE is what PostHog knows — changing the string here changes who sees the
 * feature, in the browser and in the chef's tool surface at once.
 */
export const LIBRARY_FLAG_KEY = 'library' as const;
