# Formulas, schedules and batches

**Status: phases 00 and 01 are built, and phase 02 is landing; ferments, cures
and cultures are still contract.** Epic #778. Built so far: the pure `formula`
module (#782); on top of it, `formulas/{recipeId}` with its rules, adapter,
service and mapping screen at `/recipes/:id/formula` (#806 phase 1); the process
half of that screen — `schemas/process.ts`, the pure `process` module, the
`extractProcessStages` callable, and stage review on the formula screen (#806
phase 2); and, from #812 phase 1, **scaling and the batch**: `resolveSchedule`
(bidirectional, in `process/`), the `batch` module, `batches/{batchId}` with its
rules and adapter, `batchService` as the single write path, the in-flight surface
at `/batches`, and **the entry point the feature had been missing** — "Bake a
batch" and a formula link on the recipe page, both gated on `formula != null`.

A formula screen for a recipe that has never had one was reachable by URL only
through #812; #823 gave it a menu entry point too — "Make it scalable", gated on
the domain's basis guess (`looksScalable`, `formula/guessBasis.ts`) so it only
offers itself on a recipe that looks like it has one. The gate, not the entry
point, is what stops an "add a formula" item putting baker's percentages in
front of every weeknight curry to serve the three loaves. The typed URL remains
the escape hatch for a loaf the guess misses.

One thing about what `process/` holds today is a deliberate absence rather than a
gap: a stage carries **no additions or removals** yet, because nothing produces or
consumes them. What this doc requires is that the shape not preclude them, and a
flat ordered array of stages with stable ids on an optional field of a greenfield
collection does not. Phases 03/04 own that addition.

From #812 phase 2, the **proposal tier exists too**: `proposeSchedule` (the
`pro`-tier callable that restructures a process to land at a target time, emitting
neither timestamps nor grams), the pure `diffProcess` behind the review, and
`withComponentPercentScaled` — the generic seam that turns the flow's leavening
opinion into a percentage through the bounds rail `solveFormula` has enforced
since #782.

Everything below about cultures, ferments and cures is still the contract the
remaining phases are built against, not a description of code that exists. Read it
before designing any part of ferments or cures.

Three hobbies — bread, fermented vegetables, cured meats — look like three
features and are one. All three express quantities as a **percentage of a
declared basis** rather than as absolutes; all three are a **process that runs at
a temperature over hours or weeks** rather than a method you follow at the hob;
and all three are worth **recording as they run**, because what you learn from
batch nine is what makes batch ten good.

The hats still matter — sauerkraut is not dinner, a coppa is not plannable, a
loaf belongs in the recipe library with everything else — but they belong in
copy, icons and library sections. The engine underneath is written once.

## The three nouns

### Formula — composition as ratios against a declared basis

Baker's percentage is the general case, not a special one. A formula names a
**basis** — the set of ingredients whose combined weight is 100% — and every
other ingredient is a percentage of that total.

| Craft              | Basis                        |
| ------------------ | ---------------------------- |
| Bread              | the flours                   |
| Sauerkraut, kimchi | the vegetables               |
| Coppa, salami      | the green weight of the meat |

The basis is itself a small formula (70% strong white / 30% wholemeal;
80% cabbage / 15% carrot / 5% fennel), and that second tier is what lets one
model cover all three. A cure is the degenerate case: one basis member at 100%.

Yield solving hangs off it, and **must be bidirectional from the start**:

- **Target-driven** (bread): "12 × 120 g" → 1 440 g dough →
  `basis = total ÷ (1 + Σ addition percentages)`.
- **Basis-driven** (ferments, cures): you unwrap the meat, it weighs 2.4 kg, and
  everything else follows from that.

Same equation, different unknown. Building only the target-driven direction bakes
"yield is the input" into the types and is awkward to unpick later.

A target yield is **how many, and how many grams each** — `{ count,
unitDoughGrams }`, and nothing else (issue #1274). It carries **no name and no
loss factor**, and both omissions are decisions rather than gaps:

- **No name.** A shipped table of eleven shapes ("900 g tin loaf", "1 kg focaccia
  tray") answered three questions in one string — how much dough, what the thing
  is, what it is baked in — so 900 g could be read as the pan, the dough or the
  cooked bread. The recipe already says it is a ciabatta. The yield does not say
  it again.
- **No bake loss.** A cooked weight is a number nobody can know, it fed no
  arithmetic, and the UK tin convention has already absorbed it: a 900 g tin
  yields Warburtons' 800 g loaf precisely _because_ of the oven loss, so
  modelling it separately was the same sum twice.

**A vessel is a fact about tonight, not about the recipe.** A formula stores the
dough figures alone; the batch records what the run was baked in, as a free-text
snapshot (`BatchSchema.vessel`) that nothing parses and nothing computes from.
The split is not stylistic — a formula's grams stay editable, so a vessel stored
beside them is a second number free to drift into a lie, where `freezeBatch`
stamps a batch's vessel and grams together and neither moves again.

A **named tin needs no coefficient at all**: UK tins are sold by the dough they
take, so a 900 g tin resolves to ~900 g of dough directly. Running one through an
estimate would replace a convention that is already right with one that is not.

**Only a vessel with no trade name uses a coefficient** — a tray, a roasting tin,
a baking dish, described either as a volume or as a length × width with a dough
depth (2 cm by default; a tray is not filled to its walls). There is **one**
coefficient and it works over volume: two — one for deep vessels, one for flat
ones — would disagree by up to 70% on the same tray depending which way the user
described it, which is a trap rather than a refinement. It lives at
`DOUGH_GRAMS_PER_ML` in `packages/domain/src/formula/doughAmount.ts` with its
boundary stated beside it: a domestic starting point, right to ~15% on the two
anchors anyone can check, and not a fact.

**Its result is never load-bearing.** It has one caller — the UI — which writes
the figure into an ordinary editable box the person can type straight over, so the
coefficient never reaches a document and can never become an input to scaling.
That is the deliberate difference from the bake loss deleted above, which _was_
stored and _was_ read back. A locked derived figure would be strictly worse than
bake loss ever was: the same invented number, now load-bearing.

On the batch, the tray path records the vessel it was measured as ("30 × 40 cm
tray") and never the weight — the weight already lives at
`totals.units.unitDoughGrams`, and a second copy is the drift being avoided. So a
run whose suggested weight was typed over still names the tray it was baked in.

A **loss allowance is not forbidden, it is unbuilt.** Trim loss on a pork
shoulder is 10–20%, an order of magnitude from anything in bread; phase 04
(cures) is where that requirement gets stated, and reintroducing a field there is
free on a greenfield collection. What produced the rework was preserving
switched-off machinery against a use case nobody had written down.

All of it is arithmetic. Pure domain, no dependencies.

### Process — ordered stages, each with a temperature and a duration

A stage has an environment (counter 20 °C, fridge 4 °C, chamber 12 °C at 75% RH),
a duration that is either fixed or a function of that temperature, and a
completion criterion that may be **observational** rather than temporal — "until
doubled", "until it tastes right", "until 30% weight loss".

A ferment is this model with one long stage. A cure is this model with three and
a weight-loss criterion. Bread is this model with six short ones.

Three properties that bread alone would not force, and that must be in the shape
from the start:

- **Stages can carry additions.** Bread adds everything at mix; a cure rubs at
  stage one, washes at stage two, cases at stage three; kefir's second ferment
  adds fruit to the already-strained liquid. Formula additions are therefore
  assignable to a stage rather than all landing at mix.
- **Stages can remove or split off.** Kefir strains the grains back out,
  kombucha holds liquid back as next week's starter, sourdough discards. What is
  removed may go back to a culture (see below).
- **Completion may be a criterion, not a time.** Bread's schedule is time-driven
  and predictable. A cure is done at 35% weight loss, which might be day 60 or
  day 95 — so a batch holds an **estimate that observations revise**, not a plan
  of times.

**A stage's link to a recipe step is optional and one-way.** An AI-added fridge
retard corresponds to no step; the bake stage points at the bake step so it can
hand off to cook mode. Required, and added stages have nowhere to live; two-way,
and the batch starts writing back into the recipe. In practice this also decides
what extraction does with a hallucinated step id: it drops the **citation**, not
the stage — a bulk ferment is still a bulk ferment without one. (`generateGuidedPlan`
drops the whole note, correctly, because a note with no step is nothing at all.)

**`active` versus `wait` is defined once and quoted, not paraphrased.** A `wait`
is unattended change — the dough, the ferment or the oven changes on its own and
the cook can leave the room. An `active` stage is one the cook carries out and is
present for. **The bake is `active`; the preheat is `wait`.** The definition lives
in `ProcessStageKindSchema`'s field docs and verbatim in the extraction prompt,
with a test pinning the two together, because the spike labelled the bake
differently on each of three bread recipes purely for want of that sentence.

**A stage may be OPTIONAL, and a run may SKIP one** (issue #1275). `optional` is a
property of the process stage, authored by the extraction pass from the recipe's own
words ("optionally, brush the top with milk") and correctable by hand on the formula
screen. It is **information and gates nothing**: on a run, every stage is skippable
whether it is marked or not. Reading "optional ⇒ skippable, therefore required ⇒ not
skippable" is the obvious inference and it is wrong — the stages most worth knowing
you skipped are exactly the ones the recipe called required.

On the batch, a stage therefore has **four conditions, derived from three nullable
timestamps and never stored as an enum**: `skipped != null` → skipped, else
`actualEndAt != null` → done, else `actualStartAt != null` → in progress, else not
started. `stageStatus` in `domain/src/batch/transitions.ts` is the one derivation.
Skipping re-times the tail through `resolveSchedule` over the **unskipped** remainder
and leaves the skipped stage's own planned times alone; a stage can also be marked
**started** without being marked done, which records overlap without planning it —
the plan stays a strict queue. A skipped stage is filtered out of the reminder
enqueue in `onBatchWritten` and no-opped at dispatch; `remindableStages` stays pure
and planned-only, and its rule is untouched by a skip.

**A recipe with no waits extracts to nothing.** The flow returns the full ordered
list — actives included, because a schedule needs the active time between the
waits — but only for a method that has something to wait for. This is enforced in
the flow rather than asked for in the prompt: a model told to list stages will
always find some, and an invented proof is worse than no process at all.

### Batch — the run

Salt today has recipe (durable, family-shared) → `cookSessions` (transient,
per-user, one evening). This needs formula (durable, family-shared) → **batch**
(durable, family-shared, weeks long, observed).

A batch is **not** a cook session and must not be built on one: wrong ownership,
wrong lifetime, wrong sharing. It:

- is family-shared — either partner may glance at the crock;
- lives for weeks or months;
- **freezes the resolved quantities and the resolved schedule at start**, because
  the formula may be edited afterwards and a batch has to record what was
  actually done or its log is worthless;
- carries an **observation log** — weight, pH, temperature, humidity, a photo, a note;
- records **when it was stopped**, not merely that it was (`abandonedAt`, issue
  #1280). A run given up on at ten past eight on the Sunday is a different story
  from one given up on the Thursday, and `updatedAt` cannot answer it;
- has a second view, **the batch log** (issue #1280) — the start, every stage
  start, completion and skip, every reading and the abandonment, in one ordered
  list. DERIVED by `buildBatchLog` from the fields above and never stored, so
  there is no event stream that can disagree with the plan beside it;
- is the object opened day to day. The formula is opened once a month.

Making the batch first-class is the load-bearing decision. Skip it and everything
else degenerates into optional fields on a recipe, with nowhere for the
day-to-day UX to live.

### Culture — the fourth noun, deferred

Kefir grains, a sourdough starter, a kombucha SCOBY, a vinegar mother, yoghurt
backslopped from the last pot: a living thing that is **not consumed by a batch**
but strained out, reused, and fed on its own rhythm. It has a state (thriving,
sluggish, resting in the fridge), a mass that grows, and reminder needs unrelated
to any particular jar.

The split that keeps this out of the way: **a pre-ferment is a formula concern; a
mother is a culture concern.** A levain built for one bake is a sub-formula and
the formula module already handles it. The jar fed twice a day is an entity.

Nothing in phases 00–04 changes to accommodate it, which is the test of whether
the amendment is clean. There is no sourdough in use today, so bread does not
pull it in — only kefir does, and it may never be built.

## The two verbs

Scaling and adapting are different in kind, and should not look or behave alike —
the user's trust in each is correctly different.

|             | **Scale**                                                          | **Adapt**                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner       | `packages/domain`                                                  | Genkit callable                                                                                                                                                                         |
| Nature      | exact, instant, offline, unit-tested                               | a proposal you review                                                                                                                                                                   |
| Determinism | same answer every time                                             | authored once, then stored as data                                                                                                                                                      |
| Covers      | yield solving, basis re-splits, dough amounts, percentages → grams | wait-stage extraction, a schedule that lands at a target time, the yeast consequence of a longer retard, what more wholemeal does to hydration and timing, ferment flavour combinations |

**The AI authors, the domain runs.** A schedule is proposed once, stored on the
batch, then executed by pure code and the existing Cloud Tasks path. The model is
never in the loop while the dough is proving. This is `guidedPlans`' lifecycle
exactly — AI writes, human edits, runtime never calls the model again.

**Two tiers inside the AI half**, via the existing `resolveModel` seam:

- **Extraction** (cheap tier) — pulling wait stages out of step text and the
  timers already parsed onto it. Mechanical, no judgement, same posture as
  `parseRecipeIngredients`.
- **Proposal** (better tier) — restructuring a schedule to land at a target time.

Two flows, two tiers; not one flow doing both.

**Review a diff, store a snapshot.** A proposal can _restructure_: ninety minutes
on the counter becomes twenty on the counter and eight in the fridge. So the
process on the formula is a **reference**, not a template the schedule merely
re-times. A pure `diffProcess` renders the change for review; what lands on the
batch is the resolved schedule itself. `recipeDiff` is the exact precedent — a
pure domain function producing a human-signal render contract that is never
persisted. Do **not** model a split as a first-class diff operation: one stage
becoming two is a removal and two additions, and renders honestly as that.

## Documents

| Doc           | Firestore path                        | Scope         | Purpose                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Formula`     | `formulas/{recipeId}`                 | family-shared | Basis, percentages, reference yield (dough), reference process                                                                                                                                                                                                               |
| `Batch`       | `batches/{batchId}`                   | family-shared | One run: frozen quantities and schedule, current stage, state, vessel, the kitchen temperature it was started at (`ambientCelsius`), the frozen place each stage ran in, and when it was abandoned (`abandonedAt`, null while running and on runs stopped before it existed) |
| `Observation` | `batches/{batchId}/observations/{id}` | family-shared | Append-only log — weight, pH, temperature, humidity, note, photo, and the stage it is about (`stageId`, an FK into the parent's frozen `stages`; `null` = the whole run)                                                                                                     |
| `Culture`     | `cultures/{cultureId}`                | family-shared | Deferred. Maintenance formula, rhythm, state, feed log                                                                                                                                                                                                                       |

**Why `formulas` is its own collection, keyed by recipe id**, rather than fields
on `RecipeSchema` — the same reasoning as `guidedPlans/{recipeId}`:

- `recipes` holds production data (#240); a large optional nested structure would
  weigh on every recipe that will never have one.
- Every existing consumer — shopping list, canon matching, planner, cook mode,
  hero images, chat — keeps reading `ingredients[]` unchanged. That is an
  enormous amount of free reuse.
- Under document-level LWW, a fiddly formula edit never contends with the
  `onRecipeWritten` trigger writing `image` / `imageBrief`.
- A recipe with no formula carries no empty scaffolding.

The recipe's `ingredients[]` stays the **resolved projection at the formula's
reference yield**.

> **The recipe never shows scaled numbers.** Scaled quantities live on the batch
> and are only ever reachable by opening the batch. Someone who opens the loaf and
> taps Cook gets guided mode with the recipe's own numbers and never learns a
> formula exists. Get this wrong and the weekly loaf silently becomes twelve rolls.

## Kind versus presence

Do **not** add `bread`, `ferment` and `cure` as kinds and hang behaviour off them.
`kind` keeps doing exactly what it does today (see CLAUDE.md and
`recipe/queries/capabilities.ts`): identity, copy, icons, library section, which
prompt authors it, whether the planner offers it. What a document can _do_ comes
from what it _has_.

| Entry            | `kind`     | formula | process | batches | culture |
| ---------------- | ---------- | :-----: | :-----: | :-----: | :-----: |
| Weeknight curry  | `recipe`   |    —    |    —    |    —    |    —    |
| Tin loaf         | `recipe`   |    ●    |    ●    |    ●    |    —    |
| Thin pizza bases | `recipe`   |    ●    |    ●    |    ●    |    —    |
| Fresh sausage    | `recipe`   |    ●    |    —    |    —    |    —    |
| Sauerkraut       | `ferment`  |    ●    |    ●    |    ●    |    —    |
| Kimchi           | `ferment`  |    ●    |    ●    |    ●    |    —    |
| Milk kefir       | `ferment`  |    ●    |    ●    |    ●    |    ●    |
| Coppa            | `cure`     |    ●    |    ●    |    ●    |    —    |
| Salami           | `cure`     |    ●    |    ●    |    ●    |    —    |
| Negroni          | `cocktail` |  free   |    —    |    —    |    —    |
| Friday takeaway  | `outing`   |    —    |    —    |    —    |    —    |

A loaf **is** a recipe: cooked, plannable, wants a hero image, ingredients on the
shopping list. A `bread` kind would fork all of that for nothing. `ferment` and
`cure` earn kinds the way `cocktail` did — they are a different section of the
library, not dinner. Sausages fall out without a decision: a fresh banger is a
formula with no process, a salami is nearly the same formula with a cure's
process. A cocktail could gain a 1:1:1 formula with no code change at all.

**The rule that stops the capability table rotting:** capabilities answer
questions about the **kind**; presence answers questions about the **document**.
"Is this offered in the planner?" is a capability. "Does this have a formula?" is
`formula != null`. Keep that line sharp and `capabilities.ts` stays as wide as
the questions it answers about a kind — five columns today (`takesIngredients`,
`isCookable`, `isPlannable`, `isAuthorable`, `takesComponents`) — instead of
growing a boolean per feature.

## Placement

The layer map is unchanged — no new packages.

```
packages/domain/src/
  formula/      basis, scaling, dough amounts, bidirectional yield solve     — pure
  process/      stage model, forward + backward schedule, diffProcess          — pure; "now" injected
  batch/        transitions, derived progress, observations                    — pure
  culture/      maintenance rhythm, feed log, draw                             — pure; deferred
  schemas/      formula.ts · process.ts · batch.ts · culture.ts

packages/adapters/firebase-sync/
  formulas/{recipeId} · batches/{batchId} · batches/{id}/observations/

apps/cloud-functions/
  reuse  onCookTimerWrite → onCookTimerDispatch     stage reminders, longer horizon
  new    extractProcessStages   (cheap tier)
  new    proposeSchedule        (better tier)
  new    authorFerment          (phase 03)

apps/web-pwa/
  reuse  recipe surface + a scale affordance
  new    in-flight surface — batches and their next action
```

The **in-flight surface** is the day-to-day home and does not exist in any form
today: "Coppa — day 12, 22% lost, weigh Friday", "Kraut — day 5 at 19 °C, taste
it". It is family-shared, so it is not a fit for _Mine_ (a per-user projection).
It holds **two** kinds of card — projects with a finish line, and (if cultures
ever land) rhythms with a next feed. Same card shape: next action, when.

## What is reused

|                                        |                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud Tasks + push + `timerDeliveries` | The cook-timer path is exactly the mechanism a proof reminder or a "day 7, taste it" needs — same shape, longer horizon, exactly-once already solved. The single biggest reuse. |
| Canon matching                         | Unaffected. Ratios resolve to grams before anything canonicalises.                                                                                                              |
| Shopping list                          | Works as-is, with one ordering constraint: extract from the **resolved** quantities, never the formula.                                                                         |
| `guidedPlans`                          | The precedent for a separate family-shared doc keyed by recipe id, and for the AI-authors-once lifecycle.                                                                       |
| `recipeDiff`                           | The precedent for a pure, never-persisted, human-signal diff.                                                                                                                   |
| Cook mode                              | Bread still gets baked. The final stage of a bread process hands off to the existing cook session.                                                                              |
| `RecipeKind`                           | Adding two kinds is a one-file change, and the `Record` forces every consumer to be answered before it compiles.                                                                |
| Genkit callables + `resolveModel`      | Both new flows are the existing pattern; the model tiering seam already exists.                                                                                                 |

Nothing needs to be built externally. The only thing resembling external data is
a reference table (hydration norms, cure-salt limits) — a checked-in constant in
`domain`, not a service. Note what is **not** on that list any more: the eleven
named unit shapes were exactly such a table, and #1274 deleted them. A vessel size
is UI affordance, not domain data.

## What not to build

|                                               |                                                                                                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A separate app                                | Immediately loses canon, shopping, search and images.                                                                                                                                              |
| A process/workflow DSL                        | Stages are a small fixed shape. A mini-language costs more than it saves and is unreviewable.                                                                                                      |
| `{ type: 'percent' }` on `QuantitySchema`     | Ratios would leak into every consumer reading `parsed.quantity` — shopping list, canon, chat — each needing a basis it cannot see. Resolve at the formula boundary; downstream keeps seeing grams. |
| Batches on `cookSessions`                     | Wrong ownership, wrong lifetime, wrong sharing.                                                                                                                                                    |
| A parallel "Projects" model outside `recipes` | Fragments canon, search, shopping and images for no gain.                                                                                                                                          |
| A fermentation model                          | Timing judgement is a one-shot AI proposal the user reviews. A numeric model needs months of the household's own data before it is worth having.                                                   |
| The AI in the hot path                        | It authors the schedule, then it is gone. Timers, reminders and state transitions are pure code on existing infrastructure.                                                                        |
| Daily notifications for a long run            | A 90-day cure must not notify 90 times. Reminders attach to stage transitions and scheduled checks, never to elapsed time.                                                                         |

## Phasing

Bread first, and the reason is **cycle time**, not preference. A bread batch runs
the entire lifecycle — create, plan, schedule, notify, observe, finish — in
eighteen hours. A kraut takes three weeks; a coppa four months. A batch model
cannot be debugged on a four-month feedback loop.

| Phase  | Scope                                                                                                                                                                                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **00** | Formula in `domain`, headless. Basis, bidirectional solve, dough amounts. Fully tested before anything renders it.                                                                                                                                                                                                                                                                 |
| **01** | Basis mapping on an existing recipe; `extractProcessStages`; "12 × 120 g". **Ship with 02, not before** — scaling by hand already works, so alone this only replaces arithmetic nobody minds doing. It is the substrate the schedule needs.                                                                                                                                        |
| **02** | `proposeSchedule`, the `batches` collection, the in-flight surface, reminders on the existing Tasks path. The half with no manual workaround, and the half that justifies the whole thing.                                                                                                                                                                                         |
| **03** | Ferments. New kind, `authorFerment`, vessel headspace, one long stage. The basis-driven solve earns its keep — you weigh the cabbage, not the output.                                                                                                                                                                                                                              |
| **04** | Cures. New kind, the observation log worked hard, weight-loss criteria, revised projections, reminders past the Tasks horizon. Cure-salt bounds are a prerequisite, not a feature. **A trim-loss allowance is this phase's to build** — #1274 deleted bread's, which fed no arithmetic; a 10–20% trim on a shoulder is a real requirement and belongs where it is actually stated. |
| **05** | Cultures. Only if kefir happens.                                                                                                                                                                                                                                                                                                                                                   |

### What bread hands on

Carries over whole: the formula model and its two-tier basis; the batch
collection, snapshot and state machine; the in-flight surface; reminders on the
Tasks path; diff review and the two model tiers; canon, shopping, images, search.

Still to build at 03–04: the basis-driven solve direction; stages carrying
additions; projections that observations revise; reminders beyond the Tasks
scheduling horizon; `authorFerment` and two kinds; vessel headspace and the
cure-salt bounds.

Optional stages and the four-condition run (started / done / skipped, with a reason)
shipped with bread, in #1275 — they are not on that list.

## Open questions

Settle the first before promising anything; the rest before the phase that needs
them.

- **Cure salt is a safety boundary, not a number.** Nitrite percentages carry hard
  bounds in `domain`, and the scaler refuses rather than extrapolates. Settle
  before any curing UI exists.
- **How good are the two AI passes.** The gate on everything: hand three real
  bread recipes to the cheap model and check the wait stages come out clean, then
  the same three to a better model with a target time and read the schedules. If
  both read well the phases are plumbing; if not, the prompts are the work.
- **Who writes the resolved ingredient list** — the client on formula save (one
  owner, simple) or an `onFormulaWritten` trigger (consistent, but contends with
  client `setDoc` under LWW). Leaning client.
- ~~**Observations: array field or subcollection.**~~ **SETTLED — subcollection**
  (issue #812, the observation log). Append-only over weeks, and two people logging
  a weight on the same day must not clobber each other under document-level LWW, so
  an array field would have meant the second phone to sync erasing the first
  partner's reading. `batches/{batchId}/observations/{id}`, family-shared, ordered
  by when a reading was **observed** rather than when it arrived — Salt's first
  purpose-built subcollection, following `shoppingLists/{listId}/items`. There is
  deliberately no domain producer for the append: an entry is its own document, so
  "add to the log" is a write, not a decision.
- ~~**The Cloud Tasks scheduling horizon.**~~ **ANSWERED — 30 days** (issue #812,
  the reminder path). Cloud Tasks accepts a `scheduleTime` at most 30 days ahead.
  Bread's eighteen hours is nowhere near it, so nothing in phases 00–02 was
  affected — but the guard was added anyway (`CLOUD_TASKS_HORIZON_DAYS` in
  `apps/cloud-functions/src/triggers/batchStageTypes.ts`), and a stage beyond the
  horizon is skipped with a logged warning rather than silently dropped. A 90-day
  dry **will** exceed it, so phase 04 still owes a re-enqueue chain or a scheduled
  sweep — it now finds a guard and a warning rather than a surprise.
- **Does a culture reuse `process`.** A maintenance rhythm is a repeating single
  stage, so it either reuses the model or is a simpler thing of its own. Decide
  when cultures land.
- **Planner and shopping reach.** Does starting a batch consume a planner slot or
  push to the list? Bread probably yes; kraut and coppa at start only.
