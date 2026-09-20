import { z } from 'zod';

// Admin-managed AI model selection (Phase 1). A single Firestore singleton doc
// (`appSettings/singleton`); Firestore is per-project, so this is automatically
// scoped to the environment it lives in.
//
// Each role field names the Gemini model used by a class of AI flows. Every
// field `.default()`s to today's exact production literal, so a missing,
// empty, or never-configured doc resolves to the current behaviour — deleting
// or corrupting the doc leaves AI fully working on defaults.

// The AI roles flows are bucketed into. Free-text model names per role for
// now (no live catalog yet); a later phase adds validation against a catalog.
export const AI_MODEL_ROLES = ['fast', 'lite', 'pro', 'embedding', 'image'] as const;
export type AiModelRole = (typeof AI_MODEL_ROLES)[number];

// Today's exact production model literals — the fallback for every role. These
// MUST stay in sync with the hardcoded literals the flows used before Phase 1.
export const AI_MODEL_DEFAULTS = {
  fast: 'gemini-flash-latest',
  lite: 'gemini-flash-lite-latest',
  pro: 'gemini-pro-latest',
  embedding: 'gemini-embedding-001',
  image: 'gemini-2.5-flash-image',
} as const satisfies Record<AiModelRole, string>;

// Phase 2: per-flow model overrides. Every AI flow (and the server embedding
// adapter) maps to exactly one role; this is the single source of truth for that
// mapping, shared by the CF resolver and the admin UI. A flow inherits its
// role's model unless an admin sets an explicit override in `perFlow`.
//
// IMPORTANT: these flow-id keys are stable identifiers persisted in the
// `perFlow` map of the production `appSettings` doc — renaming one orphans any
// saved override. Add new flows here; do not rename existing ones.
//
// COMPLETENESS (issue #935): the CF resolver takes a flow id and nothing else —
// `resolveModel(flowId: AiFlowId)`, with the role read from this map — so a flow
// missing from here cannot resolve a model at all: there is no signature that
// accepts it. That makes the compiler, not a convention, the thing that keeps
// this list complete and keeps the admin override list from silently omitting a
// job. The boundary of that guarantee: it binds every FLOW's model and embedder
// call — every site that goes through `resolveModel`/`flowModel`. It does not
// reach `apps/cloud-functions/src/ai/testModel.ts`, the admin "test this model"
// probe, which calls `googleAI.model`/`googleAI.embedder` directly on a model id
// an admin typed — off-seam by design, since faking or registering it would
// defeat its purpose. A flow that hardcoded a model literal instead of going
// through the resolver would also bypass it, and nothing here would notice.
export const AI_FLOW_ROLES = {
  arbitrateCanon: 'lite',
  // `lite` (issue #500, registered #935). Same shape and same tier as
  // arbitrateCanon directly above, and for the same reason: a closed question
  // over a short candidate list ("is this a non-buyable form of one of these?"),
  // answered against a rubric rather than by judgement, and driven by every
  // recipe import — so volume, not depth, is what sets the price.
  arbitrateProductForm: 'lite',
  authorRecipe: 'fast',
  // `categoriseRecipe`, a `fast` key, is RETIRED here (issue #1249) — not
  // renamed, and not re-used for anything else. #935 registered it as if it were
  // deployed and it never became so: the flow had no callable, no trigger and no
  // client caller, and its only invocation in the tree was the one-off operator
  // script `apps/cloud-functions/scripts/recategorise-recipes.ts`. What that
  // cost was an admin control misrepresenting itself — the "Fast model" role
  // card named a job the app does not run, and the Advanced section offered an
  // override for it. The flow, its schemas, its tests and that script are
  // deleted with this key; recipes are still categorised, by the librarian and
  // the two importers, all under the same shared `CATEGORY_TAG_RULES`.
  //
  // The production consequence, the same shape as the `serverEmbedding`
  // retirement documented below: `perFlow` is a free-form
  // `z.record(z.string(), …)`, so an override saved against this key still
  // parses and is simply never read again. Unlike `serverEmbedding` there is
  // nothing an orphan could corrupt — no code resolves this id any more, and no
  // vectors were written under it — so the worst case is a dead map entry.
  //
  // The evidence, and its boundary. Daniel (repo owner) states on 2026-09-04
  // that `recategorise-recipes.ts --apply` has been run to completion against
  // production and the flow is no longer needed. That is a dated statement from
  // the owner, in the same form the `serverEmbedding` note took; it is not a
  // re-read of production recipe tags. What would falsify it is a recipe still
  // carrying pre-rules tag soup, and the repair then is to re-author or hand-edit
  // that recipe — the librarian applies the same tag rules this flow did.
  chefChat: 'pro',
  // The cheap text half of the equipment pictogram pair (issue #877): turns a
  // make and model into a brand-free visual brief. `fast` for the same reason
  // describeRecipeScene is — it is the step in front of an image call, and its
  // cost has to stay far below the picture it directs.
  describeEquipmentSubject: 'fast',
  describeRecipeScene: 'fast',
  // The one embedding switch there is (issue #935). Text in, vector out — for
  // canon matching, single item and batch alike: `computeEmbeddings` delegates
  // to `embedTextFlow` per text rather than resolving its own model.
  //
  // `serverEmbedding`, the key that batch path used to resolve, is RETIRED here
  // — not renamed, and not re-used for anything else. `perFlow` is a free-form
  // `z.record(z.string(), …)` (below), so a value saved against the old key
  // still parses and is simply never read again: the risk retiring it carried
  // was never a parse failure, only an orphaned override quietly moving batch
  // canon vectors onto a different embedding model from the stored ones.
  //
  // The evidence that nothing was orphaned, and its boundary. Staging (project
  // `s2-stage-ccb22`) was restored from production on 2026-09-01 — a restore is
  // a full mirror that includes `appSettings` (`docs/data-refresh.md`) — and its
  // `appSettings/singleton` was read on 2026-09-02: no `perFlow` map at all,
  // absent rather than empty. Daniel (repo owner) states no per-flow model
  // override has ever been set on `serverEmbedding` in either environment,
  // before the restore or since. Together that is a dated as-of, not an
  // unqualified guarantee: what would falsify it is an override the owner is
  // not aware of, or one set in production after this note was written. If one
  // ever surfaces, the repair is to set the same value on `embedText` from
  // /admin/app-settings — the override is recoverable there, whereas vectors
  // already written under a different model are not comparable and would need
  // a re-embed.
  embedText: 'embedding',
  extractRecipeFromUrl: 'fast',
  // Multimodal: 1–4 cookbook-page images in, structured recipe JSON out (#649).
  // Same tier as the URL import — accuracy over creativity, and the same model
  // family reads both, so a model change moves the two together.
  extractRecipeFromPhoto: 'fast',
  // `lite` (issue #806, epic #778). Pulling the wait stages out of step text and
  // the timers already parsed onto it is MECHANICAL — no judgement, the answer is
  // in the words in front of it — which is the same posture as
  // parseRecipeIngredients. The epic's contract names this the "extraction (cheap
  // tier)" half deliberately; the "proposal (better tier)" half is the separate
  // flow immediately below.
  extractProcessStages: 'lite',
  // `pro`, and it is the other half of the pair above (issue #812, epic #778).
  // The epic's contract says "two flows, two tiers; not one flow doing both":
  // extraction is transcription, this is JUDGEMENT — restructuring a process so a
  // loaf lands at 07:30 without anyone getting up at 03:00, and having an opinion
  // about what a longer, colder ferment does to the yeast. The spike measured it
  // on the pro tier at 65–108 s uncapped, which is why this flow carries its own
  // timeout constants rather than the house text-flow values.
  proposeSchedule: 'pro',
  // `pro`, deliberately (issue #751). Cue quality IS the feature: a wrong sensory
  // cue tells the cook to wait for something that will never happen, which is
  // worse than no cue at all — and the volume is a handful of recipes ever, so the
  // cost argument that puts the import flows on `fast` does not apply. chefChat is
  // the precedent: long-form judgement about a whole dish.
  generateGuidedPlan: 'pro',
  generateCanonIcon: 'image',
  // The image half of the equipment pair (issue #877). Its own id rather than
  // borrowing generateCanonIcon's, so an override aimed at grocery pictograms
  // does not silently move the appliances too.
  generateEquipmentIcon: 'image',
  // The generic kitchen-tool pictograms (issue #882). Its own id, for the same
  // reason equipment has one: an override aimed at grocery pictograms must not
  // silently move the tools too.
  generateKitchenToolIcon: 'image',
  generateRecipeImage: 'image',
  generateChatTitle: 'lite',
  identifyEquipment: 'fast',
  // `fast` (issue #882). It reads a whole recipe and returns a short structured
  // answer, which is describeRecipeScene's shape rather than chefChat's: the
  // question has a right answer that is mostly in the words in front of it, and it
  // runs once per recipe on a trigger, so its cost has to stay small. It is NOT
  // `lite` — the inference half is real ("mash the potatoes" needs a masher the
  // recipe never names), and a label that reads like a cook wrote it ("large
  // frying pan", not "pan") is the whole user-visible outcome.
  identifyRecipeKit: 'fast',
  // `fast` (issue #952, phase 2). Same shape and same reasoning as
  // identifyRecipeKit directly above: it reads a whole stored recipe and returns a
  // short structured answer, once per recipe on a trigger. Not `lite` — judging
  // that six onions is twenty minutes of knife work and that a proved dough is an
  // unattended wait rather than prep is the entire value of the answer.
  estimateRecipeTimes: 'fast',
  // `fast` (issue #1458, phase 2). It reads a short list of words and a closed
  // vocabulary and answers alias / new / not-kit per word. `lite` is too little:
  // the value is the GROUPING judgement — that "large mixing bowl" and "Large
  // Bowls" are the bowl we already draw, and that "20cm" is not kit at all — and
  // that is the same shape of call as identifyRecipeKit above. It is not `pro`
  // either: a wrong answer costs one glance at a sentence a person then declines
  // to press, and it runs on every visit to an admin page.
  proposeKitchenTools: 'fast',
  parseEntry: 'lite',
  parseRecipeIngredients: 'lite',
  populateEquipmentEntry: 'lite',
} as const satisfies Record<string, AiModelRole>;

