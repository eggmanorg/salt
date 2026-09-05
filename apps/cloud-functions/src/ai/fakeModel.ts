import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { googleAI } from '@genkit-ai/google-genai';
import type { ModelAction } from 'genkit/model';
import { AI_FLOW_IDS, type AiFlowId } from '@salt/domain/schemas';
import { ai } from '../genkit.js';
import { resolveModel } from './resolveModel.js';

// ─────────────────────────────────────────────────────────────────────────────
// E2E fake-model seam (test-infra Phase 1).
//
// PURPOSE
//   Under the Functions emulator ONLY, swap the Genkit *model* used by an AI
//   flow for a deterministic fake whose answer is read from Firestore. The full
//   callable → flow → Firestore-write pipeline still runs unchanged; only the
//   model output is faked. This lets e2e specs assert AI-driven UI behaviour
//   without a live Gemini key and without flaky model output.
//
//   The real model path is BYTE-FOR-BYTE unchanged when the flag is off — this
//   module's only entrypoint, `flowModel`, returns exactly the production
//   `googleAI.model(await resolveModel(flowId))` when `FUNCTIONS_AI_FAKE`
//   is not '1'. The fake is unreachable in production (the flag is never set
//   there; only the emulator harness sets it).
//
// HARD GATE
//   Activates ONLY when `process.env.FUNCTIONS_AI_FAKE === '1'`. The e2e harness
//   sets this on the Functions emulator (see docker-compose.test.yml). It is
//   never set in any deployed environment.
//
// ─────────────────────────────────────────────────────────────────────────────
// CROSS-PROCESS STUB CONTRACT (read this before wiring a new flow in a later
// phase — phases 2–6 all depend on it)
//
//   `window.__e2e.stubAi(flowName, response)` runs in the BROWSER; this fake
//   model runs in the CLOUD FUNCTIONS process. They cannot share memory. The
//   emulator's Firestore IS shared between both, so it is the rendezvous:
//
//     • The browser writes the canned answer to `_e2e_ai_stubs/{flowName}`.
//       Document shape: `{ response: <JSON>, updatedAt: <ISO string> }` where
//       `response` is the exact object the flow's `ai.generate({ output: ... })`
//       should resolve to (i.e. the structured `result.output`).
//     • This fake model reads `_e2e_ai_stubs/{flowName}` and returns
//       `JSON.stringify(response)` as the model's text content. Genkit's
//       `output: { schema }` formatter then parses that text back into
//       `result.output`, exactly as a real model response would be parsed.
//
//   KEYING: by flow name only (one stub per flow). This is deliberately simple
//   and sufficient for Phase 1's single-call specs. Flow name === Genkit flow
//   name === `AiFlowId` (e.g. 'populateEquipmentEntry', 'parseRecipeIngredients',
//   'chefChat'). A later phase that needs per-input answers can extend the key
//   to `{flowName}__{inputHash}` and have `stubAi` accept an optional input
//   matcher — change BOTH the writer (e2eHooks.ts) and this reader together.
//
//   COLLECTION: `_e2e_ai_stubs`. The underscore prefix marks it as test-only
//   scaffolding; it never exists in production Firestore.
//
// WIRING A FLOW (per later phase)
//   Replace the flow's model expression
//       googleAI.model(await resolveModel(flowId))
//   with
//       await flowModel(flowId)
//   Everything else (system prompt, output schema, withAiTimeout) stays. When
//   the flag is off this is a no-op; when on, the flow's model reads its stub.
//   This swaps the MODEL, not the callable boundary — the contract CLAUDE.md
//   requires ("replace the model, not the callable boundary").
//
// WHAT IS NOT ON THIS SEAM, AND WHY (issue #935, phase 4; updated #1193)
//   Every text-generation flow in `src/flows` now takes its model from
//   `flowModel`. That is the claim and it is a BOUNDED one — these sit outside
//   it deliberately, so "nothing reaches Gemini under the flag" would be false:
//
//     • The three pictogram flows through `defineIconFlow` —
//       `generateCanonIcon`, `generateEquipmentIcon`, `generateKitchenToolIcon`
//       — are NOT on this seam: this fake emits TEXT and cannot stand in for
//       image media. They have their OWN fake, `ai/fakeImageModel.ts`
//       (`imageFlowModel`), wired at `defineIconFlow.ts`'s model-resolution
//       point (issue #1193) — though only `generateEquipmentIcon` is actually
//       reached under the flag; the other two are already short-circuited one
//       level up, in `iconWriteTrigger.ts`, untouched by #1193 (see
//       `fakeImageModel.ts`'s header for why).
//     • `generateRecipeImage` still calls the real model under the flag, but
//       needs no fake: its only call site (`onRecipeWritten.ts`'s
//       `maybeGenerateImage`) already returns on `aiFakeEnabled()` before the
//       flow is ever invoked, so it is unreachable under the flag today
//       (verified against the tree for issue #1193).
//     • `embedText` — an embedder is not a model action, so `flowModel` cannot
//       return one. Its seam is `ai/fakeEmbedding.ts`; since #935 the batch
//       adapter inherits that one by delegating to the flow rather than keeping
//       a second short-circuit.
//     • `arbitrateCanon` and `arbitrateProductForm` — both SHORT-CIRCUIT under
//       the flag instead of using a fake model, returning the already-degraded
//       answer ('no-match' / `{ kind: 'none' }`). The reasoning is written at
//       each site and both stay as they are.
//     • `ai/testModel.ts` — the admin "test this model" probe, which exists to
//       call a model id an admin typed. Faking it would defeat its only purpose.
//
//   Nothing enforces that list. It states where the seam reaches today, and a
//   flow added tomorrow with `googleAI.model(...)` written out by hand would sit
//   outside it silently. What IS enforced is narrower, and worth not confusing
//   with it: registry membership, by the single-argument `resolveModel(flowId)`
//   signature (issue #935, phase 1).
//
//   Four flows are driven by a TRIGGER rather than by a spec —
//   `identifyRecipeKit`, `estimateRecipeTimes`, `describeRecipeScene` on every
//   recipe write and `describeEquipmentSubject` on every equipment-manifest
//   write — and every one of those triggers returns on `aiFakeEnabled()` before
//   it reaches its flow call, so under this harness none of the four is ever
//   invoked and the loud throw below never fires for them. A spec that drives
//   one of these flows directly through its deployed callable (recipe
//   art-direction, equipment describe) still hits the throw and still needs
//   `stubAi()` — that path is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/** Firestore collection holding one canned answer per flow. Test-only. */
export const E2E_AI_STUB_COLLECTION = '_e2e_ai_stubs';

