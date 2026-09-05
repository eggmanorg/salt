import { CATEGORY_TAG_RULES } from './categoryTags.js';
import { INGREDIENT_SUBSTITUTION_RULES } from './ingredientConversions.js';
import { STEP_RULES, FIRST_USE_ORDINAL_RULE } from './stepRules.js';

// THE field-rule policy for every recipe-AUTHORING path (issue #785): the URL
// import (extractRecipeFromUrl, both its JSON-LD and HTML prompts), the photo
// import (extractRecipeFromPhoto) and the librarian (authorRecipe, which covers
// create, edit and variation chats).
//
// It began as extraction-only (`recipeExtractionRules.ts`, two exported consts)
// while the librarian carried a hand-rolled twin of the same field list. Four of
// the five top-level bullets were byte-identical and the two blocks had drifted
// in BOTH directions, which is exactly what CATEGORY_TAG_RULES,
// INGREDIENT_SUBSTITUTION_RULES and STEP_RULES were each pulled out to prevent —
// the extraction just stopped one layer short of the block around them.
//
// ONE genuine difference survives, and it is a NAMED ARGUMENT rather than two
// prose blocks that happen to disagree:
//
//   measures: 'metricate' — the source is a finished recipe in someone else's
//     WORDING (a web page, a cookbook page). Rewriting the line into a clean,
//     British, metric one is the entire point.
//   measures: 'preserve' — the source is the conversation the user is looking
//     at. The chef just said "a teaspoon of cumin"; rewriting that inside the
//     same turn makes the saved recipe stop matching the words on screen, which
//     reads as the librarian ignoring them.
//
// NOTE what that argument does NOT decide any more: the UNITS. MEASURE_RULES is
// unconditional — every path emits grams, millilitres or a count, and every path
// keeps tsp/tbsp verbatim for the parse stage. `measures` now governs only how
// freely the LINE may be rewritten around those units.
//
// Everything else is unconditional, including the two ingredient-hygiene rules
// (commit to one ingredient, split a combined line) — a "salt and freshly ground
// black pepper" line off a website is exactly as unmatchable as one from a chat.
// They already reach both paths, because they live inside
// INGREDIENT_SUBSTITUTION_RULES.
//
// The result slots into a prompt as two whole sections, so the heading levels and
// the bullet indentation below are load-bearing. Pinned by
// recipeFieldRules.test.ts plus a per-flow test on each of the three paths.

export type MeasurePolicy = 'preserve' | 'metricate';

export function recipeFieldRules({ measures }: { measures: MeasurePolicy }): string {
  return `${conversionRules()}

${fields(measures)}`;
}

// The unit vocabulary, and it is UNCONDITIONAL — a recipe this app wrote is in
// grams, millilitres or counts whether it came off a web page or out of a chat.
//
// The spoon exception is the load-bearing half, and it is a PIPELINE fact rather
// than a preference. `assembleRecipeDraft` feeds the rawText emitted here into
// `parseRecipeIngredientsFlow`, which is what turns "1 tsp" into
// `quantity: 2, unit: 'g'` AND sets `displayText: '1 tsp'` — the bracketed form
// `IngredientText.svelte` renders as "2g whole black peppercorns (1 tsp)". Parse
// never sees the original source line, only this rawText, so a prompt that
// metricates the spoon itself here doesn't move the tsp into the bracket: it
// deletes it, and parse then correctly emits `displayText: null` because the line
// it was handed was already in grams. The instruction to convert tablespoons and
// teaspoons used to sit in the 'metricate' bullet for exactly that reason, and it
// is why imports lost their spoon measures while chat-authored recipes kept them.
const MEASURE_RULES = `- Metric or count values only: grams/kilograms for weight, millilitres/litres for liquid, or a plain \
count of the thing as it is bought ("2 cloves garlic", "1 tin chopped tomatoes", "3 eggs"). NEVER cups, \
sticks, pints, quarts, fluid ounces, ounces or pounds — convert them, and never introduce one the source \
did not use.
- tsp and tbsp are the ONE exception: leave a spoon measure EXACTLY as the source wrote it ("1 tsp \
ground cumin", "½ tbsp honey"). Do NOT convert it to grams or millilitres yourself. A later stage does \
that conversion and keeps the spoon as the bracketed form the cook reads — "2g whole black peppercorns \
(1 tsp)" — so converting it here is what DESTROYS it.`;

