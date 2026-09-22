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

**Since #1465 a kit entry can RECORD which of your things it means, and that is
read first.** `recipes[].kit[].equipment` is `{ itemId, accessoryId | null }`,
written by the kit flow at the moment it had the manifest in front of it. Where it
resolves it is authoritative and no word is read: the linked thing's picture, or
none. It is what finally reaches a FAMILY member — "Tefal non-stick 28cm" carries
no word of "Frying Pans", and no rule over the words could ever find it. A link to
something since deleted resolves to nothing and the entry reads as words again, so
the manifest needs no cleanup job and nothing is ever written back to a recipe.
This NARROWS the words-only contract above; it does not repeal it. `kitchenTools`
ids are still never written onto a recipe, because a vocabulary grows and an
identity does not.

**The link is now the only thing that GROUPS a kit** (#1465 Phase 4).
`groupKitByEquipment` used to carry two further passes that read the words to decide
what nested under what; the production re-run of 2026-09-19 relinked all 66 recipes
and replaying the query over the live manifest showed no recipe grouping differently
without them, so they were deleted. An entry with no resolving link is a flat row.
**The words still decide the PICTURE, though, and not in the abstract:** every kit
surface reads `resolveKitEntryItem` — the link, then `resolveEquipmentItem` — and the
same measurement found two stored lines (`"frying pan"`, twice, both reaching the
Frying Pans family) that carry no link and draw that family's picture through the
word half. Remove it and those two rows go blank; `apps/web-pwa/tests/kitIcons.test.ts`
pins them.

**And a bare accessory name never borrows an unrelated object's drawing** (#1460).
`kitchenToolForKitLabel`, not the bare `resolveKitchenTool`, is what every kit
surface goes through: a label that exactly names one of the manifest's accessories
keeps a curated tool only when the vocabulary explains the NAME rather than a word
inside it. The Magimix's sealed "Thermo Bowl" was drawn as a plain mixing bowl and
the AMZCHEF's "Grill plate" as a dinner plate. Where a curation decision is needed
("an egg whisk is an ordinary whisk"), it is made in the vocabulary, as a matcher
— never inferred. The admin unresolved queue composes the identical function, so a
label the renderer declines is visible there as the gap it is.

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

So equipment's icons live in a **sibling collection**, `equipmentIcons/{docId}` —
the `canonEmbeddings` move (#410) and the `guidedPlans` move: when a field and its
host document have different owners and different read audiences, the field gets its
own collection. Two further consequences follow, and both are departures from the
canon shape rather than variations on it:

- **The trigger is LEVEL-triggered, not edge-triggered.** `onCanonItemWritten` needs
  `iconNeedsGeneration` precisely because it writes back to the document it watches.
  `onEquipmentManifestWritten` never writes the manifest, so it can just ask the
  honest question — does this item's brief match this item's name? — with no nonce.
- **A human reads the description before any image is generated** — through the
  Draw callable's gate, the only path a client request can reach. The trigger
  authors an appliance description (`describeEquipmentSubject`, `'fast'` tier) and
  stops; the image is drawn only when someone presses **Draw**, by the
  `drawEquipmentIcon` callable, which runs the image flow and `sharp` inline. Canon's
  fully-automatic model is right for groceries — "a bag of frozen peas" has one
  obvious rendering — but a make and model is exactly where fidelity is won or lost,
  and a brief is a sentence you can correct where a wrong picture is only a re-roll.
  Only the description is ever shown or editable; the style anchors stay in code.
  The one exception is `scripts/generate-equipment-icons.mjs --apply`, the
  one-off backfill for a kit that already exists: it DELIBERATELY BYPASSES this
  gate, because those briefs were read by hand, side by side with their
  drawings, in a prior dry run of the same script. Every item added after the
  backfill goes through the gate normally.

  **The equipment list's Draw button (#1458) does not bypass this.** It is a
  one-press route TO this panel, `push('/equipment/{id}')`, never a second place
  that draws. #1458 asks for one press from the list to close a different gap —
  finding which record has no picture — and Daniel's ruling on the review that
  first tried to also draw in place is that the friction being removed is the
  hunting, never this reading. #1465's `KitPicturePicker.svelte` hands a
  pictureless row noticed on a recipe to this same route for the same reason:
  there is deliberately only one host for this panel, and only one gate.

### An entry may have a picture of its own (#1465, Phase 2)

An accessory or a family member — the steam basket, the Lodge skillet — can carry
its own drawing, and the document id is the **accessory's uuid**. That is the whole
of the mechanism: accessory ids come from the same generator as item ids and are
unique across the manifest, so `firestore.rules`'s `{itemId}` wildcard, the orphan
sweep's `equipment-icons/ → equipmentIcons` join, `drawEquipmentIcon`,
`setIconUpload` and `getImagePrompt` all carry over untouched. #1460 priced this as
"probably an epic" on the assumption of a second keying scheme; there isn't one.

Two things did **not** carry over, both in `onEquipmentManifestWritten`:

- **The reconcile pass deletes every icon doc outside a live set it is handed**, and
  that set was the items alone — so the first manifest write after entries could own
  pictures would have deleted all of them. It now asks `equipmentIconOwnerIds`
  (`packages/domain/src/equipment/queries/equipmentIcon.ts`), and
  `tests/triggers/onEquipmentManifestWritten.test.ts` goes red if it stops.
- **The brief-authoring loop stays item-only.** There are ~140 entries, most never
  named in a recipe; authoring each a description would be ~140 text calls on every
  manifest save for words nobody asked to read. **Nothing is ever drawn or described
  for an entry automatically.** The first act is a press — the `authorEntryIconBrief`
  callable, from the entry's row on the equipment page — and after that the entry is
  the item flow unchanged: read the description, correct it, Draw.

`authorEntryIconBrief` is the one callable here that **persists** what it authors,
unlike `describeEquipmentSubject` below, and for a reason that does not generalise:
there is no document yet, so there is no occupied caption for an unaccepted sentence
to overwrite. It is idempotent on the subject name, so a second press costs nothing
until the entry or its record has been renamed.

The words a brief is authored from are `equipmentEntrySubjectName`'s, and they are
not always the entry's own: a family member stands alone ("De Buyer Mineral B Carbon
Steel 28cm"), while an appliance's part is qualified by its appliance ("Steam Basket
(Cosori 5L Rice Cooker)") — a steam basket for _what_ is the difference between a
specific drawing and a generic one. Nothing displays that string; every heading and
row shows the entry's own name.

At display time `kitIcons.ts` prefers the entry's picture over its record's, and a
**hidden** entry picture stops the fall from the entry to the record — "hidden" is
the answer for that row, and the record's picture would be answering a different
question. It does **not** stop the fall from the entry's own picture to that same
entry's _borrowed_ one (below): a borrow is not a different question, it is the
same row pointed at a different drawing, and it can be set after a hide. Blocking
that too would make the write permanent and silent. An entry described but not yet
drawn falls back the same way, which is what keeps the ~140 undrawn entries free.

### A picture can be borrowed, and asked for where the miss is noticed (#1465, Phase 3)

A thing you own can be **pointed at a drawing that already exists** instead of
being given one: `borrowedPicture: { family: 'equipment' | 'kitchenTool', id }` on
`EquipmentItemSchema` and `AccessorySchema`, `.default(null)` and with **no
refine** — the manifest is one document, so a refine on a reference whose target
was later deleted would take the whole equipment list down. A dangling reference
resolves to nothing at display time and the row falls back, exactly as a dangling
kit link does.

**A reference, never a copied URL.** Every icon family reuses its Storage object
path on a redraw and writes the bytes `immutable`, and the cache-bust nonce lives
on the _source_ document — so a copied URL is stale the moment the source is
redrawn and has no nonce to fix it. Reading through the id is what makes
"redraw the frying pan" reach every pan borrowing it. `kitIcons.ts` owns the
reading, and the order is: entry's own → entry's borrowed → record's own →
record's borrowed → none.

**The picker is on the recipe page, and that overturns a decision.** #1458
rejected "a per-recipe one-tap add at the point of the miss"; #1465 reverses it,
because the miss is noticed on the recipe and sending the person to Admin is the
friction that leaves gaps open. #1458's concern — one-row-at-a-time minting is how
#956's near-duplicates arose — is answered by **order**, not by removal:
`suggestKitchenToolParent` leads — filtered to a tool that actually has a
drawing, the same filter the searchable list beside it applies, since the query
itself ranks on shared words alone and does not read `thumbnail` — the
searchable list of existing drawings comes next, and "draw a new one" sits
under both.

**Two rows, two different acts**, and they are indistinguishable on screen. Which
one a row gets is decided by `resolveKitEntryItem` — the recorded link, falling
back to the words where there is none — the same function `kitIcons.ts` renders
through, so a row the strip already draws as "one of your things" cannot take the
other act just because this dialog asked a narrower question:

- a row that **resolves to one of your things** gets a borrowed picture on the
  manifest — a fact about that object. "Draw one for it" hands over to the
  equipment record's page, where #877's read-the-description gate already lives;
  there is deliberately no second host for that panel.
- a row that resolves to nothing is **ordinary words**, so choosing writes a
  **matcher** on the chosen tool (every recipe that already says them lights up,
  nothing migrated) and drawing mints a tool named after them. Equipment pictures
  are not offered there: a record has no matchers, so there would be nothing for
  the words to be taught to.

What this does **not** do is re-point the recipe's link. "This 'large frying pan'
is my Tefal 28cm" is a per-recipe edit of what the line _means_, which is a
different act, and the issue leaves it out.

**The description may also be authored from a photograph (#947).** `describeEquipmentSubject`
gained a third mode alongside authoring-from-name and revising-from-a-correction:
**Use a photo** on the item page sends a reference photo of the actual appliance, and
the flow writes a fresh description from what the photo shows — "Start over, but
with a picture", discarding whatever was in the box exactly as Start over does. The
photo is REQUEST-SCOPED: it goes to Gemini as a media prompt part and is never
written anywhere — no Storage object, no Firestore field, no trace on the item —
only the sentence it produces persists, and only once **Draw** is pressed.

### A missing picture says so, where it can be closed (#1458, Phase 1)

Production held 22 equipment records and 20 drawings on 2026-09-18. Both undrawn
records rendered as the same pale placeholder tile a record whose art is still
generating renders, so the only way to find one was to go looking — and nobody did,
for months. The fix is a sentence and a number, not a pipeline.

- **`undrawnEquipment`** (`packages/domain/src/equipment/queries/undrawnEquipment.ts`)
  is the predicate, and its header is where the definition lives. Three things are
  **not** gaps: a `"hidden"` thumbnail (the user's answer for that row), a
  **borrowed** picture (#1465 — a row showing a picture is not missing one), and an
  **entry's** missing drawing (nothing is ever drawn or described for one
  automatically, and ~140 of them would be a badge that never falls).
- **The equipment list says "Not drawn yet"** on a marked row and offers **Draw**
  beside it, at the same rung as the accessory and rule counters — a fact about the
  row, not a warning. Draw is a one-press route to the record's page, where the
  description is shown and #877's gate holds; see the boundary paragraph under
  #877 above.
- **The Admin nav badge does NOT count them**, and a third summand that did was
  removed the week it reached production. #1458 added undrawn records plus
  `unresolvedKitLabels`' rows to the badge beside canon's and product forms'
  `needs_approval` counts. In staging and then in production it read **76** against
  **zero** pending canon items and **zero** pending product forms — a number whose
  only plausible reading, on a badge whose other two summands are approvals, was an
  approval backlog that did not exist. Two further things made it unactionable:
  `/admin` badges its **Catalog** tile and nothing else, so the count had no tile to
  land on; and the two kinds of gap are closed on two different pages, neither of
  them the one the badge points at.
- **A picture gap is stated beside the thing it describes, not counted at the top
  level.** "Not drawn yet" sits on the equipment list row with **Draw** next to it,
  and the unresolved vocabulary queue is the list on `/admin/kitchen-tools`. Both
  were what #1458 Phase 1 was actually for; the badge was the part that could not
  say what it meant.

**If the badge ever regains a picture summand, it needs a tile and a word first.**
The arithmetic was never wrong — `undrawnEquipment` and `unresolvedKitLabels` can
never name the same thing, because that query already excludes a label resolving to
one of the household's records. What was wrong was putting a count of drawings in a
place that means approvals, with no route from the number to the work.

### Salt proposes, a person writes (#1458, Phase 2)

Every **Not drawn yet** row on `/admin/kitchen-tools` carries a sentence saying what
Salt thinks the word is. The rows themselves are #1489 Phase 3's; this is a sentence
added to them, and it takes no verb away and adds none.

- **`proposeKitchenTools`** (`apps/cloud-functions/src/flows/proposeKitchenTools.ts`)
  answers one of three things per word — another name for a tool that already draws,
  a new tool with a suggested name, or not a piece of kit at all.
- **One call for the whole group, once per arrival.** The judgement worth paying a
  model for is grouping — that "large mixing bowl" and "Large Bowls" are the bowl we
  already draw — and a model shown one word at a time cannot make it. It also keeps
  opening the page to a single `fast` call.
- **The pure head-noun suggestion still leads.** `suggestKitchenToolParent` paints
  every row before the call is made and stays there if the answer never comes; the
  proposal replaces it in place when it arrives. Nothing spins and nothing is
  disabled while waiting, and a model that is unavailable costs the page a sentence
  and nothing else.
- **Nothing is written without a press,** and the presses are the ones the row
  already had: the one-click alias, or the pre-filled Add dialog where #956's
  near-duplicate warning lives. There is no accept button of its own, and no
  dismiss — a word this page cannot name is the library's own content, and there is
  nowhere honest to record that somebody disagreed with a suggestion.

**What stops the vocabulary bloating, stated rather than overstated.** One thing is
mechanical: `sanitiseKitchenToolProposals` refuses to propose a **new** tool where
the vocabulary can already name the name the MODEL suggested for it, through
`resolveKitchenTool`. It deliberately does **not** check the requested word itself
against `resolveKitchenTool` — `kitIcons.ts` (every surface that draws a kit label)
renders through `kitchenToolForKitLabel`, not the bare `resolveKitchenTool`, and every
word this flow is ever asked about already failed that gate (`unresolvedKitLabels`
applies the same lookup before a word joins the queue). So `resolveKitchenTool(word,
tools)` is non-null only when `kitchenToolForKitLabel`'s accessory rule (#1460)
deliberately refused that word — e.g. "Thermo Bowl" naming the Magimix's sealed
accessory rather than an ordinary mixing bowl — and checking it would rewrite that
refusal back into the very alias #1460 exists to prevent, on the row's own leading
press. It is pinned by
`apps/cloud-functions/tests/flows/proposeKitchenTools.test.ts`. The ceiling in
`apps/cloud-functions/tests/kitchenToolVocabulary.test.ts` is unchanged and green.

One thing is **not** guaranteed, and no test can make it so: a person may always
confirm a `new` proposal that should have been an alias; that is the design — Salt
records, it does not police. Nor does this guard stop the flow proposing an alias
onto a word `kitchenToolForKitLabel` already refused — the model may answer `alias`
outright, or a `new` whose `suggestedLabel` resolves to that same refused tool, and
either still reaches the row's leading press; the guard only prevents minting a
duplicate, not aliasing onto one.

### The description's two lives (#1433)

The same flow runs on two paths with opposite durability, and that is the decision
rather than an inconsistency. On the **automatic** path — a create or a rename —
`onEquipmentManifestWritten` calls the flow, gets a description nobody asked for and
writes it to `equipmentIcons/{itemId}` immediately; the `--apply` backfill script does
the same in bulk. On the **human** path — Revise, Start over, Use a photo — the
callable hands the sentence back to the textarea and writes nothing, so a revision is
lost if the phone sleeps before **Draw**. That loss is accepted deliberately. A
durable version was considered and rejected: the document already exists and the
browser already subscribes to it, so writing would be cheap, but `subjectBrief` is
not an empty slot — it is the caption of the picture currently on screen. Saving an
unaccepted revision there would replace a description somebody approved with one
nobody has, raise no `equipmentIconAwaitingApproval` signal doing it (that predicate
compares `sourceName` with `briefSourceName` and never reads the brief), and arrive
back down the item page's own subscription over whatever the user had typed since.
Client-side durability was rejected too, by CLAUDE.md hard rule 3. The claim this
rests on is narrower than the one the code used to state: `drawEquipmentIcon` is
the only writer of `subjectBrief` that **takes its brief from a client request** —
the describe callable's output, once the browser sends it — reaching Firestore. It
is emphatically not the only writer of the field; who the others are is the next
section, and no code comment restates it.

### Who writes `subjectBrief` (#1519)

**This table is the only enumeration of this set. Every comment that used to carry
its own points here instead, and `pnpm briefwriters:check` fails when the table and
the code disagree.** That gate exists because the prose version went stale twice on
the same mechanism — #1461 corrected four sites after the trigger and the backfill
were recognised as writers, and #1482 broke all four again one PR later by adding
`authorEntryIconBrief` and touching none of them. CLAUDE.md rule 12.

Read the **category**, not the count. The count is what a script can check; the
category is what an agent actually needs, and it is the half that broke worst — the
old prose divided the world into "text a human typed" and "text authored from the
item's name", and `authorEntryIconBrief` is neither. It is reached from the browser
like the first and authors its own sentence like the second, then persists it with
no review step at all.

<!-- subject-brief-writers:start — the canonical list; checked by `pnpm briefwriters:check` (#1519) -->

| Writer                                 | Site                                                              | Where its sentence comes from                                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drawEquipmentIcon`                    | `apps/cloud-functions/src/callables/drawEquipmentIcon.ts`         | **A client-typed string.** The only one. Its brief is whatever was in the textarea when Draw was pressed, so this is the one write a person approved.                                                                  |
| `authorEntryIconBrief`                 | `apps/cloud-functions/src/callables/authorEntryIconBrief.ts`      | **Server-authored, browser-asked-for.** A press resolves the entry's name server-side, runs the flow and persists the answer immediately — no textarea, no review step. Neither of the other two categories covers it. |
| `onEquipmentManifestWritten`           | `apps/cloud-functions/src/triggers/onEquipmentManifestWritten.ts` | **Server-authored, nobody asked.** A create or a rename runs the flow in authoring mode and writes the result; no browser is in the loop.                                                                              |
| `generate-equipment-icons.mjs --apply` | `apps/cloud-functions/scripts/generate-equipment-icons.mjs`       | **Server-authored, nobody asked.** Same flow, same mode, in bulk. An operator tool rather than a path — its briefs are read by hand, which is not what separates the writers.                                          |

<!-- subject-brief-writers:end -->

Consequences worth keeping in view when you add a fifth:

- `drawEquipmentIcon.ts`'s transaction is not ceremony. The trigger is a concurrent
  writer of the same field, so a rename landing mid-draw has already re-authored
  `subjectBrief` under the new name.
- `equipmentIconAwaitingApproval` compares `sourceName` with `briefSourceName` and
  never reads the brief, so a brief-only write raises no signal at all — see
  `index.ts` → `describeEquipmentSubject`, fact FOUR.
- The gate matches a literal `subjectBrief:` assignment under
  `apps/cloud-functions/src` and `apps/cloud-functions/scripts`. A write that never
  spells the field on the line — a spread, a computed key — is outside what it sees;
  `scripts/lib/subjectBriefWriters.mjs`'s header says so at length.

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
