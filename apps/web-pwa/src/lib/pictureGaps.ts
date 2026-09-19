import { undrawnEquipment, unresolvedKitLabels } from '@salt/domain';
import type { EquipmentItem, KitLabelSource } from '@salt/domain';
import type { EquipmentIconDoc, KitchenToolDoc } from '@salt/domain/schemas';

// How many open picture gaps is somebody sitting on? (Issue #1458, Phase 1.)
//
// The number on the Admin nav badge, and the reason this is a function rather
// than an expression inside `App.svelte`: the badge is the only place in the app
// where two unrelated backlogs are added together, and the arithmetic is the
// thing worth a test. `App.svelte` itself is not unit-testable in any useful way.
//
// TWO KINDS OF GAP, ONE NUMBER, because they are one job:
//
//   • a RECORD of the household's own kit with no picture — `undrawnEquipment`;
//   • a NAME our own content uses that the drawn vocabulary cannot answer —
//     `unresolvedKitLabels`, which is already what `/admin/kitchen-tools` shows.
//
// It sums two counts rather than measuring one merged list because the two are
// closed by different acts (press Draw; write a vocabulary row) and neither can
// ever name the other — `unresolvedKitLabels` excludes a label that resolves to a
// record, so nothing is counted twice.
//
// ─── What this number does NOT include, and why ─────────────────────────────
// GUIDED PLANS. `unresolvedKitLabels` also reads the two free-text container
// fields on a guided plan, and `/admin/kitchen-tools` hands it those — but it
// gets them from `loadAllGuidedPlansForCuration`, a whole-collection read it
// performs once on arrival. The badge is computed on every admin's boot, from
// stores the app already subscribes to, and buying a collection read there to
// find the labels that appear in a plan and in no recipe is not worth it.
//
// The consequence is stated rather than hidden: THE BADGE IS A FLOOR, NOT A
// TOTAL. A gap only a guided plan's container field names is real, is listed on
// the admin page, and is not in this count. Every gap this counts is a real one,
// and the count falls to zero exactly when the recipe-side and equipment-side
// backlogs are empty. `pictureGaps.test.ts` pins the arithmetic, including that
// a plan-only label does not raise it.

/**
 * The Admin badge's picture-gap summand.
 *
 * @param items The equipment manifest's records.
 * @param icons `equipmentIcons` by document id.
 * @param recipes Every recipe, for the kit labels nothing draws.
 * @param tools The curated kitchen-tool vocabulary.
 */
export function pictureGapCount(
  items: readonly EquipmentItem[],
  icons: ReadonlyMap<string, EquipmentIconDoc>,
  recipes: readonly KitLabelSource[],
  tools: readonly KitchenToolDoc[],
): number {
  return (
    undrawnEquipment(items, icons).length + unresolvedKitLabels(recipes, [], tools, items).length
  );
}