function conversionRules(): string {
  // None of these is a measure the chef chose, so preserving the source's wording
  // preserves nothing worth keeping — an app that writes recipes in British
  // English and metric writes them that way from a chat as much as from a URL.
  return `## Conversion rules (apply to EVERYTHING)
${MEASURE_RULES}
- Temperatures in °C only — never Fahrenheit; convert and round sensibly (e.g. 350°F → 180°C).
${INGREDIENT_SUBSTITUTION_RULES}
- Use British spelling everywhere (e.g. "flavour", "colour", "caramelise").`;
}

// WHAT A RECIPE'S TIMING IS, and it is unconditional — a recipe off a web page
// and one out of a chat have to be comparable, or the list's "quickest first" sort
// and the cook plan are measuring different things (issue #952).
//
// EXPORTED (issue #952, phase 2; renamed from `TIME_RULES` in #1233) so every
// authoring path — both extractors, the librarian and the re-estimator — asks for
// phases against ONE text and never a paraphrase. A second copy anywhere is the
// #785 twin, and it would leave half the library's timelines drawn to one
// definition of "hands-on" and half to another.
//
// This block used to sit UNDER definitions of the three prep / cook / total time
// fields, including a `total >= prep + cook` clause. Issue #1233 removed all four:
// nothing stored those three any more, so asking for them bought a model call for
// an answer that was thrown away, and the reconciliation clause is definitional
// once elapsed time is a sum of the parts by construction. Issue #1211 then deleted
// the fields themselves — `recipeFieldRules.test.ts` pins that no rule names them.
//
// TWO numbers per phase, never a third. Elapsed time is derived from them, and
// asking the model for it as well is asking for a number that can contradict the
// two it was added to.
//
// OVERLAP is the sharpened half. "Counts ONCE" already sat in the estimator's own
// heuristics; what it never said was WHERE the overlapped work goes, which is why
// a pan of water coming to the boil landed nowhere at all. It goes in the phase
// that contains it, as hands-off minutes, and the attended work happening across
// it is that same phase's hands-on minutes.
//
// Two more heuristics folded in from the backfill's own prompt (issue #1191,
// closed as superseded once this fold-in and the definitions above already
// covered its ask): scaling hands-on work with servings, and treating a step's
// own timer as a floor. Both hold whether the phases are being read off an
// existing recipe or generated in the same pass as the steps themselves, so
// unlike the backfill's remaining reading-specific instructions (see
// `estimateRecipeTimes.ts`), they belong here rather than staying flow-local.
export const PHASE_RULES = `- phases: the recipe's timing as an ORDERED list of 3–6 named blocks, in the order the \
cook does them, covering the whole process from walking into the kitchen to the dish being ready. \
Name each one for what it IS in a couple of words — "Mix & knead", "First rise", "Roast cauliflower \
& make sauce", "Bake", "Cool", "Prep", "Cook". A simple dish may need only two or three; never more \
than six.
  Each phase carries exactly two numbers, both whole non-negative minutes:
  - handsOnMinutes: minutes the cook is actively working during that block.
  - handsOffMinutes: minutes of that block that pass WITHOUT the cook — heat, a prove, a chill, a \
rest, a pan coming to the boil, an oven heating.
  The block's elapsed time is those two added, so do NOT return a total for a phase.
- Phases are NOT steps. Several steps collapse into one phase, and a phase is named for what it is, \
not for the steps inside it. Do not emit one phase per step.
- Scale hands-on minutes with the servings stated for the recipe. Dicing two onions is not dicing six.
- Where a step carries its own timer, that number is a floor for the hands-on or hands-off minutes \
it belongs to — not a starting guess to round down from.
- Work that OVERLAPS goes in ONE phase, never two. Roasting the cauliflower while you make the \
sauce is a single 20-minute phase with 15 minutes hands-on inside it. Where several things share a \
window and no single name fits, give the phase a general name ("Cook").
- Account for EVERY minute the cook waits, including the ones no step bothers to time: bringing a \
pan of water to the boil, heating the oven, waiting for butter to soften. Those are hands-off \
minutes of the phase they happen in. A recipe whose phases sum to less than the real wall clock is \
the failure being fixed.
- Overestimate rather than underestimate a phase, but assume a competent cook who overlaps what any \
competent cook would overlap. Round to numbers a person would say: 5, 10, 15, 20, 30, 45, 90.
- timingSummary: ONE short plain sentence over the strip, saying how much of it is the cook and how \
long the whole thing spans — "About 40 minutes of you, spread over 2¼ hours — start it the night \
before." Null only when you have no phases.`;

