import { z } from 'zod';
import { ProcessStageContentSchema } from './process.js';

// proposeSchedule (issue #812, phase 2 of epic #778) — the PROPOSAL half of the
// epic's two AI tiers. `extractProcessStages` transcribes a method into stages;
// this one restructures those stages so the loaf comes out of the oven when you
// asked for it, and says in words why it did what it did.
//
// ─── THE FLOW EMITS NO TIMESTAMPS AND NO GRAMS ─────────────────────────────────
//
// It returns STAGES and PROSE. Not a single clock time, not a single weight.
//
//   • `resolveSchedule` computes the clock. Back-solving from `{ kind: 'endAt' }`
//     hits the requested minute EXACTLY BY CONSTRUCTION, where a model asked for
//     wall-clock times does arithmetic it gets inconsistently right — and a
//     schedule that is four minutes out is a schedule nobody can trust.
//   • `solveFormula` computes the grams, through the one rounding authority.
//
// This is the contract doc's "the AI authors, the domain runs" applied to TIME as
// well as to MASS. Letting the flow return times was considered and rejected; do
// not add a time field here.
//
// ─── YEAST IS AN OPINION, NOT A CALCULATION ────────────────────────────────────
//
// A longer, colder ferment wants less leavening. How much less is a BAKER'S
// JUDGEMENT — "longer and colder, so I'd take the yeast down to roughly
// two-thirds" — and it is stated as such, in words a baker can disagree with,
// alongside a MULTIPLICATIVE FACTOR against a named component's existing percent.
// It never emits grams and never emits a percent:
//
//   • the factor is applied to the stored percentage by `withComponentPercentScaled`
//     in the formula module, which is generic (it knows nothing about yeast);
//   • the result is re-solved through the same `solveFormula` and the same
//     rounding as every other component, so `domain` stays the single rounding
//     authority and nothing here can round differently;
//   • an ABSURD factor is caught by the bounds rail that already exists —
//     `minPercent`/`maxPercent` on `FormulaComponentSchema` and `solveFormula`'s
//     refusal (#782). The rail catches nonsense; it is NEVER a decider inside the
//     sane range. See `LEAVENING_PERCENT_BOUNDS`.
//
// There is DELIBERATELY no fermentation model anywhere near this — no hours-at-
// temperature equivalence, no numeric timing model. Deciding what a fridge retard
// does to a dough is an opinion, and giving a guess the authority of a computed
// figure is worse than an opinion labelled as one. Named in
// docs/formulas-schedules-batches.md's "what not to build".

// ─── The three timeouts ─────────────────────────────────────────────────────────
//
// ONE place, so they cannot drift apart — `PHOTO_IMPORT_TIMEOUT_SECONDS` is the
// precedent, and this flow needs it more: the spike measured proposeSchedule at
// 65–108 s uncapped, and 19–31 s with a capped thinking budget at unchanged
// schedule quality. The budget is a TARGET AND NOT A CEILING on `gemini-pro-latest`
// (a capped run reported 4,365 thinking tokens against a 1,024 budget), so none of
// these is sized off it.
//
// The order is load-bearing and is what each number buys:
//
//   AI budget (150 s) < client (170 s) < function (180 s)
//
//   • The AI call must give up FIRST, so a hung model surfaces as this flow's own
//     error with a message, rather than as the runtime killing the invocation.
//   • The client must wait LONGER than the AI budget, or a working call is
//     abandoned on the browser side while the function is still writing its
//     answer. The callable SDK defaults to 70 s, which this call legitimately
//     exceeds, so the wrapper MUST pass an explicit timeout.
//   • The function must outlive the client, so the request is never cut off from
//     under a browser that is still listening.
export const PROPOSE_SCHEDULE_TIMEOUT_SECONDS = 180;
export const PROPOSE_SCHEDULE_CLIENT_TIMEOUT_MS = 170_000;
export const PROPOSE_SCHEDULE_AI_TIMEOUT_MS = 150_000;

// ─── The household constraint ───────────────────────────────────────────────────
//
// "Nobody is awake between 23:00 and 06:00" — the spike's phrasing, and the one
// constraint that decides whether an overnight loaf is a good idea or a 03:00
// alarm. Expressed as a pair of LOCAL HOURS because that is how a household says
// it; the flow only ever quotes it back in the prompt, and `resolveSchedule` (which
// knows nothing of it) does the clock afterwards.
//
// The window WRAPS midnight by construction — `fromHour` 23, `toHour` 6 — and both
// ends are hours of the day, not instants. Nothing in the domain enforces the
// window: it is a request made of the model, and the reviewer sees the resulting
// times and can disagree.
export const QuietHoursSchema = z.object({
  fromHour: z.number().int().min(0).max(23),
  toHour: z.number().int().min(0).max(23),
});

export const DEFAULT_QUIET_HOURS: QuietHours = { fromHour: 23, toHour: 6 };

