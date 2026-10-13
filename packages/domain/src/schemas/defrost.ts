import { z } from 'zod';
import { freezerItemDocId } from './freezerItem.js';

// Something promised out of the freezer (issue #1685, epic #795) —
// `defrosts/{paddedNumber}_{recipeId | 'manual'}`, family-shared. Written when a
// shopping row is used from the freezer instead of bought; deleted when somebody
// taps Got it out in Kitchen. The app never expires one, however long ago its
// night was.
//
// `forDate` is the night it is for, worked out ONCE when the pack is used: the
// next night its recipe is planned, as the planner stood then (#1696). Nothing
// re-dates it on read, so a meal moved or planned again later leaves the item on
// its original night; only another commit to the same document changes it.
//
// `name`, `location` and `recipeTitle` are snapshots taken at commit time: the
// freezer entry may be gone by the time anybody reads this (the last pack removes
// it), and Kitchen and the 09:00 push name the meal without a recipe read.
export const DEFROSTS_COLLECTION = 'defrosts';

/**
 * The document id: the bag number padded as `freezerItems` pads it, then the
 * recipe it serves or `manual`. `47, 'abc123'` → `"047_abc123"`; `12, null` →
 * `"012_manual"`. Deterministic, so committing the same bag to the same recipe
 * twice lands on one document — and `commitDefrost` sums the packs.
 */
export function defrostDocId(number: number, recipeId: string | null): string {
  return `${freezerItemDocId(number)}_${recipeId ?? 'manual'}`;
}

export const DefrostSchema = z.object({
  schemaVersion: z.literal(1),
  freezerNumber: z.number().int().positive(),
  name: z.string(),
  // Where the bag was when it was committed: `Garage · shelf B`, or the freezer's
  // name alone for a freezer with no shelves.
  location: z.string(),
  // `null` for a row added by hand — nothing says which meal it is for.
  recipeId: z.string().nullable(),
  recipeTitle: z.string().nullable(),
  // Whole packs: freezer stock is counted in packs only (#1684), so no unit.
  amount: z.number().int().positive(),
  committedAt: z.string(),
  // `YYYY-MM-DD` of the planned night, fixed at commit. `null` for no night: a
  // hand-added row, a "make it yourself" producer the planner does not hold, a
  // recipe not planned in the weeks Kitchen held at that moment — and every
  // document written before #1696, which has no field and reads as `null`.
  forDate: z.string().nullable().default(null),
});

export type DefrostDoc = z.infer<typeof DefrostSchema>;
