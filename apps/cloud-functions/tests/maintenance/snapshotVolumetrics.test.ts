import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit-level (mock-based, no emulator) coverage of the daily volumetrics
// snapshot (issue #684): count() aggregations only — no document reads, no
// writes — emitted as a single PostHog event so dashboards/alerts can watch
// collection growth. The kind arithmetic is the part worth pinning: `kind` is
// schema-defaulted and absent on pre-#637 recipe docs, so plain recipes must be
// derived, never queried.

vi.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (_opts: unknown, handler: unknown) => handler,
}));

vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: () => 'test-posthog-key' }),
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockCapture = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
const mockReport = vi.fn();
vi.mock('@salt/observability/server', () => ({
  captureServerEvent: mockCapture,
  flushServerObservability: mockFlush,
  createServerObservabilityErrorReportingAdapter: vi.fn(() => ({ report: mockReport })),
}));

// Collection-aware Firestore mock exposing only the aggregate-count surface the
// handler is allowed to use. Any call to doc()/get() on a collection would throw
// (undefined is not a function) — which is exactly the assertion that no
// document is ever read.
let mockCounts: Record<string, number> = {};
const mockCountQueries: string[] = [];

function countable(key: string) {
  return {
    count: () => ({
      get: async () => {
        mockCountQueries.push(key);
        if (!(key in mockCounts)) throw new Error(`unexpected count query: ${key}`);
        return { data: () => ({ count: mockCounts[key] }) };
      },
    }),
  };
}

const mockDb = {
  collection: (name: string) => ({
    ...countable(name),
    where: (field: string, _op: string, value: unknown) =>
      countable(`${name}.${field}=${String(value)}`),
  }),
};
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => mockDb,
}));

const { snapshotVolumetrics, VOLUMETRICS_SNAPSHOT_EVENT } =
  await import('../../src/maintenance/snapshotVolumetrics.js');

beforeEach(() => {
  vi.clearAllMocks();
  mockCountQueries.length = 0;
  mockCounts = {
    recipes: 40,
    'recipes.kind=special': 3,
    'recipes.kind=cocktail': 2,
    'recipes.kind=placeholder': 21,
    // #1404. The per-kind queries are derived from `RecipeKindSchema.options`, so
    // a new kind is counted the day it is added and this fixture has to say so.
    'recipes.kind=cure': 4,
    canonItems: 150,
    'canonItems.needs_approval=true': 4,
    productForms: 60,
    'productForms.needs_approval=true': 5,
  };
});

describe('snapshotVolumetrics', () => {
  it('captures one event with all counts, deriving plain recipes as the remainder', async () => {
    await (snapshotVolumetrics as unknown as Function)();

    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith(VOLUMETRICS_SNAPSHOT_EVENT, {
      recipes_total: 40,
      recipes_special: 3,
      recipes_cocktail: 2,
      recipes_placeholder: 21,
      recipes_cure: 4,
      // 40 − 3 − 2 − 21 − 4: pre-#637 docs carry no `kind` field, so this can only
      // ever be arithmetic — a where('kind','==','recipe') query must not exist.
      recipes_recipe: 10,
      canon_items_total: 150,
      canon_items_needs_approval: 4,
      product_forms_total: 60,
      product_forms_needs_approval: 5,
    });
    expect(mockFlush).toHaveBeenCalled();
  });

  it('never queries kind==recipe (absent on pre-#637 docs)', async () => {
    await (snapshotVolumetrics as unknown as Function)();

    expect(mockCountQueries).not.toContain('recipes.kind=recipe');
  });

  it('never throws out of the scheduled handler, reports, and always flushes', async () => {
    delete mockCounts['canonItems']; // makes that aggregate get() reject

    await expect((snapshotVolumetrics as unknown as Function)()).resolves.toBeUndefined();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockReport).toHaveBeenCalledWith(expect.any(Error), 'SyncError');
    expect(mockFlush).toHaveBeenCalled();
  });
});
