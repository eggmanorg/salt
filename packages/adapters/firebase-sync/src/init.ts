import { initializeApp, getApps, getApp } from 'firebase/app';
import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  connectFirestoreEmulator,
  disableNetwork,
  enableNetwork,
} from 'firebase/firestore';
// The one sanctioned `getFunctions` outside callFunction.ts (#928 Phase 6), and
// a genuinely different call: it takes an EXPLICIT app rather than the default
// one, and its only purpose is to hand `connectFunctionsEmulator` an instance to
// rewire. No callable is created here and no wrapper is being copied, which is
// what the rule exists to stop. Disabled at the line so a fourth exemption has
// to be argued in a diff rather than added to a config array.
// eslint-disable-next-line no-restricted-imports -- emulator wiring, not a callable
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { getAuth } from 'firebase/auth';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import type { AppCheck } from 'firebase/app-check';
import { connectAuthEmulatorOnce } from './auth.js';
import { FUNCTIONS_REGION } from './functionsRegion.js';

// Tracks which app instances have had their emulator transports wired up.
// Keyed to the app instance (not a module-global boolean) so that a torn-down
// and re-created default app — as the emulator integration suite now does per
// test to isolate a poisoned Listen channel (#319) — re-establishes its
// emulator connection instead of being skipped by a stale "already connected"
// flag. Still idempotent per app: connectFirestoreEmulator throws if called
// twice on the same Firestore instance, and a live app is only ever wired once.
const emulatorConnectedApps = new WeakSet<FirebaseApp>();

// The App Check instance `initializeAppCheck` returned, per app (issue #1667).
// Retained only so writeHealth.ts can ask the public `getToken` whether a token
// exchange is stuck — it joins App Check's one shared in-flight promise, so it
// is a faithful probe of what Firestore's stream start is waiting on. No entry
// means App Check was never initialised for that app (emulators, or no site
// key). Read through `retainedAppCheck`, which is deliberately NOT re-exported
// from the package barrel: the SDK type stays inside this package (Rule 2).
const appCheckByApp = new WeakMap<FirebaseApp, AppCheck>();

export function retainedAppCheck(app: FirebaseApp): AppCheck | undefined {
  return appCheckByApp.get(app);
}

export interface AppCheckConfig {
  /** reCAPTCHA Enterprise site key. Public — it ships in the client bundle. */
  siteKey: string;
  /**
   * App Check debug token, for unattested environments (local dev or CI hitting a
   * real Firebase backend). When set, the SDK uses the debug provider instead of
   * reCAPTCHA. MUST NOT be baked into a deployed bundle — it bypasses attestation.
   */
  debugToken?: string;
}

/**
 * Emulator-only Firestore transport arm (issue #734, Phase 2).
 *
 * `experimentalForceLongPolling` was forced against the emulator in #122 for a
 * *different* symptom, three firebase minors ago. This makes the arm selectable
 * so we can find out whether it is still earning its keep, without ever
 * touching production: `useEmulators === false` returns `{}` unconditionally,
 * so a real backend keeps the SDK's default transport whatever the variable
 * says. It is read from `VITE_E2E_FIRESTORE_TRANSPORT`, and anything
 * unrecognised (including unset) is today's behaviour — the e2e harness
 * validates the value at the source, in globalSetup.ts, so a typo fails the run
 * rather than silently reporting the wrong arm.
 *
 * Note `auto-detect` passes NO setting: `experimentalAutoDetectLongPolling`
 * has defaulted to `true` since firebase v9.22, so the SDK default IS
 * auto-detect and `grpc` is the arm that has to opt out of it explicitly.
 *
 * Read from `import.meta.env` like every other `VITE_*` in this file, which
 * makes the arm BROWSER-ONLY: the e2e harness exports it to the Vite server it
 * spawns and Vite inlines it into the bundle. The Node-side emulator
 * integration suite has a Vite-provided `import.meta.env` that `process.env`
 * does not feed, so it keeps #122's forced long-polling unconditionally — which
 * is what we want, since it is not part of the A/B.
 *
 * Exported from this module (not from the package barrel) purely so the arms
 * can be unit-tested: `import.meta.env` cannot be written from a test, which is
 * exactly why the env arrives as a parameter rather than being read in here.
 */
