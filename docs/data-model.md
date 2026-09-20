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

## `recipes` holds five kinds

`kind: 'recipe' | 'special' | 'cocktail' | 'placeholder' | 'cure'` (issues #637, #652, #1404).

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
  It carries the one per-kind field on this document: `cureCategory`, one of five
  closed values or `null`.

Schema constraints, each load-bearing:

- `.default('recipe')` is **mandatory**. The realtime subscription skips documents
  that fail validation, so a required field would hide every production recipe.
- `ingredients` / `steps` stay required arrays (`[]` when empty) — never a
  discriminated union.
- `kind` is **immutable**: set at create — by the New sheet for a special, a meal
  or a placeholder, by the import or the chef for a recipe or a cocktail — and
  never editable. There is no route or control that changes it (the
  `/recipes/new/:kind` segment that used to set it went with the editor, #1319
  Phase 8).

Specials and placeholders are **not** separate collections — they occupy a planner
slot in place of a recipe. If they ever need their own fields, add optional nullable
fields to the recipe document first.

**That precedent now has a user.** `cureCategory: CureCategory | null`, `.default(null)`,
is the first per-kind field on this document (issue #1404). Nullable rather than
required-on-a-cure because the no-discriminated-union rule above means the schema
_cannot_ express "required iff `kind === 'cure'`" — and because an uncategorised cure
is a normal state, not an error. It is a **closed enum**, not a tag: it is frozen onto
a batch and filtered on, so it cannot carry the typo-drops-it-out cost the `placeholder`
mood accepts. Unlike `kind` it is **editable**, in place on the recipe page, because a
misclassification with no route back is a permanent wrong answer. It is identity and
grouping only — no capability predicate reads it, and the table gains no sixth column.

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
