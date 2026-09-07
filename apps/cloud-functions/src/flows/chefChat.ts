import { z } from 'genkit';
import type { MessageData } from 'genkit';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  ChefChatInputSchema,
  ChefChatOutputSchema,
  ChefChatStreamSchema,
  DeclareOfferInputSchema,
  DeclareOfferOutputSchema,
} from '@salt/domain/schemas';
import { RecipeSchema } from '@salt/domain/schemas';
import { CanonItemSchema, CanonPurchaseCountsSchema } from '@salt/domain/schemas';
import {
  FindRecipesInputSchema,
  FindRecipesOutputSchema,
  RecipeSearchProjectionSchema,
  RECIPE_SEARCH_PROJECTION_FIELDS,
} from '@salt/domain/schemas';
import { ReadRecipeInputSchema, ReadRecipeOutputSchema } from '@salt/domain/schemas';
import type { ChefOffer } from '@salt/domain/schemas';
import type {
  FindRecipesInput,
  FindRecipesOutput,
  ReadRecipeInput,
  ReadRecipeOutput,
} from '@salt/domain/schemas';
import { recipePhaseTotals, searchRecipes } from '@salt/domain';
import type { RecipeSearchCandidate } from '@salt/domain';
import {
  AI_TEXT_FLOW_TIMEOUT,
  withAiStreamTimeout,
  withAiTimeout,
} from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { flowModel } from '../ai/fakeModel.js';
import { reportFlowError } from '../observability/reportServerError.js';
import { UK_INGREDIENT_PRINCIPLE } from './ingredientConversions.js';
// The unit policy the chef's prose and the saved recipe's `displayText` bracket
// now share (#934). The chef used to state its own, and it said the opposite —
// "½ tsp salt (3 g)" against the pipeline's "2g whole black peppercorns (1 tsp)".
// Never restate it here; interpolate it.
import { READER_UNIT_PRINCIPLE } from '@salt/domain/prompts';
import { readEquipmentContext, equipmentSectionForChef } from './equipmentContext.js';
import { readKitchenMemoryContext, kitchenMemorySectionForChef } from './kitchenMemoryContext.js';
import { readComponentContext, componentSectionForChef } from './componentContext.js';
import { formatRecipeForPrompt, withComponents } from './recipeText.js';

async function readRecipeContext(
  db: ReturnType<typeof getFirestore>,
  recipeId: string,
): Promise<string> {
  try {
    const snap = await db.collection('recipes').doc(recipeId).get();
    if (!snap.exists) return '';
    const result = RecipeSchema.safeParse(snap.data());
    if (!result.success) {
      logger.warn('chefChat: recipe failed validation', { recipeId });
      return '';
    }
    const r = result.data;

    // The SAME rendering the librarian reads (issue #890). This used to be a
    // thinner hand-rolled twin — title, description, ingredient lines and step
    // text — which was survivable while the chef only talked ABOUT a dish, and
    // stopped being survivable the moment Refresh asked it to write one out: a
    // chef shown no servings, no times, no step timers and no notes hands the
    // librarian a recipe with those things missing, and the household loses
    // them. See recipeText.ts.
    //
    // The dishes a meal is built from (issue #838) are appended to the recipe
    // body rather than pushed as their own top-level section, so they stay
    // adjacent to the recipe they belong to and nest correctly under whichever
    // heading the caller puts this text under — "Current recipe" or "Starting
    // point for a NEW dish". Both paths reach this reader, so a variation chat
    // sees the dinner too.
    //
    // The read cannot join the flow's Promise.all: the component ids are inside
    // the recipe document, so this is the one round-trip that is necessarily
    // serial. It is a single batched getAll and only happens for a meal — a
    // recipe with no components returns '' here and the prompt is unchanged.
    const componentSection = componentSectionForChef(await readComponentContext(db, r, 'chefChat'));
    return withComponents(formatRecipeForPrompt(r), componentSection);
  } catch (err) {
    logger.warn('chefChat: failed to read recipe', { recipeId, err });
    return '';
  }
}

