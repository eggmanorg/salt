import { hasPendingCoalescedWrites } from './writeCoalescer.js';
import { isPageReloading, reloadPage } from './pageReload.js';

// Recovers a page whose writes are stuck by reloading it (issue #1667, Phase 2).
//
// A fresh page instance is the one thing proven to flush a wedged queue: on
// 9 Oct 2026 about 40 queued writes landed within five seconds of a phone's
// new page coming up. Queued writes survive the reload because they live in
// Firestore's `persistentLocalCache` (IndexedDB), not in page memory — pinned
// by e2e/stall-recovery-durability.spec.ts.
//
// The decision is taken only when syncHealth.ts's detector has just said
// `write-stalled` — never pre-emptively — and the reload goes ahead only when
// nothing a reload would cost the user is in flight:
//   - the page is visible (a hidden page is not stuck in front of anyone, and
//     the monitor re-checks on resume);
//   - no text field holds a half-typed draft (a reload would wipe it);
//   - no coalescer holds an edit still waiting out its debounce (it has not
//     reached the SDK's durable queue yet). The recovery does NOT flush it
//     instead: a flush waits for a server ack, which on a stuck page never
//     comes (writeCoalescer.ts `flushAll`).
// Anything else defers: nothing is retried here, the next stalled check from
// the monitor asks again.
//
// THE LOOP GUARD is storage-free (Rule 3): a page younger than
// MIN_PAGE_AGE_FOR_STALL_RELOAD_MS never stall-reloads. If a reload does not
// heal the stall, the new page reports it and waits that long before trying
// again — at most one recovery reload per that interval, not a loop.

/**
 * A page this young never stall-reloads. Long enough that a reload which did
 * not heal the stall is reported and left alone for a while instead of
 * spinning; short against the hours a wedged page stayed stuck on 9 Oct.
 * Measured with `performance.now()`, whose origin is this page instance's
 * navigation.
 */
export const MIN_PAGE_AGE_FOR_STALL_RELOAD_MS = 5 * 60_000;

export type StallRecovery =
  | 'reload'
  | 'deferred-hidden'
  | 'deferred-draft'
  | 'deferred-coalescer'
  | 'skipped-young-page'
  | 'skipped-already-reloading';

/** The page state the decision reads. Injectable for tests. */
export interface StallRecoveryEnvironment {
  isVisible(): boolean;
  activeElement(): Element | null;
  hasPendingCoalescedWrites(): boolean;
  pageAgeMs(): number;
  isReloading(): boolean;
}

const browserEnvironment: StallRecoveryEnvironment = {
  isVisible: () => document.visibilityState === 'visible',
  activeElement: () => document.activeElement,
  hasPendingCoalescedWrites,
  pageAgeMs: () => performance.now(),
  isReloading: isPageReloading,
};

// Input types whose value is not something typed. Everything else (text,
// search, email, number, date, …) counts as a possible draft.
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Whether `el` is a focused text field with something typed into it. */
export function holdsDraft(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return el.value !== '';
  if (el instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(el.type) && el.value !== '';
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    return (el.textContent ?? '').trim() !== '';
  }
  return false;
}

/** Decides what to do about a stall the detector has just reported. */
export function decideStallRecovery(
  env: StallRecoveryEnvironment = browserEnvironment,
): StallRecovery {
  if (env.isReloading()) return 'skipped-already-reloading';
  if (env.pageAgeMs() < MIN_PAGE_AGE_FOR_STALL_RELOAD_MS) return 'skipped-young-page';
  if (!env.isVisible()) return 'deferred-hidden';
  if (holdsDraft(env.activeElement())) return 'deferred-draft';
  if (env.hasPendingCoalescedWrites()) return 'deferred-coalescer';
  return 'reload';
}

/** Acts on a decision. Goes through the one shared reload latch. */
export function applyStallRecovery(decision: StallRecovery): void {
  if (decision === 'reload') reloadPage();
}
