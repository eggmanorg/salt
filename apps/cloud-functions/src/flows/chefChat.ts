import { randomUUID } from 'node:crypto';
import { z, type ActionContext } from 'genkit';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { ChefChatInputSchema, ChefChatOutputSchema } from '@salt/domain/schemas';
import { ChatSessionSchema } from '@salt/domain/schemas';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import { RecipeSchema } from '@salt/domain/schemas';
import { CanonItemSchema, CanonPurchaseCountsSchema } from '@salt/domain/schemas';
import {
  FindRecipesInputSchema,
  FindRecipesOutputSchema,
  RecipeSearchProjectionSchema,
  RECIPE_SEARCH_PROJECTION_FIELDS,
} from '@salt/domain/schemas';
import { ReadRecipeInputSchema, ReadRecipeOutputSchema } from '@salt/domain/schemas';
import {
  ReadEquipmentDetailInputSchema,
  ReadEquipmentDetailOutputSchema,
  FindKitchenNotesInputSchema,
  FindKitchenNotesOutputSchema,
  ReadKitchenNoteInputSchema,
  ReadKitchenNoteOutputSchema,
  WriteKitchenNoteInputSchema,
  WriteKitchenNoteOutputSchema,
  LibraryPageSchema,
  LIBRARY_PAGE_COLLECTION,
  LIBRARY_PAGE_BODY_MAX,
  LIBRARY_PAGE_TITLE_MAX,
  pushRevision,
} from '@salt/domain/schemas';
import type {
  FindRecipesInput,
  FindRecipesOutput,
  ReadRecipeInput,
  ReadRecipeOutput,
  ReadEquipmentDetailInput,
  ReadEquipmentDetailOutput,
  FindKitchenNotesInput,
  FindKitchenNotesOutput,
  ReadKitchenNoteInput,
  ReadKitchenNoteOutput,
  WriteKitchenNoteInput,
  WriteKitchenNoteOutput,
  LibraryPageDoc,
} from '@salt/domain/schemas';
import { SaveRecipeInputSchema, SaveRecipeOutputSchema } from '@salt/domain/schemas';
import type { SaveRecipeOutput } from '@salt/domain/schemas';
import {
  chatExpiresAt,
  libraryPageSummary,
  recipePhaseTotals,
  resolveEquipmentItem,
  searchLibraryPages,
  searchRecipes,
} from '@salt/domain';
import type { LibraryPageCandidate, RecipeSearchCandidate } from '@salt/domain';
// The SERVER subpath, never the default one: the default wraps posthog-js and
// cannot run in Node (CLAUDE.md Rule 5).
import {
  CHAT_SAVE_FLAG_KEY,
  LIBRARY_FLAG_KEY,
  isServerFeatureEnabled,
} from '@salt/observability/server';
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
import {
  readEquipmentContext,
  readEquipmentItems,
  renderEquipmentDetail,
  equipmentSectionForChef,
} from './equipmentContext.js';
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

// ─── The household's own recipes, as a tool (issue #840) ─────────────────────
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
 * Searches the household's saved recipes for the chef.
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
const FIND_RECIPES_DESCRIPTION = `Search this household's OWN saved recipes — the dishes they have chosen to keep.

CALL THIS when the answer depends on what they have saved:
- planning nights ("what shall we have this week?") — leave query out entirely and browse
- "we've got lamb in", "what can we do with the chicken?"
- "something quick and vegetarian"
- building a meal out of dishes they already have

DO NOT CALL IT for anything you can simply answer yourself. A technique question, a substitution, \
a conversion, "how do I know when it's done", "why did my sauce split", how long to rest a joint, \
or an idea for a dish they do not have — none of those are among their recipes, and searching for \
them spends the turn without helping. When in doubt, just answer.

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
// the FAVOURITES_FRAMING "something different" rule below, restated for their
// recipes, and "never read it back as a list", which is the same instinct that
// makes an index feel like an index.
//
// THE WORD "LIBRARY" IS NOT SPENT HERE, and that is issue #1476 reversing issue
// #1377's call — see the section comment on the Library tools below for why.
// This section is about the RECIPES collection, which the app calls Recipes; the
// constant keeps its `LIBRARY_` name only because that is the name every comment
// in this file already refers to it by.
//
// UNLIKE THE LIBRARY TOOLS BELOW, NOTHING PINS THIS (CLAUDE.md Rule 12):
// `chefChat.findRecipes.test.ts` asserts `DO NOT CALL IT` and the technique/
// substitution guidance, never vocabulary, so a reinstated "recipe library" in
// `FIND_RECIPES_DESCRIPTION` above or in this framing would ship green. Stated
// here rather than fixed, per `docs/library.md`'s Rule 12 ledger.
const LIBRARY_FRAMING = `## Their own recipes
This household has its own saved recipes. findRecipes searches them and readRecipe opens one in \
full. They are the dishes this family chose to keep, so reaching for one is often a better answer \
than inventing something — it is already theirs, and they already know they like it.

Search to FIND a dish; read one when you are going to reason about what is actually in it. \
Building a dinner out of two saved dishes means reading both — you cannot say what clashes for \
the oven or what to prep the night before from a title.

