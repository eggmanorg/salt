import {
  Blender,
  BookOpen,
  CalendarDays,
  ChefHat,
  Hourglass,
  Library,
  Settings,
  Shield,
  ShoppingCart,
} from '@lucide/svelte';
import type { NavItem } from '@salt/ui-components';
import { pop, push } from 'svelte-spa-router';

// The daily-driver destinations. Kept to FOUR so the mobile BottomNav has room for
// its active-indicator pill; everything else goes in `overflowNavItems`. The
// desktop SideNav shows both lists inline (see AppShell).
//
// The fourth slot is Chef (the AI Kitchen Assistant, issue #206), returned to the
// primary four by #828. It is the one destination reached for mid-task, hands
// occupied, so one tap from anywhere is most of what it is worth; it held this
// slot until #634 handed it to the personal view and spent the interval folded
// into the overflow.
//
// The personal view ("Kitchen", #634/#682/#755) is deliberately in NEITHER list.
// #828 moved it into the TopBar's actions area, where it reads as the signed-in
// member's own name ("Daniel's Kitchen") at every width and carries the live
// "what's open now" count that used to hang off this tab — see App.svelte, where
// the stores it counts are subscribed. Keeping a nav entry as well would give the
// desktop SideNav (which renders both lists inline) two competing routes to one
// destination, so the header is its single entry point at every breakpoint.
//
// One word per label by necessity — BottomNav gives each of five columns an equal
// slice of a fixed bar and never truncates (ui-spec-v04 §17.2).
export const navItems: NavItem[] = [
  { id: 'shopping', label: 'Shop', icon: ShoppingCart, href: '#/shopping' },
  { id: 'mealplan', label: 'Planner', icon: CalendarDays, href: '#/mealplan' },
  { id: 'recipes', label: 'Recipes', icon: BookOpen, href: '#/recipes' },
  { id: 'chat', label: 'Chef', icon: ChefHat, href: '#/chat' },
];

// Set-up-and-forget destinations: folded behind the BottomNav's "More" tab on
// mobile. `adminNavItem` is appended here (admins only) in App.svelte.
//
// "Batches" (issue #812, phase 1 of epic #778) is the in-flight surface: what is
// proving, fermenting or curing right now, and what each one wants next. It sits
// here rather than in the primary four because the primary four are full — a fifth
// tab is a spec change, not an addition (ui-spec-v04 §17.1) — and because a run is
// something you glance at once a morning, not a destination you live in. It is
// NOT part of "Kitchen": that is a per-user projection, and a batch is family-shared.
// The hourglass is the noun, not the food: phases 03 and 04 put ferments and cures
// on this same surface, so a loaf would have been the wrong picture.
//
// "Library" (epic #1372) is the same kind of destination and sits here for the same
// reason: the primary four are full, and a reference page is something you go
// looking for once in a while rather than a place you live. It is family-shared, so
// like Batches it is NOT part of "Kitchen".
export const overflowNavItems: NavItem[] = [
  { id: 'batches', label: 'Batches', icon: Hourglass, href: '#/batches' },
  { id: 'equipment', label: 'Equipment', icon: Blender, href: '#/equipment' },
  { id: 'library', label: 'Library', icon: Library, href: '#/library' },
  { id: 'settings', label: 'Settings', icon: Settings, href: '#/settings' },
];

/**
 * The overflow list minus entries whose feature is still gated (issue #831).
 *
 * A plain boolean in, a list out — this module deliberately does NOT import
 * `featureGate.js`. The vocabulary of features lives there, the live answer is
 * read at the call site (App.svelte, beside the admin append), and this stays a
 * pure function of its argument so the filtering itself is testable without a
 * PostHog stand-in.
 */
export function overflowNavItemsFor(features: { bread: boolean; library: boolean }): NavItem[] {
  return overflowNavItems.filter((item) => {
    if (item.id === 'batches') return features.bread;
    if (item.id === 'library') return features.library;
    return true;
  });
}

// Operator-area entry (issues #155, #157). Appended to the nav only for admins —
// see App.svelte, which also hangs the canon needs-approval badge here now that
// canon management lives behind the operator area. Cosmetic gating only; the
// real boundary is server-side.
export const adminNavItem: NavItem = {
  id: 'admin',
  label: 'Admin',
  icon: Shield,
  href: '#/admin',
};

// A back button should return you to wherever you came from, not to a section's
// home list. Every page navigates with svelte-spa-router's `push('/fixed/route')`,
// so a hard-coded back destination is wrong the moment you arrive from anywhere
// other than that list (open a recipe from the planner, hit back, land on the
// recipes list). `goBack` uses real browser history instead.
//
// The catch: `pop()` is `window.history.back()`, which on a PWA cold-launch /
// deep-link / shared URL — where the detail page is the FIRST entry in this tab —
// walks the user straight out of the app. So we track our depth in the in-app
// history stack: svelte-spa-router navigates by setting `window.location.hash`,
// which creates a fresh history entry (its own state carries only scroll data, no
// marker of ours). On every `hashchange` we stamp the current entry with a
// monotonic `__saltIdx` if it has none; a back/forward navigation restores an
// already-stamped entry and is left untouched. The router preserves our marker
// because it always spreads `...history.state` when it writes scroll state, and
// `replace()` reuses the same (already-stamped) entry. `goBack` then reads the
// current entry's index: index 0 (or an unstamped entry) means nothing in-app is
// behind us, so it falls back to the caller's route instead of popping out.
let saltIdxCounter = -1;

function stampCurrentEntry(): void {
  const state = (window.history.state ?? {}) as { __saltIdx?: number };
  if (state.__saltIdx == null) {
    saltIdxCounter += 1;
    window.history.replaceState({ ...state, __saltIdx: saltIdxCounter }, '');
  }
}

if (typeof window !== 'undefined') {
  stampCurrentEntry(); // the initial landing entry becomes index 0
  window.addEventListener('hashchange', stampCurrentEntry);
}

/**
 * Return to the previous in-app screen. Falls back to `fallback` when the current
 * screen is the first in-app history entry (cold-launch / deep-link / shared URL),
 * so a back press never ejects the user out of the app.
 */
export function goBack(fallback: string): void {
  const idx = (window.history.state as { __saltIdx?: number } | null)?.__saltIdx ?? 0;
  if (idx > 0) pop();
  else push(fallback);
}
