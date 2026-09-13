// Journey 2 — recipe create → canonicalise → shopping-list rollup (issue #722).
//
// The highest-value chain in the app, and the one the Playwright suite cannot
// cover: under `FUNCTIONS_AI_FAKE` the canon pipeline is stubbed, so e2e proves
// only that the wiring exists. Here it runs against real Gemini.
//
// Two deliberate cost/blast-radius choices:
//
//   * The recipe is created with `image` already set. `onRecipeWritten` skips
//     hero generation whenever `image !== null`, so this journey never pays for
//     an image it does not assert on. Recipe image generation is out of scope
//     for issue #722's six journeys.
//   * Ingredient names are *derived* from canon items that already exist, so
//     the expected outcome is "matched", not "created" — a probe must not
//     accrete new canon entries into a prod-restored environment on every run.
//     If the pipeline creates one anyway that is a genuine finding: it is
//     reported as a warning and the stray item is removed.

import { CanonItemSchema, ShoppingListItemSchema } from '@salt/domain/schemas';

import { callCallable } from '../harness/callable.js';
import { writeAsUser } from '../harness/firestore.js';
import type { Journey } from '../harness/journey.js';
import { assert } from '../harness/runner.js';

import { deriveCanonSeeds } from './deriveCanonSeeds.js';

/** Enough to exercise the batch path without a long AI bill. */
const INGREDIENT_COUNT = 3;

/** The trigger chain makes up to three sequential AI calls (~120s worst case). */
const MATCH_TIMEOUT_MS = 180_000;