export function emulatorTransportSettings(
  useEmulators: boolean,
  env: Record<string, string | undefined>,
): { experimentalForceLongPolling?: boolean; experimentalAutoDetectLongPolling?: boolean } {
  if (!useEmulators) return {};
  switch (env['VITE_E2E_FIRESTORE_TRANSPORT']) {
    case 'auto-detect':
      return {};
    case 'grpc':
      return { experimentalAutoDetectLongPolling: false };
    default:
      return { experimentalForceLongPolling: true };
  }
}

function importMetaEnv(): Record<string, string | undefined> {
  return (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
}

export function initFirebase(
  options: FirebaseOptions,
  useEmulators = false,
  usePersistentCache = false,
  appCheck?: AppCheckConfig,
): void {
  const isNew = getApps().length === 0;
  const app = isNew ? initializeApp(options) : getApp();

  // App Check attests that requests come from our genuine app, protecting the
  // Gemini/Genkit callables (the real cost surface) plus Firestore/Storage.
  // Skipped under emulators: the emulator suite runs against a `demo-*` project
  // that has no App Check backend and the emulators don't enforce App Check, so
  // initialising it there is pure noise. Enforcement itself is configured
  // server-side (monitor-first — see cloud-functions). Must run before any other
  // Firebase service is used so tokens attach to their requests.
  if (isNew && !useEmulators && appCheck?.siteKey) {
    if (appCheck.debugToken) {
      (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
        appCheck.debugToken;
    }
    appCheckByApp.set(
      app,
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(appCheck.siteKey),
        isTokenAutoRefreshEnabled: true,
      }),
    );
  }

  if (isNew && usePersistentCache) {
    // Under emulators, also force long-polling — the e2e/dev PWA hits the same
    // gRPC Listen-stream corruption as the integration suite (#122/#199), which
    // surfaces as flaky cross-tab convergence (canon-sync aisle specs). Real
    // backends keep default gRPC streaming. (see the emulator branch below)
    // The arm is selectable under emulators only; the default is #122's forced
    // long-polling, so this is unchanged unless the e2e harness says otherwise.
    initializeFirestore(app, {
      localCache: persistentLocalCache(),
      ...emulatorTransportSettings(useEmulators, importMetaEnv()),
    });
  }

  if (useEmulators && !emulatorConnectedApps.has(app)) {
    const _env = importMetaEnv();
    const firestorePort = Number(_env['VITE_EMULATOR_FIRESTORE_PORT'] ?? 8080);
    const functionsPort = Number(_env['VITE_EMULATOR_FUNCTIONS_PORT'] ?? 5001);
    // Force long-polling for the emulator transport. The default gRPC streaming
    // Listen channel intermittently corrupts against the Firestore emulator —
    // bogus "RESOURCE_EXHAUSTED: Received message larger than max" framing
    // errors (a multi-GB phantom size) that poison the channel for the client's
    // lifetime, after which realtime subscriptions never deliver and the
    // integration suite times out. Long-polling sidesteps the streaming
    // transport entirely. Emulator-only — production keeps default gRPC. (#122)
    // Selectable arm since #734; the default below is still #122's behaviour.
    const db =
      isNew && !usePersistentCache
        ? initializeFirestore(app, emulatorTransportSettings(useEmulators, _env))
        : getFirestore(app);
    connectFirestoreEmulator(db, '127.0.0.1', firestorePort);
    connectFunctionsEmulator(getFunctions(app, FUNCTIONS_REGION), '127.0.0.1', functionsPort);
    connectAuthEmulatorOnce(getAuth(app));
    emulatorConnectedApps.add(app);
  }
}

export async function setFirestoreNetwork(online: boolean): Promise<void> {
  const db = getFirestore();
  if (online) {
    await enableNetwork(db);
  } else {
    await disableNetwork(db);
  }
}
