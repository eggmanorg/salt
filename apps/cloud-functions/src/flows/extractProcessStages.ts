import {
  ExtractProcessStagesInputSchema,
  ExtractProcessStagesAIOutputSchema,
  ExtractProcessStagesOutputSchema,
  type RecipeDoc,
} from '@salt/domain/schemas';
import { getFirestore } from 'firebase-admin/firestore';
import { AI_TEXT_FLOW_TIMEOUT, withAiTimeout } from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { flowModel } from '../ai/fakeModel.js';
import { equipmentSectionForStages, readEquipmentItems } from './equipmentContext.js';
import { requireRecipe } from './loadRecipe.js';

// extractProcessStages (issue #806, phase 2 of epic #778). Reads a recipe's method
// and returns the ORDERED STAGES it describes — mix, bulk ferment, shape, final
// proof, preheat, bake — each labelled `active` or `wait`, with whatever
// temperature and duration the recipe actually gave.
//
// The CHEAP TIER, and the epic's contract is explicit about why: this is mechanical
// extraction from step text and the timers already parsed onto it, not judgement.
// The judgement half (restructuring a schedule to land at a target time) is a
// separate flow on a better model, and it does not exist yet.
//
// Like generateGuidedPlan, it reads the recipe SERVER-SIDE via the Admin SDK and
// authors CONTENT ONLY — no stage ids, no timestamps, nothing persisted. The web
// service mints ids and the user reviews the result before anything is saved.
//
// TWO PROPERTIES ARE ENFORCED IN CODE RATHER THAN LEFT TO THE PROMPT, because both
// are things the spike got wrong on real recipes and neither is worth a coin toss:
// a stage citing a step the recipe does not have loses its citation, and a process
// with no waits comes back empty. See each below.

// The `active`/`wait` definition is reproduced here VERBATIM from
// `ProcessStageKindSchema`'s field docs in @salt/domain/schemas. It is not a
// paraphrase and must not become one: the spike's headline defect was the bake
// being labelled differently on each of three bread recipes, which happened
// because nothing anywhere said which side the oven falls on. The last line is
// what pins it.
export const STAGE_KIND_RULES = `A \`wait\` is unattended change — the dough, the ferment or the oven changes on its own and the cook can \
leave the room: bulk fermentation, proving, a fridge retard, resting, curing, and an oven coming up to temperature.
An \`active\` stage is one the cook carries out and is present for: mixing, folding, shaping, and the bake itself.
THE BAKE IS \`active\`. THE PREHEAT IS \`wait\`.`;

const EXTRACT_PROCESS_STAGES_SYSTEM = `You are reading a recipe's method and writing down the stages it goes through, in order. \
This is a transcription job, not a rewrite: every stage you return must be something the method actually says.

## active or wait
${STAGE_KIND_RULES}

## When to return nothing
Return an EMPTY list of stages unless the method contains at least one \`wait\`. A recipe with nothing to wait for has \
no process worth recording — the method already covers it. NEVER invent a proof, a rest or a rise that the recipe does \
not describe. An empty list is a correct and expected answer.

## What each stage carries
- \`label\`: two or three words for what happens. "Bulk ferment", "Shape", "Preheat the oven", "Bake".
- \`kind\`: \`active\` or \`wait\`, by the rule above.
- \`environment\`: where the stage happens, when the recipe says or plainly implies it. Null when there is nothing \
to say — a mix has no meaningful temperature. Only set \`relativeHumidityPercent\` if the recipe states a humidity.
  - \`temperature\`: \`{ "kind": "fixed", "celsius": N }\` when the recipe means one figure — an oven at 240 means \
240 — or \`{ "kind": "range", "minCelsius": N, "maxCelsius": M }\` when it means a band. PREFER A RANGE FOR ANYTHING \
AMBIENT: "at room temperature" is 20–24, "somewhere warm" is 24–28, "in the fridge" is 3–5. A single figure for a \
prove is a fiction — nobody's kitchen holds 20 °C all day. KEEP A RANGE AS A RANGE; do not average it.
  - \`equipmentId\`: null unless a place below fits, and see the places section for when one does.
- \`duration\`: \`{ "kind": "fixed", "minutes": N }\` for a single time, or \
\`{ "kind": "range", "minMinutes": N, "maxMinutes": M }\` when the recipe gives a spread ("prove for 45 minutes to an \
hour"). KEEP A RANGE AS A RANGE — do not average it. Null when the recipe gives no time at all.
- \`until\`: the observable sign that the stage is done, in the recipe's own terms — "until doubled in size", "until \
it sounds hollow when tapped". Null when the recipe gives none.
- \`stepId\`: the id of the step this stage came from, copied verbatim from the method below. Null when the stage is \
not in any one step.
- \`optional\`: true ONLY when the method itself says the step may be left out — "optionally, brush the top with \
milk", "if you like, give it a second fold", "you can skip the final rest". Anything else is false, including a step \
that merely sounds inessential to you. A step the recipe states plainly is not optional, however small it is.

## What you must not do
- Do NOT invent a temperature or a duration the recipe does not give. Null is the correct answer for both.
- Do NOT merge two waits into one. A method that says "rest 20 minutes, then another after 20 minutes, and another 20 \
minutes later" has THREE rests, and each is its own stage.
- Do NOT split a single instruction into stages the recipe does not distinguish.
- Do NOT return stages in any order but the order the cook does them in.

Write British English. Temperatures in °C only.`;

