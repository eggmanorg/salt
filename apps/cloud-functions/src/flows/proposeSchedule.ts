import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/https';
import {
  DEFAULT_QUIET_HOURS,
  FormulaSchema,
  ProposeScheduleInputSchema,
  ProposeScheduleAIOutputSchema,
  ProposeScheduleOutputSchema,
  PROPOSE_SCHEDULE_AI_TIMEOUT_MS,
  type ComponentAdjustment,
  type Formula,
  type ProcessStage,
  type QuietHours,
  type RecipeDoc,
  type StageDuration,
} from '@salt/domain/schemas';
import { flattenIngredients, stageTemperatureText } from '@salt/domain';
import { withAiTimeout } from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { flowModel } from '../ai/fakeModel.js';
import { equipmentSectionForStages, readEquipmentItems } from './equipmentContext.js';
import { STAGE_KIND_RULES } from './extractProcessStages.js';
import { requireRecipeFrom } from './loadRecipe.js';

// proposeSchedule (issue #812, phase 2 of epic #778). The PROPOSAL tier: takes a
// formula's reference process and a time the household wants to eat, and returns a
// RESTRUCTURED process plus the reasoning for it — ninety minutes of bulk on the
// counter becoming twenty on the counter and eight in the fridge, so the bake
// lands at 07:30 and nobody is shaping dough at three in the morning.
//
// The BETTER TIER, and the epic's contract is explicit about why: this is
// judgement, not transcription. Its sibling `extractProcessStages` runs on `lite`
// because the answer is in the words in front of it; this one is deciding what to
// do, which is exactly what the two-tier split exists for.
//
// ─── IT EMITS NO TIMESTAMPS AND NO GRAMS ───────────────────────────────────────
//
// Stages and prose, and nothing else. `resolveSchedule` puts the stages on a clock
// (back-solving from the requested finish, which hits the minute by construction)
// and `solveFormula` turns percentages into weights. The model's own arithmetic is
// never load-bearing — see schemas/proposeSchedule.ts for the full argument, and do
// not add a time or a weight to the output schema.
//
// The leavening opinion crosses as a MULTIPLICATIVE FACTOR against a named
// component's stored percent, applied by `withComponentPercentScaled` and re-solved
// through the same rounding as everything else. "Longer and colder, so I'd take the
// yeast down to about two-thirds" is an opinion a baker can disagree with; a gram
// figure from a language model is a guess wearing the clothes of a calculation.
//
// Like its sibling it reads SERVER-SIDE via the Admin SDK — the recipe AND its
// formula, from ids alone — and PERSISTS NOTHING. What comes back is reviewed as a
// diff (`diffProcess`), and the user's Start is what freezes a batch.
//
// THREE PROPERTIES ARE ENFORCED IN CODE rather than left to the prompt, each for
// the same reason as in extraction: they are things a model gets wrong on real
// recipes and none of them is worth a coin toss. A citation to a stage that is not
// there loses the citation; a citation to a step that is not there loses the
// citation; an adjustment to an ingredient that is not there is dropped whole. See
// each below.

