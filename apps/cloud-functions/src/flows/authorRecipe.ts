import { z } from 'genkit';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  AuthorRecipeInputSchema,
  AuthorRecipeOutputSchema,
  LibrarianOutputSchema,
  RecipeSchema,
} from '@salt/domain/schemas';
import type { RecipeDoc } from '@salt/domain/schemas';
import { isAuthorable, stampAttribution } from '@salt/domain';
import { setActiveSpanName } from '@salt/observability/server';
import { AI_TEXT_FLOW_TIMEOUT, withAiTimeout } from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { assembleRecipeDraft } from './assembleRecipeDraft.js';
import { persistAuthoredRecipe } from './persistAuthoredRecipe.js';
import { flowModel } from '../ai/fakeModel.js';
import { recipeFieldRules } from './recipeFieldRules.js';
import { readEquipmentContext, equipmentSectionForLibrarian } from './equipmentContext.js';
import { readComponentContext, componentSectionForLibrarian } from './componentContext.js';
import { formatRecipeForPrompt, withComponents } from './recipeText.js';

export const authorRecipeFlow = ai.defineFlow(
  {
    name: 'authorRecipe',
    inputSchema: AuthorRecipeInputSchema,
    // Validated against the real recipe contract (issue #932, Phase 6). This was
    // `z.custom<RecipeDoc>()`, which — with no validator function — accepts any
    // value, so the declared output type was a claim Genkit never checked. The
    // swap is a deliberate behaviour change: a malformed draft that used to pass
    // straight through to the `recipes` collection now fails the flow instead.
    // Shipped on Phase 5's evidence — its observing `safeParse` reported no
    // mismatch across a URL import, a photo import and a chat-authored recipe,
    // run against real model output on staging.
    outputSchema: AuthorRecipeOutputSchema,
  },
  async (input) => {
    const conversationText = input.messages
      .map((m) => `${m.role === 'user' ? 'User' : 'Chef'}: ${m.text}`)
      .join('\n\n');

    const tagVocab =
      input.existingTags.length > 0
        ? `\n\nExisting category tags in this recipe collection (prefer these where they genuinely fit; add a new tag only if meaningfully different, and still never an ingredient): ${input.existingTags.join(', ')}.`
        : '';

    // Edit mode: ground the librarian on the existing recipe so it returns the
    // FULL recipe with the conversation's changes applied, rather than authoring
    // a near-empty recipe from an incremental edit chat (e.g. "add some cheese").
    // We keep the structured doc (not just the prompt text) so the draft
    // assembler can diff against it and skip re-parsing/re-embedding unchanged
    // ingredients.
    // The equipment manifest rides along in BOTH create and edit mode, purely so
    // the librarian RECOGNISES appliance names in the transcript and preserves
    // them (see equipmentContext.ts — it must never pick equipment itself).
    // Without it, "sear it in the Pizzaiolo at 400 °C" gets flattened back to
    // "bake in the oven" on the way into the saved recipe.
    //
    // Variation mode (issue #763) is a THIRD composition and deliberately not a
    // shade of edit mode: the conversation is about a new dish that starts from
    // an existing one. It grounds the PROSE on the base recipe — so the draft
    // carries forward every ingredient, step and timing the chat never mentioned
    // — while `assembleRecipeDraft` is still called with `baseRecipe: null`, so
    // the draft never inherits the base's identity (its `producesCanonId`, its
    // image, or its title). Edit mode wins when both ids are set.
    const db = getFirestore();
    const [baseRecipe, variationBase, equipmentContext] = await Promise.all([
      input.recipeId ? readBaseRecipe(db, input.recipeId) : Promise.resolve(null),
      !input.recipeId && input.basedOnRecipeId
        ? readBaseRecipe(db, input.basedOnRecipeId)
        : Promise.resolve(null),
      readEquipmentContext(db, 'authorRecipe'),
    ]);
    // The dishes a meal is built from (issue #838). NAMES, DESCRIPTIONS AND TIMES
    // ONLY — never a component's ingredients or steps, because this flow returns a
    // complete RecipeDoc that is spread over the stored recipe and the planner
    // attaches the meal AND its dishes, so a copied ingredient line is shopped
    // twice for one dinner. See componentContext.ts for the full argument.
    //
    // Necessarily after the reads above: the component ids live inside the recipe
    // document. One batched getAll, and only for a meal — a recipe with no
    // components yields '' and the prompt is byte-for-byte what it was.
    const componentBase = baseRecipe ?? variationBase;
    const componentSection = componentBase
      ? componentSectionForLibrarian(await readComponentContext(db, componentBase, 'authorRecipe'))
      : '';

    const closing = baseRecipe
      ? // `stepIds: true` for edit mode ALONE (issue #1178): this is the only
        // composition where "which existing step did this come from?" has an
        // answer. Variation mode assembles with `baseRecipe: null`, so a citation
        // there would be honoured against nothing; create mode has no base at all.
        editModeSection(
          withComponents(formatRecipeForPrompt(baseRecipe, { stepIds: true }), componentSection),
        )
      : variationBase
        ? variationModeSection(
            withComponents(formatRecipeForPrompt(variationBase), componentSection),
          )
        : CREATE_MODE_CLOSING;
    const equipmentSection = equipmentSectionForLibrarian(equipmentContext);
    const systemPrompt = `${LIBRARIAN_SYSTEM}\n\n${closing}${tagVocab}${
      equipmentSection ? `\n\n${equipmentSection}` : ''
    }`;

    // Flash + temperature:0 for the librarian — accuracy over creativity (issue #206).
    // `flowModel` rather than `resolveModel` so the librarian can be stubbed under
    // FUNCTIONS_AI_FAKE (issue #763): "Save as recipe" had no e2e coverage at all
    // because the one flow it runs was the last leg still reaching a live model.
    // Byte-for-byte the production path when the flag is off — see fakeModel.ts,
    // which already names authorRecipe as a structured-output flow.
    const model = await flowModel('authorRecipe');
    const result = await withAiTimeout(
      'authorRecipe',
      () =>
        ai.generate({
          model,
          system: systemPrompt,
          prompt: conversationText,
          output: { schema: LibrarianOutputSchema },
          config: { temperature: 0 },
        }),
      AI_TEXT_FLOW_TIMEOUT,
    );

    const parsed = LibrarianOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`Librarian returned invalid recipe structure: ${parsed.error.message}`);
    }

    // Human-readable top-level span name for the end-to-end trace view. The flow
    // span is the active span inside an ai.defineFlow body; setActiveSpanName
    // renames it (caps at 80 chars, no-op when no span is active). Recipe title is
    // only known after the librarian generates, so name it here.
    setActiveSpanName(`Author recipe: ${parsed.data.title}`);

    // `baseRecipe` is null in BOTH create and variation mode — that is what makes
    // a variation an independent dish rather than a second copy of the original.
    // Do not pass `variationBase` here (issue #763).
    //
    // Its KIND is the one thing a variation does inherit (issue #765): a variation
    // on a Negroni is a cocktail, and the base is sitting right there, so there is
    // no reason to make the model infer it from a conversation about gin. Passed
    // as a hint rather than as `baseRecipe` so nothing else about the original's
    // identity comes with it. `isAuthorable` narrows the type as well as gating
    // it — a base the librarian may not write (a special, a placeholder) is not
    // reachable from the variation menu, which is gated on the same predicate, and
    // if one ever were, the model's own answer is used rather than minting an
    // entry with a method its kind is not allowed to have.
    const kindHint = variationBase && isAuthorable(variationBase.kind) ? variationBase.kind : null;
    const draft = await assembleRecipeDraft(parsed.data, {
      source: { type: 'manual' },
      baseRecipe,
      kindHint,
    });

    // ─── The flow writes the recipe it authored (issue #1431) ──────────────────
    //
    // Only in CREATE mode, and the gate is `input.recipeId` — read exactly as the
    // Promise.all above reads it, so the mode this writes for and the mode it
    // grounded the prompt for cannot disagree. Everything below is skipped when
    // one is set, which is what protects the review gate:
    //
    //   * EDIT MODE (`recipeAmend.propose` → `proposeRecipeAmendment`, always
    //     `recipeId: existing.id`) is a PROPOSAL. The draft is merged and shown as
    //     a diff, and reaches Firestore only when the user confirms. A write here
    //     would commit an unreviewed amendment over a live recipe — data
    //     destruction, not a UX regression — so it is pinned by a test that goes
    //     red if an edit-mode call writes anything (#764, #791). It still READS:
    //     grounding the librarian on the existing recipe is the whole of edit
    //     mode.
    //   * A failed base read does NOT reopen it. `readBaseRecipe` degrades to null
    //     on a missing or corrupt document, so `baseRecipe` is an unsafe gate: it
    //     is null on an amend whose recipe would not parse, and writing then would
    //     mint a stray recipe out of an amendment nobody confirmed.
    //   * VARIATION mode (`basedOnRecipeId`, no `recipeId`) IS a create and is
    //     written: it authors a new independent dish, and its one caller treats it
    //     exactly like any other create.
    //
    // WHY HERE AND NOT THE BROWSER. `chatRecipeAuthor` used to write the document
    // on the statement after the `await` — the statement a locked phone, a
    // backgrounded PWA or a closed tab never runs. The flow completed, the
    // librarian and the whole parse/canon fan-out were paid for, and the recipe
    // was thrown away with no error and nothing on screen. Same fault and same fix
    // as `persistAuthoredRecipe` itself (#616), `generateGuidedPlan` (#1416) and
    // `chefChat` (#1430).
    //
    // THE BOUNDARY, rather than "the recipe can no longer be lost": this removes
    // the loss caused by the PAGE going away, which was 100% of occurrences. A
    // FAILED WRITE still loses it — deliberately, because failing the call would
    // throw away a generation that succeeded — recovered only by the stash and the
    // first in-place edit, with the limits written out in `persistAuthoredRecipe`.
    //
    // NOT FLAGGED `needs_approval`: that is `assembleRecipeDraft`'s option and the
    // librarian does not pass it. A chat-authored recipe is something you talked
    // through and asked for, not raw AI output nobody has read.
    if (input.recipeId) return draft;

    // The same stamp the browser applies to every other recipe write, from
    // `@salt/domain` so there is one rule and not two: `createdBy` filled only
    // when blank, `lastEditedBy` always, and BOTH left alone when no name came
    // over the wire. The assembler carries `createdBy` forward from a base recipe
    // and blanks it on a create, so fill-once here re-points nothing.
    const recipe = stampAttribution(draft, input.authorName ?? '');
    await persistAuthoredRecipe(recipe, 'authorRecipe');
    // The document that was written, not the one before the stamp: the client
    // stashes this for the page it navigates to, so a divergence would paint a
    // recipe that disagrees with Firestore the moment the listener catches up.
    return recipe;
  },
);

