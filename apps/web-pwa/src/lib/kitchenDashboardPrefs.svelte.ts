// "My Kitchen" workbench preferences — which sections show, how dense the
// layout is, and whether the in-progress cook's banner renders. NOT persisted
// (CLAUDE.md Rule 3: no localStorage/sessionStorage/IndexedDB outside the two
// narrow pre-auth exceptions in auth.svelte.ts, and this isn't one of them).
// A module-level rune singleton, same shape as install.svelte.ts / auth.svelte.ts
// — in-memory only, so it resets to the defaults below on reload or a fresh tab,
// but survives navigating away from and back to /mine within the same session.

export type KitchenSection = 'timers' | 'live' | 'tasks' | 'upcoming' | 'review' | 'chats';
export type KitchenDensity = 'comfortable' | 'compact';

const DEFAULT_SECTIONS: Record<KitchenSection, boolean> = {
  timers: true,
  live: true,
  // To do (issue #1685) — shown only behind the `freezer` gate, whatever this says.
  tasks: true,
  upcoming: true,
  review: true,
  chats: true,
};

class KitchenDashboardPrefs {
  sections = $state<Record<KitchenSection, boolean>>({ ...DEFAULT_SECTIONS });
  density = $state<KitchenDensity>('comfortable');
  imagery = $state(true);

  toggleSection(section: KitchenSection): void {
    this.sections[section] = !this.sections[section];
  }

  setDensity(density: KitchenDensity): void {
    this.density = density;
  }

  setImagery(on: boolean): void {
    this.imagery = on;
  }

  reset(): void {
    this.sections = { ...DEFAULT_SECTIONS };
    this.density = 'comfortable';
    this.imagery = true;
  }
}

export const kitchenPrefs = new KitchenDashboardPrefs();
