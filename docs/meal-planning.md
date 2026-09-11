# Meal Planning module

Plan a week's worth of **evening meals**. Each week is one document; a single
**standard template** (the typical week) can be loaded into any week and then
tweaked. The whole point is fast weekly turnaround: load the template, adjust
the exceptions, done.

All data is family-shared (no per-user scoping). Member references are by
`memberId` (= normalised email, the members-module key from #155).

## Documents

| Doc                | Firestore path                            | Cardinality | Purpose                                                     |
| ------------------ | ----------------------------------------- | ----------- | ----------------------------------------------------------- |
| `MealPlanConfig`   | `mealPlanConfig/{document}` (singleton)   | 1           | `firstDayOfWeek` — the "big shop" day that starts each week |
| `MealPlanTemplate` | `mealPlanTemplate/{document}` (singleton) | 1           | The standard week, keyed by weekday (`mon`…`sun`)           |
| `MealPlanWeek`     | `mealPlans/{YYYY-MM-DD}`                  | many        | One concrete week, keyed by the date of its start day       |

Config and template are **separate singletons** so editing one never
last-write-wins-clobbers the other.

## Day shape (shared by template and week)

Both the template's seven weekday entries and a week's seven dated entries use
the same shape:

```
Day {
  note: string                       // free-text meal description (v1)
  recipeIds: string[]                // attached `recipes/{id}` entries (#17). An entry may be a
                                     // non-cookable "When you CBA" outing (#637) — same collection,
                                     // same reference; nothing here changes shape for it
  chefs: memberId[]                  // zero or more; a chef need NOT be an attendee
  attendees: Attendee[]
  guests: number                     // extra, unnamed diners with no member record; counts
                                     // towards the attending total alongside `attendees`
}

Attendee {
  memberId: string
  homeTime: string | null            // "HH:mm" 24h local time; null = attending, time unknown (a valid saved state)
  note: string                       // per-person note, e.g. "make a portion for another day"
}
```

- **Template** keys its `Day`s by weekday name — up to seven, not necessarily
  seven. `MealPlanTemplateSchema` validates an open enum-keyed record, so a
  stored template may omit weekdays, and since issue #1056 the type says so and
  the two commands that index it guard for it. Every writer the app has emits
  all seven; that is the writers' behaviour, not a schema guarantee. It carries
  the _usual_ attendees, chefs, home-times (which may be blank), per-person
  notes, and an optional recurring meal `note` (e.g. Friday = pizza).
- **Week** keys its seven `Day`s by concrete `YYYY-MM-DD` date.

## First-day-of-week & week identity

`firstDayOfWeek` (a global setting, the big-shop day) controls only **layout and
which date a week starts on** — it never reshapes the template. The template is
always keyed mon–sun, so changing the big-shop day re-maps the standard week
onto the new day order without data migration.

A week's document key is the ISO date (`YYYY-MM-DD`) of its start day. A pure
domain function `weekStartFor(date, firstDayOfWeek)` computes the start date of
the week containing any given date. It takes the `Weekday` directly, not a config
object.

## Shop day (issue #629)

The shop is **ad hoc** — it moves week to week with whoever can actually get to
the shops — so it is recorded per week as its own tiny document,
`shoppingDays/{YYYY-MM-DD}` (`date`, `slot: 'am' | 'pm'`, `setBy`, `setAt`). See
[salt-architecture.md §5](salt-architecture.md) for why it is standalone rather
than a field on a list or on the week doc.

It **does not move the week.** `firstDayOfWeek` and the layout above are
completely untouched: the shop marker sits _inside_ the week wherever it falls.

**Which day you shop is a fact about the week, so it is set at the week** (issue
#640, Phase 4). The planner carries one control under its week nav: a button that
says the current answer — _Shop · Sat 1 pm_, or _No shop day set_ — opening a
picker that holds the week's seven days in `firstDayOfWeek` order, each with AM
and PM. One tap sets both halves and closes it; _No shop day_ clears. When the
planner is also showing next week (#639) that week is offered too, under its own
heading — from the last three days of the cycle the week you are provisioning _is_
next week — and `setShopDay` scopes its one-shop-per-week clear by the **date's
own** week, so marking one week's shop never disturbs the other's. Until #640 the
AM/PM pair lived inside a single day's sheet: you opened Thursday to say "we shop
Thursday", and the answer then appeared as a rule across the list, somewhere else
entirely. Nothing about the shop is left in `MealDayEditor`, in either of its
shapes.

The shop itself is **drawn as a labelled rule across the week's list** — a cart,
the slot, then a hairline to the edge — not as a badge on a row, so the week
visibly divides into before the shop and after wherever the shop falls.

Days before the shop are **not** shaded: #639 dropped the pre-shop wash along
with the per-row pill, leaving the rule as the whole display. The pure predicate
`isBeforeShop(day, shopDate)` in `packages/domain/src/shoppingDay/` survives,
tested, but is wired to no surface today.

The **default shopping list** carries the same fact as a read-only line under the
list name — _Shopping Sat AM_ — tapping through to that week in the planner via
`/mealplan/:date`. It reads relative only where relative beats a weekday: "today"
and "tomorrow" are unambiguous and match the push copy, while "in 4 days" is
arithmetic the reader has to undo. Those two near states are also the only ones
emphasised, because they are the only ones where the list still being wrong costs
anything. The other lists show nothing: they are background collectors for
specialist stores, shopped whenever, and the weekly shop says nothing about them.

**An unmarked week says so.** With no shop day set the same line reads _"No shop
day set"_ and opens the planner. Without it the feature would fail silently in
exactly the situation it exists for — a week passes, nobody marks a day, and no
reminder ever fires. (This closes the open question #629 shipped with.) The
`upcomingShopDay` store is therefore three-state — `undefined` not loaded, `null`
loaded-and-none, a doc — so the prompt cannot flash before the subscription
resolves.

The evening before a shop, `remindShoppingDay` (a Cloud Scheduler job, 17:00
Europe/London) pushes _"Shopping tomorrow AM/PM"_ to every subscribed device.
`slot` drives copy only — both slots nudge at the same hour, because mornings are
unreliable in a working household and extra notice costs nothing.

## The core mechanic: load template

`instantiateWeek(startDate, config, template)` is a pure function: for each of
the seven dates from `startDate`, it looks up that date's weekday in the
template and copies the weekday `Day` into the dated `Day` — or a blank day if
the template omits that weekday (#1056), so the produced week always has all
seven dates and the function never throws. This is the
"load template" action. Re-loading overwrites the week back to the standard,
ready for exception-tweaking. This is the heart of the quick-weekly-update goal.

## Conflict model

One Firestore document per week, **whole-document last-write-wins** (consistent
with Firestore-as-master, no tombstones). The only clobber window is two people
editing the _same_ week simultaneously — acceptable for a single small
household. Per-day documents were rejected as over-engineering for the
concurrency profile.

**Typed fields coalesce their writes; applies never defer** (issue #940). Typing
a dinner used to issue a whole-week `setDoc` per keystroke, fanned out to every
family device. `mealPlanService` splits the two halves of `persistWeek`: the
optimistic store apply stays **synchronous**, and only the `setDoc` goes through
`createWriteCoalescer` — the debounced, document-keyed writer in
`apps/web-pwa/src/lib/writeCoalescer.ts`, promoted out of this module by #1319 so
recipe in-place editing shares the one mechanism rather than a second copy. Its
header carries the guarantees and the honest limits (what a killed tab still
loses, why a dropped connection loses nothing extra, how the clobber window below
widens by the debounce) — read it there rather than here. The apply itself cannot
be deferred — every mutator rebuilds the week from the store, so a deferred apply
would let two edits to the same day build on the same stale document and discard
one another.

**Only the four note mutators coalesce.** `setWeekDayNote`,
`setWeekAttendeeNote` and their two template twins are the fields typed a
character at a time. Every other mutator — chef, attendee, guests, recipes,
load-template — is one deliberate tap and writes at once. That is not a
performance nicety: a debounced click is an edit the user has finished making,
and a reload landing inside the window would silently discard it
(`e2e/mealplan.spec.ts` asserts exactly that it survives a reload).

## Member references

Store `memberId` only. Names, initials, and avatars are resolved at **display
time** from the live members store — never denormalised into the plan. A member
who has left the family renders as removable/unknown rather than corrupting the
document. Tolerate-and-render, never block on a missing member.

## Access & admin

Firestore rules keep **writes open to any authenticated user** (an
authenticated user is already an allowlisted member via `beforeMemberCreated`),
matching the shared-data / canon-write-path-open principle. The **template
editor and first-day setting live in the admin settings area**, but that
`AdminGuard` is **cosmetic** (accidental-damage protection) — it is never
enforced in rules. The weekly plan editor is open to all members.

## Architecture placement

New modules sit inside existing packages — **no new package, no new dependency,
no layer-map change, no AI** (recipes/AI arrive later via #17):

- `packages/domain/src/mealPlan/` — entities, pure commands/queries
- `packages/domain/src/schemas/mealPlan*.ts` — zod schemas (validated on read in firebase-sync)
- `packages/adapters/firebase-sync/src/mealPlan*.ts` — subscriptions + writes for the three docs
- `apps/web-pwa/src/lib/mealPlanService.ts` + routes — store, navigation, editors

The shop day (#629) follows the same shape, in its own files:

- `packages/domain/src/shoppingDay/` — `isBeforeShop`, the "tomorrow in zone" date helpers, `shopDayForWeek`
- `packages/domain/src/schemas/shoppingDay.ts` — the `shoppingDays/{date}` doc schema
- `packages/adapters/firebase-sync/src/shoppingDaySync.ts` — week range read + mark/clear writes
- `apps/web-pwa/src/lib/shoppingDayService.ts` — stores, the one-shop-per-week rule
- `apps/cloud-functions/src/maintenance/remindShoppingDay.ts` — the daily 17:00 nudge (the module's first Cloud Function)

## Recipes on a day (#17, #637, #652)

`Day.recipeIds` is populated. The weekly editor attaches entries through a
picker over the recipes store; titles and hero thumbnails resolve live at display
time (never denormalised), and the free-text `note` remains for ad-hoc meals. The
field's shape never changed to get here — adding use of an existing field is
free, which is why no migration was ever needed.

`MealPlanDaySchema` is likewise **unchanged** by the kind discriminator (#637):
an outing lands in `day.recipeIds` like anything else, because it lives in the
same `recipes` collection. What the picker filters on is
`isPlannable(kind)` — a cocktail is not dinner and never appears — and what the
per-recipe **Add to shop** action is gated on is `takesIngredients(kind)`, since
a takeaway has nothing to buy. Both are the pure domain predicates: the planner
never compares a kind to decide behaviour. The one place it names a kind at all
is copy — a non-`recipe` picker row wears a small label ("When you CBA") so the
option can be told apart in a list of dinners.

### Attaching from the recipe page

A recipe's own page carries **Add to planner**, gated on the same
`isPlannable(kind)` the picker uses — the question is identical ("is this
offered for a night?"), so it gets one answer, not two. It opens a hand-rolled
month grid rather than `<input type="date">`: the native control hands the
interaction to the OS, which means a different picker on every device and none of
them able to start the week on `firstDayOfWeek`.

The non-obvious part is the write. Every other day mutator **refuses** a week it
has not read, because a full-document write built on a week nobody looked at
destroys its other six days — safe in the planner, where the days on screen are
the days it is subscribed to. This caller can name any date, so `addRecipeToDay`
reads the week first and writes what it read; a failed read stays a `Failure`
rather than becoming a blind overwrite. That one-shot read is deliberately **not**
cached in the service's week store: nothing is listening to it, so nothing would
refresh it, and its presence would make `weekIsKnown` lie to the next writer.

### A second page now holds planner weeks (#755)

`mealPlanService` has **three** claims on its subscription set, not two. The
planner owns the primary week and the optional extension week; the Kitchen page
(`/mine`) owns a third slot, `subscribeKitchenWeeks()`, holding the one or two
weeks its _Cooking soon_ list projects over.

**Anchored on today, not on `_anchorDate`.** The planner's weeks follow wherever
the user scrolled to; "which nights are mine next" is a question about now. Browse
to October in the planner, switch to the Kitchen, and the answer must still be
_this_ week — so the kitchen slot recomputes `weekStartFor(today, firstDayOfWeek)`
for itself and never reads or moves the planner's anchor. It takes a second week
on exactly the planner's own `weekExtendsIntoNext` rule, reused rather than
re-derived: what makes the last three days of a cycle the moment next week matters
is a fact about the household's week, and two pages disagreeing about it would be
a defect nobody could see from either one.

**The keep-set is a union, and no claimant may close a week by name.** The two
pages ask for weeks independently and routinely ask for the _same_ week — today's,
most of the time — so `pruneWeekSubscriptions` keeps the union of primary +
extension + kitchen starts, and each caller's teardown clears only its own claim
before re-asserting it. Unsubscribing a kitchen week directly on unmount would
close the planner's live subscription behind it and freeze a page that is still
open. In the common case the union is why the Kitchen costs **no** extra read at
all: `subscribeWeekDoc` is idempotent, so a week the planner already holds is
shared rather than opened twice.

**It is page-owned, not started at auth time.** Same bargain the extension week
strikes: these are real subscriptions on a module-level singleton, and holding a
week document open for a screen nobody is looking at is the cost the planner
already refuses to pay. The nav badge deliberately does not read this projection,
so no other page drags the weeks in.

**Recomputed on the config snapshot.** `firstDayOfWeek` answers `'mon'` until the
config document lands. On a cold launch — mount, subscribe under the fallback,
config arrives saying `'fri'` — a set computed in that gap is the wrong week
_identity_, not merely a stale one, so the kitchen slot re-asserts itself in the
same callback that calls `syncWeekSubscription()`.

**It widens `weekIsKnown`, and that is safe.** While the Kitchen is mounted,
`addRecipeToDay` will build on a held kitchen week instead of re-reading it. The
prohibition above is specifically about a week **nothing is listening to**; a
kitchen week has a live listener keeping it fresh, which is the property that
makes the optimistic path honest. `loadMealPlanWeek` is deliberately _not_ used
for these weeks for the same reason.

### The note-only night attaches its own picture (#652)

A night planned in a sentence — "roast chicken dinner", no recipe and none ever
coming — used to be a thin line of text between full photographic cards, so it
read as a gap in the ledger. It now attaches a **placeholder**: an ordinary
`recipes` document (`kind: 'placeholder'`) whose hero says "a good dinner is
planned" without claiming a particular dish. Nothing about the plan document
changed to allow this — the id lands in `day.recipeIds` like any other.

The mechanics, and why each is what it is:

- **On the dinner field's `onblur` in `MealDayEditor.svelte`, never in an
  `$effect`.** An effect reconciling "has a note, has no recipe" would fire
  across every rendered day — seven to fourteen of them — and each one is a
  whole-week `setDoc` through `persistWeek`. Blur is one write per user action.
- **Guarded on four things**: the field is non-empty, `day.recipeIds` is empty,
  `onRecipesChange` is supplied, and the row has a `dateKey`. The last is what
  keeps the weekday-keyed **template editor** out of it without a special case —
  it has no dates at all, the same way it has no picker.
- **The pick is frozen.** `pickPlaceholder(recipes, dateKey, weather)` reads the
  evening's forecast once, at the real moment the day was planned, and the id is
  stored; nothing re-evaluates it. Resolving at render time could only
  approximate that, because the forecast expires as a day ages.
- **No `kind` branch in the app.** Every recipe is handed over and the domain
  filters to placeholders itself — including skipping any whose hero generation
  failed. `null` means "nothing to attach" (notably: before any placeholder has
  been built) and the day simply stays a block of text.
- **It is attached, not conjured**, so it is a removable row in the day's sheet
  like any other. Remove it and the day is text again. The two accepted
  consequences of treating it as an ordinary attached entry — the day's card
  takes the placeholder's photograph even after a real recipe joins it, and
  clearing the dinner text re-seeds it with the placeholder's own title — are
  recorded, and rejected as bugs, in
  [recipe-module.md](recipe-module.md#schema-extensions-kind-discriminator-issues-637-652).

A day with **neither** a note nor a recipe reads **"Nothing planned"** (it said
"No meal set"). That is the whole of the empty-day treatment, deliberately: once
every planned night carries a photograph, a short muted line between them already
reads as the hole it is, and a dashed ghost card would cost ~187px of deck height
saying nothing.

### A meal plans the whole dinner, once (#752)

A **meal** is an ordinary `recipes/{id}` carrying `componentRecipeIds`; there is
no fifth kind and no second collection, and the planner has no meal branch in it.
Attaching one writes `[mealId, ...componentRecipeIds]` into `day.recipeIds`,
deduped against what the night already holds (`expandForPlanner` +
`mergePlannerRecipeIds`, both pure, in `domain/src/recipe/queries/components.ts`).
Nothing about the plan document changed to allow it: `recipeIds` was already a
`string[]` and several recipes on a night is shipped behaviour.

- **The expansion is FROZEN at attach time**, the same bargain `pickPlaceholder`
  strikes. Edit the meal afterwards and an already-planned night is untouched.
  That is what keeps `day.recipeIds` homogeneous — every consumer (the day sheet,
  the week card, "Shop the week", `personalViewService`, the admin editor) goes on
  resolving plain recipe ids against one store, with no idea meals exist.
- **The meal id goes FIRST**, and two existing mechanics then do the right thing
  by themselves: the day's note seeds from the first attached recipe's title, and
  the day's card takes the first attached hero. Neither was modified.
- **`expandForPlanner` takes no recipe store and filters nothing.** A component
  deleted since it was attached leaves a dangling id, which every planner consumer
  already skips silently. Filtering would make a planner _write_ depend on store
  hydration, so a half-hydrated store would plan fewer dishes than the user
  picked — much the worse failure.
- **Removal needs no new code.** Dropping one dish from one night is the existing
  `day.recipeIds.filter(...)`; it touches neither the meal nor any other night.
- **"Shop the week" groups, and only groups.** Within a night, an entry whose
  recipe has components adopts the entries beside it that it names: one line, one
  tick, `Sunday roast · 3`. What comes back is still the FLAT list of entries, in
  row order, because the page drives one `RecipeAddToListSheet` per entry and the
  confirm button's count is a promise about how many review sheets follow. A meal
  that is a pure bundle therefore still gets its own (empty) review sheet — not
  meal-specific, and deliberately not special-cased: any ingredient-less recipe
  behaves the same, and the fix, if it ever bites, is one predicate in the entry
  filter that would help all of them.

The planner also **answers one question for the cook plan** (#752 Phase 4):
`latestHomeTimeFor(weeks, recipeId, dateKey)` in
`domain/src/mealPlan/queries/latestHomeTimeFor.ts` is what a meal's cook plan
seeds its serve time from — the last attendee home on the night that dish is
planned for. It is a **read only**, gated on the dish actually sitting in that
day's `recipeIds`, and it returns null rather than a guess when the plan has no
opinion; the cook plan then falls back to 19:00 on its own. Nothing in the planner
knows the cook plan exists, and no plan document is written by it.

Production data caveat: the planner collections hold real production data, and so
has `recipes` since 2026-06-17 (#240). Anything added to a `Day` — or to the
recipe documents it points at — has to be back-compatible on read or ship a
migration. Placeholders were **not** backfilled: days already planned in a
sentence stay as they are until someone next edits the note.
