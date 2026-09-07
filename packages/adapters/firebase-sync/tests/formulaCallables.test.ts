import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// callExtractProcessStages (issue #806, phase 2 of epic #778). The whole surface is
// one call and a failure map, and the failure map is the part worth pinning: this
// adapter must NEVER throw (Rule 10), because the formula screen's answer to "the
// call failed" is to leave the stages the user already has exactly where they are
// and say so — which it cannot do if the promise rejects.

// Typed as the callable `httpsCallable` really returns, not inferred: an
// inferred mock pins `data.stages` to `never[]` from the empty literal here, so
// every `mockResolvedValueOnce` carrying a real stage is rejected (#1135).
const callableMock = vi.fn<(payload?: unknown) => Promise<{ data: unknown }>>(async () => ({
  data: { stages: [] },
}));
const httpsCallable = vi.fn(() => callableMock);
const getFunctions = vi.fn(() => ({}));

vi.mock('firebase/functions', () => ({ getFunctions, httpsCallable }));

const { callExtractProcessStages } = await import('../src/formulaCallables.js');

const STAGE = {
  label: 'Bulk ferment',
  kind: 'wait' as const,
  environment: { temperature: { kind: 'fixed', celsius: 20 }, equipmentId: null },
  duration: { kind: 'fixed' as const, minutes: 240 },
  until: null,
  stepId: 'step-2',
};

beforeEach(() => {
  vi.clearAllMocks();
  // Node >= 21 exposes navigator globally with onLine = false, and since #916 the
  // offline check runs FIRST in classifyCallableError — so every code-based case
  // has to say it is online, exactly as firestoreErrors.test.ts does.
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callExtractProcessStages', () => {
  it('sends only the recipe id, to the europe-west2 callable', async () => {
    callableMock.mockResolvedValueOnce({ data: { stages: [STAGE] } });

    const result = await callExtractProcessStages({ recipeId: 'recipe-1' });

    expect(getFunctions).toHaveBeenCalledWith(undefined, 'europe-west2');
    // Three arguments now, not two: the function declares 90 s and the callable
    // client's default is 70, so #928 Phase 5 gave this wrapper a matching
    // client timeout. Raising the CF's `timeoutSeconds` means raising this.
    expect(httpsCallable).toHaveBeenCalledWith(expect.anything(), 'extractProcessStages', {
      timeout: 90_000,
    });
    expect(callableMock).toHaveBeenCalledWith({ recipeId: 'recipe-1' });
    expect(result).toEqual({ kind: 'ok', value: { stages: [STAGE] } });
  });

  it('returns the empty list through unchanged', async () => {
    // A recipe with nothing to wait for is a SUCCESS carrying no stages, not a
    // failure. The adapter must not mistake one for the other.
    callableMock.mockResolvedValueOnce({ data: { stages: [] } });
    const result = await callExtractProcessStages({ recipeId: 'recipe-1' });
    expect(result).toEqual({ kind: 'ok', value: { stages: [] } });
  });

  it.each([
    ['functions/unauthenticated', { kind: 'AuthError', reason: 'unauthenticated' }],
    ['functions/permission-denied', { kind: 'AuthError', reason: 'forbidden' }],
    // A Cloud Function 500 is a SERVER fault, not a connectivity one (issue
    // #916): StorageError so the user is not told to check their connection, and
    // so the §7.6 reporting gate actually sees it.
    ['functions/internal', { kind: 'StorageError', reason: 'unavailable' }],
    ['functions/unavailable', { kind: 'NetworkError', reason: 'transient' }],
    ['', { kind: 'StorageError', reason: 'unavailable' }],
  ])('maps %s to a Failure rather than throwing', async (code, error) => {
    callableMock.mockRejectedValueOnce(Object.assign(new Error('nope'), code ? { code } : {}));

    const result = await callExtractProcessStages({ recipeId: 'recipe-1' });

    expect(result).toEqual({ kind: 'err', error });
  });

  it('does not throw even when the SDK rejects with something that is not an Error', async () => {
    callableMock.mockRejectedValueOnce('a string');
    await expect(callExtractProcessStages({ recipeId: 'recipe-1' })).resolves.toEqual({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
  });

  it('still calls a genuine offline failure a NetworkError, code notwithstanding', async () => {
    // The callable SDK surfaces a failed fetch as `functions/internal` too, which
    // is why the offline check has to come first.
    vi.stubGlobal('navigator', { onLine: false });
    callableMock.mockRejectedValueOnce(
      Object.assign(new Error('nope'), {
        code: 'functions/internal',
      }),
    );

    await expect(callExtractProcessStages({ recipeId: 'recipe-1' })).resolves.toEqual({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });
  });
});