// ─── The recipe library, as a tool (issue #840) ──────────────────────────────
//
// The chef's FIRST tool, and it overturns half of design principle #1
// (`docs/ai-kitchen-assistant.md`): "no structured output schema" survives, "no
// tools" does not. The reason is a SIZE test, not a change of taste. Equipment,
// household favourites and kitchen memory are small, fixed and always relevant,
// so they stay ambient — dropped into the prompt on every turn. The library is
// neither: 59 dishes after two months of real use, growing without bound, and an
// ambient index could only ever carry a summary line per dish.
//
// The split is: the small, fixed, always-relevant things stay ambient; the large,
// growing thing the chef needs SOME of gets a tool. That is the whole principle,
// and it is written down in the doc rather than only here.
//
// THE LATENCY BUDGET. The drain below is wrapped in `withAiStreamTimeout`, which
// races each chunk against a 55 s IDLE timer — a stream is bounded by silence,
// never by total duration. A tool round-trip is silence, so the handler must stay
// fast: one projected Firestore collection read and a pure ranking pass, both
// measured in milliseconds. Do not let slow work in here.

/**
 * How much of a description a search line carries.
 *
 * Enough to tell two chicken dishes apart, short enough that browsing the whole
 * library is not a wall of prose in the next model turn. Cut on a word boundary
 * where one is near enough, and marked with an ellipsis so the chef can see the
 * sentence was cut rather than mistaking it for the whole description.
 */
const SEARCH_DESCRIPTION_CHARS = 240;

