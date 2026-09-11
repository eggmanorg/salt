import { flushSync } from 'svelte';

/**
 * Run a rune factory outside a component.
 *
 * `$effect` is only legal inside an effect root, and a `.test.ts` file is not compiled
 * in runes mode — so a factory that declares effects (`createStepDeck`, and `createDeck`
 * underneath it) cannot simply be called from a test. This gives it a root, flushes the
 * effects it registered, and tears the root down afterwards.
 *
 * Deliberately synchronous end to end. Nothing here waits for a frame or a settle: the
 * test drives the state, calls `flushSync()`, and reads the answer — which is what keeps
 * a factory's coverage the same on a loaded CI runner as on a quiet laptop (issue #967).
 */
export function withEffectRoot<T>(create: () => T, body: (value: T) => void): void {
  let value: T;
  const destroy = $effect.root(() => {
    value = create();
  });
  try {
    flushSync();
    body(value!);
  } finally {
    destroy();
  }
}

/**
 * A minimal `$state` box for a test that needs one of its factory's `options`
 * getters to be genuinely reactive — e.g. standing in for a Svelte store's
 * auto-subscribed value (`() => $someStore`), which is how every real caller
 * wires a live input into a `$derived`/`$effect` factory. A plain closure
 * variable read through a getter (`let current = …; () => current`) does NOT
 * do this: `$derived`/`$effect` track only signals actually read during their
 * run, and reassigning an untracked variable never schedules a rerun, however
 * many times `flushSync()` is called afterwards.
 *
 * `$state` is a compile-time rune, legal only in a file Svelte's preprocessor
 * treats as runes-mode (`.svelte`, `.svelte.ts`/`.svelte.js`) — this file is one,
 * so a plain `.test.ts` can import and use the box without being able to declare
 * `$state` itself.
 */
export function reactiveBox<T>(initial: T): { get: () => T; set: (next: T) => void } {
  let value = $state(initial);
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
    },
  };
}