ALWAYS LINK A SAVED DISH. Every saved recipe you name is written as a Markdown link built from \
the id the search returned: [Roast chicken traybake](#/recipes/abc123). Never name a saved dish \
without its link, and never write a link for a dish that did not come back from a search — you do \
not know its id, and a guessed one goes nowhere.

NEVER READ THEIR RECIPES BACK AS A LIST. You are a chef who has read their cookbook, not an index \
of it. Say what you would cook and why, in your own words, and link the dishes as they come up.

Say plainly when nothing saved fits, then cook something new. Never present a dish you invented as \
one they already have.

When they ask for something DIFFERENT, their saved recipes are part of what they already own — the \
same rule the section on what they buy states. Use it to know what to steer AWAY from, not what to \
offer.`;

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
// findRecipes's does not: not just when to reach for their recipes, but when the
// shallow line is already enough — a chef that reads three dishes in full to
// suggest one of them has spent the turn on reading rather than on cooking.
const READ_RECIPE_DESCRIPTION = `Read ONE saved dish in full — every ingredient, every step, the timings, the recipe's own notes, \
and the dishes it is built from if it is a meal. Takes the id findRecipes returned.

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

// ─── The chef's kit, on demand (issue #1373) ─────────────────────────────────
//
// The THIRD tool. `chefChat.ts` used to say "the chef's TWO tools, and the whole
// surface (issue #840) — a third is a new issue with its own justification";
// issue #1373 is that justification, and the comment below now says three.
//
// WHY IT EXISTS. One equipment record can stand for a whole set of similar
// things — twelve frying pans, eleven Weck jar models — each with its own note
// about what it is good for. Rendering all of that into five AI prompts on every
// call is what this replaces: the ambient list is names and rules, and the detail
// is fetched at the moment a question turns on it.
//
// READ-ONLY, PERMANENTLY. Asked whether the chat should be able to edit
// equipment, Daniel's answer was "No, and not ever" — so there is no write
// sibling to this tool and none is to be added. The reason is not caution about
// AI generally: an equipment list that is quietly WRONG is worse than one that is
// out of date, and there is no review surface anywhere in Salt where a bad write
// here would be noticed. A confirmation step does not fix that — the confirmation
// is the ceremony Salt avoids, and the failure mode is silent either way. Pinned
// by a test asserting the chef's tools array holds no equipment writer.

// What to do with the third tool, as its own section beside LIBRARY_FRAMING —
// tool-use guidance, not equipment policy. It is deliberately NOT in
// EQUIPMENT_CHEF_FRAMING: that string lives in `equipmentContext.ts` beside three
// framings for flows that have no tools at all, and its header is explicit that
// the four must not drift into each other.
//
// GATED ON THE KIT LIST, unlike LIBRARY_FRAMING. How many recipes are saved is
// unknown until the tool has been called, so its framing is unconditional; the
// kit list is right there in the prompt, and with no manifest this tool can only
// ever miss. A household with no equipment gets exactly the prompt it got before.
const KITCHEN_DETAIL_FRAMING = `## Looking their kit up
The list above is names and household rules. There is more behind it that you are NOT being shown \
every turn: what each accessory or family member is actually like, and what the household has \
written about the item itself — "the 28cm cast iron is the only one that goes in the oven", "the \
Magimix is on a high shelf and takes ages to wash, only for genuinely large volumes".

readEquipmentDetail fetches all of that for one item, by name. Call it when the answer turns on \
the detail — choosing between two machines that would both work, picking which pan or which jar, \
committing to a piece of kit where being wrong about it would matter. Do not call it to confirm \
something the list already says.

NEVER GUESS WHAT IS BEHIND A NAME. If it would change your answer, look it up; if you have not \
looked it up, do not state it.

You cannot change their kitchen. Reading is the whole of what you can do here — if they ask you to \
add, rename or remove a piece of equipment, say plainly that they edit it in the app themselves, \
and do not pretend to have done it.`;

/**
 * Reads ONE equipment record in full for the chef.
 *
 * A MISS, NEVER A GUESS. Name resolution is `resolveEquipmentItem`'s, the same
 * one the "You'll need" strip uses — so a name matching nothing, or matching two
 * records equally, returns `found: false` rather than borrowing one of them. The
 * tool never invents a record, and the chef is told to say so rather than
 * inventing its contents.
 */
export async function readEquipmentDetailForChef(
  db: ReturnType<typeof getFirestore>,
  input: ReadEquipmentDetailInput,
): Promise<ReadEquipmentDetailOutput> {
  const items = await readEquipmentItems(db, 'chefChat.readEquipmentDetail');
  const item = resolveEquipmentItem(input.name, items);
  return item
    ? { found: true, detail: renderEquipmentDetail(item) }
    : { found: false, detail: null };
}

const READ_EQUIPMENT_DETAIL_DESCRIPTION = `Look up ONE piece of kit, or one family of kit, in full — what it contains or what accessories it \
has, what the household has written about each of those, their notes on the item itself, its \
household rules, and the temperature it holds if it holds one. Takes the name as it appears in the \
kitchen list in your instructions.

CALL THIS when the answer genuinely turns on the detail:
- choosing between two things that would both do the job — "the Magimix or the Kenwood?" — where \
what the household has written about each is the deciding fact
- picking one member of a family: which pan, which jar, which dish, when size or material or what \
it can take matters
- before committing to a piece of kit for anything where being wrong about it would matter

DO NOT CALL IT when the names in the list already answer the question. That they own a mandoline, \
that a frying pan exists, that the oven is an oven — the list carries all of that. Looking up \
three items to name one is a turn spent reading instead of cooking.

Anything the detail marks NOT OWNED is something they do not have: never propose it, and say \
plainly what is missing if the best method needs it.

If found comes back false, no single item answers to that name — you may have used a name that is \
not in the list, or one that fits two items equally. Say so and ask which they mean; never invent \
what an item contains.

You cannot change anything here. This reads their kitchen and nothing more — if they ask you to \
add, rename or remove equipment, tell them it is theirs to edit in the app.`;

export const readEquipmentDetailTool = ai.defineTool(
  {
    name: 'readEquipmentDetail',
    description: READ_EQUIPMENT_DETAIL_DESCRIPTION,
    inputSchema: ReadEquipmentDetailInputSchema,
    outputSchema: ReadEquipmentDetailOutputSchema,
  },
  (input) => readEquipmentDetailForChef(getFirestore(), input),
);

// ─── The household's own Library (epic #1372, issue #1377) ───────────────────
//
// The THIRD and FOURTH tools, and the point at which the standing two-tool limit
// recorded above was deliberately lifted — Daniel's call on 2026-09-14, made with
// the cost in front of him: the Library is where his proven answers live and the
// chat is where he asks the questions, so a chef that cannot reach it answers from
// generic advice while the right answer sits two taps away. The mitigation is the
// SHAPE, and it is the one findRecipes/readRecipe already use — a cheap search
// returning a summary per match, and a full read only when the detail matters.
//
// WHAT THESE PAGES ARE CALLED, everywhere the model can see: the Library, and a
// page in it. The recipes collection is "their recipes" and never "their library".
//
// THIS REVERSES #1377's CALL, which is why it is spelled out (issue #1476). #1377
// saw the collision — one system prompt cannot use "the library" for two things —
// and resolved it by renaming THESE pages to "kitchen notes", leaving
// `LIBRARY_FRAMING` holding "their recipe library". The collision was real; the
// premise was not. The app had already assigned the word: `nav.ts` labels
// `#/library` "Library" and it opens these pages, while `#/recipes` is Recipes.
// So the chef was taught two names no user can see, and told Daniel his recipe
// was not in his "Recipe Library" in the same breath as writing it to the
// Library — he read it as a refusal and saved the dish a second time by hand.
// The fix is to name what the navigation names. DO NOT RESTORE "kitchen notes"
// or "recipe library" here: `chefChat.kitchenNotes.test.ts` asserts the assembled
// system prompt contains neither, in both gate states, so a revival in this
// section goes red. That coverage stops at this section's boundary — it says
// nothing about `FIND_RECIPES_DESCRIPTION` below, which carries no equivalent
// assertion (see the note there), nor about the four schema `.describe()` files
// under `packages/domain/src/schemas`, which carry none at all.
//
// Only the words the model reads changed. The collection, the schema, the feature
// key, the app's routes and the tool identifiers (`findKitchenNotes`,
// `readKitchenNote`, `writeKitchenNote`) keep the names they have — they never
// reach the user, and renaming them is churn for no user-visible gain.
//
// GATED SERVER-SIDE, per caller — see `kitchenNotesEnabled`. The moment the chef
// can read a page, content written under the `library` flag reaches a household
// member the feature is hidden from, through an answer no browser gate can reach.
// That is issue #831 exactly.

/**
 * Searches the household's notes for the chef.
 *
 * The I/O half of `findKitchenNotes`, and deliberately nothing more: read,
 * validate, hand the rows to the pure `searchLibraryPages` and render each match
 * through the pure `libraryPageSummary`. No ranking and no string shaping here.
 *
 * READS WHOLE DOCUMENTS, unlike `findRecipesInLibrary`'s projection, and that is
 * not an oversight: the summary is derived FROM THE BODY, so there is no cheaper
 * read that could produce one. What keeps it small is the collection itself — a
 * library is tens of pages — and `LIBRARY_PAGE_SEARCH_CEILING` on what comes back.
 *
 * A corrupt document is SKIPPED rather than thrown on (Rule 10, and the Zod
 * failure table in docs/data-model.md): one unparseable page must not cost the
 * household every other one, and a tool never throws out of the model's loop.
 *
 * ON FAILURE this still returns Rule-10-shaped `{ matches: [], totalNotes: 0 }`
 * — indistinguishable on those two fields alone from a genuinely empty library —
 * but `ok: false` rides alongside it precisely so the two are NOT indistinguishable
 * to the model. `KITCHEN_NOTES_FRAMING` tells the chef to say plainly when a
 * household has written nothing; without `ok` a transient Firestore error would
 * make that the same confident, wrong sentence.
 */
export async function findKitchenNotesForChef(
  db: ReturnType<typeof getFirestore>,
  input: FindKitchenNotesInput,
): Promise<FindKitchenNotesOutput> {
  try {
    const snapshot = await db.collection(LIBRARY_PAGE_COLLECTION).get();
    const pages: LibraryPageCandidate[] = [];
    let skipped = 0;
    for (const doc of snapshot.docs) {
      // The id is the DOCUMENT's, never the field inside it: a page carrying a
      // stale `id` would otherwise hand the chef an id that opens nothing.
      const parsed = LibraryPageSchema.safeParse({ ...doc.data(), id: doc.id });
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const page = parsed.data;
      pages.push({
        id: page.id,
        title: page.title,
        tags: page.tags,
        body: page.body,
        updatedAt: page.updatedAt,
      });
    }
    if (skipped > 0) {
      logger.warn('chefChat: findKitchenNotes skipped notes that failed validation', { skipped });
    }

    return {
      ok: true,
      matches: searchLibraryPages(pages, input).map((page) => ({
        id: page.id,
        title: page.title,
        tags: [...page.tags],
        summary: libraryPageSummary(page),
      })),
      totalNotes: pages.length,
    };
  } catch (err) {
    logger.warn('chefChat: findKitchenNotes failed', { err });
    // `ok: false` is load-bearing: without it this is byte-for-byte the answer a
    // household with zero notes gets, and KITCHEN_NOTES_FRAMING tells the chef to
    // say plainly they have written nothing — which would be a confident, wrong
    // thing to tell a household with forty notes over a transient read failure.
    return { ok: false, matches: [], totalNotes: 0 };
  }
}

const FIND_KITCHEN_NOTES_DESCRIPTION = `Search this household's Library — the pages they have written down for themselves, the kitchen facts \
that are NOT recipes. Their own proven numbers: sous vide times and temperatures they have tested, the jars and \
tins in the cupboard and what each one holds, settings that work in THIS kitchen, a table lifted off a website \
and kept.

CALL THIS when their own answer would beat a general one, or when they ask for theirs:
- a time, a temperature or a setting they are likely to have proven for themselves
- "how long do I…", "what do we normally do for…", "what did we write down about…"
- kit they own and the numbers that go with it — capacities, sizes, what fits what
- anything they say is written down somewhere

DO NOT CALL IT for ordinary cooking knowledge you already have. A technique, a substitution, a conversion, why a \
sauce split, how long to rest a joint — none of that is in their Library, and looking spends the turn without \
helping. Do not search to check an answer you are already sure of, and when in doubt, just answer.

What comes back is SHALLOW — a title, its tags and the opening of the page. That is very often the whole answer: \
if the summary already gives the number they asked for, use it and say which page it came from. Open a page with \
readKitchenNote only when the detail you need is further in.

If ok comes back false, the search itself could not run — a lookup problem, not an empty Library. Say plainly \
that you could not check their Library just now; never say they have written nothing about it, and never answer \
as though totalNotes were the true count.`;

export const findKitchenNotesTool = ai.defineTool(
  {
    name: 'findKitchenNotes',
    description: FIND_KITCHEN_NOTES_DESCRIPTION,
    inputSchema: FindKitchenNotesInputSchema,
    outputSchema: FindKitchenNotesOutputSchema,
  },
  (input) => findKitchenNotesForChef(getFirestore(), input),
);

/**
 * Reads one note in full for the chef.
 *
 * `found: false` covers THREE causes — the note is gone, the document is corrupt,
 * and a Firestore read that threw — so it is not "this note has been deleted", and
 * the tool description must not tell the model it is. The same distinction
 * `readRecipeForChef` carries, for the same reason: one transient read failure
 * would otherwise have the chef announce that a note the household is looking at
 * on screen no longer exists.
 */
export async function readKitchenNoteForChef(
  db: ReturnType<typeof getFirestore>,
  input: ReadKitchenNoteInput,
): Promise<ReadKitchenNoteOutput> {
  const unreadable = { found: false, title: null, body: null } as const;
  try {
    const snap = await db.collection(LIBRARY_PAGE_COLLECTION).doc(input.id).get();
    if (!snap.exists) return unreadable;
    const parsed = LibraryPageSchema.safeParse({ ...snap.data(), id: snap.id });
    if (!parsed.success) {
      logger.warn('chefChat: readKitchenNote note failed validation', { id: input.id });
      return unreadable;
    }
    return { found: true, title: parsed.data.title, body: parsed.data.body };
  } catch (err) {
    logger.warn('chefChat: readKitchenNote failed', { id: input.id, err });
    return unreadable;
  }
}

const READ_KITCHEN_NOTE_DESCRIPTION = `Read ONE Library page in full, exactly as the household wrote it. Takes the id findKitchenNotes \
returned.

CALL THIS when the summary is not enough and being wrong would matter:
- a table you need one specific row out of
- a method you are going to follow or adapt step by step
- anything where the number matters and the summary only hints at it

DO NOT CALL IT when the line from findKitchenNotes already answers the question, and never open several pages to \
write one paragraph. Reading three pages to quote one line is a turn spent reading instead of cooking.

If found comes back false you could not open that page — it may have been deleted, or the read may simply have \
failed. Say plainly that you cannot open it and carry on; never state that it has been deleted, and never invent \
its contents.`;

export const readKitchenNoteTool = ai.defineTool(
  {
    name: 'readKitchenNote',
    description: READ_KITCHEN_NOTE_DESCRIPTION,
    inputSchema: ReadKitchenNoteInputSchema,
    outputSchema: ReadKitchenNoteOutputSchema,
  },
  (input) => readKitchenNoteForChef(getFirestore(), input),
);

/**
 * The display name a page the chef wrote is attributed to.
 *
 * A NAME, never a uid — `createdBy`/`lastEditedBy` are denormalised display names
 * for audit only (`libraryPage.ts`), and no uid appears anywhere in the
 * family-shared data model. The chef's own name rather than the person who asked
 * for it, and that is the useful answer: the revision history then shows at a
 * glance which version was written by the chat and which by hand, which is what
 * makes a bad write easy to spot and undo.
 */
const CHEF_AUTHOR_NAME = 'The chef';

const refused = (problem: string): WriteKitchenNoteOutput => ({
  saved: false,
  id: null,
  created: false,
  problem,
});

/**
 * Writes one note for the chef — a new one, or a replacement for an existing one.
 *
 * WHY WRITING IS PERMITTED HERE WHEN #1373 REFUSED IT FOR EQUIPMENT. That issue
 * settled "the chat may read kit detail and may never write it", and its reason
 * was specific: an equipment list that is quietly wrong is worse than one that is
 * out of date, and there is no review surface where a bad write would be noticed.
 * Neither half holds for a note. A note is a document somebody opens and reads,
 * and #1375 gave it a visible revision history with restore — so a wrong write is
 * both noticeable and reversible, which is exactly the property equipment lacks.
 * Do not read #1373's rule as universal; read its reason.
 *
 * WHAT IS MECHANICAL HERE, AND WHAT IS NOT (CLAUDE.md Rule 12). "The chef writes
 * only when it is told to" is enforced by the tool description's DO NOT CALL IT
 * half, and prompt text is not a mechanism — that limit is stated, not dressed
 * up. What IS mechanical, and pinned by `chefChat.writeKitchenNote.test.ts`:
 *
 *   - this tool CANNOT DELETE. There is no delete path in it, and no other tool
 *     has one either; the suite scans this whole module for one;
 *   - this tool CANNOT EMPTY A NOTE either — a blank or whitespace-only body is
 *     refused before any write, the same shape as the blank-title guard;
 *   - a replacement that displaces a version THE CHEF DID NOT WRITE goes through
 *     `pushRevision`, so that version is recoverable — and the cap still holds,
 *     because `pushRevision` is the only thing that ever grows the array. That is
 *     the claim's real boundary and not a hedge: the one replacement that pushes
 *     nothing is the chef's own last write, which is the next bullet;
 *   - CONSECUTIVE CHEF WRITES COALESCE: a replacement only pushes a new revision
 *     when the version it replaces was NOT itself written by the chef, so a
 *     chatty run of chef writes cannot evict the human-authored version beneath
 *     them the way one revision per tool call otherwise would;
 *   - it writes to `libraryPages` and to no other collection.
 *
 * It also never THROWS (Rule 10): a refusal comes back as `saved: false` with a
 * sentence the chef can say out loud, which is what a model can actually act on
 * inside its own tool loop.
 */
export async function writeKitchenNoteForChef(
  db: ReturnType<typeof getFirestore>,
  input: WriteKitchenNoteInput,
): Promise<WriteKitchenNoteOutput> {
  const title = input.title.trim();
  if (title === '') return refused('a note needs a title, and that one was blank');
  if (title.length > LIBRARY_PAGE_TITLE_MAX) {
    return refused(
      `that title is too long — a note's title holds ${LIBRARY_PAGE_TITLE_MAX} characters`,
    );
  }
  // A blank or whitespace-only body would `set` a page with nothing left in it —
  // a REPLACEMENT write, structurally nothing like a removal, so it is invisible
  // to the no-removal-path scan at the bottom of this module's test file. It is
  // exactly the move the tool's own description tells the model it does not have:
  // "You cannot delete a note and you cannot empty one." Refused here, the same
  // shape as the blank-title guard three lines up, rather than left to the schema
  // (Rule 10 — a refusal the chef can read out, not a validation error inside its
  // own tool loop).
  if (input.body.trim() === '') {
    return refused('a note needs some body text, and that one was blank');
  }
  // The number comes from the schema's own constant, so there is one source for
  // it. This is NOT a second copy of the browser's append arithmetic
  // (`appendedBody` in `libraryImport.ts`, which measures what APPENDING would
  // produce and belongs to the import sheet and `appendToLibraryPage`): a tool
  // write replaces the whole body, so there is nothing to append to and nothing
  // to compute. `apps/cloud-functions` could not import that function in any case
  // — nothing imports an app (Rule 6).
  if (input.body.length > LIBRARY_PAGE_BODY_MAX) {
    return refused(
      `that note is too long — a note holds ${LIBRARY_PAGE_BODY_MAX} characters, and that was ${input.body.length}`,
    );
  }

  try {
    const now = new Date().toISOString();
    const pages = db.collection(LIBRARY_PAGE_COLLECTION);

    if (input.id === undefined) {
      const page: LibraryPageDoc = {
        id: randomUUID(),
        schemaVersion: 1,
        kind: 'note',
        title,
        body: input.body,
        // Untagged. Filing is the household's call and a tag the chef invented
        // would sit in the library's filter list for ever.
        tags: [],
        createdAt: now,
        updatedAt: now,
        createdBy: CHEF_AUTHOR_NAME,
        lastEditedBy: CHEF_AUTHOR_NAME,
        revisions: [],
      };
      await pages.doc(page.id).set(page);
      return { saved: true, id: page.id, created: true, problem: null };
    }

    // A replacement is only ever built on a note that was READ back first. An id
    // the model invented, or a document that no longer parses, leaves the
    // collection untouched — writing over something we could not read is how a
    // page gets silently destroyed, and the revision history cannot restore what
    // was never captured.
    const ref = pages.doc(input.id);
    const snap = await ref.get();
    if (!snap.exists) {
      return refused(
        'there is no note with that id — search for it, or leave the id out to start a new one',
      );
    }
    const parsed = LibraryPageSchema.safeParse({ ...snap.data(), id: snap.id });
    if (!parsed.success) {
      logger.warn('chefChat: writeKitchenNote left an unreadable note alone', { id: input.id });
      return refused('that note could not be read, so it was left exactly as it was');
    }

    const current = parsed.data;
    // COALESCE CONSECUTIVE CHEF WRITES. The browser captures one revision per
    // EDITING SESSION (`beginLibraryEdit`'s in-memory snapshot), never one per
    // keystroke; the chef has no such session, and a write per TOOL CALL is the
    // literal equivalent of pushing a revision per keystroke — "write it up",
    // "put it in a table", "add the tulips", "sort them by capacity" is four
    // writes for one piece of work, and a chatty back-and-forth easily reaches
    // `LIBRARY_PAGE_REVISION_CAP` calls, evicting the one human-authored version
    // the whole history exists to protect (the property #1377 relies on to permit
    // writing here when #1373 refused it for equipment).
    //
    // The fix reuses `lastEditedBy` as the session boundary rather than inventing
    // one: if the version being replaced was ITSELF the chef's own last write,
    // this call is a continuation of the same run, not a new edit displacing a
    // human's, so no revision is pushed and the array is carried over untouched.
    // The moment a human saves in between — `lastEditedBy` becomes their name —
    // the next chef write sees that and captures it, exactly as today. A human's
    // version therefore survives any number of consecutive chef writes that
    // follow it, however many, and `pushRevision`'s cap is never the thing that
    // has to hold that promise.
    const chefIsContinuingItsOwnRun = current.lastEditedBy === CHEF_AUTHOR_NAME;
    const page: LibraryPageDoc = {
      ...current,
      title,
      body: input.body,
      updatedAt: now,
      lastEditedBy: CHEF_AUTHOR_NAME,
      // `savedBy` is whoever REPLACED the version being filed, matching the
      // browser's own snapshot at `beginLibraryEdit`.
      revisions: chefIsContinuingItsOwnRun
        ? current.revisions
        : pushRevision(current.revisions, {
            title: current.title,
            body: current.body,
            savedAt: now,
            savedBy: CHEF_AUTHOR_NAME,
          }),
    };
    await ref.set(page);
    return { saved: true, id: page.id, created: false, problem: null };
  } catch (err) {
    logger.warn('chefChat: writeKitchenNote failed', { id: input.id, err });
    return refused('that could not be saved just now');
  }
}

const WRITE_KITCHEN_NOTE_DESCRIPTION = `Write a page into the household's Library, or replace one that is already there. Use it to put \
something down where they will find it again: a table you worked out together, the settings for a piece of kit, a \
list of what they own.

CALL THIS ONLY WHEN THEY HAVE ASKED YOU TO WRITE ONE. "Write that up", "make me a note of this", "add it to my \
jar page", "save this somewhere" — an instruction, in their words, in this conversation.

DO NOT CALL IT for anything else, ever. Not because a conversation covered ground worth keeping, not to tidy a \
page you have just read, not to record what you have decided, and not to save your own answer. A long chat about \
jars is not permission to rewrite the jar page. If you think something is worth writing down, SAY SO and let them \
ask.

To ADD to an existing page, read it first with readKitchenNote, then send its whole text back with your addition \
in it and its id here. The body you send REPLACES everything the page held — sending only the new part throws \
the rest away.

You cannot delete a page and you cannot empty one. If they ask you to, say plainly that deleting is theirs to do, \
on the page itself.

Check saved before you say anything. When it is false, problem says why in plain words: repeat it and do not \
claim the page was written.`;

export const writeKitchenNoteTool = ai.defineTool(
  {
    name: 'writeKitchenNote',
    description: WRITE_KITCHEN_NOTE_DESCRIPTION,
    inputSchema: WriteKitchenNoteInputSchema,
    outputSchema: WriteKitchenNoteOutputSchema,
  },
  (input) => writeKitchenNoteForChef(getFirestore(), input),
);

// ─── Asking for the conversation to be saved as a recipe (issue #1480) ───────
//
// The tool the chef calls when somebody asks it to save a recipe, and the whole
// of what the server does about it.

/**
 * The tool's name, as the model sees it and as the reply is scanned for.
 *
 * One constant rather than two literals: the declaration below and
 * `turnRequestedRecipeSave` have to agree or the intent is recorded by nobody,
 * silently.
 */
export const SAVE_RECIPE_TOOL_NAME = 'saveRecipe';

const SAVE_RECIPE_DESCRIPTION = `Save the dish this conversation has arrived at as one of their recipes — the same save as the \
button in the app, producing the same recipe, in the same place.

CALL THIS ONLY WHEN THEY HAVE ASKED FOR IT. "Save this as a recipe", "create a recipe from this", "add that to my \
recipes", "keep that one" — a request, in their words, in this conversation.

DO NOT CALL IT for anything else. Not because they liked the sound of something, not because you think a dish is \
worth keeping, and not to round off an answer you are pleased with. Enthusiasm is not an instruction. If you think \
something is worth saving, SAY SO and let them ask.

It takes no arguments and you do not write the recipe: the app reads the conversation and writes it, and it will \
take them to the finished recipe. Never write the dish out as a page in their Library instead — that is a \
different thing entirely, and it is not what they asked for.

Say one short line afterwards. They are about to watch the page change, so do not list the recipe back out, do not \
invent a title for it, and never claim to have written it yourself.`;

/**
 * The one tool here that records a request and performs no write.
 *
 * THE HANDLER IS A CONSTANT, and that is the safety property this whole feature
 * rests on (CLAUDE.md Rule 12). It takes no `db`, closes over nothing, and
 * returns the same object every time — so recognising a save intent cannot itself
 * change anything, however wrong the model is about what was meant. What the
 * model's call actually does is leave a `toolRequest` part in the turn's own
 * message history, which `turnRequestedRecipeSave` below reads and
 * `writeChefChatTurn` records on the chat document. The SAVE then runs in the
 * browser, through `chatRecipeAuthor.ts` — the one create implementation.
 *
 * A SERVER-SIDE SAVE IS FORBIDDEN, not merely unbuilt. `cloud-functions` cannot
 * import `@salt/firebase-sync` (Rule 2), and a second create path is the exact
 * drift `chatRecipeAuthor.ts` and `recipeAmend.ts` were consolidated to end
 * (#791). If this handler ever grows a body, that decision is being reversed —
 * `chefChat.saveIntent.test.ts` goes red first.
 *
 * Contrast `writeKitchenNoteTool` above, which does write: a Library page is a
 * document with a visible revision history, so a wrong write there is noticeable
 * and reversible. A recipe written by a mishearing is the same — deletable — but
 * there is no reason to move the write to reach it, so it does not move.
 */
export const saveRecipeTool = ai.defineTool(
  {
    name: SAVE_RECIPE_TOOL_NAME,
    description: SAVE_RECIPE_DESCRIPTION,
    inputSchema: SaveRecipeInputSchema,
    outputSchema: SaveRecipeOutputSchema,
  },
  // `async` only because Genkit's tool signature demands a promise; there is
  // nothing here to await, and nothing to await is the point.
  async (): Promise<SaveRecipeOutput> => ({ requested: true }),
);

// How the chef is told the save exists at all, beside LIBRARY_FRAMING and in the
// same shape as KITCHEN_NOTES_FRAMING: the tool description governs when to call,
// this governs how to talk about it. Present only for a caller inside the flag,
// so everyone else's prompt is byte for byte what it was.
const SAVE_RECIPE_FRAMING = `## Saving one of their recipes
They can keep this conversation as one of their own recipes. There is a save control in the app, and now there is \
you: saveRecipe does exactly what that control does, so "save this as a recipe" is something you can simply do \
rather than something you have to explain.

ASKED, NOT ASSUMED. Reach for it when they ask, in this conversation, in their own words. A dish they are keen on \
is not a request, and neither is your own feeling that something is worth keeping — offer, and let them answer.

YOU DO NOT WRITE IT. The app reads the whole conversation and writes the recipe itself, and then shows it to them. \
So do not compose the recipe into your reply first, do not name it, and do not describe what you have saved: one \
short line is the right answer, because the recipe is about to be on screen.

IT IS NOT A PAGE. If they ask for a recipe, they mean a recipe. Writing the dish out as a page instead is the one \
mistake worth naming here, and it is not a near miss — it puts the thing they asked for somewhere they will not \
look for it.`;

/**
 * Did the model ask for a save on this turn?
 *
 * READ OFF THE TURN'S OWN MESSAGE HISTORY, because `toolRequests` is the LAST
 * model message's alone and the last message of a tool turn is the prose that
 * follows the call. `GenerateResponse.messages` is the accumulated request plus
 * that final message, and Genkit's tool loop carries the model message holding
 * the `toolRequest` forward into every subsequent request
 * (`@genkit-ai/ai@1.42.0`, `lib/generate/action.js` — `messages` is rebuilt as
 * `[...rawRequest.messages, generatedMessage]` before it recurses, and
 * `generate.js` keeps `response.request ?? request`). So the call is still in
 * there when the turn finishes.
 *
 * THE BOUNDARY: that is a property of a pinned dependency's source, not an
 * observation in production, and a Genkit change could take it away. When it
 * does, this returns false — a missed prompt and a button press, never a wrong
 * write — and `chefChat.saveIntent.test.ts` pins the shape this reads so the
 * parsing itself cannot rot unnoticed. `messages` also THROWS when the response
 * carries no request reference (an aggregate we never see in practice, and every
 * test double), hence the catch.
 *
 * Structural rather than typed: the parts come back through Genkit's own schemas
 * and narrowing them here would buy a cast, not a check.
 */
export function turnRequestedRecipeSave(response: unknown): boolean {
  let messages: unknown;
  try {
    messages = (response as { messages?: unknown } | null | undefined)?.messages;
  } catch {
    return false;
  }
  if (!Array.isArray(messages)) return false;
  return messages.some((message: unknown) => {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return false;
    return content.some((part: unknown) => {
      const name = (part as { toolRequest?: { name?: unknown } } | null)?.toolRequest?.name;
      if (typeof name !== 'string') return false;
      // A plugin-registered tool arrives namespaced (`plugin/tool`); this one is
      // defined locally and does not, but matching both costs a suffix test and
      // removes a way for the signal to go quiet after a refactor.
      return name === SAVE_RECIPE_TOOL_NAME || name.endsWith(`/${SAVE_RECIPE_TOOL_NAME}`);
    });
  });
}

// How the chef is told to USE the Library, beside LIBRARY_FRAMING and in the same
// shape: the tool descriptions govern when to call, this governs what to do with
// the answer. Its own section rather than a paragraph bolted onto LIBRARY_FRAMING
// precisely because the two must not blur — see the heading's last rule.
const KITCHEN_NOTES_FRAMING = `## Their Library
This household writes things down — the kitchen facts that are not recipes. Their Library is where those pages \
live; findKitchenNotes searches it and readKitchenNote opens one page in full. They are what this kitchen has \
actually proven, so where a page answers the question it beats anything you would say from general knowledge.

LOOK FIRST, READ SECOND. A search gives you the opening of each page, and that is usually the whole answer. \
Open a page in full only when the detail you need is deeper in it.

SAY WHICH PAGE YOU USED, by its title, in your own words — "your sous vide table has chuck at 65 °C for 24 \
hours". Never read a page back as a wall of text, and never present something you worked out yourself as \
something they had written down.

WRITING ONE IS SOMETHING THEY ASK FOR. writeKitchenNote puts a page into their Library, and you reach for it \
when they tell you to and at no other time. A conversation that covered good ground is not an instruction, and \
neither is a page you have just read being out of date. If something is worth writing down, say so and let them \
ask. To add to a page, read it first and send its whole text back with your addition in it — the body you send \
replaces what was there. You cannot delete a page; that is theirs to do on the page itself.

THE LIBRARY IS NOT THEIR RECIPES. Their saved recipes are a different thing with a different pair of tools, \
described above. A Library page is a reference page: a table, a list of kit, a set of numbers.

Say plainly when they have written nothing about it, then answer as you normally would. That is different from \
findKitchenNotes failing to run at all — see its own description for what to say then. Their Library is one more \
thing you can reach, not a place you have to go first.`;

/**
 * The verified caller of this turn.
 *
 * `onCallGenkit` copies the callable's own `req.auth` — the DECODED, VERIFIED
 * Firebase ID token — into the Genkit action context as `context.auth`
 * (firebase-functions 7.3.2, `lib/v2/providers/https.js`), and `chefChat` runs
 * under `authPolicy: isSignedIn()` (`index.ts`), so behind that policy the object
 * is present and its uid is the signed-in person.
 *
 * THIS IS THE ONLY ROUTE THE UID TAKES. Nothing is read off the request body, and
 * `ChefChatInputSchema` has no uid field for a client to put one in — a
 * client-supplied uid is not a gate. `input.speaker` is a display NAME and is not
 * an identity: it is never consulted here.
 *
 * Null means the context carried no verified uid, which cannot happen behind the
 * auth policy and is therefore not a case to be generous about — `kitchenNotesEnabled`
 * fails closed on it.
 */
interface VerifiedCaller {
  readonly uid: string;
  readonly email?: string;
}

export function verifiedCaller(context: ActionContext | undefined): VerifiedCaller | null {
  const auth: Record<string, unknown> | undefined = context?.auth;
  if (auth === undefined) return null;
  const uid = auth['uid'];
  if (typeof uid !== 'string' || uid === '') return null;
  // The email is a person property PostHog may target a release condition on, the
  // same way the browser identifies people. Absent is fine; wrong is not, so it is
  // only taken when the verified token actually carries a non-empty string there.
  const token = auth['token'];
  const claim =
    typeof token === 'object' && token !== null ? Reflect.get(token, 'email') : undefined;
  return typeof claim === 'string' && claim !== '' ? { uid, email: claim } : { uid };
}

/**
 * Whether one PostHog flag is on for this caller — the kitchen-notes tools
 * (`library`, issue #831) and the recipe save (`chat-save`, issue #1480) alike.
 *
 * The gate decides WHICH TOOLS GO INTO THE `tools:` ARRAY for this request, and
 * which framing sections reach the prompt — not what a tool does once called: the
 * tools themselves are defined at module load, as Genkit requires, and the array
 * is passed by value.
 *
 * FAILS CLOSED on a missing uid, where `isServerFeatureEnabled` would fail OPEN on
 * a deployment with no PostHog key ("unconfigured means ungated"). The two
 * asymmetries are deliberate and different: no PostHog at all means nothing is
 * being gated anywhere, while no verified caller behind `isSignedIn()` means
 * something is wrong, and a gate that opens when it cannot identify anybody is not
 * a gate.
 */
async function callerInFlag(flagKey: string, caller: VerifiedCaller | null): Promise<boolean> {
  if (caller === null) return false;
  return isServerFeatureEnabled(
    flagKey,
    caller.uid,
    caller.email === undefined ? undefined : { email: caller.email },
  );
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
  kitchenNotesFraming: string,
  saveRecipeFraming: string,
): string {
  // FIRST after the base, and unconditional. It is a capability statement — how
  // this chef answers at all — not a piece of context about tonight, so it sits
  // with the base rather than among the situational sections that follow. There
  // is nothing to gate it on either: how many recipes are saved is only known
  // once the tool has been called, and a read to find out would cost every turn
  // the very thing the tool exists to avoid paying.
  const sections: string[] = [CHEF_SYSTEM_BASE, LIBRARY_FRAMING];

  // Immediately after the recipes framing it belongs to, and ONLY for a caller
  // inside the `chat-save` flag (issue #1480) — same rule as the Library section
  // below, for the same reason: a chef told it can save a recipe, holding no tool
  // that says so, would offer and then be unable to. Empty for everyone outside
  // the flag, so their prompt is byte for byte today's.
  if (saveRecipeFraming) sections.push(saveRecipeFraming);

  // Beside LIBRARY_FRAMING, and ONLY when this caller actually has the tools
  // (issue #1377). A chef told about a Library it cannot reach would offer to
  // look in it and then be unable to — worse than never mentioning it. Empty for
  // everyone outside the flag, so their prompt is byte for byte today's.
  if (kitchenNotesFraming) sections.push(kitchenNotesFraming);

  const equipmentSection = equipmentSectionForChef(equipmentContext);
  // Both or neither, and in this order: the kit list first, then what to do when
  // a name on it is not enough (issue #1373). With no manifest there is nothing
  // for readEquipmentDetail to find, so neither section appears.
  if (equipmentSection) sections.push(equipmentSection, KITCHEN_DETAIL_FRAMING);

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

const CHAT_SESSION_COLLECTION = 'chatSessions';

/**
 * Send one fragment to the reader, and never let a failed send end the turn
 * (issue #1430).
 *
 * THE WHOLE FIX RESTS ON THE FLOW BODY OUTLIVING THE CLIENT. `writeChefChatTurn`
 * below runs after the drain loop, for the express purpose of surviving a phone
 * that locked mid-reply — so if emitting into a dead connection threw, the loop
 * would throw into the catch and the write would never happen in exactly the case
 * it exists for.
 *
 * IT DOES NOT THROW, in `firebase-functions@7.3.2`, which is what this repo pins.
 * Read from the transport rather than assumed: `wrapOnCallHandler`
 * (`lib/common/providers/https.js`) registers `res.on('close', …)` which aborts an
 * `AbortController`, and `sendChunk` returns `Promise.resolve(false)` — no write,
 * no rejection — for the rest of the request once that signal is aborted. Genkit's
 * `onCallGenkit` (`lib/v2/providers/https.js`) does `await res.sendChunk(chunk)`
 * and ignores the `false`, so its own drain continues, the flow's `output` promise
 * is still awaited, and the model call is never cancelled — nothing forwards the
 * abort signal into `action.stream`.
 *
 * SO WHY WRAP IT AT ALL. Because that is a property of a transport we do not own,
 * established by reading a pinned dependency's source and not by an observation in
 * production, and a minor-version change to it would silently take the fix with it.
 * This makes the flow's half true by construction whatever the transport does, and
 * `chefChat.disconnect.test.ts` goes red if the wrapper is removed. A swallowed
 * emit costs the reader nothing they can still see — by definition the connection
 * that would have shown it is gone.
 *
 * Deliberately NOT swallowed silently: a throw here would mean the transport
 * changed, and that is worth a log line rather than a mystery.
 */
function emit(streamingCallback: (chunk: string) => void, text: string): void {
  try {
    streamingCallback(text);
  } catch (err) {
    // The raw error, as `writeKitchenNoteForChef` logs its own: Cloud Logging
    // serialises it, and narrowing it to a message here would be a branch that
    // only a contrived non-Error throw could ever cover.
    logger.warn('chefChat: streaming emit failed, continuing the turn', { err });
  }
}

/**
 * `expiresAt` as stored: a `Timestamp` on everything written since #1008, an
 * ISO-8601 string on any document not yet migrated. Both become the string
 * `ChatSessionSchema` expects; anything else passes through for the schema to
 * refuse.
 *
 * The admin SDK's `Timestamp`, and deliberately a second implementation of
 * `normalizeExpiresAt` in `@salt/firebase-sync` rather than a shared one: the two
 * name two different `Timestamp` classes from two different SDKs, and neither
 * package may import the other (Hard rules 1 and 2). What is NOT duplicated is
 * the thing that would matter if it drifted — how long a chat lives — which is
 * `chatExpiresAt` in `@salt/domain`, called by both.
 */
function chatExpiresAtToIso(data: Record<string, unknown>): Record<string, unknown> {
  const stored = data['expiresAt'];
  if (stored instanceof Timestamp) {
    return { ...data, expiresAt: stored.toDate().toISOString() };
  }
  return data;
}

interface ChefChatTurn {
  readonly sessionId: string;
  readonly caller: VerifiedCaller | null;
  readonly userText: string;
  readonly replyText: string;
  /** When the person pressed send — the user turn's `createdAt`. */
  readonly askedAt: Date;
  /** When the reply finished — the assistant turn's `createdAt`, and the write's. */
  readonly repliedAt: Date;
  /**
   * Whether the model called `saveRecipe` on this turn (issue #1480) — i.e.
   * whether somebody asked for this conversation to be kept as a recipe.
   *
   * OPTIONAL because it is a request, not a fact about the turn: absent reads as
   * "nobody asked", which is what every caller that predates this meant.
   */
  readonly saveRequested?: boolean;
}

/**
 * Write the turn this flow has just streamed into `chatSessions/{sessionId}`
 * (issue #1430).
 *
 * WHY THE FLOW AND NOT THE BROWSER. The browser used to mint both turns, hold
 * them in memory for the length of the call, and write once the stream had fully
 * drained. A phone that locked, or a tab that closed, performed none of that: the
 * function completed, the tokens were paid for, and both the chef's reply AND the
 * user's own typed sentence were gone with no error and nothing on screen. Same
 * fault and same fix as `persistAuthoredRecipe` (#616) and `generateGuidedPlan`
 * (#1416).
 *
 * READ-THEN-`.set()`, NEVER REBUILT FROM `input.messages`. The history on the wire
 * is deliberately filtered — `chatService.sendMessage` strips every `/remember …`
 * line before sending, because the note is already in the system prompt and the
 * raw line invites the chef to acknowledge a save it played no part in. The wire
 * history is therefore NOT a faithful copy of the conversation, and a write built
 * from it would silently delete every `/remember` line from the stored transcript.
 * The same read-rebuild-`.set()` shape `writeKitchenNoteForChef` uses above.
 *
 * THE OWNERSHIP CHECK IS RE-CREATED HERE because an Admin SDK write bypasses
 * `firestore.rules` wholesale. `firestore.rules`' `chatSessions` block is what
 * guarantees a chat is only ever written by its owner (#408), and it still governs
 * every browser write — it simply does not see this one. So the document's own
 * `ownerUid` is compared against the VERIFIED caller (`verifiedCaller`, #1377 —
 * the Genkit action context, never the request body) and a mismatch writes
 * nothing. Without it a client-supplied `sessionId` would be a write primitive
 * into someone else's conversation. `chatSessions` stays exactly as per-user as it
 * was; only the writer changed.
 *
 * `expiresAt` IS BUMPED, not carried forward. A full `.set()` that omitted it
 * would disable the TTL for that document in silence (#1008 — the machinery acts
 * on a `Timestamp` and skips anything else without a word), and carrying the old
 * value forward lets a fortnight-old chat expire in the middle of an active
 * conversation. `chatExpiresAt` from `@salt/domain` is the one home for the two
 * durations; only the `Timestamp` conversion is ours.
 *
 * IT ALSO CARRIES THE SAVE REQUEST (issue #1480), and that is the whole of the
 * channel: `pendingSaveIntent` rides the write this function was already making,
 * so the wire contract does not move and #1303's deploy-skew corruption cannot
 * recur. This is still not a save — see `saveRecipeTool` — it records that one
 * was asked for, and the browser does the rest.
 *
 * IT NEVER THROWS (Rule 10, and `persistAuthoredRecipe`'s reasoning): a Firestore
 * hiccup must not throw away a completed, already-paid-for turn. The callable
 * still returns the reply, the browser still paints it, and the failure is logged.
 * The boundary, because "the turn is never lost" would be too strong: when this
 * write fails, the turn is lost exactly as it was before this issue — the browser
 * no longer persists on the send path, so there is no second writer to fall back
 * on. What this removes is the loss caused by the PAGE going away, which was 100%
 * of the occurrences; a failed write is a different and much rarer one.
 */
export async function writeChefChatTurn(
  db: ReturnType<typeof getFirestore>,
  turn: ChefChatTurn,
): Promise<void> {
  try {
    if (turn.caller === null) {
      logger.warn('chefChat: no verified caller, turn not written', { sessionId: turn.sessionId });
      return;
    }
    const ref = db.collection(CHAT_SESSION_COLLECTION).doc(turn.sessionId);
    const snap = await ref.get();
    if (!snap.exists) {
      logger.warn('chefChat: chat session not found, turn not written', {
        sessionId: turn.sessionId,
      });
      return;
    }
    const parsed = ChatSessionSchema.safeParse(chatExpiresAtToIso({ ...snap.data(), id: snap.id }));
    if (!parsed.success) {
      // Writing over a document we could not read would destroy whatever it
      // actually holds — the same reason `writeKitchenNoteForChef` leaves an
      // unreadable note alone.
      logger.warn('chefChat: chat session unreadable, turn not written', {
        sessionId: turn.sessionId,
      });
      return;
    }
    const session = parsed.data;
    if (session.ownerUid !== turn.caller.uid) {
      logger.warn('chefChat: chat session belongs to another user, turn not written', {
        sessionId: turn.sessionId,
      });
      return;
    }

    const repliedAt = turn.repliedAt.toISOString();
    // Minted here so the save intent below can name the turn it belongs to.
    const assistantMessageId = randomUUID();
    const updated: ChatSessionDoc = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: randomUUID(),
          role: 'user',
          text: turn.userText,
          createdAt: turn.askedAt.toISOString(),
        },
        { id: assistantMessageId, role: 'assistant', text: turn.replyText, createdAt: repliedAt },
      ],
      updatedAt: repliedAt,
      // SET ON EVERY TURN, to the new assistant message id or back to null — one
      // half of the clearing rule the field's declaration describes (issue
      // #1480). Carrying the stored value forward instead would leave a request
      // nobody acted on sitting on the document, re-firing on every reload until
      // somebody deleted the chat; this way a stale one survives at most until
      // the next thing anybody says. The browser clears it as it takes it, which
      // is the half that stops it firing twice in one conversation.
      pendingSaveIntent: turn.saveRequested === true ? assistantMessageId : null,
      expiresAt: chatExpiresAt(session, turn.repliedAt).toISOString(),
    };
    await ref.set({
      ...updated,
      // The one wire divergence from the domain shape, matching `saveChatSession`:
      // the TTL machinery acts only on a `Timestamp` (#1008). Same instant, new
      // type.
      expiresAt: Timestamp.fromDate(new Date(updated.expiresAt)),
    });
  } catch (err) {
    logger.error('chefChat: failed to write the turn', { sessionId: turn.sessionId, err });
    // Additive to the log line above (§Observability), not a replacement for it.
    // No DomainError category to hand it: this is a raw Firestore exception, not
    // a classified Result envelope, so it goes through uncategorised — the
    // bucket the reporting policy gates as reportable ("report the unexpected").
    await reportFlowError(err);
  }
}

