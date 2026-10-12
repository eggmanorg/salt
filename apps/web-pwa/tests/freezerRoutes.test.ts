import { describe, it, expect, vi } from 'vitest';

// The freezer's route (issue #1682). Code-split, so the table holds a THUNK — and
// a thunk nothing calls is a route that looks registered and cannot open. Same
// reasoning as libraryRoutes.test.ts, which this mirrors.

vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({})), initializeApp: vi.fn() }));

import { routes } from '../src/routes/index.js';
import { isFullViewportRoute } from '../src/routes/fullViewport.js';
import FreezerPage from '../src/routes/freezer/FreezerPage.svelte';

describe('the freezer route', () => {
  it('resolves /freezer to the freezer page', async () => {
    const entry = (routes as Map<string | RegExp, unknown>).get('/freezer') as {
      props: { load: () => Promise<{ component?: unknown; default?: unknown }> };
    };
    const loaded = await entry.props.load();
    expect(loaded.component ?? loaded.default ?? loaded).toBe(FreezerPage);
  });

  it('is an ordinary shell route, inside the app chrome', () => {
    expect(isFullViewportRoute('/freezer')).toBe(false);
  });
});
