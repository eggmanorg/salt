import { describe, it, expect, vi } from 'vitest';

// The library's two routes (epic #1372, Phase 1).
//
// Both are code-split, so what the route table holds is a THUNK — and a thunk
// nothing ever calls is a route that looks registered and cannot open. That is the
// failure this file exists for: `lazyRoute` already pins the wrapper's behaviour
// and every page test mounts its component directly, so between them nothing
// checks that the table's entry actually resolves to the right component.
//
// It imports the real route table, which eagerly pulls in a dozen page modules.
// That is why the services they touch are stubbed below — importing a Svelte
// component module does not render it, but it does run its imports.

vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({})), initializeApp: vi.fn() }));

import { routes } from '../src/routes/index.js';
import LibraryListPage from '../src/routes/library/LibraryListPage.svelte';
import LibraryPageView from '../src/routes/library/LibraryPageView.svelte';

/** Run a wrapped route's loader and return the component it resolves to. */
async function resolve(path: string): Promise<unknown> {
  const entry = (routes as Map<string | RegExp, unknown>).get(path) as {
    props: { load: () => Promise<{ component?: unknown; default?: unknown }> };
  };
  const loaded = await entry.props.load();
  return loaded.component ?? loaded.default ?? loaded;
}

describe('the library routes', () => {
  it('registers both, static before parameterised', () => {
    const paths = [...(routes as Map<string | RegExp, unknown>).keys()];
    expect(paths).toContain('/library');
    expect(paths).toContain('/library/:id');
    expect(paths.indexOf('/library')).toBeLessThan(paths.indexOf('/library/:id'));
  });

  it('resolves /library to the list', async () => {
    expect(await resolve('/library')).toBe(LibraryListPage);
  });

  it('resolves /library/:id to the page view', async () => {
    expect(await resolve('/library/:id')).toBe(LibraryPageView);
  });
});
