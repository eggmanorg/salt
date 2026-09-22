import { derived, readable, type Readable } from 'svelte/store';
import {
  areObservabilityFeatureFlagsSettled,
  isObservabilityFeatureEnabled,
  onObservabilityFeatureFlags,
  BREAD_FLAG_KEY,
  LIBRARY_FLAG_KEY,
  CHAT_SAVE_FLAG_KEY,
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
export type FeatureKey = 'bread' | 'library' | 'chatSave';

// Feature key → PostHog flag key. Separate from the union so the flag can be
// renamed in PostHog without touching every call site, and so the app's word for
// a feature never has to match an analytics naming convention.
//
// The KEYS are this app's words. The VALUES are PostHog's, and come from
// `@salt/observability` (issue #1054) because the server half of the same gate
// asks about the same flag from an app this one cannot import.
//
// Both keys live in @salt/observability because both gates have a SERVER half —
// `onBatchWritten` for bread, `chefChat`'s kitchen-notes tools for the library —
// asking about the same flag from an app web-pwa cannot import, and a shared key
// is what stops the two spellings drifting. A browser-only gate may keep its
// literal here instead; `recipePhases` was one, until issue #1213 retired it along
// with everything it was hiding.
const FLAG_KEY: Record<FeatureKey, string> = {
  bread: BREAD_FLAG_KEY,
  // MOVED to @salt/observability by #1377, epic #1372's Phase 4, exactly as the
  // comment that stood here said it would have to be: the chef's kitchen-notes
  // tools read these pages from a Cloud Function and answer out of them, so the
  // gate now has a server half (`chefChat.ts`) and a literal in each place would
  // be a rename waiting to go half-done.
  library: LIBRARY_FLAG_KEY,
  // Both halves from the start (#1480): the SERVER half decides whether the chef
  // is given the `saveRecipe` tool at all, and is what actually withholds the
  // feature; this browser half decides whether a recorded request is ever acted
  // on, which is what stops one recorded during a deploy window running a save
  // this bundle was never told about.
  chatSave: CHAT_SAVE_FLAG_KEY,
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

// NO `chatSaveGate` STORE, deliberately (issue #1512). Asking the chef to save a
// recipe (issue #1480) is gated in exactly one place — `consumeSaveIntent` in
// `chatService.ts`, the seam every save-intent surface goes through — via the
// one-shot `isFeatureEnabled('chatSave')` above. A store here would be a second
// place to read the same flag, which is the duplication #1512 removed: the two
// call sites that had it could disagree, and a third surface could have neither.
// A surface that needs the flag reactively (to paint something differently)
// would need one back; nothing does today.
