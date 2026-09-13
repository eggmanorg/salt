// Journey 7 — importing a recipe from a photograph of a page (issue #1356).
//
// Covers `extractRecipeFromPhoto` end to end: the attested callable with a real
// image payload, real multimodal Gemini, the server-side persist into
// `recipes/{serverId}`, and the hero-image trigger that fires behind it. Under
// `FUNCTIONS_AI_FAKE` the e2e suite stubs the extraction entirely, so nothing
// anywhere else proves that a photograph of a page becomes a recipe.
//
// OPT-IN, for one reason: every import path lands the recipe with `image: null`,
// and `onRecipeWritten` generates a hero on create with a null image. There is
// no per-document opt-out and the only switch is the per-environment
// `devSettings/singleton.recipeImageGenerationEnabled`, which does not exist in
// staging — so an import costs one generated image, every time. Adding a
// suppression field to product code to make a probe cheaper would be the tail
// wagging the dog.
//
// Three choices worth stating:
//
//   * The fixture is a page WE WROTE (`assets/recipe-page.html` renders
//     `assets/recipe-page.webp`), not a photograph of a published cookbook. The
//     repo can hold it without any question about whose words they are, and the
//     `.html` beside it is what makes that checkable rather than asserted.
//   * The recipe id is chosen by the SERVER (`persistImportedRecipe`), so the
//     `probe-` prefix cannot apply and `ctx.track` would refuse it. Teardown
//     goes through `ctx.trackCreated` with a reason, which puts the deletion in
//     `report.adoptedDocs` — audited rather than silent. The hero object is
//     named after that same id, so it needs the same treatment: that is what
//     `ctx.trackCreatedStorageObject` is for, added here rather than by
//     loosening the `probe-` guard that refused it.
//   * The journey WAITS for the hero image before finishing. Not for the
//     assertion's sake: the trigger writes a Storage object and a doc field
//     minutes after the import returns, so tearing down early would leak the
//     object and write to a document that no longer exists.
//
// Never assert on the extracted prose (runbook rule 3). That a page about leeks
// produces a recipe whose title says "leeks" is a `ctx.warn()`, because a model
// wording it differently is variance, not a regression. What is asserted is
// structure: it parses as a recipe, it has a title, it has ingredients, it has
// steps.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RecipeSchema } from '@salt/domain/schemas';

import { callCallable } from '../harness/callable.js';
import type { Journey } from '../harness/journey.js';
import { assert } from '../harness/runner.js';

/** The fixture page, and the content type the capture UI actually produces. */
const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/recipe-page.webp');
const FIXTURE_CONTENT_TYPE = 'image/webp';

/** Where `onRecipeWritten` uploads the hero it generates. */
const IMAGE_STORAGE_PREFIX = 'recipe-images';

/**
 * Image generation is the slowest thing in the app, and the hero is a photoreal
 * render rather than a pictogram. Generous on purpose: the wait is what keeps
 * teardown honest, so a deadline shorter than the work leaks the object it was
 * supposed to remove.
 */
const HERO_TIMEOUT_MS = 300_000;

/**
 * A well-formed W3C `traceparent`, minted the way the browser's OTel tracer
 * does, so the import runs under one trace rather than re-rooting server-side.
 * The field is optional on the wire; supplying it is what exercises the path.
 */
function newTraceparent(): string {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

export const recipeImport: Journey = {
  name: 'recipe-import',
  description: 'A photographed cookbook page becomes a persisted, structurally sound recipe.',
  domain: 'recipes',
  optIn: 'the imported recipe triggers a real hero-image generation (real cost)',

  async run(ctx) {
    const page = await ctx.step('the fixture page image loads', async () => {
      const bytes = readFileSync(FIXTURE_PATH);
      assert(bytes.byteLength > 0, `fixture at ${FIXTURE_PATH} is empty`);
      return bytes.toString('base64');
    });

    // ---- The callable ------------------------------------------------------

    const recipe = await ctx.step('extractRecipeFromPhoto reads the page', async () => {
      const response = await callCallable(ctx.env, ctx.identity, 'extractRecipeFromPhoto', {
        images: [{ base64: page, contentType: FIXTURE_CONTENT_TYPE }],
        traceparent: newTraceparent(),
      });

      assert(
        response.errorStatus === null,
        `callable failed: HTTP ${response.httpStatus} ${response.errorStatus ?? ''} ${response.errorMessage ?? ''}`,
      );

      const parsed = RecipeSchema.safeParse(response.result);
      assert(
        parsed.success,
        `returned payload fails the live RecipeSchema: ${parsed.success ? '' : parsed.error.message}`,
      );
      return parsed.data;
    });

    // The server chose the id, so the `probe-` guard cannot apply — the deletion
    // is audited instead, and registered before anything can fail after it.
    ctx.trackCreated('recipes', recipe.id, 'created server-side by extractRecipeFromPhoto');
    ctx.trackCreatedStorageObject(
      `${IMAGE_STORAGE_PREFIX}/${recipe.id}.webp`,
      'hero written by onRecipeWritten for the imported recipe',
    );

    // ---- Structure, never prose -------------------------------------------

    await ctx.step('the extracted recipe is structurally sound', async () => {
      assert(recipe.title.trim() !== '', 'the extracted recipe has an empty title');

      const groups = recipe.ingredients.filter((group) => group.items.length > 0);
      assert(
        groups.length > 0,
        `expected at least one ingredient group with items, got ${recipe.ingredients.length} group(s), none populated`,
      );

      assert(recipe.steps.length > 0, 'the extracted recipe has no steps');
      assert(
        recipe.steps.every((step) => step.text.trim() !== ''),
        'the extracted recipe has an empty step',
      );

      // Semantic judgements — recorded, never fatal.
      if (!recipe.title.toLowerCase().includes('leek')) {
        ctx.warn(`extraction titled the page "${recipe.title}", which does not mention leeks`);
      }
      if (recipe.source?.type !== 'book') {
        ctx.warn(`expected source.type "book", got ${String(recipe.source?.type)}`);
      }
      if (recipe.source?.book === undefined) {
        ctx.warn('no book provenance was read off the page (running head, author, page number)');
      }
      return Promise.resolve();
    });

    // ---- The server-side persist ------------------------------------------

    await ctx.step('the import persists itself to recipes/{id}', async () => {
      const snapshot = await ctx.admin.firestore.collection('recipes').doc(recipe.id).get();
      assert(snapshot.exists, `extractRecipeFromPhoto returned ${recipe.id} but wrote no document`);

      const parsed = RecipeSchema.safeParse(snapshot.data());
      assert(
        parsed.success,
        `the persisted document fails the live RecipeSchema: ${parsed.success ? '' : parsed.error.message}`,
      );
      // Deliberately no assertion on `image` here. The import lands it null and
      // that is what arms the hero trigger, but the trigger may already have
      // filled it in by the time this read happens — asserting either value
      // would be asserting on a race. The settle below is where the hero is
      // proved.
    });

    // ---- The hero the import costs ----------------------------------------

    await ctx.settle(
      'onRecipeWritten generates and stores a hero image',
      async () => {
        const snapshot = await ctx.admin.firestore.collection('recipes').doc(recipe.id).get();
        const image = snapshot.get('image') as { url?: unknown; source?: unknown } | null;
        if (image === null || image === undefined) return null;
        assert(typeof image.url === 'string' && image.url.startsWith('http'), 'hero has no URL');
        assert(image.source === 'ai', `expected an ai-sourced hero, got ${String(image.source)}`);
        return image.url;
      },
      { timeoutMs: HERO_TIMEOUT_MS },
    );
  },
};