export const recipeCanonShopping: Journey = {
  name: 'recipe-canon-shopping',
  description: 'Recipe create → canonicalise ingredients → shopping-list rollup settles.',
  domain: 'shopping',

  async run(ctx) {
    const seeds = await ctx.step('derive ingredient names from existing canon', () =>
      deriveCanonSeeds(ctx, INGREDIENT_COUNT),
    );

    // ---- Recipe create ----------------------------------------------------

    const recipeId = ctx.id('recipe');
    const now = new Date().toISOString();
    ctx.track('recipes', recipeId);

    await ctx.step('the probe may create a recipe', async () => {
      const result = await writeAsUser(ctx.env, ctx.identity, `recipes/${recipeId}`, {
        id: recipeId,
        schemaVersion: 1,
        kind: 'recipe',
        title: `Probe run ${ctx.runId}`,
        description: null,
        ingredients: [
          {
            id: `${recipeId}-group`,
            name: null,
            items: seeds.map((seed, index) => ({
              id: `${recipeId}-ing-${index}`,
              rawText: seed.name,
              parsed: null,
              canonId: null,
              matchState: 'pending',
              isOptional: false,
              firstUsedInStepId: null,
            })),
          },
        ],
        steps: [{ id: `${recipeId}-step-1`, text: 'Probe step.', timer: null, note: null }],
        metadata: {
          servings: 2,
          tags: [],
        },
        source: null,
        notes: null,
        // Non-null so `onRecipeWritten` skips hero-image generation — see the
        // header note. Not an assertion target.
        image: { url: `https://example.invalid/probe/${ctx.runId}.webp`, source: 'upload' },
        createdAt: now,
        updatedAt: now,
      });
      assert(result.errorStatus === null, `recipe create refused: ${result.errorStatus ?? ''}`);
    });

    // ---- Canonicalisation -------------------------------------------------

    await ctx.step('canonicaliseRecipeIngredients resolves every ingredient', async () => {
      const response = await callCallable(ctx.env, ctx.identity, 'canonicaliseRecipeIngredients', {
        items: seeds.map((seed) => ({ rawName: seed.name })),
      });

      assert(
        response.errorStatus === null,
        `callable failed: HTTP ${response.httpStatus} ${response.errorStatus ?? ''} ${response.errorMessage ?? ''}`,
      );
      assert(Array.isArray(response.result), 'expected an array of per-item results');

      const results = response.result as unknown[];
      assert(
        results.length === seeds.length,
        `expected one result per ingredient (${seeds.length}), got ${results.length}`,
      );

      results.forEach((entry, index) => {
        const seed = seeds[index];
        const record = entry as { kind?: unknown; value?: unknown };
        assert(
          record.kind === 'ok' || record.kind === 'err',
          `result ${index} has neither an ok nor an err kind`,
        );

        if (record.kind === 'err') {
          // A per-item failure is structural, not prose — hard-fail it.
          assert(false, `ingredient "${seed?.name ?? index}" failed to canonicalise`);
          return;
        }

        const value = record.value as { decision?: unknown; item?: unknown };
        assert(
          value.decision === 'created' ||
            value.decision === 'matched' ||
            value.decision === 'ai_arbitrated',
          `ingredient "${seed?.name ?? index}" returned an unknown decision ${String(value.decision)}`,
        );

        // The wire type is `z.any()`, so this is the assertion that keeps the
        // callable honest about what it actually returns.
        const parsed = CanonItemSchema.safeParse(value.item);
        assert(
          parsed.success,
          `ingredient "${seed?.name ?? index}" returned an item the live CanonItemSchema rejects: ${
            parsed.success ? '' : parsed.error.message
          }`,
        );

        if (value.decision === 'created' && parsed.success) {
          // Derived from an existing canon name, so a create means the matcher
          // missed. Not a hard failure (thresholds are tuned, not contractual),
          // but it must not be left behind.
          ctx.warn(
            `canonicalising "${seed?.name ?? index}" CREATED canon item ${parsed.data.id} instead of matching the existing one`,
          );
          ctx.trackCreated('canonItems', parsed.data.id, 'created by canonicalise during this run');
        }
      });
    });

    // ---- Shopping-list rollup ---------------------------------------------
    //
    // A run-scoped list of its own, never the household's default list: the
    // probe must not appear in anyone's actual shopping.

    const listId = ctx.id('list');
    const itemId = ctx.id('item');
    const seed = seeds[0];
    assert(seed !== undefined, 'no canon seed available for the rollup');

    ctx.track('shoppingLists', listId);
    ctx.cleanup(`delete shoppingLists/${listId}/items/${itemId}`, async () => {
      await ctx.admin.firestore
        .collection('shoppingLists')
        .doc(listId)
        .collection('items')
        .doc(itemId)
        .delete();
    });

    await ctx.step('the probe may create its own shopping list', async () => {
      const result = await writeAsUser(ctx.env, ctx.identity, `shoppingLists/${listId}`, {
        id: listId,
        name: `Probe ${ctx.runId}`,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      });
      assert(result.errorStatus === null, `list create refused: ${result.errorStatus ?? ''}`);
    });

    await ctx.step('adding an item leaves it pending for the trigger', async () => {
      const result = await writeAsUser(
        ctx.env,
        ctx.identity,
        `shoppingLists/${listId}/items/${itemId}`,
        {
          id: itemId,
          rawText: seed.name,
          notes: '',
          sources: [{ kind: 'manual', addedBy: 'probe' }],
          canonId: null,
          matchState: 'pending',
          checked: false,
          needsCheck: false,
          schemaVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
      );
      assert(result.errorStatus === null, `item create refused: ${result.errorStatus ?? ''}`);
    });

    // Layer 2 — poll for the trigger's effect, never a fixed sleep.
    const settled = await ctx.settle(
      'onShoppingListItemWrite settles the item off pending',
      async () => {
        const snapshot = await ctx.admin.firestore
          .collection('shoppingLists')
          .doc(listId)
          .collection('items')
          .doc(itemId)
          .get();
        const data = snapshot.data();
        if (data === undefined) return null;
        return data['matchState'] === 'pending' ? null : data;
      },
      { timeoutMs: MATCH_TIMEOUT_MS },
    );

    await ctx.step('the settled item is a valid, resolved shopping-list item', async () => {
      const parsed = ShoppingListItemSchema.safeParse(settled);
      assert(
        parsed.success,
        `settled item fails ShoppingListItemSchema: ${parsed.success ? '' : parsed.error.message}`,
      );
      if (!parsed.success) return;

      const { matchState, canonId } = parsed.data;
      assert(
        matchState === 'matched' || matchState === 'needs_approval',
        `expected an item derived from an existing canon name to match, got ${matchState}`,
      );
      assert(canonId !== null, `matchState is ${matchState} but no canonId was written`);

      if (canonId !== seed.id) {
        // Legitimate: several canon entries can share a name or a synonym. The
        // structural invariant is "resolved to something", not "to this one".
        ctx.warn(
          `"${seed.name}" resolved to canon ${canonId}, not the ${seed.id} it was derived from`,
        );
      }
    });
  },
};