// The librarian's system framing. It is a CONVERSATION source: the chef just
// said "a teaspoon of cumin", and metricating that to 5g inside the same turn
// makes the saved recipe stop matching the words the user is looking at. Hence
// `measures: 'preserve'` — the one axis on which this prompt differs from the
// two import prompts, which ask the SAME module for `'metricate'` (issue #785).
// Everything else — tags, step policy, ingredient hygiene, British names and
// spelling — is shared, so a rule improved for one authoring path reaches all
// three.
//
// This was briefly a FUNCTION taking a source, because refresh mode (#784) read
// a stored document rather than a conversation and therefore wanted
// `'metricate'`. Refresh no longer runs here at all (issue #890): it is a chef
// turn followed by an ordinary amendment, so every caller of this flow is once
// again reading a conversation, and the parameter had exactly one value.
const LIBRARIAN_SYSTEM = `You are a precise recipe extraction assistant. \
Given a cooking conversation between a user and a chef, extract and structure a complete recipe.

${recipeFieldRules({ measures: 'preserve' })}`;

// Create mode: the conversation is the only source of truth.
const CREATE_MODE_CLOSING = `Extract only what is present in the conversation. \
Do not invent ingredients or steps not discussed — though splitting an operation the chef DID \
describe across consecutive steps, per the one-operation rule above, invents nothing.`;