function trimDescription(description: string | null): string | null {
  if (description === null || description.length <= SEARCH_DESCRIPTION_CHARS) return description;
  const cut = description.slice(0, SEARCH_DESCRIPTION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > SEARCH_DESCRIPTION_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The candidate row, plus the numbers the model is shown but nothing ranks on. */
type SearchRow = RecipeSearchCandidate & {
  readonly servings: number | null;
  readonly elapsedMinutes: number | null;
  readonly handsOnMinutes: number | null;
};

/**
 * Searches the recipe library for the chef.
 *
 * The I/O half of `findRecipes`, and deliberately nothing more: it projects,
 * validates, hands the rows to the pure `searchRecipes` in `@salt/domain` and
 * renders what comes back. No ranking logic lives here (CLAUDE.md rule 1).
 *
 * WHAT CROSSES THE WIRE. `select(...RECIPE_SEARCH_PROJECTION_FIELDS)` fetches
 * four fields — title, description, kind, metadata. `ingredients` and `steps` are
 * not among them, so a search never pays for a recipe's body; that field list is
 * read off `RecipeSearchProjectionSchema`'s own keys, so widening the projection
 * and widening the query are one edit. Pinned by `chefChat.findRecipes.test.ts`,
 * whose Firestore stub refuses an unprojected read.
 *
 * A doc that fails validation is SKIPPED, as in every other list read here — one
 * corrupt recipe costs the chef that recipe, not the search.
 *
 * ON FAILURE it returns no matches and a library size of zero, which the model
 * cannot tell from a genuinely empty library. That is the accepted trade rather
 * than an oversight: the chef then answers from its own knowledge, which is
 * exactly what it did before this tool existed, and failing the turn outright
 * would be strictly worse.
 */
export async function findRecipesInLibrary(
  db: ReturnType<typeof getFirestore>,
  input: FindRecipesInput,
): Promise<FindRecipesOutput> {
  try {
    const snap = await db
      .collection('recipes')
      .select(...RECIPE_SEARCH_PROJECTION_FIELDS)
      .get();

    const rows: SearchRow[] = [];
    let skipped = 0;
    for (const doc of snap.docs) {
      const parsed = RecipeSearchProjectionSchema.safeParse(doc.data());
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const { title, description, kind, metadata } = parsed.data;
      // Times come from the phase strip summed at the point of use (#1122) —
      // there is no stored total, and a recipe authored before phases existed
      // has none at all, which reads as null rather than as zero minutes.
      const totals = recipePhaseTotals(metadata.phases);
      rows.push({
        id: doc.id,
        title,
        description,
        kind,
        tags: metadata.tags,
        servings: metadata.servings,
        elapsedMinutes: totals.hasPhases ? totals.elapsedMinutes : null,
        handsOnMinutes: totals.hasPhases ? totals.handsOnMinutes : null,
      });
    }
    if (skipped > 0) {
      logger.warn('chefChat: findRecipes skipped recipes that failed validation', { skipped });
    }

    return {
      matches: searchRecipes(rows, input).map((row) => ({
        ...row,
        tags: [...row.tags],
        description: trimDescription(row.description),
      })),
      totalInLibrary: rows.length,
    };
  } catch (err) {
    logger.warn('chefChat: findRecipes failed', { err });
    return { matches: [], totalInLibrary: 0 };
  }
}

// The tool description is PROMPT TEXT, and the "when NOT to call" half is the
// load-bearing one. The recorded failure mode design principle #1 was protecting
// is real: a chef with a tool reaches for it, and every turn spent searching is a
// turn not spent being a chef. Two tools is the whole surface, and this is where
// the discipline is written.
const FIND_RECIPES_DESCRIPTION = `Search this household's OWN saved recipe library — the dishes they have chosen to keep.

CALL THIS when the answer depends on what they have saved:
- planning nights ("what shall we have this week?") — leave query out entirely and browse
- "we've got lamb in", "what can we do with the chicken?"
- "something quick and vegetarian"
- building a meal out of dishes they already have

DO NOT CALL IT for anything you can simply answer yourself. A technique question, a substitution, \
a conversion, "how do I know when it's done", "why did my sauce split", how long to rest a joint, \
or an idea for a dish they do not have — none of those live in the library, and searching for them \
spends the turn without helping. When in doubt, just answer.

Turn a vibe into keywords BEFORE calling: search for the words a recipe would actually contain, \
not the mood. "Something warming for a cold night" is a search for "stew braise soup roast".

What comes back is shallow — a title, its kind, tags, timings and the opening of its description. \
That is enough to name a dish, link it and suggest it. It does NOT include ingredients or a method: \
when you need those, read the dish with readRecipe.`;

/**
 * The `findRecipes` tool.
 *
 * Defined at module load, as Genkit requires, and passed to `generateStream` by
 * value rather than by name so the flow and the tool cannot get out of step.
 * Reads Firestore through the Admin SDK at call time — Cloud Functions must not
 * import `@salt/firebase-sync`, which is browser-only (Rule 2).
 */
export const findRecipesTool = ai.defineTool(
  {
    name: 'findRecipes',
    description: FIND_RECIPES_DESCRIPTION,
    inputSchema: FindRecipesInputSchema,
    outputSchema: FindRecipesOutputSchema,
  },
  (input) => findRecipesInLibrary(getFirestore(), input),
);

// How the chef is told to USE what comes back. The tool description governs when
// to call; this governs what to do with the answer, and it exists as its own
// section because two of its four rules are lessons already paid for elsewhere:
// the FAVOURITES_FRAMING "something different" rule below, restated for the
// library, and "never read it back as a list", which is the same instinct that
// makes an index feel like an index.
const LIBRARY_FRAMING = `## Their own recipe library
This household has its own saved recipes. findRecipes searches them and readRecipe opens one in \
full. They are the dishes this family chose to keep, so reaching for one is often a better answer \
than inventing something — it is already theirs, and they already know they like it.

Search to FIND a dish; read one when you are going to reason about what is actually in it. \
Building a dinner out of two saved dishes means reading both — you cannot say what clashes for \
the oven or what to prep the night before from a title.

ALWAYS LINK A SAVED DISH. Every library entry you name is written as a Markdown link built from \
the id the search returned: [Roast chicken traybake](#/recipes/abc123). Never name a saved dish \
without its link, and never write a link for a dish that did not come back from a search — you do \
not know its id, and a guessed one goes nowhere.

NEVER READ THE LIBRARY BACK AS A LIST. You are a chef who has read their cookbook, not an index of \
it. Say what you would cook and why, in your own words, and link the dishes as they come up.

Say plainly when nothing saved fits, then cook something new. Never present a dish you invented as \
one they already have.

When they ask for something DIFFERENT, their library is part of what they already own — the same \
rule the section on what they buy states. Use it to know what to steer AWAY from, not what to offer.`;

/**
 * Reads one saved dish in full for the chef.
 *
 * REUSES `readRecipeContext` and adds NO SECOND RENDERING. That is the whole
 * shape of this tool: `readRecipeContext` is already the rendering the chef reads
 * a dish through, it is already `formatRecipeForPrompt` (issue #890, so the chef
 * and the librarian see the same document), and it is already component-aware
 * (issue #838, so a meal read this way carries its dishes with it). A third
 * renderer here would have re-opened both holes at once — `authorRecipe.ts`
 * already admits one duplicate exists, and that is one too many.
 *
 * `readRecipeContext` returns '' for a dish that is missing, corrupt or
 * unreadable, and cannot return '' for one that is fine — `formatRecipeForPrompt`
 * always emits at least a `Title:` line. So the empty string is exactly "I could
 * not read that dish", which becomes `found: false` here rather than a throw: the
 * chef says so out loud and carries on, which is what a stale id from earlier in
 * the conversation deserves. Pinned by `chefChat.readRecipe.test.ts`.
 *
 * NOTE WHAT IT IS NOT. Three different causes reach the same '' — gone, corrupt,
 * and a Firestore read that threw — so `found: false` is not "this dish has been
 * deleted" and the tool description must not tell the model it is. One transient
 * read failure would otherwise have the chef announce that a recipe the household
 * is looking at on screen no longer exists.
 */
export async function readRecipeForChef(
  db: ReturnType<typeof getFirestore>,
  input: ReadRecipeInput,
): Promise<ReadRecipeOutput> {
  const recipe = await readRecipeContext(db, input.id);
  return recipe ? { found: true, recipe } : { found: false, recipe: null };
}

// The SECOND tool, and the last one. Its description has to answer a question
// findRecipes's does not: not just when to reach for the library, but when the
// shallow line is already enough — a chef that reads three dishes in full to
// suggest one of them has spent the turn on reading rather than on cooking.
const READ_RECIPE_DESCRIPTION = `Read ONE saved dish in full — every ingredient, every step, the timings, the notes, and the \
dishes it is built from if it is a meal. Takes the id findRecipes returned.

CALL THIS when you need what is actually IN the dish or how it is actually made:
- building a meal out of two saved dishes — what clashes for the oven, what to prep the night \
before, what to double
- "what can I get done ahead for this?", answered from that dish's real steps
- scaling, substituting or adapting a dish they already have
- anything where being wrong about an ingredient or a step would matter

DO NOT CALL IT when the line from findRecipes already answers the question. Naming a dish, \
suggesting it, saying roughly what it is, judging whether it fits the night — the title, tags, \
timings and description already carry all of that. Reading three dishes to propose one is a turn \
spent reading instead of cooking. Read the ones you are actually going to reason about, and no \
more.

If found comes back false you could not read that dish — it may have been deleted, or the \
read may simply have failed. Say plainly that you cannot open it and carry on; never state \
that it has been deleted, and never invent its contents.`;

export const readRecipeTool = ai.defineTool(
  {
    name: 'readRecipe',
    description: READ_RECIPE_DESCRIPTION,
    inputSchema: ReadRecipeInputSchema,
    outputSchema: ReadRecipeOutputSchema,
  },
  (input) => readRecipeForChef(getFirestore(), input),
);

// ─── The chef says what it offered (issue #1299) ─────────────────────────────
//
// The THIRD tool, and the only one that touches nothing: no Firestore read, no
// write, no second model call. Calling it IS the effect — the flow reads the
// request back off the drained response below and hands it to the client, where
// it decides whether the buttons under that reply exist.
//
// Its description has to carry an explicit WHEN NOT TO CALL clause, as the other
// two do. Without one it fires on every turn and gates nothing, which is exactly
// the noise this issue exists to remove: today the buttons appear after any
// reply, so "why is my crumb so tight?" offers to rewrite the recipe.
const DECLARE_OFFER_DESCRIPTION = `Declare what your reply has put on the table, so the app can offer the user the right thing to \
do with it. Call it ONCE, alongside the reply you are already writing. It writes nothing, changes \
nothing and is never shown to the user.

CALL IT with "dish-change" when you have suggested changing the dish this conversation is attached \
to — less sweet, a swapped ingredient, a different method, more of something. Anything the user \
could reasonably want folded into that recipe.

CALL IT with "new-dish" when you have described a dish worth keeping in its own right: a whole \
recipe you have given them, something to serve alongside, a drink to go with it. It has to be a \
real dish with real quantities or a real method — not a passing mention of what one might cook.

CALL IT with both when your reply genuinely does both — a change to this dish AND something to \
serve beside it.

DO NOT CALL IT when you have simply answered a question. Explaining why a crumb is tight, what \
baking soda does, whether a pan is hot enough, how long something keeps, what an ingredient is — \
none of those put a dish on the table, and declaring one would offer to rewrite a recipe nobody \
asked you to touch. If you are unsure, do not call it: a missing button costs the user one more \
message, a wrong one costs them their recipe.`;

export const declareOfferTool = ai.defineTool(
  {
    name: 'declareOffer',
    description: DECLARE_OFFER_DESCRIPTION,
    inputSchema: DeclareOfferInputSchema,
    outputSchema: DeclareOfferOutputSchema,
  },
  // A constant. Everything this tool does happens in `declaredOffers` below,
  // reading the REQUEST rather than anything the implementation produced — which
  // is what keeps it free of the module-scope trap: `findRecipesTool` and
  // `readRecipeTool` are module-scope singletons and so is this one, so a
  // module-level variable written here would be shared across concurrent
  // invocations on a warm instance and would leak one household's declaration
  // into another's turn.
  () => Promise.resolve({ recorded: true }),
);

// How the chef is told to use it. A tool description governs when to reach for a
// tool; this says the thing the description cannot — that declaring is part of
// finishing a turn, not an optional extra — and it sits with the base prompt
// because it is a capability statement, not context about tonight.
const DECLARE_OFFER_FRAMING = `## Saying what you have offered
When your reply suggests changing the dish this conversation is about, or describes a dish worth \
keeping, call declareOffer to say so. That is what puts the right button under your reply.

When you have only answered a question, do not call it. An answer is not an offer, and a button \
after one offers to rewrite a recipe the user never asked you to touch.`;

/**
 * What the chef declared, read back off the finished turn.
 *
 * Reads the REQUESTS, not the responses, and reads them from the whole message
 * history rather than from `response.toolRequests`: Genkit resolves a tool call
 * and loops, so by the time the turn finishes the LAST model message is the prose
 * and carries no tool request at all. The declaration is two messages back.
 *
 * `.safeParse` because a model-authored tool input is a trust boundary like any
 * other (CLAUDE.md → Zod conventions). A malformed or unknown kind is dropped
 * rather than failing the turn — the user still gets their reply, and the failure
 * mode is a missing button, which is the one this design accepts. Duplicates are
 * collapsed: a chef that declares "new-dish" twice offered one button.
 */
export function declaredOffers(messages: readonly MessageData[]): ChefOffer[] {
  const seen = new Set<ChefOffer>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.toolRequest?.name !== 'declareOffer') continue;
      const parsed = DeclareOfferInputSchema.safeParse(part.toolRequest.input);
      if (!parsed.success) {
        logger.warn('chefChat: declareOffer called with an input that did not parse');
        continue;
      }
      // No second validation of each kind: `DeclareOfferInputSchema` is an array
      // of the enum, so anything that got past the parse above is already one of
      // the two. A belt-and-braces check here would be a branch nothing can take.
      for (const offer of parsed.data.offers) seen.add(offer);
    }
  }
  return [...seen];
}

