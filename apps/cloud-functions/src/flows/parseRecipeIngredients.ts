// Text → structure, and NOTHING ELSE: this flow reads an ingredient line (or a
// whole list) and returns parsed groups. IT DELIBERATELY PERSISTS NOTHING, and
// that is load-bearing rather than an oversight (issue #1435, epic #1417).
//
// Two reasons, both of which must stay true for the sentence above to stay true:
//
//   1. IT CANNOT NAME A DOCUMENT. `ParseRecipeIngredientsInputSchema` is
//      `{ rawText }` and nothing else — no recipe id, no group id, no ingredient
//      id. Writing would take a wire-contract change, not a `getFirestore()` call.
//   2. ITS IN-PROCESS CALLERS NEED IT PURE. Two files call this flow directly:
//      `assembleRecipeDraft.ts`, itself reached by `extractRecipeFromUrl.ts`,
//      `extractRecipeFromPhoto.ts` and `authorRecipe.ts` — every URL import, photo
//      import and chat-authored recipe; and `scripts/rematch-ingredients.ts`. The
//      three import paths already persist at the right moment, once and whole, via
//      `persistAuthoredRecipe`, so a write here would fire mid-assembly, writing
//      partial ingredient state — onto a recipe that does not exist yet on the
//      import and create paths, and onto a LIVE recipe the family can already
//      read on `authorRecipe`'s edit path (a non-null `baseRecipe`). The script's
//      default mode is deliberately read-only, and a write here would break that
//      promise silently.
//
// The claim is PINNED, not merely asserted (CLAUDE.md rule 12): a source scan in
// `tests/flows/parseRecipeIngredients.test.ts` fails if this file grows a
// `firebase-admin` import, a `getFirestore` or a `firestore()`. Its boundary is
// exactly that — it pins what this FILE imports, not what a helper it calls might
// do, so keep the write out rather than routing it through a module.
//
// The browser-side consequence — the ✗ rematch on a recipe row persists in the
// page, not here, and why that is right — is argued at the callable in
// `../index.ts` and at `matchIngredient` in `web-pwa/src/lib/recipeService.ts`.
import {
  ParseRecipeIngredientsInputSchema,
  ParseRecipeIngredientsAIOutputSchema,
  ParseRecipeIngredientsOutputSchema,
} from '@salt/domain/schemas';
// The reader-facing unit policy, shared with the chef's prose (#934). It governs
// `displayText` — the bracket the cook reads — and nothing else here; the
// `quantity`/`unit` conversion rules below are this flow's own.
//
// `SPOON_MEASURE_CAP_TBSP` and `clampSpoonMeasureDisplayText` are the #1196
// pair: the constant is interpolated into every prompt bullet that states the
// bound (so it is one number, not five hand-typed literals), and the clamp is
// the deterministic backstop applied to every `displayText` after generation —
// see the header comment on `unitPolicy.ts` for why prose alone isn't enough.
import {
  READER_UNIT_PRINCIPLE,
  SPOON_MEASURE_CAP_TBSP,
  clampSpoonMeasureDisplayText,
} from '@salt/domain/prompts';
import { AI_TEXT_FLOW_TIMEOUT, withAiTimeout } from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { flowModel } from '../ai/fakeModel.js';