// Edit mode: the existing recipe is the source of truth and the conversation
// describes a delta to apply. Without this, the librarian (told to "extract only
// what is present in the conversation") drops everything not mentioned in the
// edit chat — saving a recipe that is just the change.
function editModeSection(baseRecipe: string): string {
  return `## Editing an existing recipe
The user is refining a recipe that ALREADY EXISTS. Its current full content is below, \
and the conversation describes the change(s) they want to make to it.

Return the COMPLETE updated recipe: start from the current recipe and apply ONLY the \
changes discussed in the conversation. Preserve every ingredient, step, time, serving \
count, tag, and detail the conversation does not change — keep the original wording \
(rawText) of unchanged ingredients verbatim. Do not drop anything that was not discussed. \
Integrate additions (e.g. a new ingredient) into the appropriate group and reference them \
from the relevant steps.

### Where each step came from
Each step of the current recipe is written below as \`N. [id] text\`. For every step you return, \
set \`sourceStepId\` to the id of the EXISTING step it came from, copied verbatim from the method \
below — even when you have reworded it completely, and even when it has moved to a different \
position. Null ONLY for a step you are genuinely adding, which no existing step became. If you \
split one existing step into two, give BOTH halves that step's id. Do not repeat an id across \
steps that came from different originals, and never invent an id that is not in the list below. \
Do NOT write the \`[id]\` markers into the step text you return — the text is the step's wording \
and nothing else.

### Current recipe
${baseRecipe}`;
}

