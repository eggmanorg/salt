# Canon item icons (Tier-1 pictograms)

Status: **implemented** ([#148](https://github.com/eggmanorg/salt/issues/148)) · Owner decisions baked in below.

**Two collections, one pipeline** ([#871](https://github.com/eggmanorg/salt/issues/871)).
Everything below describes canon items, and every word of it applies unchanged to
**product forms** — the same seed image, the same verbatim prompt, the same
background removal and framing, the same tri-state `thumbnail`, the same
`canonIconGenerationEnabled` kill switch. Only three things differ, and they are
the three that have to: the trigger is `onProductFormWritten` on
`productForms/{id}`, the Storage prefix is `product-form-icons/`, and the subject
is the form's `label` rather than the item's `name`. A form is drawn separately
from its parent because a form exists precisely when the thing you buy looks
different from the parent — lime juice is not a lime. Read every "canon item"
below as "canon item or product form" unless a line says otherwise.

## What this is

Every canon item gets a small, warm, "quick-sketch" cartoon icon, displayed on a
pale **cool-grey rounded tile** wherever canon items are listed (shopping list now;
recipe ingredient lists and canon views as they land). The icon is generated once,
server-side, when the canon item is created, and cached in Firebase Storage.

This is **Tier 1** of a deliberate two-tier image system (see below). It is _not_
the recipe imagery feature.

## Two-tier image system (important context)

| Tier              | What                            | Where                                | Style                           | Generation                                      |
| ----------------- | ------------------------------- | ------------------------------------ | ------------------------------- | ----------------------------------------------- |
| **1 — pictogram** | canon-item icon                 | dense lists, ~30px                   | flat warm line-art, transparent | this feature                                    |
| **2 — hero**      | photo of a `recipes/{id}` entry | recipe/planner cards + detail, large | photorealistic                  | **separate issue** (shipped: `onRecipeWritten`) |

They do not clash because they never share size or context. The recipe feature must
**not** try to "match" the icon style — different tier, different job. Tier 2 reuses
the same Storage + `thumbnail`-style conventions but is out of scope here.

**Tier 1 now has four subject families.** Groceries (this document's original
subject), the 17 weather pictograms (#387, an offline one-off — the planner renders
committed static assets, nothing generates at request time), **equipment** (#877),
and **kitchen tools** (#882). All four share ONE house style, because all four
import the same locked `STYLE` constant from `generateCanonIcon.ts` verbatim rather
than copying its wording. What each family adds is its own subject wording and its
own prohibitions, never an edit to `STYLE`:

| Family       | Prompt module              | Relationship to `STYLE`                                                                                                                        |
| ------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| grocery      | `generateCanonIcon.ts`     | owns it; adds the UK-supermarket steer                                                                                                         |
| weather      | `weatherIconPrompt.ts`     | removes ONE clause (`A single centered subject…`) — a weather pictogram is a composite scene                                                   |
| equipment    | `equipmentIconPrompt.ts`   | keeps it WHOLE (an appliance _is_ a single centred subject) and **adds** a no-lettering-on-the-object clause                                   |
| kitchen tool | `kitchenToolIconPrompt.ts` | keeps it WHOLE, **omits** the UK-supermarket steer (a whisk is not a supermarket product), and **adds** a no-brand-lettering clause of its own |

That addition is worth knowing about before writing a fifth family. `STYLE`
bans lettering _added_ around the subject but explicitly permits text that is part
of the depicted item ("wording printed on a tin or jar") — which is exactly where a
brand wordmark on an appliance sits. Equipment closes that gap in its own anchors;
it does not rewrite `STYLE`, because groceries genuinely want the wording on the tin.

### The fourth family: generic kitchen tools (#882)

Tools are the family that works differently, and the difference is worth reading
before touching it.

**Nothing points at a tool.** There is no `toolId` on a recipe, a step or a guided
plan, and there never will be. A step says "tip it into a large bowl" and a plan's
prep card is called "Magmix bowl"; both store WORDS, and `resolveKitchenTool`
(`packages/domain/src/kitchenTool/`) finds the tool from those words every time the
row is drawn. Two consequences, both deliberate: adding a tool later is retroactive
and free — every plan that already says "griddle pan" gains a picture with nothing
migrated and nothing regenerated — and a name that matches nothing renders as words
with no picture, which is the correct and complete answer to a miss.

**Since #954 a kit label is asked of TWO vocabularies, equipment first.** A label
can now name a specific appliance this household owns — the kit flow is handed the
manifest and writes the item's own name — and those already have better pictures of
their own in `equipmentIcons`. `resolveEquipmentItem`
(`packages/domain/src/equipment/queries/`) is tried before `resolveKitchenTool`, and
the ORDER is load-bearing rather than a preference: the tool resolver matches on
token-aligned containment, so "Magimix Cocotte Slow Cook Pot" contains "pot" and
would otherwise resolve a specific appliance to a generic saucepan drawing. The two
resolvers also match differently, deliberately — containment is right for a closed
list of common nouns and wrong for product names, so `resolveEquipmentItem` requires
the item's leading (maker's) word plus a subset of its own words, and answers `null`
rather than guess when two owned items qualify. `apps/web-pwa/src/lib/kitIcons.ts` is
the one place the two are composed; do not write a second ordering into a page. The
admin queue (`unresolvedKitLabels`) excludes equipment matches for the same reason,
so nobody is invited to draw a `kitchenTools` cartoon of a Magimix.

**The vocabulary is CURATED and closed**, about forty tools, seeded by
`apps/cloud-functions/scripts/seed-kitchen-tools.mjs` (which holds the list). It is
deliberately NOT routed through the canon matching pipeline: no `findClosestMatch`,
no embeddings, no AI arbitration, no `needs_approval`. Canon needs all that because
an unmatched ingredient becomes an orphan document polluting a shared catalog; a
missed tool costs a missing picture and nothing else.

Everything else is the canon pipeline unchanged — the same seed image, the same
`STYLE`, the same background removal and `contentMax: 108` framing, the same
tri-state `thumbnail`, and the same `canonIconGenerationEnabled` kill switch (a
fourth flag would only be a fourth thing to remember to flip). What differs is what
has to: the trigger is `onKitchenToolWritten` on `kitchenTools/{id}`, the Storage
prefix is `kit-icons/`, and the subject is the tool's `label`.

The seeding script writes each document with its `thumbnail` ALREADY set. That is
load-bearing rather than incidental: the trigger's edge guard skips any document
whose thumbnail is non-null, so seeding never pays for the same drawing twice.

**Tier 2 is no longer only dishes.** The `recipes` collection also holds "Chef's Specials" and cocktails (#637) and placeholders (#652), so the hero pipeline
carries four art directions — a plated dish, a chef's special shown exactly as it
really turns up (handed over, eaten out, bought ready to eat, thrown together at
home — #671 — or cooked by heart in the household's own kitchen, #1322), a drink
in glassware, and an evening in which **nothing may be nameable** — selected by
the entry's `kind`. Tier 1 is unaffected: canon items
are groceries, one style, and nothing about a hero's art direction reaches down
here.

The placeholder direction is the odd one, and the reason is worth knowing before
touching it: the other three make a subject the star, and a placeholder must not
have one. Ten of them are attached to many different evenings each, so a
nameable dish is a picture of the wrong dinner. Two consequences follow, both
load-bearing. Its style anchors name **no subject** — they reference whatever the
per-document direction leads with, because anything concrete in a block that is
byte-identical across every placeholder becomes the whole brief and every picture
comes back the same. And what its tags mean lives in one shared module,
`apps/cloud-functions/src/flows/placeholderVocabulary.ts`, because both the image
prompt and the art director's prompt have to say it and they drifted apart the
one time they each said it themselves.

## House style (proven in prototype)

- Warm quick-sketch: thick rounded outline, soft limited pastel palette, single
  centred subject, **no faces**, no text/logos, plain background.
- **UK supermarket forms** (e.g. milk = 2 L plastic bottle, not a carton).
- Generated by **reference-conditioning**: a single committed seed image steers the
  style. Prompt-only drifts badly (random borders, text leakage, style wander) — do
  not use it. Negative-guide against copying the seed's _subject_ (only its style).

## Data model

`CanonItem.thumbnail` (`string | null`, already on the schema) is the single source
of truth. Tri-state:

- **`null`** — no valid icon yet (never generated, or last attempt failed). UI shows
  the bare tile; the creation trigger will (re)attempt generation.
- **`<https URL>`** — a valid icon; render it.
- **`"hidden"`** — user opted out. UI shows the bare tile; the trigger **skips** it
  and never regenerates.

Regenerate = set `null`. Hide = set `"hidden"`. Un-hide = set `null`. The `"hidden"`
sentinel is validated at the client read boundary (it's the one type-smell; chosen
over widening the schema, reversible pre-launch).

### Equipment departs from `thumbnail`-on-the-document (#877)

Everything else here writes the picture back onto the document the picture is OF —
`canonItems/{id}.thumbnail`, `recipes/{id}.image` — with a partial `.update()`, and
Firestore's field-level merge is what makes that safe. **Equipment has no such
document.** The whole kit is ONE doc, `equipmentManifest/current`, holding an
`items[]` array, and every mutator does a whole-document `setDoc` of the entire
array. A `thumbnail` on an array element would mean ticking one accessory's checkbox
could wipe the icons off every item, and the trigger re-firing on its own writes.

So equipment's icons live in a **sibling collection**, `equipmentIcons/{itemId}` —
the `canonEmbeddings` move (#410) and the `guidedPlans` move: when a field and its
host document have different owners and different read audiences, the field gets its
own collection. Two further consequences follow, and both are departures from the
canon shape rather than variations on it:

- **The trigger is LEVEL-triggered, not edge-triggered.** `onCanonItemWritten` needs
  `iconNeedsGeneration` precisely because it writes back to the document it watches.
  `onEquipmentManifestWritten` never writes the manifest, so it can just ask the
  honest question — does this item's brief match this item's name? — with no nonce.
- **A human reads the description before any image is generated.** The trigger
  authors an appliance description (`describeEquipmentSubject`, `'fast'` tier) and
  stops; the image is drawn only when someone presses **Draw**, by the
  `drawEquipmentIcon` callable, which runs the image flow and `sharp` inline. Canon's
  fully-automatic model is right for groceries — "a bag of frozen peas" has one
  obvious rendering — but a make and model is exactly where fidelity is won or lost,
  and a brief is a sentence you can correct where a wrong picture is only a re-roll.
  Only the description is ever shown or editable; the style anchors stay in code.

**The description may also be authored from a photograph (#947).** `describeEquipmentSubject`
gained a third mode alongside authoring-from-name and revising-from-a-correction:
**Use a photo** on the item page sends a reference photo of the actual appliance, and
the flow writes a fresh description from what the photo shows — "Start over, but
with a picture", discarding whatever was in the box exactly as Start over does. The
photo is REQUEST-SCOPED: it goes to Gemini as a media prompt part and is never
written anywhere — no Storage object, no Firestore field, no trace on the item —
only the sentence it produces persists, and only once **Draw** is pressed.

## Generation pipeline

Extends the **existing** `onCanonItemWritten` trigger (`apps/cloud-functions/src/index.ts`)
— do not add a rival trigger on `canonItems/{id}`. The trigger already generates the
embedding with its own idempotency guard; the icon is a **second, independently
guarded** side-effect:

```
canonItems/{id} written
  ├─ embedding branch  (existing)  guard: if embedding present → skip
  └─ icon branch       (new)       guard: if thumbnail != null → skip   (null && not "hidden" ⇒ generate)
```

Both guards independent; the function self-terminates once both fields are set. Every
`.update()` re-fires the trigger, so the guards are load-bearing against loops.

Icon branch steps:

1. `generateCanonIconFlow(canonName)` — Genkit flow, model `gemini-2.5-flash-image`,
   reference-conditioned off the committed seed, UK-steered, locked house-style
   prompt. Wrapped in **`withAiTimeout`** (image-gen ~5–8s; far slower than text).
2. **Background removal** (the model cannot emit alpha — it paints a checkerboard).
   `sharp`: flood-fill from the frame edges keyed on the flat fill colour (safe
   because the style keeps the subject centred, never touching the edge), then resize
   and encode.
3. **Framing normalisation** (`normalizeIconFraming`, `contentMax: 108`). The model
   centres its subject only loosely: measured across six production icons, the
   subject's longer side filled 55–72% of the 128px frame, with 18–41px asymmetric
   margins. Untreated, that means the art reads far smaller than its tile (a 55%-fill
   icon draws ~22px inside a 40px tile) and a column of icons rags between apparent
   sizes. This trims to the alpha bounding box, scales the longer side to
   `contentMax`, and re-pads dead-centre — **no regeneration, no restyling**; stroke
   weight and palette are intrinsic to the generated art and untouched.
   `contentMax: 108` (84% of the frame) is tuned for the ~40px row tile and is
   deliberately larger than the weather set's 92px default; it is not pushed higher
   because the match-reveal sage lift reads through the margin that remains
   (ui-spec-v04 §14.5.3). The 32px rung (§14.6.1) is this same framing drawn
   smaller — a rung is a display size, never a second framing, so no asset is
   reframed or regenerated when a call site moves between them. Shared, single implementation:
   `src/imaging/normalizeIconFraming.ts`, also used by the weather-icon tooling.
4. Upload to Storage `canon-icons/{canonId}.webp`; make public; write the public
   https URL to `thumbnail`.

**Icons generated before framing normalisation** keep their original loose framing —
re-framing is a display improvement, not a schema change, so nothing breaks. Bring
them up to date without regenerating via
`scripts/reframe-canon-icons.ts` (dry-run by default; bumps `iconRequestedAt` so
`CanonIcon`'s `version` cache-bust defeats the browser cache on the reused URL).

**Output format:** WebP with alpha, ~128px square (covers the 32px rung up to ~4×
DPR, and the 96px detail tile at ~1.3×; tiny file). **Seed + prompt:** committed in the `cloud-functions` package (versioned;
a style change is a code change + PR).

Runtime: region `europe-west2`; raise the function timeout/memory for the icon path
(`sharp` + image-gen). `GEMINI_API_KEY` secret already bound to this trigger.

## Storage

First use of Firebase Storage in the project. Adds a `storage` block to
`firebase.json` and a `storage.rules`. That file is the list of prefixes — it also
carries the non-pictogram `recipe-images/` and `batch-images/` blocks, which this doc
does not cover. The pictogram prefixes, and what is peculiar to each:

- `canon-icons/{file}` — **public read**, **no client write** (only the CF Admin SDK
  writes). Icons are non-sensitive, so public read keeps the client SDK-free: the
  browser just renders `<img src={thumbnail}>`, no Storage SDK in `firebase-sync`.
- `product-form-icons/{file}` — identical posture, written by `onProductFormWritten`
  (#871). A **separate prefix** rather than a shared one, because the weekly orphan
  sweep (`sweepOrphanedStorage`, #620) joins each prefix against its own owning
  collection — one prefix serving two collections could not tell a live object from
  a stranded one. Deploying the function without deploying `storage.rules` leaves
  every generated URL returning 403, which looks exactly like a generation failure.
- `equipment-icons/{file}` — same posture, added by #877. Written by the
  `drawEquipmentIcon` callable. Note the ordering trap: without this block the
  catch-all deny at the bottom of `storage.rules` makes every equipment icon
  unreadable, so the rules must be deployed before the pictograms will render.
  Storage objects are reclaimed by `sweepOrphanedStorage`, which only works because
  `onEquipmentManifestWritten` deletes the icon DOC when its item leaves the
  manifest — a left-behind doc would make the sweep conclude "not orphaned".
- `kit-icons/{file}` — same posture a fourth time, added by #882 for the curated
  `kitchenTools` vocabulary and written by `onKitchenToolWritten`, with the same
  deploy-ordering trap as the two above.

### Provisioning (one-time, per environment)

`firebase deploy` deploys `storage.rules` but does **not** create the project's
default Storage bucket — and it hard-fails ("Firebase Storage has not been set up")
if the bucket is missing. The default bucket is therefore provisioned once per
project, **outside** the deploy workflows. Both buckets are **`EUROPE-WEST2`**
(regional, matching the `europe-west2` Cloud Functions region that writes icons); the
location is permanent.

Provisioned via the Cloud Storage for Firebase API (singleton default-bucket create):

```sh
TOKEN=$(gcloud auth print-access-token)
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://firebasestorage.googleapis.com/v1beta/projects/<PROJECT>/defaultBucket" \
  -d '{"location":"EUROPE-WEST2"}'
```

Done for both: `s2-stage-ccb22.firebasestorage.app` and `s2-prod-e46bd.firebasestorage.app`.
(Equivalent to the Firebase Console Storage → "Get Started" flow.) The CF uses
`getStorage().bucket()` — the default bucket — so no bucket name is hardcoded.

## Rendering

A reusable **`<CanonIcon>`** in `@salt/ui-components`:

- transparent icon centred in a 40px tile, on no backdrop — the pictogram is the
  object, and the pale cool-grey square behind it only diluted it. The tile keeps a
  hairline footprint shadow (`salt-icon-lift`) so its square still reads against
  `bg-card`;
- bare tile placeholder — the pale cool-grey `hsl(180 8% 93%)`-family theme token, so
  it follows dark mode — when `thumbnail` is `null` or `"hidden"`. It stands in for
  art that hasn't generated yet and holds the text column straight down a
  part-matched list;
- a display treatment on the artwork (`salt-icon-art`): the generated palette is pale
  by design (measured mean saturation 0.11–0.50 against mean value 0.60–0.85), so
  `saturate`/`contrast` warm it without recolouring, and a drop-shadow separates the
  pictogram's dark outline from the surface. Display-only — no stored byte changes;
- lazy-loaded.

### `CanonIcon` props

**The ratified spec is [`docs/design/ui-spec-v04.md` §14](design/ui-spec-v04.md)** — props table
(§14.2), tri-state `thumbnail` contract (§14.3), cache-bust (§14.4), matched/reveal states
(§14.5), tile styling (§14.6), testing requirements (§14.7). That is the single source of
truth and the target of the component's provenance comment; do not restate the props here.
This document covers the icon _pipeline_ (generation, storage, house style) and the design
rationale below.

### Why the reveal is shaped the way it is

`matched` and `shimmer` serve the shopping list's "it found its home" moment (issue
#571, Treatment 2), but the component keeps them general. Two findings are worth keeping
because they cost a rebuild each:

- **The tile is one voice in a three-part choreography** owned by the shopping list: the
  row's Other copy collapses out (300 ms) while its aisle copy rises in (380 ms), and the
  sweep runs over both, `0–700`. All parts start on the same frame, and the caller's reveal
  window closes just after the sweep. An earlier build moved the row with a single Svelte
  `crossfade` and scaled the sweep down to 420 ms to fit it — measured, that crossfade never
  animated (its receive half always fell back to a snap), so the scaling tracked a move that
  did not exist. The spec's own two-part move is what ships, and the spec's 700 ms sweep is
  sized for it.
- **Any surplus in the reveal window is dead air.** The sage lift drops when the window
  closes, and that drop is the last thing the eye sees, so a window much longer than the
  sweep reads as a separate trailing event. Two rounds of "there's still a gap" were both
  this. Keep the window just past the sweep — enough margin for timer jitter, no more.

The sage lift applying to an **icon** tile (not just a bare one) for the duration of a reveal
is what makes the moment visible in its most common form — an item matching an established
canon, which by now nearly always has a generated icon. The backdrop reads behind an icon
because the pictograms leave margin and transparency around the artwork.

Consumers: `ShoppingListPage` rows (icon at row start, dimmed when checked; include
`thumbnail` in the page's `canonMap`, which currently drops it); later, recipe
ingredient lists and canon management views. Manual **regenerate/hide** lives in the
canon management view via a `regenerateCanonIcon` callable + a hide action.

**Regenerate accepts an optional steer.** The Regenerate button opens a small dialog
with an optional free-text field; the text is a one-shot, **additive** prompt hint
(e.g. "show it as a tin", "make it greener") appended verbatim to the locked prompt —
it never alters the house-style wording. The hint rides a transient `iconHint` field
on the canon doc: the callable writes `{ thumbnail: null, iconHint }`, and the trigger's
icon branch consumes it and clears it (`FieldValue.delete()`) in the same write that
sets the new `thumbnail`.

## Architecture contract notes

- **`firebase-admin` in `cloud-functions`:** the CF already imports `firebase-admin`
  directly for Firestore; Storage-Admin here follows that established precedent
  (contract rule 2's "Firebase SDK only in firebase-sync" is honoured by the _client_;
  the CF is the documented exception).
- **New dependency `sharp`** (native) on `cloud-functions` — esbuild must mark it
  `external` so the Functions runtime resolves the prebuilt binary.
- **Pre-launch / greenfield:** no migration; `thumbnail` is already nullable and
  currently always `null`, so old docs simply read as "no icon yet."

## Out of scope

Recipe photorealistic hero imagery (Tier 2) — its own issue; different/costlier model
path; shares only the Storage + `thumbnail`-style convention.

Product-form icons are **not** out of scope — they are this same pipeline pointed at
a second collection (#871); see the note at the top.

## Proven prompt (verbatim — reproduce exactly)

This is the exact prompt set from the prototype that produced the approved set. Commit
it as the locked house-style prompt; **do not paraphrase** — wording changes drift the
style.

**Locked is not the same as hidden** (issue #892). These strings are code-only in the
sense that matters: they live in `generateCanonIcon.ts`, they are never stored per
item, and nothing a user types can edit them or displace them. They are NOT secret.
The `getImagePrompt` callable assembles the complete prompt for any picture — this
wording included — and returns it to a read-only dialog, so anyone can read what drew
their icon and paste it into Gemini to play with. There is exactly ONE assembly of
these words in the repo: that callable **calls** `buildIconPrompt` rather than
restating it, for precisely the reason this section gives.

Model: `gemini-2.5-flash-image`. No special generation config (defaults).

**Shared style string** (call it `STYLE`):

> Flat vector cartoon illustration. A single centered subject filling most of the frame. Thick, uniform, rounded dark outline. Soft cheerful limited pastel colour palette. Simple minimal friendly shapes, low detail. Plain solid off-white background. No border or frame around the image; the subject sits directly on the plain background. No faces, no eyes, no facial expressions on any object. No caption text, no separate labels, and no lettering added under, beside, or around the subject; any text must be part of the depicted item itself (such as wording printed on a tin or jar). No drop shadows, no background gradients. Square composition, app sticker / emoji style.

**UK steer string** (`UK`):

> The item is as commonly sold in a UK supermarket.

**Step 1 — generate the seed** (text-only), once, to produce the committed reference
image. Seed subject was `a red apple`:

> A cute cartoon icon of a red apple. {STYLE}

The committed seed is downscaled to a 384×384 WebP (issue #236) — it only conveys
_style_, not detail we keep, so it is sized to a single Gemini input tile (≤384px) and
re-encoded as WebP to minimise per-call input tokens and payload. Resolution beyond this
buys nothing because the prompt negative-guides against copying the seed's subject.

**Step 2 — per-item generation** (multimodal: `[ {media: referenceImage}, {text: …} ]`):

> Generate a cute cartoon icon of {ITEM}. {UK} Copy ONLY the rendering STYLE of the reference image — its line weight, outline, colouring technique, palette and plain background. Do NOT copy the apple, and do NOT add any leaf, stem, sprig, red colouring or face that came from the reference. Draw only {ITEM} and nothing else. {STYLE}

**Seed-coupling caveat:** the negative clause (`Do NOT copy the apple … red colouring`)
is keyed to the **red-apple** seed. If the committed production seed is a different
subject/colour, update those subject/colour negatives to match it — otherwise
contamination protection won't apply. (A neutral, leaf-free seed reduces contamination,
but the apple seed worked once the negatives were added.)

**`{ITEM}` phrasing** uses UK forms, e.g. `two litre plastic bottle of milk`,
`plastic squeezy bottle of tomato ketchup`, `bag of frozen mixed vegetables`,
`block of cheddar cheese`. Feed the canon item's name; for packaged goods, prefer the
UK retail form.
