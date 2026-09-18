import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';
import {
  CanonItemSchema,
  EquipmentIconSchema,
  EquipmentManifestSchema,
  EQUIPMENT_ICONS_COLLECTION,
  EQUIPMENT_MANIFEST_COLLECTION,
  EQUIPMENT_MANIFEST_DOC_ID,
  GetImagePromptInputSchema,
  KitchenToolSchema,
  KITCHEN_TOOLS_COLLECTION,
  ProductFormSchema,
  RecipeSchema,
  type GetImagePromptResult,
  type ImagePromptFamily,
} from '@salt/domain/schemas';
import { equipmentEntrySubjectName } from '@salt/domain';
import { makeCallable } from '../tracedCallable.js';
import { resolveModel } from '../ai/resolveModel.js';
import { CANON_ICON_SEED_FILE } from '../flows/assets/canonIconSeed.js';
import { buildIconPrompt } from '../flows/generateCanonIcon.js';
import { buildKitchenToolIconPrompt } from '../flows/kitchenToolIconPrompt.js';
import { buildEquipmentIconPrompt } from '../flows/equipmentIconPrompt.js';
import { buildRecipePrompt } from '../flows/generateRecipeImage.js';
import { reportFlowError } from '../observability/reportServerError.js';

// The prompt behind any generated picture (issue #892, Phase 1).
//
// ─── It CALLS the builders; it never restates them ──────────────────────────
// Every arm below loads a document and hands it to the SAME function the
// generator hands it to. Nothing in this file spells a word of house style, a UK
// steer, a prohibition or an anchor. That is the whole design constraint:
// docs/canon-icons.md → "Proven prompt (verbatim — reproduce exactly)" warns that
// paraphrase drifts the style, and flows/placeholderVocabulary.ts exists because
// two prompts that each said the same thing drifted apart once already. A
// read-only viewer that kept its own copy would be that failure a third time,
// and a silent one — the picture would keep changing while the window swore it
// had not.
//
// ─── Re-derived, not recorded ───────────────────────────────────────────────
// Nothing is persisted at generation time and no schema moves. Every family's
// prompt is a pure function of code constants plus fields already on the
// document, so it can be rebuilt on demand — which also means it works
// retroactively for every picture drawn before this shipped. For an old image
// what comes back is "the prompt that would be sent now" rather than the literal
// bytes that produced it; prompt changes here are code changes shipped by PR, and
// the dialog labels it as such rather than pretending otherwise.
//
// The one-shot `iconHint` is deliberately NOT reinstated — it is deleted after
// use so that a plain regenerate is plain (callables/requestIconRegeneration.ts),
// and resurrecting it here to make re-derivation byte-exact would reverse that
// decision as a side effect of a read-only feature.
//
// ─── NOT an AI call ─────────────────────────────────────────────────────────
// It assembles a string and reads a model id. So there is no GEMINI_API_KEY
// binding, no withAiTimeout and no AI-OTLP export in this process — the secret
// posture of callables/setObservationImageUpload.ts, for the same reason: only
// posthog, so an unexpected Firestore read failure can still be reported.
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

/** Not found, in the one shape every arm needs. */
function missing(what: string): HttpsError {
  return new HttpsError('not-found', what);
}

async function loadDoc(collection: string, id: string): Promise<unknown> {
  const snap = await getFirestore().collection(collection).doc(id).get();
  if (!snap.exists) return undefined;
  return snap.data();
}

/**
 * Builds one family's prompt from its document, plus the model and seed that go
 * with it.
 *
 * The `seedFile` split is the real difference between the families, not a detail:
 * the four pictogram families are reference-conditioned off the committed
 * red-apple seed (flows/assets/canonIconSeed.ts), while a recipe hero is
 * prompt-only by design (generateRecipeImage.ts — Tier 1 and Tier 2 deliberately
 * do not share a look), so its seed is honestly `null` rather than an empty
 * string standing in for one.
 */
