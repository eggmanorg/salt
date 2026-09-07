import type { Component } from 'svelte';
import type { RouteDefinition, WrappedComponent } from 'svelte-spa-router';
import EquipmentListPage from './equipment/EquipmentListPage.svelte';
import EquipmentCapturePage from './equipment/EquipmentCapturePage.svelte';
import EquipmentEditPage from './equipment/EquipmentEditPage.svelte';
import ShoppingListRedirectPage from './shopping/ShoppingListRedirectPage.svelte';
import ShoppingListCreatePage from './shopping/ShoppingListCreatePage.svelte';
import ShoppingListsManagePage from './shopping/ShoppingListsManagePage.svelte';
import ShoppingListPage from './shopping/ShoppingListPage.svelte';
import MealPlanWeekPage from './mealplan/MealPlanWeekPage.svelte';
import MinePage from './mine/MinePage.svelte';
import SettingsPage from './settings/SettingsPage.svelte';
import NotFound from './NotFound.svelte';
import { lazy } from './lazyRoute';

// Lazily code-split routes (issue #411). Each `import()` becomes its own chunk,
// kept out of the boot bundle: the admin area drags in Leaflet (the map picker
// in AppSettings → HomeLocationField → LocationMapField), and chat + recipes are
// large, module-specific screens ~most sessions never open. Deferring them
// shrinks first load and lets a deploy that touches only one area re-download
// just that chunk. The core daily-use views (shopping, equipment, meal plan,
// settings) stay eagerly imported so the default route paints immediately.
//
// `lazy` (./lazyRoute) shows a dependency-free RouteLoading placeholder while a
// chunk fetches, and — when a chunk STILL fails after Phase 1's one silent
// auto-reload — an inline "couldn't load this page — retry" fallback instead of
// hanging on the loader (issue #472, Phase 2).

// One wrapper, six routes (see the admin block below): a fresh `lazy()` per entry
// would be six wrappers around the same chunk.
const catalogPage = lazy(() => import('./admin/CatalogPage.svelte'));

// More-specific static routes must precede parameterised ones when using a Map.
// The Map is typed with RouteDefinition's own value type: without it, `new Map`
// infers a heterogeneous union of `Component<Props>` tuples that TS cannot unify
// to a single readonly entry type under exactOptionalPropertyTypes (the pages
// have differing `params` props), so the constructor overload fails to match.
export const routes: RouteDefinition = new Map<
  string | RegExp,
  Component<any, any> | WrappedComponent
