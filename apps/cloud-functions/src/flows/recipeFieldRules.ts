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

// The five kinds of cure (issue #1404), and what tells them apart. Nested inside
// KIND_RULES rather than standing beside it, because it is meaningless on its own:
// the answer is null for every entry the question above did not call a cure, and
// two rules a model must correlate across a prompt is how they come to disagree.
//
// They are named for the SAFETY MECHANISM, not for the shape of the thing, and the
// rules say so — a model asked to sort by appearance puts a saucisson with a
// bresaola because both are hanging, which is the one mistake that matters here.
//
// A WRONG answer is cheap, and that is deliberate: the category is corrected on
// the recipe page in a tap, with no confirmation and no gate. So this asks the
// model to choose rather than to hedge, and takes null only for a genuine refusal.
const CURE_CATEGORY_RULES = `- cureCategory: which of FIVE kinds of cure, and null for anything whose kind is \
not "cure". Sort by what makes it safe to eat, never by what it looks like:
  "dry_cured_whole_muscle" — a whole piece of muscle made safe by salt and by losing a third of \
its weight to the air, eaten raw without cooking. Prosciutto, bresaola, coppa, lonza, culatello.
  "cooked_whole_muscle" — a whole piece of muscle cured with salt or nitrite and then COOKED, \
smoked or boiled, and cooked again or eaten cold. It is not shelf-stable. Back and streaky bacon, \
gammon, ham, pastrami, kassler.
  "fermented_dry_cured" — MINCED meat fermented by bacteria until it is sour, then dried, and \
eaten raw. This is salami in the broad sense. Saucisson sec, finocchiona, fuet, chorizo, \
soppressata.
  "semi_dry" — minced meat soured quickly and only partly dried, usually smoked, and usually kept \
in the fridge rather than on a shelf. Summer sausage, landjäger, pepperoni, snack sticks.
  "cooked_emulsified" — meat cured and then worked into a smooth paste and fully cooked, eaten \
cold or hot. Mortadella, frankfurters, bologna, saucisson de Lyon cuit, liver sausage.
  Choose the closest of the five rather than refusing; answer null only when the entry is not a \
cure at all.`;

// WHICH SECTION OF THE LIBRARY does an AI-created entry land in — a drink you
// mix, cured meat, or something you eat (issues #765, #1404).
//
// UNCONDITIONAL, and it lives here rather than in each of the four prompts that
// interpolate this module (the URL import's two, the photo import's, the
// librarian's) for the reason the module exists: three copies of a
// classification rule is three classifications one edit apart from disagreeing,
// which is exactly what #785 pulled apart.
//
// The tie-break is stated as loudly as the question, because the mistakes are NOT
// symmetrical. A cocktail — or a cure — filed under Recipes is merely in the wrong
// chip and works in every other way. A dinner filed under either can never be put
// on the meal plan (`isPlannable` is false for both) and `kind` is immutable, so
// that one is a permanent loss of function with no route back but deleting the
// entry. Everything doubtful therefore goes to `recipe`, and #1404 inherited that
// argument unchanged rather than restating it: the shelf a cure sits on is worth
// far less than the planner slot a misfiled dinner loses. The schema enforces the
// same floor independently (`AuthoredRecipeKindSchema`); this states the
// preference, the schema guarantees it.
//
// The CATEGORY is the opposite case and is treated as such (#1404): it is
// editable on the recipe page in a tap, so a wrong one costs nothing and
// `CURE_CATEGORY_RULES` asks the model to choose rather than to hedge.
const KIND_RULES = `- kind: "cocktail" ONLY for a drink that is MIXED and served in a glass — a \
Negroni, a margarita, a highball, a punch. "cure" ONLY for CURED MEAT. "recipe" for everything \
else, including everything you merely have doubts about.
  Anything you eat is a recipe, however boozy: a tiramisu, a rum baba, a beer-braised shoulder. So \
is anything you brew, infuse, bottle or keep — a cordial, a syrup, a stock, a hot chocolate, a \
smoothie, a pot of tea — and so is a mocktail. When it is not clearly a mixed drink in a glass, \
answer "recipe".
  "cure" means meat preserved by salt, nitrite, drying, fermentation or smoking, made to be KEPT \
and sliced rather than served as a meal the day it is made — a prosciutto, a bresaola, a coppa, a \
bacon, a gammon, a pastrami, a saucisson, a chorizo, a summer sausage, a mortadella. A dish that \
merely CONTAINS cured meat is a recipe: a carbonara, a charcuterie board, a bacon sandwich. A \
fresh sausage you fry the same day is a recipe. Fish, vegetables and dairy are never "cure", \
however they are preserved — gravlax, sauerkraut, kimchi and cheese are all recipes. When it is \
not clearly cured meat, answer "recipe".
${CURE_CATEGORY_RULES}`;

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
