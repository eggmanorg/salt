import { isCanonIconRenderable } from '../../canon/index.js';
import type { EquipmentItem } from '../entities/EquipmentItem.js';
import type { EquipmentIconDoc } from '../../schemas/equipmentIcon.js';

// Which of the household's records have no picture at all? (Issue #1458,
// Phase 1.)
//
// The gap this answers is a VISIBILITY one, not a rendering one. Production held
// 22 records and 20 drawings on 2026-09-18, and both undrawn records rendered as
// the same pale placeholder tile a record whose art is still generating renders —
// so the only way to find one was to go looking. Nothing counted them, and
// nothing said so.
//
// ─── What counts as a gap, and what deliberately does not ───────────────────
//
//   • NOTHING DRAWN — no icon document, or one whose `thumbnail` is `null`. This
//     is the ordinary case: `onEquipmentManifestWritten` authors a description
//     the moment a record appears and stops there, because #877 puts a person
//     between the description and the drawing. A record sits here from the
//     moment it is added until somebody presses Draw.
//   • HIDDEN IS NOT A GAP. `"hidden"` is the user saying "no picture on this
//     row", which is an answer, not an omission. Counting it would make the
//     badge un-clearable by design.
//   • A BORROWED PICTURE IS NOT A GAP EITHER (issue #1465, Phase 3). A record can
//     be POINTED AT a drawing that already exists rather than given one of its
//     own, and a row that shows a picture is not missing one. "Undrawn" is
//     therefore the wrong word for the whole predicate and the right word for
//     half of it — the name is the deliverable's, and this paragraph is what it
//     means.
//   • ENTRIES ARE NOT COUNTED. An accessory or a family member may carry its own
//     drawing, but nothing is ever drawn OR described for one automatically
//     (docs/canon-icons.md § "An entry may have a picture of its own"): there are
//     ~140 of them and most are never named in a recipe. Counting the undrawn
//     ones would report ~140 gaps on day one and never fall, which is a badge
//     that says nothing. An entry's picture is asked for where it is wanted, and
//     its absence is not a backlog.
//
// ─── The boundary this claim actually has ───────────────────────────────────
// A borrowed picture is read as the PRESENCE OF A REFERENCE, never resolved to
// the drawing it points at. Resolving one here would put a second copy of the
// app's picture order inside the pure domain, where it could answer differently
// from the code that renders — the defect round-1 review on #1482 called
// blocking.
//
// So a record whose borrow points at something that is not (or is no longer)
// renderable — a source drawing since hidden, a source record since removed from
// the equipment list — counts as having a picture here and is not reported. A
// dangling reference is valid on read (`borrowedPictureField` in the manifest
// schema says why), so this is a state the data can hold, not a hypothetical.
// The under-report is by however many records point at what got hidden or
// removed, not one row. That is the safe direction for a badge:
// the error is an omission, and a record this query does report has nothing
// drawn, nothing borrowed and is not hidden. `undrawnEquipment.test.ts` pins
// each of those — the `'deleted-record'` case, the now-hidden source, and every
// borrower of one hidden source going unreported at once.
//
// WHAT A BORROWED PICTURE RESOLVES TO ON SCREEN — which level answers when
// another has nothing, and when a row goes blank — is deliberately not stated
// here. Three successive attempts to restate it in this header each shipped a
// different false claim (#1516, #1544, #1548). Read it from the code that
// renders: `linkedIcon` in `apps/web-pwa/src/lib/kitIcons.ts` for kit
// surfaces, and `pictureFor` in
// `apps/web-pwa/src/routes/equipment/EquipmentListPage.svelte` for the
// equipment list's own tiles.
//
// PURE, and takes the two plain structures a caller already holds. The icons
// arrive as a Map rather than an array because an `EquipmentIconDoc` does not
// carry its own id — the id is the key, and here it is the record's.

/**
 * The records with no picture: nothing drawn for them, nothing borrowed, and not
 * deliberately hidden.
 *
 * Input order is preserved, so a caller that sorted its manifest keeps its sort.
 *
 * @param items The manifest's records.
 * @param icons `equipmentIcons` by document id. Only the item-level ids are read
 *   — see the header on why an entry's missing drawing is not a gap.
 */
export function undrawnEquipment(
  items: readonly EquipmentItem[],
  icons: ReadonlyMap<string, EquipmentIconDoc>,
): EquipmentItem[] {
  return items.filter((item) => {
    const thumbnail = icons.get(item.id)?.thumbnail ?? null;
    if (isCanonIconRenderable(thumbnail)) return false;
    // The sentinel, caught by what it is NOT: "hidden" and "not drawn yet" are
    // both unrenderable above, and only one of them is a gap. Anything that is
    // neither null nor renderable is a value this query has no opinion on, and
    // treating it as a gap would put a row on the badge that pressing Draw
    // might not clear.
    if (thumbnail !== null) return false;
    return !item.borrowedPicture;
  });
}
