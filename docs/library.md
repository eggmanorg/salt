# The library

**Status: all four phases of epic #1372 are built and live behind the `library`
feature flag.** Phase 1 pages you can write and read (#1372, PR #1374), phase 2
history and paste-in import (#1375, PR #1381), phase 3 diagrams behind a
sanitiser allowlist (#1376, PR #1388), phase 4 the chef's three note tools
(#1377, PR #1389). The epic stays open until the flag is lifted; nothing about
the feature is visible to anyone outside it.

The kitchen facts that are not recipes: which Weck jars are in the cupboard and
how much kraut each one holds, the Control Freak temperatures proven right in
this kitchen, a sous vide table lifted off a website.

This doc holds what no single file can: the map across five packages, the calls
that were made and what they were made against, the ledger of which safety
claims are mechanical, and the list of what is deliberately not built. Every
mechanism is explained beside the code — the module headers on
`schemas/libraryPage.ts`, `libraryService.ts` and `libraryImport.ts` are long
and they are the source. Read them, not a paraphrase here.

## Three siblings, and the boundary between them

| Thing             | Is                                            | Costs                               |
| ----------------- | --------------------------------------------- | ----------------------------------- |
| `kitchenMemories` | one line of standing preference               | injected into **every** chef turn   |
| `libraryPages`    | a thousand words nobody reads until they look | a tool call, when the chef needs it |
| `recipes`         | a dish, with ingredients and a method         | its own subsystem                   |

Merging the first two would put the jar dimensions into every prompt. That is
the whole reason the collection exists separately, and it is the test to apply
to anything proposed for either one.

**The model never sees the word "library" for these pages.** `LIBRARY_FRAMING`
in `chefChat.ts` already spends that word on the household's saved _recipes_,
and two things under one name in one system prompt is a collision for the model
and for the next reader. Tool names, tool descriptions and framing all say
**notes**. The collection, the schema and the app's routes keep their `library`
names. Do not "fix" the inconsistency in either direction.

## The parts

| File                                                             | Owns                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/domain/src/schemas/libraryPage.ts`                     | the document, the two length bounds, the revision cap, and `pushRevision`                           |
| `packages/domain/src/library/pageSummary.ts`                     | `libraryPageSummary` — the derived search line                                                      |
| `packages/domain/src/library/searchLibraryPages.ts`              | keyword filter over pages; a filter, not a ranking                                                  |
| `packages/adapters/firebase-sync/src/libraryPageSubscription.ts` | the collection subscription and the two writes                                                      |
| `apps/web-pwa/src/lib/libraryService.ts`                         | the store, the id, the clock, and the **one browser write path**                                    |
| `apps/web-pwa/src/lib/libraryImport.ts`                          | HTML → markdown for the paste-in import                                                             |
| `apps/web-pwa/src/routes/library/*.svelte`, `libraryTags.ts`     | the list, the page, the history sheet, the import sheet, the tag line                               |
| `apps/cloud-functions/src/flows/chefChat.ts`                     | `findKitchenNotes`, `readKitchenNote`, `writeKitchenNote` — the **second** writer                   |
| `packages/adapters/observability/src/shared/featureFlagKeys.ts`  | `LIBRARY_FLAG_KEY`, shared by both halves of the gate                                               |
| `firestore.rules` → `match /libraryPages/{pageId}`               | signed-in read and write, no `resource == null` clause because nothing dereferences `resource.data` |

Page ids are random UUIDs, so the subscription is a plain collection listener —
**unfiltered and unordered on the wire**, with searching and tag filtering done
client-side over tens of delivered documents. That is why there is no
`firestore.indexes.json` entry: a composite index makes a query cheap, and there
is no query.

The subscription is **not** started at app boot, unlike the `init*Sync()` calls
§9 of [salt-architecture.md](salt-architecture.md) lists. The two library
surfaces own its lifecycle (`$effect(() => initLibrarySync())`), the pattern
`BatchListPage` already uses, because nothing else in the app reads these
documents.

The chef half is documented where the chef is:
[ai-kitchen-assistant.md](ai-kitchen-assistant.md) — the tool shapes, the
fail-closed gate, and why writing is permitted here.

## The gate has two halves, and they fail in opposite directions

`library` is one PostHog flag read from two runtimes. The browser half
(`featureGate.ts` → `<FeatureGuard feature="library">`) is **cosmetic** — it
hides an unfinished screen, `firestore.rules` is untouched, and anyone with
devtools can turn it back on. The server half (`kitchenNotesEnabled` in
`chefChat.ts`) is not cosmetic and **fails closed** on a missing uid, because the
moment the chef can read a page, content written under the flag reaches a
household member the feature is hidden from, through an answer no browser gate
can reach (#831).

Do not read the browser half's "this is cosmetic" note as covering both.

## Calls that are settled

- **No folder tree.** A page is filed by tags, so "Fermentation" and "Sous vide"
  are filters rather than places and one page can be both. Adding a nullable
  `parentId` later stays purely additive; nothing in this repo is tree-shaped.
- **The list searches titles only.** A substring match inside a body answers
  "some page mentions this word", which a list of titles cannot then show you.
  Bodies become searchable in the app when there is something to show for a hit
  inside one. The chef searches bodies because a tool result can carry a summary.
- **The summary is derived at call time and never stored.** A `summary` field
  would be a second source of truth for the same prose, drifting the moment
  somebody edited the body, with nothing to notice — the same reasoning #1373
  gives for refusing a hand-written equipment summary.
- **`revisions` is embedded, not a subcollection.** It travels with the page on
  the single read the page already makes. What that costs under two writers is
  the ledger's last row, and it is the thing to weigh before a third writer is
  added.
- **The chef may write a note, though #1373 refused it for equipment.** That
  refusal's reason was specific — a quietly wrong equipment list is worse than a
  stale one, and there is no surface where a bad write would be noticed. Neither
  half holds for a note: it is a document somebody opens and reads, and #1375
  gave it a visible history with restore, so a wrong write is both noticeable
  and reversible. Read #1373's reason, not its rule.
- **The chef's standing two-tool limit was lifted for this**, Daniel's call on
  2026-09-14 with the cost in front of him. The mitigation is the shape
  `findRecipes`/`readRecipe` already use: a cheap search returning a summary per
  match, and a full read only when the detail matters.
- **`kind` is `z.literal('note')` and nothing branches on it.** It is carried
  from day one so widening it to an enum for a hosted, sandboxed "tool page" is
  additive. Nothing is built on it.

## Rule 12 ledger — what is mechanical, and what is only stated

CLAUDE.md Rule 12 asks that a stated safety property be pinned by a test or have
its limits stated. This feature makes several, across three runtimes, so they are
collected here rather than left one per header.

| The claim                                                                              | Mechanical?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A page can never outgrow a Firestore document                                          | **Yes** — `domain/tests/library/libraryPage.schema.test.ts` → "fits with a maximal body and a full history of maximal bodies" builds the worst case and measures it, so raising either bound goes red                                                                                                                                                                                                                                                                                                 |
| A restore that changes nothing writes nothing                                          | **Yes** — the short-circuit in `restoreLibraryRevision`, _not_ `pushRevision`'s dedup, which compares against `revisions[0]` and would record an eleventh copy of what is showing. `libraryHistory.test.ts` → "writes nothing at all when the chosen version is what is already showing"                                                                                                                                                                                                              |
| A restore puts back the version that was previewed, not whatever now sits at its index | **Yes** — matched on the whole snapshot, not the index. `libraryHistory.test.ts` → "restores the previewed version, not whatever now sits at its old position", and the `NotFound` case beside it                                                                                                                                                                                                                                                                                                     |
| No raw HTML reaches a page body through the paste-in import                            | **Yes**, three guards, each found by measurement: `DROP_WITH_CONTENTS` (without it `<script>alert(1)</script>` converts to the paragraph `alert(1)`), the cell/caption flattening that keeps the GFM plugin off its `outerHTML` bail-out, and `emitCellOnOneLine`, which states the property over the _converted text_ because the set of block elements that produce a newline cannot be enumerated (#1383). `libraryImport.test.ts`                                                                 |
| A `javascript:`/`data:` href never becomes a clickable link                            | **Yes** — a scheme **allowlist** on the conversion, independent of the render-side sanitiser. Salt serves no Content-Security-Policy, so both exist on their own merits. `libraryImport.test.ts` → "htmlToMarkdown — link schemes"                                                                                                                                                                                                                                                                    |
| The GFM plugin still has a cell rule to wrap                                           | **Yes** — `gfmTableCellRule` is exported so its throw is reachable; `libraryImport.test.ts` → "refuses to load at all if the GFM plugin stops registering a cell rule". A throw no green run can reach is a claim nothing checks                                                                                                                                                                                                                                                                      |
| The wrapper can tell the plugin skipped a cell from the plugin converting one          | **Yes** — asked of the plugin itself rather than a local copy of its private `tableShouldBeSkipped`: the skipped branch returns its argument identically, `cell()` never does, and that `===` is the discriminator. `libraryImport.test.ts` → "can tell the plugin skipped a cell from the plugin converting one" (#1410). A plugin release that moved the skipped path goes red there, not in one of the conversion tests quietly changing shape                                                     |
| Raw HTML in a rendered body is allowlisted                                             | **Yes**, and the allowlist is the _entire_ defence: `ui-components/src/primitives/Markdown/svgSanitizeSchema.ts` with `MarkdownSanitize.test.ts`, plus `sanitizedHtmlCallers.test.ts` → "is exactly the three library surfaces, and nothing else in the app". Read the module header before widening it                                                                                                                                                                                               |
| The chef cannot delete a note, and cannot empty one                                    | **Yes** — `chefChat.writeKitchenNote.test.ts` scans the module for a delete path of any shape, and a blank body is refused before any write                                                                                                                                                                                                                                                                                                                                                           |
| A human-authored version survives any run of consecutive chef writes                   | **Yes** — consecutive chef writes coalesce on `lastEditedBy === CHEF_AUTHOR_NAME`, so a chatty run cannot evict it through the cap (#1392/#1399). `chefChat.writeKitchenNote.test.ts` → "coalescing consecutive chef writes"                                                                                                                                                                                                                                                                          |
| The chef writes only when it is told to                                                | **No — stated, not enforced.** It lives in the tool description's DO-NOT-CALL-IT half, and prompt text is not a mechanism                                                                                                                                                                                                                                                                                                                                                                             |
| A version this browser write replaces is in the document it sends                      | **Yes, and that is the whole of the claim** — `libraryService.test.ts` → "revision capture — a second writer landed while the editor was open". It is a property of one write's document                                                                                                                                                                                                                                                                                                              |
| A version, once filed, stays filed                                                     | **No, and nothing here can make it so.** `revisions` is a field of a full-document `setDoc`, so any write built from a store that has not seen the previous one replaces the whole array — by another device, by the chef, or by this tab's own next write once its once-per-session snapshot is spent. Two people typing on one page can finish with neither overwritten version recorded. Pinned **as the boundary** by "loses it again when this tab writes once more after the other writer does" |

## What is not built

- **A durable history under concurrent writers.** The last ledger row is the
  live limit. Closing it means the tab remembering what it last wrote, turning
  one revision per session into one per session plus one per foreign write
  detected — a spec decision, not a fix, and not taken.
- **A nested or layout table survives the import as readable prose, not as
  markup, only at its bare-text minimum.** A cell with no blocks in it still
  concatenates straight into its neighbour with nothing between them
  (`innerouter`) — but #1410 stopped flattening what each cell _contains_ with
  it: an outer cell keeps its own paragraphs, and an inner table the plugin
  does convert arrives as a real pipe table. The no-markup property holds
  everywhere; readability now only fails at that minimum. What a nested or
  layout table _should_ become is still a product question with no answer yet.
- **Images.** The body is markdown and text; phase 3 bought hand-drawn SVG
  through the sanitiser allowlist, not an upload path.
- **Tool pages.** See `kind`, above.
- **e2e coverage.** There is none — the feature is unit-tested at every layer and
  has no Playwright spec. Behaviour that only shows up through a real browser
  (the paste interception, blur-then-write ordering, the sheet stack) is covered
  by component tests or by nothing.

## Before you change anything here

- Touching the revision machinery, the import converter or the chef's write tool
  means reading the module header first — each one records failure modes found by
  measurement, several of which read as over-caution until you know what they
  caught.
- Adding a **third** writer to `libraryPages` means re-reading the last ledger
  row before anything else. Two writers already cost recorded versions; a third
  is where it does real damage.
- A claim added to this feature gets a row in the ledger above, with its test or
  with its boundary. That is Rule 12, and this table is where it is paid.