// Quoted VERBATIM from `ProcessStageKindSchema`'s field docs, by importing the
// single constant its sibling flow already publishes rather than by copying the
// words a second time. The spike's headline defect was the bake being labelled
// differently on each of three bread recipes; a second paraphrase in a second
// prompt is precisely how that comes back. There is one definition, in
// @salt/domain/schemas, and both prompts quote it — the extraction test pins the
// schema and the constant together, and this flow's test pins the constant into
// this prompt.
const PROPOSE_SCHEDULE_SYSTEM = `You are a baker planning when to do each part of a bake so it finishes at the time the household asked for.

You are given the recipe's process as it stands — an ordered list of stages, each with a temperature and a duration — and the time it must be finished by. Rearrange it so it lands there and so the people doing it are awake. Return the stages you would actually do, in order.

## active or wait
${STAGE_KIND_RULES}

## What you must NOT write
- NO CLOCK TIMES. Not on a stage, not anywhere. You return durations and temperatures; the app works out when each stage starts and ends, and it lands on the requested time exactly. A time from you would only be a second, worse answer.
- NO WEIGHTS. Not in grams, not in percentages. The app resolves those too.

## The rules the plan must obey
- NO STAGE MAY *START* DURING THE HOUSEHOLD'S QUIET HOURS, given below. Nobody is awake then. A stage may run THROUGH the night — that is what a fridge retard is for — but nobody may be required to get up and begin one.
- The last stage must be the one that finishes the food, because the finish is what is being timed.
- The preheat MAY sit inside the final proof, and often should: an oven coming up to temperature is a \`wait\` and the dough is proving at the same time. That overlap is correct and is not a mistake to avoid.
- Keep the stages the dough actually needs. You may move time between them, change where a stage happens, split one stage into two, or add a stage the schedule needs (a cold retard is the usual one). Do not throw away a stage the bake depends on. Where a stage can happen is the list of places below when there is one — this household's own, not an assumed counter and fridge.
- THE KITCHEN'S TEMPERATURE TODAY is given below whenever the baker answered. Reason from the figure they gave rather than from a room you have assumed: a counter bulk at 26 °C is not the same stage as one at 16 °C. Say in the rationale what you did about it.

## DOING NOTHING IS A REAL ANSWER
If the process already lands at the requested time with nobody up in the night, RETURN IT UNCHANGED and say so in the rationale. The app will show "nothing to change". Restructuring a schedule that did not need it is a worse answer than leaving it alone — restraint here matters as much as the restructure.

## What each stage carries
- \`label\`: two or three words. "Bulk ferment", "Cold retard", "Shape", "Preheat the oven", "Bake".
- \`kind\`: \`active\` or \`wait\`, by the rule above.
- \`environment\`: where the stage happens. \`temperature\` is \`{ "kind": "fixed", "celsius": N }\` for a figure the recipe means exactly (an oven at 240), or \`{ "kind": "range", "minCelsius": N, "maxCelsius": M }\` for one that is really a band ("somewhere warm, 22–26"). KEEP A RANGE AS A RANGE — do not average it. Copy \`equipmentId\` through from the existing stage unchanged, or null. Null the whole \`environment\` when there is nothing to say — a mix has no meaningful temperature.
- \`duration\`: \`{ "kind": "fixed", "minutes": N }\`, or \`{ "kind": "range", "minMinutes": N, "maxMinutes": M }\` when you mean a spread. KEEP A RANGE AS A RANGE — do not average it. Null only for a stage that is genuinely watched rather than timed.
- \`until\`: the observable sign the stage is done, in a baker's terms — "until doubled", "until it springs back slowly". Null when there is none.
- \`stepId\`: the recipe step this stage corresponds to, copied verbatim from the method below. Null when it corresponds to none.
- \`sourceStageId\`: the id of the EXISTING stage this one came from, copied verbatim from the process below. Null for a stage you are adding. If you split one existing stage into two, give BOTH halves that stage's id — the app will show it as one stage removed and two added, which is the honest description of what happened.

## The rationale
A short paragraph in plain English, addressed to the baker: what you moved, and why. Name the trade-off if there is one. This is stored on the batch and read months later.

## The leavening
If — and only if — your plan makes the fermentation much longer or much colder than the recipe intended, say what you would do to the yeast: name the ingredient by its id from the list below, give a FACTOR against its current percentage (0.66 means "down to about two-thirds"), and say why in one sentence. This is an opinion offered to a baker, not a calculation: they may disagree and the app will let them. Leave it null — which is the normal answer — when the ferment is broadly as intended, and never adjust anything but the leavening.

Write British English. Temperatures in °C only.`;

function describeDuration(duration: StageDuration | null): string {
  if (duration === null) return 'no fixed time';
  if (duration.kind === 'fixed') return `${duration.minutes} min`;
  return `${duration.minMinutes}–${duration.maxMinutes} min`;
}

