import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import type { DomainError } from '@salt/shared-types';
import type { EnrichmentFailureDoc } from '@salt/domain/schemas';

// The app-wide read of `enrichmentFailures` (issue #1419).
//
// Two things belong to this module rather than to the adapter under it: the
// store it publishes, and the §7.6 category gate on its stream errors. The
// second is the one worth a file — a subscription whose `onError` reports
// nothing is the #1053 defect, and a thirteenth silent call site added a week
// after that issue closed would be the same defect wearing a new collection's
// name.

const { reportSpy } = vi.hoisted(() => ({ reportSpy: vi.fn() }));

vi.mock('@salt/observability', async () => {
  const actual = await vi.importActual<typeof import('@salt/observability')>('@salt/observability');
  return {
    ...actual,
    // Delegates to the REAL category predicate, so the suppression cases below
    // exercise the actual report/suppress boundary rather than a forked copy.
    createObservabilityErrorReportingAdapter: vi.fn(() => ({
      report: (error: unknown, category: DomainError['kind']) => {
        if (!actual.isReportableCategory(category)) return;
        reportSpy(error, category);
      },
    })),
  };
});

const { subscribeCalls } = vi.hoisted(() => ({ subscribeCalls: [] as unknown[][] }));
vi.mock('@salt/firebase-sync', () => ({
  isAuthTransitioning: vi.fn(() => false),
  subscribeEnrichmentFailures: vi.fn((...args: unknown[]) => {
    subscribeCalls.push(args);
    return vi.fn();
  }),
}));

import * as fs from '@salt/firebase-sync';
import {
  enrichmentFailures,
  hasEnrichmentFailure,
  initEnrichmentFailureSync,
  __resetEnrichmentFailureServiceForTest,
} from '../src/lib/enrichmentFailureService.js';

const STORAGE_ERR: DomainError = { kind: 'StorageError', reason: 'corruption' };
const NETWORK_ERR: DomainError = { kind: 'NetworkError', reason: 'offline' };

function onDocs(): (f: Map<string, EnrichmentFailureDoc>) => void {
  return subscribeCalls.at(-1)?.[0] as (f: Map<string, EnrichmentFailureDoc>) => void;
}
function onError(): (err: DomainError, raw?: unknown) => void {
  return subscribeCalls.at(-1)?.[1] as (err: DomainError, raw?: unknown) => void;
}

function record(over: Partial<EnrichmentFailureDoc> = {}): EnrichmentFailureDoc {
  return {
    enrichment: 'recipeKit',
    subjectId: 'r1',
    subjectLabel: 'Home-Cured Streaky Bacon',
    reason: 'timeout',
    failedAt: 1_757_030_400_000,
    ...over,
  };
}

beforeEach(() => {
  subscribeCalls.length = 0;
  reportSpy.mockReset();
  vi.mocked(fs.isAuthTransitioning).mockReturnValue(false);
  __resetEnrichmentFailureServiceForTest();
});

afterEach(() => {
  __resetEnrichmentFailureServiceForTest();
});

describe('initEnrichmentFailureSync', () => {
  it('starts empty, and an empty map is the correct "nothing has failed"', () => {
    expect(get(enrichmentFailures).size).toBe(0);
  });

  it('publishes what the subscription delivers', () => {
    initEnrichmentFailureSync();
    onDocs()(new Map([['recipeKit_r1', record()]]));
    expect([...get(enrichmentFailures).keys()]).toEqual(['recipeKit_r1']);
  });

  it('reuses one error reporter across repeated starts', () => {
    initEnrichmentFailureSync();
    initEnrichmentFailureSync();
    expect(subscribeCalls).toHaveLength(2);
    // The second start takes the memoised reporter rather than building a
    // second adapter, and it still reports — which is the half of that memo a
    // single start never reaches.
    onError()(STORAGE_ERR);
    expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
  });
});

describe('stream errors go through the §7.6 category gate', () => {
  it('reports a StorageError, and forwards the RAW error when one is supplied', () => {
    initEnrichmentFailureSync();
    const raw = new Error('FirebaseError: permission-denied');
    onError()(STORAGE_ERR, raw);
    expect(reportSpy).toHaveBeenCalledWith(raw, 'StorageError');
  });

  it('surfaces NOTHING for a NetworkError — the gate suppresses it', () => {
    initEnrichmentFailureSync();
    onError()(NETWORK_ERR);
    expect(reportSpy).not.toHaveBeenCalled();
  });
});

describe('hasEnrichmentFailure', () => {
  it('answers per (kind, subject) pair, and never conflates two kinds', () => {
    const failures = new Map([
      ['recipeKit_r1', record()],
      ['recipeImage_r2', record({ enrichment: 'recipeImage', subjectId: 'r2' })],
    ]);
    expect(hasEnrichmentFailure(failures, 'recipeKit', 'r1')).toBe(true);
    // Same recipe, different job — the hero is fine even though the kit is not.
    expect(hasEnrichmentFailure(failures, 'recipeImage', 'r1')).toBe(false);
    // Same job, different recipe.
    expect(hasEnrichmentFailure(failures, 'recipeKit', 'r2')).toBe(false);
  });
});
