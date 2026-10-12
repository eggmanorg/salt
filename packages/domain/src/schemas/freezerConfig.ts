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
export const FreezerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  shelves: z.array(z.string()).default([]),
});

export const FreezerConfigSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string(),
  freezers: z.array(FreezerSchema).default([]),
});

export type FreezerDoc = z.infer<typeof FreezerSchema>;
export type FreezerConfigDoc = z.infer<typeof FreezerConfigSchema>;
