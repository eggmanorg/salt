# #939 — query narrowing and the whole-snapshot re-parse: investigation

Read-only investigation against `perf/narrow-subscriptions-939`, cut from
`integration/current-sprint` @ `6d2297dc` — i.e. **after** #928 (subscription
consolidation) and #931 (writer error contract) landed. No production code was
changed. A later agent implements from this; nothing here is a decision already
taken.

The issue's own numbers were measured before #928. **Every count below was
re-derived against this tree**, and where the issue is now stale it says so.

> **Status — both headline recommendations have landed; read the rest as the
> point-in-time record.** The `docChanges()` fix (§0, §4 Stage 1) shipped in #984,
> pinned by `packages/adapters/firebase-sync/tests/snapshotParseCount.test.ts`.
> `chatSessions` growth (§2 row 5, A5-012, §4 Stage 2) was settled by #1008's TTL
> sweep instead of a `limit()` — see
> [`docs/runbooks/ttl-policies.md`](runbooks/ttl-policies.md) for which projects are
> armed. Line numbers and "appears nowhere" claims below describe the tree this was
> written against, not today's.

---

## 0. Headline, restated honestly

> **Done — landed in #984.** `subscribeCollection.ts` now re-parses only the
> documents `snap.docChanges()` names. The paragraph below is the pre-#984 state.

The mechanism is real: `docChanges()` appears **nowhere** in the repo
(`grep -rn docChanges packages apps --include='*.ts' --include='*.svelte'` → 0
hits), so every snapshot re-`safeParse`s every document in the delivered set.

Two things have changed since the issue was written, and they pull in opposite
directions:

- **The fix got much cheaper.** All 28 subscriptions now route through
  `packages/adapters/firebase-sync/src/subscribeCollection.ts` and
  `subscribeDocument.ts`. `onSnapshot` is called in exactly two places in the
  whole repo (`subscribeCollection.ts:80`, `subscribeDocument.ts:78`) and the
  parse loop lives once in `schemaParsing.ts:63`. What the issue costed as 15
  edits is now **one edit in one function**.
- **The payoff is smaller than the issue implies.** Measured against real
  collection sizes (§3), today's whole-snapshot re-parse costs **1.3 ms** for
  recipes and **0.25 ms** for canon. That is not a user-visible defect today. It
  becomes one at several hundred recipes under a write burst.

And the bounding half of the issue does not survive contact with the data. Of the
15 collection subscriptions, **one** has a genuine unbounded-growth defect
(`chatSessions`). Nine are permanently tiny or structurally bounded, one is
deliberately unbounded by design, and the rest already carry constraints.
Recommending a `limit` on the other fourteen would be churn.

---

## 1. The thirteen findings — verdicts

