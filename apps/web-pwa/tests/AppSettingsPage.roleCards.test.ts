import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { normaliseMemberEmail } from '@salt/domain';
import type { Member } from '@salt/domain';
import {
  AI_FLOW_IDS,
  AI_FLOW_ROLES,
  AI_MODEL_DEFAULTS,
  AI_MODEL_ROLES,
  type AiModelRole,
} from '@salt/domain/schemas';

/**
 * The role cards' job lists are GENERATED, and this is what says so mechanically
 * (issue #935).
 *
 * Each of the five cards used to carry a hand-written sentence naming the jobs
 * that used that tier, and four of the five had fallen behind — the Image card
 * said "canon-item icons" while the image model drew four families. The fix was
 * to stop writing the list down twice: the card renders the registry, so adding
 * a flow to `AI_FLOW_ROLES` puts it on a card with no prose to edit.
 *
 * A comment claiming that would be exactly the defect CLAUDE.md rule 12 names,
 * so the assertion below walks EVERY registry entry and demands its label on its
 * own role's card and on no other. Break the derivation — hard-code a list, drop
 * a role, group by the wrong key — and it goes red.
 *
 * Its boundary: it proves the card matches the registry. It cannot prove the
 * registry matches what the Cloud Functions actually run; that is the flow-id
 * signature's job (`resolveModel(flowId)`), stated at `AI_FLOW_ROLES` itself.
 */
// Five vi.mock calls, the house ceiling (unit-test spec UT-B1): the admin guard's
// two (auth + members), the two services this page reads, and firebase-sync for
// the weather field's subscription. Everything else — the router, toasts, nav,
// geocoding — is left real because nothing hereexercises it.
const { mockMembers, mockAuth, mockAppSettings, mockCatalog, readable } = await vi.hoisted(
  async () => {
    const { makeStore } = await import('./support/testStore.js');
    return {
      mockMembers: makeStore<Member[]>([]),
      mockAuth: { user: { email: 'admin@e.org' } as { email: string } | null },
      mockAppSettings: makeStore<unknown>(null),
      mockCatalog: makeStore<Record<string, unknown[]>>({
        fast: [],
        lite: [],
        pro: [],
        embedding: [],
        image: [],
      }),
      // A one-shot readable, for the derived stores the page only reads.
      readable: <T>(value: T) => ({
        subscribe: (fn: (v: T) => void) => {
          fn(value);
          return () => {};
        },
      }),
    };
  },
);

vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth }));
vi.mock('../src/lib/membersService.js', () => ({
  members: mockMembers,
  isLoadingMembers: { subscribe: (fn: (v: boolean) => void) => (fn(false), () => {}) },
  currentMember: {
    subscribe(fn: (v: Member | null) => void) {
      return mockMembers.subscribe((roster) => {
        const email = mockAuth.user?.email ?? '';
        if (!email) return fn(null);
        const normalised = normaliseMemberEmail(email);
        fn(roster.find((m) => m.email === normalised) ?? null);
      });
    },
  },
}));

vi.mock('../src/lib/appSettingsService.js', () => ({
  appSettings: mockAppSettings,
  isLoadingAppSettings: readable(false),
  isAppSettingsCorrupt: readable(false),
  effectiveModels: readable(AI_MODEL_DEFAULTS),
  effectiveFlowModels: readable(
    Object.fromEntries(AI_FLOW_IDS.map((id) => [id, AI_MODEL_DEFAULTS[AI_FLOW_ROLES[id]]])),
  ),
  setModelRole: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  resetModelRole: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  setFlowOverride: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  resetFlowOverride: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  setHomeLocation: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  resetHomeLocation: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

vi.mock('../src/lib/aiModelCatalogService.js', () => ({
  catalogByRole: mockCatalog,
  isCatalogLoading: readable(false),
  isCatalogUnavailable: readable(false),
  hasCatalog: readable(false),
  ensureCatalog: vi.fn().mockResolvedValue(undefined),
  refreshCatalog: vi.fn().mockResolvedValue(undefined),
  testModel: vi.fn(),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeWeatherForecast: () => () => {},
  callRefreshWeatherForecast: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import AppSettingsPage from '../src/routes/admin/AppSettingsPage.svelte';

beforeEach(() => {
  mockMembers.set([
    {
      schemaVersion: 1,
      id: 'admin@e.org',
      name: 'Admin',
      email: 'admin@e.org',
      admin: true,
      sortOrder: 0,
      icon: null,
      cookMode: 'standard',
      system: false,
      updatedAt: '2026-09-02T00:00:00.000Z',
    } as unknown as Member,
  ]);
});

afterEach(() => cleanup());

const jobsTextFor = (role: AiModelRole): string =>
  screen.getByTestId(`app-settings-role-jobs-${role}`).textContent ?? '';

describe('AppSettingsPage role cards list the jobs from the registry', () => {
  it('gives each role exactly the jobs the registry assigns it, and 24 in total', () => {
    render(AppSettingsPage);

    const listed = Object.fromEntries(
      AI_MODEL_ROLES.map((role) => [
        role,
        jobsTextFor(role)
          .replace(/^\s*Used by:\s*/, '')
          .split('·')
          .map((s) => s.trim())
          .filter(Boolean),
      ]),
    ) as Record<AiModelRole, string[]>;

    for (const role of AI_MODEL_ROLES) {
      const expected = AI_FLOW_IDS.filter((id) => AI_FLOW_ROLES[id] === role).length;
      expect(listed[role], `the ${role} card lists the wrong number of jobs`).toHaveLength(
        expected,
      );
    }

    // Every job appears exactly once across the five cards — no flow silently
    // absent (the defect this replaces) and none double-counted.
    const all = AI_MODEL_ROLES.flatMap((role) => listed[role]);
    expect(all).toHaveLength(AI_FLOW_IDS.length);
    expect(new Set(all).size).toBe(AI_FLOW_IDS.length);
  });

  it('names four picture families on the image card and three jobs on the pro card', () => {
    render(AppSettingsPage);

    // The two the issue called out by name: the Image card said "canon-item
    // icons" while four families use it, and the Pro card said "Chef Chat"
    // while three jobs do.
    expect(jobsTextFor('image')).toContain('Canon icon generation');
    expect(jobsTextFor('image')).toContain('Equipment pictogram generation');
    expect(jobsTextFor('image')).toContain('Kitchen tool pictogram generation');
    expect(jobsTextFor('image')).toContain('Recipe hero image generation');
    expect(jobsTextFor('pro')).toContain('Chef Chat');
    expect(jobsTextFor('pro')).toContain('Guided plan');
    expect(jobsTextFor('pro')).toContain('Schedule proposal');
    // And the merged embedding job is one switch, not two (phase 2).
    expect(jobsTextFor('embedding')).toContain('Embed text');
    expect(jobsTextFor('embedding')).not.toContain('Server embedding');
  });
});
