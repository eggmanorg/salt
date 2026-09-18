import { z } from 'zod';

// Equipment pictograms (issue #877) — a SIBLING collection, one tiny document
// per equipment item, server-written and client-read.
//
// ─── Why this is not a field on the manifest ────────────────────────────────
// Equipment is not stored per item. The whole kit is ONE document,
// `equipmentManifest/current`, holding an `items[]` array, and every one of the
// nine domain mutators reaches `saveEquipmentManifest`, which does a
// WHOLE-DOCUMENT `setDoc` of the entire array (equipmentManifestSubscription.ts).
//
// Every other generated-image pipeline in Salt writes back with a partial
// `.update()` on a document whose identity matches the image's identity —
// `canonItems/{id}.thumbnail`, `recipes/{id}.image` — and Firestore's field-level
// merge is what makes that safe. Equipment has no such document. A `thumbnail` on
// the array element would mean:
//
//   • ticking one accessory's checkbox serialises the whole array back and can
//     wipe the icons off EVERY item, not just the edited one;
//   • the Cloud Function's write re-fires its own trigger on the whole manifest,
//     so seeding N icons is N full-manifest write events re-syncing to every
//     client;
//   • the trigger's guard degrades into an N-way array diff that any unrelated
//     item's edit fires.
//
// So the field gets its own collection. This is the `canonEmbeddings` move
// (#410) and the `guidedPlans` move: when a field and its host document have
// different owners and different read audiences, the field gets its own
// collection. The Cloud Function NEVER writes the manifest, so there is no
// self-refire and no LWW clobber.
//
// ─── Two names, two guards, and deliberately no status enum ─────────────────
// Because the CF never writes the manifest, the trigger can be LEVEL-triggered
// rather than edge-triggered — no nonce gymnastics, no loop risk.
//
//   • RE-AUTHOR THE BRIEF when no icon doc exists, or when
//     `briefSourceName !== item.name`. That is the trigger's only job, and it
//     hands rewrite-on-rename over for free.
//   • AWAITING APPROVAL is DERIVED, never stored — see
//     `equipmentIconAwaitingApproval` in `@salt/domain`. It covers both "never
//     drawn" (`sourceName` absent) and "renamed since the last draw", and it goes
//     false the instant a draw succeeds, because the draw stamps
//     `sourceName = briefSourceName`.
//
// Deriving that state from the two names instead of storing a status is what
// stops a failed or abandoned draw from needing bookkeeping of its own: there is
// no state to leave behind, because there is no state.
//
// ─── The document id is an ITEM id OR an ENTRY id (issue #1465, Phase 2) ─────
// An accessory or family member may have a picture of its own, on request. Its
// document is `equipmentIcons/{accessoryId}` and its object
// `equipment-icons/{accessoryId}.webp` — no second collection and no second
// Storage prefix, because accessory ids are uuids minted by the same generator as
// item ids and are unique across the whole manifest. Everything keyed by doc id
// therefore carries over untouched: `firestore.rules`'s `{itemId}` wildcard, the
// orphan sweep's `equipment-icons/ → equipmentIcons` join, `drawEquipmentIcon`,
// `setIconUpload` and `getImagePrompt`.
//
// TWO THINGS DO NOT CARRY OVER, and both are in `onEquipmentManifestWritten`:
//   • its reconcile pass builds the live set from the items alone, and would have
//     deleted every entry's icon document on the next manifest write. It now
//     builds the set from `equipmentIconOwnerIds`, pinned by a test that goes red
//     if it stops.
//   • its brief-authoring loop stays ITEM-ONLY. ~140 entries means ~140 text
//     calls on every manifest save, for pictures nobody asked for. An entry's
//     brief is authored on demand, by the `authorEntryIconBrief` callable below,
//     and never by a trigger.
//
// The set of ids a manifest legitimately owns is `equipmentIconOwnerIds` in
// `@salt/domain` (equipment/queries/equipmentIcon.ts).
export const EQUIPMENT_ICONS_COLLECTION = 'equipmentIcons';

