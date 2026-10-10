import {
  initFirebase,
  createFirebaseAuth,
  type FirebaseOptions,
  type AppCheckConfig,
} from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter } from '@salt/observability';

export const useEmulators = import.meta.env.VITE_USE_EMULATORS === 'true';

// In emulator mode the SDK ignores credential values but still requires
// non-empty strings for apiKey/appId. Project IDs prefixed `demo-` keep
// the SDK strictly emulator-only (no real-network fallthrough).
const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
const options: FirebaseOptions = useEmulators
  ? {
      apiKey: 'emulator',
      authDomain: `${projectId}.firebaseapp.com`,
      projectId,
      storageBucket: `${projectId}.appspot.com`,
      messagingSenderId: '0',
      appId: 'emulator',
    }
  : {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    };

// App Check (issue #145). Only configured for real backends; under emulators
// initFirebase skips it. The site key is public; the optional debug token is for
// unattested local/CI access to a real backend and must come from an untracked
// env / CI secret, never a committed/deployed value.
const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY;
const appCheckDebugToken = import.meta.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN;
const appCheck: AppCheckConfig | undefined = appCheckSiteKey
  ? {
      siteKey: appCheckSiteKey,
      ...(appCheckDebugToken ? { debugToken: appCheckDebugToken } : {}),
    }
  : undefined;

// The third argument is `usePersistentCache`, and it is `!useEmulators` so the
// emulator suites do not read a stale cache between runs (docs/salt-architecture.md
// § "Initialises Firestore with persistentLocalCache()").
//
// What that COSTS, which nothing else said until issue #1085: under emulators there
// is no local mutation queue. A write handed to the SDK but not yet acked by the
// server lives in page memory alone, so a reload loses it outright instead of
// replaying it on the next load the way production does. Any e2e spec that reloads
// to prove a write round-tripped must therefore settle that write first, rather
// than assuming production's durability — `window.__e2e.flushMealPlanWrites()` is
// that seam for the planner. Assuming it is what made `mealplan-split.spec.ts` fail
// on roughly half of every CI run.
//
// The ONE exception is opt-in, emulator-only and per page load (issue #1667): a
// URL carrying `?e2ePersistentCache` gets production's persistent cache, so
// `stall-recovery-durability.spec.ts` can prove that queued writes survive a
// reload — the very thing the default arm above cannot have. A query parameter
// rather than a `VITE_*` variable because the e2e Vite server is shared by every
// spec, and every other spec must keep the default. Against a real backend the
// parameter is ignored: `useEmulators` is false and the cache is persistent
// already.
const e2ePersistentCache =
  useEmulators && new URLSearchParams(window.location.search).has('e2ePersistentCache');

initFirebase(options, useEmulators, !useEmulators || e2ePersistentCache, appCheck);

export const authProvider = createFirebaseAuth(createObservabilityErrorReportingAdapter());
