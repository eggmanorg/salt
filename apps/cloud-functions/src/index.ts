import { initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';
import { onCall, onCallGenkit, isSignedIn, HttpsError } from 'firebase-functions/https';
import {
  MatchOrCreateCanonWireInputSchema,
  CanonicaliseRecipeIngredientsWireInputSchema,
  AuthorRecipeWireInputSchema,
  DescribeRecipeSceneWireInputSchema,
  ExtractRecipeFromUrlWireInputSchema,
  ExtractRecipeFromPhotoWireInputSchema,
  IdentifyEquipmentWireInputSchema,
  PopulateEquipmentEntryWireInputSchema,
  RefreshWeatherForecastWireInputSchema,
  PHOTO_IMPORT_TIMEOUT_SECONDS,
  PROPOSE_SCHEDULE_TIMEOUT_SECONDS,
} from '@salt/domain/schemas';
import { enableFirebaseTelemetry } from '@genkit-ai/firebase';
import {
  initServerObservability,
  attachAiOtlpSpanProcessor,
  attachDistributedSpanProcessor,
} from '@salt/observability/server';
import { makeCallable, makeTracedCallable, APP_CHECK_ENFORCEMENT } from './tracedCallable.js';
import { runRefreshWeatherForecast } from './weather/refreshWeatherForecast.js';
import { registerGenkitDevTracing } from './genkitTracing.js';
import { reportFlowError } from './observability/reportServerError.js';
import { resolveServerEnvironment } from './observability/environment.js';
import { armCfTelemetry } from './observability/telemetryReady.js';
import { embedTextFlow } from './flows/embedText.js';
import { arbitrateCanonFlow } from './flows/arbitrateCanon.js';
import { matchOrCreateCanonFlow } from './flows/matchOrCreateCanon.js';
import { canonicaliseRecipeIngredientsFlow } from './flows/canonicaliseRecipeIngredients.js';
import { identifyEquipmentFlow } from './flows/identifyEquipment.js';
import { populateEquipmentEntryFlow } from './flows/populateEquipmentEntry.js';
import { parseRecipeIngredientsFlow } from './flows/parseRecipeIngredients.js';
import { chefChatFlow } from './flows/chefChat.js';
import { authorRecipeFlow } from './flows/authorRecipe.js';
import { describeRecipeSceneFlow } from './flows/describeRecipeScene.js';
import { describeEquipmentSubjectFlow } from './flows/describeEquipmentSubject.js';
import {
  extractRecipeFromUrlFlow,
  UrlImportError,
  type UrlImportFailureCode,
} from './flows/extractRecipeFromUrl.js';
import {
  extractRecipeFromPhotoFlow,
  PhotoImportError,
  type PhotoImportFailureCode,
} from './flows/extractRecipeFromPhoto.js';
import { generateChatTitleFlow } from './flows/generateChatTitle.js';
import { generateGuidedPlanFlow } from './flows/generateGuidedPlan.js';
import { extractProcessStagesFlow } from './flows/extractProcessStages.js';
import { proposeScheduleFlow } from './flows/proposeSchedule.js';
import { onShoppingListItemWrite } from './triggers/onShoppingListItemWrite.js';
import { onCanonItemWritten } from './triggers/onCanonItemWritten.js';
import { onRecipeWritten } from './triggers/onRecipeWritten.js';
import { handleListAiModels } from './ai/listAiModels.js';
import { handleTestModel } from './ai/testModel.js';

// Under the Functions emulator, hand firebase-admin the service-account identity
// up front so it never goes looking for one (issue #749, second call site).
//
// `getFunctions().taskQueue(...).enqueue()` — onCookTimerWrite's cook-timer
// enqueue — needs a service-account email for the task's OIDC token, and
// firebase-admin ALWAYS attempts the real lookup first: findServiceAccountEmail()
// → ApplicationDefaultCredential → the GCE metadata server at 169.254.169.254.
// It substitutes 'emulated-service-acct@email.com' only in the CATCH, after that
// request has already failed, and CLOUD_TASKS_EMULATOR_HOST does not shortcut it
// (see firebase-admin functions-api-client-internal.ts, enqueue → getServiceAccount).
// Under Docker Desktop for Mac that address is the same black hole that hung every
// Genkit flow (#753), so the lookup stalls the trigger locally; on a CI runner it
// merely fails fast and wastes the round trip. There is no GCP project to resolve
// an identity against under the emulator (demo-salt), so the lookup is doomed by
// construction either way.
//
// getExplicitServiceAccountEmail() short-circuits on `serviceAccountId` before any
// credential work, so setting it skips the request entirely. The value is exactly
// what firebase-admin would have substituted anyway, which is what makes this a
// pure subtraction: the enqueued task is byte-identical, minus the doomed request.
// FUNCTIONS_EMULATOR is set only by the emulator, so deployed functions keep
// resolving their real identity from the metadata server as before.
initializeApp(
  process.env['FUNCTIONS_EMULATOR']
    ? { serviceAccountId: 'emulated-service-acct@email.com' }
    : undefined,
);

// 512MiB is the memory floor for every function. The 256MiB default sits just
// below this codebase's resting footprint — firebase-admin, Genkit/OTel
// (enableFirebaseTelemetry), and posthog-node all load at module init — so a
// function OOMs on its first real context read (chefChat died at "263 MiB used",
// 7 over). Override UPWARD per function where proven (onCanonItemWritten's icon
// decode needs 1GiB).
//
// NB: firebase-functions bakes global options into each function's __endpoint
// EAGERLY at definition time, and ES imports evaluate before this line runs, so
// this only reaches the callables defined inline below. The top-imported modules
// (the triggers, regenerateCanonIcon, beforeMemberCreated) pin memory inline —
// the same reason they already pin region inline.
setGlobalOptions({ region: 'europe-west2', memory: '512MiB' });

// Drop W3CBaggagePropagator from the globally-registered propagator composite.
//
// enableFirebaseTelemetry() → Genkit's NodeSDK passes `propagator: undefined`, so
// BasicTracerProvider.register() builds the composite from OTEL_PROPAGATORS, whose
// default is 'tracecontext,baggage'. That puts W3CBaggagePropagator.extract() on the
// inbound path of every callable via runWithExtractedTraceContext(request.rawRequest
// .headers, …) — and @opentelemetry/core < 2.8.0 allocates unboundedly there when fed
// an oversized `baggage` header (CVE-2026-54285 / GHSA-8988-4f7v-96qf, dependabot #79).
// The fix ships in the OTel 2.x suite, which is blocked upstream on Genkit adopting it
// (#300), so we remove the REACHABILITY instead of the vulnerable code: nothing in this
// repo reads or writes baggage, and every trace-propagation path we rely on — the two
// runWith*TraceContext helpers, activeTraceparent(), Genkit's HTTP auto-instrumentation
// — is W3C tracecontext only. Set before enableFirebaseTelemetry() below, which is where
// the composite is built. `||=` (not `??=`) so an empty-string env is also replaced;
// a deliberate deploy-time OTEL_PROPAGATORS still wins. Revisit when #300 lands.
process.env['OTEL_PROPAGATORS'] ||= 'tracecontext';

// Telemetry, owned at module load so it's in place before any flow runs:
//
//  1. enableFirebaseTelemetry() owns the single process-wide OTel
//     NodeTracerProvider — it is the Genkit-native telemetry integration, so
//     every exported callable flow and the onCanonItemWritten trigger emit
//     spans/metrics through it (to Firebase Genkit Monitoring in prod). Wrapped
//     so a telemetry-init failure can never take down the CF.
//     Once it resolves (the provider is registered), attachAiOtlpSpanProcessor()
//     adds our PostHog AI-OTLP span processor to that same provider, so Genkit's
//     AI spans are remapped (genkit:* → gen_ai.*/ai.*) and shipped to PostHog LLM
//     observability as real traces (#356), and attachDistributedSpanProcessor()
//     adds — alongside it — the distributed-tracing processor, which ships EVERY
//     finished span to PostHog's /i/v1/traces endpoint so the whole invocation
//     (canon matching + parents + infra) renders as one coherent trace correlated
//     by trace_id to the AI generations. Both no-op without POSTHOG_API_KEY and
//     are suppressed under GENKIT_TELEMETRY_SERVER (local dev → Genkit Dev UI only;
//     set SALT_AI_OTLP_LOCAL=1 to opt back in for deliberate local verification).
//
//     It is NOT safe under the Functions emulator (issue #749) — hence the gate
//     below. The emulator sets K_SERVICE in every function worker, so
//     @genkit-ai/firebase treats the process as deployed GCP and resolves
//     credentials for trace/metric export; that lookup reaches the GCE metadata
//     server at 169.254.169.254, which inside Docker Desktop for Mac is a black
//     hole (packets dropped, no RST, no refusal). The promise then NEVER settles
//     and EVERY Genkit flow blocks behind it — measured on a trivial no-AI flow:
//     3 ms with the boot skipped, never returned with it. The failure mode is a
//     silent unbounded hang, not a crash, which is why it went unnoticed: locally
//     it made the whole AI e2e surface deterministically red. GENKIT_ENV=dev does
//     NOT make it safe (it is unset in the e2e stack, and setting it was tested
//     and still hangs); nor does METADATA_SERVER_DETECTION=none (tested). Nothing
//     is lost by skipping it: the emulator project (demo-salt) has no GCP backend
//     to export to, so the credential lookup is doomed by construction. Precedent
//     for the same root cause fixed at one call site: onCanonItemWritten.ts skips
//     icon generation under the fake seam because the Storage upload authenticates
//     the same way and hangs the trigger.
//  2. PostHog server telemetry (posthog-node) — the cf-path canon.match event and
//     server error reporting (AI model/token/cost now rides the AI-OTLP spans in
//     (1), not a flat $ai_generation event). No-ops when POSTHOG_API_KEY is absent
//     (e.g. an emulator run without the secret).
//  3. registerGenkitDevTracing() points Genkit's native trace export at the
//     local Dev UI when GENKIT_TELEMETRY_SERVER is set (pnpm dev:emulators).

// Skip the GCP telemetry boot in a Functions-emulator worker (issue #749 — see
// (1) above for the mechanism). FUNCTIONS_EMULATOR is set ONLY by the emulator, so
// prod and staging can never take this branch and their telemetry is byte-identical
// to before; this is the same gate shape as genkit.ts's sandboxedRuntime switch.
// SALT_AI_OTLP_LOCAL=1 opts back in, so deliberate local verification of the
// PostHog AI-OTLP span pipeline still works — that run pays the metadata stall,
// which is the cost of asking for the real pipeline.
const skipGcpTelemetryBoot =
  Boolean(process.env['FUNCTIONS_EMULATOR']) && process.env['SALT_AI_OTLP_LOCAL'] !== '1';

try {
  // Arm the trigger telemetry-readiness gate (issue #370) with the boot promise:
  // Firestore triggers await it before extracting a supplied trace, so a cold-
  // started handler does not run the OTel propagator/context-manager before this
  // async init lands (which silently dropped the trace and re-rooted the flow).
  // armCfTelemetry SETTLES readiness on rejection too, so a telemetry-export setup
  // failure (e.g. no GCP creds locally) degrades to a root trace without a separate
  // .catch and without an unhandled rejection. The gate stays ARMED on the skipped
  // path — with an already-resolved promise — so whenCfTelemetryReady() settles
  // immediately instead of every cold-started trigger burning the full
  // CF_TELEMETRY_READY_TIMEOUT_MS (10 s) fallback waiting for a boot that will
  // never happen.
  armCfTelemetry(
    skipGcpTelemetryBoot
      ? Promise.resolve()
      : enableFirebaseTelemetry().then(() => {
          attachAiOtlpSpanProcessor();
          attachDistributedSpanProcessor();
        }),
  );
} catch {
  // enableFirebaseTelemetry is async, but guard the synchronous path too.
}
initServerObservability(process.env['POSTHOG_API_KEY'] ?? '', resolveServerEnvironment());
registerGenkitDevTracing();

const geminiApiKey = defineSecret('GEMINI_API_KEY');
// PostHog project API key for server-side telemetry (posthog-node) in the
// AI/match functions. Optional — when unset, server observability no-ops and
// firebase-functions/logger still emits match logs additively.
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

// APP_CHECK_ENFORCEMENT (monitor-first App Check, #145) is owned by
// ./tracedCallable.js so the traced-callable factory applies it uniformly; it is
// imported here for the onCallGenkit / non-traced onCall callables below.

export const embedText = onCallGenkit(
  {
    ...APP_CHECK_ENFORCEMENT,
    secrets: [geminiApiKey],
    authPolicy: isSignedIn(),
  },
  embedTextFlow,
);

export const arbitrateCanon = onCallGenkit(
  {
    ...APP_CHECK_ENFORCEMENT,
    // posthogApiKey bound so this function's AI spans reach PostHog when
    // arbitrateCanon runs as its own callable. The key is both the posthog-node
    // key (canon.match / error reporting) AND the bearer token for the AI-OTLP
    // span exporter; without it the exporter no-ops in this function's process
    // (it only ships when invoked inside a posthog-bound parent like
    // matchOrCreateCanon).
    secrets: [geminiApiKey, posthogApiKey],
    authPolicy: isSignedIn(),
  },
  arbitrateCanonFlow,
);

// ─── Browser→CF trace continuity (issue #362, Phase 3) ────────────────────────
//
// These USER-INITIATED callables run their flow within a W3C trace context so the
// flow span nests under one coherent invocation trace instead of re-rooting. The
// whole entrypoint sequence — auth → wire safeParse → strip `traceparent` →
// env-gated trace propagation (browser-supplied field WINS over the inbound GCP
// header) → report-and-flush — lives in
// makeTracedCallable (./tracedCallable.ts, issue #415), so each callable below is
// just a declaration and the happy-path span flush is guaranteed uniform.
export const matchOrCreateCanon = makeTracedCallable({
  wireSchema: MatchOrCreateCanonWireInputSchema,
  flow: matchOrCreateCanonFlow,
  options: { secrets: [geminiApiKey, posthogApiKey] },
});

// Batch callable: one canon-collection read + batched embeddings for a full
// recipe. Mirrors matchOrCreateCanon's port-wiring but fans inputs through
// matchOrCreateBatch so later items see items created earlier in the batch.
// Memory-heavy (whole-canon read + batched embeddings); covered by the 512MiB
// global floor — at 256 it OOM-killed (500/504 + a browser CORS error, since the
// dead response carries no CORS headers).
export const canonicaliseRecipeIngredients = makeTracedCallable({
  wireSchema: CanonicaliseRecipeIngredientsWireInputSchema,
  flow: canonicaliseRecipeIngredientsFlow,
  options: { secrets: [geminiApiKey, posthogApiKey], timeoutSeconds: 120 },
});

// Add-equipment grouping (issue #361). The multi-step add-equipment action fires
// identifyEquipment then populateEquipmentEntry with human think-time between; the
// browser mints ONE trace id and supplies the SAME `traceparent` to both calls, so
// both flows nest under one trace instead of re-rooting two. posthogApiKey is the
// bearer token for the AI-OTLP span exporter (and the posthog-node key) AND lets
// the entrypoint catch report a flow failure.
export const identifyEquipment = makeTracedCallable({
  wireSchema: IdentifyEquipmentWireInputSchema,
  flow: identifyEquipmentFlow,
  options: { secrets: [geminiApiKey, posthogApiKey] },
});

export const populateEquipmentEntry = makeTracedCallable({
  wireSchema: PopulateEquipmentEntryWireInputSchema,
  flow: populateEquipmentEntryFlow,
  options: { secrets: [geminiApiKey, posthogApiKey] },
});

// Recipe lists are larger prompts than single-entry flows — allow 90s so the
// 55s withAiTimeout has sufficient headroom within the function lifetime.
export const parseRecipeIngredients = onCallGenkit(
  {
    ...APP_CHECK_ENFORCEMENT,
    // posthogApiKey bound so this function's AI spans reach PostHog: it is the
    // bearer token for the AI-OTLP span exporter (and the posthog-node key).
    // Without it the exporter no-ops in this function's process, so this
    // callable's AI usage never lands in PostHog.
    secrets: [geminiApiKey, posthogApiKey],
    authPolicy: isSignedIn(),
    timeoutSeconds: 90,
  },
  parseRecipeIngredientsFlow,
);

// Librarian: conversation → recipe draft with canon-matched ingredients. The
// default error handler reports the librarian flow failure (AI + batch
// canonicalise) and re-throws unchanged. Memory comes from the 512MiB global
// floor. #415 added the happy-path span flush this callable previously lacked.
export const authorRecipe = makeTracedCallable({
  wireSchema: AuthorRecipeWireInputSchema,
  flow: authorRecipeFlow,
  options: { secrets: [geminiApiKey, posthogApiKey], timeoutSeconds: 120 },
});

// Scene brief on demand (issue #522, Phase 3): read the recipe → return the
// art-direction paragraph that will direct its hero image. Two shapes, one flow:
// with a `currentBrief` + `hint` it REVISES ("make it summery", folded through);
// with neither it authors from scratch, which is what "start over" sends so a
// substantially rewritten recipe can shed art direction describing the old dish.
//
// PERSISTS NOTHING — deliberately. The brief goes back to the dialog, still
// editable, and only ever reaches Firestore when the user commits by pressing
// Regenerate (regenerateRecipeImage stamps `imageBrief`). That is the economics of
// the feature: revising is a fraction of a cent and touches no doc, so you can
// iterate the art direction freely and only pay for an image once it is right —
// three brief revisions and one good image, not three images and a shrug. A
// revision that auto-saved would also silently overwrite the brief behind the
// image currently on screen, which is not what "let me see it first" means.
//
// Auth posture mirrors the image callables: signed-in only, NO admin gate —
// recipes are member-writable by design and the gate here is on AI cost, not on
// authority. This is a plain text flow (no fetch, no image), so the house
// text-flow timeout is plenty.
export const describeRecipeScene = makeTracedCallable({
  wireSchema: DescribeRecipeSceneWireInputSchema,
  flow: describeRecipeSceneFlow,
  options: { secrets: [geminiApiKey, posthogApiKey], timeoutSeconds: 90 },
});

// Equipment description on demand (issue #885): the same flow the manifest
// trigger runs, reachable from the item page's two new buttons. With a
// `currentBrief` + a `hint` it REVISES ("it's matte black, not cream", folded
// through the sentence); with neither it authors from scratch, which is what
// "Start over" sends so a description edited into a corner can be thrown away.
//
// PERSISTS NOTHING — deliberately, and this is the load-bearing property.
// `drawEquipmentIcon` remains the ONLY writer of `subjectBrief` (it stamps it
// inside the same transaction as `sourceName`), so the revised sentence lives in
// the browser's textarea until the user presses Draw. That is the economics of
// the review gate: a revision is a fraction of a penny and touches no document,
// so you correct the words as often as you like and buy one picture once they
// are right. A revision that auto-saved would also silently overwrite the words
// behind the picture currently on screen.
//
// Plain onCallGenkit rather than makeTracedCallable, same as generateGuidedPlan
// below: one press, one call, no cross-invocation pair like identifyEquipment →
// populateEquipmentEntry, so there is no browser trace to unify and the traced
// factory would buy only a wire envelope to maintain. Signed-in, no admin gate —
// equipment is member-editable and the gate here is on AI cost, not authority.
// 90s so the flow's 55s withAiTimeout has headroom. That is ABOVE the callable
// client's 70s default, not inside it — this comment claimed the opposite until
// #928, and the arithmetic was the whole of finding B2-010: the browser gave up
// at 70s while the function ran on to 90. `callDescribeEquipmentSubject`
// (`firebase-sync/src/equipmentIconSubscription.ts`) now declares a matching
// 90s client timeout, so raising this number means raising that one too.
// Memory comes from the global 512MiB floor: this callable is defined inline,
// below setGlobalOptions, so unlike a top-imported module it genuinely inherits
// it (issue #883).
export const describeEquipmentSubject = onCallGenkit(
  {
    ...APP_CHECK_ENFORCEMENT,
    secrets: [geminiApiKey, posthogApiKey],
    authPolicy: isSignedIn(),
    timeoutSeconds: 90,
  },
  describeEquipmentSubjectFlow,
);

// Guided plan (issue #751, Phase 1): read the recipe → write the plan → return
// it. Takes only a recipe id; the flow reads the recipe with the Admin SDK, so
// the plan is always about the recipe that is actually stored.
//
// PERSISTS THE DOCUMENT ITSELF (issue #1416), and is the odd one out among the
// flows either side of it here. It writes `guidedPlans/{recipeId}` before it
// returns, and so owns the control fields a generated plan carries: the
// prep-entry ids, `needs_approval`, `recipeUpdatedAtAtSave` and the timestamps.
// The client's `guidedPlanService.saveGuidedPlan` — the HUMAN save — is the other
// writer of that document. Why the flow rather than the browser, and where the
// two-writer split is pinned, are in the flow's own header; the client write this
// replaced is not to be restored.
//
// Plain onCallGenkit rather than makeTracedCallable: there is no browser trace id
// to unify here (one call, one click, no cross-invocation pair like the equipment
// callables), so the traced factory would buy only a wire envelope to maintain.
// 210s so the flow's 180s withAiTimeout has headroom for the Firestore read and
// the response hop. NOT "inside the callable client's 70s default" — this comment
// once said that, and the number has always exceeded 70, which is finding B2-010
// in one line: the browser abandoned the call early while the function ran on and
// went on writing. `callGenerateGuidedPlan`
// (`firebase-sync/src/guidedPlanCallables.ts`) declares a matching 210s client
// timeout, so raising this number means raising that one too — and the flow's own
// budget is the third. THE LOWEST OF THE THREE GOVERNS; they are only useful
// together.
//
// Why 210 and not the 90 this carried before: the flow writes a note for every
// step of the recipe, so its latency scales with the length of the method, and
// 90s was below the cost of an ordinary one. The measurements, and why capping
// the model's thinking budget does not substitute for this, are at
// GUIDED_PLAN_TIMEOUT in `flows/generateGuidedPlan.ts` — the number's reasoning
// lives beside the number that drives it, not here.
//
// `pro` (see the flow): cue quality IS the feature, and the volume is a handful of
// recipes ever. posthogApiKey is the bearer token for the AI-OTLP span exporter as
// well as the posthog-node key — without it this function's AI usage never lands
// in PostHog.
export const generateGuidedPlan = onCallGenkit(
  {
    ...APP_CHECK_ENFORCEMENT,
    secrets: [geminiApiKey, posthogApiKey],
    authPolicy: isSignedIn(),
    timeoutSeconds: 210,
  },
  generateGuidedPlanFlow,
);

// Process stages (issue #806, phase 2 of epic #778): read the recipe → return the
// ordered stages its method describes, each labelled `active` or `wait`. Takes only
// a recipe id, for the same reason the guided plan does. PERSISTS NOTHING — the
// stages land on the formula screen for review, and the user's Save is what writes
// them onto `formulas/{recipeId}`.
//
// Plain onCallGenkit, same call as generateGuidedPlan and for the same reason: one
// call from one tap, no cross-invocation pair to unify, so the traced factory would
// buy only a wire envelope to maintain. 90s for the flow's 55s withAiTimeout —
// ABOVE the callable client's 70s default, not inside it, which is what this
// comment used to claim and what #928 finding B2-010 was. `callExtractProcessStages`
// (`firebase-sync/src/formulaCallables.ts`) now declares a matching 90s client
// timeout, so raising this number means raising that one too.
//
// `lite` (see the flow): mechanical extraction, not judgement.
export const extractProcessStages = onCallGenkit(
  {
    ...APP_CHECK_ENFORCEMENT,
    secrets: [geminiApiKey, posthogApiKey],
    authPolicy: isSignedIn(),
    timeoutSeconds: 90,
  },
  extractProcessStagesFlow,
);

// The schedule (issue #812, phase 2 of epic #778): read the recipe and its formula
// → return the process RESTRUCTURED to land at the time asked for, plus the words
// explaining what moved and why. Ids and a wall clock in, stages and prose out — no
// timestamps and no weights, because `resolveSchedule` computes the clock and
// `solveFormula` computes the grams. PERSISTS NOTHING: the proposal is reviewed as
// a diff and the user's Start is what freezes a batch.
//
// Plain onCallGenkit, same as its sibling above: one call from one tap, nothing to
// unify across invocations, so `makeTracedCallable` would buy only a wire envelope
// to maintain (apps/cloud-functions/CLAUDE.md, "New callable flows that don't need
// this nesting can use onCallGenkit").
//
// THE THREE TIMEOUTS ARE ONE SET OF CONSTANTS, in @salt/domain/schemas, shared with
// the firebase-sync wrapper: AI budget 150 s < callable client 170 s < this
// function 180 s. The spike measured this flow at 65–108 s uncapped, so the
// callable client's 70 s default would abandon a perfectly healthy call — which is
// why the wrapper passes an explicit timeout and why these cannot be allowed to
// drift apart.
//
// `pro` (see the flow): judgement, not transcription.
export const proposeSchedule = onCallGenkit(
  {
    ...APP_CHECK_ENFORCEMENT,
    secrets: [geminiApiKey, posthogApiKey],
    authPolicy: isSignedIn(),
    timeoutSeconds: PROPOSE_SCHEDULE_TIMEOUT_SECONDS,
  },
  proposeScheduleFlow,
);

// SSRF-hardened URL import (recipe URL import epic). A custom onError maps the
// flow's UrlImportError taxonomy to specific HttpsError codes with user-safe copy
// (no internal SSRF detail leaked). The flow does outbound DNS + a network fetch
// in addition to the AI call, so the function timeout is generous. Memory comes
// from the 512MiB global floor.
function mapUrlImportFailure(code: UrlImportFailureCode): HttpsError {
  switch (code) {
    case 'invalid-url':
      return new HttpsError('invalid-argument', "That doesn't look like a valid web address.");
    case 'blocked-url':
      // No internal detail leaked.
      return new HttpsError('invalid-argument', "That link can't be imported.");
    case 'fetch-failed':
      return new HttpsError(
        'unavailable',
        "We couldn't reach that page — it may be down, paywalled, or blocking us.",
      );
    case 'not-a-recipe':
      return new HttpsError('failed-precondition', "We couldn't find a recipe on that page.");
    case 'ai-failed':
      return new HttpsError(
        'internal',
        'The recipe reader had trouble with that page — try again, or add it manually.',
      );
  }
}

export const extractRecipeFromUrl = makeTracedCallable({
  wireSchema: ExtractRecipeFromUrlWireInputSchema,
  flow: extractRecipeFromUrlFlow,
  options: { secrets: [geminiApiKey, posthogApiKey], timeoutSeconds: 120 },
  // A bad wire envelope is a malformed URL from the client — user-safe copy.
  invalidArgumentMessage: "That doesn't look like a valid web address.",
  // Report the GENUINE cause before mapping to a user-facing HttpsError — the raw
  // error/stack, never the HttpsError envelope. The UrlImportError taxonomy
  // encodes EXPECTED user outcomes (bad/blocked URL, unreachable page,
  // not-a-recipe) which are suppressed per policy; only `ai-failed` (the
  // recipe-reader model itself failing) is the unexpected one worth surfacing. A
  // non-UrlImportError throw is an unexpected bug → report.
  onError: async (err) => {
    if (err instanceof UrlImportError) {
      if (err.code === 'ai-failed') await reportFlowError(err);
      throw mapUrlImportFailure(err.code);
    }
    await reportFlowError(err);
    throw new HttpsError(
      'internal',
      'The recipe reader had trouble with that page — try again, or add it manually.',
    );
  },
});

// Import from photographs of a cookbook page (issue #649, Phase 3). Same shape as
// the URL import — a user-initiated, AI-heavy callable that persists the recipe
// it extracts — over its OWN failure taxonomy: none of the URL codes
// (invalid-url, blocked-url, fetch-failed) mean anything when the input is a
// photograph, so UrlImportFailureCode is deliberately NOT widened.
//
// The photographs are request-scoped: they ride in on the payload, go to the
// model, and are discarded. Nothing is written to Storage.
function mapPhotoImportFailure(code: PhotoImportFailureCode): HttpsError {
  switch (code) {
    case 'invalid-photos':
      // Raised by the wire safeParse, not the flow — see invalidArgumentMessage.
      return new HttpsError('invalid-argument', "Those photos can't be imported.");
    case 'unreadable-photos':
      // Blurry/dark and no-recipe-on-the-page are indistinguishable server-side,
      // so the copy has to cover both honestly.
      return new HttpsError(
        'failed-precondition',
        "We couldn't read a recipe from those photos — try a sharper, brighter shot of the whole page.",
      );
    case 'import-failed':
      return new HttpsError(
        'internal',
        'The recipe reader had trouble with those photos — try again, or add it manually.',
      );
  }
}

export const extractRecipeFromPhoto = makeTracedCallable({
  wireSchema: ExtractRecipeFromPhotoWireInputSchema,
  flow: extractRecipeFromPhotoFlow,
  // PHOTO_IMPORT_TIMEOUT_SECONDS is shared with the firebase-sync wrapper, which
  // passes it as the callable client's explicit `HttpsCallableOptions.timeout`.
  // Without that the client's 70s default would truncate a slow multi-page
  // extraction while the server was still working — one constant, no drift.
  options: {
    secrets: [geminiApiKey, posthogApiKey],
    timeoutSeconds: PHOTO_IMPORT_TIMEOUT_SECONDS,
  },
  // A bad wire envelope is a bad payload from the capture UI: no images, more
  // than four, an unsupported content type, or empty bytes.
  invalidArgumentMessage: "Those photos can't be imported.",
  // Report the GENUINE cause before mapping to a user-facing HttpsError. The
  // PhotoImportError taxonomy encodes EXPECTED user outcomes — a photograph too
  // blurry to read, or a page with no recipe on it — which are suppressed per
  // policy; only `import-failed` (the recipe reader itself failing) is the
  // unexpected one worth surfacing. A non-PhotoImportError throw is a bug →
  // report.
  onError: async (err) => {
    if (err instanceof PhotoImportError) {
      if (err.code === 'import-failed') await reportFlowError(err);
      throw mapPhotoImportFailure(err.code);
    }
    await reportFlowError(err);
    throw new HttpsError(
      'internal',
      'The recipe reader had trouble with those photos — try again, or add it manually.',
    );
  },
});

export const chefChat = onCallGenkit(
  {
    ...APP_CHECK_ENFORCEMENT,
    secrets: [geminiApiKey, posthogApiKey],
    authPolicy: isSignedIn(),
    timeoutSeconds: 120,
    // Memory-heavy: pro-tier streaming + equipment/recipe/history context reads.
    // Covered by the 512MiB global floor — at 256 it OOM'd ("263 MiB used"), and
    // the SIGKILL killed the instance before enableFirebaseTelemetry flushed the
    // flow span, so it never appeared in Genkit Monitoring.
  },
  chefChatFlow,
);

export const generateChatTitle = onCallGenkit(
  {
    ...APP_CHECK_ENFORCEMENT,
    secrets: [geminiApiKey, posthogApiKey],
    authPolicy: isSignedIn(),
  },
  generateChatTitleFlow,
);

// Admin-only AI model catalog + probe (Phase 3 — admin-managed model selection).
// Both re-check admin server-side (issue #155) and declare the AI secret so the
// catalog fetch / probe can read GEMINI_API_KEY from process.env. App Check
// monitor-first like every other callable. POSTHOG_API_KEY is bound so an
// unexpected throw can be reported (the handlers map every EXPECTED operational
// outcome to an HttpsError / a `{ ok:false }` result, so only a non-HttpsError
// escaping is reported — see reportUnexpected).
//
// The report-unless-HttpsError rule these two needed is now the makeCallable
// default (#920): an HttpsError is an outcome the handler / requireAdmin
// deliberately classified (auth, permission, unavailable catalog) — expected, so
// suppressed; anything else is a genuine bug and is reported before it
// propagates. They used to carry a local `reportUnexpected` wrapper that said
// exactly that; the factory says it once, for every callable, and also flushes.
export const listAiModels = makeCallable({
  options: { secrets: [geminiApiKey, posthogApiKey] },
  handler: (request) => handleListAiModels(request),
});

export const testModel = makeCallable({
  options: { secrets: [geminiApiKey, posthogApiKey] },
  handler: (request) => handleTestModel(request),
});

// Forecast fetch + cache pipeline (issue #382, Phase 2). Callable by any
// signed-in member — deliberately NOT admin-gated (issue #408): the meal planner
// silently refreshes a stale forecast on access for every member
// (weatherService.ensureFreshForecast, force=false), and a manual refresh button
// in the settings UI passes force=true to bypass the staleness re-check. It
// follows the same browser-supplied-trace pattern as the canon-matching callables
// (validate the WIRE envelope, strip `traceparent`, run within the propagated
// trace context, report + flush), so it uses the same makeTracedCallable factory.
// No AI, so only posthogApiKey is bound (error reporting + the distributed-trace
// OTLP bearer); no geminiApiKey, no withAiTimeout. The heavy lifting (read home
// location, staleness re-check, Open-Meteo fetch + validate, pure aggregation,
// Firestore write) lives in runRefreshWeatherForecast; the default onError reports
// an unexpected server failure (Firestore read/write, Open-Meteo fetch, or a
// malformed external payload) and re-throws unchanged.
export const refreshWeatherForecast = makeTracedCallable({
  wireSchema: RefreshWeatherForecastWireInputSchema,
  flow: (input) => runRefreshWeatherForecast(input),
  options: { secrets: [posthogApiKey], timeoutSeconds: 30 },
});

export { onShoppingListItemWrite };
export { onCanonItemWritten };
export { onRecipeWritten };
export { onCookTimerWrite } from './triggers/onCookTimerWrite.js';
export { onCookTimerDispatch } from './triggers/onCookTimerDispatch.js';
// Batch stage reminders (issue #812) — the cook-timer Cloud Tasks pair, mirrored
// for a run that lasts hours or weeks. NOTE for deploys: `onBatchStageDispatch` is
// a NEW task queue, so the deployer service account needs the Cloud Tasks
// permissions before it will provision (see the cook timer's own history).
export { onBatchWritten } from './triggers/onBatchWritten.js';
export { onBatchStageDispatch } from './triggers/onBatchStageDispatch.js';
// Standalone kitchen timers (issue #842) — the same Cloud Tasks pair again, for a
// timer that belongs to nobody's cook. NOTE for deploys: `onKitchenTimerDispatch`
// is a THIRD task queue. Both existing queue functions are confirmed live in
// staging, so the deployer service account already carries the Cloud Tasks
// permissions — but watch the first deploy, because a failed queue-create leaves
// the function reporting "Skipped (No changes detected)" for ever with no queue
// behind it.
export { onKitchenTimerWrite } from './triggers/onKitchenTimerWrite.js';
export { onKitchenTimerDispatch } from './triggers/onKitchenTimerDispatch.js';
// Product-form pictograms (issue #871) — the canon icon pipeline pointed at a
// second collection. NOTE for deploys: it writes a NEW Storage prefix
// (`product-form-icons/`), so storage.rules must be deployed before any icon
// will load in the browser.
export { onProductFormWritten } from './triggers/onProductFormWritten.js';
// Generic kitchen-tool pictograms (issue #882) — the same pipeline pointed at the
// curated `kitchenTools` vocabulary. NOTE for deploys: it writes a NEW Storage
// prefix (`kit-icons/`), so storage.rules must be deployed before any tool icon
// will load in the browser.
export { onKitchenToolWritten } from './triggers/onKitchenToolWritten.js';
// Equipment pictogram BRIEFS (issue #877). Level-triggered on the single
// equipment manifest doc; it authors appliance descriptions and NEVER an image —
// the picture is drawn by `drawEquipmentIcon` when the user presses Draw. It also
// reconciles icon docs for items that have been deleted, which is what lets
// `sweepOrphanedStorage` reclaim their Storage objects.
export { onEquipmentManifestWritten } from './triggers/onEquipmentManifestWritten.js';
export { regenerateCanonIcon } from './callables/regenerateCanonIcon.js';
export { regenerateProductFormIcon } from './callables/regenerateProductFormIcon.js';
export { regenerateRecipeImage } from './callables/regenerateRecipeImage.js';
export { setRecipeImageUpload } from './callables/setRecipeImageUpload.js';
export { getImagePrompt } from './callables/getImagePrompt.js';
export { setIconUpload } from './callables/setIconUpload.js';
export { redoRecipeKit } from './callables/redoRecipeKit.js';
// The observation photo (issue #812, phase 4) — the same auth-gated upload one
// level deeper, writing `batch-images/{batchId}/{observationId}.webp` and stamping
// the URL onto the observation with a partial update. NOTE for deploys: it writes a
// NEW Storage prefix, which storage.rules must be deployed for before the log will
// render a photo.
export { setObservationImageUpload } from './callables/setObservationImageUpload.js';
// The equipment pictogram's Draw / Hide button (issue #877). Runs the image flow
// and sharp INLINE — the user is waiting — and stamps the result back with a
// partial update. NOTE for deploys: it writes a NEW Storage prefix
// (`equipment-icons/`), which storage.rules must be deployed for before the icons
// will render.
export { drawEquipmentIcon } from './callables/drawEquipmentIcon.js';
export { listPushoverDevices } from './callables/listPushoverDevices.js';
export { beforeMemberCreated } from './auth/beforeMemberCreated.js';
export { sweepOrphanedStorage } from './maintenance/sweepOrphanedStorage.js';
export { remindShoppingDay } from './maintenance/remindShoppingDay.js';
export { snapshotVolumetrics } from './maintenance/snapshotVolumetrics.js';
export { requestEmailOtp } from './callables/requestEmailOtp.js';
export { verifyEmailOtp } from './callables/verifyEmailOtp.js';