/** True only under the emulator harness; never set in any deployed env. */
export function aiFakeEnabled(): boolean {
  return process.env['FUNCTIONS_AI_FAKE'] === '1';
}

// One fake ModelAction per flow. Genkit forbids defining actions at request
// time ("Cannot define new actions at runtime"), so these MUST be created at
// module load, not lazily inside a flow. We register one per AiFlowId up front
// when the flag is on; each closes over its flow id so its runner reads the
// right stub doc. Per-flow (rather than one shared model) keeps the model name
// meaningful in traces and keys the Firestore read without threading the flow
// id through generate().
const fakeModels = new Map<AiFlowId, ModelAction>();

function defineFakeModel(flowId: AiFlowId): ModelAction {
  return ai.defineModel(
    {
      name: `e2e-fake/${flowId}`,
      supports: { multiturn: true, tools: false, systemRole: true, output: ['text', 'json'] },
    },
    async () => {
      const snap = await getFirestore().collection(E2E_AI_STUB_COLLECTION).doc(flowId).get();

      if (!snap.exists) {
        // No stub registered for this flow. Fail loudly: a spec that drives an
        // AI flow under FUNCTIONS_AI_FAKE without first calling stubAi() has a
        // bug, and a silent empty answer would surface as a confusing schema
        // parse error downstream.
        throw new Error(
          `e2e fake model: no stub registered at ${E2E_AI_STUB_COLLECTION}/${flowId}. ` +
            `Call window.__e2e.stubAi('${flowId}', <response>) before invoking the flow.`,
        );
      }

      const response = snap.data()?.['response'];
      logger.info('e2e fake model: returning stubbed answer', { flowId });

      // Emit the canned answer as the model's text content.
      //
      //   • Structured-output flows (z.object/array — parseRecipeIngredients,
      //     populateEquipmentEntry, authorRecipe) stub an OBJECT. A real
      //     structured model emits JSON text that Genkit's output formatter parses
      //     back into result.output, so we JSON.stringify the object — byte-for-
      //     byte the original Phase 1 behaviour.
      //   • String-output flows (z.string() — chefChat, generateChatTitle) stub a
      //     STRING. A real model emits that prose verbatim, NOT JSON-quoted; for a
      //     streaming string flow the chunks ARE the displayed reply, so quoting
      //     would surface literal quotes in the chat bubble. Emit the string as-is.
      //
      // Keying-by-flow contract is unchanged; only the text encoding adapts to the
      // stub's runtime type, matching what a real model would emit for each schema.
      const text = typeof response === 'string' ? response : JSON.stringify(response);
      return {
        finishReason: 'stop',
        message: {
          role: 'model',
          content: [{ text }],
        },
      };
    },
  );
}

// Eagerly register a fake model for every flow id, but only under the flag — in
// production this block never runs, so no fake action is ever registered and the
// real model path is untouched. Done at module load to satisfy Genkit's
// "actions defined at load time" rule.
if (aiFakeEnabled()) {
  for (const flowId of AI_FLOW_IDS) {
    fakeModels.set(flowId, defineFakeModel(flowId));
  }
}

/**
 * Resolves the model a text-generation flow should pass to `ai.generate()`.
 *
 *   • Flag OFF (production, and emulator without the flag): returns exactly
 *     `googleAI.model(await resolveModel(flowId))` — the unchanged
 *     production path.
 *   • Flag ON (emulator e2e harness): returns the deterministic fake model
 *     (registered at module load) that reads its canned answer from
 *     `_e2e_ai_stubs/{flowId}`.
 *
 * Drop-in replacement for `googleAI.model(await resolveModel(flowId))` at a
 * flow's model site. Awaitable in both branches so the call site is identical.
 *
 * The flow id is the only argument (issue #935) — the role comes from
 * `AI_FLOW_ROLES`, so a flow that is not in the registry cannot be given a model
 * here either.
 */
export async function flowModel(
  flowId: AiFlowId,
): Promise<ReturnType<typeof googleAI.model> | ModelAction> {
  if (aiFakeEnabled()) {
    // Registered at module load above; AI_FLOW_IDS covers every flow id.
    return fakeModels.get(flowId)!;
  }
  return googleAI.model(await resolveModel(flowId));
}
