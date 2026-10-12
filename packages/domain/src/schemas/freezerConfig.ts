import { z } from 'zod';

// The household's freezers and their shelves (issue #1682, epic #795) — ONE
// family-shared document, written whole with `setDoc` like
// `equipmentManifest/current`. The stock that sits on these shelves is a
// separate collection and a later child of #795; nothing here knows about it.
export const FREEZER_CONFIG_COLLECTION = 'freezerConfig';
export const FREEZER_CONFIG_DOC_ID = 'current';

// `id` is OPAQUE and minted when the freezer is added — never derived from the
// name. Stock will point at a freezer by this id, so a rename must leave it alone
// (`renameFreezer` changes `name` only).
//
// The read schema checks SHAPE only. A blank name, a case-insensitive duplicate
// or a repeated shelf label is refused by the domain commands that write this
// document, not here: a read that rejected them would take the household's whole
// freezer setup off the page over one bad label, where the commands simply never
// write one.
//
// `shelves` are labels in the order given ("A", "B", "C", "D"); a freezer may
// have none.
//
// `suppliers` (issue #1684) are the places stock has been bought from, remembered
// when an item is saved and NOT dropped when the last item from there is gone
// (Manage freezers removes one by hand), so the item sheet can offer it again.
// It rides on this document's full-document LWW: a save from a device that had not
// yet seen another's append drops that entry, and typing the place again puts it
// back (docs/data-model.md → `freezerItems/{number}`). A document written before
// the field existed reads as `[]`.
//
// `highestNumber` (issue #1693) is the highest bag number an add has used,
// suggested or typed, so `nextBagNumber` counts on past a bag that was removed
// instead of offering its number again. No command but `recordBagNumber` changes
// it, and that one only raises it — a typo of 9999 that is saved moves every later
// suggestion past it. It rides on this document's full-document LWW too: a device
// holding a stale copy (one that was offline) can save a LOWER mark over a higher
// one. A number still on a bag is not offered again even then, because
// `nextBagNumber` also takes the highest item; a top number both handed out and
// removed inside that window can be. A document written before the field existed
// reads as `0`.
//
// The reverse direction holds for both: saving an item that remembers a new place,
// and adding one above the mark — every add at the suggested number — writes this
// whole document, so a device with a stale copy reverts another device's freezer
// or shelf change (docs/data-model.md → `freezerConfig.highestNumber`).
export const FreezerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  shelves: z.array(z.string()).default([]),
});

export const FreezerConfigSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string(),
  freezers: z.array(FreezerSchema).default([]),
  suppliers: z.array(z.string()).default([]),
  highestNumber: z.number().int().nonnegative().default(0),
});

export type FreezerDoc = z.infer<typeof FreezerSchema>;
export type FreezerConfigDoc = z.infer<typeof FreezerConfigSchema>;
