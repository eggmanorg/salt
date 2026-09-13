import { z } from 'zod';

// Standalone kitchen timers (issue #842). ONE document per user at
// `kitchenTimers/{uid}`, holding every timer that belongs to nobody's cook —
// "boil an egg", "bread out in 20". The FOURTH owner-scoped collection in an
// otherwise family-shared data model (see the "Per-user exceptions" note in
// CLAUDE.md): a kitchen timer is inherently personal — it is *my* egg — and
// there is no family-shared reading of it.
//
// ONE DOCUMENT PER USER, not one per timer. The collection is then bounded at a
// handful of documents forever, which makes the abandoned-timer question
// disappear rather than answering it: no sweep, no scheduled function, and no
// hand-configured per-project TTL policy. It also mirrors `activeTimers` on
// `cookSessions`, so the producers beside this file and the delivery trigger
// that reads it are near-copies of code already in production, and the client
// needs one document listener rather than a collection query.
//
// The accepted cost is that two devices editing DIFFERENT timers at the same
// moment clobber each other under full-document LWW — precisely the property
// `cookSessions.activeTimers` already has and accepts.

// WHERE A TIMER WAS ARMED FROM (issue #1327, Phase 2). Null for a timer started
// on My Kitchen, which came from nowhere but the kitchen itself; a batch id for
// one armed on `/batches/:id/cook`, with the step it sits on where it sits on
// one.
//
// It is a DEEP LINK AND A DISPLAY KEY, never scoping. The timer is still the
// owner's and still read and written under `kitchenTimers/{ownerUid}` alone —
// `origin` gates nothing, is checked by no rule, and does not make the timer the
// batch's (CLAUDE.md's per-user exceptions are still four, and `batches` still
// holds no timer). Two things read it: the finished-timer push, which lands the
// chef back on the page they armed it from instead of on Mine, and the batch cook
// deck, which shows a timer ON its step from an id rather than by matching label
// text.
//
// `stepId` is nullable INSIDE a non-null origin: an ad-hoc timer started from the
// batch cook page belongs to the batch and to no step, which is a different fact
// from belonging to nothing at all.
export const KitchenTimerOriginSchema = z.object({
  batchId: z.string(),
  stepId: z.string().nullable(),
});

// A single standalone timer. Deliberately `CookActiveTimerSchema` MINUS
// `stepId`: a timer with no cook is the same object without the one field that
// ties it to a recipe. That still holds with `origin` below — what came back is
// an ORIGIN, not a session binding: it says where the timer was armed, never that
// a cook owns it. Every other difference from that schema is because this
// collection is greenfield and that one is not —
//
//   - no `z.preprocess`. The preprocess on the cook schema exists solely to
//     backfill `id` for sessions written before #748. There is nothing here to
//     migrate, so adding one would be ceremony that outlives its reason.
//   - `label` and `durationMinutes` are REQUIRED, where the cook schema has
//     them nullable. They are nullable there to let a legacy entry fall back to
//     its recipe step; a standalone timer has no step to fall back to, so a
//     null would simply be a hole.
//   - no `createdAt`/`updatedAt`. Nothing reads one: the countdown is derived
//     from `endsAt`, and LWW here is whole-document and unconditional.
export const KitchenTimerSchema = z.object({
  // Minted client-side. Identity for re-timing and for dismissing, and — with
  // the owner's uid in front of it — the delivery ledger's key.
  id: z.string(),
  // The timer's own name, as typed. Always present: the sheet prefills one and
  // an emptied field falls back to the same default rather than to null.
  label: z.string(),
  // Absolute ISO end-time (not a remaining duration) so the countdown survives a
  // reload or a device switch without drift. Same contract as a cook timer's.
  endsAt: z.string(),
  // What the timer was ACTUALLY started for, which is what the dial's sweep
  // needs: a countdown alone says what is left, never how far through you are.
  durationMinutes: z.number().positive(),
  // Whether this one earns the server-side push backstop. Re-derived from the
  // duration on every start, so a timer stretched over the floor gains it and
  // one cut under the floor loses it.
  notify: z.boolean(),
  // `.nullable().default(null)` so every timer written before #1327 — and every
  // one started from My Kitchen since — reads as a timer from nowhere in
  // particular, with no migration. See the schema above for what it is and is
  // not.
  origin: KitchenTimerOriginSchema.nullable().default(null),
});

export const KitchenTimersSchema = z.object({
  // Pinned on every write and equal to the document id. The id alone is what the
  // security rule keys on — but the FIELD is what the delivery trigger reads to
  // target `pushSubscriptions`, so the send target is proven by the same
  // document that armed the timer.
  ownerUid: z.string(),
  // `.default([])` so a document written before a timer was ever added — or one
  // whose last timer was dismissed — reads as an empty kitchen rather than
  // failing validation.
  timers: z.array(KitchenTimerSchema).default([]),
});

export type KitchenTimerOrigin = z.infer<typeof KitchenTimerOriginSchema>;
export type KitchenTimerDoc = z.infer<typeof KitchenTimerSchema>;
export type KitchenTimersDoc = z.infer<typeof KitchenTimersSchema>;