// ─── Household favourites (issue #726) ───────────────────────────────────────
//
// What the household actually buys, counted from shopping-list tick-offs. Read
// server-side from Firestore via the Admin SDK — Cloud Functions must not import
// `@salt/firebase-sync`, which is browser-only (Rule 2).
//
// PROVISIONAL PARAMETERS. The issue asks for these to be judged against a
// populated `canonData/purchaseCounts` document, which cannot exist until the
// capture side has been live for a few shops. `stocked` was chosen because it
// already separates the pantry from the shop on real canon — it covers salt,
// sugar, flour, the oils, eggs, milk, coffee and the ground spices. Two things
// to revisit once there is data: it also sweeps up household non-food (bleach,
// tissues, washing-up liquid), which is right for the chef but means `stocked`
// is doing double duty; and an `aisleId` exclusion may be the better tool for
// that half. Both constants are safe to retune — nothing depends on their value.
const FAVOURITES_TOP_N = 25;
// How many counted ids to resolve before staples are stripped. Bounded so a long
// history cannot turn one chat message into a full canon scan, and generously
// above TOP_N so stripping the staples still leaves a full list. Only ids the
// household has actually ticked are ever fetched, so early on this is a handful
// of reads, not a collection read.
const FAVOURITES_LOOKUP_LIMIT = 100;

