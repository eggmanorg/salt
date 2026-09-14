import { z } from 'zod';

// Canonical Firestore location of the single shared equipment manifest. Both the
// client store (firebase-sync) and the server-side chef flow (cloud-functions)
// read this doc; sharing the identifiers here is the one source of truth so the
// two sides can't drift (which silently broke the chef's equipment context once).
export const EQUIPMENT_MANIFEST_COLLECTION = 'equipmentManifest';
export const EQUIPMENT_MANIFEST_DOC_ID = 'current';

export const AccessorySchema = z.object({
  id: z.string(),
  name: z.string(),
  owned: z.boolean(),
  included: z.boolean(),
  // What the household knows about THIS ONE THING and no other — "the 28cm cast
  // iron is the only one that goes in the oven", "the XL dough hook needs the
  // upgraded firmware" (issue #1373).
  //
  // NEVER AMBIENT. No note, here or on the item, is rendered into any AI prompt;
  // the chef reaches one only by looking a record up with its tool. That is the
  // whole point — a note is what refines a choice the chef is already weighing,
  // and there are enough of them across twelve pans to double the prompt if they
  // rode along on every call. A standing fact that must reach the chef whether or
  // not it stops to look is a `rules` entry on the item, not a note.
  //
  // `.default('')` for the same reason `environment` defaults below: every
  // accessory already written has no `note` key, and absence means "nothing said
  // about this one", not a parse failure that takes the whole manifest down.
  note: z.string().default(''),
});

// ─── A place: equipment that holds a temperature (issue #1281) ────────────────
//
// THE LINE THIS DRAWS, and it is deliberately narrow: STORE THE NUMBERS, DESCRIBE
// THE CONTRAPTION IN PROSE. Range, humidity capability, control mode and standing
// setpoint are fields, because a batch freezes a setpoint as a number and the UI
// renders a range — re-parsing those back out of a sentence would be a
// type-laundering site on a safety-adjacent axis. WHAT THE THING IS BUILT FROM
// ("polystyrene box with a seedling heat mat in the base") stays in `rules`,
// where it is only ever read by a prompt.
//
// This supersedes the standing decision that equipment capabilities are not
// stored (see the header of `apps/cloud-functions/src/flows/equipmentContext.ts`).
// That reasoning assumed commercial products a pro model already knows. These
// chambers are home-made, and a chamber's current setpoint is a fact about this
// household this month that no product knowledge could ever supply.
//
// Most equipment is not a place. `environment` is null for a knife block.

// Whether a BATCH may dial this place in.
//   - `dedicated` — it holds one job at a time (dough proofer, fermentation
//     chamber, Anova oven), so the batch sets it and `standing` is meaningless.
//   - `shared`    — it holds several things at different stages (the curing
//     chamber), so the setting belongs to the chamber and a batch only RECORDS
//     what is there. `standing` is that setting.
// Not a property of the hardware: a curing chamber is perfectly settable, it is
// just occupied by other things.
export const EquipmentControlSchema = z.enum(['shared', 'dedicated']);

// How closely the place holds a humidity, which is the difference between the
// Anova's steam injection and a wine fridge with a reptile fogger in it.
export const EquipmentHumidityPrecisionSchema = z.enum(['approximate', 'controlled']);

export const EquipmentHumiditySchema = z.object({
  precision: EquipmentHumidityPrecisionSchema,
  minPercent: z.number().min(0).max(100),
  maxPercent: z.number().min(0).max(100),
});

// The setting a SHARED place is standing at. A batch snapshots it and never
// writes it.
export const EquipmentStandingSettingSchema = z.object({
  celsius: z.number(),
  relativeHumidityPercent: z.number().min(0).max(100).nullable().default(null),
});

export const EquipmentEnvironmentSchema = z.object({
  control: EquipmentControlSchema,
  // The range the place actually REACHES — not what a stage wants of it.
  minCelsius: z.number(),
  maxCelsius: z.number(),
  // `null` = it has no opinion about humidity at all, which is most kit.
  humidity: EquipmentHumiditySchema.nullable().default(null),
  // NO `.refine` couples this to `control`, and that is deliberate: the manifest
  // is ONE document (`equipmentManifest/current`), so a refine failing on one bad
  // item takes down the WHOLE equipment list — the same reasoning stated at
  // `process.ts` for why stages carry no refine either (CLAUDE.md rule 12).
  //
  // THE CLAIM AND ITS BOUNDARY: "a dedicated place carries no standing setpoint"
  // is enforced by the write path (`setEquipmentEnvironment`) and by the UI, and
  // pinned by unit tests on that command. It is NOT enforced on read: a document
  // hand-written into Firestore with `control: 'dedicated'` and a `standing` will
  // parse. Readers treat `standing` as meaningful only when `control` is
  // `'shared'` rather than trusting it to be absent.
  standing: EquipmentStandingSettingSchema.nullable().default(null),
});

// ─── Equipment, or a family of kit (issue #1373) ─────────────────────────────
//
// A record either IS one object with accessories under it (the Magimix and its
// blades) or STANDS FOR a set of similar things (twelve frying pans). The list
// underneath is the same list either way — same field, same commands, same
// editor.
//
// WORDS ONLY, and this is the whole licence. `kind` picks the heading on the
// edit page and the row label in the rendered prompt (`accessories:` against
// `contains:`), and the owned tick is not shown for a family. It must never gate
// capability, availability or existence — the same discipline CLAUDE.md sets for
// `recipes.kind`, where comparison is permitted "only to pick words, pictures or
// identity".
export const EquipmentKindSchema = z.enum(['equipment', 'family']);

export const EquipmentItemSchema = z.object({
  id: z.string(),
  schemaVersion: z.literal(1),
  name: z.string(),
  // `.default('equipment')` — every document already written has no `kind` key,
  // and it reads that absence as what it is: a piece of equipment.
  kind: EquipmentKindSchema.default('equipment'),
  accessories: z.array(AccessorySchema).default([]),
  rules: z.array(z.string()).default([]),
  // The record's own note, beside the `rules` it already has, and the two are not
  // the same thing. A RULE is a standing fact that changes the answer whether or
  // not the chef stops to think ("the bowl seal is perished, don't process
  // liquids") and stays ambient in every prompt. A NOTE is what the chef reads
  // while weighing a choice ("on a high shelf and takes ages to wash; only for
  // genuinely large volumes") and is fetched, never ambient — see the comment on
  // `AccessorySchema.note`.
  note: z.string().default(''),
  // `.nullable().default(null)` — the additive-field pattern (kitchenTool.ts,
  // following productForms). Every equipment document already written has no
  // `environment` key at all, and the default reads that absence as "not a
  // place", which is what it is, instead of failing validation and taking the
  // manifest down.
  environment: EquipmentEnvironmentSchema.nullable().default(null),
  updatedAt: z.string(),
});

export const EquipmentManifestSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string(),
  items: z.array(EquipmentItemSchema).default([]),
});

export type EquipmentItemDoc = z.infer<typeof EquipmentItemSchema>;

export type AccessoryDoc = z.infer<typeof AccessorySchema>;
export type EquipmentManifestDoc = z.infer<typeof EquipmentManifestSchema>;

export type EquipmentKind = z.infer<typeof EquipmentKindSchema>;
export type EquipmentControl = z.infer<typeof EquipmentControlSchema>;
export type EquipmentHumidityDoc = z.infer<typeof EquipmentHumiditySchema>;
export type EquipmentStandingSettingDoc = z.infer<typeof EquipmentStandingSettingSchema>;
export type EquipmentEnvironmentDoc = z.infer<typeof EquipmentEnvironmentSchema>;
