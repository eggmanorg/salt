import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The opt-in `?e2ePersistentCache` arm (issue #1667, Phase 2). Pinned here
// because its whole safety claim is a negative: against a real backend the
// parameter changes nothing, and under emulators nothing but the parameter
// turns the persistent cache on.

const initFirebase = vi.fn();
vi.mock('@salt/firebase-sync', () => ({
  initFirebase: (...args: unknown[]) => initFirebase(...args),
  createFirebaseAuth: vi.fn(() => ({})),
}));
vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
}));

async function boot(emulators: boolean, search: string): Promise<boolean> {
  vi.stubEnv('VITE_USE_EMULATORS', emulators ? 'true' : 'false');
  window.history.replaceState(null, '', `/${search}`);
  await import('../src/lib/firebase.js');
  // initFirebase(options, useEmulators, usePersistentCache, appCheck)
  return initFirebase.mock.calls[0]?.[2] as boolean;
}

beforeEach(() => {
  vi.resetModules();
  initFirebase.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.replaceState(null, '', '/');
});

describe('firebase.ts usePersistentCache', () => {
  it('is on against a real backend, with or without the parameter', async () => {
    expect(await boot(false, '')).toBe(true);
    vi.resetModules();
    initFirebase.mockClear();
    expect(await boot(false, '?e2ePersistentCache')).toBe(true);
  });

  it('is off under emulators by default', async () => {
    expect(await boot(true, '')).toBe(false);
  });

  it('is on under emulators only when the page load asks for it', async () => {
    expect(await boot(true, '?e2ePersistentCache')).toBe(true);
  });
});
