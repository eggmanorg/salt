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

## `recipes` holds four kinds

`kind: 'recipe' | 'outing' | 'cocktail' | 'placeholder'` (issues #637, #652).

- an **outing** (UI label "When you CBA") is a takeaway / night off, with no
  ingredients and no method;
- a **cocktail** is a full recipe that is not dinner;
- a **placeholder** is neither — a stock photograph of "a good dinner, no particular
  dish", attached to a planner day that was planned in a sentence, so that night gets
  a card like any other. Its mood is an ordinary `tags` entry (`bright` / `comfort`,
  constants exported from `@salt/domain`), deliberately **not** a schema field.

Schema constraints, each load-bearing:

- `.default('recipe')` is **mandatory**. The realtime subscription skips documents
  that fail validation, so a required field would hide every production recipe.
- `ingredients` / `steps` stay required arrays (`[]` when empty) — never a
  discriminated union.
- `kind` is **immutable**: set at create — by the New sheet for an outing, a meal
  or a placeholder, by the import or the chef for a recipe or a cocktail — and
  never editable. There is no route or control that changes it (the
  `/recipes/new/:kind` segment that used to set it went with the editor, #1319
  Phase 8).

Outings and placeholders are **not** separate collections — they occupy a planner
slot in place of a recipe. If they ever need their own fields, add optional nullable
fields to the recipe document first.

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