// Variation mode (issue #763): the conversation is about a NEW dish that starts
// from an existing one. It sits between the other two closings and needs both
// halves of them — carry the base forward like edit mode, because a chat that
// only says "prawns instead of chorizo" would otherwise author a recipe made of
// prawns and nothing else; but author it as a new dish like create mode, with
// its own name, rather than returning the original under the original's title.
function variationModeSection(baseRecipe: string): string {
  return `## Writing a variation on an existing recipe
The user is creating a NEW recipe that starts from the one below. The original will NOT be \
changed and must not be described as changed. The conversation says how the new dish differs \
from it.

Build the new recipe on the original: start from its full content and apply the changes \
discussed in the conversation, along with everything those changes imply — an ingredient that \
replaces another usually brings its own quantities, its own place in the method and its own \
timings with it. Keep every ingredient, step, time, serving count and detail the conversation \
does not change, keeping the original wording (rawText) of unchanged ingredients verbatim. Do \
not drop anything that was not discussed.

Give it a title of its own that says what the dish actually IS now. Do NOT reuse the original's \
title, and do not append the word "variation" — a prawn version of a chorizo pilaf is a prawn \
pilaf, not "Chorizo Pilaf variation". Write the description for the new dish too.

### The recipe it starts from
${baseRecipe}`;
}

// Reads and validates the existing recipe for edit mode. Returns null on a
// missing/corrupt doc or any failure, so edit mode degrades to create mode
// rather than throwing.
async function readBaseRecipe(
  db: ReturnType<typeof getFirestore>,
  recipeId: string,
): Promise<RecipeDoc | null> {
  try {
    const snap = await db.collection('recipes').doc(recipeId).get();
    if (!snap.exists) return null;
    const result = RecipeSchema.safeParse(snap.data());
    if (!result.success) {
      logger.warn('authorRecipe: base recipe failed validation', { recipeId });
      return null;
    }
    return result.data;
  } catch (err) {
    logger.warn('authorRecipe: failed to read base recipe', { recipeId, err });
    return null;
  }
}