export const parseRecipeIngredientsFlow = ai.defineFlow(
  {
    name: 'parseRecipeIngredients',
    inputSchema: ParseRecipeIngredientsInputSchema,
    outputSchema: ParseRecipeIngredientsOutputSchema,
  },
  async ({ rawText }) => {
    // Recipe lists are much larger prompts than single-entry calls, so Flash can
    // take 30–50s on a full ingredient list. Use a higher timeout with no retry:
    // retrying a large legitimate request just doubles the wait for no gain.
    //
    // Production: googleAI.model(resolveModel('parseRecipeIngredients')).
    // Under FUNCTIONS_AI_FAKE=1 (emulator e2e only) flowModel returns the
    // deterministic fake model instead; byte-identical otherwise. See
    // ../ai/fakeModel.ts for the cross-process stub contract.
    const model = await flowModel('parseRecipeIngredients');
    const result = await withAiTimeout(
      'parseRecipeIngredients',
      () =>
        ai.generate({
          model,
          system: SYSTEM_INSTRUCTIONS,
          prompt: rawText,
          output: { schema: ParseRecipeIngredientsAIOutputSchema },
          config: { temperature: 0 },
        }),
      AI_TEXT_FLOW_TIMEOUT,
    );

    const parsed = ParseRecipeIngredientsAIOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`AI returned invalid ingredient structure: ${parsed.error.message}`);
    }

    return parsed.data.groups.map((group) => ({
      id: crypto.randomUUID(),
      name: group.name,
      items: group.items.map((ingredient) => ({
        id: crypto.randomUUID(),
        rawText: ingredient.rawText,
        parsed: {
          quantity: ingredient.quantity,
          unit: ingredient.unit,
          item: ingredient.item,
          preparation: ingredient.preparation,
          notes: ingredient.notes,
          // Deterministic backstop for the spoon-measure cap (#1196): the prompt
          // bullet below only asks the model for it, this nulls a bracket the
          // model returned anyway above the cap so the stored ingredient can't
          // carry one.
          displayText: clampSpoonMeasureDisplayText(ingredient.displayText),
          // Both amounts the line states are kept, and the parse never picks
          // between them (issue #1643). An absent count is written as null so
          // the stored document never carries an `undefined`.
          statedCount: ingredient.statedCount ?? null,
        },
        canonId: null,
        matchState: 'pending' as const,
        isOptional: ingredient.isOptional,
        firstUsedInStepId: null,
      })),
    }));
  },
);

