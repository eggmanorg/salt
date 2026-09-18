// The plan-building half of ../fix-kitchen-tool-accessory-matchers.ts, lifted
// into a module a test can import for the same reason
// pruneInstanceNamedKitchenTools.ts states beside its own copy of this
// sentence: the script self-executes on import (reaches Firestore via
// `applicationDefault()` at module load, requires `GOOGLE_CLOUD_PROJECT` or
// calls `process.exit`), so this is the only part a test can reach without
// running the thing.
//
// WHAT THIS FIXES (issue #1460, folded into #1465). `kitchenToolForKitLabel`
// refuses a single-word winning phrase for a kit label that exactly names one
// of the household's manifest accessories — see that function's header for the
// full rule. Two of production's live `kitchenTools` documents were seeded
// before the rule existed and only carry their bare single-word label, so the
// household's own "Egg Whisk" and "Glass Mixing Bowl" accessories lost their
// picture the moment the rule shipped. The fix is the same curation act
// `kitchen-tool-vocabulary.mjs` already made for the SEED table's `whisk` and
// `ladle` rows (see the comments beside them): add the multi-word phrase that
// names the accessory as an extra matcher, so the winning phrase is more than
// one word and condition 2 passes.
//
// THIS IS A REMEDIATION, NOT A RE-SEED. `seed-kitchen-tools.mjs` `.set()`s
// whole documents and regenerates every drawing — using it here would
// overwrite `label`, `thumbnail`, `iconRequestedAt`, `schemaVersion`,
// `createdAt` and `updatedAt` on two documents for the sake of one field each.
// This module's caller does a field-masked `.update({ matchers })` instead,
// and a future re-seed of `kitchenTools` supersedes this file entirely — once
// the seed table's own curated matchers (`whisk`'s `egg whisk`, `ladle`'s
// `soup ladle`) are live on every environment, these two targets are redundant
// and this script can be deleted.

/** One document to add a matcher to, and the matcher to add. */
export interface MatcherFixup {
  readonly id: string;
  readonly matcher: string;
}

// Exactly the two targets #1465's rule regressed against production's real
// manifest vocabulary — no more, no fewer. A third label failing the same rule
// is a new curation decision, not an extension of this list.
export const KITCHEN_TOOL_MATCHER_FIXUPS: readonly MatcherFixup[] = [
  { id: 'whisk', matcher: 'egg whisk' },
  { id: 'bowl', matcher: 'mixing bowl' },
];

/** The outcome of planning one fixup against whatever Firestore currently holds. */
export interface MatcherFixupStep extends MatcherFixup {
  /** Whether `kitchenTools/{id}` exists at all. A missing doc is never created. */
  readonly found: boolean;
  /** `matchers` as read, or `null` when the document does not exist. */
  readonly before: readonly string[] | null;
  /** `matchers` after the union, or `null` when the document does not exist. */
  readonly after: readonly string[] | null;
  /** The matcher was already present — re-running this step is a no-op. */
  readonly alreadyPresent: boolean;
  /** Whether applying this step would issue a Firestore write. */
  readonly needsWrite: boolean;
}

/**
 * Plan the fixups against a snapshot of what each target document currently
 * holds. `existing` maps a `kitchenTools` doc id to its live `matchers` array,
 * or omits the id entirely when the document does not exist — the caller reads
 * Firestore, this function makes every other decision so it can be tested
 * without one.
 *
 * Additive and idempotent by construction: a matcher already present is left
 * alone rather than re-appended, so re-running the plan (and the script that
 * applies it) over an already-fixed document reports nothing to write.
 */
export function planKitchenToolMatcherFixups(
  fixups: readonly MatcherFixup[],
  existing: ReadonlyMap<string, readonly string[]>,
): readonly MatcherFixupStep[] {
  return fixups.map((fixup) => {
    const before = existing.get(fixup.id);
    if (before === undefined) {
      return {
        ...fixup,
        found: false,
        before: null,
        after: null,
        alreadyPresent: false,
        needsWrite: false,
      };
    }
    const alreadyPresent = before.includes(fixup.matcher);
    const after = alreadyPresent ? before : [...before, fixup.matcher];
    return { ...fixup, found: true, before, after, alreadyPresent, needsWrite: !alreadyPresent };
  });
}
