import { z } from 'genkit';
import type { AiFlowId } from '@salt/domain/schemas';
import { setActiveSpanName } from '@salt/observability/server';
import { ai } from '../genkit.js';
import { withAiTimeout } from '../adapters/withAiTimeout.js';
import { loadCanonIconSeed } from './assets/canonIconSeed.js';
import { imageFlowModel } from '../ai/fakeImageModel.js';
import { parseDataUrl } from './dataUrl.js';

// The Tier-1 pictogram GENERATION step, once (issue #989).
//
// `generateCanonIcon` (#148), `generateKitchenToolIcon` (#882) and
// `generateEquipmentIcon` (#877) had the same eleven-line body three times over:
//
//   span name → seed → resolveModel → generate(seed media + text) → media-null
//   throw → parseDataUrl
//
// Comment-stripped and identifier-normalised, two of the three were ZERO lines
// apart and the third was the same body again. They differ only in the flow's
// name, its input schema, which field of that input the picture is OF, and which
// builder writes the words.
//
// ─── Three identities the factory takes as a PARAMETER, never collapses ──────
//
// `name` reaches four places that each depend on it being this flow's own:
// `resolveModel(name)` — a registry key (#935), so merging the names would
// silently repoint every per-flow model override; `withAiTimeout(name, …)`;
// `setActiveSpanName(\`${name}: ${subject}\`)`; and the media-null error message,
// which is how a failure is attributed to a family in the logs. That is why this
// is a factory over three flows rather than one flow over three families.
//
// The house style itself is not parameterised here at all: it is `STYLE` in
// generateCanonIcon.ts, IMPORTED verbatim by each prompt module. What varies
// between families is the anchors that follow it, and those belong to the
// builders — see docs/canon-icons.md, which is the owner of that wording.

// Image generation is far slower than text (~5–8s, occasionally more), so this
// is deliberately NOT `AI_TEXT_FLOW_TIMEOUT`. One budget rather than three
// literals: all three families are the same model doing the same job at the same
// size, and matching them by hand was already how they came to agree. Each
// caller's function timeout is raised to suit.
//
// The wrapper belongs HERE, in the file that calls the model, and nowhere else
// (issue #915). A trigger or callable that wrapped it again would impose the
// house 20s default on top, so a drawing that took longer than 20s would be cut
// short and retried whole. `tests/aiTimeoutGuard.test.ts` scans for exactly this.
const ICON_GEN_TIMEOUT_MS = 60_000;

/**
 * Raw generated image bytes, base64-encoded (Genkit flow outputs must be
 * JSON-serialisable). Every icon family returns this same pair, and the caller
 * decodes to a Buffer before background removal.
 */
export const IconImageOutputSchema = z.object({
  imageBase64: z.string(),
  contentType: z.string(),
});

/** The four axes an icon flow differs on. */
export interface IconFlowDescriptor<TSchema extends z.ZodTypeAny> {
  /**
   * The flow's own name. A `resolveModel` registry key (#935), the
   * `withAiTimeout` label, the span-name prefix and the media-null error's
   * attribution — four reasons it is a parameter and not a constant.
   *
   * Typed as `AiFlowId` rather than `string`, which is what a factory buys here
   * that three hand-written bodies could not: a flow whose name is not in the
   * model registry no longer compiles, so the per-flow override surface and the
   * set of flows can never drift apart silently.
   */
  readonly name: AiFlowId;
  readonly inputSchema: TSchema;
  /** What the picture is OF, for the span label: an item's name, a tool's label. */
  readonly subjectOf: (input: z.infer<TSchema>) => string;
  /** This family's prompt builder, called with this family's own fields. */
  readonly promptOf: (input: z.infer<TSchema>) => string;
}

export function defineIconFlow<TSchema extends z.ZodTypeAny>(
  descriptor: IconFlowDescriptor<TSchema>,
) {
  const { name, inputSchema, subjectOf, promptOf } = descriptor;

  return ai.defineFlow(
    { name, inputSchema, outputSchema: IconImageOutputSchema },
    async (input: z.infer<TSchema>) => {
      setActiveSpanName(`${name}: ${subjectOf(input)}`);
      // Reference-conditioned off the committed red-apple seed: the model copies
      // ONLY the rendering style of the seed, never its subject. Every family
      // shares the one seed, which is what makes a whisk and a lemon read as one
      // set. The seed-coupled negatives live in the builders and are keyed to
      // THIS seed — swapping it means updating them too.
      const seed = loadCanonIconSeed();

      const imageModel = await imageFlowModel(name);

      const result = await withAiTimeout(
        name,
        () =>
          ai.generate({
            model: imageModel,
            prompt: [
              { media: { url: seed.url, contentType: seed.contentType } },
              { text: promptOf(input) },
            ],
          }),
        { timeoutMs: ICON_GEN_TIMEOUT_MS, retries: 1 },
      );

      const media = result.media;
      if (!media?.url) {
        throw new Error(`${name}: model returned no image`);
      }

      const { base64, contentType } = parseDataUrl(media.url, name);
      return { imageBase64: base64, contentType };
    },
  );
}
