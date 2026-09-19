// The planning and diffing half of ../rerun-recipe-kits.ts, lifted into a module
// a test can import for the same reason `kitchenToolAccessoryMatchers.ts` and
// `pruneInstanceNamedKitchenTools.ts` state beside their own copies of this
// sentence: the script self-executes on import (reaches Firestore via
// `applicationDefault()` at module load, requires `GOOGLE_CLOUD_PROJECT` or calls
// `process.exit`), so this is the only part a test can reach without running the
// thing. docs/one-shot-scripts.md §2 owns the split.
//
// WHAT THE SCRIPT DOES (issue #1465, Phase 4). Every recipe stored before #1470
// carries kit LABELS and no link, so Salt still guesses from the words which of
// the household's things each line means — and that guessing is what fails for
// families. The fix is to ask the flow again, once, for every recipe that has a
// kit: clear `kitInferredAt` and bump `kitRequestedAt`, exactly as the
// `redoRecipeKit` callable does, and let `onRecipeWritten`'s kit branch do the
// write. Nothing here calls the model and nothing here writes a `kit` array.
//
// TWO DECISIONS LIVE HERE, and they are the two the operator has to trust:
//
//   1. WHICH RECIPES ARE IN SCOPE (`planKitRerun`) — a non-empty kit, minus the
//      ones a previous interrupted pass already did. `--since` is how the second
//      half is expressed, and it is the same resume mechanism `RecipeSchema`'s
//      `timesEstimatedAt` comment describes for the #952 backfill: an interrupted
//      run resumes instead of paying for every recipe twice. A recipe whose
//      inference FAILED carries no stamp, so it is correctly re-targeted.
//   2. WHAT CHANGED (`diffKitEntries`) — the before/after the operator reviews
//      before moving on to the next environment.
//
// THE DIFF PAIRS ENTRIES BY LABEL, and that boundary is real rather than
// incidental: a kit entry has no id, and positions move between inferences, so
// the label is the only stable key there is. Consequence, stated rather than
// rounded up: a REWORDED line ("frying pan" → "large frying pan") reads as one
// removed plus one added, not as a rename. That is the outcome the issue already
// warns about ("wording on some lines may shift, as it does with Redo kit"), and
// showing it as a pair of lines is more honest than guessing which old line a new
// one descends from. Case and inner whitespace are normalised before pairing, so
// "Frying Pan" → "frying pan" alone is not reported as a change.
//
// TWO SKIP REASONS THAT MIRROR `maybeInferKit`'s OWN GUARDS (PR #1483 review,
// should-fix 4). `onRecipeWritten`'s kit branch declines — silently, and
// permanently for this recipe until something else changes it — when the recipe
// is not cookable (`isCookable(recipe.kind)`) or has no steps. Both are checked
// here with the SAME predicate the trigger uses, imported rather than
// re-derived, so a recipe this script would otherwise target but the trigger
// would always decline is named as a skip instead of burning the full
// stamp-wait timeout on an inference that structurally cannot happen. A recipe
// reaching this state has a stale kit left over from before an edit changed its
// `kind` or emptied its steps.

import { isCookable } from '@salt/domain';
import type { RecipeKind } from '@salt/domain';

/** A kit entry's link to one of the household's things, as stored on the recipe. */
export interface KitLink {
  readonly itemId: string;
  readonly accessoryId: string | null;
}

/** The two fields of a kit entry this script reads. */
export interface KitEntrySnapshot {
  readonly label: string;
  readonly equipment: KitLink | null;
}

/** One recipe, as read before the re-run. */
export interface RecipeKitSnapshot {
  readonly id: string;
  readonly title: string;
  readonly kit: readonly KitEntrySnapshot[];
  /** The stamp as read, or `null` when the recipe has never been inferred. */
  readonly kitInferredAt: number | null;
  /** Gates `isCookable` below — the same field `maybeInferKit` reads. */
  readonly kind: RecipeKind;
  /** `recipe.steps.length` — the same count `maybeInferKit` reads. */
  readonly stepCount: number;
}

/** Why a recipe is not being re-run. */
export type KitRerunSkipReason = 'empty-kit' | 'not-cookable' | 'no-steps' | 'already-rerun';

/** One recipe's place in the plan. */
export interface KitRerunStep {
  readonly id: string;
  readonly title: string;
  readonly before: readonly KitEntrySnapshot[];
  /** `null` when this recipe is a target; otherwise why it is being skipped. */
  readonly skip: KitRerunSkipReason | null;
}

