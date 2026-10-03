import { z } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import {
  ArbitrationRequestSchema,
  ArbitrationResultSchema,
  CanonArbitrationAIOutputSchema,
} from '@salt/domain/schemas';
import { setActiveSpanName } from '@salt/observability/server';
import { ai } from '../genkit.js';
import { resolveModel } from '../ai/resolveModel.js';
import { aiFakeEnabled } from '../ai/fakeModel.js';
import { withAiTimeout } from '../adapters/withAiTimeout.js';

// Flow output is the shared `ArbitrationResultSchema` from `@salt/domain/schemas`
// (issue #417) — the same schema the domain `ArbitrationResult` type derives from,
// so the flow output and the port contract can't drift. The flow always populates
// `prompt`/`rawResponse` (optional in the schema).

export const arbitrateCanonFlow = ai.defineFlow(
  {
    name: 'arbitrateCanon',
    inputSchema: ArbitrationRequestSchema,
    outputSchema: ArbitrationResultSchema,
  },
  async (req) => {
    setActiveSpanName(`arbitrateCanon: ${req.normalisedName}`);
    const builtPrompt = buildPrompt(req);
    // E2E fake seam (issue #686, third offender — see #690 for the first two).
    // Every canon match runs through here, so without a short-circuit the whole
    // e2e suite made a live Gemini call per unmatched item with the dummy
    // emulator key. This one only became reachable once #690 gave the batch
    // embedder a working stand-in vector: before that the pipeline died at the
    // embedding and never got as far as arbitration.
    //
    // `no-match` rather than a `flowModel` stub because no spec asserts an
    // AI-arbitrated outcome, and `no-match` is byte-for-byte what the 400
    // already degraded to — `matchOrCreate` funnels an errored and a no-match
    // arbitration into the same fallback branch, differing only in the
    // `reasoning` string it records. So this preserves current e2e behaviour
    // while dropping the network call, the retry budget and the log noise.
    // Wire it to `flowModel('arbitrateCanon')` the day a spec needs a
    // positive arbitration. Unreachable in production (the flag is never set).
    if (aiFakeEnabled()) {
      return { kind: 'no-match' as const, prompt: builtPrompt, rawResponse: '' };
    }
    const model = await resolveModel('arbitrateCanon');
    // Below the fake seam on purpose (issue #915): under FUNCTIONS_AI_FAKE the
    // short-circuit above returns before this line, so the wrapper adds no
    // timer to the fake path and nothing here has to change the day that seam
    // is wired to `flowModel`.
    //
    // The deadline lives in the flow rather than at the adapter that used to
    // apply it, because `arbitrateCanonFlow` is ALSO exported as its own
    // callable (index.ts) — a caller-side wrapper left that entrypoint
    // completely unguarded. House defaults (20s + 1 retry), the same values
    // `createServerArbitrationAdapter` applied from outside.
    const result = await withAiTimeout('arbitrateCanon', () =>
      ai.generate({
        model: googleAI.model(model),
        prompt: builtPrompt,
        output: { schema: CanonArbitrationAIOutputSchema },
        config: { temperature: 0 },
      }),
    );
    const output = result.output!;
    const rawResponse = result.text ?? JSON.stringify(output);

    // Map aisle name → id (first match wins; null if name not found in list).
    const aisleId =
      output.aisle_name != null
        ? (req.aisles.find((a) => a.name === output.aisle_name)?.id ?? null)
        : null;

    const optionalFields = {
      ...(output.largeQuantityThreshold != null
        ? { largeQuantityThreshold: output.largeQuantityThreshold }
        : {}),
      ...(output.unit != null ? { unit: output.unit } : {}),
      // A weight of one only means something for an item bought by the count,
      // and a non-positive one is no weight at all (issue #1643).
      ...(output.unit === 'count' && output.gramsPerItem != null && output.gramsPerItem > 0
        ? { gramsPerItem: output.gramsPerItem }
        : {}),
      reasoning: output.reasoning,
    };

    if (output.match_found && output.match_id != null) {
      const confidence =
        req.candidates.find((c) => c.item.id === output.match_id)?.confidence ?? 1.0;
      return {
        kind: 'match' as const,
        itemId: output.match_id,
        confidence,
        shoppingBehavior: output.shoppingBehavior,
        ...optionalFields,
        prompt: builtPrompt,
        rawResponse,
      };
    }

    if (output.canonical_name != null) {
      return {
        kind: 'new' as const,
        canonName: output.canonical_name,
        aisleId,
        shoppingBehavior: output.shoppingBehavior,
        ...optionalFields,
        prompt: builtPrompt,
        rawResponse,
      };
    }

    return { kind: 'no-match' as const, prompt: builtPrompt, rawResponse };
  },
);

