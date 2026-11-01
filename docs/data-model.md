# Firestore data model — collections, ids, and rules

The invariants live in [CLAUDE.md](../CLAUDE.md) and are auto-loaded: family-shared
by default, four per-user exceptions, no soft-delete, LWW per document. This doc
holds the **mechanics behind them** — why each collection is shaped the way it is,
which id schemes are load-bearing, and which `firestore.rules` clauses look
redundant but are not.

Read it before adding a collection, changing an id scheme, or editing
`firestore.rules`. Several of the clauses below have been "tidied away" before and
each time it broke a listener in production.

## The four per-user collections

`chatSessions`, `cookSessions`, `pushSubscriptions` and `kitchenTimers` are the only
owner-scoped collections — a chat history, an in-progress cook, which device to
notify, and whose egg is boiling are all personal. Everything else is family-shared.

### `cookSessions/{recipeId}_{uid}`

Deterministic id, `ownerUid == request.auth.uid` set on create and pinned on update.
Unlike `chatSessions` it has **no TTL** — a cook may span several days — and its
orphan cleanup (deleted recipe → delete session) is client-side only.

Its read/delete rule also permits `resource == null` (issue #558). **Do not remove
that clause.** The deterministic id means the cook page subscribes _before_ the
session exists, and a rule that dereferences `resource.data` on an absent document
is denied — which kills the listener for good, not just for that read. Both emulator
suites cover it.

### `pushSubscriptions/{uid}_{deviceHash}`

One web-push subscription per device (issue #544). `ownerUid` set on create and
pinned on update; read/delete gated on `resource.data.ownerUid` **with the same
`resource == null` clause**, for the same deterministic-id reason as `cookSessions`
(subscribe- or delete-before-exists). Cloud Functions read every subscription via
the Admin SDK, bypassing rules, in order to send.

### `kitchenTimers/{uid}`

**One document per user** (issue #842), holding a `timers[]` array of standalone
timers. The one-doc-per-user shape is what bounds the collection at ~5 documents
forever, so there is no sweep, no scheduled function and **no TTL policy** — a
dismissed timer just leaves the array, and one left ringing over a day is pruned by
the next start.

Its rule is the one that **deliberately has no `resource == null` clause, and must
not gain one.** The document id simply _is_ the uid, so ownership is provable from
the path and the rule never dereferences `resource.data` at all; the absent-document
denial that forced the clause onto the other two cannot arise here.

Each timer carries `origin: { batchId, stepId } | null` (issue #1327) — where it was
armed from. `null` for a timer started on My Kitchen, and for every timer written
before the field, which is why it is `.nullable().default(null)` and needs no
migration. **It is not scoping.** The timer is still read and written under its
owner's uid alone; `origin` is checked by no rule, gates no capability and does not
make the timer the batch's — `batches` holds no timer, and the per-user exceptions
above are still four. Exactly two things read it: the finished-timer push, which
deep-links to `/#/batches/{batchId}/cook` instead of `/#/mine`, and the batch cook
deck, which shows a timer on its step from `stepId` rather than by matching label
text. A non-null origin with `stepId: null` is an ad-hoc timer started from a batch's
cook page — a different fact from `origin: null`.

`ownerUid` is still stored and pinned on write, because `onKitchenTimerDispatch`
reads it off the parsed document to target `pushSubscriptions`.

## `timerDeliveries` — server-owned, client-denied

An exactly-once delivery-dedupe ledger. Always a **separate document**, never a
write-back onto the document that triggered the send: a client full-doc `setDoc`
would clobber it under LWW.

It serves several producers that **deliberately share one collection**, the key
prefixes keeping the key spaces apart:

| Producer                  | Key                                               | Issue |
| ------------------------- | ------------------------------------------------- | ----- |
| Cook timers               | `${sessionId}_${timerId}_${endsAtMs}`             | #544  |
| Batch stage reminders     | `batch_${batchId}_${stageId}_${plannedStartAtMs}` | #812  |
| Standalone kitchen timers | `kitchen_${uid}_${timerId}_${endsAtMs}`           | #842  |

A second collection of the same kind, with the same `allow read, write: if false`
rules and the same purpose, would be pure duplication — **do not add one.** The
existing rules block covers every producer without change.

Retention on this collection and on `chatSessions` has its own runbook:
[runbooks/ttl-policies.md](runbooks/ttl-policies.md).

## `enrichmentFailures` — server-owned, client-READABLE

One tiny document per (background job, subject) pair, written by the Firestore
triggers when an AI enrichment gives up and deleted by the same branch on its
next success (issue #1419). It is what makes "we asked and it failed"
distinguishable from "nobody ever asked" — a distinction the data could not make
at all before, which is how four recipes reached the library with no equipment
list and sat there for up to twelve days (#1418).

Document id: `` `${enrichment}_${subjectId}` `` (`enrichmentFailureId` in
`@salt/domain/schemas`). Derived rather than random, which is the whole of the
housekeeping: a job that fails twice overwrites its own row, and a success
deletes a row it can name without reading anything first.

| Field          | Meaning                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enrichment`   | Closed enum — `recipeImage` / `recipeKit` / `recipeTimes` / `equipmentBrief` / `canonEmbedding` / `canonIcon` / `productFormIcon` / `kitchenToolIcon` |
| `subjectId`    | The document the job was FOR. Never a uid, never read as scoping                                                                                      |
| `subjectLabel` | What that subject was called at the moment of failure — a snapshot                                                                                    |
| `reason`       | Closed enum — `timeout` / `upstream` / `unknown`. No free text                                                                                        |
| `failedAt`     | Epoch ms                                                                                                                                              |

**Why not a field on the enriched document.** `recipes`, `canonItems`,
`productForms` and `kitchenTools` are all rewritten wholesale by a client
`setDoc`, so a trigger-written field is clobbered under LWW — the
`timerDeliveries` reasoning above, unchanged. The equipment brief settles it
independently: on that failure path there is no `equipmentIcons/{itemId}`
document to put a field on.

**And why not `timerDeliveries` itself**, which the note above says not to
duplicate: the difference is the rules block, not taste. That one is a dedupe
ledger no client ever reads (`allow read, write: if false`). This one exists to
BE read by the client — the recipe page renders a marker from it — so it takes
the `equipmentIcons` shape instead: `allow read: if request.auth != null; allow
write: if false`.

**Nothing branches on it.** No trigger guard consults it, and the retry handles
are unchanged — an unstamped `kitInferredAt` / `timesEstimatedAt`, a null
`thumbnail`, a bumped nonce. It is purely additive, so the ~91 production
documents that predate it render exactly as they did: **no migration, no
backfill.** Family-shared, with no `userId`; the four per-user collections stay
four.

## `shoppingDays/{YYYY-MM-DD}` — its own collection

One tiny family-shared document per shop trip (issue #629).

Not a field on a shopping list — it is a fact about the household's _week_, read by
both the planner and the reminder. Not a field on `mealPlans/{startDate}` either: a
week document only exists once someone plans that week, but the shop happens
regardless, and keeping it separate means marking a shop never contends with a
concurrent full-doc week write under LWW.

The date-keyed id is load-bearing. The daily reminder is one `get` by deterministic
id, the planner reads a week with one range query over document ids (no index), and
clearing is a `delete` — there is no "cleared" state to model.

`slot` (`'am' | 'pm'`) drives **copy and display only**, never timing.

It carries a `setBy` uid, but that is **audit only** and deliberately unpinned in the
rules: either partner may reschedule the other's shop.

## `freezerItems/{number}` — the doc id is the bag number

One family-shared document per thing in a freezer (issue #1684, epic #795). The
setup it sits in — freezers and their shelves — is the single
`freezerConfig/current` document (#1682).

**The id is the bag number, zero-padded** (`freezerItemDocId(47)` → `"047"`; a
fourth digit is kept, not cut). The number is written on the bag, so it is the
item's identity: moving an item rewrites `freezerId`/`shelf` in place and never
the id. Renumbering would be delete-and-recreate, and nothing offers it.

**Uniqueness, and its limit.** Adding is a plain `setDoc` at the number
pre-filled from `nextBagNumber` (one past the highest number given out — see
`freezerConfig.highestNumber` below) or typed over it. The number is checked
against the items **this device holds** — `FREEZER_NUMBER_IN_USE` — and nothing else checks it: no
transaction (the browser SDK cannot run one offline, and the garage freezer is
where signal is worst) and no rules clause. So numbers are unique **except** when
two devices add the same number before either has seen the other's add — in
practice, while one of them is offline: both writes land, the later one wins,
and the earlier item's record is replaced. A
rules clause refusing the second create was rejected because the losing device's
item would vanish silently on reconnect, which is worse than a visible overwrite.
The rules emulator test pins that the overwrite is allowed.

**Not placed.** An item points at a freezer by its opaque id and at a shelf by
its label, or `null` — the only place in a freezer set up with no shelves, and
**no shelf yet** in one that has them (packs labelled in the kitchen before
anyone has seen which shelf they fit on; `itemsByShelf` files them as the
freezer's `unshelved` until someone moves them). Removing a freezer or a
shelf, or relabelling a shelf, is allowed with stock on it and rewrites no item;
`itemsByShelf` files any item whose freezer or shelf the setup no longer has
under **Not placed**, computed in memory, until someone moves it. Nothing is
stored to mark it.

**`packWeight`** (issue #1712) is `{ amount, unit: 'g' | 'ml' }` — what ONE
pack under this number weighs, stored once on the entry rather than per pack, so
every pack under a number shares it by shape. It describes the pack, never what
is left: `amount` stays whole packs and a take stays −1. `addFreezerItem` and
`editFreezerItem` refuse a missing, non-finite, zero or negative weight
(`INVALID_FREEZER_PACK_WEIGHT`), so every entry added or edited since #1712
carries one. **Its limit:** a document written before it has no field and reads
as `null` (`.nullable().default(null)`), and keeps reading so until someone
edits it — required on read would make the list read skip the bag, hiding it
while it still holds its number. Move, recount and take carry the field through
untouched. `schemaVersion` stays `1`.

**Writes.** Adding, editing, moving and correcting the count are a
whole-document `setDoc`, and removing is a `deleteDoc` —
ordinary per-document LWW, so an edit saved from a copy that had not yet seen
another device's take overwrites it. **Taking a pack is the exception:**
`takeFreezerItemAmount` is an `updateDoc` of `{ amount: increment(delta),
updatedAt }`, the second sanctioned field transform beside
`recordCanonPurchases`. Takes from two devices compose — one queued offline and
replayed later included — so five less two is three; the emulator suite pins it.
`increment` cannot stop at zero, so two devices taking the last pack land on
`-1`: the schema has no lower bound on `amount`, and `displayAmount` shows it as
none. It is `updateDoc` rather than `canonPurchaseSync`'s `setDoc(…, { merge:
true })` on purpose: a take arriving after the item was removed fails
`not-found` (mapped to `NotFound`, which is not reported) instead of recreating
a partial document that would fail the schema and hold the number. The same
take rides inside `commitFromFreezer`'s batch (`defrosts` below) — the same
transform, queued by `queueFreezerTake` in the same file, not a third one.

**`freezerConfig.suppliers`.** The places stock has been bought from, as a
`string[]` on the config document, so the item sheet can offer a place after its
last item has gone. Saving an item whose `purchasedFrom` is not on the list
(trimmed, case-insensitive) appends it and saves the config; a place already
there is saved with the spelling the list has. Manage freezers removes one, and
no item changes. A config written before the field existed reads as `[]`. **Its
limit:** the list rides on the config document's whole-document LWW, so an
append is lost from it when another device saves the config before seeing the
append — a Manage-freezers edit, or remembering a different place at the same
time. Only the suggestion is lost (the item keeps its `purchasedFrom`), and
typing the place again puts it back; nothing claims the list is complete. The
reverse direction, which is worse, is under `freezerConfig.highestNumber`.

**`freezerConfig.highestNumber`.** The highest bag number an add has used,
suggested or typed (issue #1693), so a removed bag's number is not offered again:
`nextBagNumber` suggests one more than the greater of this mark and the highest
number among the items the device holds. An add records its number with
`recordBagNumber`, which hands back the same config — nothing written — when the
number is not above the mark; no edit, move, take or removal raises it. A
config written before the field existed reads as `0`, and taking the items too
is what gives that household the number after its highest bag with no migration.
Three limits:

1. **It rides on the config document's whole-document LWW.** A device holding a
   stale copy — typically one that was offline — can save a LOWER mark over a
   higher one. A number still on a bag this device holds is not offered again
   even then (the suggestion takes the items too), but a top number that was
   both handed out and removed inside that window can be. So "never reused" holds except across
   that window.
2. **Nearly every add writes the config document.** An add above the mark —
   every add at the suggested number, and a typed number past it — saves the
   config, and so does an add that remembers a new supplier; both changes are
   composed and saved in ONE `saveFreezerConfig` call. An add at or below the mark
   writes no config unless it remembers a new supplier. `saveFreezerConfig`
   writes the whole document, so **on a device holding a stale copy that save
   reverts another device's freezer or shelf change**, and the items of a freezer
   that change added fall under Not placed.
3. **Nothing lowers it on purpose.** A typo of 9999 that is saved moves every
   later suggestion past it, permanently; removing that bag does not undo it.

## `defrosts/{number}_{recipeId|manual}` — packs promised out of the freezer

One family-shared document per bag committed from the shopping list instead of
bought (issue #1685): Kitchen lists it under **To do** until somebody taps **Got
it out**, and the 09:00 push (#1683) scans the same projection, `kitchenTasks`.

**The id is deterministic** — `defrostDocId(number, recipeId)`: the bag number
padded as `freezerItems` pads it, then the recipe it serves (a "make it
yourself" row's **producer**) or `manual` for a row added by hand. Firestore
auto-ids are 20 characters, so `manual` cannot collide with a recipe id.

**The night is stored, once, at commit** (`forDate`, `YYYY-MM-DD` or `null`;
issue #1696). `useFromFreezer` works it out as `nextPlannedNight` over the
Kitchen weeks the Shopping list page holds while the freezer is on — the
soonest stored date key from today whose day plans `recipeId` — and nothing
re-dates it afterwards: Kitchen and the 09:00 push read the field and no
planner. So planning the recipe again never re-dates or re-buzzes an old,
un-ticked item, and moving the meal leaves the item on its original night (a
cost accepted with the decision). A commit before those weeks and the planner
config have loaded is refused, never stored `null`: an undated item is
permanent and never buzzes.

**`null` is undated:** a hand-added row (no lookup), a "make it yourself"
producer the planner does not hold, a recipe not planned in the held weeks at
that moment — the window is today's week, plus the next one in a cycle's last
three days, so a meal planned further out stays undated for good — and every
document written before #1696, which has no field and reads as `null` through
the schema's default. No migration, no backfill; `schemaVersion` stays `1`.

**A recommit sums.** Committing the same bag to the same id again adds its packs
to the existing document (`commitDefrost`, read from the subscribed store), as a
whole-document `setDoc` — ordinary LWW, no field transform, so a commit on
another phone this one has not yet seen is overwritten, its night included. The
recommit's `forDate` replaces the stored one, `null` included: a fresh commit
onto a stale, un-ticked item is dated by the fresh meal.

**One batch.** `commitFromFreezer` writes the stock decrement (the take-a-pack
`increment` above, queued on the batch), the entry's delete when it was the last
pack, this document, and the delete of the ONE shopping row it replaces, in a
single `writeBatch`. The take is queued even before the last pack's delete, so an
item another phone removed fails the whole batch `not-found` and nothing applies.

**The tick is the app's only delete.** Got it out is a `deleteDoc` by
anybody, for everybody — a household act, not a per-user dismissal; its Undo
re-sets the same document from the copy held in memory. No soft-delete, no
expiry: an item whose night has passed stays until ticked.

**No `resource == null` clause in the rules.** A create guard would refuse the
recommit that sums onto an existing id, which is the design. The rules emulator
test pins that the overwrite lands.

## `guidedPlans/{recipeId}`

The prep list and step notes for one recipe, keyed by the recipe id (issue #751).
Family-shared.

Deliberately its **own collection** rather than fields on `RecipeSchema`: a plan is a
rendering of a recipe, not part of it, so it can be rewritten without touching — or
LWW-clobbering — the dish, and a recipe with no plan carries no empty scaffolding.

**Two writers, split by who is waiting** (issue #1416). A GENERATION is written
server-side by the `generateGuidedPlan` flow through the Admin SDK, which is what
makes it survive a phone locking during the one-to-three-minute call; the callable
returns the document it wrote, and the client only paints it. On the human side,
`guidedPlanService` writes three ways: a SAVE/Approve (`saveGuidedPlan`), a
per-line EDIT with no Save step at all (`editGuidedPlan`, issue #1453 — every
changed line writes the moment it changes), and a DISCARD. Whole-document LWW as
everywhere else, so the hazard is not the writers but the control fields
disagreeing: `needs_approval` is set **only** by the flow and dropped **only** by
`saveGuidedPlan` — an edit carries it through untouched, because correcting a line
is not the claim that the whole plan has been read. `recipeUpdatedAtAtSave` is
stamped by the flow and by `saveGuidedPlan`, each against the recipe it actually
read, but **not** by `editGuidedPlan` — a plan edited against a recipe that has
since moved on keeps showing the stale banner until Approve re-stamps it. All
three are pinned by tests — see the header of
`apps/web-pwa/src/lib/guidedPlanService.ts`.

No `firestore.rules` clause covers the server write and none should: an Admin SDK
write bypasses rules entirely.

## `recipes` holds seven kinds

`kind: 'recipe' | 'special' | 'cocktail' | 'placeholder' | 'cure' | 'bread' | 'ferment'` (issues #637, #652, #1404, #1646, #1656).

- a **special** (UI label "Chef's Specials") is a meal that needs no recipe card — a
  takeaway, a night off, or the roast the cook knows by heart — with no ingredients
  and no method. Stored as `outing` until issue #1322, which renamed it in two
  deploys behind a temporary read-side coercion (see `docs/recipe-module.md`);
- a **cocktail** is a full recipe that is not dinner;
- a **placeholder** is neither — a stock photograph of "a good dinner, no particular
  dish", attached to a planner day that was planned in a sentence, so that night gets
  a card like any other. Its mood is an ordinary `tags` entry (`bright` / `comfort`,
  constants exported from `@salt/domain`), deliberately **not** a schema field.
- a **cure** (issue #1404) is cured meat — a coppa, a bacon, a saucisson, a
  mortadella. A full entry in every way a recipe is (ingredients, shopping list,
  canon, method, hero image) except that it is never offered in the planner picker.
  It carries one of the two per-kind fields on this document: `cureCategory`, one
  of five closed values or `null`.
- a **bread** (issue #1646) is a dough baked as bread — a loaf, rolls, focaccia, a
  flatbread, soda bread, pizza dough. Every capability is a recipe's; the label buys
  its own library shelf and is what offers "Make it scalable" (a first formula),
  as it is on a cure. **Deploy order:** an installed app or a Cloud Function that
  predates the member fails to parse a `kind: 'bread'` document and skips it, so
  nothing is labelled `bread` until both are on production — the same holds for
  `cure` since #1404 and `ferment` since #1656.
- a **ferment** (issue #1656) is vegetables or fruit fermented in salt — a
  sauerkraut, a kimchi, brined pickles, a fermented hot sauce, preserved lemons.
  Cure's capability row, cell for cell: a full entry, never offered in the planner
  picker, offered a first formula from the basis. It carries the other per-kind
  field, `fermentCategory`, one of five closed values (`kraut`, `kimchi`,
  `brined_pickle`, `hot_sauce`, `fruit_condiment`) or `null`. Drinks, dairy and miso
  stay `recipe`.

Schema constraints, each load-bearing:

- `.default('recipe')` is **mandatory**. The realtime subscription skips documents
  that fail validation, so a required field would hide every production recipe.
- `ingredients` / `steps` stay required arrays (`[]` when empty) — never a
  discriminated union.
- `kind` is set at create — by the New sheet for a special, a meal or a
  placeholder, by the import or the chef for the authorable kinds — and changed
  afterwards by exactly one route: the recipe page's label control (#1646), which
  switches only among the kinds that show ingredients and a method (recipe,
  cocktail, cure, bread, ferment; `relabelChoices`) and never gives a meal a kind
  that drops its dishes. Specials and placeholders are fixed. AI paths never change
  a kind. Leaving `cure` clears `cureCategory`, and leaving `ferment` clears
  `fermentCategory` (`withKind`).

Specials and placeholders are **not** separate collections — they occupy a planner
slot in place of a recipe. If they ever need their own fields, add optional nullable
fields to the recipe document first.

**That precedent now has a user.** `cureCategory: CureCategory | null`, `.default(null)`,
is the first per-kind field on this document (issue #1404). Nullable rather than
required-on-a-cure because the no-discriminated-union rule above means the schema
_cannot_ express "required iff `kind === 'cure'`" — and because an uncategorised cure
is a normal state, not an error. It is a **closed enum**, not a tag: it is frozen onto
a batch and filtered on, so it cannot carry the typo-drops-it-out cost the `placeholder`
mood accepts. It is **editable**, in place on the recipe page, because a
misclassification with no route back is a permanent wrong answer. It is identity and
grouping only — no capability predicate reads it, and the table has no column for it.

`fermentCategory` (issue #1656) is its **sibling**, on identical terms, rather than a
generalisation of it: `cureCategory` is stored and carries behaviour
(`cureSaltFitness`), so renaming it would be a migration. The two enums share no value.
Which field a kind owns is answered in one place — `categoryOf` / `withCategory` in
`domain/src/recipe/queries/category.ts` — so no screen picks a field by kind.

Note what `isPlannable` actually gates: whether a kind is **offered in the planner
picker**, not whether it may sit in a day. A placeholder is `isPlannable: false` and
still occupies a slot, because it is attached on its own rather than chosen.

## Zod validation failures, per boundary

Always `.safeParse()`, then handle by boundary type — the shape of the failure path
is what differs, not the decision to validate:

| Boundary                                                                               | On failure                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter single-document read — one-shot (`load(id)`) **or live** (`subscribeDocument`) | log the rejection, then `Failure<DomainError>` (`{ kind: 'StorageError', reason: 'corruption' }`) — never throw across an internal layer seam, and never a `null`: `null` is what an ABSENT document delivers, so answering a refusal with one tells the caller the document was never written (#928) |
| Adapter list reads & COLLECTION subscriptions                                          | skip the invalid document, log it, return the valid subset; one corrupt document must not fail the whole read. Stream-level errors still surface via `onError`                                                                                                                                        |
| Callable CF entrypoints                                                                | `throw new HttpsError('invalid-argument', …)` — the Firebase callable protocol for rejecting bad client input, not an internal seam                                                                                                                                                                   |
| Firestore triggers                                                                     | log and return; there is no caller to surface a `Failure` to                                                                                                                                                                                                                                          |

## Back-compat

Canon, Aisles, Equipment, Shopping List, Meal Planner and Recipes hold **real
production data**. A schema-shape change must be backward-compatible on read, or
carry a one-off migration. Recipes lost their greenfield status when the module
shipped to all members in #240 (2026-06-17).

Canon also has a vestigial `deletedAt` field from the local-first era. It is not a
soft-delete pattern to copy — see [salt-architecture.md §1.1](salt-architecture.md).
