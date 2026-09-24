import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { ProductFormSchema, type ProductFormDoc } from '@salt/domain/schemas';
import { generateCanonIconFlow } from '../flows/generateCanonIcon.js';
import { iconWriteTrigger } from './iconWriteTrigger.js';

// Product-form pictogram generation (issue #871).
//
// The SAME Tier-1 pictogram pipeline as canon items (issue #148,
// docs/canon-icons.md), pointed at a second collection — and since #989 that is
// literally true rather than a resemblance: the whole body is the descriptor
// below, over `triggers/iconWriteTrigger.ts`. A form gets its own icon rather
// than borrowing its parent's because a form exists precisely when the thing you
// buy looks different from the parent — lime juice is not a lime.
//
// It draws through the CANON flow, not one of its own: a form IS a grocery, so
// the grocery prompt (UK-supermarket steer included) is the right one. This is
// why the pipeline's descriptor names a `draw` closure rather than a family's
// "own" flow — three flows serve four families.
//
// ONE branch, not two. `onCanonItemWritten` carries an embedding branch beside
// its icon branch; there is no equivalent here, because `resolveProductForm`
// matches on label/matcher TEXT, not on a vector — so there is nothing to embed,
// and no `alongside` in the descriptor.
//
// No `traceContext` plumbing either: `ProductFormSchema` carries no such field,
// and forms are written by an admin editing the catalog rather than at the end
// of a browser-rooted shopping-list trace. This trigger roots its own trace.
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

// Mirrors canon's `canon-icons`. A distinct prefix (rather than sharing one) is
// what lets the weekly orphan sweep join each prefix against its OWN collection
// — see the SWEEPS table in maintenance/storageSweepTargets.ts, which this
// prefix is registered in.
const ICON_STORAGE_PREFIX = 'product-form-icons';

export const onProductFormWritten = onDocumentWritten(
  {
    document: 'productForms/{id}',
    region: 'europe-west2',
    secrets: [geminiApiKey, posthogApiKey],
    // Image generation (~5–8s+) plus sharp processing need more headroom than
    // the default text-only triggers.
    timeoutSeconds: 300,
    // Same reasoning as onCanonItemWritten: each icon decode holds a
    // libvips/sharp image buffer, and a batch of AI-seeded form proposals fires
    // this trigger many times at once. concurrency:1 serialises icon work per
    // instance (Cloud Run scales out instead), bounding memory regardless of
    // batch size; 1GiB gives the single decode room. Pinned inline — this module
    // loads before index.ts's setGlobalOptions, same reason region is inline.
    concurrency: 1,
    memory: '1GiB',
  },
  iconWriteTrigger<ProductFormDoc>({
    name: 'onProductFormWritten',
    collection: 'productForms',
    enrichment: 'productFormIcon',
    storagePrefix: ICON_STORAGE_PREFIX,
    schema: ProductFormSchema,
    // The form's LABEL is what the picture is of — "lime juice", "egg yolk". It
    // is already the human-facing name of the thing bought, so it needs no
    // decoration with the parent's name.
    subjectOf: (form) => form.label,
    draw: (name, hint) => generateCanonIconFlow({ name, ...(hint ? { hint } : {}) }),
  }),
);