function buildPrompt(req: z.infer<typeof ArbitrationRequestSchema>): string {
  const candidateList = req.candidates.length
    ? req.candidates
        .map(
          (c) => `- id: "${c.item.id}", name: "${c.item.name}", score: ${c.confidence.toFixed(3)}`,
        )
        .join('\n')
    : '(none)';

  const aisleList = req.aisles.length
    ? req.aisles.map((a) => `- "${a.name}"`).join('\n')
    : '(none)';

  const rawInputLine =
    req.rawText !== undefined && req.rawText !== req.normalisedName
      ? `Raw input (context only — use container/descriptor words like "tin of", "smoked", "fresh" to resolve ambiguity, but match on the normalised name above): "${req.rawText}"`
      : null;

  return [
    `You are a UK supermarket canon-matching assistant. Apply the four rules below and respond with a single JSON object matching the output schema exactly.`,
    ``,
    `Normalised input: "${req.normalisedName}"`,
    ...(rawInputLine ? [rawInputLine] : []),
    ``,
    `Candidate matches (id, name, similarity score 0–1):`,
    candidateList,
    ``,
    `Available aisles (use the exact name in your response):`,
    aisleList,
    ``,
    `## Rule 1 — Canonical Matching`,
    `If any candidate is semantically the same grocery item as the input, set \`match_found\` to true and \`match_id\` to that candidate's id.`,
    `- Allow for plurals, minor spelling variants, or superficial size/pack modifiers (e.g., "big onion" is a semantic match for "onions"; "large loose box tomatoes" is a match for "tomatoes").`,
    `- If multiple candidates match, choose the one with the highest similarity score.`,
    `- If no candidate is a semantic match, set \`match_found\` to false and \`match_id\` to null.`,
    ``,
    `## Rule 2 — Canonical Product Name (UK Conventions)`,
    `If \`match_found\` is false, determine the \`canonical_name\`. This must be the singular, Title-Case name a UK supermarket (like Tesco or Sainsbury's) prints on a shelf edge label.`,
    `- Strip away size, weight, pack, or quality modifiers (e.g., "big onion" becomes "Onion").`,
    `- Retain a modifier ONLY when it denotes a fundamentally distinct product type or botanical variety sold separately in the UK (e.g., "Red Onion", "Spring Onion", and "Onion" are distinct; "Maris Piper Potato" is distinct from a generic "Potato").`,
    `- If \`match_found\` is true, set \`canonical_name\` to null.`,
    ``,
    `## Rule 3 — shoppingBehavior`,
    `Classify the item as one of:`,
    `  "stocked"  — kept in the store cupboard long-term (salt, olive oil, plain flour, dried pasta, spices)`,
    `  "check"    — perishable or semi-perishable; might already be in stock (eggs, butter, cheese, milk)`,
    `  "needed"   — typically bought fresh per shop (fresh vegetables, fresh meat, fresh fish, bread)`,
    ``,
    `## Rule 4 — largeQuantityThreshold`,
    `If the item is sold in a standard UK pack, set largeQuantityThreshold to 60% of the pack size and unit to "g", "ml", or "count". For example: plain flour → 600 g; eggs → 8 count. If there is no clear standard UK pack, set both to null.`,
    ``,
    `## Rule 5 — gramsPerItem`,
    `When unit is "count", set gramsPerItem to the typical weight in grams of ONE of the item as a UK shopper buys it (one medium onion → 150; one egg → 50; one whole chicken → 1500). Otherwise set gramsPerItem to null.`,
    ``,
  ].join('\n');
}
