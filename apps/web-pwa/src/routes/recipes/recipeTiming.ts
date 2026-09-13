import { recipePhaseTotals, type Recipe } from '@salt/domain';
import { formatMinutes } from '../../lib/durationDisplay.js';

// "How long does this take?", asked by a surface that has to show ONE number
// (issue #1122).
//
// Five places ask it — the recipe page's component rows, the edit page's, the
// recipe list's chip, the list's Quickest sort and the meal cook plan's per-dish
// line — and #1122 exists because they were each answering it from a different
// stored field. One function, so they cannot drift back apart (#1055).
//
// Issue #1213 took the last of those stored fields away, and with it the
// `phasesEnabled` argument and every per-surface fallback. What is left is the one
// thing that must not vary: the phase strip answers, or nothing does. The WORDING
// still belongs to each surface, because it honestly differs — the cook plan says
// "No timing yet" where the list says nothing at all — and `componentTimeLabel`
// below is the one shared wording, because the recipe page's component rows and
// the edit page's are the same row on two screens (issue #1212, #1208's third
// bullet) and a rule stated twice is a rule that can disagree with itself.

/**
 * A recipe's elapsed time from its phase strip, or `null` when it has no strip.
 *
 * `null` is a real answer and every caller must draw something for it: after
 * issue #1213 there is no old field to fall back to, so a recipe with no strip has
 * no stated timing at all. Through the normal authoring paths only placeholders
 * and specials reach that state — neither is cookable, and neither ever showed a
 * timing — but that is the claim's boundary, not a property of the type: a recipe
 * starts life with an empty strip, and the editor can remove its last phase.
 *
 * `hasPhases` rather than `elapsedMinutes > 0`: a strip a cook has zeroed by hand
 * is a stated timing of nothing, which is not the same as an unknown.
 */
export function phaseMinutes(recipe: Recipe): number | null {
  const totals = recipePhaseTotals(recipe.metadata.phases);
  return totals.hasPhases ? totals.elapsedMinutes : null;
}

/**
 * A component row's time, on both screens that draw one: the phase sum, or `null`
 * when the component has no strip, which is the row showing no time at all.
 */
export function componentTimeLabel(component: Recipe): string | null {
  const minutes = phaseMinutes(component);
  return minutes === null ? null : formatMinutes(minutes);
}
