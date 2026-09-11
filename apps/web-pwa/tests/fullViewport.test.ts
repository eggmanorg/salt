import { describe, it, expect } from 'vitest';
import { isFullViewportRoute } from '../src/routes/fullViewport.js';

// Issue #641. This predicate is what makes App.svelte pass `chrome={false}` to
// AppShell, so a false negative puts focusable, screen-reader-visible navigation
// behind cook mode's overlay — and a false positive strips the nav off an ordinary
// page. Both failure modes are silent, hence the boundary cases below.

describe('isFullViewportRoute', () => {
  it('matches cook mode', () => {
    expect(isFullViewportRoute('/recipes/abc123/cook')).toBe(true);
    // Firestore ids are opaque; nothing here may assume a shape.
    expect(isFullViewportRoute('/recipes/A-b_9.zZ/cook')).toBe(true);
  });

  it('matches guided cook mode', () => {
    // Issue #751, Phase 2: the same mode read through the recipe's guided plan,
    // and so the same chrome-less treatment.
    expect(isFullViewportRoute('/recipes/abc123/cook/guided')).toBe(true);
    expect(isFullViewportRoute('/recipes/A-b_9.zZ/cook/guided')).toBe(true);
  });

  it('matches the batch cook page', () => {
    // Issue #1327: cook mode read through a running batch — the same hands-full
    // mode, so the same chrome-less treatment.
    expect(isFullViewportRoute('/batches/abc123/cook')).toBe(true);
    expect(isFullViewportRoute('/batches/A-b_9.zZ/cook')).toBe(true);
  });

  it('leaves the other batch routes their chrome', () => {
    // The run's own page and its log are desk work at the bench.
    expect(isFullViewportRoute('/batches')).toBe(false);
    expect(isFullViewportRoute('/batches/abc123')).toBe(false);
    expect(isFullViewportRoute('/batches/abc123/log')).toBe(false);
  });

  it('does not match the recipe routes either side of it', () => {
    expect(isFullViewportRoute('/recipes/abc123')).toBe(false);
    expect(isFullViewportRoute('/recipes/abc123/edit')).toBe(false);
    expect(isFullViewportRoute('/recipes')).toBe(false);
    // The PLAN EDITOR is desk work in the ordinary shell — never full-viewport.
    expect(isFullViewportRoute('/recipes/abc123/guided')).toBe(false);
  });

  it('anchors both ends — no prefix or suffix sneaks through', () => {
    expect(isFullViewportRoute('/recipes/abc123/cook/steps')).toBe(false);
    expect(isFullViewportRoute('/recipes/abc123/cook/guided/steps')).toBe(false);
    expect(isFullViewportRoute('/admin/recipes/abc123/cook')).toBe(false);
    expect(isFullViewportRoute('/admin/recipes/abc123/cook/guided')).toBe(false);
    // A nested id segment is a different route, not a cook page.
    expect(isFullViewportRoute('/recipes/a/b/cook')).toBe(false);
    expect(isFullViewportRoute('/recipes/a/b/cook/guided')).toBe(false);
    expect(isFullViewportRoute('/batches/abc123/cook/steps')).toBe(false);
    expect(isFullViewportRoute('/admin/batches/abc123/cook')).toBe(false);
    expect(isFullViewportRoute('/batches/a/b/cook')).toBe(false);
  });

  it('leaves every ordinary route with its chrome', () => {
    for (const path of ['/', '/mine', '/shopping/list-1', '/mealplan', '/settings', '/admin']) {
      expect(isFullViewportRoute(path)).toBe(false);
    }
  });
});
