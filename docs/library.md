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

**The model calls these pages the Library, and calls `recipes` recipes** — the
words `nav.ts` puts on screen. Only one of the two surfaces may hold "library"
in one system prompt, and #1377 originally gave it to the _recipes_ side,
renaming these pages "kitchen notes". Issue #1476 reversed that: neither "Recipe
Library" nor "Kitchen Notes" is a surface anyone can find in Salt, and the chef
duly told Daniel his recipe was not in his "Recipe Library" in the same breath
as writing it to the Library — he read it as a refusal and saved the dish twice.
The collision is still real; the word just belongs to the pages.

Tool **identifiers** (`findKitchenNotes`, `readKitchenNote`, `writeKitchenNote`)
kept their #1377 names — they never reach a user, and renaming them is churn.
So is the collection, the schema, the feature key and the routes. Do not "fix"
that inconsistency in either direction. What is pinned, in
`chefChat.kitchenNotes.test.ts`, is the assembled system prompt: it contains
neither "recipe library" nor "kitchen note" in either gate state, and carries
`## Their Library` and `## Their own recipes`.

## The parts

| File                                                             | Owns                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/domain/src/schemas/libraryPage.ts`                     | the document, the two length bounds, the revision cap, and `pushRevision`                           |
| `packages/domain/src/library/pageSummary.ts`                     | `libraryPageSummary` — the derived search line                                                      |
| `packages/domain/src/library/searchLibraryPages.ts`              | keyword filter over pages; a filter, not a ranking                                                  |
| `packages/domain/src/schemas/libraryBlocks.ts`                   | the `salt-<kind>` block schemas, the `tone` enum, and `parseLibraryBlock` (#1663)                   |
| `packages/domain/src/library/composedPage.ts`                    | the checks a laid-out page must pass to replace the chef's draft — blocks parse, no figure lost     |
| `packages/ui-components/src/primitives/DocBlocks/*`              | the presentational card, callout and stat primitives; tone → design token                           |
| `apps/web-pwa/src/routes/library/LibraryBlock.svelte`            | parses one block and draws it, or shows its text with a notice when it does not parse               |
| `apps/cloud-functions/src/flows/composeLibraryPage.ts`           | the page writer: lays out the chef's draft inside `writeKitchenNote`; writes nothing itself         |
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

## Laid-out pages (#1663)

A page body is still one Markdown string. Layout lives **inside** it, as fenced
code blocks whose info string is `salt-<kind>` (`cards`, `callout`, `stats`,
`steps`, and the drawings `chart`, `range`, `timeline`, `flow`, `shapes`)
holding YAML, so
`LibraryPageSchema` did not change and every older body is already valid. Tables on the three library surfaces are drawn in Salt's colours
by `Markdown`'s doc scale; blocks are drawn by `LibraryBlock` through
`Markdown`'s `blocks` prop (ui-spec-v04 §12.7). Chat and recipe notes pass no
`blocks`, so a `salt-` fence there stays a code block.

The chef's `writeKitchenNote` body is a **draft**. Before saving, the handler
asks `composeLibraryPage` to lay it out; the layout is saved only if
`checkComposedPage` accepts it, otherwise the draft is saved exactly as sent and
the tool answers `laidOut: false`. The page writer is a step inside the chef's
write, not a third writer — there are still two.

**Drawings are drawn from figures.** A `chart`, `range` or `timeline` block
holds numbers, not a picture: `DocChart`, `DocRangeMap` and `DocTimeline` place
each mark by its value, so a figure edited by hand moves its mark. A figure is
kept as the text typed (`1,062` shows as `1,062`) beside the number it means;
anything that is not a plain number — a unit inside the value, a word — is a
broken block, shown as its text. Positions are percentages laid out by CSS, so
a drawing has no fixed width; the only width-dependent choice, how many axis
ticks fit, is made for a 360px phone (`docScale.ts` → `axisFor`).

**Flow charts are laid out, shapes are drawn to measurement.** A `flow` block is
boxes and arrows; `layoutLibraryFlow` (domain, beside the schema) puts each box
one row below the lowest box feeding it, carries an arrow that skips rows
through a pass slot in each, and refuses a loop or a row wider than three — so
the parsed block is already a grid, and `DocFlowChart` only places it. A
`shapes` block draws each vessel from its `mouth`, `height` and the widths its
`profile` uses, every shape in the block on ONE scale (`docDiagram.ts` →
`shapeScale`). The page writer may not invent a measurement: `checkComposedPage`
refuses a `salt-shapes` measurement that is not a figure in the draft, and the
guide tells it to keep the table when the draft has none. `steps` are numbered
captions, each with an optional gauge drawn to scale like any other figure.

**Freehand drawings are a trial, in tones only.** For what no kind draws — how a
clip sits on a lid — the guide lets the page writer put one inline `<svg>` on a
page, through the same `sanitizedHtml` allowlist as any hand-typed drawing.
That allowlist narrows `fill` and `stroke` to the five tone names and `none`
(`svgSanitizeSchema.ts` → `SVG_PAINTS`); any other paint is drawn `muted`
(`rehypeToneOnlyPaint`, before the sanitiser), and `Markdown`'s doc styles map
each name to its token. The capability stays only on Daniel's call from the
trial; dropping it is the guide section and the paint rule, nothing else.

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

| The claim                                                                              | Mechanical?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A page can never outgrow a Firestore document                                          | **Yes** — `domain/tests/library/libraryPage.schema.test.ts` → "fits with a maximal body and a full history of maximal bodies" builds the worst case and measures it, so raising either bound goes red                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A restore that changes nothing writes nothing                                          | **Yes** — the short-circuit in `restoreLibraryRevision`, _not_ `pushRevision`'s dedup, which compares against `revisions[0]` and would record an eleventh copy of what is showing. `libraryHistory.test.ts` → "writes nothing at all when the chosen version is what is already showing"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A restore puts back the version that was previewed, not whatever now sits at its index | **Yes** — matched on the whole snapshot, not the index. `libraryHistory.test.ts` → "restores the previewed version, not whatever now sits at its old position", and the `NotFound` case beside it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| No raw HTML reaches a page body through the paste-in import                            | **Yes**, three guards, each found by measurement: `DROP_WITH_CONTENTS` (without it `<script>alert(1)</script>` converts to the paragraph `alert(1)`), the cell/caption flattening that keeps the GFM plugin off its `outerHTML` bail-out, and `emitCellOnOneLine`, which states the property over the _converted text_ because the set of block elements that produce a newline cannot be enumerated (#1383). `libraryImport.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A `javascript:`/`data:` href never becomes a clickable link                            | **Yes** — a scheme **allowlist** on the conversion, independent of the render-side sanitiser. Salt serves no Content-Security-Policy, so both exist on their own merits. `libraryImport.test.ts` → "htmlToMarkdown — link schemes"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The GFM plugin still has a cell rule to wrap                                           | **Yes** — `gfmTableCellRule` is exported so its throw is reachable; `libraryImport.test.ts` → "refuses to load at all if the GFM plugin stops registering a cell rule". A throw no green run can reach is a claim nothing checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| The wrapper can tell the plugin skipped a cell from the plugin converting one          | **Yes** — asked of the plugin itself rather than a local copy of its private `tableShouldBeSkipped`: the skipped branch returns its argument identically, `cell()` never does, and that `===` is the discriminator. `libraryImport.test.ts` → "can tell the plugin skipped a cell from the plugin converting one" (#1410). A plugin release that moved the skipped path goes red there, not in one of the conversion tests quietly changing shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Raw HTML in a rendered body is allowlisted                                             | **Yes**, and the allowlist is the _entire_ defence: `ui-components/src/primitives/Markdown/svgSanitizeSchema.ts` with `MarkdownSanitize.test.ts`, plus `sanitizedHtmlCallers.test.ts` → "is exactly the three library surfaces, and nothing else in the app". Read the module header before widening it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| The chef cannot delete a note, and cannot empty one                                    | **Yes** — `chefChat.writeKitchenNote.test.ts` scans the module for a delete path of any shape, and a blank body is refused before any write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A human-authored version survives any run of consecutive chef writes                   | **Yes** — consecutive chef writes coalesce on `lastEditedBy === CHEF_AUTHOR_NAME`, so a chatty run cannot evict it through the cap (#1392/#1399). `chefChat.writeKitchenNote.test.ts` → "coalescing consecutive chef writes"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Colour on a block is a named tone, never a value                                       | **Yes** — no block schema has a colour, class or style field; `domain/tests/library/libraryBlocks.test.ts` → "colour is a tone, never a value" walks every schema. `ui-components/tests/DocBlocks.test.ts` pins that every tone maps to a token class, not a raw colour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A drawing typed into a page paints only in Salt's tones                                | **Yes, for `fill` and `stroke`.** `MarkdownSanitize.test.ts` → "is the schema that refuses a non-tone paint, rewrite or no rewrite" (the allowlist alone), "turns an arbitrary hex, a colour word or a reference into the default tone" (the rewrite) and "has a style rule painting every tone name, for fill and for stroke". Bounded: `opacity` and `fill-opacity` are still free, so a tone can be paled but not changed; the `salt-*` block primitives never pass through this rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A drawing is drawn to one scale from its figures                                       | **Yes, for where each mark is placed — not for how a browser lays it out.** `ui-components/tests/docScale.test.ts` pins that a value maps to its axis position, bars and pie slices are in proportion, and the ticks chosen leave room between labels at 360 px and 412 px — arithmetic over the layout's own constants, since jsdom lays nothing out; `DocDrawings.test.ts` pins the percentage each mark is given and that changing a figure moves it. `composeLibraryPage.test.ts` pins that every example in the style guide parses. Flow charts and shapes (Phase 4): `libraryFlowStepsShapes.test.ts` sweeps 400 seeded charts up to the 12-box cap for every box drawn once, every arrow traced row to row and no row wider than three, and `docDiagram.test.ts` pins that slots never share a half-column, that every shape's outline reaches and never passes its measured box, and that equal heights draw equal on one scale. That a page writer's shape is MEASURED, not guessed, is `composedPage.test.ts` → "refuses a measurement the page writer made up" — bounded: the number must appear somewhere in the draft                                              |
| A broken block shows its text and a notice, never a blank                              | **Yes** — `parseLibraryBlock` returns, never throws (`libraryBlocks.test.ts`); `LibraryPageView.test.ts` → "shows a broken block as the text that was written". Bounded to the block kinds' schemas: a block the scanner and the renderer disagree about (a fence nested in a list) is simply drawn or not drawn by the renderer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Only the library surfaces draw blocks, and the hook opens no raw-HTML route            | **Yes** — `libraryBlocksCallers.test.ts` lists the three surfaces; `ui-components/tests/MarkdownBlocks.test.ts` pins that the hook runs after the sanitiser and that a raw `<salt-block>` is never drawn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The page writer never costs a write, and keeps every number token the draft held       | **Yes, for number tokens as written — not for which item they sit on.** `composeLibraryPage.test.ts` refuses a layout that drops a number, carries a bad block or one nested in a list or quote, is blank, errors or times out; `chefChat.writeKitchenNote.test.ts` pins that the handler then saves the draft. The figure check compares number tokens as a multiset, ordered-list markers aside, so a figure moved to a different item, a dropped minus sign and a changed unit all pass (`composedPage.test.ts` pins that boundary); it cannot tell a derived total that is _wrong_ from one that is right, and it does not check words                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A chat turn that writes no page costs what it did before the page writer               | **Yes, to one sentence** — `chefChat.kitchenNotes.test.ts` → "the chat prompt is not where pages are laid out" bounds the framing plus the write tool's description against the pre-#1663 baseline and bans the style guide's vocabulary from both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The chef writes only when it is told to                                                | **No — stated, not enforced.** It lives in the tool description's DO-NOT-CALL-IT half, and prompt text is not a mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| The chef never says "recipe library" or "kitchen note" to a user (issue #1476)         | **Partial.** `chefChat.kitchenNotes.test.ts` asserts the assembled system prompt holds neither exact bigram, in both gate states, and separately asserts neither appears in the two Library tool descriptions. That is the whole of it. It does **not** reach: any GATED section of the prompt — the fixture's `dbWith` throws for every collection but `libraryPages`, so the equipment framing, favourites, kitchen memory, `## Current recipe` and variation framing never appear in the assembled prompt it checks, and a regression in any of them is invisible to this test; the recipes-side tool descriptions (`FIND_RECIPES_DESCRIPTION`, `READ_RECIPE_DESCRIPTION`), which carry no vocabulary assertion in `chefChat.findRecipes.test.ts`; or the bare word "library" anywhere — only the two bigrams are banned, so e.g. "their library" would ship green. The four schema `.describe()` files under `packages/domain/src/schemas` that Genkit renders into the tool-call JSON schema (`findRecipes.ts`, `readRecipe.ts`, `findKitchenNotes.ts`, `readKitchenNote.ts`) are pinned by nothing at all — the widest blast radius in this change, and the least covered |
| A version this browser write replaces is in the document it sends                      | **Yes, and that is the whole of the claim** — `libraryService.test.ts` → "revision capture — a second writer landed while the editor was open". It is a property of one write's document                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A version, once filed, stays filed                                                     | **No, and nothing here can make it so.** `revisions` is a field of a full-document `setDoc`, so any write built from a store that has not seen the previous one replaces the whole array — by another device, by the chef, or by this tab's own next write once its once-per-session snapshot is spent. Two people typing on one page can finish with neither overwritten version recorded. Pinned **as the boundary** by "loses it again when this tab writes once more after the other writer does"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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
- **A freehand drawing's labels are not checked.** The figure check counts
  every number on the page, so a number in a drawing's coordinates (`x="130"`)
  can stand in for a `130` the layout dropped, and a figure written into a
  drawing's label is not compared with the draft. The guide forbids figures in
  a label; nothing enforces it. **Flow charts with loops** are refused rather than drawn: the layout
  runs top to bottom and has no route for an arrow back up.
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
