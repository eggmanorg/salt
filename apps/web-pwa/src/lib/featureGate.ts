import { derived, readable, type Readable } from 'svelte/store';
import {
  areObservabilityFeatureFlagsSettled,
  isObservabilityFeatureEnabled,
  onObservabilityFeatureFlags,
  BREAD_FLAG_KEY,
} from '@salt/observability';

// The one place in the app that knows how to ask "is this feature on for me?"
// (issue #831).
//
// WHAT THIS IS FOR: shipping something half-built to main without shipping it to
// the household. A feature under construction stays in the trunk — no long-lived
// branch, no merge held open for weeks — and everyone except the people testing
// it simply never sees it exists.
//
// IT IS COSMETIC, NOT A PERMISSION BOUNDARY. The flag is evaluated in the browser
// and the data is family-shared either way; `firestore.rules` is untouched and a
// determined person with devtools can turn any of this back on. That is fine —
// what is being withheld is an unfinished screen, not somebody else's data. Do not
// build anything on this that would matter if it were bypassed.
//
// AND NOTHING MAY HINT THAT A FEATURE IS WITHHELD. There is no "coming soon", no
// greyed-out entry, no denial copy. A gated feature is simply absent — which is
// the one place this deliberately parts company with `AdminGuard`, whose denial
// message is right for an operator area you know exists and wrong for a feature
// you are not supposed to know about yet.

/**
 * The closed vocabulary of gated features. Gating the next unfinished thing means
 * adding a key here and a flag in PostHog — a union rather than a free string so
 * a typo is a compile error instead of a feature that silently stays hidden
 * forever (a misspelled flag reads as "off" and looks exactly like a working gate).
 */
export type FeatureKey = 'bread' | 'library';

// Feature key → PostHog flag key. Separate from the union so the flag can be
// renamed in PostHog without touching every call site, and so the app's word for
// a feature never has to match an analytics naming convention.
//
// The KEYS are this app's words. The VALUES are PostHog's, and come from
// `@salt/observability` (issue #1054) because the server half of the same gate
// asks about the same flag from an app this one cannot import.
//
// `BREAD_FLAG_KEY` lives in @salt/observability because the bread gate has a
// SERVER half — `onBatchWritten` asks about the same flag from an app web-pwa
// cannot import — and a shared key is what stops the two spellings drifting. A
// browser-only gate may keep its literal here instead; `recipePhases` was one,
// until issue #1213 retired it along with everything it was hiding.
const FLAG_KEY: Record<FeatureKey, string> = {
  bread: BREAD_FLAG_KEY,
  // BROWSER-ONLY for as long as the library is browser-only, so the literal lives
  // here rather than in @salt/observability. Epic #1372's Phase 4 gives the chef a
  // tool that reads these pages from a Cloud Function, and THAT is when the key
  // has to move next to `BREAD_FLAG_KEY` — a page written under the flag would
  // otherwise reach a household member the feature is hidden from, through an
  // answer no browser gate can reach.
  library: 'library',
};

export interface FeatureGate {
  /** Whether the feature is on for THIS person right now. */
  enabled: boolean;
  /**
   * Whether the answer has arrived. False only while PostHog's flag payload is in
   * flight. A route guard must wait for this before redirecting, otherwise it
   * bounces the flagged user off their own page on first paint.
   */
  settled: boolean;
}

/**
 * A one-shot read, for the places that are already reactive for another reason
 * (a `$derived` in a page that re-runs anyway). Prefer `featureGate` where the
 * arrival of the flags is the only thing that would change the answer.
 *
 * Returns `true` when this build has no PostHog key at all — see
 * `isObservabilityFeatureEnabled`: without live PostHog nothing can be gated, so
 * unit tests and the e2e build see the whole app. A key that was supplied and then
 * failed to come up is the opposite case and fails closed.
 */
export function isFeatureEnabled(feature: FeatureKey): boolean {
  return isObservabilityFeatureEnabled(FLAG_KEY[feature]);
}

// Bumps whenever PostHog delivers a flag payload. Nothing reads the number — it
// exists purely to give the derived stores below something to invalidate on,
// since the flag values themselves live inside the SDK rather than in a store we
// could subscribe to. The subscription is torn down with the last subscriber.
const flagRevision = readable(0, (set) => {
  let n = 0;
  return onObservabilityFeatureFlags(() => set((n += 1)));
});

// One store per key, memoised, so every consumer of the same feature shares a
// single flag subscription rather than opening one apiece.
const gates = new Map<FeatureKey, Readable<FeatureGate>>();

/** The live gate for a feature: re-evaluates each time PostHog delivers flags. */
export function featureGate(feature: FeatureKey): Readable<FeatureGate> {
  const existing = gates.get(feature);
  if (existing) return existing;
  const store = derived(flagRevision, () => ({
    enabled: isFeatureEnabled(feature),
    settled: areObservabilityFeatureFlagsSettled(),
  }));
  gates.set(feature, store);
  return store;
}

/** Bread — formulas, batches and everything epic #778 is still building. */
export const breadGate = featureGate('bread');

/** The library — the kitchen facts that are not recipes (epic #1372). */
export const libraryGate = featureGate('library');
