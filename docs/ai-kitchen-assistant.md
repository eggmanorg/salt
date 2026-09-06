# AI Kitchen Assistant

The conversational AI feature: the **main point of the app**. It is one chat engine
serving two purposes — a general kitchen assistant (open Q&A, recipe ideation) and a
structured recipe author. This is the follow-on epic deferred from the recipe
foundation (#179).

## Design principles (load-bearing — do not violate)

1. **The chef speaks in plain text — and it has tools.** Conversational turns have
   **no structured output schema**. Structure is the librarian's job, applied only at
   save time; forcing structure onto the chat is what made the earlier prototype feel
   constrained and produce sub-Gemini answers, and that half of this principle is not
   negotiable.

   **The "and no tools" half was overturned in #840, deliberately.** The chef can
   search the recipe library and read a saved dish, because a chef that cannot name
   one of the household's own fifty-nine recipes is not a kitchen assistant. What the
   original principle was protecting is real and survives as a constraint rather than
   a prohibition: a model with tools reaches for them, and every turn spent searching
   is a turn not spent being a chef. So — **two tools, no more** (`findRecipes`,
   `readRecipe`), every tool description carries an explicit _when not to call_
   clause, and the chef still **writes nothing**. Saving, planning and shopping-list
   adds stay manual. A third tool is a new issue with its own justification.

2. **Small and fixed stays ambient; large and growing gets a tool.** Equipment,
   household favourites and kitchen memory go straight into the chef's system prompt
   ("here's the equipment available — draw on it when it genuinely helps, ignore it
   otherwise"). No retrieval tool, nothing the model feels obliged to call, and the
   assistant is never _bound_ to the user's equipment.

   **This is a SIZE test, not a matter of taste** — which is why the recipe library
   is on the other side of it (#840). The library fails the test in both directions:
   it was 59 dishes after two months of real use and grows without bound, so an
   ambient index is paid on every single turn forever; and an index can only ever
   carry a summary line per dish, so the moment the chef needs the ingredients or the
   method of a dish it did not open with, ambient cannot help it at all. Apply the
   same two questions — _is it bounded?_ and _is a summary enough?_ — before making
   anything else ambient or a tool.

3. **Pro-tier model for the chef.** Conversation quality is the whole point — use a
   Pro-tier Gemini for the chef, not Flash. The librarian (structured extraction)
   stays on Flash + `temperature: 0`, consistent with the other parse flows.
4. **One agent, not three.** The user's "creative chef / kitchen engineer /
   librarian" roles survive as _intentions_, not as a forced pipeline. The
   "engineer" is just the user asking ("how do I make the most of my kit here?") —
   the equipment context is already present, so the same agent answers. Only the
   librarian is a genuinely separate (non-conversational) component.
5. **Guided cook mode never shows less than plain cook mode** (#761). Guidance is
   added on top of what the recipe already says — it never replaces or withholds it,
   so every amount plain cook mode prints must be on the guided screen too.
   The one thing guided mode is allowed to _replace_ is the **faded peek at the next
   step** (#769), and only because that peek is not content: it is the top few lines
   of the next step, cut off at whatever height the layout leaves and unreadable by
   design. The plan's authored look-ahead says more in the same space, and says the
   one thing the raw text structurally cannot — which part of the next step has to be
   _started now_ (an oven that needs fifteen minutes, a steak that needs half an hour
   out of the fridge). Nothing is withheld: the step's own words arrive in full a
   moment later, unchanged, and a plan with no look-ahead falls back to the fade.

## Scope boundaries

- "Contents of my kitchen" means **equipment + accessories only**. There is no
  pantry/fridge inventory module and this feature does not add one. The household
  favourites the chef sees (issue #726) are **not** an inventory: they are a
  purchase _history_ — what got ticked off at the shop, over time — and say
  nothing about what is in the house right now. Do not let them grow into one.
- A saved recipe **must canon-match** its ingredients (reuse the existing canon
  pipeline). Adding to the shopping list or meal planner stays a **manual** action
  (shopping-list add already exists).
- **The librarians never read kitchen memory notes.** `authorRecipe`,
  `extractRecipeFromUrl`, `extractRecipeFromPhoto` and `generateGuidedPlan` are
  temperature-0 transcribers; handing one a preference like "we hate coriander"
  licenses it to quietly rewrite an imported recipe. A note shapes what the chef
  _suggests_ in conversation — it must never touch what a recipe _says_. Only
  `chefChat` reads `kitchenMemories` (see Components, below).
- **Inference about a recipe runs AFTER it, never inside the transcription.** The
  same rule, applied the other way round: because those four are transcribers, no
  question that requires judgement about a dish may be added as an output field on
  `ExtractRecipeAIOutputSchema` or `LibrarianOutputSchema`. It gets its own
  best-effort pass over the recipe as SAVED, triggered by `onRecipeWritten`.
  `describeRecipeScene` (the hero's art direction) established the shape;
  `identifyRecipeKit` (issue #882 — what kit a dish needs a cook to get out, which
  is almost never written down: "mash the potatoes" needs a masher the recipe
  never names) is the second; `estimateRecipeTimes` (issue #952 phase 2 — how long
  a recipe already in the library actually takes, re-asked against the definition
  in `recipeFieldRules.ts` rather than restating it) is the third. It is
  edge-triggered on a `timesRequestedAt` nonce rather than on create, unlike the
  other two — the authoring paths already answer this question, so a fourth means
  adding a flow, not a field.

## Per-user data — a deliberate exception

Chats were the **first** per-user-scoped data in Salt; they are no longer the only
one. Everything else is family-shared with no `userId` anywhere, and the
owner-scoped collections are a closed, enumerated list: `chatSessions`,
`cookSessions`, `pushSubscriptions` and `kitchenTimers`, one owner-scoped block
each in `firestore.rules`. CLAUDE.md's "Per-user exceptions (only four)" is the
authoritative count and the place to argue for a fifth — not this doc.

- Chat documents carry `ownerUid` (= `request.auth.uid`).
- `firestore.rules`: a caller may read/write a chat **only if they own it**
  (`resource.data.ownerUid == request.auth.uid`, and on create
  `request.resource.data.ownerUid == request.auth.uid`). This was the first
  owner-scoped rule block and set the pattern the later three follow — note the
  differences CLAUDE.md records: the deterministic-id collections additionally
  permit `resource == null`, and `kitchenTimers` deliberately does not, because
  its document id _is_ the uid.
- Retention via an `expiresAt` stamp that every write bumps: **14 days** for a
  general kitchen chat, **18 months** for a recipe-attached one (`recipeId` set).
  Issue #707 lists a recipe chat on that recipe's "Chef chats" card, so a
  fortnightly sweep would empty the card for the dishes you have lived with
  longest — but the exemption is a longer window, not an exemption from expiry.
  Between #696 and #939 it was `9999-12-31`, i.e. never; since a chat claims its
  recipe as soon as it produces one, that put the majority of sessions (52 of
  staging's 76) beyond any sweep and left the collection unbounded. Eighteen
  months is sized to survive an annually-cooked dish; any turn of the conversation
  restamps it.
- **The wire type is a `Timestamp`, and it has to be** (#1008). A Firestore TTL
  policy only expires a document whose TTL field holds a **`Timestamp`** — a
  string is skipped silently — and `expiresAt` was an ISO-8601 string from #206
  until #1008, so the windows above were retention _policy_ with no _mechanism_
  behind them (measured 2026-08-25: 42 of staging's 76 sessions past their own
  recorded expiry, all still present). `firebase-sync` now converts at the wire in
  both directions: `ChatSessionSchema.expiresAt` stays a string, because
  `packages/domain` imports no Firebase types.
- **The read path accepts both shapes, permanently.** The realtime subscription
  _skips_ documents that fail validation, so a read that demanded a `Timestamp`
  would make every unmigrated chat disappear from the list rather than error —
  and a stale client can write a string long after a migration has run. Tolerance
  here is not transitional.
- **Enabling the sweep is a deliberate per-project act, not a deploy.** The policy
  is infra and lives in no deployed artefact; the documents already written need
  converting first. Procedure, and what is expected to be swept versus kept:
  [docs/runbooks/ttl-policies.md](runbooks/ttl-policies.md).

## Components

```
chat session doc (Firestore)         ← owned by web-pwa + firebase-sync (client writes)
  └─ chef flow (CF, Genkit, streaming, plain text)   ← reads equipmentManifest, returns reply
                                                         + kitchenMemories (issue #816)
  └─ librarian flow (CF, Genkit, structured)         ← conversation → RecipeDoc draft
        └─ reuses canonicaliseRecipeIngredients       ← canon-matches ingredients

kitchenMemories/{id} (Firestore, family-shared)      ← owned by web-pwa + firebase-sync
  └─ captured by `/remember <text>` — parsed, not classified (no AI, no flow)
  └─ read server-side into the chef's system prompt, grouped by author
```

### 1. Chat session (data + persistence)

- Schema in `@salt/domain/schemas/chatSession.ts`, exported via the schemas index.
- One doc per session at `chatSessions/{id}`:
  `{ id, ownerUid, recipeId: string | null, basedOnRecipeId: string | null, title, messages: Message[], createdAt, updatedAt, reopenedAt: string | null, expiresAt }`.
  `Message = { id, role: 'user' | 'assistant', text, createdAt }`.
- **Read-only after two days (issue #1270).** `isChatReadOnly` (`@salt/domain`) says a
  session has gone quiet once more than two days have passed since `reopenedAt ??
createdAt` — `createdAt` never changes, so the clock only restarts when the
  composer's "Make read-write" action explicitly sets `reopenedAt`, never as a
  side effect of chatting within the window. The composer is the one shared
  gate every host inherits; `sendMessage` refuses again (`CHAT_READ_ONLY`) as
  defence-in-depth. The reopen dialog warns that it costs more, because it
  resends the whole history. Enforcement is client-only, by design — no
  `firestore.rules` change.
- `recipeId` set ⇒ the session is **attached to a recipe** (the "open chat alongside
  a recipe" mode). `null` ⇒ general kitchen-assistant chat.
- `basedOnRecipeId` (issue #763) is a **different question**: the dish this chat
  STARTED FROM, for a "Make a variation" conversation, as against the dish it
  BELONGS to. A variation has the second and not the first, so it does not appear
  on the base recipe's chat list and keeps the ordinary 14-day expiry until it
  produces something; on "Save as recipe" it claims the NEW recipe, ending up with
  both fields set and pointing at two different dishes. Both flows read the base
  server-side, so the transcript never carries pasted recipe text. It is
  `.nullable().default(null)` and that is load-bearing, not stylistic: the
  realtime subscription skips docs that fail validation, so a required field would
  have made every pre-existing chat vanish from the list rather than error.
- Messages are an **array in the session doc** (not a subcollection): simpler store,
  TTL, and optimistic updates. A cooking chat will not approach the 1 MB doc ceiling;
  note the bound. Per-token streaming is **not** persisted — the client holds the
  partial assistant text in memory and writes the final message once on completion.
- `firebase-sync` store (`chatSessionSubscription.ts` + writes) follows the
  `recipeSubscription.ts` pattern exactly: `onSnapshot` + `safeParse` (skip+log
  invalid on list, `Failure` on single-doc corruption), `ReadResult` envelopes.
  Apply the **optimistic snapshot guard** (drop `onSnapshot` echoes older than the
  newest local edit by `updatedAt`) — see existing optimistic stores.

### 2. Chef flow (the conversation)

- Genkit flow in `apps/cloud-functions/src/flows/chefChat.ts`, exposed via
  `onCallGenkit` (gives streaming + `authPolicy: isSignedIn()` for free), region
  `europe-west2`, `secrets: [geminiApiKey, posthogApiKey]`, App Check from the shared
  `APP_CHECK_ENFORCEMENT` constant like every other callable (see
  [salt-architecture.md §8.1](salt-architecture.md)).
- **Streaming**: define the flow with a stream schema and emit chunks; the client
  consumes via `httpsCallable(...).stream()`. This is the one piece of newer
  plumbing — **validate it early and interactively** (WSL2 emulator quirks).
- Input: `{ messages: Message[], newMessage: string }` (recent history window +
  the new turn). The flow is **stateless** — it does not write chat docs.
- The flow reads the **equipment manifest** doc server-side (admin SDK, like the
  canon flows read the canon collection) and injects it into the system prompt as
  ambient context. Client stays simple; equipment is always fresh.
- It also reads **household favourites** the same way (issue #726): the
  `canonData/purchaseCounts` tick-off history, joined against `canonItems`, with
  `shoppingBehavior === 'stocked'` dropped so pantry staples cannot drown the
  taste signal. Ambient context like the equipment, and steered **in words** —
  "something a bit different" pushes away from the list, "our usual stuff" leans
  in. There is deliberately no mode flag, no wire field, and no chat UI for it.
  Absent or empty counts omit the section entirely, so the chef behaves exactly
  as it did before the feature existed.
- It searches the **recipe library** on the turns that need it (issue #840), via the
  `findRecipes` tool rather than an ambient index — principle #2 says why. The tool
  is one projected Firestore read (`title`, `description`, `kind`, `metadata`, so a
  search never pulls a recipe's ingredients or method off the wire) wrapped around
  the pure ranking in `packages/domain/src/recipe/queries/searchRecipes.ts`. A tool
  round-trip is silence to the stream guard below, which is why the handler must
  stay fast; a failure degrades to no matches and the chef answers from its own
  knowledge, exactly as it did before the tool existed.
- It reads one dish in full through `readRecipe`, which is `readRecipeContext` and
  **no second rendering** — so it is `formatRecipeForPrompt` (#890) and it is
  component-aware (#838) for free, and a dish read this way carries the dishes it is
  built from. A dish that is missing or corrupt comes back `{ found: false }` rather
  than throwing; the empty render `readRecipeContext` returns for one is unambiguous
  because a recipe that parses always renders at least a `Title:` line, which
  `chefChat.readRecipe.test.ts` pins. **Do not add a third recipe renderer** —
  `authorRecipe.ts` already admits one duplicate exists.
- Plain text out. **No `output` schema**, ever — and, since #840, tools. Guard the model call with
  `withAiStreamTimeout`, not `withAiTimeout` — this is the one streaming flow, and
  a promise wrapper cannot bound a stream. `withAiTimeout` around the aggregated
  response sits _after_ the drain loop, so a model that goes quiet mid-answer
  never reaches it and holds the invocation to its 120 s quota (issue #915). The
  stream wrapper races each chunk against an idle timer instead: silence longer
  than the budget fails the turn, and a long answer that keeps arriving is never
  cut short.

### 3. Librarian flow (conversation → recipe)

- Genkit flow `apps/cloud-functions/src/flows/authorRecipe.ts`, structured output,
  Flash + `temperature: 0`. Exposed via `onCallGenkit` (or `onCall` if it needs the
  batch memory bump like `canonicaliseRecipeIngredients`).
- Input: the conversation (or the portion the user points at). Output: a
  `RecipeDoc`-shaped draft — title, description, metadata, ingredient groups
  (`rawText`, `isOptional`), steps (with ids), and **step↔ingredient links emitted
  directly** (the model names, per ingredient, the step it is first used in; the
  server resolves ordinals to `firstUsedInStepId`). Do **not** post-compute this.
- Canon: the draft's ingredients are run through the existing
  `canonicaliseRecipeIngredients` path to fill `canonId` / `matchState`. The client
  assembles the final `RecipeDoc` and persists with the existing `saveRecipe`.
- **The librarian only ever authors cookable kinds** (#637). A "When you CBA"
  outing is hand-written and has nothing to author, and a placeholder is a
  photograph and a title; the Ask / amend affordance is capability-gated off both
  view pages, so the librarian is simply unreachable for either.
- **Which kinds it may author is a named predicate** — `isAuthorable` in
  `packages/domain/src/recipe/queries/capabilities.ts` (#763), `true` for `recipe`
  and, since #765, for `cocktail`. The `cocktail` row was `false` only while
  `assembleRecipeDraft` hardcoded `kind: baseRecipe?.kind ?? 'recipe'`; flipping
  it was the whole change, and every consumer (the two ⋮ entry points, the flows,
  the list chip) inherited it untouched.
- **The model says which kind it wrote** (#765), on all three creation paths — URL
  import, photo import and chat "Save as recipe". They funnel through
  `assembleRecipeDraft`, whose precedence is `baseRecipe?.kind ?? kindHint ??
raw.kind`:
  - an **edit-mode base wins unconditionally**, so an amend can never silently
    re-type the entry it is editing (`kind` is immutable by design);
  - `kindHint` is **variation mode** — a variation on a cocktail is a cocktail, a
    deterministic answer that beats inferring one from the transcript;
  - otherwise the model's own classification, asked for by the `kind` bullet in
    `recipeFieldRules` (one text, all four prompts) and bounded on the wire to
    `AUTHORABLE_RECIPE_KINDS`, so `outing` and `placeholder` are never offered.
    The floor is the schema's, not the prompt's: `AuthoredRecipeKindSchema` uses
    `.catch('recipe')`, so a missing or invented kind degrades rather than failing an
    import — load-bearing on the librarian path, which has no retry. The tie-break
    leans to `recipe` because the mistakes are asymmetric: a cocktail in the Recipes
    chip still works, a dinner in Cocktails can never be planned.
- **Three prompt closings, not two.** `CREATE_MODE_CLOSING` (the conversation is
  the only source of truth), `editModeSection` (return the COMPLETE updated recipe)
  and `variationModeSection` (#763 — build on the base, but give it a name of its
  own). Variation mode grounds the PROSE on the base recipe while still calling
  `assembleRecipeDraft` with `baseRecipe: null`, which is what makes a variation an
  independent dish: no `producesCanonId` carried, no image shared with the original
  (the doc-id-keyed orphan sweep makes a shared image a data-loss bug — see
  [recipe-module.md](recipe-module.md) § "Duplicating a recipe"), and a hero
  generated from the new content. Edit mode wins if both ids somehow arrive.

### 4. Kitchen memory (the household's own notes for the chef)

- Issue #816. `/remember <text>` in the chat composer, on any conversation,
  saves a standing note; `parseChatCommand` (`@salt/domain`) recognises the
  command by reading characters, case-insensitively — no classifier, no flow,
  no per-turn cost. The command branch runs ahead of the usage event, the
  stream and the title-generation call, so a `/remember` as the first line of
  a chat triggers no AI at all.
- Schema in `@salt/domain/schemas/kitchenMemory.ts`. `kitchenMemories/{id}` —
  **a collection, one document per note**, family-shared like everything
  except the per-user collections enumerated above (no `ownerUid`). A
  singleton doc with an entries array was rejected: whole-document LWW with
  no merge logic means two notes added in the same moment would silently lose
  one; one doc per note makes an add independent and a delete a plain
  `deleteDoc`. `author` is a display name denormalised at write time, never a
  uid. Greenfield collection, no back-compat burden.
- `firebase-sync`'s `kitchenMemorySubscription.ts` follows the **list read**
  contract (skip-and-log a corrupt note, deliver the rest), unlike
  `guidedPlanSubscription`'s single-doc refuse-on-corrupt — a note is one
  sentence, not a reviewed artefact.
- `/chat/remembered` ("What I remember", `ChatMemoryPage.svelte`) lists every
  note grouped by author, and can add or delete one. An ordinary shell route
  (not full-viewport) — reading and tidying notes is not a hands-full mode.
- **Phase 2 — the chef reads them.** `apps/cloud-functions/src/flows/kitchenMemoryContext.ts`
  reads `kitchenMemories` server-side (Admin SDK, like the equipment
  manifest) and renders them into `chefChat`'s system prompt, grouped by
  author. Framed as _preferences, not rules_ — the conversation always wins,
  and the chef may raise a note only once, only when it belongs to someone
  **other** than the person it is talking to. Degrades to no section at all
  on an empty, missing or unreadable collection (Rule 10) and never lists the
  notes back or opens with them.
- The librarians never read this collection — see Scope boundaries, above.

## Surfaces (web-pwa)

- `/chat` — general kitchen-assistant chat (message list, streaming render).
- `/chat/remembered` — "What I remember" (issue #816), listed and static so it
  precedes the parameterised `/chat/:id` route; see Components §4 above.
- Recipe-attached chat — opened alongside an existing recipe; same chat engine with
  `recipeId` set; "apply changes" re-runs the librarian against the recipe.
- Authoring a NEW recipe out of a conversation — one leg, `src/lib/chatRecipeAuthor.ts`,
  three buttons (#798). It is always the CREATE path (`recipeId` never sent), it stamps
  the clock, saves, and fires one `recipe.created` with `recipe_method: 'chat'`; the
  page owns its busy state, its toasts, its navigation and whether the conversation
  goes on to claim what it produced. The three:
  - **"Save as recipe"** on a general chat (`chat-save-recipe-btn`) — passes the
    session's `basedOnRecipeId` through, so a variation chat is grounded on the dish
    it started from, and CLAIMS the session for the recipe it invented.
  - **"Save as new recipe"** on a chat attached to a recipe — in the full page's
    header (`chat-save-new-recipe-btn`) and in the recipe page's docked chat column
    and drawer (`sidebar-save-new-recipe-btn` / `drawer-save-new-recipe-btn`), both
    rendered from one `saveAsNewRecipeAction` snippet. Same gate as "Review changes":
    at least one assistant turn. It passes `basedOnRecipeId: null` **even on a session
    that has one**, and does NOT claim — an accompaniment is not derived from the dish
    it accompanies, and the conversation stays listed on the dish it is attached to,
    so the new recipe has no origin chat. The dish on screen is never written to.
  - The pair on an attached chat is the whole distinction: **Review changes** folds
    the conversation into THIS dish behind a diff; **Save as new recipe** makes it a
    different dish and leaves this one alone. What kind it is saved as is the
    librarian's answer, bounded to `AUTHORABLE_RECIPE_KINDS` — see `isAuthorable`
    above; the button introduces no choice of its own.
- Variation chat (#763) — ⋮ → **Make a variation** on a recipe opens a NEW chat at
  `/chat/:id` carrying `basedOnRecipeId`, with a _Based on: …_ chip and an empty
  transcript. It navigates AWAY from the recipe deliberately: you are leaving that
  dish to make a different one. Nothing is written but the session doc until "Save
  as recipe", which is the same button a general chat already has — there is no
  new exit from the recipe-amend review gate, and Duplicate is untouched. Note the
  difference from "Save as new recipe" (#798): a variation is _this dish, but
  different_ and carries `basedOnRecipeId`; an accompaniment is _a different dish_
  and carries nothing.
- My Kitchen (`/mine`) — a "Recent chats" footer linking straight back into the last
  few conversations. Read-only and free: it projects the app-wide subscription
  started at auth, so it is a shortcut into chat, not a second place chat lives.
  Chef is the fourth primary nav tab again as of #828, which returned it the slot
  it lent the personal view in #634 — but that is the nav's doing, not this link's.

## Constraints inherited from the architecture

- All Gemini access via Genkit flows + callables in cloud-functions; **no AI keys in
  the client**.
- No new package and **no layer-map change** — schemas in `@salt/domain`, flows in
  `cloud-functions`, adapter/store in `firebase-sync` + `web-pwa`, UI primitives via
  `@salt/ui-components`.
- Recipe schema now holds live production data (module shipped to all members
  in #240, 2026-06-17) — recipe schema changes need back-compat on read or a
  migration, like any other production collection. Chat schema is brand-new
  (no back-compat burden yet).