/**
 * Decide which recipes the re-run touches.
 *
 * @param recipes Every recipe read from the collection, in whatever order.
 * @param since Epoch ms, or `null` for a first pass. A recipe already stamped at
 *   or after this instant was inferred by an earlier pass of this same run and is
 *   skipped — which is what makes an interrupted run resumable without paying for
 *   every recipe twice.
 * @returns One step per input recipe, in input order, each either a target
 *   (`skip: null`) or carrying its reason. Nothing is dropped: the caller prints
 *   the skipped ones too, so "66 read, 58 targeted" is visible rather than left
 *   to be inferred from a count that does not add up.
 */
export function planKitRerun(
  recipes: readonly RecipeKitSnapshot[],
  since: number | null,
): readonly KitRerunStep[] {
  return recipes.map((recipe) => {
    const base = { id: recipe.id, title: recipe.title, before: recipe.kit };
    // An empty kit is not a gap to fill — the flow was asked and answered
    // "nothing". Re-asking buys an AI call per recipe for an answer that is
    // already right, and the issue scopes the re-run to a non-empty kit.
    if (recipe.kit.length === 0) return { ...base, skip: 'empty-kit' as const };
    // The trigger's own two guards (`maybeInferKit`), checked here so a recipe
    // it will always decline is never targeted — see this module's header.
    if (!isCookable(recipe.kind)) return { ...base, skip: 'not-cookable' as const };
    if (recipe.stepCount === 0) return { ...base, skip: 'no-steps' as const };
    if (since !== null && recipe.kitInferredAt !== null && recipe.kitInferredAt >= since) {
      return { ...base, skip: 'already-rerun' as const };
    }
    return { ...base, skip: null };
  });
}

/** A label present on both sides whose link moved. */
export interface KitLinkChange {
  readonly label: string;
  readonly before: KitLink | null;
  readonly after: KitLink | null;
}

/** What one recipe's kit gained, lost and re-pointed at. */
export interface KitDiff {
  /** Entries whose label appears more times after than before. */
  readonly added: readonly KitEntrySnapshot[];
  /** Entries whose label appears more times before than after. */
  readonly removed: readonly KitEntrySnapshot[];
  /** Same label on both sides, different link — the point of the whole re-run. */
  readonly relinked: readonly KitLinkChange[];
  /** How many entries came back with the same label and the same link. */
  readonly unchanged: number;
  /** Whether anything at all moved. */
  readonly changed: boolean;
}

function pairingKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sameLink(a: KitLink | null, b: KitLink | null): boolean {
  if (a === null || b === null) return a === b;
  return a.itemId === b.itemId && a.accessoryId === b.accessoryId;
}

function byPairingKey(
  entries: readonly KitEntrySnapshot[],
): ReadonlyMap<string, readonly KitEntrySnapshot[]> {
  const grouped = new Map<string, KitEntrySnapshot[]>();
  for (const entry of entries) {
    const key = pairingKey(entry.label);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(entry);
    else grouped.set(key, [entry]);
  }
  return grouped;
}

/**
 * Compare one recipe's kit before and after the re-run.
 *
 * Entries are paired by normalised label (see this module's header for why that
 * is the only key available, and what it costs). Two entries sharing a label are
 * paired in document order, so a duplicate label on one side alone reports as
 * exactly one addition or removal rather than as a re-link of the other.
 */
export function diffKitEntries(
  before: readonly KitEntrySnapshot[],
  after: readonly KitEntrySnapshot[],
): KitDiff {
  const beforeByKey = byPairingKey(before);
  const afterByKey = byPairingKey(after);
  const added: KitEntrySnapshot[] = [];
  const removed: KitEntrySnapshot[] = [];
  const relinked: KitLinkChange[] = [];
  let unchanged = 0;

  for (const [key, afterEntries] of afterByKey) {
    const beforeEntries = beforeByKey.get(key) ?? [];
    const paired = Math.min(beforeEntries.length, afterEntries.length);
    for (let i = 0; i < paired; i += 1) {
      const was = beforeEntries[i]!;
      const now = afterEntries[i]!;
      if (sameLink(was.equipment, now.equipment)) unchanged += 1;
      else relinked.push({ label: now.label, before: was.equipment, after: now.equipment });
    }
    added.push(...afterEntries.slice(paired));
  }

  for (const [key, beforeEntries] of beforeByKey) {
    const afterCount = (afterByKey.get(key) ?? []).length;
    removed.push(...beforeEntries.slice(afterCount));
  }

  return {
    added,
    removed,
    relinked,
    unchanged,
    changed: added.length > 0 || removed.length > 0 || relinked.length > 0,
  };
}
