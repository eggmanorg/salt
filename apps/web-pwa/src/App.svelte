<script lang="ts">
  import Router, { router } from 'svelte-spa-router';
  import {
    AppShell,
    Button,
    Toast,
    ToastAction,
    ToastClose,
    ToastDescription,
    ToastProvider,
    ToastViewport,
  } from '@salt/ui-components';
  import AuthGate from './components/AuthGate.svelte';
  import KitchenLink from './components/KitchenLink.svelte';
  import { auth } from './lib/auth.svelte.js';
  import { navItems, overflowNavItemsFor, adminNavItem } from './lib/nav.js';
  import { breadGate, libraryGate } from './lib/featureGate.js';
  import { routes } from './routes/index.js';
  import { isFullViewportRoute } from './routes/fullViewport.js';
  import { toasts, dismissToast } from './lib/toastStore.js';
  import { canonItems, initCanonSync } from './lib/canonService.js';
  import { productForms, initProductFormSync } from './lib/productFormService.js';
  import { kitchenTools, initKitchenToolSync } from './lib/kitchenToolService.js';
  import { equipment, equipmentIcons, initEquipmentSync } from './lib/equipmentService.js';
  import { pictureGapCount } from './lib/pictureGaps.js';
  import { initShoppingListSync } from './lib/shoppingListService.svelte.js';
  import { currentMember, initMembersSync } from './lib/membersService.js';
  import { initMealPlanSync } from './lib/mealPlanService.js';
  import { initShoppingDaySync } from './lib/shoppingDayService.js';
  import { recipes, initRecipeSync } from './lib/recipeService.js';
  import { initChatSync } from './lib/chatService.js';
  import { initDevSettingsSync } from './lib/devSettingsService.js';
  import { initAppSettingsSync } from './lib/appSettingsService.js';
  import { initWeatherSync } from './lib/weatherService.js';
  import { initCookTimerAlerts } from './lib/cookTimerAlerts.js';
  import { initMyCookSessionsSync } from './lib/cookSessionService.js';
  import { initKitchenTimerSync } from './lib/kitchenTimerService.js';
  import { runPendingShareImport } from './lib/shareTarget.js';
  import { envBanner } from './lib/environment.js';
  import SessionOverlay from './lib/dev/SessionOverlay.svelte';

  // Start Firestore subscriptions when authenticated; clean up on sign-out.
  $effect(() => {
    if (!auth.user) return;
    const unsubCanon = initCanonSync();
    const unsubProductForms = initProductFormSync();
    // The kitchen-tool pictogram vocabulary (issue #882). App-wide because it is
    // a lookup table, not a page's data: any surface that prints a container name
    // resolves it against this list at display time.
    const unsubKitchenTools = initKitchenToolSync();
    const unsubEquipment = initEquipmentSync();
    const unsubShopping = initShoppingListSync();
    const unsubMembers = initMembersSync();
    const unsubMealPlan = initMealPlanSync();
    // Follows the planner's selected week (initMealPlanSync above sets it), so it
    // must start after it.
    const unsubShoppingDay = initShoppingDaySync();
    const unsubRecipes = initRecipeSync();
    const unsubChat = initChatSync(auth.user.uid);
    // My open cook sessions (issue #634). App-wide rather than page-local: the
    // "resume a cook" card and its nav badge have to be answerable from any page.
    const unsubMyCooks = initMyCookSessionsSync(auth.user.uid);
    // Standalone kitchen timers (issue #842). App-wide for the same two reasons
    // as the cooks above: the nav badge counts a fired timer from any page, and
    // the chime watcher below has to be able to ring one that finishes while the
    // chef is somewhere else entirely.
    const unsubKitchenTimers = initKitchenTimerSync(auth.user.uid);
    const unsubDevSettings = initDevSettingsSync();
    const unsubAppSettings = initAppSettingsSync();
    const unsubWeather = initWeatherSync();
    // Not a Firestore subscription — a clock over the cook-session store the cook
    // page already fills. It lives here rather than on the cook page so a timer
    // still alerts once the chef has navigated away (see cookTimerAlerts.ts).
    const unsubCookTimers = initCookTimerAlerts();
    return () => {
      unsubCanon();
      unsubProductForms();
      unsubKitchenTools();
      unsubEquipment();
      unsubShopping();
      unsubMembers();
      unsubMealPlan();
      unsubShoppingDay();
      unsubRecipes();
      unsubChat();
      unsubMyCooks();
      unsubKitchenTimers();
      unsubDevSettings();
      unsubAppSettings();
      unsubWeather();
      unsubCookTimers();
    };
  });

  // Web Share Target hand-off (issue #589). main.ts captured the shared link before
  // mount; this runs it once auth has resolved, because the import goes through an
  // authenticated callable. Signed out, it drops the share with a toast rather than
  // resuming after sign-in (Rule 3 — no third browser-storage carve-out). The
  // pending share is single-use, so re-runs of this effect are no-ops.
  $effect(() => {
    if (auth.loading) return;
    void runPendingShareImport(!!auth.user);
  });

  // Admin-ness drives whether the operator-area nav entry is shown. Cosmetic
  // only — real enforcement is server-side (rules + CF admin re-checks, #155).
  // `currentMember` (membersService) is the same uid → email → member resolution
  // this used to do inline; the personal view needs it too, so it lives there now.
  const isAdmin = $derived($currentMember?.admin === true);

  // Canon management now lives behind the operator area (#157), so its
  // needs-approval backlog count rides on the Admin nav entry — visible only to
  // admins, who are the ones who action the review queue. Product-form proposals
  // (issue #500, Phase 3) share the same review affordance, so their pending count
  // sums into the one Admin badge alongside canon's.
  //
  // A THIRD SUMMAND, for the same reason (issue #1458): open picture gaps — a
  // record of your own kit with nothing drawn for it, and a name our content uses
  // that the drawn vocabulary cannot answer. Both were findable only by going to
  // look, which is why production sat on two undrawn records for months. The
  // arithmetic and what it deliberately leaves out are in `pictureGaps.ts`; it
  // reads only stores this app is already subscribed to, so the badge costs no
  // extra Firestore read.
  const reviewCount = $derived(
    $canonItems.filter((i) => i.needs_approval).length +
      $productForms.filter((f) => f.needs_approval).length +
      pictureGapCount($equipment?.items ?? [], $equipmentIcons, $recipes, $kitchenTools),
  );
  // Admin joins the overflow rather than the four primary tabs. The BottomNav sums
  // the overflow badges onto its "More" tab, so the review count still surfaces
  // even while Admin itself is folded away.
  // A full-viewport route (cook mode) replaces the shell's chrome rather than
  // painting over it (issue #641) — covered nav stays focusable and stays in the
  // accessibility tree, so a keyboard user tabs into invisible navigation and can
  // leave mid-cook by accident.
  const showChrome = $derived(!isFullViewportRoute(router.location));

  // Two cosmetic filters over one list, and they are different in kind. The admin
  // append hides an area you may not enter; `overflowNavItemsFor` hides a feature
  // that is still being built (issue #831), which nobody outside the test group is
  // meant to know exists — hence a filter rather than a disabled entry.
  const decoratedOverflowNavItems = $derived([
    ...overflowNavItemsFor({ bread: $breadGate.enabled, library: $libraryGate.enabled }),
    ...(isAdmin ? [reviewCount > 0 ? { ...adminNavItem, badge: reviewCount } : adminNavItem] : []),
  ]);
