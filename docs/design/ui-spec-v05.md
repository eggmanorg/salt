# Salt 2.0 — UI Primitives Specification (v0.5)

**Status:** Planning  
**Scope:** `@salt/ui-components` — `ListPage` fill mode, `AppShell` full-viewport routes  
**Audience:** AI code-generation agents + human contributors

> Rule: If anything is missing or ambiguous → STOP → extend this spec → regenerate.  
> No invention beyond what is written here.

This document extends **v0.2**, **v0.3** and **v0.4**.  
All global rules, architecture, naming, styling, and testing conventions from v0.2 remain in force, as do v0.4's layout-component sections (§13, §16, §17) and its `ListPage` Selection Mode contract (§9).

---

## 0. v0.5 Scope

v0.5 introduces:

- **`ListPage` fill mode** — an opt-in `fill` prop that makes a page occupy the app shell's content area rather than grow with its content, handing the leftover height to `children` so the page can own its own scrolling surface (§1)
- **`AppShell` full-viewport routes** — an opt-in `chrome` prop that suppresses the shell's navigation for a route that owns the whole screen, plus the rules a full-viewport page must follow (§2)

Nothing in v0.5 changes the default behaviour of any existing component. `fill` defaults to `false` and `chrome` defaults to `true`; every page that does not pass them renders exactly as it did under v0.4.

---

# 1. ListPage — Fill mode

## 1.1 Overview

By default a `ListPage` grows with its content and `AppShell`'s `<main>` scrolls it. That is correct for essentially every list in the app and remains the default.

A small number of pages instead need to **own their own scrolling surface** — a gesture-driven deck, a virtualised list, a pane that must not move while something inside it does. Such a page needs a definite height to size that surface against, and it must not simultaneously be scrolled by an ancestor. `fill` provides both.

Precedent: the meal planner's week view (issue #639), which pages between days with the shared gesture deck (`apps/web-pwa/src/lib/deck.svelte.ts`) and therefore cannot be a natural-height page inside a scrolling `<main>`.

## 1.2 The height chain

`AppShell` (§13) renders:

```
div.flex.h-dvh.flex-col
  TopBar
  div.flex.flex-1.overflow-hidden
    SideNav
    main.flex-1.overflow-y-auto.pb-[calc(var(--salt-layout-bottom-nav-height)+env(safe-area-inset-bottom))].lg:pb-0
```

`<main>` therefore already has a **definite, bounded height** — it is a `flex-1` child of a fixed-height column. What was missing is that `ListPage` passed no height down to its children.

Under `fill`:

- The root `<section>` gains `h-full min-h-0`. `h-full` resolves against `<main>`'s definite height (and, because `<main>` carries the bottom-nav padding, resolves to the space _above_ the nav automatically). `min-h-0` allows the section to shrink inside the flex column rather than being floored at its intrinsic content height.
- The content wrapper gains `flex flex-1 flex-col` alongside its existing `min-h-0`, so it takes the height left over after the header and toolbar and passes it to `children`.

**`AppShell` is not modified, and must not be.** `<main>` is `overflow-y-auto`, which scrolls only _on overflow_. A page that exactly fills it therefore leaves it with nothing to scroll. The two mechanisms do not have to be coordinated because they never overlap.

## 1.3 Props

- `fill?: boolean` (default `false`). When `true`, the page fills the shell's content area and `children` receives the remaining height.

`fill` composes with every other `ListPage` prop, including selection mode. When `fill` and the contextual bottom action bar are both active, `pb-24` still applies — the fixed bar overlays the filled page exactly as it overlays a scrolling one.

Conditional classes are composed through `cn` (tailwind-merge), so a caller's own `class` continues to merge and override normally — the same mechanism as the existing `showActionBar && 'pb-24'`.

## 1.4 Consuming-page contract

A page passing `fill` **must** give its scrolling child a definite height from the chain — typically `min-h-0 flex-1` on the child that clips, with `overflow-hidden` if it owns the gesture itself. It must not reintroduce a second scroller inside a filled page unless that is the entire point of filling.

```svelte
<ListPage title="Meal plan" fill class="p-4 sm:p-6">
  {#snippet children()}
    <!-- header/nav chrome at natural height -->
    <div class="min-h-0 flex-1 overflow-hidden">
      <!-- the page's own scrolling / gesture surface -->
    </div>
  {/snippet}
</ListPage>
```

## 1.5 When NOT to use it

`fill` is for a page that owns a scrolling surface. It is **not** a way to make a page "fit on one screen", and it is not a fix for a page whose content is slightly too tall. An ordinary list that simply has many rows should keep the default and let `<main>` scroll it — that is the behaviour with native momentum, a real scrollbar, find-in-page, and correct zoom reflow, and it should be given up only for a specific interaction that requires it.

## 1.6 Testing requirements

- A default (`fill` unset) `ListPage` renders with no height classes on its root — proving existing pages are untouched.
- A `fill` `ListPage` renders `h-full` and `min-h-0` on its root and `flex-1` on its content wrapper.
- `fill` composes with `class`: a caller's padding still applies and is not dropped by `cn`.

## 1.7 Forbidden

- Do not set `overflow` on `AppShell`'s `<main>`, or otherwise modify `AppShell`, to make a filled page work. The overflow-only-on-overflow behaviour is the mechanism; overriding it couples the shell to one page.
- Do not compute a pixel height in a consuming page (`calc(100dvh - …)`, measuring `TopBar`, reading `clientHeight` to set a style). That hardcodes shell chrome into a page and breaks when the chrome changes; use `fill` and the height chain.
- Do not use `fill` merely to suppress page scrolling, or to make content fit without addressing why it overflows.
- Do not nest a second `fill` `ListPage` inside a filled one.