export const EquipmentIconSchema = z.object({
  /**
   * The appliance description — what the thing LOOKS LIKE, in brand-free words.
   * This is the one field shown to the user and the one field they may EDIT; the
   * locked house-style wording lives in code (`EQUIPMENT_STYLE_ANCHORS`) and is
   * never stored and never editable.
   *
   * AMENDED (issue #892): it is no longer true that the anchors never reach the
   * client. `getImagePrompt` assembles the whole prompt — anchors included — and
   * hands it to a read-only dialog, so a person can see exactly what draws their
   * picture and take those words elsewhere. What the original wording was
   * protecting is untouched: the style is not editable, not stored per item, and
   * not something a user can talk the model out of. Nothing in it is sensitive —
   * it is cartoon-illustration wording in a family app.
   */
  subjectBrief: z.string().min(1),
  /** The item name the CURRENT brief was authored from. Drives the trigger's guard. */
  briefSourceName: z.string().min(1),
  /**
   * Tri-state, exactly as `CanonItem.thumbnail` (see `isCanonIconRenderable`):
   * `null` → nothing drawn yet; a URL → the picture; `"hidden"` → the user opted
   * out. `CanonIcon` renders all three without change.
   */
  thumbnail: z.string().nullable(),
  /**
   * The item name the CURRENT PICTURE was drawn from. Absent until the first
   * successful draw — which is precisely what makes "never drawn" and "renamed
   * since the draw" one comparison instead of two.
   */
  sourceName: z.string().optional(),
  /**
   * Cache-bust nonce, fed to `CanonIcon`'s `version` prop. Load-bearing: a redraw
   * reuses the same Storage object path, so the download URL is byte-identical
   * and a browser would serve the stale image for a year (the object is written
   * `immutable`, matching canon). Stamped fresh on every successful draw.
   */
  iconRequestedAt: z.number().optional(),
  /** Server write stamp. Audit only — nothing branches on it. */
  updatedAt: z.string().optional(),
});

export type EquipmentIconDoc = z.infer<typeof EquipmentIconSchema>;

// ─── Draw / Hide callable wire input ────────────────────────────────────────
// ONE callable takes an action rather than two callables, and both actions go
// through a callable at all because `equipmentIcons` is client-write-denied.
// Canon can afford a plain client write for hide (`hideCanonIcon`) because the
// sentinel lives on a document the client already writes; equipment has no such
// path, and opening a server-owned collection to client writes to mirror canon's
// split exactly would buy nothing.
//
// A discriminated union rather than an optional `brief`: a draw without a brief
// is not a request this callable should have to interpret, and the union makes
// that a parse failure rather than a runtime branch.
//
// There is deliberately NO `unhide` action. A draw overwrites `thumbnail` with
// the new URL whatever it held before, so pressing Draw IS the un-hide — canon
// needs a separate one only because its un-hide has to clear the field back to
// null and let a trigger pick it up.
//
// `itemId` is the DOCUMENT id, and since #1465 Phase 2 that may be an entry's
// accessory id as readily as an item's. The field keeps its name: it is a wire
// contract against production clients, and renaming it would buy a more accurate
// word at the price of a migration on a field whose meaning is "which
// equipmentIcons document".
export const DrawEquipmentIconInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('draw'),
    itemId: z.string().min(1),
    // The brief actually drawn from — the stored one, or the user's edit of it.
    // Bounded because it is free user text heading for an AI prompt.
    brief: z.string().min(1).max(2000),
  }),
  z.object({
    action: z.literal('hide'),
    itemId: z.string().min(1),
  }),
]);

export type DrawEquipmentIconInput = z.infer<typeof DrawEquipmentIconInputSchema>;

// ─── Author one ENTRY's description, on request (issue #1465, Phase 2) ───────
//
// The item path never needs this: `onEquipmentManifestWritten` authors an item's
// brief the moment it appears, so by the time anyone looks at an item there is a
// description to read and `drawEquipmentIcon` has something to draw from. An
// entry has no such document and deliberately never gets one automatically —
// ~140 entries, most never named in a recipe, and a picture per entry is one more
// to curate. So the first act on an entry is asking for its description, and this
// is the callable that does it.
//
// IT TAKES A PAIR, NOT AN ID, because the words a brief is authored from are a
// function of BOTH (`equipmentEntrySubjectName`): an appliance's part is
// qualified by its appliance, a family member is not. The server reads the
// manifest itself rather than trusting a name off the wire — the manifest is the
// authority on what this household owns, and a client-supplied subject would be
// an unvalidated prompt input for no gain.
//
// It PERSISTS what it authors, which is the one way it differs from
// `describeEquipmentSubject`: there is no document yet, so there is nothing for a
// transient sentence to be a revision OF. Once it exists, Revise and Draw behave
// exactly as they do for an item.
export const AuthorEntryIconBriefInputSchema = z.object({
  itemId: z.string().min(1),
  accessoryId: z.string().min(1),
});

export type AuthorEntryIconBriefInput = z.infer<typeof AuthorEntryIconBriefInputSchema>;
