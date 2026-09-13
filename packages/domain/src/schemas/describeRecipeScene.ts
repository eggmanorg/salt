import { z } from 'zod';
import { RecipeKindSchema } from './recipe.js';

// Input/output for the describeRecipeScene flow (recipe hero art-direction).
// A cheap text step in front of the expensive image step: a fast model reads the
// WHOLE recipe — not just the title/description the image prompt used to see —
// and writes a short art-direction brief describing what the plated dish actually
// looks like and how it reads in mood/season/cuisine. That brief then directs the
// image model in place of the "work it out yourself" clause.
//
// The input mirrors CategoriseRecipeInputSchema: both flows read the same recipe
// content, they just answer different questions about it.
export const DescribeRecipeSceneInputSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  // What kind of entry this is (issue #637). It selects the art director's brief
  // entirely: a recipe brief is written from the METHOD and the INGREDIENTS ("the
  // blistered top, the torn basil"), and a special has neither — so a special
  // brief describes the food as it ARRIVES instead (vessel, packaging, spread,
  // setting). OPTIONAL and defaulted downstream to `'recipe'`, so a caller that
  // omits it (and every request already in flight) gets exactly today's prompt.
  kind: RecipeKindSchema.optional(),
  // The entry's own tags. Issue #148 fed these to the IMAGE flow but never to
  // this one, which for three kinds was merely a missed cue — and for a
  // PLACEHOLDER was a hole: it has no ingredients and no method, and its mood
  // (`bright` / `comfort`, plus the optional weather conditions) is an ordinary
  // `tags` entry rather than a schema field, so the placeholder brief prompt's
  // "what you read instead is the MOOD, which the tags carry" was reading a
  // field it was never handed. Title and description were the whole input.
  //
  // OPTIONAL and defaulted so every existing caller stays valid; the flow adds
  // no `Tags:` block when the array is empty, so a caller that omits them sends
  // byte-for-byte the prompt it sent before.
  tags: z.array(z.string()).optional().default([]),
  // Ingredient display lines (rawText). The whole point of this flow: a garnish
  // or a finishing ingredient that appears ONLY here is exactly the detail the
  // title/description-only prompt could never see.
  ingredients: z.array(z.string()),
  // Method text. Carries the finished-appearance cues ("grill until blistered
  // and golden", "scatter with torn basil") that decide how the dish looks.
  steps: z.array(z.string()).optional().default([]),
  // The dishes a MEAL is built from, as display lines (issue #838). A meal is a
  // recipe pointing at other recipes, and a bundle-only one — a Sunday roast that
  // is just chicken + potatoes + gravy — has no ingredients and no method of its
  // own, so before this the art director's ENTIRE input was a title. That is the
  // case where the blindness hurts most, and it is why #752 deferred this
  // question rather than answering it.
  //
  // TITLE AND DESCRIPTION ONLY, rendered by `componentDisplayLines` in
  // `@salt/domain` — never a component's ingredients or steps. Nothing
  // aggregates: what is photographed is the dinner on the table, not a merged
  // recipe. Kept as its OWN field rather than folded into `ingredients`, because
  // a dish is not an ingredient and the prompt clause it drives is its own.
  //
  // OPTIONAL and defaulted exactly as `tags` above: every existing caller stays
  // valid, and the flow adds no `Dishes:` block and no meal clause when the array
  // is empty — so a recipe that is not a meal sends byte-for-byte the prompt it
  // sent before.
  components: z.array(z.string()).optional().default([]),
  // ─── Revision mode (issue #522, Phase 3) ────────────────────────────────────
  // Both OPTIONAL and ADDITIVE: omit both and the flow authors from scratch —
  // the original behaviour, and also what "start over" deliberately sends (a
  // fresh reading of the current recipe, discarding accumulated edits). Supply
  // both and the flow REVISES `currentBrief` per `hint` instead.
  //
  // The recipe fields above stay REQUIRED in revision mode on purpose: revising
  // a paragraph without knowing which dish it describes drifts away from the
  // food, which is the exact failure this whole feature exists to fix. A
  // revision is anchored to the actual recipe, not just to the prose about it.
  //
  // Caps mirror their neighbours: 2000 is the brief cap on
  // RegenerateRecipeImageInputSchema.brief (the same paragraph round-trips
  // through both), and 200 is the established steer cap.
  currentBrief: z.string().trim().max(2000).optional(),
  hint: z.string().trim().max(200).optional(),
});

export type DescribeRecipeSceneInput = z.infer<typeof DescribeRecipeSceneInputSchema>;

// The brief round-trips as ONE PROSE BLOB, deliberately NOT a structured object
// ({ plating, vessel, garnish, … }). It is written to be read and edited by a
// human as a paragraph, and it is handed to the image model as prose, so
// decomposing it would only add a shape to keep in sync with no consumer for the
// parts. The wrapper object exists solely because Genkit structured output needs
// one — `brief` itself is the payload.
export const DescribeRecipeSceneOutputSchema = z.object({
  brief: z.string(),
});

export type DescribeRecipeSceneOutput = z.infer<typeof DescribeRecipeSceneOutputSchema>;