>([
  // Shopping is the default view; '/' redirects to the user's shopping list.
  // "Mine" is deliberately NOT the default (issue #634) — a personal view has to
  // earn its visit. Eagerly imported: it is small and it is a daily-driver.
  ['/', ShoppingListRedirectPage],
  ['/mine', MinePage],
  ['/equipment', EquipmentListPage],
  ['/equipment/new', EquipmentCapturePage],
  ['/equipment/:id', EquipmentEditPage],
  ['/shopping', ShoppingListRedirectPage],
  ['/shopping/new', ShoppingListCreatePage],
  ['/shopping/lists', ShoppingListsManagePage],
  ['/shopping/:listId', ShoppingListPage],
  ['/mealplan', MealPlanWeekPage],
  // Same page, opened on the week containing a given date (issue #629): the
  // shopping list's shop-day chip deep-links here. Must follow the static route.
  ['/mealplan/:date', MealPlanWeekPage],
  // Chat / AI Kitchen Assistant (issue #206). Lazy-loaded (#411).
  ['/chat', lazy(() => import('./chat/ChatListPage.svelte'))],
  // "What I remember" (issue #816) — the household's standing notes for the chef.
  // Static, so it precedes '/chat/:id' like every other pair here; an ordinary
  // shell route, so no entry in ./fullViewport.ts.
  ['/chat/remembered', lazy(() => import('./chat/ChatMemoryPage.svelte'))],
  ['/chat/:id', lazy(() => import('./chat/ChatSessionPage.svelte'))],
  // Recipe module (issue #179). More-specific static/edit routes precede the
  // parameterised view route. Lazy-loaded (#411).
  ['/recipes', lazy(() => import('./recipes/RecipeListPage.svelte'))],
  ['/recipes/new', lazy(() => import('./recipes/RecipeEditPage.svelte'))],
  // Same editor, creating a non-recipe kind (issue #637): `/recipes/new/outing`
  // is "When you CBA". The kind is set here and only here — it is immutable, so
  // there is no selector in the form and no way to change it after the fact. An
  // unrecognised segment falls back to a plain new recipe (the page validates it
  // with RecipeKindSchema); a URL is user input.
  ['/recipes/new/:kind', lazy(() => import('./recipes/RecipeEditPage.svelte'))],
  ['/recipes/:id/edit', lazy(() => import('./recipes/RecipeEditPage.svelte'))],
  // Guided cook (issue #751, Phase 2) precedes plain cook mode for the same
  // more-specific-first reason as every other pair here. A SECOND full-viewport
  // route, and so a second entry in ./fullViewport.ts: it is cook mode with the
  // recipe's guided plan as a lens — the prep list in place of the ingredient
  // checklist, and the plan's notes under each step's own words.
  ['/recipes/:id/cook/guided', lazy(() => import('./recipes/GuidedCookPage.svelte'))],
  ['/recipes/:id/cook', lazy(() => import('./recipes/CookModePage.svelte'))],
  // The guided-plan EDITOR (issue #751, Phase 1). An ordinary shell route — desk
  // work, not a hands-full mode — so it gets no entry in ./fullViewport.ts.
  ['/recipes/:id/guided', lazy(() => import('./recipes/GuidedPlanPage.svelte'))],
  // The formula screen (issue #806, phase 1 of epic #778). Also an ordinary shell
  // route — desk work, once a month — so no entry in ./fullViewport.ts. It shipped
  // reachable BY URL ONLY; #812 gave it an entry point on the recipe page for a
  // recipe that ALREADY HAS a formula, and #823 gave it one for a recipe that has
  // never had a formula but LOOKS like it could ("Make it scalable", gated on the
  // domain's basis guess — an item on every recipe would put baker's percentages in
  // front of every weeknight curry to serve the three loaves). The URL stays as the
  // escape hatch for a loaf that guess misses; it is no longer the only way in.
  ['/recipes/:id/formula', lazy(() => import('./recipes/FormulaPage.svelte'))],
  // A meal's cook plan (issue #752, phase 4) — the dashboard for the evening: the
  // meal and its component dishes in running order, each with a start time counted
  // back from one serve time. An ORDINARY shell route, and so NO entry in
  // ./fullViewport.ts: cook mode is the modal single-task deck, and this is a hub
  // you bounce in and out of all evening with the nav still under it.
  ['/recipes/:id/cook-plan', lazy(() => import('./recipes/MealCookPlanPage.svelte'))],
  ['/recipes/:id', lazy(() => import('./recipes/RecipeViewPage.svelte'))],
  // Batches (issue #812, phase 1 of epic #778) — the in-flight surface and one
  // run's own screen. Static before parameterised, as everything above. ORDINARY
  // shell routes, so no entry in ./fullViewport.ts: a batch is desk work at the
  // bench, and the list is a thing you glance at with the nav still under it.
  // Lazy-loaded (#411) on the same argument as the recipe module — a
  // module-specific screen most sessions never open.
  ['/batches', lazy(() => import('./batches/BatchListPage.svelte'))],
  // The batch log (issue #1280) — what actually happened to a run, as against the
  // plan. ABOVE `/batches/:id` because the more specific pattern has to match first,
  // and an ordinary shell route like the two around it.
  ['/batches/:id/log', lazy(() => import('./batches/BatchLogPage.svelte'))],
  ['/batches/:id', lazy(() => import('./batches/BatchDetailPage.svelte'))],
  ['/settings', SettingsPage],
  // Operator area (issues #155, #157). All routes are guarded client-side by
  // AdminGuard; the real boundary is server-side (rules + CF admin checks).
  // Canon management lives here (not the user nav) because approving/curating
  // canon records is an operator activity — see #157. Lazy-loaded (#411): the
  // whole admin area (incl. Leaflet, pulled in by the app-settings map picker)
  // is code-split out of the boot path.
  ['/admin', lazy(() => import('./admin/AdminHomePage.svelte'))],
  ['/admin/members', lazy(() => import('./admin/AdminMembersPage.svelte'))],
  ['/admin/mealplan', lazy(() => import('./admin/AdminMealPlanPage.svelte'))],
  ['/admin/dev-settings', lazy(() => import('./admin/DevSettingsPage.svelte'))],
  ['/admin/app-settings', lazy(() => import('./admin/AppSettingsPage.svelte'))],
  ['/admin/aisles', lazy(() => import('./canon/AisleManagementPage.svelte'))],
  // The drawn kitchen-tool vocabulary (issue #882). A SIBLING of the catalog, not
  // a third record kind in it: a tool shares no aisle, no match pipeline and no
  // approval queue with the two grocery kinds, so it gets its own screen.
  ['/admin/kitchen-tools', lazy(() => import('./admin/KitchenToolsPage.svelte'))],
  // The catalog (issue #872) — one list for canon items and their product forms,
  // in place of the two it replaced. `/admin/canon` and `/admin/product-forms`
  // survive as ALIASES so existing bookmarks still land somewhere correct: the
  // page reads the path it was reached by to preset the filter and to know which
  // collection a bare `:id` belongs to. One `catalogPage` wrapper serves all six
  // entries, so moving between them never re-fetches the chunk.
  ['/admin/catalog', catalogPage],
  ['/admin/catalog/:id', catalogPage],
  ['/admin/canon', catalogPage],
  ['/admin/canon/new', lazy(() => import('./canon/CanonCreatePage.svelte'))],
  ['/admin/canon/:id', catalogPage],
  ['/admin/product-forms', catalogPage],
  ['/admin/product-forms/new', lazy(() => import('./admin/ProductFormEditPage.svelte'))],
  ['/admin/product-forms/:id', catalogPage],
  ['*', NotFound],
]);

// Which of these are FULL-VIEWPORT routes — running without the app shell's nav
// chrome — is declared next door in ./fullViewport.ts (issue #641). Keep the two
// in step: a new full-viewport page needs an entry there as well as here.
