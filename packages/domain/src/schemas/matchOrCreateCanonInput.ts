import { z } from 'zod';

export const MatchOrCreateCanonInputSchema = z.object({
  rawName: z.string(),
  selectedAisleId: z.string().nullable().optional(),
  forceCreate: z.boolean().optional(),
  rawText: z.string().optional(),
});

// The Result envelope `matchOrCreate` produces, as it crosses the callable
// boundary. `item` and `error` stay `z.any()`: CanonItem and DomainError are
// validated by the domain layer upstream, and modelling them again in zod would
// duplicate that contract rather than check it.
//
// ONE declaration, not two (issue #932, B3-013). `canonicaliseRecipeIngredients`
// declared a byte-identical union for its per-item result; it now consumes this.
export const MatchOrCreateCanonOutputSchema = z.union([
  z.object({
    kind: z.literal('ok'),
    value: z.object({
      decision: z.enum(['created', 'matched', 'ai_arbitrated']),
      item: z.any(),
    }),
  }),
  z.object({
    kind: z.literal('err'),
    error: z.any(),
  }),
]);

export type MatchOrCreateCanonOutput = z.infer<typeof MatchOrCreateCanonOutputSchema>;