// `placeNames` is the manifest's own id → name map. A stage citing a place the
// manifest does not hold says only its temperature: a raw id in a prompt is noise,
// and the same one-way rule governs the output (see the drop below).
function describeStage(stage: ProcessStage, placeNames: ReadonlyMap<string, string>): string {
  const placeName =
    stage.environment === null || stage.environment.equipmentId === null
      ? undefined
      : placeNames.get(stage.environment.equipmentId);
  const parts = [
    `[${stage.id}]`,
    stage.kind,
    `"${stage.label}"`,
    describeDuration(stage.duration),
    stage.environment === null ? null : stageTemperatureText(stage.environment.temperature),
    placeName === undefined ? null : `in the ${placeName}`,
    // The criterion in the recipe's own words, in brackets: it usually already
    // starts "until", and "until until doubled" reads as carelessness to a model
    // being asked to be careful.
    stage.until === null ? null : `(${stage.until})`,
    stage.stepId === null ? null : `step ${stage.stepId}`,
  ];
  return parts.filter((part): part is string => part !== null).join(' · ');
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

// The target as a person would say it. The input is a LOCAL wall clock with no
// offset (see the input schema), so it is parsed as if it were UTC purely to read
// the weekday off it — no zone conversion happens anywhere, and none should: the
// model never converts a time and never emits one.
function describeTarget(targetEndAtLocal: string): string {
  const [date, time] = targetEndAtLocal.split('T');
  const at = new Date(`${date}T00:00:00Z`);
  const weekday = Number.isNaN(at.getTime()) ? '' : `${WEEKDAYS[at.getUTCDay()]} `;
  return `${weekday}${date} at ${time}`;
}

function describeQuietHours(quietHours: QuietHours): string {
  const pad = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
  return `${pad(quietHours.fromHour)} to ${pad(quietHours.toHour)}`;
}

// What the model sees. The RECIPE'S METHOD IS INCLUDED, unlike in extraction: the
// stages are already extracted, so there is no risk of re-transcribing them, and a
// schedule is judgement about a particular dough — whether it is enriched, whether
// it is sourdough, whether the shaping is fiddly — which the stage labels alone do
// not carry. The step ids come with it because the output cites them.
//
// The FORMULA'S COMPONENTS are shown as percentages with their labels, for one
// reason only: the leavening opinion has to name an ingredient by id. Grams are
// deliberately absent — the model has no business holding a weight it might echo.
function promptFor(
  recipe: RecipeDoc,
  formula: Formula,
  process: readonly ProcessStage[],
  targetEndAtLocal: string,
  quietHours: QuietHours,
  ambientCelsius: number | null,
  placeNames: ReadonlyMap<string, string>,
): string {
  const labels = new Map(
    flattenIngredients(recipe).map((ingredient) => [ingredient.id, ingredient.rawText]),
  );
  const componentLines = formula.components.map((component) => {
    const label = labels.get(component.ingredientId) ?? '(no longer in the recipe)';
    const basis = component.inBasis ? ' (part of the basis)' : '';
    return `- [${component.ingredientId}] ${label} — ${component.percent}%${basis}`;
  });
  const stepLines = recipe.steps.map((step, i) => `${i + 1}. [${step.id}] ${step.text}`);

  return [
    `Title: ${recipe.title}`,
    `Finished by: ${describeTarget(targetEndAtLocal)}`,
    `Quiet hours (nobody is awake): ${describeQuietHours(quietHours)}`,
    // Omitted entirely when the baker skipped the question, rather than sent as a
    // guess: a made-up room temperature is worse than none, because the model
    // would reason from it as though somebody had measured it.
    ambientCelsius === null ? null : `Kitchen temperature today: ${ambientCelsius} °C`,
    `The process as it stands:\n${process.map((stage) => describeStage(stage, placeNames)).join('\n')}`,
    componentLines.length > 0 ? `The formula:\n${componentLines.join('\n')}` : null,
    stepLines.length > 0 ? `Method:\n${stepLines.join('\n')}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join('\n\n');
}

// One stage's environment with an unresolvable `equipmentId` nulled out. Returns
// the environment UNTOUCHED when there is nothing to drop, so a household with no
// manifest gets object-for-object what the model returned.
function dropUnknownPlace<T extends { equipmentId: string | null }>(
  environment: T | null,
  placeNames: ReadonlyMap<string, string>,
): T | null {
  if (environment === null) return environment;
  const { equipmentId } = environment;
  if (equipmentId === null || placeNames.has(equipmentId)) return environment;
  return { ...environment, equipmentId: null };
}

export const proposeScheduleFlow = ai.defineFlow(
  {
    name: 'proposeSchedule',
    inputSchema: ProposeScheduleInputSchema,
    outputSchema: ProposeScheduleOutputSchema,
  },
  async ({ recipeId, targetEndAtLocal, quietHours, ambientCelsius }) => {
    const db = getFirestore();
    // The manifest rides in the same round trip. It is an ENHANCEMENT, never a
    // hard dependency: `readEquipmentItems` degrades to [] on a missing or corrupt
    // document, and a household that has described no place gets byte-for-byte the
    // prompt it got before this issue.
    const [recipeSnap, formulaSnap, equipmentItems] = await Promise.all([
      db.collection('recipes').doc(recipeId).get(),
      db.collection('formulas').doc(recipeId).get(),
      readEquipmentItems(db, 'proposeSchedule'),
    ]);

    // Both are trust boundaries (Firestore reads), so both are validated — the
    // recipe's half by the helper the sibling flows share, the formula's here
    // because only this flow reads one.
    const recipe = requireRecipeFrom(recipeSnap);
    if (!formulaSnap.exists) {
      throw new HttpsError('failed-precondition', "That recipe doesn't have a formula yet.");
    }
    const formula = FormulaSchema.safeParse(formulaSnap.data());
    if (!formula.success) {
      throw new HttpsError('failed-precondition', "That formula can't be read.");
    }

    // A process with no stages is nothing to reschedule, and asking the model to
    // invent one here would be `extractProcessStages`' job done twice and worse.
    const process = formula.data.process ?? [];
    if (process.length === 0) {
      throw new HttpsError(
        'failed-precondition',
        'That formula has no stages yet, so there is nothing to schedule.',
      );
    }

    // `pro` (see the flow header and AI_FLOW_ROLES): judgement, not transcription.
    // `flowModel` returns the deterministic e2e fake under FUNCTIONS_AI_FAKE, which
    // is what keeps this flow off live Gemini in every e2e run.
    const model = await flowModel('proposeSchedule');
    // REUSED, not rewritten: `equipmentSectionForStages` is the framing
    // `extractProcessStages` already asks places with, and every framing lives in
    // that one file so two prompts cannot drift (see its header). '' when there is
    // nothing to show.
    const placesSection = equipmentSectionForStages(equipmentItems);
    const placeNames = new Map(
      equipmentItems
        .filter((item) => item.environment !== null)
        .map((item) => [item.id, item.name] as const),
    );
    const result = await withAiTimeout(
      'proposeSchedule',
      () =>
        ai.generate({
          model,
          system: placesSection
            ? `${PROPOSE_SCHEDULE_SYSTEM}\n\n${placesSection}`
            : PROPOSE_SCHEDULE_SYSTEM,
          prompt: promptFor(
            recipe,
            formula.data,
            process,
            targetEndAtLocal,
            quietHours ?? DEFAULT_QUIET_HOURS,
            ambientCelsius ?? null,
            placeNames,
          ),
          output: { schema: ProposeScheduleAIOutputSchema },
          config: {
            // Warmer than extraction's 0 and for the opposite reason: there is one
            // correct transcription of a method but there are several good
            // schedules, and a schedule authored at 0 reads like a spreadsheet.
            temperature: 0.4,
            // The spike measured 65–108 s uncapped against 19–31 s capped, at
            // unchanged schedule quality — an enormous saving for nothing given up.
            // NOTE the budget is a TARGET, NOT A CEILING on this model family (a
            // capped run reported 4,365 thinking tokens against a 1,024 budget),
            // which is why the timeouts are not sized off it.
            thinkingConfig: { thinkingBudget: 4096 },
          },
        }),
      // Its own budget rather than the house text-flow values: this call
      // legitimately runs for a minute or more. See the three constants in
      // schemas/proposeSchedule.ts for how the three deadlines nest. No retry — a
      // human is sitting in front of a sheet with a button they can press again,
      // and a second 150 s attempt would outlive the function.
      { timeoutMs: PROPOSE_SCHEDULE_AI_TIMEOUT_MS, retries: 0 },
    );

    const parsed = ProposeScheduleAIOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`proposeSchedule returned invalid output: ${parsed.error.message}`);
    }

    // AN EMPTY PROPOSAL IS A FAILURE, NOT A DECLINE. Declining means returning the
    // process as it stands — which diffs to no changes — whereas no stages at all
    // would render as "remove everything", which is never the right answer for a
    // dough that has to be mixed and baked. Enforced here for the same reason
    // extraction enforces its no-waits rule in code: a model given a plausible
    // degenerate answer will occasionally take it.
    if (parsed.data.stages.length === 0) {
      throw new Error('proposeSchedule returned no stages');
    }

    // A citation to a stage or a step that does not exist loses the CITATION, not
    // the stage — the extraction precedent, not the guided-plan one. `sourceStageId`
    // and `stepId` are both optional one-way back-references, and a cold retard is
    // still a cold retard without either; dropping the stage would tear a hole in
    // the middle of a schedule the bake depends on. The cost is small and visible:
    // an uncited stage renders as an addition in the review, which is honest — we
    // cannot say what it came from.
    //
    // An `equipmentId` the manifest does not hold is dropped the SAME WAY, and for
    // the same reason: it is the same kind of one-way reference (see
    // `StageEnvironmentSchema.equipmentId`), and a stage whose place cannot be
    // resolved is still a stage that has to happen. What the reader loses is the
    // place, which we could not have rendered anyway.
    const stageIds = new Set(process.map((stage) => stage.id));
    const stepIds = new Set(recipe.steps.map((step) => step.id));
    const stages = parsed.data.stages.map((stage) => ({
      ...stage,
      environment: dropUnknownPlace(stage.environment, placeNames),
      sourceStageId:
        stage.sourceStageId !== null && stageIds.has(stage.sourceStageId)
          ? stage.sourceStageId
          : null,
      stepId: stage.stepId !== null && stepIds.has(stage.stepId) ? stage.stepId : null,
    }));

    // An adjustment naming an ingredient the formula does not hold is DROPPED WHOLE
    // — and here the guided-plan precedent is the right one, not extraction's. A
    // note is nothing without the step it annotates, and a factor is nothing without
    // the component it multiplies: there is no id to null out and still have a
    // meaningful thing left. The rationale prose survives regardless, so the words
    // are never lost with the number.
    const componentIds = new Set(formula.data.components.map((c) => c.ingredientId));
    const adjustment: ComponentAdjustment | null =
      parsed.data.adjustment !== null && componentIds.has(parsed.data.adjustment.ingredientId)
        ? parsed.data.adjustment
        : null;

    return { stages, rationale: parsed.data.rationale, adjustment };
  },
);
