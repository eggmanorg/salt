import { describe, it, expect, vi, beforeEach } from 'vitest';

// The emulator Firestore transport arm (issue #734, Phase 2). The load-bearing
// assertion here is the NEGATIVE one: `VITE_E2E_FIRESTORE_TRANSPORT` must be
// inert against a real backend, whatever it is set to.
//
// The arms are exercised on `emulatorTransportSettings` directly rather than
// through `initFirebase`, because the variable reaches the app through Vite's
// bundle (`import.meta.env`), which a test cannot write — `vi.stubEnv` sets
// `process.env` and would silently test the default arm every time. Taking the
// env as a parameter is what makes the decision testable at all; the wiring
// below then pins that `initFirebase` really does hand production nothing.

const { mockInitializeFirestore, mockGetFirestore, mockPersistentLocalCache } = vi.hoisted(() => ({
  // Typed to the real function's PARAMETERS, not inferred: an inferred
  // zero-argument mock records every call as an empty tuple, so reading
  // `mock.calls[0][1]` — the settings object this whole suite is about — is a
  // compile error (#1135). The return type stays `string`, matching what this
  // mock actually stands in for ('mock-db'), never a real `Firestore`.
  mockInitializeFirestore: vi.fn<
    (...args: Parameters<typeof import('firebase/firestore').initializeFirestore>) => string
  >(() => 'mock-db'),
  mockGetFirestore: vi.fn(() => 'mock-db'),
  mockPersistentLocalCache: vi.fn(() => 'mock-cache'),
}));

vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({ name: 'mock-app' })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: 'mock-app' })),
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  initializeFirestore: mockInitializeFirestore,
  persistentLocalCache: mockPersistentLocalCache,
  connectFirestoreEmulator: vi.fn(),
  disableNetwork: vi.fn(),
  enableNetwork: vi.fn(),
}));

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => 'mock-functions'),
  connectFunctionsEmulator: vi.fn(),
}));

vi.mock('firebase/auth', () => ({ getAuth: vi.fn(() => 'mock-auth') }));

vi.mock('firebase/app-check', () => ({
  initializeAppCheck: vi.fn(() => ({ marker: 'app-check-instance' })),
  ReCaptchaEnterpriseProvider: vi.fn(),
}));

vi.mock('../src/auth.js', () => ({ connectAuthEmulatorOnce: vi.fn() }));

import { initializeApp } from 'firebase/app';
import { initFirebase, emulatorTransportSettings, retainedAppCheck } from '../src/init.js';

const arm = (value?: string) => ({ VITE_E2E_FIRESTORE_TRANSPORT: value });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('emulatorTransportSettings (#734)', () => {
  it('keeps #122 forced long-polling as the default under emulators', () => {
    expect(emulatorTransportSettings(true, arm(undefined))).toEqual({
      experimentalForceLongPolling: true,
    });
  });

  it('drops to the SDK default for the auto-detect arm', () => {
    // Auto-detect has been the SDK default since v9.22 — the arm passes nothing.
    expect(emulatorTransportSettings(true, arm('auto-detect'))).toEqual({});
  });

  it('opts out of auto-detection explicitly for the plain-gRPC arm', () => {
    expect(emulatorTransportSettings(true, arm('grpc'))).toEqual({
      experimentalAutoDetectLongPolling: false,
    });
  });

  it('falls back to the default arm rather than throwing on a bad value', () => {
    // globalSetup.ts is what rejects a typo; the adapter must never throw for it.
    expect(emulatorTransportSettings(true, arm('nonsense'))).toEqual({
      experimentalForceLongPolling: true,
    });
  });

  it('is inert against a real backend, whatever the variable says', () => {
    for (const value of ['grpc', 'auto-detect', 'force-long-polling', 'nonsense', undefined]) {
      expect(emulatorTransportSettings(false, arm(value))).toEqual({});
    }
  });
});

describe('initFirebase transport wiring (#734)', () => {
  it('hands a real backend the persistent cache and no transport override', () => {
    initFirebase({ projectId: 'salt-prod' }, false, true);
    const settings = mockInitializeFirestore.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(settings)).toEqual(['localCache']);
  });

  it('still forces long-polling under emulators by default', () => {
    initFirebase({ projectId: 'demo-salt' }, true, true);
    const settings = mockInitializeFirestore.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(settings).toMatchObject({ experimentalForceLongPolling: true });
  });

  it('applies the arm on the emulator path the app actually takes', () => {
    // `apps/web-pwa/src/lib/firebase.ts` passes `usePersistentCache = !useEmulators`,
    // so under emulators the persistent-cache branch is skipped entirely and the
    // transport comes from the second `initializeFirestore` call. Both branches
    // must go through the same selector or e2e would silently keep the default.
    initFirebase({ projectId: 'demo-salt' }, true, false);
    const settings = mockInitializeFirestore.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(settings).toEqual({ experimentalForceLongPolling: true });
  });
});

describe('initFirebase App Check retention (#1667)', () => {
  // writeHealth.ts probes the instance initializeAppCheck returned; before #1667
  // it was discarded, and a probe with no instance can only ever say `absent`.
  it('retains the App Check instance for the app it was initialised on', () => {
    initFirebase({ projectId: 'salt-prod' }, false, true, { siteKey: 'site-key' });
    const app = vi.mocked(initializeApp).mock.results[0]?.value as object;
    expect(retainedAppCheck(app as never)).toEqual({ marker: 'app-check-instance' });
  });

  it('retains nothing under emulators, where App Check is skipped', () => {
    initFirebase({ projectId: 'demo-salt' }, true, false, { siteKey: 'site-key' });
    const app = vi.mocked(initializeApp).mock.results[0]?.value as object;
    expect(retainedAppCheck(app as never)).toBeUndefined();
  });
});