async function buildFor(family: ImagePromptFamily, id: string): Promise<GetImagePromptResult> {
  switch (family) {
    case 'canon': {
      const parsed = CanonItemSchema.safeParse(await loadDoc('canonItems', id));
      if (!parsed.success) throw missing('No such canon item.');
      return {
        prompt: buildIconPrompt(parsed.data.name.trim()),
        model: await resolveModel('generateCanonIcon'),
        seedFile: CANON_ICON_SEED_FILE,
      };
    }
    case 'productForm': {
      const parsed = ProductFormSchema.safeParse(await loadDoc('productForms', id));
      if (!parsed.success) throw missing('No such product form.');
      // A form's LABEL is the subject, exactly as onProductFormWritten uses it —
      // the form reuses the grocery prompt unchanged, because a form IS a grocery.
      return {
        prompt: buildIconPrompt(parsed.data.label.trim()),
        model: await resolveModel('generateCanonIcon'),
        seedFile: CANON_ICON_SEED_FILE,
      };
    }
    case 'kitchenTool': {
      const parsed = KitchenToolSchema.safeParse(await loadDoc(KITCHEN_TOOLS_COLLECTION, id));
      if (!parsed.success) throw missing('No such kitchen tool.');
      return {
        prompt: buildKitchenToolIconPrompt(parsed.data.label.trim()),
        model: await resolveModel('generateKitchenToolIcon'),
        seedFile: CANON_ICON_SEED_FILE,
      };
    }
    case 'equipment': {
      // TWO documents, because equipment keeps its picture in a sibling
      // collection (equipmentIcon.ts explains why). The icon doc holds the brief
      // that IS the subject; the manifest holds the name that stands in when
      // there is no brief yet. Reading the manifest only on that fallback keeps
      // the normal path to one read.
      const icon = EquipmentIconSchema.safeParse(await loadDoc(EQUIPMENT_ICONS_COLLECTION, id));
      if (icon.success) {
        return {
          prompt: buildEquipmentIconPrompt(icon.data.briefSourceName, icon.data.subjectBrief),
          model: await resolveModel('generateEquipmentIcon'),
          seedFile: CANON_ICON_SEED_FILE,
        };
      }
      // No brief authored yet — the degraded arm the builder already has, which
      // is genuinely what would be drawn if someone pressed Draw this second.
      //
      // The id may name an ITEM or one of its ENTRIES (issue #1465, Phase 2):
      // `equipmentIcons` is keyed by either, so this fallback has to answer for
      // either. An entry's subject is `equipmentEntrySubjectName`'s — the same
      // words `authorEntryIconBrief` would author from — so the degraded prompt
      // stays what would genuinely be drawn rather than a different one.
      const manifest = EquipmentManifestSchema.safeParse(
        await loadDoc(EQUIPMENT_MANIFEST_COLLECTION, EQUIPMENT_MANIFEST_DOC_ID),
      );
      const items = manifest.success ? manifest.data.items : [];
      const item = items.find((i) => i.id === id);
      if (!item) {
        const parent = items.find((i) => i.accessories.some((a) => a.id === id));
        const accessory = parent?.accessories.find((a) => a.id === id);
        if (!parent || !accessory) throw missing('No such equipment item.');
        return {
          prompt: buildEquipmentIconPrompt(equipmentEntrySubjectName(parent, accessory)),
          model: await resolveModel('generateEquipmentIcon'),
          seedFile: CANON_ICON_SEED_FILE,
        };
      }
      return {
        prompt: buildEquipmentIconPrompt(item.name.trim()),
        model: await resolveModel('generateEquipmentIcon'),
        seedFile: CANON_ICON_SEED_FILE,
      };
    }
    case 'recipe': {
      const parsed = RecipeSchema.safeParse(await loadDoc('recipes', id));
      if (!parsed.success) throw missing('No such recipe.');
      const recipe = parsed.data;
      // The trigger's own argument list, minus the hint (see the header) and
      // minus the author-a-brief-on-the-fly step: that step is an AI call, and a
      // recipe with no stored brief genuinely renders through the "read the dish
      // yourself" fallback if it is drawn before one is written.
      return {
        prompt: buildRecipePrompt(
          recipe.title.trim(),
          recipe.description,
          undefined,
          recipe.metadata.tags,
          recipe.imageBrief?.trim() || undefined,
          recipe.kind,
        ),
        model: await resolveModel('generateRecipeImage'),
        seedFile: null,
      };
    }
  }
}

// region and memory are pinned INLINE, as every function in this app must be
// (issue #883): this module is imported at the top of index.ts, so its onCall is
// built before setGlobalOptions runs and would otherwise silently fall to the
// 256MiB platform default — under the module-init baseline of firebase-admin +
// Genkit + OTel + posthog-node. 512MiB is the floor, not an override: this
// callable reads a document and joins strings, and never touches sharp, so it
// needs none of the 1GiB headroom the imaging paths pin.
export const getImagePrompt = makeCallable({
  options: {
    region: 'europe-west2',
    secrets: [posthogApiKey],
    memory: '512MiB',
  },
  handler: async (request) => {
    const parsed = GetImagePromptInputSchema.safeParse(request.data);
    if (!parsed.success) {
      throw new HttpsError('invalid-argument', 'Invalid request payload.');
    }
    return await buildFor(parsed.data.family, parsed.data.id);
  },
});
