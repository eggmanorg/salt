import { vi } from 'vitest';

/**
 * A stand-in for `lib/toastStore` that remembers which toasts are still ON SCREEN
 * (issue #1439).
 *
 * Page tests mock the toast store and never render `App.svelte`, so there is no
 * toast viewport and no DOM to assert against. `addToast: vi.fn()` is enough when
 * the question is "did it say something", but not when the question is "is it
 * still saying it" — a persistent acknowledgement raised on click and cleared on
 * settle is only correct if BOTH halves happen, and a plain spy cannot tell a
 * cleared toast from a leaked one.
 *
 * So this models the store's real contract instead: `addToast` returns a fresh
 * id, `dismissToast(id)` removes that one, and `live()` is what a user would
 * still be looking at. `tests/startedToast.test.ts` pins that contract against
 * the real store, so the two cannot drift apart silently.
 */
export interface ToastSpy {
  /** Mirrors `addToast(message, variant?, options?)` — returns the new toast's id. */
  addToast: ReturnType<typeof vi.fn>;
  /** Mirrors `dismissToast(id)`. */
  dismissToast: ReturnType<typeof vi.fn>;
  /** Messages of every toast raised and not since dismissed, in the order raised. */
  live(): string[];
  /** Forget every call and every live toast. Call from `beforeEach`. */
  reset(): void;
}

export function makeToastSpy(): ToastSpy {
  const open = new Map<string, string>();
  let seq = 0;

  const addToast = vi.fn((message: string) => {
    const id = `toast-${++seq}`;
    open.set(id, message);
    return id;
  });
  const dismissToast = vi.fn((id: string) => {
    open.delete(id);
  });

  return {
    addToast,
    dismissToast,
    live: () => [...open.values()],
    reset: () => {
      open.clear();
      seq = 0;
      addToast.mockClear();
      dismissToast.mockClear();
    },
  };
}
