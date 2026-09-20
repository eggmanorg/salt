import { z } from 'zod';

// Canonical Firestore location of the single shared equipment manifest. Both the
// client store (firebase-sync) and the server-side chef flow (cloud-functions)
// read this doc; sharing the identifiers here is the one source of truth so the
// two sides can't drift (which silently broke the chef's equipment context once).
export const EQUIPMENT_MANIFEST_COLLECTION = 'equipmentManifest';
export const EQUIPMENT_MANIFEST_DOC_ID = 'current';

// ─── A picture BORROWED from something else (issue #1465, Phase 3) ───────────
//
// A thing you own can be given a picture without anything being drawn for it:
// "this Tefal 28cm looks like the generic frying pan" points at a drawing that
// already exists, and every recipe naming that pan gains it at once.
//
// A REFERENCE, NEVER A COPIED URL, and that is the whole reason this is two
// fields rather than one string. Every icon family reuses its Storage object
// path on a redraw and writes the bytes `immutable` (see `kitIcons.ts` and
// ui-spec-v04 §14.4), so a copied URL is stale the first time the source is
// redrawn — and the cache-bust nonce it would need lives on the SOURCE document,
// which a copy cannot see. Reading through the id means redrawing the frying pan
// updates every pan borrowing it, on the same subscription that updates the
// frying pan itself.
//
// `family` because the two vocabularies are two collections: `kitchenTool` is a
// `kitchenTools` document (its picture is a field on it), `equipment` is an
// `equipmentIcons` document (keyed by an item id or an entry id). There is no
// third family here on purpose — canon items and product forms are ingredients,
// and nothing in a kit list should ever draw one.
export const BorrowedPictureSchema = z.object({
  family: z.enum(['equipment', 'kitchenTool']),
  id: z.string().min(1),
});

export type BorrowedPictureDoc = z.infer<typeof BorrowedPictureSchema>;

// The borrowed picture, for an item or an entry. `.nullable().default(null)` —
// the additive-field pattern every other field here follows, so the ~19 records
// and ~140 entries already written read as "borrows nothing", which is what they
// do.
//
// NO `.refine` couples it to anything, and that is deliberate for the reason
// `EquipmentEnvironmentSchema` states two fields below: the manifest is ONE
// document, so a refine failing on one stale reference takes the WHOLE equipment
// list down. A reference whose target has since been deleted is therefore
// perfectly valid on read and simply resolves to nothing at display time — the
// same degradation a dangling kit link gets.
const borrowedPictureField = BorrowedPictureSchema.nullable().default(null);

export const AccessorySchema = z.object({
  id: z.string(),
  name: z.string(),
  owned: z.boolean(),
  included: z.boolean(),
  borrowedPicture: borrowedPictureField,
  // What the household knows about THIS ONE THING and no other — "the 28cm cast
  // iron is the only one that goes in the oven", "the XL dough hook needs the
  // upgraded firmware" (issue #1373).
  //
  // NEVER AMBIENT. No note, here or on the item, is rendered into any AI PROMPT,
  // and the chef never volunteers one unprompted; it reaches one only by looking
  // a record up with its tool. That is the whole point — a note is what refines a
  // choice the chef is already weighing, and there are enough of them across
  // twelve pans to double the prompt if they rode along on every call. A standing
  // fact that must reach the chef whether or not it stops to look is a `rules`
  // entry on the item, not a note.
  //
  // THE BOUNDARY THIS DOES NOT COVER (Daniel's call, 2026-09-20 — issue #1485):
  // `IdentifyRecipeKitInputSchema.equipment` (`identifyRecipeKit.ts`) is the raw
  // `EquipmentItemSchema[]`, not a rendering of it, so a note DOES cross into that
  // flow's declared input and from there into Genkit's Cloud Function trace logs
  // — deliberately. The data is family-shared and the logs are project-internal,
  // and stripping notes at that boundary was judged not worth the plumbing. Read
  // "never ambient" as a claim about the AI's prompts and unprompted replies; it
  // is not a claim about what a CF trace can see, nor about the equipment editor,
  // which of course shows a note back to whoever wrote it.
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
  // See `borrowedPictureField` above. An ITEM borrows for the same reason an
  // entry does, and the whole family then shows it: "Frying Pans" is a category
  // nobody will ever draw a portrait of, and the generic frying pan is the right
  // picture for it.
  borrowedPicture: borrowedPictureField,
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