/**
 * Reads the household's most-bought non-staple ingredients as a prompt section.
 *
 * Returns '' whenever there is nothing worth saying — no counts document, an
 * empty one, every counted item a staple, or any failure at all. Taste context
 * is an enhancement and never a hard dependency, so chat behaves exactly as it
 * did before this existed when the signal is absent.
 */
export async function readFavouritesContext(db: ReturnType<typeof getFirestore>): Promise<string> {
  try {
    const snap = await db.collection('canonData').doc('purchaseCounts').get();
    if (!snap.exists) return '';
    const parsed = CanonPurchaseCountsSchema.safeParse(snap.data());
    if (!parsed.success) {
      logger.warn('chefChat: purchaseCounts failed validation, proceeding without taste context');
      return '';
    }

    const ranked = Object.entries(parsed.data.counts)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, FAVOURITES_LOOKUP_LIMIT);
    if (ranked.length === 0) return '';

    // Counts outlive the canon items they key: an id whose item has since been
    // deleted simply resolves to a missing snapshot and drops out here.
    const snaps = await db.getAll(...ranked.map(([id]) => db.collection('canonItems').doc(id)));
    const byId = new Map<string, string>();
    for (const doc of snaps) {
      if (!doc.exists) continue;
      const item = CanonItemSchema.safeParse(doc.data());
      // A list read: skip the invalid doc rather than losing the whole signal.
      if (!item.success) continue;
      if (item.data.shoppingBehavior === 'stocked') continue;
      byId.set(doc.id, item.data.name);
    }

    const names = ranked
      .map(([id]) => byId.get(id))
      .filter((name): name is string => name !== undefined)
      .slice(0, FAVOURITES_TOP_N);
    if (names.length === 0) return '';

    return `${FAVOURITES_FRAMING}\n\n${names.map((n) => `- ${n}`).join('\n')}`;
  } catch (err) {
    logger.warn('chefChat: failed to read purchaseCounts', { err });
    return '';
  }
}

