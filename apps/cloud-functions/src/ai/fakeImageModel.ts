import { googleAI } from '@genkit-ai/google-genai';
import type { ModelAction } from 'genkit/model';
import type { AiFlowId } from '@salt/domain/schemas';
import { ai } from '../genkit.js';
import { loadCanonIconSeed } from '../flows/assets/canonIconSeed.js';
import { aiFakeEnabled } from './fakeModel.js';
import { resolveModel } from './resolveModel.js';

// ─────────────────────────────────────────────────────────────────────────────
// E2E fake IMAGE model seam (issue #1193), sibling to fakeModel.ts's text seam.
//
// PURPOSE
//   Wired into `defineIconFlow.ts`'s single model-resolution point, shared by
//   all three pictogram flows — `generateCanonIcon`, `generateEquipmentIcon`,
//   `generateKitchenToolIcon`. In practice only `generateEquipmentIcon` reaches
//   it under the flag today: it is the one call site with no earlier
//   `aiFakeEnabled()` guard (`drawEquipmentIcon.ts` calls it unconditionally),
//   so it genuinely reached live Gemini before this fake existed. The other
//   two are called from Firestore triggers that already short-circuit one
//   level up, in `iconWriteTrigger.ts`'s shared `maybeGenerateIcon` (`if
//   (aiFakeEnabled()) return;`, landed in #989, predating this fake) — for a
//   Storage-upload emulator-safety reason this fake does not touch. That guard
//   is UNCHANGED and untouched by this seam: nothing was broken there, so
//   nothing was fixed there (issue #1193 decision). This fake is written
//   flow-agnostic (see below) so it needs no special-casing if that guard is
//   ever narrowed later — it would just start being reached by the other two.
//
// A SEPARATE FILE FROM fakeModel.ts, ON PURPOSE
//   Mirrors the existing per-purpose split between `fakeModel.ts` (text) and
//   `fakeEmbedding.ts` (embeddings): this seam differs from `fakeModel.ts`'s in
//   kind, not just in file organisation. `fakeModel.ts` emits TEXT read
//   per-flow from a Firestore stub a spec configures ahead of time. This fake
//   emits a fixed IMAGE with no per-flow or per-test configurability at all —
//   no e2e spec asserts on pictogram *content*, only that generation completes
//   and a thumbnail/icon field gets written.
//
// WHY ONE MODEL, NOT ONE PER FLOW
//   `fakeModel.ts` registers one fake per `AiFlowId` because each flow's
//   answer is configured independently through Firestore. This fake has
//   nothing to key on — the canned image is identical for every flow and every
//   input — so one shared model, registered once, is all three families need;
//   `defineIconFlow.ts`'s shared model-resolution point (already common to all
//   three) picks it up with the same one-line change regardless of which flow
//   is asking.
//
// THE CANNED IMAGE
//   Reuses the committed `canon-icon-seed.webp` (`loadCanonIconSeed`) — the
//   same asset already sent as the *reference* image on every real
//   `defineIconFlow` call. No new binary asset, no per-test configurability.
//
// WHAT IS NOT ON THIS SEAM, AND WHY
//   `generateRecipeImage` is NOT wired to this fake and needs no fake model:
//   its only call site (`onRecipeWritten.ts`'s `maybeGenerateImage`) already
//   returns on `aiFakeEnabled()` before the flow is ever invoked, so it is
//   fully unreachable under the flag today (verified against the tree, not
//   assumed, for issue #1193).
//
// HARD GATE
//   Activates ONLY when `aiFakeEnabled()` is true (`FUNCTIONS_AI_FAKE === '1'`)
//   — the same contract as `fakeModel.ts` and `fakeEmbedding.ts`. Never set in
//   any deployed environment.
// ─────────────────────────────────────────────────────────────────────────────

// Registered at module load, not lazily — Genkit forbids defining actions at
// request time, the same constraint fakeModel.ts's per-flow map works within.
const fakeImageModel: ModelAction | undefined = aiFakeEnabled()
  ? ai.defineModel(
      {
        name: 'e2e-fake/image',
        supports: { media: true, output: ['media'] },
      },
      async () => {
        const seed = loadCanonIconSeed();
        return {
          finishReason: 'stop',
          message: {
            role: 'model',
            content: [{ media: { url: seed.url, contentType: seed.contentType } }],
          },
        };
      },
    )
  : undefined;

/**
 * Resolves the model an icon-generation flow should pass to `ai.generate()`.
 * Mirrors `flowModel` in `fakeModel.ts` but for the image family:
 *
 *   • Flag OFF (production, and emulator without the flag): returns exactly
 *     `googleAI.model(await resolveModel(flowId))` — the unchanged production
 *     path.
 *   • Flag ON (emulator e2e harness): returns the fake image model registered
 *     above, regardless of which of the three icon flows is asking.
 *
 * Drop-in replacement for `googleAI.model(await resolveModel(flowId))` at
 * `defineIconFlow.ts`'s model-resolution point.
 */
export async function imageFlowModel(
  flowId: AiFlowId,
): Promise<ReturnType<typeof googleAI.model> | ModelAction> {
  if (aiFakeEnabled()) {
    // Registered at module load above, whenever the flag is on.
    return fakeImageModel!;
  }
  return googleAI.model(await resolveModel(flowId));
}