export type AiFlowId = keyof typeof AI_FLOW_ROLES;
export const AI_FLOW_IDS = Object.keys(AI_FLOW_ROLES) as AiFlowId[];

// The family's home location, used to anchor location-dependent features (e.g.
// the meal-planner weather forecast, added in a later phase). Set by an admin
// via the app-settings page — either by picking an Open-Meteo geocoding result
// or by entering coordinates by hand. `timezone` is an IANA zone (e.g.
// `Europe/London`) supplied by the geocoder; `label` is a human-readable name
// for the place (e.g. `London, England, United Kingdom`).
export const HomeLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
  label: z.string().min(1),
});

export type HomeLocation = z.infer<typeof HomeLocationSchema>;

// ─── Nominatim geocoding (issue #382) ───────────────────────────────────────
// The home-location search runs as a keyless browser fetch in `web-pwa` against
// OpenStreetMap Nominatim, which resolves free-form ADDRESSES and POSTCODES (the
// previous Open-Meteo gazetteer only matched place names). Response parsing lives
// here (schemas live in `@salt/domain/schemas`) and stays a pure function over
// `unknown` — no I/O. We validate only the subset of each result we consume.
//
// Nominatim returns `lat`/`lon` as STRINGS and carries no timezone, so the caller
// passes a `fallbackTimezone` (the browser's IANA zone — the family's home is
// almost always in their own zone, and the forecast window's true zone is
// resolved server-side via Open-Meteo `timezone=auto` and stored separately on
// the forecast doc). `display_name` is the full human-readable label.
const NominatimPlaceSchema = z.object({
  place_id: z.number(),
  lat: z.string(),
  lon: z.string(),
  display_name: z.string().min(1),
});