const FAVOURITES_FRAMING = `## What this household actually buys
Below are the ingredients this household buys most often, most-bought first, counted from what \
they tick off at the shop rather than what they put on the list. Pantry staples are deliberately \
excluded — everyone buys flour, milk and black pepper, and they say nothing about what anyone \
enjoys eating. What is left is the taste signal: the cuts of meat, the cheeses, the vegetables \
they actually reach for.

Use it to read what is being asked of you. It is not a shopping list, a restriction, or a set of \
ingredients you must use:

- When they ask for something DIFFERENT, new, or a change from the usual — steer AWAY from this \
list. It IS the usual. Reach for cuisines, proteins and vegetables that are not on it.
- When they ask for something FAMILIAR, easy, or made from what they normally get — lean IN and \
build around these, because they are already in the basket.
- When they ask for neither, which is most of the time, ignore it entirely. Never bend an \
unrelated answer towards or away from this list.

Never mention this list, quote it back, or tell the user what they buy. It is background \
knowledge, not a talking point.`;

// A variation chat is grounded on a recipe it is NOT amending (issue #763). The
// heading has to say so: under the "Current recipe" wording above, the chef
// answers as though the user were editing that dish and starts talking about
// what "we" will change, when the original is about to be left exactly as it is.
const VARIATION_FRAMING = `## Starting point for a NEW dish
The user is not editing the recipe below and it will not be changed. They are using it as the \
starting point for a NEW dish of their own, and want to talk through how to take it somewhere \
else — a different protein, a different cuisine, a different occasion.

Treat it as a well-understood baseline: you know its ingredients, its method and its timings, so \
when they ask for a change, work out everything that has to follow from it. A swapped ingredient \
usually drags more with it than the line it replaces — fat that something else was providing, \
seasoning that has to be rebalanced, a stage that now belongs at a different point in the method. \
Say so, specifically, rather than only answering the question as asked.

Talk about the new dish as a new dish. Never describe the change as an edit to the recipe below, \
and do not tell the user to update or re-save the original.`;