</script>

<AuthGate>
  <ToastProvider>
    <AppShell
      {navItems}
      overflowNavItems={decoratedOverflowNavItems}
      currentPath={router.location}
      chrome={showChrome}
      title="Salt"
      envLabel={envBanner?.label}
      envClass={envBanner?.barClass}
    >
      {#snippet actions()}
        <!--
          The header's right-hand side is the way into Kitchen (#828), which is in
          neither nav list — see lib/nav.ts. It replaced a span showing the
          signed-in email address, hidden below `sm` and of no use to anyone at any
          width: nobody needs an app they are signed in to to tell them who they
          signed in as.
        -->
        <KitchenLink />
        <Button variant="outline" size="sm" onclick={() => void auth.signOut()}>Sign out</Button>
      {/snippet}
      <Router {routes} />
    </AppShell>
    <!--
      Lift toasts above the mobile BottomNav so they don't cover it. Mirrors the
      nav reservation used by AppShell's <main>, and reads the same token it does
      (`--salt-layout-bottom-nav-height`, design.md `layout`) rather than the number.
      lg:bottom-0: the BottomNav is hidden on desktop, so drop back to the edge —
      as does a full-viewport route, which has no BottomNav to clear at any width.
    -->
    <ToastViewport
      class={showChrome
        ? 'bottom-[calc(var(--salt-layout-bottom-nav-height)_+_env(safe-area-inset-bottom))] lg:bottom-0'
        : ''}
    >
      {#each $toasts as toast (toast.id)}
        <Toast
          defaultOpen={true}
          variant={toast.variant}
          duration={toast.duration}
          showCountdown={!!toast.action}
          onOpenChange={(open) => {
            if (!open) {
              toast.onDismiss?.();
              dismissToast(toast.id);
            }
          }}
        >
          <ToastDescription>{toast.message}</ToastDescription>
          {#if toast.action}
            <ToastAction
              onclick={() => {
                toast.action?.onClick();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </ToastAction>
          {/if}
          <ToastClose />
        </Toast>
      {/each}
    </ToastViewport>
  </ToastProvider>
</AuthGate>

{#if import.meta.env.DEV && !window.__e2e}
  <SessionOverlay />
{/if}
