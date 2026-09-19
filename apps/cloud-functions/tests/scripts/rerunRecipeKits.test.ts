import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression coverage for `scripts/rerun-recipe-kits.ts` itself — the three
// BLOCKING findings from the PR #1483 review, none of which the pure
// `kitRerunPlan.ts` half can see (docs/one-shot-scripts.md §2 says only that
// half is normally reachable by a test, because the script self-executes on
// import). Firestore, the filesystem and the equipment reader are all mocked
// here, so this never touches a real project — the whole suite runs against
// fakes, not against dev/staging/prod.
//
//   1. A recipe whose inference is merely SLOW must not be declared failed —
//      see 'a slow-but-successful inference'.
//   2. Completion is decided by the stamp's VALUE, not its presence — see
//      'a stale client write restoring the old stamp'.
//   3. The report is durable across the run, not only at the end — see
//      'the report already holds a finished recipe's before/after'.

// The real STAMP_TIMEOUT_MS is 360_000ms (AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS*1000
// + 60_000 headroom) at POLL_MS=3_000ms per poll — the comments below refer to
// both by value rather than importing them, since the script does not export
// them (docs/one-shot-scripts.md §2: this file is the disposable half).
//
// A stamp value the real clock (2026-ish epoch ms) can never reach — used as
// "genuinely fresher than any `requestedAt` this suite captures", since the
// comparison under test is against the real `Date.now()` at run time, not a
// fixed reference.
const FAR_FUTURE = 9_999_999_999_999;

const writeFileMock = vi.fn(async (_path: string, _data: string, _enc: string) => undefined);
vi.mock('node:fs/promises', () => ({ writeFile: writeFileMock }));

vi.mock('firebase-admin/app', () => ({
  initializeApp: vi.fn(),
  applicationDefault: vi.fn(),
}));

vi.mock('../../src/flows/equipmentContext.js', () => ({
  readEquipmentItems: vi.fn(async () => []),
}));

interface FakeDoc {
  readonly id: string;
  data(): Record<string, unknown> | undefined;
}

/** A recipe queue: `.get()` shifts through this list, repeating the last entry. */
const pollQueues = new Map<string, Array<{ exists: boolean; data?: Record<string, unknown> }>>();
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
let initialDocs: FakeDoc[] = [];

function nextPoll(id: string): { exists: boolean; data?: Record<string, unknown> } {
  const queue = pollQueues.get(id);
  if (!queue || queue.length === 0) throw new Error(`no canned poll response for ${id}`);
  return queue.length > 1 ? queue.shift()! : queue[0]!;
}

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => '__DELETE__' },
  getFirestore: () => ({
    collection: (name: string) => {
      if (name === 'devSettings') {
        return { doc: () => ({ get: async () => ({ exists: false }) }) }; // fails open → enabled
      }
      return {
        get: async () => ({ docs: initialDocs }),
        doc: (id: string) => ({
          get: async () => {
            const next = nextPoll(id);
            return { exists: next.exists, data: () => next.data };
          },
          update: async (patch: Record<string, unknown>) => {
            updateCalls.push({ id, patch });
          },
        }),
      };
    },
  }),
}));

function recipeDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r1',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Untitled',
    description: null,
    ingredients: [],
    steps: [{ id: 's1', text: 'Do the thing', timer: null, note: null }],
    metadata: { servings: null, phases: [], timingSummary: null, tags: [] },
    source: null,
    notes: null,
    kit: [{ label: 'frying pan', equipment: null, stepIds: ['s1'] }],
    kitInferredAt: 1_000,
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Runs the script fresh: resets its module cache so top-level code re-executes. */
async function runScript(): Promise<void> {
  vi.resetModules();
  await import('../../scripts/rerun-recipe-kits.js');
  // Let every chained setTimeout (`sleep`) in the polling/settle loop resolve —
  // the fake clock advances as each one fires, so this drains the whole run.
  await vi.runAllTimersAsync();
}