function buildSystemPrompt(
  equipmentContext: string,
  recipeContext: string,
  favouritesContext: string,
  variationContext: string,
  memoryContext: string,
  speaker: string | undefined,
): string {
  // FIRST after the base, and unconditional. It is a capability statement — how
  // this chef answers at all — not a piece of context about tonight, so it sits
  // with the base rather than among the situational sections that follow. There
  // is nothing to gate it on either: the library's size is only known once the
  // tool has been called, and a read to find out would cost every turn the very
  // thing the tool exists to avoid paying.
  const sections: string[] = [CHEF_SYSTEM_BASE, LIBRARY_FRAMING, DECLARE_OFFER_FRAMING];

  const equipmentSection = equipmentSectionForChef(equipmentContext);
  if (equipmentSection) sections.push(equipmentSection);

  if (favouritesContext) sections.push(favouritesContext);

  // AFTER the favourites and BEFORE the dish, deliberately. The two taste signals
  // belong together — one inferred from what gets ticked off at the shop, the other
  // the household's own words — and the explicit one goes second so it reads as the
  // correction to the inferred one rather than the other way round. Both sit ahead
  // of the recipe so the dish under discussion stays the last, most specific thing
  // the chef reads; a preference nearer the end of the prompt than the task is how
  // "never open with them" turns into opening with them.
  //
  // Absent entirely when there are no notes, so a household with none gets exactly
  // today's prompt, byte for byte.
  const memorySection = kitchenMemorySectionForChef(memoryContext, speaker);
  if (memorySection) sections.push(memorySection);

  if (recipeContext) {
    sections.push(
      `## Current recipe\nThe user is asking about this recipe. Use it as context for the conversation.\n\n${recipeContext}`,
    );
  }

  // Mutually exclusive with the section above in practice — a session is either
  // attached to a recipe or based on one, never both — but ordered after it so a
  // session that somehow carried both still reads as an amendment, matching the
  // librarian's precedence.
  if (variationContext) {
    sections.push(`${VARIATION_FRAMING}\n\n${variationContext}`);
  }

  return sections.join('\n\n');
}

