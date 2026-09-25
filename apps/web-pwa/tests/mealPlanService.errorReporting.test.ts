import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { DomainError } from '@salt/shared-types';
import { emptyWeek, type MealPlanConfig, type Recipe } from '@salt/domain';

// Issue #1511. `loadWeekForDisplay` is the one read of a week no subscription
// holds, so its `Failure` has no `onError` to be reported through — the service
// reports it itself. The spy delegates to the REAL category gate, so the
// suppressed categories genuinely no-op here rather than being asserted by
// convention (same shape as chatService.errorReporting.test.ts).
const { reportSpy } = vi.hoisted(() => ({ reportSpy: vi.fn() }));

vi.mock('@salt/observability', async () => {
  const actual = await vi.importActual<typeof import('@salt/observability')>('@salt/observability');
  return {
    isReportableCategory: actual.isReportableCategory,
    trackUsageEvent: vi.fn(),
    createObservabilityErrorReportingAdapter: vi.fn(() => ({
      report: (error: unknown, category: DomainError['kind']) => {
        if (!actual.isReportableCategory(category)) return;
        reportSpy(error, category);
      },
    })),
  };
});

vi.mock('@salt/firebase-sync', () => ({
  subscribeMealPlanConfig: vi.fn(() => vi.fn()),
  subscribeMealPlanTemplate: vi.fn(() => vi.fn()),
  subscribeMealPlanWeek: vi.fn(() => vi.fn()),
  loadMealPlanWeek: vi.fn().mockResolvedValue({ kind: 'ok', value: null }),
  saveMealPlanConfig: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  saveMealPlanTemplate: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  saveMealPlanWeek: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  isAuthTransitioning: vi.fn(() => false),
}));

import * as firebaseSync from '@salt/firebase-sync';
import {
  addRecipeToDay,
  initMealPlanSync,
  loadWeekForDisplay,
  seedMealPlanConfig,
  seedMealPlanWeek,
  weekHasEdits,
  __resetMealPlanServiceForTest,
} from '../src/lib/mealPlanService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

const CONFIG: MealPlanConfig = { firstDayOfWeek: 'mon', schemaVersion: 1 };

// Exactly what `loadMealPlanWeek` returns when `MealPlanWeekSchema.safeParse`
// rejects a real document (packages/adapters/firebase-sync/src/mealPlanSync.ts).
const CORRUPTION: DomainError = { kind: 'StorageError', reason: 'corruption' };
const AUTH_ERR: DomainError = { kind: 'AuthError', reason: 'forbidden' };
const NETWORK_ERR: DomainError = { kind: 'NetworkError', reason: 'offline' };

beforeEach(() => {
  __resetMealPlanServiceForTest();
  vi.clearAllMocks();
  initMealPlanSync();
  seedMealPlanConfig(CONFIG);
});

describe('mealPlanService — loadWeekForDisplay error reporting', () => {
  it('reports a corrupted week document and still hands the Failure back', async () => {
    fs.loadMealPlanWeek.mockResolvedValue({ kind: 'err', error: CORRUPTION });

    const read = await loadWeekForDisplay('2026-06-29');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy).toHaveBeenCalledWith(CORRUPTION, 'StorageError');
    expect(read).toEqual({ kind: 'err', error: CORRUPTION });
  });

  it('reports an AuthError — a one-shot read has no sign-out-race carve-out', async () => {
    fs.loadMealPlanWeek.mockResolvedValue({ kind: 'err', error: AUTH_ERR });

    await loadWeekForDisplay('2026-06-29');

    expect(reportSpy).toHaveBeenCalledWith(AUTH_ERR, 'AuthError');
  });

  it('does not report an offline read, which still comes back as a Failure', async () => {
    fs.loadMealPlanWeek.mockResolvedValue({ kind: 'err', error: NETWORK_ERR });

    const read = await loadWeekForDisplay('2026-06-29');

    expect(reportSpy).not.toHaveBeenCalled();
    expect(read).toEqual({ kind: 'err', error: NETWORK_ERR });
  });

  it('does not report a successful read', async () => {
    fs.loadMealPlanWeek.mockResolvedValue({ kind: 'ok', value: null });

    await loadWeekForDisplay('2026-06-29');

    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('issues no read and no report for a week the service is already holding', async () => {
    seedMealPlanWeek(emptyWeek('2026-06-08'));
    fs.loadMealPlanWeek.mockResolvedValue({ kind: 'err', error: CORRUPTION });

    const read = await loadWeekForDisplay('2026-06-08');

    expect(fs.loadMealPlanWeek).not.toHaveBeenCalled();
    expect(reportSpy).not.toHaveBeenCalled();
    expect(read.kind).toBe('ok');
  });
});

// #1578: the two other one-shot week reads, same shape as #1511.
describe('mealPlanService — weekHasEdits / addRecipeToDay read error reporting', () => {
  const RECIPE = { id: 'r1', title: 'Soup' } as unknown as Recipe;

  it('weekHasEdits reports a corrupted week and still hands the Failure back', async () => {
    fs.loadMealPlanWeek.mockResolvedValue({ kind: 'err', error: CORRUPTION });

    const read = await weekHasEdits('2026-06-29');

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy).toHaveBeenCalledWith(CORRUPTION, 'StorageError');
    expect(read).toEqual({ kind: 'err', error: CORRUPTION });
  });

  it('weekHasEdits does not report an offline read', async () => {
    fs.loadMealPlanWeek.mockResolvedValue({ kind: 'err', error: NETWORK_ERR });

    await weekHasEdits('2026-06-29');

    expect(reportSpy).not.toHaveBeenCalled();
  });

  it('addRecipeToDay reports a corrupted week, writes nothing, and hands the Failure back', async () => {
    fs.loadMealPlanWeek.mockResolvedValue({ kind: 'err', error: CORRUPTION });

    const result = await addRecipeToDay('2026-06-30', RECIPE, new Map());

    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy).toHaveBeenCalledWith(CORRUPTION, 'StorageError');
    expect(fs.saveMealPlanWeek).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'err', error: CORRUPTION });
  });

  it('addRecipeToDay does not report an offline read', async () => {
    fs.loadMealPlanWeek.mockResolvedValue({ kind: 'err', error: NETWORK_ERR });

    await addRecipeToDay('2026-06-30', RECIPE, new Map());

    expect(reportSpy).not.toHaveBeenCalled();
  });
});