// A Nominatim *search* response is a bare array of places ([] when nothing matches).
const NominatimSearchResponseSchema = z.array(NominatimPlaceSchema);

// A single place an admin can pick. `id` is stable per place (used as a list
// key); `label` is the pretty name; `location` is exactly the doc shape we save.
export type GeocodingResult = {
  id: number;
  label: string;
  location: HomeLocation;
};

// Parses a raw Nominatim *search* response into pickable results, or `null` if
// the payload is malformed. Rows with unparseable / out-of-range coordinates are
// skipped (not fatal) so one bad row can't drop the whole list. Pure — the caller
// (web-pwa) does the fetch and supplies the fallback timezone.
export function parseNominatimResponse(
  raw: unknown,
  fallbackTimezone: string,
): GeocodingResult[] | null {
  const parsed = NominatimSearchResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const timezone = fallbackTimezone.trim() || 'UTC';
  const results: GeocodingResult[] = [];
  for (const p of parsed.data) {
    const latitude = Number(p.lat);
    const longitude = Number(p.lon);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) continue;
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) continue;
    results.push({
      id: p.place_id,
      label: p.display_name,
      location: { latitude, longitude, timezone, label: p.display_name },
    });
  }
  return results;
}

// Parses a raw Nominatim *reverse* response into a display label, or `null` when
// the lookup failed / was malformed (Nominatim returns `{ error }` for no match).
// Used to refresh the label after the admin drags the map pin. Pure.
const NominatimReverseResponseSchema = z.object({ display_name: z.string().min(1) });
export function parseNominatimReverse(raw: unknown): string | null {
  const parsed = NominatimReverseResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data.display_name : null;
}

export const AppSettingsSchema = z.object({
  fast: z.string().min(1).default(AI_MODEL_DEFAULTS.fast),
  lite: z.string().min(1).default(AI_MODEL_DEFAULTS.lite),
  pro: z.string().min(1).default(AI_MODEL_DEFAULTS.pro),
  embedding: z.string().min(1).default(AI_MODEL_DEFAULTS.embedding),
  image: z.string().min(1).default(AI_MODEL_DEFAULTS.image),
  schemaVersion: z.literal(1).default(1),
  // Phase 2: optional per-flow overrides (flow-id → model name). Absent means
  // "no overrides" — every flow inherits its role's model — so a Phase 1 doc
  // with no `perFlow` field parses unchanged (back-compat on read). Keys are
  // free-form strings so an unknown/retired flow-id in a stored doc never fails
  // the parse; the resolver only reads the key for the flow it asks about. Each
  // value is a non-empty model name — clearing an override drops the key
  // entirely rather than storing an empty string.
  perFlow: z.record(z.string(), z.string().min(1)).optional(),
  // Optional family home location (issue #382). Absent on every doc written
  // before this field existed, so it must stay optional — an old doc with no
  // `homeLocation` parses unchanged (back-compat on read). Cleared by deleting
  // the key entirely rather than storing an empty object.
  homeLocation: HomeLocationSchema.optional(),
  // Audit metadata: who last changed the doc and when (ms epoch). Optional so a
  // never-configured / defaulted doc still parses; the UI shows them when set.
  updatedAt: z.number().optional(),
  updatedBy: z.string().optional(),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;