export const chefChatFlow = ai.defineFlow(
  {
    name: 'chefChat',
    inputSchema: ChefChatInputSchema,
    // Split by #1299, and the split is the point: the STREAM is still a plain
    // string, so text fragments arrive as text and the streaming render is
    // untouched. Only the resolved value widened, to carry what the chef said
    // its reply offered.
    outputSchema: ChefChatOutputSchema,
    streamSchema: ChefChatStreamSchema,
  },
  async (input, streamingCallback) => {
    try {
      const db = getFirestore();
      const [equipmentContext, recipeContext, favouritesContext, variationContext, memoryContext] =
        await Promise.all([
          readEquipmentContext(db, 'chefChat'),
          input.recipeId ? readRecipeContext(db, input.recipeId) : Promise.resolve(''),
          // Joins the existing Promise.all rather than adding a serial round-trip.
          readFavouritesContext(db),
          // The base recipe of a variation chat (issue #763). Reuses the same
          // reader, which returns '' for a deleted or corrupt doc — so a variation
          // whose base disappears mid-conversation quietly becomes an ordinary
          // chat instead of failing the turn (Rule 10).
          input.basedOnRecipeId
            ? readRecipeContext(db, input.basedOnRecipeId)
            : Promise.resolve(''),
          // The household's notes (issue #816). Joins the existing Promise.all
          // rather than adding a serial round-trip — it is one small collection
          // read, and it costs the turn nothing it was not already waiting on.
          readKitchenMemoryContext(db, 'chefChat'),
        ]);

      const systemPrompt = buildSystemPrompt(
        equipmentContext,
        recipeContext,
        favouritesContext,
        variationContext,
        memoryContext,
        input.speaker,
      );

      // Convert Message[] history to Genkit MessageData format. Our domain role is
      // 'user' | 'assistant'; Genkit/Gemini uses 'user' | 'model', so the assistant
      // turns must be remapped (a bare cast leaves 'assistant' at runtime, which
      // Genkit rejects with "messages.N.role: must be equal to one of the allowed
      // values").
      const history = input.messages.map((m) => ({
        role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
        content: [{ text: m.text }],
      }));

      // Pro-tier model for conversational quality (design principle #3, issue #206).
      const chatModel = await flowModel('chefChat');
      const { stream, response } = ai.generateStream({
        model: chatModel,
        system: systemPrompt,
        messages: history,
        prompt: input.newMessage,
        // The chef's THREE tools, and the whole surface. Two read the library
        // (#840); the third (#1299) reads and writes nothing at all — it exists so
        // the chef can say what its reply offered, which is the issue #840's
        // "a third tool is a new issue with its own justification" asked for. The
        // alternative was a second AI call per turn to recover one bit the model
        // already knew. Genkit runs the tool loop inside
        // this call and keeps streaming across it, so the reply still arrives in
        // fragments; the gaps while tools run are silence, which is what the idle
        // timer below bounds. A turn may now search AND read, so that is two
        // round-trips inside one stream — each is a Firestore read measured in
        // milliseconds, nowhere near the 55 s idle budget. Passed BY VALUE rather
        // than by name so the flow and the tools cannot get out of step.
        //
        // Note what is still absent: no `output` option, and none is coming. The
        // non-negotiable half of design principle #1 survives intact — the chef
        // returns prose, structure stays the librarian's job at save time, and
        // `offered` below is recovered from a TOOL REQUEST, never from a schema
        // imposed on what the model writes.
        tools: [findRecipesTool, readRecipeTool, declareOfferTool],
      });

      // The DRAIN is what needs the deadline, not what follows it (issue #915).
      // This loop used to be bare, with withAiTimeout applied afterwards to the
      // aggregated `response` — which a model that goes quiet mid-stream never
      // reaches, so the turn hung until the 120s function quota killed it.
      // withAiStreamTimeout races each chunk against an idle timer instead: a
      // silence longer than the budget throws AiTimeoutError into the catch
      // below, and a long answer that keeps arriving is never cut short.
      for await (const chunk of withAiStreamTimeout('chefChat', stream)) {
        const text = chunk.text;
        if (text) streamingCallback(text);
      }

      // The stream has fully drained above, so this resolves immediately in the
      // normal case; the timeout stays as a backstop. AI model/token/cost
      // telemetry rides the Genkit model span the AI-OTLP processor ships to
      // PostHog (#356) — and span-derived usage fixes the old streamed-response
      // empty-tokens gap.
      const finalResponse = await withAiTimeout('chefChat', () => response, AI_TEXT_FLOW_TIMEOUT);

      return { text: finalResponse.text, offered: declaredOffers(finalResponse.messages) };
    } catch (err) {
      // onCallGenkit owns this callable's error path; report the AI/Genkit
      // failure (incl. AiTimeoutError, or a mid-stream model error) here, flush,
      // then re-throw unchanged. Best-effort; never throws.
      await reportFlowError(err);
      throw err;
    }
  },
);

const CHEF_SYSTEM_BASE = `You are a skilled, knowledgeable kitchen assistant and conversational chef. \
Your goal is to have genuinely helpful, creative, and practical cooking conversations. \
You can discuss recipes, techniques, flavour pairings, substitutions, dietary adaptations, \
and anything else related to cooking and food. \
Speak naturally and warmly — like a knowledgeable friend in the kitchen, not a recipe generator. \
When you suggest a recipe or technique, feel free to riff, improvise, and add your own perspective. \
You are not bound to any particular list of ingredients. \
${UK_INGREDIENT_PRINCIPLE} \
${READER_UNIT_PRINCIPLE} \
Temperatures in °C only — never Fahrenheit.`;
