import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import {
  KitchenToolSchema,
  KITCHEN_TOOLS_COLLECTION,
  type KitchenToolDoc,
} from '@salt/domain/schemas';
import { generateKitchenToolIconFlow } from '../flows/generateKitchenToolIcon.js';
import { iconWriteTrigger } from './iconWriteTrigger.js';

// Kitchen-tool pictogram generation (issue #882).
//
// The SAME Tier-1 pictogram pipeline as canon items (issue #148,
// docs/canon-icons.md) and product forms (#871), pointed at a fourth collection:
// same seed image, same locked `STYLE`, same background removal and framing
// normalisation, same tri-state `thumbnail`, same kill switch. Only the prompt
// differs, and only in the two ways a hand tool needs it to (see
// kitchenToolIconPrompt.ts) — which is why this family has its OWN flow where
// product forms reuse canon's.
//
// ONE branch, not two. `onCanonItemWritten` carries an embedding branch beside
// its icon branch; there is no equivalent here, because `resolveKitchenTool`
// matches on label/matcher TEXT and never on a vector — so there is nothing to
// embed. The vocabulary is closed by choice: a name that matches nothing gets no
// picture, and that is the whole cost of a miss.
//
// No `traceContext` plumbing either: `KitchenToolSchema` carries no such field,
// and a tool is written by the seeding script or by an admin curating the list,
// never at the end of a browser-rooted trace. This trigger roots its own.
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const posthogApiKey = defineSecret('POSTHOG_API_KEY');

// Mirrors canon's `canon-icons` and forms' `product-form-icons`. A distinct
// prefix (rather than sharing one) is what lets the weekly orphan sweep join each
// prefix against its OWN collection — see the SWEEPS table in
// maintenance/storageSweepTargets.ts, which this prefix is registered in.
const ICON_STORAGE_PREFIX = 'kit-icons';

export const onKitchenToolWritten = onDocumentWritten(
  {
    document: `${KITCHEN_TOOLS_COLLECTION}/{id}`,
    region: 'europe-west2',
    secrets: [geminiApiKey, posthogApiKey],
    // Image generation (~5–8s+) plus sharp processing need more headroom than
    // the default text-only triggers.
    timeoutSeconds: 300,
    // Same reasoning as onCanonItemWritten: each icon decode holds a
    // libvips/sharp image buffer, and seeding the vocabulary fires this trigger
    // dozens of times in quick succession. concurrency:1 serialises icon work per
    // instance (Cloud Run scales out instead), bounding memory regardless of how
    // many tools land at once; 1GiB gives the single decode room. Pinned inline —
    // this module loads before index.ts's setGlobalOptions, same reason region is.
    concurrency: 1,
    memory: '1GiB',
  },
  iconWriteTrigger<KitchenToolDoc>({
    name: 'onKitchenToolWritten',
    collection: KITCHEN_TOOLS_COLLECTION,
    enrichment: 'kitchenToolIcon',
    storagePrefix: ICON_STORAGE_PREFIX,
    schema: KitchenToolSchema,
    // The tool's LABEL is what the picture is of — "Mixing bowl", "Balloon
    // whisk". The matchers are alternative phrasings a cook might type, never
    // subjects: a prompt naming all of them would ask for several tools in one
    // frame.
    subjectOf: (tool) => tool.label,
    draw: (label, hint) => generateKitchenToolIconFlow({ label, ...(hint ? { hint } : {}) }),
  }),
);
