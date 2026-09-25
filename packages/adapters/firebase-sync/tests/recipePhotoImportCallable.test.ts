import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// callExtractRecipeFromPhoto (issue #649, Phase 3). The wrapper's three jobs:
//  • pass an EXPLICIT client timeout — the callable SDK defaults to 70s, which
//    would abandon a slow multi-page extraction while the server still worked;
//  • forward the optional traceparent on the payload (Rule 4: no observability
//    import here — firebase-sync only carries the string);
//  • NEVER throw (Rule 10) — every failure crosses as a Failure carrying the
//    photo-import failure code, its own closed set, not the URL one;
//  • ask whether the server's write of the recipe landed, and hand that on
//    (issue #1601) — reading an older function's bare recipe as "did not say".

const callableMock = vi.fn();
const httpsCallable = vi.fn(() => callableMock);
const getFunctions = vi.fn(() => ({}));

vi.mock('firebase/functions', () => ({ getFunctions, httpsCallable }));

const { callExtractRecipeFromPhoto } = await import('../src/recipeCallables.js');
const { PHOTO_IMPORT_TIMEOUT_SECONDS } = await import('@salt/domain/schemas');

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const INPUT = { images: [{ base64: 'AAAA', contentType: 'image/webp' as const }] };
const RECIPE = { id: 'r1', title: 'Ragù' };

const rejectWith = (code: string) => {
  const err = Object.assign(new Error('nope'), { code });
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

describe('callExtractRecipeFromPhoto', () => {
  it('returns the assembled draft on success, with whether it was saved', async () => {
    const result = await callExtractRecipeFromPhoto(INPUT);
    expect(result).toEqual({ kind: 'ok', value: { recipe: RECIPE, persistence: 'written' } });
  });

  it('hands on a failed server write as the outcome, not as a failure', async () => {
    callableMock.mockResolvedValue({ data: { recipe: RECIPE, persistence: 'failed' } });
    const result = await callExtractRecipeFromPhoto(INPUT);
    expect(result).toEqual({ kind: 'ok', value: { recipe: RECIPE, persistence: 'failed' } });
  });

  it('reads a function older than the flag — a bare recipe — as "did not say"', async () => {
    // A function deployed before #1601 ignores `reportPersistence` and answers
    // the bare recipe. It is still a working recipe, so it is read, not rejected.
    callableMock.mockResolvedValue({ data: RECIPE });
    const result = await callExtractRecipeFromPhoto(INPUT);
    expect(result).toEqual({ kind: 'ok', value: { recipe: RECIPE, persistence: null } });
  });

  it('passes an explicit client timeout matching the server budget', async () => {
    await callExtractRecipeFromPhoto(INPUT);

    expect(httpsCallable).toHaveBeenCalledWith(expect.anything(), 'extractRecipeFromPhoto', {
      timeout: PHOTO_IMPORT_TIMEOUT_SECONDS * 1000,
    });
    // Load-bearing: without it the SDK's 70s default truncates the call.
    expect(PHOTO_IMPORT_TIMEOUT_SECONDS * 1000).toBeGreaterThan(70_000);
  });

  it('forwards the traceparent on the payload when supplied', async () => {
    await callExtractRecipeFromPhoto(INPUT, TRACEPARENT);
    expect(callableMock).toHaveBeenCalledWith({
      ...INPUT,
      reportPersistence: true,
      traceparent: TRACEPARENT,
    });
  });

  it('omits the field entirely when no traceparent is supplied', async () => {
    await callExtractRecipeFromPhoto(INPUT);
    expect(callableMock).toHaveBeenCalledWith({ ...INPUT, reportPersistence: true });
    expect(callableMock.mock.calls[0]![0]).not.toHaveProperty('traceparent');
  });

  it('never throws — a rejected payload crosses as invalid-photos', async () => {
    rejectWith('functions/invalid-argument');
    await expect(callExtractRecipeFromPhoto(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'ImportError', code: 'invalid-photos' },
    });
  });

  it('maps failed-precondition to unreadable-photos', async () => {
    rejectWith('functions/failed-precondition');
    await expect(callExtractRecipeFromPhoto(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'ImportError', code: 'unreadable-photos' },
    });
  });

  it('maps a reader failure to import-failed', async () => {
    // The only two codes that mean the reader itself failed: `internal` is what
    // mapPhotoImportFailure emits for import-failed, `deadline-exceeded` is the
    // client giving up on a slow extraction.
    for (const code of ['functions/internal', 'functions/deadline-exceeded']) {
      rejectWith(code);
      await expect(callExtractRecipeFromPhoto(INPUT)).resolves.toEqual({
        kind: 'err',
        error: { kind: 'ImportError', code: 'import-failed' },
      });
    }
  });

  // Issue #740. This is the defect: a dead session used to arrive as
  // `import-failed`, i.e. "the recipe reader had trouble with those photos",
  // about photographs nobody had looked at — and with no DomainError category,
  // so §7.6's reporting gate could never see it.
  it('crosses a dead session as AuthError, never as a claim about the photos', async () => {
    rejectWith('functions/unauthenticated');
    await expect(callExtractRecipeFromPhoto(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'unauthenticated' },
    });
  });

  it('crosses permission-denied as AuthError/forbidden', async () => {
    rejectWith('functions/permission-denied');
    await expect(callExtractRecipeFromPhoto(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'forbidden' },
    });
  });

  it('crosses a transport hiccup as a DomainError, not as a photo verdict', async () => {
    // Neither code can come from mapPhotoImportFailure — the call never reached
    // the reader, so there is no honest verdict to give about the photographs.
    rejectWith('functions/unavailable');
    await expect(callExtractRecipeFromPhoto(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });

    // A rejection carrying no code at all is the UNEXPECTED, and since #916 it
    // defers to the shared callable mapper rather than blaming the connection.
    rejectWith('');
    await expect(callExtractRecipeFromPhoto(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
  });

  it('still calls a genuine offline failure a suppressed NetworkError', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    rejectWith('functions/internal');
    await expect(callExtractRecipeFromPhoto(INPUT)).resolves.toEqual({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    });
  });
});