// The recipe as the model sees it. Step ids are shown because the output cites
// them, and the timer already parsed onto a step is shown because it is the
// cleanest duration signal in the whole document — a step that says "prove for an
// hour" carries `[timer: 60 minutes]` and needs no re-reading of the prose.
//
// INGREDIENTS ARE DELIBERATELY NOT SHOWN. A stage is a fact about the method, and
// an ingredient list in front of the model is an invitation to author an addition
// schedule — which this phase does not model (see schemas/process.ts) and which
// would come back as stages nobody asked for.
function promptFor(recipe: RecipeDoc): string {
  const stepLines = recipe.steps.map((step, i) => {
    const timer = step.timer ? ` [timer: ${step.timer.durationMinutes} minutes]` : '';
    return `${i + 1}. [${step.id}]${timer} ${step.text}`;
  });
  return [
    `Title: ${recipe.title}`,
    recipe.description ? `Description: ${recipe.description}` : null,
    stepLines.length > 0 ? `Method:\n${stepLines.join('\n')}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join('\n\n');
}

export const extractProcessStagesFlow = ai.defineFlow(
  {
    name: 'extractProcessStages',
    inputSchema: ExtractProcessStagesInputSchema,
    outputSchema: ExtractProcessStagesOutputSchema,
  },
  async ({ recipeId }) => {
    const recipe = await requireRecipe(recipeId);

    // The household's places (issue #1281). Read alongside the recipe rather than
    // baked into the system prompt because it is a document that changes, and ''
    // when there is nothing to show — a household that has described no chamber
    // gets byte-for-byte the prompt it got before, and every stage comes back
    // with no place, which is today's behaviour exactly.
    const equipmentItems = await readEquipmentItems(getFirestore(), 'extractProcessStages');
    const placesSection = equipmentSectionForStages(equipmentItems);

    // `lite`: mechanical extraction from text already in front of it, the same
    // posture as parseRecipeIngredients. `flowModel` returns the deterministic e2e
    // fake under FUNCTIONS_AI_FAKE.
    const model = await flowModel('extractProcessStages');
    const result = await withAiTimeout(
      'extractProcessStages',
      () =>
        ai.generate({
          model,
          system: placesSection
            ? `${EXTRACT_PROCESS_STAGES_SYSTEM}\n\n${placesSection}`
            : EXTRACT_PROCESS_STAGES_SYSTEM,
          prompt: promptFor(recipe),
          output: { schema: ExtractProcessStagesAIOutputSchema },
          // Zero, and unlike the guided plan that is right here: there is one
          // correct transcription of a method into stages, and every degree of
          // creativity is a degree of invented proof. The same reasoning that puts
          // the ingredient parser at 0.
          config: { temperature: 0 },
        }),
      // No retry (the shared budget's): a human is sitting in front of the
      // formula screen with a button they can press again.
      AI_TEXT_FLOW_TIMEOUT,
    );

    const parsed = ExtractProcessStagesAIOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`extractProcessStages returned invalid output: ${parsed.error.message}`);
    }

    // A cited step that does not exist loses the CITATION, not the stage. This is
    // deliberately gentler than generateGuidedPlan, which drops the whole note: a
    // note IS an annotation on a step and is nothing without one, whereas `stepId`
    // here is an optional one-way back-reference and a bulk ferment is still a bulk
    // ferment without it. Throwing away a real wait stage because the model mistyped
    // an id is exactly the loss this feature exists to prevent.
    const stepIds = new Set(recipe.steps.map((s) => s.id));
    // A place the manifest does not have loses the PLACE, not the stage, and for
    // exactly the reason a bad `stepId` loses only the citation: `equipmentId` is
    // an optional one-way reference and a bulk ferment is still a bulk ferment
    // without one. The alternative — trusting the prompt — is how you get a
    // confidently invented chamber that no screen can resolve to a name.
    const placeIds = new Set(equipmentItems.filter((i) => i.environment !== null).map((i) => i.id));
    const stages = parsed.data.stages.map((stage) => {
      const stepId = stage.stepId !== null && !stepIds.has(stage.stepId) ? null : stage.stepId;
      const environment =
        stage.environment !== null &&
        stage.environment.equipmentId !== null &&
        !placeIds.has(stage.environment.equipmentId)
          ? { ...stage.environment, equipmentId: null }
          : stage.environment;
      return { ...stage, stepId, environment };
    });

    // NO WAITS, NO PROCESS. Enforced here rather than trusted to the prompt because
    // it is the difference between "this recipe has no process" and a confidently
    // invented proof, and a model asked to list stages will always find some. The
    // actives are only worth returning as the gaps BETWEEN waits; with no waits
    // they are just the method again, which the recipe already holds.
    if (!stages.some((stage) => stage.kind === 'wait')) {
      return { stages: [] };
    }

    return { stages };
  },
);
