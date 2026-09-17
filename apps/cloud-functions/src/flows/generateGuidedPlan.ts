import {
  GenerateGuidedPlanInputSchema,
  GenerateGuidedPlanAIOutputSchema,
  GenerateGuidedPlanOutputSchema,
  type RecipeDoc,
} from '@salt/domain/schemas';
import { withAiTimeout } from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { flowModel } from '../ai/fakeModel.js';
import { requireRecipe } from './loadRecipe.js';
import { GUIDED_PREP_RULES, GUIDED_STEP_NOTE_RULES } from './stepRules.js';

// generateGuidedPlan (issue #751, Phase 1). Writes the GUIDED PLAN for one recipe:
// a mise-en-place list of prep jobs, and the notes that sit underneath the
// recipe's existing steps.
//
// What the plan is FOR: a recipe is written for someone who already knows how to
// cook it. The plan spells out what it assumes — which bowl the diced veg waits
// in, how low "gentle heat" is, what the pan should sound like when it is right.
// So the model is asked for exactly the things the recipe left out, and told in
// as many words to leave a field null when the recipe left nothing out.
//
// It reads the recipe SERVER-SIDE via the Admin SDK (as the canon flows do) rather
// than taking one on the wire: the client sends an id, so the plan is always about
// the recipe that is actually in Firestore, and a 60-step recipe never has to
// round-trip through the browser to be annotated.
//
// It authors CONTENT ONLY — no ids, no timestamps, no `needs_approval`. The web
// service assembles and persists the document (one write path, one place those
// control fields are decided). This flow persists nothing.
//
// Prompt policy lives in stepRules.ts alongside STEP_RULES, which is the single
// source of truth for what a cook is told at a step; see that file's header.

const GUIDED_PLAN_SYSTEM = `You are an experienced cook standing beside someone less experienced, reading them a recipe. \
Your job is to spell out what the recipe ASSUMES they already know — and NOTHING ELSE.

You are given one recipe: its ingredients (each with an id) and its numbered method steps (each with an id, and a \
timer where the step has one). Return two things: a prep list, and notes to add under the steps.

## What you must not do
- Do NOT change, rewrite, reword, re-order, split, merge or re-time any step. The recipe's own words are shown to the \
cook exactly as written; you only add lines underneath them.
- Do NOT invent ingredients, equipment, temperatures or times the recipe does not imply.
- Do NOT pad. An empty field is a correct answer whenever the recipe left nothing unsaid, and every field you fill \
with a guess is a confident instruction to do the wrong thing.

## What to return
${GUIDED_PREP_RULES}
${GUIDED_STEP_NOTE_RULES}

Write British English. Temperatures in °C only. Speak plainly and in the imperative, as you would to someone with \
their hands full.`;

// The recipe as the model sees it. Ids are shown because the output references
// them — an ingredient id per prep job, a step id per note — and a model that
// cannot see an id cannot cite it.
function promptFor(recipe: RecipeDoc): string {
  const ingredientLines = recipe.ingredients.flatMap((group) =>
    group.items.map(
      (item) => `- [${item.id}] ${item.rawText}${group.name ? ` (${group.name})` : ''}`,
    ),
  );
  const stepLines = recipe.steps.map((step, i) => {
    const timer = step.timer ? ` [timer: ${step.timer.durationMinutes} minutes]` : '';
    return `${i + 1}. [${step.id}]${timer} ${step.text}`;
  });
  return [
    `Title: ${recipe.title}`,
    recipe.description ? `Description: ${recipe.description}` : null,
    ingredientLines.length > 0 ? `Ingredients:\n${ingredientLines.join('\n')}` : null,
    stepLines.length > 0 ? `Method:\n${stepLines.join('\n')}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join('\n\n');
}

// NOT the house `AI_TEXT_FLOW_TIMEOUT` (55s), and the gap is the whole reason this
// literal exists. That budget was sized for a flow that answers in one short burst;
// this one writes a note for EVERY step of the recipe — seven fields each — so its
// work, and therefore its latency, scales with the length of the method. Measured
// against `gemini-pro-latest` on production recipes:
//
//     16 steps (Spaghetti Bolognese)   47–67s   — over the 55s budget on most runs
//     32 steps                         103s     — over it on every run
//
// So 55s was not a deadline the flow occasionally missed; it was below the cost of
// an ORDINARY recipe, and the failure it produced was total (issue: the editor's
// "Couldn't write the plan" on every attempt in production). Capping the model's
// thinking budget was measured too and does not close it — at `thinkingBudget:
// 4096` the same 16-step recipe still took 47s, inside 55s by seconds rather than
// by design, and the 32-step case is untouched.
//
// 180s clears the longest recipe measured with ~75% headroom. It is the flow's
// share of the 210s the callable is exported with (see `index.ts`), which is in
// turn matched by `callGenerateGuidedPlan`'s client timeout — RAISING ANY ONE OF
// THE THREE MEANS RAISING THE OTHER TWO, and the lowest of them is what actually
// governs. The 30s left over is for the Firestore read and the response hop.
//
// No retry, unchanged from the house budget: the caller is a human sitting in
// front of the editor with a Write-the-plan button they can press again, and a
// second 180s attempt they did not ask for would hold them for six minutes.
const GUIDED_PLAN_TIMEOUT = { timeoutMs: 180_000, retries: 0 } as const;

export const generateGuidedPlanFlow = ai.defineFlow(
  {
    name: 'generateGuidedPlan',
    inputSchema: GenerateGuidedPlanInputSchema,
    outputSchema: GenerateGuidedPlanOutputSchema,
  },
  async ({ recipeId }) => {
    const recipe = await requireRecipe(recipeId);

    // The `pro` role, and deliberately so: cue quality IS the feature. A wrong
    // sensory cue is worse than no cue (it tells the cook to wait for something
    // that will not happen), the plans are a handful of recipes ever, and this is
    // long-form judgement about a whole dish — the same argument that puts
    // chefChat on `pro`. `flowModel` returns the deterministic e2e fake under
    // FUNCTIONS_AI_FAKE.
    const model = await flowModel('generateGuidedPlan');
    const result = await withAiTimeout(
      'generateGuidedPlan',
      () =>
        ai.generate({
          model,
          system: GUIDED_PLAN_SYSTEM,
          prompt: promptFor(recipe),
          output: { schema: GenerateGuidedPlanAIOutputSchema },
          // Not zero: a cue is a description of a pan, and temperature 0 writes
          // the same four stock phrases for every dish. Low enough that it stays
          // anchored to the recipe in front of it.
          config: { temperature: 0.4 },
        }),
      GUIDED_PLAN_TIMEOUT,
    );

    const parsed = GenerateGuidedPlanAIOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`generateGuidedPlan returned invalid output: ${parsed.error.message}`);
    }

    // Drop annotations for steps that do not exist. The model is told to copy step
    // ids verbatim, and a hallucinated one would render as nothing in the editor
    // anyway — but silently carrying it into the document makes every later reader
    // handle it, and a note the cook can never see is not worth storing.
    const stepIds = new Set(recipe.steps.map((s) => s.id));
    return {
      prep: parsed.data.prep,
      stepNotes: parsed.data.stepNotes.filter((note) => stepIds.has(note.stepId)),
    };
  },
);