// IS IT A DRINK YOU MIX, OR SOMETHING YOU EAT (issue #765) — the one question
// that decides which section of the library an AI-created entry lands in.
//
// UNCONDITIONAL, and it lives here rather than in each of the four prompts that
// interpolate this module (the URL import's two, the photo import's, the
// librarian's) for the reason the module exists: three copies of a
// classification rule is three classifications one edit apart from disagreeing,
// which is exactly what #785 pulled apart.
//
// The tie-break is stated as loudly as the question, because the two mistakes are
// NOT symmetrical. A cocktail filed under Recipes is merely in the wrong chip and
// works in every other way. A dinner filed under Cocktails can never be put on
// the meal plan — `isPlannable('cocktail')` is false — and `kind` is immutable,
// so that one is a permanent loss of function with no route back but deleting the
// entry. Everything doubtful therefore goes to `recipe`. The schema enforces the
// same floor independently (`AuthoredRecipeKindSchema`); this states the
// preference, the schema guarantees it.
const KIND_RULES = `- kind: "cocktail" ONLY for a drink that is MIXED and served in a glass — a \
Negroni, a margarita, a highball, a punch. "recipe" for everything else, including everything you \
merely have doubts about.
  Anything you eat is a recipe, however boozy: a tiramisu, a rum baba, a beer-braised shoulder. So \
is anything you brew, infuse, bottle or keep — a cordial, a syrup, a stock, a hot chocolate, a \
smoothie, a pot of tea — and so is a mocktail. When it is not clearly a mixed drink in a glass, \
answer "recipe".`;

function fields(measures: MeasurePolicy): string {
  return `## Fields
- title: clear, concise recipe name.
${KIND_RULES}
- description: 1–2 sentence summary, or null.
- servings: integer portions, or null if not stated.
${PHASE_RULES}
${CATEGORY_TAG_RULES}
- ingredientGroups: group ingredients by course/stage (null name = default group).
  Each ingredient: ${rawTextClause(measures)}, isOptional (true only if explicitly optional), \
${FIRST_USE_ORDINAL_RULE}
${STEP_RULES}
- notes: the author's overall notes/tips, or null.`;
}

// The one clause the source kind actually changes — how freely the LINE may be
// rewritten, not what units it lands in (MEASURE_RULES settles that for both).
// Under 'preserve' it also has to say which rules BEAT preservation: the measure
// and ingredient-hygiene rules above are unconditional, and without the
// precedence sentence "preserve the original wording" reads as a licence to keep
// "1 cup heavy cream" and "salt and pepper".
//
// The bracket clause added under 'preserve' (#934) is the other half of the chef
// flipping to metric-first. The chef now writes "3 g salt (½ tsp)", so a chat line
// reaches `parseRecipeIngredients` ALREADY IN GRAMS — and that flow correctly
// emits `displayText: null` for an already-metric source. Left alone, the flip
// would silently strip the spoon measure from every chat-authored recipe. The
// bracket has to survive this transcription for the parser to have anything to
// lift, which is why the two changes could not ship apart. The parser's matching
// half is its "already reads metric-first with a spoon measure in brackets"
// bullet; the two are pinned together in
// `apps/cloud-functions/tests/flows/unitPolicy.test.ts`.
function rawTextClause(measures: MeasurePolicy): string {
  if (measures === 'metricate') {
    return `rawText (the ingredient line rewritten in British spelling/terms and the units the measure \
rules above allow — this is what the rest of the pipeline parses, so write a clean natural line e.g. \
"240ml whole milk", "2 cloves garlic, crushed" or "1 tsp ground cumin")`;
  }
  return `rawText (preserve the original wording and any tsp/tbsp measures the chef used — INCLUDING \
a spoon measure the chef wrote in brackets AFTER a metric amount ("3 g salt (½ tsp)", "15 ml oil \
(1 tbsp)"): copy that bracket through exactly as written, because a later stage lifts it out as the \
form the cook reads and dropping it here loses it for good — EXCEPT \
where the conversion rules above take precedence — always use the measure rules' units (never a cup, \
pint or ounce, however the chef phrased it), always use the British ingredient NAMES (e.g. "double \
cream" not "heavy cream"), commit to a single ingredient rather than an either-or choice, and split any \
line that combines two distinct ingredients into two separate ingredients ("Salt and freshly ground \
black pepper" → two ingredients). These override "preserve the original wording")`;
}