// ─── The callable input ─────────────────────────────────────────────────────────
//
// IDS ONLY, plus the ask. The flow reads the recipe AND its formula server-side
// through the Admin SDK — same posture as `extractProcessStages` and
// `generateGuidedPlan` — so the client cannot hand the model a process that is not
// the one in Firestore.
//
// The target is a LOCAL WALL CLOCK (`YYYY-MM-DDTHH:mm`, exactly what a
// `datetime-local` input produces) and NOT an ISO instant, deliberately. The model
// reasons in "out of the oven at half seven on Saturday"; it never converts a zone
// offset and it never emits a time. The client keeps the instant for
// `resolveSchedule` and sends the wall clock here — one representation each, for
// the one job each is right for.
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export const ProposeScheduleInputSchema = z.object({
  recipeId: z.string().min(1),
  // "Out of the oven at 07:30 on Saturday."
  targetEndAtLocal: z.string().regex(LOCAL_DATE_TIME),
  // Omitted → `DEFAULT_QUIET_HOURS`, applied in the flow rather than by a zod
  // `.default()` so a caller can simply not pass it without the inferred input
  // type demanding one.
  quietHours: QuietHoursSchema.optional(),
  // HOW WARM THE KITCHEN IS TODAY, as the bake sheet asked it (issue #1286). The
  // one figure nobody can derive — Salt has an outdoor forecast and no honest way
  // to turn it into an indoor temperature — and the thing this flow has been
  // missing: without it a counter prove is reasoned about at whatever room the
  // model assumes, which in February is wrong by ten degrees.
  //
  // NOTHING COMPUTES WITH IT. It reaches the prompt as a line of text and the
  // rationale, and nothing else; the durations that come back are the model's
  // judgement, exactly as they were before (see this file's header, and
  // docs/formulas-schedules-batches.md "what not to build").
  //
  // `.nullable().optional()`: null is "the baker skipped the question", absent is
  // "this caller does not ask it", and the flow treats them identically.
  ambientCelsius: z.number().nullable().optional(),
});

// ─── What the model authors ─────────────────────────────────────────────────────
//
// CONTENT ONLY, with one addition: a citation. `ProcessStageContentSchema` carries
// no `id` because ids are document-local identity minted by the write path, and
// that stays true here — but a diff has to know which reference stage a proposed
// one CAME FROM, so the proposal cites it.
//
// `sourceStageId` is nullable and the null case is ordinary, not an error: an
// AI-added fridge retard came from no stage at all. What the flow does with a
// citation to a stage that does not exist is the extraction precedent, not the
// guided-plan one — it nulls the CITATION and keeps the STAGE, because a cold
// retard is still a cold retard without a provenance note, and dropping it would
// tear a hole in the middle of the process. See the flow.
//
// A citation is a CLAIM, not a key: two proposed stages may cite the same
// reference stage (a ninety-minute bulk becoming twenty on the counter and eight
// in the fridge), and `diffProcess` renders that honestly as a removal plus two
// additions rather than inventing a "split" operation.
export const ProposedStageSchema = ProcessStageContentSchema.extend({
  sourceStageId: z.string().nullable(),
});

// The leavening opinion. GENERIC in shape — an ingredient, a factor and a
// sentence — because the same seam is what a cure's salt would use; only the
// prompt is bread-flavoured.
//
// `factor` is MULTIPLICATIVE against the component's stored percent (0.66 = "down
// to roughly two-thirds"). Not a percent, not grams: a percentage figure from the
// model would be a second rounding authority and a gram figure would be a third.
export const ComponentAdjustmentSchema = z.object({
  // FK into the formula's `components[].ingredientId`. An id the formula does not
  // hold means the whole adjustment is dropped — see the flow.
  ingredientId: z.string(),
  factor: z.number().positive(),
  // Why, in the baker's own terms. Shown beside the numbers so the change can be
  // argued with rather than merely accepted.
  reason: z.string(),
});

export const ProposeScheduleAIOutputSchema = z.object({
  // The restructured process, in the order the cook does it.
  stages: z.array(ProposedStageSchema),
  // The worded reasoning for the whole schedule — what was moved and why. This is
  // what `BatchSchema.rationale` freezes onto the run.
  rationale: z.string(),
  // Null far more often than not: most proposals move time about and leave the
  // formula alone. ONE adjustment, never a list — the flow is allowed an opinion
  // about the leavening, not a licence to rewrite the formula.
  adjustment: ComponentAdjustmentSchema.nullable(),
});

// Same shape out as in. The flow's post-pass only ever REMOVES claims it cannot
// stand behind (a citation to a stage that is not there, an adjustment to an
// ingredient that is not there); it adds nothing, so there is no second shape.
//
// DECLINING TO RESTRUCTURE IS A VALID ANSWER, and it needs no field of its own: a
// proposal that returns the process as it stands produces a `ProcessDiff` with
// `hasChanges: false`, which is exactly how the review renders "nothing to change
// here — it already lands where you want it". The restraint matters as much as the
// restructure, and one of the spike's three recipes correctly did nothing but
// back-solve.
export const ProposeScheduleOutputSchema = ProposeScheduleAIOutputSchema;

export type QuietHours = z.infer<typeof QuietHoursSchema>;
export type ProposeScheduleInput = z.infer<typeof ProposeScheduleInputSchema>;
export type ProposedStage = z.infer<typeof ProposedStageSchema>;
export type ComponentAdjustment = z.infer<typeof ComponentAdjustmentSchema>;
export type ProposeScheduleOutput = z.infer<typeof ProposeScheduleOutputSchema>;
