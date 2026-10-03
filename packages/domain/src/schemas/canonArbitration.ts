import { z } from 'zod';
import { SHOPPING_BEHAVIORS, CANON_ITEM_UNITS } from '@salt/shared-types';

export const ArbitrationRequestSchema = z.object({
  normalisedName: z.string(),
  candidates: z.array(
    z.object({
      item: z.object({ id: z.string(), name: z.string() }),
      confidence: z.number(),
    }),
  ),
  aisles: z.array(z.object({ id: z.string(), name: z.string() })),
  rawText: z.string().optional(),
});

// The arbitration outcome the CF flow returns and the domain port yields (issue
// #417). Single source of truth for the shape: the domain `ArbitrationResult`
// type and the `arbitrateCanon` flow's outputSchema both derive from this, so the
// flow output can no longer drift from the port contract behind an `as unknown`
// cast. `prompt`/`rawResponse` are optional telemetry the flow always populates
// but consumers treat as best-effort (`?? ''`). `shoppingBehavior`/`unit` mirror
// `ShoppingBehavior`/`CanonItemUnit`, derived from the `SHOPPING_BEHAVIORS`/
// `CANON_ITEM_UNITS` tuples in `@salt/shared-types`, which every `z.enum` below
// draws from directly.
export const ArbitrationResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('match'),
    itemId: z.string(),
    confidence: z.number(),
    shoppingBehavior: z.enum(SHOPPING_BEHAVIORS),
    largeQuantityThreshold: z.number().optional(),
    unit: z.enum(CANON_ITEM_UNITS).optional(),
    gramsPerItem: z.number().positive().optional(),
    reasoning: z.string().optional(),
    prompt: z.string().optional(),
    rawResponse: z.string().optional(),
  }),
  z.object({
    kind: z.literal('new'),
    canonName: z.string(),
    aisleId: z.string().nullable(),
    shoppingBehavior: z.enum(SHOPPING_BEHAVIORS),
    largeQuantityThreshold: z.number().optional(),
    unit: z.enum(CANON_ITEM_UNITS).optional(),
    // The weight of one item, set alongside a `count` unit (issue #1643).
    gramsPerItem: z.number().positive().optional(),
    reasoning: z.string().optional(),
    prompt: z.string().optional(),
    rawResponse: z.string().optional(),
  }),
  z.object({
    kind: z.literal('no-match'),
    prompt: z.string().optional(),
    rawResponse: z.string().optional(),
  }),
]);

export type ArbitrationResult = z.infer<typeof ArbitrationResultSchema>;

// Flat shape returned by the Gemini model in the canon-matching flow.
// Schema is the source of truth; the TS type is derived via z.infer.
export const CanonArbitrationAIOutputSchema = z.object({
  match_found: z.boolean(),
  match_id: z.string().nullable(),
  canonical_name: z.string().nullable(),
  aisle_name: z.string().nullable(),
  shoppingBehavior: z.enum(SHOPPING_BEHAVIORS),
  largeQuantityThreshold: z.number().nullable(),
  unit: z.enum(CANON_ITEM_UNITS).nullable(),
  // Grams in ONE item when `unit` is "count" (issue #1643). Optional so a stubbed
  // model answer written before the field (the e2e `_e2e_ai_stubs`) still
  // validates; the flow drops a missing, null or non-positive value.
  gramsPerItem: z.number().nullable().optional(),
  reasoning: z.string(),
});