const SYSTEM_INSTRUCTIONS = [
  `You are a recipe ingredient parser. Parse the ingredient list into structured groups and ingredients.`,
  `All quantities are stored in metric (g or ml). Temperatures are always in °C.`,
  ``,
  `## Detecting groups`,
  `A section header is a line that ends with a colon (e.g. "For the sauce:", "Dressing:") or is a short`,
  `standalone phrase (1–4 words) with no quantity, unit, or preparation cues.`,
  `When you encounter a header, start a new group with that header text (without the trailing colon) as`,
  `the name. Ingredients before any header belong to a group with name null.`,
  ``,
  `## Parsing each ingredient line`,
  `For each ingredient line, extract:`,
  `- rawText: the original line verbatim — copy it exactly, do not alter it`,
  `- quantity: the metric amount as a single value ({type:"single",value:n}) or range`,
  `  ({type:"range",min:n,max:n}). Always a decimal — never a fraction type for the canonical value.`,
  `  "2-3 tbsp oil" → {type:"range",min:30,max:45}; "2-3 tbsp flour" → {type:"range",min:16,max:24}.`,
  `  Null if no quantity.`,
  `- unit: the metric unit. Dry/solid ingredients always use "g". Liquid ingredients always use "ml".`,
  `  Convert count/item-based and pack-based ingredients to metric "g" or "ml" — cloves, rashers,`,
  `  packets, bunches, cans, tins, jars, heads, sprigs, sticks, sheets, slices, eggs, joints,`,
  `  whole vegetables, produce, etc. Estimate their metric weight or volume using the conversion`,
  `  table below and put the original count/pack form into displayText. EVERY line that can be`,
  `  weighed gets a metric estimate here, whatever it is — the line's COUNT is recorded`,
  `  separately, in statedCount, and never replaces this amount.`,
  `  Null quantity AND null unit only for genuinely unquantifiable items ("salt to taste", "a pinch",`,
  `  "to serve") — and ONLY when the item is a seasoning already in the cupboard.`,
  `  A VAGUE AMOUNT IS STILL AN AMOUNT. "A squeeze of lemon juice", "a splash of cream", "a drizzle`,
  `  of olive oil", "a handful of parsley" all name something that has to be BOUGHT, and any amount`,
  `  of it means buying the whole thing — a squeeze of lemon juice still means a lemon goes on the`,
  `  list. A null quantity there buys nothing and the ingredient silently vanishes from the shop.`,
  `  So estimate a nominal metric amount instead: a squeeze ≈ 10ml, a splash / drizzle ≈ 15ml,`,
  `  a handful of leaves ≈ 30g, a knob of butter ≈ 15g. Put the author's wording in displayText`,
  `  ("a squeeze") so the recipe still reads the way it was written.`,
  `  EXCEPTION — applied to the EQUIPMENT, not part of the dish: set quantity AND unit to null, and`,
  `  carry the author's stated amount in displayText instead (see below). What triggers this is the`,
  `  EQUIPMENT or SURFACE the ingredient is applied to, or a wash brushed onto the top — never the`,
  `  words "for the" on their own. It covers ONLY these four purposes:`,
  `    (a) greasing or oiling a tin, bowl, tray, mould, grill or paper;`,
  `    (b) flouring or dusting a tin, work surface, banneton or the dough itself;`,
  `    (c) a wash (egg, milk, butter, cream) brushed onto the top;`,
  `    (d) a line whose stated purpose is "for the tin/pan/tray/mould/baking sheet".`,
  `  Examples: "1 tsp cooking oil (for greasing)" → quantity null, unit null, displayText "about`,
  `  1 tsp"; "flour, for dusting" → quantity null, unit null, displayText null; "1 egg, beaten, for`,
  `  the wash" → quantity null, unit null, displayText "about 1 egg"; "butter, for the tin" → quantity`,
  `  null, unit null, displayText null.`,
  `  This EXCEPTION is narrow — every other line keeps its metric amount, however it is worded. A`,
  `  "for the …" line naming any part of the dish is NOT covered: "50g butter, for the sauce" is 50g,`,
  `  "2 tbsp olive oil, for the dressing" is 30ml, "100g flour, for the roux" is 100g. Nor is a`,
  `  cooking medium given an amount: "1 tbsp oil, for frying" is 15ml, "100ml oil, for deep frying" is`,
  `  100ml. Nor are structural, finishing or garnish amounts: "6 tbsp extra virgin olive oil (plus`,
  `  more if needed)" worked into and drizzled over focaccia is 90ml, "2 tbsp olive oil, to finish" is`,
  `  30ml, "25g parmesan to scatter over" is 25g. "plus more if needed" and "as needed" are NOT`,
  `  triggers on their own.`,
  `- statedCount: the NUMBER of whole things the line states, as written — a single value, a range,`,
  `  or a fraction ({type:"mixed",...}) — recorded ALONGSIDE quantity/unit, never instead of them.`,
  `  You never choose between the two: record the metric estimate in quantity/unit AND the count`,
  `  here, for every line that counts whole things, whatever those things are. Which of the two`,
  `  the app shows and shops is decided later, from data you cannot see — so do not guess it.`,
  `  It counts the thing named in item AS IT IS BOUGHT WHOLE: "1 red onion" → 1;`,
  `  "2 eggs, soft-boiled" → 2; "½ small red onion" → {type:"mixed",whole:0,numerator:1,denominator:2};`,
  `  "2-3 carrots" → {type:"range",min:2,max:3}; "1 whole chicken (approx. 1.5 kg)" → 1;`,
  `  "1 roast chicken carcass" → 1.`,
  `  A COUNT NEVER STANDS ALONE. Whenever statedCount is set, quantity and unit are set too:`,
  `  quantity is statedCount × the per-unit weight from the conversion table (or your own`,
  `  estimate). "1 red onion" → statedCount 1, quantity 150, unit "g" — never statedCount 1 with`,
  `  a null quantity. A null quantity beside a count puts nothing on the scales and loses the`,
  `  weight the shopping list totals.`,
  `  A NUMBER THAT COUNTS PIECES OR PACKS IS NOT A COUNT OF THE ITEM, so statedCount is NULL:`,
  `  pieces cut or taken from what you buy (sticks, stalks, leaves, slices, rashers, sprigs,`,
  `  sheets, fillets, segments, egg whites and yolks) and the packs it comes in (tins, cans,`,
  `  jars, packets, bunches). "2 sticks celery" → null; "4 lettuce leaves" → null; "4 rashers`,
  `  bacon" → null; "1 thick slice of lemon" → null; "3 egg whites" → null; "1 tin chopped`,
  `  tomatoes" → null. Two sticks of celery are not two heads of celery, and the app reads this`,
  `  number as whole items. The piece still goes into displayText and its weight into quantity.`,
  `  The ONE exception is a piece the NAMING rule below puts into item — a garlic clove:`,
  `  "3 large cloves of garlic" → 3 (the CLOVES — a size word changes nothing);`,
  `  "a clove of garlic" → 1.`,
  `  Never name any other piece in item to give it a count: "4 lettuce leaves" → item "lettuce".`,
  `  NULL when the line counts nothing: an already-metric line ("300g cauliflower"), a spoon or`,
  `  cup measure ("2 tbsp oil"), a vague amount ("a squeeze of lemon juice", "a handful of`,
  `  parsley"), an unquantifiable seasoning, or an equipment-prep line. NULL too on a COMPONENT`,
  `  line ("juice of 2 limes", "zest of 1 lemon"): there the number counts the PARENT fruit, not`,
  `  the juice or zest named in item, and the parent count is already in displayText.`,
  `- item: the ingredient name after stripping quantity, unit, and preparation phrases.`,
  `  NAMING — the PART of a thing you use belongs to its NAME, not to preparation.`,
  `  preparation is for ACTIONS done to something you buy whole (chopped, sifted, melted,`,
  `  softened, crushed, halved). A line written as "the juice / zest / peel / rind of N`,
  `  <thing>" names a COMPONENT of that thing, and the component IS the ingredient name:`,
  `  write it into item as "<thing> <component>", singular. Examples: "Juice of 2 limes" →`,
  `  item "lime juice", preparation []; "Zest of 1 lemon" → item "lemon zest",`,
  `  preparation []; "juice of half an orange" → item "orange juice", preparation [].`,
  `  Never leave "juice of" or "zest of" in preparation — it names the thing, it is not`,
  `  something done to it.`,
  `  A CLOVE of garlic NAMES the same way, in BOTH the wordings recipes use — with "of"`,
  `  and without. It parts company with juice/zest on ONE point, and that point is the`,
  `  one that gets lost: in "juice of 2 limes" the number counts the PARENT, but in`,
  `  "3 cloves of garlic" it counts the CLOVES, so it survives verbatim as statedCount`,
  `  rather than converting to a yield, and quantity/unit carry the cloves' metric estimate`,
  `  (1 clove ≈ 3g). Never drop the count — it is the number the shopper needs. One example`,
  `  per line, amounts shown because they are part of the answer:`,
  `    "1 clove garlic" → statedCount 1, quantity 3, unit "g", item "garlic clove", preparation []`,
  `    "2 cloves of garlic, crushed" → statedCount 2, quantity 6, unit "g", item "garlic clove", preparation ["crushed"]`,
  `    "3 large cloves of garlic, sliced" → statedCount 3, quantity 9, unit "g", item "garlic clove", preparation ["sliced"]`,
  `    "1 small clove of garlic, grated" → statedCount 1, quantity 3, unit "g", item "garlic clove", preparation ["grated"]`,
  `  Never leave "clove" in preparation and never reduce item to "garlic": a clove is part`,
  `  of the bulb you buy, so dropping the word loses the only thing that tells them apart.`,
  `  This rule is narrow: it fires only on that "<component> of N <thing>" wording (plus the`,
  `  garlic-clove wordings just named). A line`,
  `  whose ingredient IS the whole thing keeps the thing in item and the action in`,
  `  preparation — "2 limes, halved" → item "limes", preparation ["halved"]; "1 onion,`,
  `  finely chopped" → item "onion", preparation ["finely chopped"]; "100g butter,`,
  `  softened" → item "butter", preparation ["softened"].`,
  `- preparation: array of preparation phrases (e.g. ["sifted", "finely chopped"]). Empty array if none.`,
  `- notes: any parenthetical notes not covered by preparation. Null if none.`,
  `- isOptional: true if the line says "optional" or is clearly a garnish; false otherwise.`,
  `- displayText: a short human-friendly quantity form shown in parentheses after the metric value`,
  `  (the UI renders weight-first, e.g. "2g whole black peppercorns (1 tsp)" or "150g carrots (about`,
  `  2 medium)").`,
  `  ${READER_UNIT_PRINCIPLE}`,
  `  • For SPOON measures, keep the exact measure verbatim: "½ tsp", "2 tbsp", "1½ tsp" — but ONLY up`,
  `    to ${SPOON_MEASURE_CAP_TBSP} tbsp. Above that the spoon has stopped being the useful way to read the amount (nobody`,
  `    counts out 5 tbsp at the bench), so convert as always and leave displayText NULL:`,
  `    "6 tbsp olive oil" → null.`,
  `  • When the line ALREADY reads metric-first with a spoon measure of ${SPOON_MEASURE_CAP_TBSP} tbsp or less in`,
  `    brackets after it — "3 g salt (½ tsp)", "15 ml oil (1 tbsp)" — that BRACKET IS the displayText:`,
  `    lift it out verbatim ("½ tsp", "1 tbsp") and do NOT treat the line as already-metric below.`,
  `    Above ${SPOON_MEASURE_CAP_TBSP} tbsp the bracket earns no displayText either — apply the cap instead and leave it`,
  `    NULL, e.g. "90 ml oil (6 tbsp)" → null. This is the only way a chat-authored recipe keeps its`,
  `    spoon measure: the chef writes the bracket, the librarian carries it through into rawText,`,
  `    and this is where it lands.`,
  `  • NEVER put a cup, pint, quart, fluid-ounce, ounce or pound in displayText, even when the source`,
  `    line used one. Convert the amount as always and leave displayText NULL. displayText is read by`,
  `    the cook, and a UK kitchen has teaspoons, tablespoons and scales in grams — it has no cup and no`,
  `    ounce, so those measures are noise there rather than a useful cross-check.`,
  `  • For COUNT/PACK sources, phrase it as a friendly APPROXIMATE count, because the gram value is an`,
  `    estimate: prefix with "about" / "approx" for whole counts and produce ("about 2 medium",`,
  `    "approx 2 cloves", "about 4 rashers", "about 1 bunch"); for pack/tin counts, state the count`,
  `    plainly, including fractions ("1.5 tins", "1 can", "2 packets").`,
  `  • For EQUIPMENT-PREP lines (see the unit EXCEPTION — quantity and unit both null), displayText`,
  `    carries the author's stated amount as an APPROXIMATE form, so the cook keeps the hint:`,
  `    "1 tsp cooking oil (for greasing)" → "about 1 tsp"; "2 tbsp flour, for dusting" → "about`,
  `    2 tbsp". It stays null when the line states no amount at all ("flour, for dusting").`,
  `  • For CITRUS COMPONENT lines (see the NAMING rule above and the citrus yields below),`,
  `    displayText is the shopper's plain count of whole fruit — "2 limes", "1 lemon",`,
  `    "half an orange" — with NO "about" prefix: the count is exact even though the ml/g`,
  `    yield it converts to is an estimate.`,
  `  Set to null when the source is already in g, kg, ml, or l AND carries no bracketed spoon measure`,
  `  of its own, when the source measure is one of the banned ones above, when a spoon measure is`,
  `  larger than ${SPOON_MEASURE_CAP_TBSP} tbsp, or when the line states no amount.`,
  ``,
  `## Metric conversion`,
  `Liquids (water, milk, oil, vinegar, stock, juice, cream, etc.) → ml:`,
  `  1 cup = 240ml, 1 fl oz = 30ml, 1 tbsp = 15ml, 1 tsp = 5ml.`,
  `Dry/solid ingredients → always g, even when measured in tsp or tbsp:`,
  `  1 cup plain flour ≈ 120g, 1 cup butter ≈ 227g, 1 cup caster sugar ≈ 200g,`,
  `  1 cup icing sugar ≈ 120g, 1 tbsp butter ≈ 14g, 1 tbsp flour ≈ 8g,`,
  `  1 tbsp sugar ≈ 12g, 1 tbsp salt ≈ 18g, 1 tsp salt ≈ 6g, 1 tsp sugar ≈ 4g,`,
  `  1 tsp baking powder ≈ 4g, 1 tsp ground spice/herb ≈ 2g.`,
  `Imperial weight (oz, lb) → g: 1 oz ≈ 28g, 1 lb ≈ 454g.`,
  `Tins / cans / jars / packets → standard as-sold pack weight (use ml for liquids):`,
  `  1 tin/can chopped tomatoes ≈ 400g, 1 can beans ≈ 400g (use the drained weight ≈ 240g ONLY when`,
  `  the line says "drained"), 1 tin coconut milk ≈ 400ml, 1 tin tuna ≈ 145g, 1 jar pasta sauce ≈ 500g,`,
  `  1 packet/sachet dried yeast ≈ 7g, 1 stock cube ≈ 10g.`,
  `Count produce & individually-counted items → per-unit weight estimate (multiply by the count):`,
  `  1 medium onion ≈ 150g, 1 medium carrot ≈ 75g, 1 medium potato ≈ 170g,`,
  `  1 medium tomato ≈ 120g, 1 stick celery ≈ 40g, 1 rasher bacon ≈ 25g,`,
  `  1 medium apple ≈ 180g, 1 medium banana ≈ 120g, 1 lemon ≈ 100g, 1 lime ≈ 65g,`,
  `  1 bunch herbs ≈ 30g, 1 sprig herbs ≈ 3g, 1 spring onion ≈ 15g, 1 slice bread ≈ 35g,`,
  `  1 sheet filo pastry ≈ 20g, 1 fresh chilli ≈ 15g, 1 bay leaf ≈ 0.2g,`,
  `  1 whole egg ≈ 50g, 1 egg yolk ≈ 18g, 1 egg white ≈ 33g, 1 chicken breast ≈ 175g,`,
  `  1 chicken thigh ≈ 120g, 1 chicken wing ≈ 45g, 1 drumstick ≈ 75g, 1 whole fish (portion) ≈ 200g.`,
  `  If a count produce item is NOT in this list, ESTIMATE a sensible per-unit weight and use it.`,
  `  Never return a null quantity because no weight is listed — the list is a shortcut for the`,
  `  common cases, not the set of things you are allowed to answer for.`,
  `  For these, set quantity to the total estimated grams (count × per-unit), unit to "g" (or "ml" for`,
  `  liquids), and displayText to the original count form (e.g. "2 cloves", "1 tin", "2 medium").`,
  `  statedCount follows its own rule above — the count of whole items, never of pieces or packs:`,
  `  "3 eggs" → quantity 150, unit "g", statedCount 3; "3 egg whites" → quantity 99, unit "g",`,
  `  statedCount null; "2 sticks celery" → quantity 80, unit "g", statedCount null.`,
  `  A FRACTION TAKES THAT FRACTION OF THE WEIGHT — it never becomes the quantity itself:`,
  `  "½ small red onion" → 75g (half of 150g), unit "g", displayText "½ small onion". NOT quantity`,
  `  ½ with unit "g", which would put half a GRAM of onion on the list. The fraction itself is`,
  `  the COUNT, and it goes to statedCount exactly as written: statedCount ½.`,
  `Citrus components (the juice or zest of N whole fruit) → the COMPONENT's own yield, never`,
  `the whole fruit's weight:`,
  `  juice of 1 lime ≈ 30ml, juice of 1 lemon ≈ 45ml, juice of 1 orange ≈ 70ml;`,
  `  zest of 1 lime / lemon / orange ≈ 5g.`,
  `  For these, set quantity to count × yield, unit to "ml" for juice and "g" for zest, item`,
  `  to the component name ("lime juice", "lemon zest" — see the NAMING rule above), and`,
  `  displayText to the original count form ("2 limes", "1 lemon"). A fraction of a fruit`,
  `  takes the same fraction of the yield: "juice of half an orange" → 35ml. So "Juice of`,
  `  2 limes" → quantity 60, unit "ml", item "lime juice", displayText "2 limes".`,
  `  The whole-fruit weights above (1 lemon ≈ 100g, 1 lime ≈ 65g) continue to apply whenever`,
  `  the FRUIT ITSELF is the ingredient: "2 limes, halved" is 130g of limes, not a juice`,
  `  yield.`,
  `Garlic cloves (a counted component of the bulb) → 1 clove garlic ≈ 3g, the clove count in`,
  `  statedCount: "2 cloves garlic, crushed" → quantity 6, unit "g", statedCount 2, item`,
  `  "garlic clove", preparation ["crushed"]. A FRACTION OF A CLOVE KEEPS THE FRACTION as its`,
  `  statedCount: "½ clove garlic" → quantity 1.5, unit "g", statedCount {type:"mixed",whole:0,`,
  `  numerator:1,denominator:2}. A bulb holds roughly a dozen cloves, but that conversion is the`,
  `  product form's job, not this one's — do not divide here.`,
  `  A line naming the WHOLE bulb keeps the bulb: "1 bulb garlic, roasted" → item "garlic".`,
  `Already g/kg/ml/l → store as-is, no displayText. Round to the nearest whole number.`,
  ``,
  `## Rules`,
  `1. rawText must be the original line exactly — never rephrase or correct it.`,
  `2. item must not be empty; if stripping leaves nothing, use the full rawText as item.`,
  `3. Preserve original casing in all string fields.`,
  `4. Do not merge multiple ingredients on one line into a single item.`,
  `5. Before answering, check every item: if statedCount is not null, quantity and unit must not be`,
  `   null. Fill in the metric estimate if you left it out.`,
].join('\n');