export const chefChatFlow = ai.defineFlow(
  {
    name: 'chefChat',
    inputSchema: ChefChatInputSchema,
    outputSchema: ChefChatOutputSchema,
    streamSchema: ChefChatOutputSchema,
  },
  async (input, streamingCallback) => {
    // Everything the reader has actually been shown, accumulated as it goes.
    let streamedText = '';
    // When the person pressed send, as near as this side can know it. The user
    // turn's `createdAt`, so the stored transcript orders the two turns by when
    // they happened rather than both at the end of the reply.
    const askedAt = new Date();
    try {
      const db = getFirestore();
      // The verified caller, from the Genkit action context and from nowhere else
      // (issue #1377). Never the request body.
      const caller = verifiedCaller(streamingCallback.context);
      const [
        equipmentContext,
        recipeContext,
        favouritesContext,
        variationContext,
        memoryContext,
        notesEnabled,
        saveEnabled,
      ] = await Promise.all([
        readEquipmentContext(db, 'chefChat'),
        input.recipeId ? readRecipeContext(db, input.recipeId) : Promise.resolve(''),
        // Joins the existing Promise.all rather than adding a serial round-trip.
        readFavouritesContext(db),
        // The base recipe of a variation chat (issue #763). Reuses the same
        // reader, which returns '' for a deleted or corrupt doc — so a variation
        // whose base disappears mid-conversation quietly becomes an ordinary
        // chat instead of failing the turn (Rule 10).
        input.basedOnRecipeId ? readRecipeContext(db, input.basedOnRecipeId) : Promise.resolve(''),
        // The household's notes (issue #816). Joins the existing Promise.all
        // rather than adding a serial round-trip — it is one small collection
        // read, and it costs the turn nothing it was not already waiting on.
        readKitchenMemoryContext(db, 'chefChat'),
        // Whose chat gets the kitchen-notes tools (issue #1377). A PostHog
        // round-trip, so it joins the existing Promise.all rather than adding a
        // serial one — and it resolves false without any network call at all for
        // a request that carried no verified uid.
        callerInFlag(LIBRARY_FLAG_KEY, caller),
        // Whose chef can be asked to save a recipe (issue #1480). A second
        // PostHog round-trip on the same connection, in the same batch, resolved
        // without a network call at all for a caller the gate has already
        // refused.
        callerInFlag(CHAT_SAVE_FLAG_KEY, caller),
      ]);

      const systemPrompt = buildSystemPrompt(
        equipmentContext,
        recipeContext,
        favouritesContext,
        variationContext,
        memoryContext,
        input.speaker,
        notesEnabled ? KITCHEN_NOTES_FRAMING : '',
        saveEnabled ? SAVE_RECIPE_FRAMING : '',
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

      // Built rather than ternaried, because there are now two independent gates
      // over one array and a nested conditional would answer neither clearly. The
      // ORDER is the read tools, then the Library's three, then the save — the
      // order the tools arrived in, and the order the tests name them in.
      const tools = [
        findRecipesTool,
        readRecipeTool,
        readEquipmentDetailTool,
        ...(notesEnabled ? [findKitchenNotesTool, readKitchenNoteTool, writeKitchenNoteTool] : []),
        ...(saveEnabled ? [saveRecipeTool] : []),
      ];

      const { stream, response } = ai.generateStream({
        model: chatModel,
        system: systemPrompt,
        messages: history,
        prompt: input.newMessage,
        // The chef's tools, assembled just above. Three for everyone (issues
        // #840, #1373) — findRecipes, readRecipe and readEquipmentDetail, the
        // last of which is READ-ONLY, permanently ("No, and not ever": see the
        // comment at `readEquipmentDetailTool`) — plus the three kitchen-notes
        // tools for a caller inside the `library` flag (issue #1377), plus
        // `saveRecipe` for one inside `chat-save` (issue #1480), which writes
        // nothing at all. That is what this array varying per request is for, and
        // it is the whole of both gates: the tools themselves are defined at
        // module load, as Genkit requires, and what changes is the array passed
        // BY VALUE here.
        //
        // Genkit runs the tool loop inside this call and keeps streaming across
        // it, so the reply still arrives in fragments; the gaps while tools run are
        // silence, which is what the idle timer below bounds. A turn may search,
        // read a dish, look a piece of kit up, read a note AND write one, so that
        // is up to six round-trips inside one stream — each is a Firestore read
        // (or, for writeKitchenNote, a single write) measured in milliseconds,
        // nowhere near the 55 s idle budget.
        //
        // Note what is still absent: no `output` option, and none is coming. Half
        // of design principle #1 survives intact — the chef returns prose, and
        // structure stays the librarian's job at save time.
        tools,
      });

      // The DRAIN is what needs the deadline, not what follows it (issue #915).
      // This loop used to be bare, with withAiTimeout applied afterwards to the
      // aggregated `response` — which a model that goes quiet mid-stream never
      // reaches, so the turn hung until the 120s function quota killed it.
      // withAiStreamTimeout races each chunk against an idle timer instead: a
      // silence longer than the budget throws AiTimeoutError into the catch
      // below, and a long answer that keeps arriving is never cut short.
      //
      // WHAT WAS STREAMED IS WHAT GETS STORED, and the accumulation is the whole
      // of that guarantee (PR #1303 review, kept by #1310). Genkit's tool loop
      // streams EVERY iteration's chunks through this one callback, while
      // `response.text` is the LAST model message alone — so a chef that writes
      // a sentence and then reaches for `findRecipes` or `readRecipe` would have
      // the reader watch the whole reply arrive and find only the tail of it
      // stored after a reload.
      for await (const chunk of withAiStreamTimeout('chefChat', stream)) {
        const text = chunk.text;
        if (text) {
          streamedText += text;
          emit(streamingCallback, text);
        }
      }

      // The stream has fully drained above, so this resolves immediately in the
      // normal case; the timeout stays as a backstop. AI model/token/cost
      // telemetry rides the Genkit model span the AI-OTLP processor ships to
      // PostHog (#356) — and span-derived usage fixes the old streamed-response
      // empty-tokens gap.
      const finalResponse = await withAiTimeout('chefChat', () => response, AI_TEXT_FLOW_TIMEOUT);

      // `finalResponse.text` only as the fallback for a turn that streamed nothing
      // at all — an aggregate arriving without chunks is not a shape we have seen,
      // and an empty reply is worse than a duplicated one.
      const reply = streamedText || finalResponse.text;

      // Was this one of the handful of turns where somebody asked for a recipe to
      // be saved (issue #1480)? Read off the finished turn, and GATED AGAIN here
      // rather than trusted from the tool's presence alone — the array above is
      // the only way the tool can be reached, so this second test is belt and
      // braces, and it is what makes "outside the flag, nothing is recorded" true
      // of this line on its own rather than of two lines read together.
      const saveRequested = saveEnabled && turnRequestedRecipeSave(finalResponse);

      // The turn is stored EXACTLY as it is returned, and only on a turn that got
      // this far: a stream that times out or errors throws into the catch below
      // and writes nothing, as it always has (the client rolls its optimistic
      // append back and the composer restores what was typed).
      //
      // Awaited rather than fired and forgotten: the drain is finished, this is one
      // read and one write measured in milliseconds against a 120 s budget, and a
      // promise left dangling past the flow's return is not guaranteed to run at all
      // on a function instance the platform is free to freeze.
      if (input.sessionId !== undefined) {
        await writeChefChatTurn(db, {
          sessionId: input.sessionId,
          caller,
          userText: input.newMessage,
          replyText: reply,
          askedAt,
          repliedAt: new Date(),
          saveRequested,
        });
      }

      return reply;
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
