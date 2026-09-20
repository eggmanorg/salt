import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { normaliseMemberEmail } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { KitchenToolDoc } from '@salt/domain/schemas';

// The kitchen-tools page's docked-pane gate (issue #1489), the mirror of
// `CatalogPage.docked.test.ts`.
//
// The page now carries the Catalog's two-pane shape, which means it carries the
// Catalog's dependency on `createMediaQuery(SPLIT_QUERY)` — and the four ways
// that read can fail are exactly the ones #933 wrote down. `false` is the answer
// whenever the question cannot be asked, and the phone path is the honest
// default: a page that thinks it is docked when it is not opens nothing anywhere.
//
// Asserted through the page's own output: choosing a tool either navigates to
// `/admin/kitchen-tools/:id` (phone) or docks it beside the list
// (`kitchen-tool-editor-pane`).

const { mockRecipes, mockMembers, mockIsLoading, mockAuth, toolSink } = await vi.hoisted(
  async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockRecipes: makeStore<readonly Recipe[]>([]),
      mockMembers: makeStore<{ email: string; admin: boolean }[]>([]),
      mockIsLoading: makeStore<boolean>(false),
      mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
      toolSink: { push: null as null | ((tools: readonly unknown[]) => void) },
    };
  },
);

vi.mock('svelte-spa-router', () => ({
  push: vi.fn(),
  pop: vi.fn(),
  router: { location: '/admin/kitchen-tools', querystring: '' },
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));
vi.mock('../src/lib/membersService.js', () => ({
  members: mockMembers,
  isLoadingMembers: mockIsLoading,
  currentMember: {
    subscribe(fn: (v: { email: string; admin: boolean } | null) => void) {
      return mockMembers.subscribe((roster) => {
        const email = mockAuth.user?.email ?? '';
        if (!email) return fn(null);
        const normalised = normaliseMemberEmail(email);
        fn(roster.find((m) => m.email === normalised) ?? null);
      });
    },
  },
}));
vi.mock('../src/lib/recipeService.js', () => ({ recipes: mockRecipes }));
vi.mock('../src/lib/guidedPlanService.js', () => ({
  loadAllGuidedPlansForCuration: vi.fn(async () => ({ kind: 'ok', value: [] })),
}));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: () => ({ report: vi.fn() }),
}));
vi.mock('@salt/firebase-sync', () => ({
  subscribeKitchenTools: vi.fn((onTools: (tools: readonly unknown[]) => void) => {
    toolSink.push = onTools;
    return () => {};
  }),
  upsertKitchenTool: vi.fn(async () => ({ kind: 'ok' as const, value: undefined })),
  deleteKitchenTool: vi.fn(async () => ({ kind: 'ok', value: undefined })),
  // Salt's proposal per undrawn word (#1458 Phase 2). Answering nothing is the
  // no-proposal state, which is what every assertion in this file was written
  // against: each gap row keeps `suggestKitchenToolParent`'s head-noun suggestion.
  callProposeKitchenTools: vi.fn(async () => ({
    kind: 'ok' as const,
    value: { proposals: [] },
  })),
}));

import { push } from 'svelte-spa-router';
import {
  initKitchenToolSync,
  __resetKitchenToolServiceForTest,
} from '../src/lib/kitchenToolService.js';
import KitchenToolsPage from '../src/routes/admin/KitchenToolsPage.svelte';

const WHISK: KitchenToolDoc = {
  id: 'whisk',
  schemaVersion: 1,
  label: 'Whisk',
  matchers: [],
  thumbnail: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderTools() {
  mockMembers._set([{ email: 'admin@e.org', admin: true }]);
  const rendered = render(KitchenToolsPage);
  toolSink.push?.([WHISK]);
  return rendered;
}

/** Choose "Whisk" — the wide copy, which is the one `EditableRow` shows here. */
async function openWhisk(): Promise<void> {
  await fireEvent.click(await screen.findByTestId('kitchen-tool-row-name-wide'));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.user = { email: 'admin@e.org' };
  mockIsLoading._set(false);
  mockRecipes._set([]);
  initKitchenToolSync();
});

afterEach(() => {
  cleanup();
  __resetKitchenToolServiceForTest();
  toolSink.push = null;
  document.body.innerHTML = '';
});

describe('KitchenToolsPage — the docked-pane media query, failure paths', () => {
  const realMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  /** A complete `MediaQueryList` stub — the shape the house pattern expects. */
  function fullStub(matches: boolean): typeof window.matchMedia {
    return ((query: string) => ({
      media: query,
      matches,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  it.each([
    [
      'matches: true, full listener API — docks beside the list',
      () => {
        window.matchMedia = fullStub(true);
      },
      true,
    ],
    [
      'matchMedia missing entirely — falls back to the phone layout, no throw',
      () => {
        window.matchMedia = undefined as unknown as typeof window.matchMedia;
      },
      false,
    ],
    [
      'matchMedia throws on call — falls back to the phone layout, no throw',
      () => {
        window.matchMedia = (() => {
          throw new Error('matchMedia is not supported here');
        }) as unknown as typeof window.matchMedia;
      },
      false,
    ],
    [
      'MediaQueryList with no addEventListener, matches: true — the one-shot read still docks',
      () => {
        window.matchMedia = ((query: string) => ({
          media: query,
          matches: true,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
      },
      true,
    ],
  ] as const)('%s', async (_label, setUp, expectDocked) => {
    setUp();
    renderTools();

    await openWhisk();

    if (expectDocked) {
      // Docked: no navigation, the tool opens beside the list instead.
      await waitFor(() => {
        expect(screen.getByTestId('kitchen-tool-editor-pane')).toBeInTheDocument();
      });
      expect(vi.mocked(push)).not.toHaveBeenCalled();
    } else {
      await waitFor(() => {
        expect(vi.mocked(push)).toHaveBeenCalledWith('/admin/kitchen-tools/whisk');
      });
      expect(screen.queryByTestId('kitchen-tool-editor-pane')).toBeNull();
    }
  });

  it('takes the whole screen below the seam, with a Back button', async () => {
    // The phone half of the pair, reached by the route rather than by a click —
    // which is what `push` above actually does in the app.
    window.matchMedia = fullStub(false);
    mockMembers._set([{ email: 'admin@e.org', admin: true }]);
    render(KitchenToolsPage, { props: { params: { id: 'whisk' } } });
    toolSink.push?.([WHISK]);

    await screen.findByTestId('kitchen-tool-editor-page');
    expect(screen.queryByTestId('kitchen-tool-editor-pane')).toBeNull();
    // The list is not beside it — the editor IS the screen.
    expect(screen.queryByTestId('kitchen-tool-list')).toBeNull();
    expect(screen.getByText('Back')).toBeInTheDocument();
  });
});
