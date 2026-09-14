import { describe, expect, it, vi } from 'vitest';

// The nav lists themselves (src/lib/nav.ts). `goBack` has its own suite; this one
// guards the shape of the tabs, which is a design constraint rather than logic:
// FOUR primary destinations, and a single word on each of them.

vi.mock('svelte-spa-router', () => ({ push: vi.fn(), pop: vi.fn() }));

const { navItems, overflowNavItems, overflowNavItemsFor } = await import('../src/lib/nav.js');

describe('navItems', () => {
  it('is four primary destinations, no more', () => {
    // BottomNav splits a fixed bar into five equal columns — these four plus
    // "More" — so a fifth tab is a spec change, not an addition (ui-spec-v04 §17.1).
    expect(navItems.map((i) => i.id)).toEqual(['shopping', 'mealplan', 'recipes', 'chat']);
  });

  it('gives the fourth slot back to Chef', () => {
    // #828. Chef held this slot until #634 lent it to the personal view; it is the
    // one destination reached for mid-task, so it is worth a tap from anywhere.
    expect(navItems[3]).toMatchObject({ id: 'chat', label: 'Chef', href: '#/chat' });
  });

  it('keeps every tab label to one word — BottomNav never truncates', () => {
    for (const item of [...navItems, ...overflowNavItems]) {
      expect(item.label).not.toContain(' ');
    }
  });

  it('keeps Kitchen out of BOTH lists — the header is its only entry point', () => {
    // #828 moved the personal view into the TopBar. It is absent from the overflow
    // as well as the primary four on purpose: the desktop SideNav renders both
    // lists inline, so a nav entry would give desktop two routes to one page.
    expect(navItems.map((i) => i.id)).not.toContain('mine');
    expect(overflowNavItems.map((i) => i.id)).not.toContain('mine');
    // ...and Chef is no longer folded away behind "More".
    expect(overflowNavItems.map((i) => i.id)).not.toContain('chat');
  });

  it('puts the in-flight surface in the overflow, not in the primary four', () => {
    // Issue #812. A run is something you glance at once a morning, and the primary
    // four are full — a fifth tab is a spec change, not an addition. It is also
    // deliberately NOT folded into "Kitchen": batches are family-shared, and that
    // tab is a per-user projection.
    expect(overflowNavItems.find((i) => i.id === 'batches')).toMatchObject({
      label: 'Batches',
      href: '#/batches',
    });
    expect(navItems.map((i) => i.id)).not.toContain('batches');
  });

  it('puts the library in the overflow, not in the primary four', () => {
    // Epic #1372, and the same argument as Batches above: the primary four are
    // full, a reference page is something you go looking for rather than live in,
    // and the library is family-shared so it is not part of "Kitchen" either.
    expect(overflowNavItems.find((i) => i.id === 'library')).toMatchObject({
      label: 'Library',
      href: '#/library',
    });
    expect(navItems.map((i) => i.id)).not.toContain('library');
  });
});

describe('overflowNavItemsFor', () => {
  // Issue #831. Bread is being built in the open, so the household must not see a
  // door to it; epic #1372's library is the second feature behind the same
  // mechanism. What matters here is that the entry is ABSENT rather than present
  // and disabled — nothing may hint that a feature is being withheld.

  const ALL_ON = { bread: true, library: true };
  const ALL_OFF = { bread: false, library: false };
  const GATED = { batches: 'bread', library: 'library' } as const;

  it('keeps every destination when both features are on for this person', () => {
    expect(overflowNavItemsFor(ALL_ON).map((i) => i.id)).toEqual(overflowNavItems.map((i) => i.id));
  });

  it.each(Object.entries(GATED))('removes %s entirely when its feature is gated', (id, feature) => {
    const ids = overflowNavItemsFor({ ...ALL_ON, [feature]: false }).map((i) => i.id);

    expect(ids).not.toContain(id);
  });

  // The two gates are independent, which is the property a single shared boolean
  // would silently lose: gating one feature must not take the other's door with it.
  it.each(Object.entries(GATED))(
    'leaves the other gated entry alone when %s is off',
    (_id, feature) => {
      const ids = overflowNavItemsFor({ ...ALL_ON, [feature]: false }).map((i) => i.id);
      const other = Object.entries(GATED).find(([, f]) => f !== feature)?.[0];

      expect(ids).toContain(other);
    },
  );

  it('leaves every ungated destination alone either way', () => {
    // The filter is narrow on purpose: an unfinished feature disappears, the
    // set-up-and-forget destinations do not move.
    const gatedIds = Object.keys(GATED);
    const untouched = overflowNavItems.filter((i) => !gatedIds.includes(i.id));

    expect(overflowNavItemsFor(ALL_OFF)).toEqual(untouched);
    expect(overflowNavItemsFor(ALL_ON)).toEqual(overflowNavItems);
  });

  it('never mutates the list it filters', () => {
    // App.svelte spreads the result into a fresh array every time the flag or the
    // admin badge changes; a filter that edited the source would empty the nav.
    overflowNavItemsFor(ALL_OFF);

    expect(overflowNavItems.map((i) => i.id)).toEqual(expect.arrayContaining(Object.keys(GATED)));
  });
});