---

# 2. AppShell — Full-viewport routes

## 2.1 Overview

A **full-viewport route** is a page that occupies the entire screen with no app chrome: no `TopBar`, no `SideNav`, no `BottomNav`. Cook mode (`/recipes/:id/cook`) is the first.

The list, amended (§2.6 requires every member to be named here with its justification):

| Route                      | Page                    | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/recipes/:id/cook`        | `CookModePage.svelte`   | Cook mode (issue #641). Cooking is heads-down and hands-busy; a nav bar you can fat-finger mid-step is a hazard, not an escape hatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `/recipes/:id/cook/guided` | `GuidedCookPage.svelte` | Guided cook (issue #751, Phase 2). **The same mode**, read through the recipe's guided plan: the plan's prep list in place of the ingredient checklist, and the plan's notes under each step's own words. Same pager, same gestures, same keep-awake, same hands-full cook. It is a separate route rather than a flag on the first because what mise en place _is_ differs between them, and because which one you get is a choice made at the moment you start cooking — not a stored preference. Everything §2.2 says of cook mode is true of it verbatim.                                                                               |
| `/batches/:id/cook`        | `BatchCookPage.svelte`  | Cooking a run (issue #1327, epic #778). **The same mode again**, read through a running batch: the batch's frozen grams as the weigh-out, the run's stages as bands on the recipe steps they cite, and the schedule's own countdown where cook mode would arm a timer. Separate from the two above for the same reason they are separate from each other — what mise en place _is_ differs (grams you weigh, not a servings-scaled list), and which one you get is chosen at the moment you start, from the batch rather than from the recipe. It has no cook session, so it has no Finish: a batch ends on its stages, on the batch page. |

The plan **editor** (`/recipes/:id/guided`, issue #751 Phase 1) is deliberately _not_ on this list and must not be added: writing and reading a plan is desk work you do before you cook, and it belongs inside the shell you arrived from.

This is not the same thing as `ListPage` fill (§1). Fill is a page that fills the shell's content area; a full-viewport route **leaves the shell** entirely. Fill is a layout choice; this is a mode.

## 2.2 When it is justified

Only for a genuinely **modal, single-task mode** — one where the app's other destinations are not merely unused but actively unwanted for the duration. Cook mode qualifies: cooking is heads-down and hands-busy, and a nav bar you can fat-finger mid-step is a hazard, not an escape hatch.

It is **not** justified by a layout that is awkward inside the shell, by a page that wants more vertical room, or by a screen that "looks better" without a nav bar. Those are §1 problems, or design problems. A full-viewport route removes the user's way out; it must earn that.

## 2.3 `AppShell` props

```ts
chrome?: boolean; // default true
```

`chrome={false}` makes `AppShell` **not render** `TopBar`, `SideNav` or `BottomNav`, and drops `<main>`'s BottomNav height reservation. It adds no other behaviour: no focus trap, no scroll lock, no `inert`.

Not rendering is the mechanism, and the distinction is load-bearing. A page that paints over the shell with `fixed inset-0` leaves the chrome in the DOM — still in the tab order, still in the accessibility tree. Keyboard focus then lands on invisible navigation behind the overlay, and activating it navigates away mid-task; a screen-reader user browses the covered nav as though it were available. That was the defect in issue #641, and `inert` would only be the second-best fix for it.

## 2.4 The consuming app's contract

- The route is declared in `apps/web-pwa/src/routes/fullViewport.ts`; `App.svelte` derives `chrome` from it. A page must **not** reach for a store or a context to switch the shell off from the inside — the shell's shape is decided by the route, in one place, before the page renders.
- The page **moves focus into itself on mount** (a `tabindex="-1"` container is enough). The chrome that had focus is unmounted as the route activates, so without this the user's next Tab restarts at the top of the document.
- Focus on exit needs no ceremony **when the route was entered from a page that unmounts** — the element to restore to no longer exists, and focus falling to `<body>` with the chrome remounted puts the next Tab on the `TopBar`, which is the correct start of the restored page. A full-viewport route reachable from something that _survives_ must restore focus to it.
- The page owns the whole screen; it does not re-implement a `TopBar`. Its own header, if any, is its own design.

## 2.5 Testing requirements

- A default `AppShell` renders its chrome.
- `chrome={false}` renders no `header` and no `nav`, and leaves **nothing focusable** in the shell — assert on absence from the DOM, not on `inert` or `aria-hidden`.
- `chrome={false}` drops `<main>`'s BottomNav padding reservation.
- The consuming app's route predicate is anchored at both ends (a full-viewport route must not match by prefix).

## 2.6 Forbidden

- Do not add a full-viewport route without a spec amendment naming it and its justification in §2.1's table. The list is closed by default. (Worked example: guided cook, added by issue #751 Phase 2 — it earned its row by being cook mode itself rather than a new kind of screen.)
- Do not paint over the chrome instead of suppressing it — see §2.3.
- Do not give a full-viewport route `role="dialog"` / `aria-modal`. It is a route, not a layer over a page the user can return to; with the chrome gone there is no background to mark inert, and dialog semantics announce a modal that nothing opened.
- Do not put a focus trap in `AppShell`. There is nothing to trap focus away from once the chrome is not rendered.
