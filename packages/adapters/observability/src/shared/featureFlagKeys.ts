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

/**
 * The PostHog flag gating the chef-triggered recipe save (issue #1480) — asking
 * the chef to save a recipe instead of tapping the floppy-disc icon.
 *
 * TWO HALVES FROM THE START, unlike `LIBRARY_FLAG_KEY`, which only grew a server
 * half once the chef could read a page. The server half decides whether the
 * `saveRecipe` tool goes into the `tools:` array at all — so a caller outside the
 * flag gets a prompt byte for byte identical to today's and a chef that cannot
 * recognise the ask. The browser half decides whether a recorded intent is ever
 * acted on. The server half is what actually withholds the feature; the browser
 * half is what stops an intent recorded during a deploy window, or by a browser
 * whose flags disagree, from running a save nobody asked this bundle for.
 *
 * The VALUE is what PostHog knows — changing the string here changes who sees the
 * feature, in the browser and in the chef's tool surface at once.
 */
export const CHAT_SAVE_FLAG_KEY = 'chat-save' as const;
