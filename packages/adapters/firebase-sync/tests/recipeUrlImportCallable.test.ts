import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// callExtractRecipeFromUrl's failure mapping (issue #740).
//
// The CF entrypoint maps each UrlImportError code to a DISTINCT gRPC code
// (apps/cloud-functions/src/index.ts:mapUrlImportFailure), so the reverse
// mapping here is exact and every code is worth pinning. What this file exists
// to prevent is the regression it was written for: a failure that never reached
// the import — a dead session, a transport hiccup — being reported to the user
// as a verdict on the recipe site, and carrying no DomainError category for the
// §7.6 reporting gate to see.

const callableMock = vi.fn();
const httpsCallable = vi.fn(() => callableMock);
const getFunctions = vi.fn(() => ({}));

vi.mock('firebase/functions', () => ({ getFunctions, httpsCallable }));

const { callExtractRecipeFromUrl } = await import('../src/recipeCallables.js');

const INPUT = { url: 'https://example.com/recipes/ragu' };
const RECIPE = { id: 'r1', title: 'Ragù' };

const rejectWith = (code: string, message = 'nope') => {
  const err = Object.assign(new Error(message), { code });
  callableMock.mockRejectedValueOnce(err);
};

beforeEach(() => {
  vi.clearAllMocks();
  callableMock.mockResolvedValue({ data: { recipe: RECIPE, persistence: 'written' } });
  // Node >= 21 exposes navigator globally with onLine = false, and since #916 the
  // offline check runs FIRST in classifyCallableError — so every code-based case
  // has to say it is online, exactly as firestoreErrors.test.ts does.
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callExtractRecipeFromUrl', () => {
  it('returns the assembled draft on success', async () => {
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'ok',
      value: { recipe: RECIPE, persistence: 'written' },
    });
  });

  // ─── Import-specific outcomes keep their bespoke codes ──────────────────────

  it('reads invalid-argument as invalid-url unless the message says blocked', async () => {
    rejectWith('functions/invalid-argument', "That doesn't look like a valid web address.");
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'ImportError', code: 'invalid-url' },
    });
  });

  it('reads a blocked-link message as blocked-url', async () => {
    rejectWith('functions/invalid-argument', "That link can't be imported.");
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'ImportError', code: 'blocked-url' },
    });
  });

  it('maps unavailable to fetch-failed — the page really was unreachable', async () => {
    rejectWith('functions/unavailable');
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'ImportError', code: 'fetch-failed' },
    });
  });

  it('maps failed-precondition to not-a-recipe', async () => {
    rejectWith('functions/failed-precondition');
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'ImportError', code: 'not-a-recipe' },
    });
  });

  it('maps a reader failure to ai-failed', async () => {
    for (const code of ['functions/deadline-exceeded', 'functions/internal']) {
      rejectWith(code);
      await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
        kind: 'err',
        error: { kind: 'ImportError', code: 'ai-failed' },
      });
    }
  });

  // ─── Everything else crosses as DomainError ─────────────────────────────────

  // THE defect. In production on 2026-08-05 three imports were rejected 401 in
  // under 30ms and the app blamed the recipe site; because the failure carried
  // no category, error tracking never saw it either.
  it('crosses a dead session as AuthError, never as fetch-failed', async () => {
    rejectWith('functions/unauthenticated');
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'unauthenticated' },
    });
  });

  it('crosses permission-denied as AuthError/forbidden', async () => {
    rejectWith('functions/permission-denied');
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'forbidden' },
    });
  });

  it('crosses an unmapped transport failure as a DomainError, not fetch-failed', async () => {
    // `fetch-failed` is a claim that we reached the network and the PAGE was the
    // problem. An unmapped code means the call never got that far, so it defers to
    // the shared callable mapper (issue #916) rather than inventing a verdict.
    rejectWith('functions/cancelled');
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });

    // A code nobody has classified — a rejection carrying none at all included —
    // is the UNEXPECTED, and since #916 it says so honestly (a reportable
    // StorageError) instead of blaming the user's connection.
    rejectWith('functions/resource-exhausted');
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'quota-exceeded' },
    });

    rejectWith('');
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
  });

  it('still calls a genuine offline failure a suppressed NetworkError', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    rejectWith('functions/internal');
    await expect(callExtractRecipeFromUrl(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });
  });

  it('never throws — a rejection always crosses as a Failure (Rule 10)', async () => {
    callableMock.mockRejectedValueOnce(new Error('no code at all'));
    const result = await callExtractRecipeFromUrl(INPUT);
    expect(result.kind).toBe('err');
  });
});