describe('rerun-recipe-kits — blocking findings from PR #1483', () => {
  const originalArgv = process.argv;
  const originalEnv = process.env['GOOGLE_CLOUD_PROJECT'];

  beforeEach(() => {
    vi.useFakeTimers();
    pollQueues.clear();
    updateCalls.length = 0;
    writeFileMock.mockClear();
    process.env['GOOGLE_CLOUD_PROJECT'] = 's2-test-fake';
    process.argv = ['node', 'rerun-recipe-kits.ts', '--write', '--out', './kit-rerun-test.md'];
  });

  afterEach(() => {
    vi.useRealTimers();
    process.argv = originalArgv;
    if (originalEnv === undefined) delete process.env['GOOGLE_CLOUD_PROJECT'];
    else process.env['GOOGLE_CLOUD_PROJECT'] = originalEnv;
  });

  it('does not declare a slow-but-successful inference failed (blocking 1)', async () => {
    // 65 "not yet" polls (~195s at POLL_MS=3000) is well past the OLD hardcoded
    // 180_000ms STAMP_TIMEOUT_MS — this recipe would have been misreported as
    // NEVER STAMPED under the pre-review code — but still inside the new
    // AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS-derived budget.
    const notYet = { exists: true, data: recipeDoc({ id: 'r-slow', title: 'Slow Dish' }) };
    const fresh = {
      exists: true,
      data: recipeDoc({
        id: 'r-slow',
        title: 'Slow Dish',
        kitInferredAt: FAR_FUTURE, // stamped fresh by the trigger, well after requestedAt
        kit: [
          {
            label: 'frying pan',
            equipment: { itemId: 'eq-pans', accessoryId: null },
            stepIds: ['s1'],
          },
        ],
      }),
    };
    initialDocs = [{ id: 'r-slow', data: () => recipeDoc({ id: 'r-slow', title: 'Slow Dish' }) }];
    pollQueues.set('r-slow', [...Array(65).fill(notYet), fresh]);

    await runScript();

    expect(updateCalls).toHaveLength(1);
    const lastReport = writeFileMock.mock.calls.at(-1)?.[1] as string;
    expect(lastReport).toContain('Slow Dish');
    expect(lastReport).not.toContain('NEVER STAMPED');
    expect(lastReport).toContain('re-linked');
  });

  it('does not finish early on a stale write that restores the old stamp (blocking 2)', async () => {
    // First poll: a client `setDoc` composed before our update landed BETWEEN our
    // update and the trigger's write, so the document reads with the OLD stamp
    // and OLD kit still present — "presence" alone would call this done right
    // here, with the wrong kit. It must be read as NOT YET DONE, because the
    // stamp's value predates this run's `requestedAt`.
    const staleClobber = {
      exists: true,
      data: recipeDoc({
        id: 'r-clobber',
        title: 'Clobbered Dish',
        kitInferredAt: 500, // older than requestedAt — a restored OLD stamp
        kit: [{ label: 'saucepan', equipment: null, stepIds: ['s1'] }],
      }),
    };
    const genuinelyFresh = {
      exists: true,
      data: recipeDoc({
        id: 'r-clobber',
        title: 'Clobbered Dish',
        kitInferredAt: FAR_FUTURE,
        kit: [
          {
            label: 'saucepan',
            equipment: { itemId: 'eq-pans', accessoryId: null },
            stepIds: ['s1'],
          },
        ],
      }),
    };
    initialDocs = [
      {
        id: 'r-clobber',
        data: () =>
          recipeDoc({
            id: 'r-clobber',
            title: 'Clobbered Dish',
            kit: [{ label: 'saucepan', equipment: null, stepIds: ['s1'] }],
          }),
      },
    ];
    pollQueues.set('r-clobber', [staleClobber, staleClobber, genuinelyFresh]);

    await runScript();

    const lastReport = writeFileMock.mock.calls.at(-1)?.[1] as string;
    expect(lastReport).toContain('Clobbered Dish');
    // The genuinely fresh link, not the stale clobber's "no link".
    expect(lastReport).toContain('re-linked');
    expect(lastReport).not.toMatch(/No change/);
  });

  it('keeps a finished recipe in the report even though the run continues (blocking 3)', async () => {
    const firstFresh = {
      exists: true,
      data: recipeDoc({
        id: 'r-first',
        title: 'Alpha Dish',
        kitInferredAt: FAR_FUTURE,
        kit: [
          {
            label: 'whisk',
            equipment: { itemId: 'eq-whisks', accessoryId: null },
            stepIds: ['s1'],
          },
        ],
      }),
    };
    const secondFresh = {
      exists: true,
      data: recipeDoc({
        id: 'r-second',
        title: 'Beta Dish',
        kitInferredAt: FAR_FUTURE,
        kit: [
          {
            label: 'sieve',
            equipment: { itemId: 'eq-sieves', accessoryId: null },
            stepIds: ['s1'],
          },
        ],
      }),
    };
    initialDocs = [
      { id: 'r-first', data: () => recipeDoc({ id: 'r-first', title: 'Alpha Dish' }) },
      { id: 'r-second', data: () => recipeDoc({ id: 'r-second', title: 'Beta Dish' }) },
    ];
    pollQueues.set('r-first', [firstFresh]);
    pollQueues.set('r-second', [secondFresh]);

    await runScript();

    // At least one write happened after EACH recipe (not only once at the end),
    // and every write from the second recipe onward still carries the first
    // recipe's before/after — the exact record an interrupt after recipe one
    // would otherwise have lost entirely.
    expect(writeFileMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of writeFileMock.mock.calls) {
      const content = call[1] as string;
      if (content.includes('Beta Dish')) {
        expect(content).toContain('Alpha Dish');
      }
    }
    const lastReport = writeFileMock.mock.calls.at(-1)?.[1] as string;
    expect(lastReport).toContain('Alpha Dish');
    expect(lastReport).toContain('Beta Dish');
  });
});
