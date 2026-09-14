# Domain Modules & Coordinators — Pattern Guide (v1.3)

This document supplements the Salt 2.0 Architecture Contract.
It defines the repeatable pattern for structuring domain modules, enforcing
boundaries, and coordinating cross‑module workflows.

The architecture contract defines layers.
This document defines the shape inside the domain layer.

============================================================

1. Purpose
   \============================================================

Salt's domain layer is intentionally modular. Each domain area is isolated
into its own module with:

- its own entities
- its own commands
- its own queries
- its own ports (published as the module's public interface)

Modules communicate only through each other's **published** ports — never
by reaching into another module's internals.

Cross‑module _workflows_ (flows that mutate two or more modules) are owned
by coordinators.

This pattern ensures:

- strict, machine‑enforceable boundaries
- locality of reasoning (a bug in canon stays in canon)
- consistent shape across modules (predictable navigation)
- clean testing
- long‑term maintainability against AI‑generated drift

Canon is used as the worked example.

============================================================ 2. Domain Module Structure
============================================================

Each domain module follows this structure:

/packages/domain/src/<module>/
entities/
ports/
commands/
queries/
index.ts <-- the module's PUBLIC surface

This is the minimal structure that still provides:

- clear separation of concerns
- predictable navigation
- AI‑safe isolation
- clean test boundaries
- explicit port visibility

`index.ts` re‑exports exactly what other modules and coordinators are
allowed to use:

- published port interfaces
- entity types (when other modules legitimately need to pass them)
- nothing else

Anything not re‑exported from `index.ts` is internal and off‑limits to
other modules.

**Value objects** live in `entities/` alongside the entity that owns them.
There is no dedicated `value-objects/` folder. If a module ever
accumulates 5+ value objects, revisit and consider splitting then — not
preemptively.

============================================================ 3. Module Boundaries
============================================================

The boundary rule is precise:

- A module **may** import another module's **published** port interfaces
  (via `<module>/index.ts`).
- A module **may not** import another module's internals — entities,
  commands, queries, port implementations, or any file under that
  module's subfolders.
- A module **may not** depend on a coordinator.

Allowed example:
recipe/commands/parseRecipe.ts
imports `findClosestMatch` from `domain/canon` (the index)

Forbidden examples:
recipe importing from `domain/canon/commands/...`
recipe importing from `domain/canon/entities/...`
recipe importing a coordinator
canon importing anything from recipe or shopping

Boundaries are enforced by:

- ESLint rules (no-restricted-imports patterns on subpaths)
- tsconfig project references where applicable
- commit gateway checks (CI)

The point of these rules is mechanical, not philosophical: they exist so
that AI agents and humans cannot drift across boundaries without the
build catching it.

============================================================ 4. Ports (Interfaces)
============================================================

Ports are interfaces a module owns and publishes. They describe either

- what the module needs from infrastructure (e.g. `CanonStorePort`), or
- what the module offers to other modules (e.g. `CanonLocalStorePort`).

Canon example:

CanonStorePort
save(canonItem)
load(canonId)
list()
delete(canonId)

CanonLocalStorePort
save(canonItem)
list()

Ports:

- live inside the owning module's `ports/` folder
- are re‑exported from the module's `index.ts`
- are implemented by adapters (for infrastructure) or by the module's
  own commands/queries (for module‑offered ports)
- are consumed by other modules and by coordinators
- never contain business logic

The port is the contract. Everything else in the module is replaceable
behind that contract.

============================================================
4.1 Cross‑Cutting Ports
============================================================

Most ports belong to a specific module: they are defined inside that
module's `ports/` folder and re‑exported from its `index.ts`.

Some ports are **cross-cutting**: they are not owned by a single module
and serve system‑wide concerns. These live directly in
`/packages/domain/src/` and are re‑exported from `domain/index.ts`.

Current cross‑cutting ports:

ErrorReportingPort
report(error: unknown, category?: DomainError['kind']): void

MatchLoggingPort
logMatch(entry: MatchLogEntry): void

Cross‑cutting ports:

- are implemented by adapters (e.g. observability
  solutions)
- are used by multiple modules or by the entire domain layer
- address concerns that do not fit a single module's responsibilities
- must be documented in this file (here)
- must be re‑exported from `domain/index.ts`
- follow the same naming and implementation contracts as module ports

Example:
Canon module may call `ErrorReportingPort` to report a matching failure.
Shopping module may call it separately.
The port itself belongs to neither module — it is shared infrastructure.

Composition note: `@salt/observability` ships two subpath entrypoints. The
default subpath implements `ErrorReportingPort` and `MatchLoggingPort` using
the browser PostHog SDK (`posthog-js`) and is bundled into `web-pwa`. The
`@salt/observability/server` subpath implements `MatchLoggingPort` for
Cloud Functions using `posthog-node` + native OpenTelemetry; CF spans export
to GCP / Firebase Monitoring via `enableFirebaseTelemetry()`.
`firebase-functions/logger` is used additively on the CF side for top-level
summary logs to Cloud Logging.

============================================================ 5. Coordinators (Cross‑Module Workflows)
============================================================

Some operations span multiple modules. When a flow mutates two or more
modules, the orchestration lives in a coordinator.

Example:
"Add ingredient to shopping list → canonicalise → update list"

This touches the shopping module and the canon module. Neither should own
the orchestration; both should remain focused on their own concerns.

/packages/domain/src/coordinators/
addIngredientToList.ts
canonicaliseRecipeIngredients.ts

Coordinators:

- sequence operations across modules
- own cross‑module **failure semantics** (what happens if canon succeeds
  but shopping fails, retries, compensations, partial‑state handling)
- do not define entities, value objects, or domain invariants
- do not own data
- may import any module's published surface

Coordinators are not a goal. They are a tool for flows that genuinely
need cross‑module orchestration.

**Do not write a coordinator preemptively.** A coordinator that wraps a
single port call adds friction without value. Add a coordinator the first
time a flow actually mutates two modules. If the flow is "look up X from
canon, then do recipe stuff," recipe should call `findClosestMatch`
directly — that is exactly what published functions are for.

============================================================ 6. Worked Example: Canon Module
============================================================

Canon is the smallest module with the clearest dependencies.
It is also the **canonical sync exemplar**: it owns two entities with
different shapes (items and aisles) that both use the manifest-driven
local-first ↔ Firestore sync pattern. When implementing sync for a new
module (e.g. recipes), copy this pattern verbatim.

6.1 Responsibilities
--------------------

Canon owns:

- canonical ingredient definitions
- synonyms
- aisle classification
- canonicalisation rules

Canon does not know:

- recipes
- shopping lists
- UI
- Firebase
- browser storage (IndexedDB, localStorage, etc.)

6.2 Ports
---------

Canon exposes the following ports via its `index.ts`:

CanonLocalStorePort
in-memory cache for canon items — backs live Firestore subscriptions in
the web client (web-pwa) and read-through reads in the cloud-functions
matcher

CanonSyncTransportPort
pull/subscribe for canon items — implemented by @salt/firebase-sync

AisleLocalStorePort
in-memory cache for the aisles document — same pattern as above

AisleSyncTransportPort
pull/subscribe for the aisles document — implemented by @salt/firebase-sync

Firestore is the live data layer: clients subscribe directly to the
canon collections and the aisles document, and offline reads/writes are
handled by Firestore's `persistentLocalCache`. There is no separate
manifest document, no per-scope revision counter, and no app-managed
cursor — the SDK owns durability.

Canon also exports lookup functions directly — `findClosestMatch` and
`normaliseName` — which other modules call without a wrapping port
interface.

6.3 How Other Modules Use Canon
-------------------------------

Recipe module:
imports `findClosestMatch` from `domain/canon`
calls it directly

Shopping module:
imports `normaliseName` from `domain/canon`
calls it directly

Neither module reaches into canon's internals. Both import only from
canon's published `index.ts` surface.

6.4 Coordinator Example
-----------------------

A coordinator handles a flow that mutates both canon and shopping:

addIngredientToShoppingList(rawName):
match = canonLookup.findClosestMatch(rawName)
if no match:
newCanon = canonCommands.createCanonItem(rawName)
match = newCanon
shoppingCommands.appendItem({ canonId: match.id, rawName })

This coordinator:

- creates new canon state (write to canon)
- adds to the shopping list (write to shopping)
- owns the failure semantics if either step fails

A simpler "recipe needs canonical name" lookup is **not** a coordinator —
it is a direct port call from recipe.

============================================================ 7. Rules Derived From This Pattern
============================================================

1. Modules communicate only through published ports.
   The `index.ts` of each module is the public surface. Subpath imports
   into another module's folders are forbidden.

2. Each module defines and publishes its own ports.
   Ports describe what the module needs or offers, not how it's implemented.

3. Coordinators handle flows that mutate two or more modules.
   Add them when needed; do not write them speculatively.

4. Coordinators may contain orchestration and failure handling, but
   never entity definitions, validation rules, or domain invariants.

5. Adapters implement infrastructure ports.
   Adapters may depend on multiple modules; modules never depend on
   adapters or on coordinators.

6. UI calls commands, queries, and coordinators.
   UI never calls adapters directly.

7. Domain remains pure.
   No Firebase, no IndexedDB, no browser APIs, no side effects.

8. AI agents should work within a single module per task.
   Cross‑module changes should explicitly touch a coordinator (or add
   one). This is a guideline; the boundary rules above are what's
   actually enforced.

============================================================ 8. Summary
============================================================

This document defines the repeatable pattern for domain modules:

- isolated modules with consistent shape
- explicit, published ports as the only cross‑module surface
- coordinators for genuine cross‑module workflows
- adapters implementing infrastructure ports
- UI calling domain, not infrastructure

Canon is the worked example, and what generalises from it is the **boundary
discipline**, not the folder tree: §3's boundary rule and §7's derived rules hold for
every module, with the module's own `index.ts` as its only cross-module surface. The
**shape varies** — canon's `entities/ports/commands/queries` is its full form, not a
floor, and most modules carry fewer of those subfolders or none at all; the lightweight
variants written up below are what that looks like in practice.

The list of modules is the `packages/domain/src/` directory listing itself, minus the
three names the boundary lint excludes — `schemas/`, `coordinators/` and
`__boundary_tests__/` — which is where that lint derives its own rules from rather than
from a hand-maintained copy (issue #914). The write-ups below cover the modules whose
shape needed explaining; a module with no entry here is not an exception, only
unremarkable.

The `weather` module is a lightweight variant — pure classification utilities
(`weatherIcon`, `classifyEatingMood`, `temperatureBand`, `weatherSeverity`,
`aggregateForecastWindow`) with no write operations or adapter ports; schemas
(`WeatherForecastSchema`, `WeatherDaySummarySchema`) follow the standard
`@salt/domain/schemas` convention.

The `shoppingDay` module is a lightweight variant — pure, runtime-neutral
helpers over the `shoppingDays/{YYYY-MM-DD}` collection (issue #629):
`shopDayForWeek` (the one-shop-per-week reducer), `dateInZone`,
`addCalendarDays`, `daysBetween`, `tomorrowInZone` (UTC date-only
arithmetic so a 23- or 25-hour local day cannot round the answer off), and
`shopDayHeadline` (issue #1054) — the one rendering of "Shopping tomorrow
AM" / "Shopping Sat PM", shared by the shopping list page and the daily
push reminder, two apps that cannot import each other. The pre-shop shading
predicate `isBeforeShop` was deleted in #923 — it had no reader anywhere in
the repo.
No entities, commands, queries, or ports subfolders — flat, matching the `weather`
pattern. The doc shape (`ShoppingDaySchema`) lives in `@salt/domain/schemas`.
No I/O, no clock (CLAUDE.md Rule 1): every date and timezone is injected.

The `cookSession` module is a similar lightweight variant — pure session-state
producers (`makeFreshSession`, `withStepDone`, `withIngredientChecked`,
`withAllIngredientsChecked`, `withGroupChecked`, `withTimerStarted`, `withTimerDismissed`) and
read-only queries (`firstIncompleteStepId`, `firstUseByStep`, `miseProgress`,
`timerProgress`, `hasRecipeChanged`, `formatClock`, `timerHeat`, `heatWantsAttention`)
extracted from `CookModePage.svelte` so the cook-session logic is testable
without a browser. `timerHeat` (issue #843) is the one decision behind a
countdown's urgency — `resting → soon → imminent → ringing`, monotonic — so
My Kitchen's dial, stripe and state word all read the same answer instead of
each inferring their own.
Flat structure — no `entities/`, `ports/`, `commands/`, or `queries/`
subfolders, matching the `weather` pattern. Every timestamp is an injected
parameter (never read from the clock), which keeps the module pure and makes
the timer tests deterministic. The same rule is why `withTimerStarted` takes the
whole timer entry (`withTimerStarted(session, timer)`) rather than a growing list
of positional arguments: since issue #748 a timer carries its own `id`, a
nullable `stepId`, a `label` and the `durationMinutes` it was actually started
for, and every one of those — including the id — is minted by the caller. `id`,
not `stepId`, is a timer's identity: it is what `withTimerStarted` replaces on
and what `withTimerDismissed` keys on.

The `kitchenTimer` module (issue #842) is a lightweight variant, a sibling of
`cookSession` for a timer that belongs to nobody's cook: two pure producers,
`withKitchenTimerStarted` and `withKitchenTimerDismissed`, over the per-user
`kitchenTimers/{uid}` document's `timers[]` array. It deliberately does not
re-export timer-shaped copies of `cookSession`'s `timerHeat`, `timerProgress` or
`formatClock` — a standalone timer's `endsAt` and duration read exactly like a
cook timer's, so importing those existing pure queries is what keeps the two
surfaces from ever disagreeing about what "imminent" means, rather than giving
drift a second copy to happen in. `withKitchenTimerStarted` also prunes: a fired
timer rings until dismissed by design (no tombstone — CLAUDE.md's no-soft-delete
rule applies to an array entry same as a document), but one still ringing more
than a day later is swept on the next start, the only moment the document is
already in hand and free to tidy. Flat structure, no `entities/`, `ports/`,
`commands/` or `queries/` subfolders, matching the `weather` pattern. No clock
read internally (CLAUDE.md Rule 1): `endsAt` and `nowMs` are both injected by
the caller.

The `personalView` module — the projections behind "Kitchen" — is another
lightweight variant, and its history is the useful lesson here, because
it has been **deleted and re-created**, and both moves were right.

It began as four projections behind "Mine" (#634); #682 cut the page back to
_what of mine is running right now, and what needs a look_, and the three that
were restating the planner and the shopping list (`chefDaysForMember`,
`unshoppedPlannedRecipes`, `rankPersonalCards`) went with the sections they fed.
That left one predicate, `needsReview`, which inferred "nobody has saved this"
from `updatedAt === createdAt` — real policy, complete with a `kind` gate
expressed through `isCookable`.

#755 phase 1 deleted `needsReview`, and with it the whole module, because the
inference was answering a question the data already answered outright.
`needs_approval` is a stored flag, set by the import flows and read by the recipe
page's banner and the list's pill; deriving a _second_, disagreeing notion of
"unreviewed" alongside it gave the app two review concepts and gave the derived
one no clear action short of an editor round-trip. Once `/mine` filters on the
flag, the policy is a field comparison — `r.needs_approval === true` — and a field
comparison is not policy. It lives in `personalViewService` with the store that
reads it, and the `kind` gate went with the predicate: only the import flows set
the flag, so there is nothing to gate.

Phase 3 of the same issue re-created the module, starting with one export,
`upcomingChefDays(weeks, memberId, today)`. It is deliberately **not**
`chefDaysForMember` restored — that helper was `week.days` filtered on
`chefs.includes(memberId)`, a restatement of a week the planner already draws, and
#682 was right to remove it. What `upcomingChefDays` decides is the **window** and
the **span**: a member's own nights are a run forward from today that does not
stop at the end of a cycle, so it takes an _array_ of weeks and answers across
them in one date-ordered list. The planner cannot render that — it renders weeks —
and the caller gets no merge step, no boundary bookkeeping and no second notion of
"which week is this row from". Two further decisions ride on it: an empty
`memberId` matches nothing rather than everything (a screen claiming every night
was yours is worse than one claiming none), and membership is chef-only — a chef
need not be an attendee, and filtering on attendance would silently drop exactly
the nights where you cook for a table you are not at. Pure by contract: `today` is
injected, and the helper iterates each week's **stored** date keys rather than the
seven its start implies, so a document written before `firstDayOfWeek` moved
cannot produce holes.

Issue #843 added a second export, `dayForDate(weeks, date)`, and it is a
sibling of `upcomingChefDays`, not a special case of it: `upcomingChefDays`
answers "which nights are mine", filtered on chef membership, while
`dayForDate` answers "what is happening on this date" for anybody. My
Kitchen's quiet screen leads with tonight's dinner regardless of who is
cooking it — filtering by chef would blank the screen on exactly the
evenings someone else has it covered. Same date-key and first-week-wins
rules as `upcomingChefDays`, for the same reasons.

The `memory` module is a lightweight variant in the same mould: one file,
`parseChatCommand`, which reads a chat composer line as the app's one chat
command — `/remember <text>` — by string comparison, not a classifier, so
capture is free, instant and costs no model call. No `entities/`, `ports/`,
`commands/` or `queries/` subfolders, matching the `weather` pattern.
Deliberately not a general slash-command registry: a registry would be
scaffolding kept warm for commands nobody has asked for, and there is exactly
one. The feature it serves — the household's standing notes for the chef,
`kitchenMemories/{id}` — is documented in
[ai-kitchen-assistant.md](ai-kitchen-assistant.md) (issue #816).

The `library` module (epic #1372, issue #1377) is a lightweight variant — the pure
half of the chef's kitchen-notes tools: `libraryPageSummary` (a page's opening
prose, derived at call time and never stored, so there is no second source of
truth for it alongside the document body) and `searchLibraryPages` (a keyword
filter, not a ranking — a library is tens of pages, not the hundreds `searchRecipes`
scores). No `entities/`, `ports/`, `commands/` or `queries/` subfolders, matching
the `weather` pattern; the page schema, the revision cap and `pushRevision` live in
`schemas/libraryPage.ts` with the document they describe, because this module
reads a page rather than shaping one. The feature it serves — the chef reading and
writing the household's own reference notes — is documented in
[ai-kitchen-assistant.md](ai-kitchen-assistant.md) (design principle #1 and
Components §2).

The general rule this illustrates: a domain module earns its place by holding a
_decision_. When the decision collapses into reading a field that is already on
the document, the module is indirection, and the honest move is to delete it
rather than keep an empty barrel warm for a future tenant. Re-creating the
directory later, for a helper that does hold a decision, costs a single commit —
which is the point: a module is kept alive by a tenant, never by the name over
the door.

The goal is not architectural purity. The goal is hard, enforceable
boundaries so that drift — by humans or AI agents — is caught by the
build instead of accumulating into spaghetti.
