// The two view predicates `scripts/board.mjs check` decides on, extracted so
// they can be tested — `board.mjs` runs its CLI on import, so nothing in it is
// importable, and the grouping quirk below is exactly the part that is easy to
// get silently wrong.

/**
 * The fields a view is grouped by, whichever menu GitHub put that setting in.
 *
 * A **table** view has `Group by` and reports `groupByFields`. A **board** view
 * has no such menu because its columns ARE the grouping, and that setting —
 * called `Column field` in the UI — arrives as `verticalGroupByFields` with
 * `groupByFields` empty. Read only the one matching the layout: reading the
 * wrong one answers "this view is ungrouped" about every board there is.
 */
export const viewGroupFields = (view) =>
  (view?.layout === 'BOARD_LAYOUT' ? view?.verticalGroupByFields : view?.groupByFields)?.nodes?.map(
    (f) => f.name,
  ) ?? [];

/**
 * "A view grouped by `Queue` carries no sort" — the other half of having no rank
 * field. Position within a band IS the sequence, `check`'s promotion rule reads
 * it, and a sort renders a different order in its place. Returns the failure
 * text, or `null` where the sort is fine.
 *
 * THE RULE IS THAT NARROW ON PURPOSE, and it used to be "no view at all".
 * Nothing writes position for a view grouped by anything else to hide: the
 * `Workflow` board groups by `Status`, whose columns an issue reaches by EVENT
 * rather than by placement — every transition is automated bar the one decision,
 * Triage → Todo — so its `Closed DESC, Created ASC` sort is what makes Triage
 * read oldest-first and the shipped columns read in the order they closed.
 * Flagging it was the check being wrong, not the board.
 *
 * What a sort actually costs, stated rather than overclaimed: it disables
 * drag-to-REORDER inside a group. Dragging a card BETWEEN columns still works
 * and still writes the field — measured on the `Workflow` board, against an
 * earlier version of this message that claimed otherwise.
 */
export function forbiddenSortMessage(view) {
  const sorts = (view?.sortByFields?.nodes ?? []).map((s) => `${s.field.name} ${s.direction}`);
  if (sorts.length === 0) return null;
  // Resolved by name and case-insensitively, the way every other name lookup in
  // `board.mjs` is.
  if (!viewGroupFields(view).some((name) => name.toLowerCase() === 'queue')) return null;
  return `view ${view.number} "${view.name}" groups by Queue and is sorted by ${sorts.join(', ')} — that renders a different order from the one triage wrote, and stops you reordering inside a band`;
}