| finding  | verdict                                                                 | one line                                                                                                                    |
| -------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `B2-013` | **CONFIRMED** (issue body's headline count is STALE)                    | 9 whole-collection unbounded reads, not 11 of 15; only `subscribeMyCookSessions` carries a `limit`                          |
| `A5-012` | **CONFIRMED — and the single biggest real cost**                        | app-lifetime, 76 fat documents, 52 of them written immortal — and no sweep has ever run                                     |
| `A5-011` | **CONFIRMED mechanically, REFUTED as a perf problem**                   | the collection holds 1 document                                                                                             |
| `A5-010` | **CONFIRMED — but it is an AI-cost/behaviour decision, not a perf fix** |                                                                                                                             |
| `A3-007` | **CONFIRMED** — and already carries a `ponytail:` debt marker in-code   | 2–5 full 281-doc canon reads per recipe import                                                                              |
| `C2-001` | **CONFIRMED in substance, STALE in location**                           | the handler it names no longer exists; it is now the one shared parse loop                                                  |
| `C2-002` | **CONFIRMED — OUT-OF-SCOPE for this issue**                             | AI blast radius in `domain`, no query and no snapshot involved                                                              |
| `C2-007` | **CONFIRMED as fact, REFUTED as a defect**                              | 17 sites, N = 64                                                                                                            |
| `C2-009` | **CONFIRMED**                                                           | 20 sequential document `get`s per manifest write; collapsible to 1                                                          |
| `A1-013` | **CONFIRMED as fact, REFUTED as a defect**                              | three `$derived` Maps over 281 items, rebuilt only when canon changes                                                       |
| `A3-014` | **CONFIRMED as fact, REFUTED as a defect**                              | O(S×N) with S ≤ ~50, N = 295                                                                                                |
| `A4-012` | **CONFIRMED — the only UI finding with a real shape**                   | O(N²) ≈ 79k comparisons per keystroke, and it grows quadratically                                                           |
| `C3-013` | **CONFIRMED — OUT-OF-SCOPE for this issue**                             | data-lifecycle, not query narrowing; and a TTL policy is blocked by the field's type — **resolved by #1008**, see §`C3-013` |

### B2-013 — "nine collection subscriptions with no `limit`/`where`/`orderBy`"

**CONFIRMED as written. The issue body's own restatement ("11 of 15") is STALE.**

The contract table (`tests/subscriptionContract.emulator.test.ts:697`) carries 15
collection rows and 13 document rows. But `subscribeAisles` is a _single-document_
read that happens to deliver an array (`aisleSubscription.ts:20` → `subscribeDocument`,
`canonData/aisles` holds the whole array in one doc). So there are **14 real
`collection()` reads**, of which:

- **4 carry query constraints** — `subscribeChatSessions`
  (`chatSessionSubscription.ts:49`, `where` only), `subscribeMyCookSessions`
  (`cookSessionSubscription.ts:88-92`, `where` + `orderBy` + `limit(5)`),
  `subscribeBatchObservations` (`batchObservationSync.ts:67`, `orderBy('at')`),
  `subscribeShoppingDaysInRange` (`shoppingDaySync.ts:37`, `documentId()` range).
- **1 is bounded by its path, not a constraint** — `subscribeShoppingListItems`
  (`shoppingListItemSubscription.ts:32`, a subcollection of one list).
- **9 are whole-collection unbounded** — canonItems, recipes, productForms,
  kitchenTools, kitchenMemories, equipmentIcons, members, shoppingLists, batches.

So the finding's "nine" is exactly right today, and "only `subscribeMyCookSessions`
[has a limit]" is still true. The `11 of 15` in the issue prose counted files
before the descriptor refactor and should be corrected on the issue.

### A5-012 — `subscribeChatSessions` unbounded, from `App.svelte` at auth

**CONFIRMED, and it is the one bound worth adding.**

- `chatSessionSubscription.ts:44-57` — `constraints: [where('ownerUid','==',ownerUid)]`
  and nothing else. No `orderBy`, no `limit`.
- `apps/web-pwa/src/App.svelte:58` — `const unsubChat = initChatSync(auth.user.uid);`
  in the auth effect, alongside canon/recipes/members. App-lifetime, every session,
  every cold start.
- **Staging: 76 documents. Dev: 71.** These are the fattest documents in the app —
  each holds the full `messages[]` array of a conversation. A four-document sample
  measured ~5 KB each, so the boot payload is order **380 KB** and grows with every
  chat ever held.
- **The dominant class never expires, and nothing sweeps the rest either.**
  `chatSessionSubscription.ts:30` writes `expiresAt: '9999-12-31T23:59:59.999Z'`
  for any session with a `recipeId` (#696, deliberate). Counted against staging on
  **2026-08-25** (point-in-time; re-count before quoting these):

  | count | over staging's `chatSessions`                                          |
  | ----- | ---------------------------------------------------------------------- |
  | 76    | documents in total                                                     |
  | 24    | with `recipeId == null` — so **52 carry one** and are written immortal |
  | 31    | actually holding the `9999-12-31` sentinel today                       |
  | 42    | already past their own recorded `expiresAt`, and all 42 still present  |

  A chat claims its recipe as soon as it produces one, so the immortal class is
  the majority, not an edge case. The 52/31 gap is the sessions written before
  #696 landed — they carry an ordinary 14-day date and were never restamped.

  The 42 are the other half of the finding, and this investigation originally
  missed it: **nothing has ever swept a chat**, sentinel or not. `expiresAt` is
  written as an ISO-8601 _string_, and a Firestore TTL policy only expires a
  document whose TTL field holds a `Timestamp` — anything else is skipped in
  silence. So the fortnightly sweep described since #206 has never run on any
  project. Fixed in part by #939 (the sentinel became a 540-day window); the
  `string` → `Timestamp` migration that would arm the sweep is deliberately its
  own issue, because it is a shape change on live per-user documents and it would
  make those 42 sweepable at once.

  > **Resolved by #1008 — see [`docs/runbooks/ttl-policies.md`](runbooks/ttl-policies.md).**
  > `chatSessions.expiresAt` is written as a `Timestamp`, and
  > `scripts/migrate-ttl-timestamps.mjs` converts the documents already written.

At the time of writing, this was the only subscription whose document count grew
without bound, whose documents are large, and which is attached for the whole
life of the app. Once a project's TTL policy is armed, growth is bounded by the
retention windows (`CHAT_TTL_MS` / `CHAT_RECIPE_TTL_MS` in
`packages/domain/src/chat/queries/chatExpiry.ts`) — see §4 Stage 2.

### A5-011 — whole kitchen-memory collection per chat turn

**CONFIRMED mechanically. REFUTED as a performance problem.**

`apps/cloud-functions/src/flows/kitchenMemoryContext.ts:75` —
`await db.collection(KITCHEN_MEMORY_COLLECTION).get()`, no limit, on every
`chefChat` turn (`chefChat.ts` joins it into the existing `Promise.all`, so it
adds no serial round-trip).

**Staging holds 1 document.** The collection is written by hand, one note at a
time, by ~5 people. It is bounded by human effort at the tens.

The genuine risk here is not the read — it is that `renderKitchenMemories`
concatenates _every_ note into the system prompt unbounded, so prompt size grows
with the collection. That is an AI-cost and prompt-quality question, and capping
it changes what the model sees. **Do not add a `limit` to this read as a perf
fix.** If a cap is wanted, it is a product decision (§4).

### A5-010 — every turn sends the whole message array

**CONFIRMED. It is an AI-cost and behaviour change, not a perf fix.**

- `apps/web-pwa/src/lib/chatService.ts:294` — the only filter is
  `!(m.role === 'user' && parseChatCommand(m.text) !== null)`, i.e. `/remember`
  lines are dropped. Nothing slices the array.
- `ChefChatInputSchema` (`packages/domain/src/schemas/chefChat.ts:8`) sets no
  maximum on `messages`.
- `apps/cloud-functions/src/flows/chefChat.ts:261` maps the whole array into
  Genkit `messages`.

Cost scales linearly with conversation length on **every** turn (this is the
classic quadratic-tokens-per-conversation shape). Truncating it is a real saving —
and it **changes what the model sees**, which is exactly the class of change that
must not be made silently. Flagged as a product decision in §4.

### A3-007 — `ports.store.list()` run repeatedly per import

**CONFIRMED, and the codebase already knows.**

`apps/cloud-functions/src/flows/canonicaliseRecipeIngredients.ts:116-118`:

```ts
// ponytail: second canon list read (matchOrCreateBatch lists again); fold
// into a shared load if recipe-import canon reads ever show up hot.
const canonList = await ports.store.list();
```

and `packages/domain/src/canon/commands/matchOrCreate.ts:99` —
`matchOrCreateBatch` opens with its own `await ports.store.list()`.
`resolveParentCanonId` (`canonicaliseRecipeIngredients.ts:226-230`) calls
`matchOrCreateBatch([...])` **once per distinct proposed parent name** (it does
dedupe by normalised name), and each such call is another full list.

At the real N of **281 canon items**, a recipe import that mints 3 new parents
costs `2 + 3 = 5` full collection reads = **1,405 document reads**. That is a
Firestore billing line, server-side, and it is the same _shape_ as #410 — which is
why it is worth recording — but it is a different mechanism from `docChanges()`
and touches `domain`, so it belongs in its own change (§4).

### C2-001 — the recipe snapshot re-parses every document

**CONFIRMED in substance. STALE in location — and that is good news.**

The handler the finding describes (a `snap.docs` loop with `RecipeSchema.safeParse`
inside `recipeSubscription.ts`) no longer exists. `recipeSubscription.ts:23` is now
a descriptor. The loop lives once, at `schemaParsing.ts:63-76`, driven from
`subscribeCollection.ts:82`.

This is the single most important consequence of #928 for this issue: **one edit
in one function fixes all fourteen collection subscriptions.**

### C2-002 — `Promise.all` over `arbitration.arbitrate`, no concurrency cap

**CONFIRMED.** `packages/domain/src/canon/commands/matchOrCreate.ts:118-134` —
Phase 2 fires every `needs_ai` classification concurrently with no limiter. A
recipe with 20 unmatched ingredients can fire 20 concurrent Gemini calls.

**OUT-OF-SCOPE for #939.** No query, no snapshot, no loop over a collection read.
It is an AI rate-limit / blast-radius policy, it lives in `packages/domain` (pure),
and capping it needs a stated policy (what concurrency, and what the user sees when
it queues). Note the codebase has already made this call once, in the opposite
direction and with a reason, at `onEquipmentManifestWritten.ts:213-217`
("Sequential, not parallel: nineteen concurrent Gemini calls from one invocation
is a rate-limit shape for no gain"). Own issue.

### C2-007 — `$recipes.find((r) => r.id === …)` linear scan

**CONFIRMED as fact. REFUTED as a defect.**

17 call sites (`RecipeViewPage.svelte:198,781,811`, `CookModePage.svelte:104`,
`GuidedCookPage.svelte:124`, `FormulaPage.svelte:102`, `GuidedPlanPage.svelte:52`,
`MealCookPlanPage.svelte:78`, `RecipeEditPage.svelte:150`, `MinePage.svelte:342`,
`ChatSessionPage.svelte:44,200`, `personalViewService.ts:143,259,322,372`,
`MealPlanWeekPage.svelte:375`).

**N = 64.** Most sites are a single `$derived` scan re-run only when `$recipes`
changes. Four sites are inside a `.map` (`personalViewService.ts:322,372`,
`MealPlanWeekPage.svelte:375`) — O(k×N) with k ≤ 14. A 64-element `Array.find` is
tens of nanoseconds. Building an id-indexed map to replace this is churn.

### C2-009 — one `equipmentIcons` document `get` per manifest item

**CONFIRMED.** `apps/cloud-functions/src/triggers/onEquipmentManifestWritten.ts:113`
(`const existing = await ref.get();`) inside `maybeAuthorBrief`, called in the
sequential loop at `:216`.

**Staging: 20 `equipmentIcons` documents**, and `equipmentManifest` is a single doc
whose `items[]` array drives the loop. So every manifest write does ~20 sequential
document reads, almost all of which immediately short-circuit on
`briefSourceName === name`. One collection read (or a single `getAll`) before the
loop collapses 20 reads to 1, with no behaviour change and no effect on the
deliberate sequencing of the AI calls. Small, safe, cheap — but a Cloud Functions
change, not a subscription one.

### A1-013 — three derived structures over `$canonItems`

**CONFIRMED as fact. REFUTED as a defect.**

`RecipeViewPage.svelte:405` (`canonNameById`), `:595` (`liveCanonIds`), `:607`
(`canonById`) — all three are `$derived`, so they rebuild only when `$canonItems`
changes, not per render and not per ingredient. At N = 281 that is three
Map/Set constructions ≈ tens of microseconds, on a store that changes rarely.

There _is_ a tidiness point buried here — `canonNameById` is a strict projection of
`canonById` and one Map would serve both — but that is dead weight, not latency,
and it is a two-line change in one page. Not worth a perf issue.

### A3-014 — `isKeyPending` runs `Array.find` per selected key

**CONFIRMED as fact. REFUTED as a defect at current sizes.**

`apps/web-pwa/src/routes/admin/CatalogPage.svelte:394-405` — `isKeyPending` scans
`$canonItems` (281) or `$productForms` (14), and `selectedPendingKeys` at `:405`
calls it for every selected id on every selection change. Selecting 50 rows is
~15,000 comparisons — sub-millisecond. Worth revisiting only if canon reaches the
low thousands; #410's projection work is where that threshold gets decided.

### A4-012 — `filterFn` does `$canonItems.find(...)` per candidate per keystroke

**CONFIRMED, and this is the one UI finding with a shape that actually gets worse.**

- `apps/web-pwa/src/routes/shopping/ShoppingListPage.svelte:330`
- `apps/web-pwa/src/routes/canon/CanonCreatePage.svelte:31`

Both build `comboItems` from the full `$canonItems` store and then, inside
`filterFn`, scan `$canonItems` again to recover the item's synonyms. The Combobox
calls `filterFn` once per candidate per keystroke, so the cost is
**O(N²) = 281² ≈ 79,000 comparisons per keystroke** and rises quadratically with
canon size.

The fix is one line of hoisting — a `$derived` `Map<string, CanonItem>` outside
`filterFn` — and it is genuinely the right shape rather than a micro-optimisation.
Still: measure before claiming a felt improvement; 79k trivial comparisons is
likely still ~1 ms.

### C3-013 — `timerDeliveries` has three producers, no deleter, TTL or sweep

> **Resolved by #1008 — see [`docs/runbooks/ttl-policies.md`](runbooks/ttl-policies.md).**
> `timerDeliveries` now carries an `expiresAt` `Timestamp` and a 14-day TTL; the
> write-shape blocker described below is gone. Everything that follows is the
> point-in-time record and is left as measured.

**CONFIRMED. And it does not belong in this issue.**

Confirmations:

- Three writers, one collection: `onCookTimerDispatch.ts:255`,
  `onBatchStageDispatch.ts:124`, `onKitchenTimerDispatch.ts:187`.
- `firestore.rules:371` — `allow read, write: if false`. No client ever reads it,
  so **no subscription touches it at all**.
- No `delete`, no scheduled sweep, no TTL configuration anywhere in the repo.
- Staging: **23 documents**. Dev: 23.

One extra fact that is not in the finding and matters for whoever fixes it: the
ledger writes `{ deliveredAt: Date.now(), … }` — an **epoch-millisecond integer**,
not a Firestore `Timestamp`. A Firestore TTL policy can only hang off a Timestamp
field, so "just turn on TTL in the console" is not available: the write shape has
to change first (or an `expiresAt: Timestamp` be added), which is a production
data-shape change with its own back-compat question.

**Scope verdict: OUT-OF-SCOPE.** There is no query to narrow and no loop to
shorten. Nothing about it becomes easier or harder by changing a subscription. It
is a retention/lifecycle issue that happens to have been found by the same sweep.
Own issue. Growth is roughly one document per timer that actually fires — order
hundreds per year at five users — so it is genuinely unbounded but not urgent.

---

## 2. Per-collection: is unbounded correct?

Counts are **live aggregation `count()` reads taken 2026-08-24** against staging
(`s2-stage-ccb22`) via the `firebase-staging` MCP server, cross-checked against dev
(`s2-dev-eggman`). Both non-prod environments are populated by
`scripts/restore-firestore.mjs` from production, and they agree closely
(recipes 64/64, canonItems 281/277, chatSessions 76/71), so these are the best
available proxy for prod. **There is no prod MCP server**, so no prod figure is
quoted as fact.

| #   | subscription                   | collection                  | bound today                      | attach scope              | staging N              | verdict                                                                                                                                                                                                                                                            |
| --- | ------------------------------ | --------------------------- | -------------------------------- | ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `subscribeAisles`              | `canonData/aisles`          | single document                  | app-lifetime              | 1 doc                  | **not a collection read.** One doc holds the whole aisle array. Correct.                                                                                                                                                                                           |
| 2   | `subscribeBatches`             | `batches`                   | none                             | page (`BatchListPage`)    | 0 (collection absent)  | **correct unbounded.** Bread batches; expect tens, page-scoped. Revisit if #778 phases 03–05 land and it becomes a log.                                                                                                                                            |
| 3   | `subscribeBatchObservations`   | `batches/{id}/observations` | `orderBy('at')`                  | page (`BatchDetailPage`)  | n/a                    | **correct.** Path-bounded to one run.                                                                                                                                                                                                                              |
| 4   | `subscribeCanonItems`          | `canonItems`                | none                             | app-lifetime              | **281**                | **deliberately unbounded — do not add a `limit`.** The whole canon _is_ the client-side matching index, and offline matching needs all of it. A bound would break matching, not speed it up. Size gate tracked at #410.                                            |
| 5   | `subscribeChatSessions`        | `chatSessions`              | `where(ownerUid)`                | **app-lifetime, at auth** | **76, never expiring** | **DEFECT at the time — resolved by #1008** (TTL sweep; see §1 A5-012 and §4 Stage 2). Was the only unbounded-growth, app-lifetime, fat-document read.                                                                                                              |
| 6   | `subscribeMyCookSessions`      | `cookSessions`              | `where` + `orderBy` + `limit(5)` | app-lifetime              | 1                      | **already bounded.** The reference implementation.                                                                                                                                                                                                                 |
| 7   | `subscribeEquipmentIcons`      | `equipmentIcons`            | none                             | app-lifetime              | 20                     | **correct unbounded.** Bounded by the equipment manifest (one doc, ~19 items). Permanently tiny.                                                                                                                                                                   |
| 8   | `subscribeKitchenMemories`     | `kitchenMemories`           | none                             | page (`ChatMemoryPage`)   | **1**                  | **correct unbounded.** Hand-written notes; tens forever.                                                                                                                                                                                                           |
| 9   | `subscribeKitchenTools`        | `kitchenTools`              | none                             | app-lifetime              | 2                      | **correct unbounded.** Permanently tiny.                                                                                                                                                                                                                           |
| 10  | `subscribeMembers`             | `members`                   | none                             | app-lifetime              | 5                      | **correct unbounded, permanently.** It is a household. CLAUDE.md is explicit.                                                                                                                                                                                      |
| 11  | `subscribeProductForms`        | `productForms`              | none                             | app-lifetime              | 14                     | **correct unbounded.** Grows with canon at ~5% of its rate.                                                                                                                                                                                                        |
| 12  | `subscribeRecipes`             | `recipes`                   | none                             | app-lifetime              | **64**                 | **unbounded is correct — a `limit` is the wrong fix.** The list, the planner picker, search, Mine and cook all need every recipe. But it is the heaviest schema in the app (§3) and "several hundred expected", so this is the collection `docChanges()` is _for_. |
| 13  | `subscribeShoppingDaysInRange` | `shoppingDays`              | `documentId()` range             | app-lifetime              | 4                      | **already bounded** to the planner's week.                                                                                                                                                                                                                         |
| 14  | `subscribeShoppingListItems`   | `shoppingLists/{id}/items`  | subcollection path               | page                      | 3 total                | **correct.** Path-bounded to one list.                                                                                                                                                                                                                             |
| 15  | `subscribeShoppingLists`       | `shoppingLists`             | none                             | app-lifetime              | 4                      | **correct unbounded.** Permanently tiny.                                                                                                                                                                                                                           |

**Summary: 1 defect, 1 collection where the answer is `docChanges()` rather than a
bound, 1 deliberately unbounded by design, 12 already correct.** The issue's
"eleven subscriptions need bounds" does not survive the data.

Other counts taken at the same time, for context: `canonEmbeddings` 281 (server-only,
#410), `guidedPlans` 2, `mealPlans` 12, `pushSubscriptions` 4, `timerDeliveries` 23,
`cookSessions` 1, `equipmentManifest` 1.

---

## 3. The measurement baseline

### What was measured, and why this harness

The claim under test is "every snapshot re-`safeParse`s every document". The cost
of that is _entirely_ inside `parseDocuments` (`schemaParsing.ts:63`) — the
Firestore transport, the cache and the listener are identical either way, because
`docChanges()` is a view over a snapshot the client has already materialised. So a
Vitest harness over `parseDocuments` with N synthetic documents measures the exact
quantity the fix changes, **needs no emulator**, and is deterministic enough to
re-run and compare.

It does _not_ measure: bytes on the wire (unchanged by `docChanges()`), Firestore
read billing (unchanged), or Svelte re-render cost downstream (a separate question
— see the object-identity note in §4).

### Numbers (measured 2026-08-24, darwin 25.5.0, vitest 4.1.10, Node in-thread pool)

`RecipeSchema`, fixture = 12 ingredients + 12 steps + metadata + image (comparable
to real staging recipes, which run 11–23 steps):

| N                      | ms per snapshot | µs per document |
| ---------------------- | --------------- | --------------- |
| 1                      | 0.0391          | 39.05           |
| 10                     | 0.1949          | 19.49           |
| **64 (staging today)** | **1.3074**      | 20.43           |
| 100                    | 2.1638          | 21.64           |
| 250                    | 5.4244          | 21.70           |
| **500 (projected)**    | **10.5781**     | 21.16           |
| 1000                   | 22.0488         | 22.05           |

`CanonItemSchema`, fixture = 3 synonyms, no embedding:

| N                       | ms per snapshot | µs per document |
| ----------------------- | --------------- | --------------- |
| 1                       | 0.0015          | 1.47            |
| 10                      | 0.0095          | 0.95            |
| 100                     | 0.0884          | 0.88            |
| **281 (staging today)** | **0.2508**      | 0.89            |
| 500                     | 0.4449          | 0.89            |
| 1000                    | 0.8827          | 0.88            |
| 2000                    | 1.8106          | 0.91            |

Cost is linear in N, as expected, at **~21 µs per recipe** and **~0.9 µs per canon
item**. The recipe schema is ~24× heavier per document than canon — that difference
is where the whole finding lives.

### The formula

For a collection of N delivered documents receiving a change to k documents:

```
safeParse calls per snapshot,  today          = N
safeParse calls per snapshot,  docChanges()   = k        (k = 1 for one document changed)
                                               = N        on the FIRST snapshot only
over a burst of M writes:      today          = M × N
                               docChanges()   = M × k  ≈ M
```

Applied to the real N from §2, one document changed:

| collection            | N   | today                | after              | speed-up              |
| --------------------- | --- | -------------------- | ------------------ | --------------------- |
| `recipes` (staging)   | 64  | 64 parses, 1.307 ms  | 1 parse, 0.039 ms  | **33×**               |
| `recipes` (projected) | 500 | 500 parses, 10.58 ms | 1 parse, 0.039 ms  | **271×**              |
| `canonItems`          | 281 | 281 parses, 0.251 ms | 1 parse, 0.0015 ms | **167×**              |
| `productForms`        | 14  | 14 parses            | 1 parse            | negligible either way |
| `members`             | 5   | 5 parses             | 1 parse            | negligible either way |

**The burst case is the one that matters.** A recipe import is not one write: the
create is followed by `onRecipeWritten` write-backs (thumbnail, kit, canonicalised
ingredients), so call it M = 4 snapshots. Today, at staging size, that is
`4 × 1.307 = 5.2 ms` of main-thread parse; at 500 recipes it is **42 ms**, or about
2.5 dropped frames, every import. After the fix both are ~0.16 ms.

**Honest reading: this is not a user-visible defect today at N = 64.** It is a
mechanism that gets 8× worse as the library grows to the size Daniel expects, and
the fix is one function. That is a good trade, not an emergency.

### How to reproduce exactly

Save the file below to
`packages/adapters/firebase-sync/tests/_bench939.test.ts`, run

```
npx vitest run --project @salt/firebase-sync tests/_bench939.test.ts
cat tmp/bench939.txt
```

then **delete the file** (it is a measuring instrument, not a test — it asserts
nothing about behaviour and would be dead weight in the suite). `tmp/` is
gitignored. Re-run it unchanged after the fix, with `parseDocuments` replaced by
whatever the new code path is, and compare the same N values.

```ts
/* TEMPORARY #939 baseline harness — do not commit. */
import { describe, it, expect } from 'vitest';
import { RecipeSchema, CanonItemSchema } from '@salt/domain/schemas';
import { parseDocuments, type ReadableDoc } from '../src/schemaParsing.js';

function recipeDoc(i: number): Record<string, unknown> {
  return {
    id: `r-${i}`,
    schemaVersion: 1,
    kind: 'recipe',
    title: `Recipe ${i}`,
    description: 'A dish that exists to be parsed.',
    ingredients: [
      {
        id: `g-${i}`,
        name: null,
        items: Array.from({ length: 12 }, (_, k) => ({
          id: `ing-${i}-${k}`,
          rawText: `${k + 1} tbsp of ingredient number ${k}`,
          parsed: {
            quantity: { type: 'single', value: k + 1 },
            unit: 'g',
            item: `ingredient ${k}`,
            preparation: ['chopped'],
            notes: null,
            displayText: null,
          },
          canonId: `canon-${k}`,
          matchState: 'matched',
          isOptional: false,
          firstUsedInStepId: null,
        })),
      },
    ],
    steps: Array.from({ length: 12 }, (_, k) => ({
      id: `s-${i}-${k}`,
      text: `Step ${k}: do the thing, then wait for it to be done properly.`,
      timer: k % 3 === 0 ? { durationMinutes: 10, description: null } : null,
      note: null,
    })),
    metadata: {
      servings: 4,
      totalTimeMinutes: 60,
      prepTimeMinutes: 20,
      cookTimeMinutes: 40,
      tags: ['comfort', 'bake', 'vegetarian'],
    },
    source: { type: 'manual' },
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    image: { url: 'https://example.invalid/i.webp', source: 'ai' },
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    createdBy: 'Daniel',
    lastEditedBy: 'Daniel',
  };
}

function canonDoc(i: number): Record<string, unknown> {
  return {
    id: `c-${i}`,
    schemaVersion: 5,
    name: `canon item ${i}`,
    synonyms: [`syn-a-${i}`, `syn-b-${i}`, `syn-c-${i}`],
    aisleId: 'produce',
    thumbnail: 'https://example.invalid/t.webp',
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

const asDocs = (make: (i: number) => Record<string, unknown>, n: number): ReadableDoc[] =>
  Array.from({ length: n }, (_, i) => {
    const data = make(i);
    return { id: String(data['id']), data: () => data };
  });

function timeMs(fn: () => void, reps: number): number {
  for (let i = 0; i < 5; i++) fn(); // warm-up
  const t0 = performance.now();
  for (let i = 0; i < reps; i++) fn();
  return (performance.now() - t0) / reps;
}

describe('#939 baseline: whole-snapshot re-parse cost', () => {
  it('measures parseDocuments over N docs vs 1 doc', async () => {
    const id = <T>(x: T): T => x;
    const rows: string[] = [];
    const cases: Array<
      [
        string,
        typeof RecipeSchema | typeof CanonItemSchema,
        (i: number) => Record<string, unknown>,
        number[],
      ]
    > = [
      ['RecipeSchema (recipes)', RecipeSchema, recipeDoc, [1, 10, 64, 100, 250, 500, 1000]],
      [
        'CanonItemSchema (canonItems)',
        CanonItemSchema,
        canonDoc,
        [1, 10, 100, 281, 500, 1000, 2000],
      ],
    ];
    for (const [label, schema, make, ns] of cases) {
      const probe = schema.safeParse(make(0));
      expect(probe.success, `${label} fixture must parse`).toBe(true);
      for (const n of ns) {
        const docs = asDocs(make, n);
        const reps = n >= 500 ? 20 : n >= 100 ? 100 : 500;
        const ms = timeMs(() => {
          parseDocuments(docs, schema as never, label, id);
        }, reps);
        rows.push(
          `${label}\tN=${n}\t${ms.toFixed(4)} ms/snapshot\t${((ms / n) * 1000).toFixed(2)} us/doc`,
        );
      }
    }
    (await import('node:fs')).writeFileSync('tmp/bench939.txt', rows.join('\n'));
  }, 300_000);
});
```

### The one measurement that does need the emulator

The parse count per snapshot in a _real_ listener — i.e. proving that
`docChanges()` actually fires with `k = 1` and not `k = N` on an ordinary
single-document write — can only be observed against Firestore. **This worktree is
a linked worktree, so `scripts/host-guard.mjs` refuses `pnpm test:emulator`, and I
did not run it.** The command a host-owning session should run is:

```
pnpm test:emulator                      # runs the whole emulator suite
```

and the file to watch is
`packages/adapters/firebase-sync/tests/subscriptionContract.emulator.test.ts`.
A cheap way to turn it into a number: wrap `schema.safeParse` in a counting spy
inside a throwaway emulator test, write one document into a 20-document
collection, and assert the count is 1 rather than 20.

---

## 4. Staged implementation plan

Ordered by value per unit of risk. The through-line: **this issue is four
unrelated changes wearing one hat, and only the first two belong on this branch.**

### Stage 1 — `docChanges()` in `subscribeCollection.ts` — THIS BRANCH, first commit

> **Done — landed in #984.** The regression guard is
> `packages/adapters/firebase-sync/tests/snapshotParseCount.test.ts`. What follows
> is the plan as written.

**The single highest-value change, and the only one I would make first.**

One function, `subscribeCollection.ts:78-90`. Keep a per-listener cache of parsed
documents and apply `snap.docChanges()` to it instead of re-walking `snap.docs`.
All fourteen collection subscriptions benefit for free; a new collection inherits
it.

Three things stop this being the one-liner the issue calls it, and each needs
stating in the commit message:

1. **Order must be preserved by index, not by insertion.** `parseDocuments`
   currently delivers `snap.docs` order, which is query order — load-bearing for
   `subscribeBatchObservations` (`orderBy('at')`) and `subscribeMyCookSessions`
   (`orderBy('updatedAt','desc')`). The correct pattern is to splice the cached
   array using each change's `oldIndex`/`newIndex`, which is exactly what those
   fields exist for. A `Map`-keyed cache rebuilt in insertion order would silently
   reorder those two. Expect ~40 lines, not 1.
2. **Object identity becomes stable across snapshots.** Today every snapshot
   produces fresh objects; with a cache, an unchanged document is delivered as the
   _same_ object reference. That is a net win for Svelte (fewer downstream
   invalidations) but it is a behaviour change, and any consumer that mutates a
   delivered object in place would now be mutating the cache. Worth a `grep` before
   landing. Note `canonSubscription.ts:31` is the only `project` that allocates
   (`{...item, embedding: null}`) — it will now allocate once per document rather
   than once per snapshot, which is the point.
3. **Rejected documents must stay rejected.** A document that fails `safeParse` is
   skipped today on every snapshot and logged every time. With a cache it is
   skipped once and logged once — which is _better_, but the contract test asserts
   the log happened at all (`schemaParsing.ts:41`), not how often, so this stays
   green.

**Characterisation rows that redden: predicted NONE.** `docChanges()` changes _how_
the delivered set is computed, not _what_ it is, and the net asserts delivered sets
(`toEqual` over id lists) plus the rejection log. All 15 collection rows and all 13
document rows should stay green. **If a row does redden, that is a real behaviour
change and must be treated as one — not test-edited away.** So per the #931 house
pattern there is no companion net commit here; the absence of one is the claim.

Add one _unit_ test alongside (no emulator): a fake snapshot sequence proving the
`safeParse` call count is `N` on the first snapshot and `1` on a single-document
change. That is the regression guard the benchmark cannot be.

### Stage 2 — bound `chatSessions` — THIS BRANCH, second commit, but ASK FIRST

> **Superseded by #1008 — not an open decision.** The growth this stage set out to
> bound is now swept by a Firestore TTL policy on `chatSessions.expiresAt` (see
> [`docs/runbooks/ttl-policies.md`](runbooks/ttl-policies.md) for which projects are
> armed). No `limit()` was added. What TTL does not cap is the size of the
> _in-window_ set — recipe-attached sessions live 540 days — so a subscription-side
> bound would only return as a boot-payload question, on fresh counts, in its own
> issue. The options below are the record of what was weighed.

The one genuine bound defect (§2 row 5). Two candidate fixes, and they are not
equivalent:

- **(a) `orderBy('updatedAt','desc') + limit(N)`.** One line in
  `chatSessionSubscription.ts:49`. **Requires a new composite index** —
  `firestore.indexes.json` has no `chatSessions` entry today; the precedent is the
  `cookSessions` `(ownerUid ASC, updatedAt DESC)` index at `firestore.indexes.json:4`.
  The emulator auto-creates indexes and production does not, so a missing index is a
  green CI and a dead listener in prod. **This is the trap on this change.**
  _And it truncates the chat list_: a recipe you last chatted about 200 sessions ago
  stops showing its conversation on `RecipeViewPage`. That is user-visible, so it is
  Daniel's call, not the implementer's.
- **(b) Move `messages[]` to a subcollection.** Fixes the size problem rather than
  hiding it — the list read becomes tiny and the transcript loads per session. It is
  a production schema migration on real data. **Own issue.**

Recommendation: raise (a) with the truncation consequence stated plainly, propose
`limit(50)` as an opening number, and if the truncation is unacceptable, file (b)
and take nothing on this branch.

**Characterisation rows that redden:** `subscribeChatSessions` is the row that owns
this query. At `limit ≥ 3` its exact-set assertions still pass (the row seeds one
document plus an `alsoDelivers` and a differently-owned decoy), so it should stay
green — but it must be re-run against the emulator before the claim is made, and
the index must be in `firestore.indexes.json` in the same commit.

### Stage 3 — own issue: server-side whole-collection reads (`A3-007`, `C2-009`)

Same _shape_ as #410 — a whole collection read per operation — but server-side and
in `domain`/`cloud-functions`, not in a subscription. `A3-007` is 2–5 × 281-doc
reads per recipe import; `C2-009` is 20 sequential document reads per manifest
write. Both are Firestore billing rather than latency, both are already annotated
in-code as understood trade-offs, and neither shares a line of code with Stages 1–2.
Group them as one "collection reads per server operation" issue.

### Stage 4 — own issue: AI concurrency cap (`C2-002`)

Pure `domain`, needs a stated policy, and the repo already has a precedent going
the other way with a written reason. Nothing to do with queries.

### Stage 5 — own issue (and probably close it): the UI linear scans

`C2-007`, `A1-013`, `A3-014` are churn at N = 64/281 — a map-building change that
adds code to save nanoseconds. `A4-012` is the exception and is worth one line:
hoist a `$derived` `Map` out of `filterFn` in `ShoppingListPage.svelte:330` and
`CanonCreatePage.svelte:31`, removing an O(N²) per keystroke. If any of these ships,
ship only that one, and measure it in the browser rather than asserting it.

### Stage 6 — own issue: `timerDeliveries` retention (`C3-013`)

> **Done — that issue was #1008; resolved by it. See
> [`docs/runbooks/ttl-policies.md`](runbooks/ttl-policies.md).**

Data lifecycle, not query narrowing. The first design question is not "sweep or
TTL" but "`deliveredAt` is an integer, so what field does a TTL policy hang off" —
see §1. Include that in the issue body so the next agent does not rediscover it.

### The chat findings that are product decisions, not perf fixes

Flagged explicitly per the brief:

- **`A5-010` (whole message array per turn)** — truncating history **changes what
  the model sees**. A chef that has forgotten the first half of the conversation is
  a different product, and the saving is real AI spend. Must be Daniel's call, with
  a stated window (e.g. last 20 turns, or a token budget), never a silent slice.
- **`A5-011` (whole kitchen-memory collection per turn)** — the collection holds
  **one document**. There is no perf case at all. If a cap is ever wanted it is for
  prompt discipline, and `kitchenMemoryContext.ts`'s own header explains why the
  read is server-side and complete. Leave it alone.

---

## 5. What to correct on the issue

- "Eleven of fifteen collection subscriptions attach with no `limit`, `where` or
  `orderBy`" → **nine of fourteen** whole-collection reads today (`subscribeAisles`
  is a single-document read; `subscribeShoppingListItems` is path-bounded). The
  `B2-013` finding's own "nine" is correct as stated.
- "`docChanges()` … that is the fix with the widest reach and it is a single
  pattern" → still true, and now literally a single **function**, not a pattern
  repeated 15 times. #928 did that work; #984 then made the change.
- "Subscriptions carry a bound appropriate to the collection" (Done-when) → for
  twelve of the fifteen, the appropriate bound is **none**, and §2 is the written
  record the Done-when asks for.
- `C3-013` should be moved out of this issue entirely.
