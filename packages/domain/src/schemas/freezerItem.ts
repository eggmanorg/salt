import { z } from 'zod';

// One entry in a freezer (issue #1684, epic #795) — `freezerItems/{number}`,
// family-shared. Adding, editing and moving write it whole with `setDoc`; taking
// packs out is the one partial write, an `increment` on `amount` and a new
// `updatedAt` (`takeFreezerItemAmount` in firebase-sync).
//
// The document id IS the bag number, zero-padded (`freezerItems/047`), so moving
// an item to another shelf or freezer rewrites its `freezerId`/`shelf` and never
// its id: the number is written on the bag. The number is checked only against
// what the adding device holds, so two devices adding the SAME number before
// either has seen the other's — typically one of them offline — both write, and
// the later write replaces the earlier item (docs/data-model.md →
// `freezerItems/{number}`).
export const FREEZER_ITEMS_COLLECTION = 'freezerItems';

/** The document id for bag number `n`: `47` → `"047"`. A fourth digit is kept, not cut. */
export function freezerItemDocId(n: number): string {
  return String(n).padStart(3, '0');
}

// The read schema checks SHAPE, like `FreezerConfigSchema` beside it: a blank
// name or a place the setup no longer has is a matter for the domain commands
// that write an item and for `itemsByShelf` that files it, not a reason to drop
// a real bag of food off the page.
//
// - `freezerId` is a freezer's opaque id from `freezerConfig/current`. It may name
//   a freezer since removed; the item then shows under Not placed.
// - `shelf` is one of that freezer's shelf labels, or `null`: the only place in a
//   freezer set up with no shelves, and "no shelf yet" in one that has them.
// - `amount` is a whole number of packs with NO lower bound: two devices taking
//   the last pack at once land on -1, and `displayAmount` clamps it to 0.
// - `canonId`, `recipeId` and `purchasedFrom` are optional links, `null` when
//   absent. Each is offered by the item sheet and never required.
// - `packWeight` is what ONE pack under this number weighs (issue #1712) — on the
//   entry, not per pack, so every pack under a number shares it by shape. It is a
//   property of the pack, never a measure of what is left: `amount` stays whole
//   packs. `addFreezerItem` and `editFreezerItem` refuse a missing or non-positive
//   one, so every entry added or edited since #1712 carries it; an entry written
//   before reads `null` here until someone edits it, and the read takes it so
//   rather than dropping the bag. The read checks shape only.
export const PackWeightSchema = z.object({
  amount: z.number(),
  unit: z.enum(['g', 'ml']),
});

export type PackWeightDoc = z.infer<typeof PackWeightSchema>;

export const FreezerItemSchema = z.object({
  schemaVersion: z.literal(1),
  number: z.number().int().positive(),
  name: z.string(),
  freezerId: z.string(),
  shelf: z.string().nullable(),
  amount: z.number().int(),
  canonId: z.string().nullable(),
  recipeId: z.string().nullable(),
  purchasedFrom: z.string().nullable(),
  packWeight: PackWeightSchema.nullable().default(null),
  addedAt: z.string(),
  updatedAt: z.string(),
});

export type FreezerItemDoc = z.infer<typeof FreezerItemSchema>;
