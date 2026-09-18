import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { withStartedToast } from '../src/lib/startedToast.js';
import { toasts, dismissToast } from '../src/lib/toastStore.js';

// The acknowledgement mechanism itself (issue #1439), against the REAL toast
// store — no mock. The six call sites are pinned in their own page suites with
// `support/toastSpy`; this file is what stops that spy's model of the store from
// drifting away from the store.
//
// `duration: 0` is the load-bearing detail. `Toast.svelte` bails out of its
// auto-dismiss timer on `duration <= 0`, so the acknowledgement stays put for
// the length of a two-minute callable. Assert the value, not the intent: a
// default duration here would make every one of these toasts vanish after a few
// seconds and the defect would be back with every test still green.

describe('withStartedToast', () => {
  beforeEach(() => {
    for (const t of get(toasts)) dismissToast(t.id);
  });

  it('raises a persistent, non-destructive toast for the length of the call', async () => {
    let release!: (v: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });

    const run = withStartedToast('Writing the recipe…', () => pending);

    const live = get(toasts);
    expect(live).toHaveLength(1);
    expect(live[0]!.message).toBe('Writing the recipe…');
    expect(live[0]!.variant).toBe('default');
    expect(live[0]!.duration).toBe(0);

    release('done');
    await expect(run).resolves.toBe('done');
    expect(get(toasts)).toHaveLength(0);
  });

  it('clears the toast when the call rejects, and lets the error through', async () => {
    await expect(
      withStartedToast('Writing the recipe…', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(get(toasts)).toHaveLength(0);
  });

  it('clears the toast when the call returns a Failure rather than throwing', async () => {
    const result = await withStartedToast('Writing the recipe…', () =>
      Promise.resolve({ kind: 'failure' as const }),
    );
    expect(result.kind).toBe('failure');
    expect(get(toasts)).toHaveLength(0);
  });

  it('leaves other toasts alone', async () => {
    const { addToast } = await import('../src/lib/toastStore.js');
    addToast('Recipe updated!', 'success');
    await withStartedToast('Writing the recipe…', () => Promise.resolve(null));
    expect(get(toasts).map((t) => t.message)).toEqual(['Recipe updated!']);
  });
});
