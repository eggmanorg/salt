import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DomainError, ReadResult } from '@salt/shared-types';

// The shared debounced writer (issue #940, promoted out of `mealPlanService.ts`
// by #1319). Two services now depend on it, so the properties they each rest on
// are pinned here once rather than re-asserted from each caller's suite:
//
//   1. a burst inside one window is ONE write, of the LAST document;
//   2. keys are independent — one document's burst never swallows another's;
//   3. `flush` / `flushAll` write NOW rather than waiting the window out;
//   4. `onWritten` fires once per SUCCESSFUL burst, and not at all on a failure —
//      that hook carries the planner's `plan.edited` usage event (#684, #940), so
//      a per-keystroke or a fires-anyway implementation is a live defect;
//   5. every queue in one window is handed the SAME promise — necessary for "at
//      most one failure toast per burst" (CLAUDE.md Rule 10), but NOT
//      sufficient: sharing the promise only lets a caller collapse a burst to
//      one message by comparing each result against the last promise it
//      already toasted. A caller with no such comparison still gets one toast
//      per queued edit (issue #1324 review, finding 3 — this is the meal
//      planner's shape today, pre-existing and out of scope, but the claim
//      about the MODULE had to stop implying otherwise);
//   6. `pagehide` and tab-hide flush EVERY coalescer, from the one registration
//      this module owns — the planner used to register its own and no longer
//      does, so nothing else is left to fire these;
//   7. `cancel` drops a pending write without ever issuing it, settling its
//      promise with a result the caller supplies — the seam `persistRecipe`
//      uses so an immediate write to a key can't be reverted later by a
//      pending coalesced write holding an older snapshot of it (finding 2).
//
// Each is false under an obvious wrong implementation, which is the bar.

import {
  createWriteCoalescer,
  flushAllCoalescedWrites,
  WRITE_DEBOUNCE_MS,
  type WriteCoalescer,
} from '../src/lib/writeCoalescer.js';

const OK: ReadResult<void, DomainError> = { kind: 'ok', value: undefined };
const FAILED: ReadResult<void, DomainError> = {
  kind: 'err',
  error: { kind: 'StorageError', reason: 'unavailable' } as DomainError,
};

// `createWriteCoalescer` adds every coalescer it makes to a module-level set that
// nothing evicts (they are singletons in production). Tests make several, so each
// one a test makes is discarded afterwards — otherwise the `flushAllCoalescedWrites`
// cases below would flush leftovers from earlier tests in this file.
let made: WriteCoalescer<string>[] = [];

function coalescer(
  write: (doc: string) => Promise<ReadResult<void, DomainError>>,
  options: { onWritten?: (doc: string) => void } = {},
): WriteCoalescer<string> {
  const api = createWriteCoalescer(write, options);
  made.push(api);
  return api;
}

beforeEach(() => {
  vi.useFakeTimers();
  made = [];
});

afterEach(() => {
  for (const api of made) api.discardAll();
  vi.useRealTimers();
});

describe('createWriteCoalescer', () => {
  it('turns a burst inside one window into a single write of the last document', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = coalescer(write);

    for (const doc of ['S', 'Sp', 'Spa', 'Spag']) void writes.queue('week-1', doc);
    expect(write).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('Spag');
  });

  it('waits the debounce window out rather than writing on the next tick', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = coalescer(write);

    void writes.queue('week-1', 'first');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 1);
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keys by document — two keys edited together are two writes, not one', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = coalescer(write);

    void writes.queue('week-1', 'monday');
    void writes.queue('week-2', 'tuesday');
    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.map((c) => c[0] as string).sort()).toEqual(['monday', 'tuesday']);
  });

  it('flushes one key now, leaving another key still pending', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = coalescer(write);

    void writes.queue('week-1', 'flushed');
    void writes.queue('week-2', 'still waiting');
    await writes.flush('week-1');

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('flushed');
  });

  it('flushAll writes every pending key without waiting the window out', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = coalescer(write);

    void writes.queue('week-1', 'a');
    void writes.queue('week-2', 'b');
    await writes.flushAll();

    expect(write).toHaveBeenCalledTimes(2);
  });

  it('is a no-op to flush a key with nothing pending', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = coalescer(write);

    await writes.flush('never-queued');
    await writes.flushAll();

    expect(write).not.toHaveBeenCalled();
  });

  it('opens a fresh entry for an edit arriving while a write is in flight', async () => {
    let release!: (result: ReadResult<void, DomainError>) => void;
    const write = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReadResult<void, DomainError>>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(OK);
    const writes = coalescer(write);

    void writes.queue('week-1', 'first');
    const inFlight = writes.flushAll();
    // That write is already on the wire and cannot carry this edit, so the edit
    // must open its own entry rather than join one that is committed.
    void writes.queue('week-1', 'second');
    release(OK);
    await inFlight;
    await vi.runAllTimersAsync();

    expect(write.mock.calls.map((c) => c[0] as string)).toEqual(['first', 'second']);
  });

  it('calls onWritten once per successful burst, with the document written', async () => {
    const onWritten = vi.fn();
    const writes = coalescer(vi.fn().mockResolvedValue(OK), { onWritten });

    for (const doc of ['S', 'Sp', 'Spa']) void writes.queue('week-1', doc);
    await vi.runAllTimersAsync();

    expect(onWritten).toHaveBeenCalledTimes(1);
    expect(onWritten).toHaveBeenCalledWith('Spa');
  });

  it('does not call onWritten when the write fails', async () => {
    const onWritten = vi.fn();
    const writes = coalescer(vi.fn().mockResolvedValue(FAILED), { onWritten });

    void writes.queue('week-1', 'doomed');
    await vi.runAllTimersAsync();

    expect(onWritten).not.toHaveBeenCalled();
  });

  it('hands every edit in one window the same promise — one burst, one result', async () => {
    const writes = coalescer(vi.fn().mockResolvedValue(FAILED));

    const first = writes.queue('week-1', 'a');
    const second = writes.queue('week-1', 'ab');
    const third = writes.queue('week-1', 'abc');

    expect(second).toBe(first);
    expect(third).toBe(first);
    await vi.runAllTimersAsync();
    // One shared promise is what bounds a burst to one toast: a caller awaiting
    // each queue call awaits the same settled `Failure`, not three of them.
    expect(await first).toEqual(FAILED);
  });

  // The boundary of the property above (issue #1324 review, finding 3): sharing
  // one promise is necessary for "at most one toast per burst" but not
  // sufficient. A caller that reacts to EVERY `queue()` call's own promise
  // (rather than comparing against the last one it already toasted, the way
  // `RecipeViewPage`'s `lastFailureToasted` does) still runs its callback once
  // per queued edit, because all three `.then` subscriptions fire off the same
  // settled promise. This is the meal planner's shape today (`save` and
  // `onNoteChange` have no such comparison) — proof the module cannot claim
  // "at most one toast" on the promise-sharing alone; that half of the job is
  // the caller's.
  it('sharing one promise is not by itself what bounds a burst to one toast — a caller with no identity comparison still reacts once per edit', async () => {
    const writes = coalescer(vi.fn().mockResolvedValue(FAILED));
    const reactions = vi.fn();

    for (const doc of ['a', 'ab', 'abc']) {
      writes.queue('week-1', doc).then((result) => {
        if (result.kind !== 'ok') reactions();
      });
    }

    await vi.runAllTimersAsync();

    expect(reactions).toHaveBeenCalledTimes(3);
  });

  it('surfaces a failed write as a Failure rather than throwing (Rule 10)', async () => {
    const writes = coalescer(vi.fn().mockResolvedValue(FAILED));

    const result = writes.queue('week-1', 'doomed');
    await vi.runAllTimersAsync();

    expect((await result).kind).toBe('err');
  });

  it('discardAll drops pending writes without issuing them', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = coalescer(write);

    void writes.queue('week-1', 'abandoned');
    writes.discardAll();
    await vi.runAllTimersAsync();

    expect(write).not.toHaveBeenCalled();
  });

  // `cancel` (issue #1324 review, finding 2): the seam a caller with its own
  // immediate write to the same key uses so a pending coalesced write holding
  // an older snapshot can't fire later and revert it. `T` here is `string`,
  // which carries no `updatedAt` to compare — so the guard below never applies
  // and `cancel` keeps the unconditional-drop behaviour these tests pin. The
  // guard itself is exercised on a `T` that DOES carry one, below.
  it('cancel drops a pending write without issuing it, settling its promise with the given result', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = coalescer(write);

    const pending = writes.queue('week-1', 'stale');
    writes.cancel('week-1', FAILED, 'whatever the immediate write sent');

    await vi.runAllTimersAsync();

    expect(write).not.toHaveBeenCalled();
    expect(await pending).toEqual(FAILED);
  });

  it('cancel on a key with nothing pending is a no-op', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = coalescer(write);

    expect(() => writes.cancel('never-queued', OK, 'whatever')).not.toThrow();
    await vi.runAllTimersAsync();
    expect(write).not.toHaveBeenCalled();
  });

  it('cancel does not affect a different key still pending', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = coalescer(write);

    void writes.queue('week-1', 'stale');
    void writes.queue('week-2', 'unrelated');
    writes.cancel('week-1', FAILED, 'whatever the immediate write sent');

    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('unrelated');
  });
});

// `cancel`'s guard (issue #1324 review, ROUND 2): `persistRecipe` composes and
// stamps its document, then AWAITS the immediate write — a full network round
// trip, unbounded offline. An edit can be queued inside that gap, opening a
// pending entry that carries characters the immediate write never sent.
// Cancelling unconditionally would delete that entry, unwritten — the
// original defect (a stale write clobbering a fresh one) with the arrow
// reversed. `T` here carries `updatedAt` so the comparison in `cancel` has
// something to compare.
describe("cancel's guard against dropping an edit newer than the write it is cancelled against", () => {
  interface Doc {
    updatedAt: string;
    body: string;
  }

  function docCoalescer(
    write: (doc: Doc) => Promise<ReadResult<void, DomainError>>,
  ): WriteCoalescer<Doc> {
    const api = createWriteCoalescer<Doc>(write);
    made.push(api as unknown as WriteCoalescer<string>);
    return api;
  }

  it('drops the pending entry when it is not newer than the document the immediate write sent', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = docCoalescer(write);

    const pending = writes.queue('recipe-1', { updatedAt: 'T1', body: 'stale' });
    writes.cancel('recipe-1', OK, { updatedAt: 'T2', body: 'stamped' });

    await vi.runAllTimersAsync();

    expect(write).not.toHaveBeenCalled();
    expect(await pending).toEqual(OK);
  });

  it('drops the pending entry when its updatedAt exactly equals the stamped document (<=, not <)', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = docCoalescer(write);

    const pending = writes.queue('recipe-1', { updatedAt: 'T2', body: 'same instant' });
    writes.cancel('recipe-1', OK, { updatedAt: 'T2', body: 'stamped' });

    await vi.runAllTimersAsync();

    expect(write).not.toHaveBeenCalled();
    expect(await pending).toEqual(OK);
  });

  // The failure this pins: a keystroke lands DURING the immediate write's
  // round trip, opening a pending entry at T3 after the immediate write was
  // stamped at T2. An unconditional cancel would delete that entry — settling
  // its promise with `FAILED` below and never calling `write` — so those
  // characters are lost with no write ever issued for them and no toast,
  // exactly as the round-2 review reproduced.
  it('leaves a pending entry queued, to flush on its own, when it is newer than the document the immediate write sent', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = docCoalescer(write);

    const pending = writes.queue('recipe-1', {
      updatedAt: 'T3',
      body: 'typed during the round trip',
    });
    writes.cancel('recipe-1', FAILED, { updatedAt: 'T2', body: 'stamped' });

    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ updatedAt: 'T3', body: 'typed during the round trip' });
    expect(await pending).toEqual(OK);
  });

  it('cancel on a key with nothing pending is still a no-op regardless of the guard', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    const writes = docCoalescer(write);

    expect(() =>
      writes.cancel('never-queued', OK, { updatedAt: 'T2', body: 'stamped' }),
    ).not.toThrow();
    await vi.runAllTimersAsync();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('flushAllCoalescedWrites and the unload registration', () => {
  it('flushes every coalescer, not just the one edited last', async () => {
    const weekWrite = vi.fn().mockResolvedValue(OK);
    const recipeWrite = vi.fn().mockResolvedValue(OK);
    void coalescer(weekWrite).queue('week-1', 'a night');
    void coalescer(recipeWrite).queue('recipe-1', 'a title');

    await flushAllCoalescedWrites();

    expect(weekWrite).toHaveBeenCalledTimes(1);
    expect(recipeWrite).toHaveBeenCalledTimes(1);
  });

  it('writes pending documents on pagehide', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    void coalescer(write).queue('week-1', 'typed and left');

    window.dispatchEvent(new Event('pagehide'));
    await vi.runAllTimersAsync();

    expect(write).toHaveBeenCalledWith('typed and left');
  });

  it('writes pending documents when the tab is hidden', async () => {
    const write = vi.fn().mockResolvedValue(OK);
    void coalescer(write).queue('week-1', 'backgrounded');

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.runAllTimersAsync();
    visibility.mockRestore();

    expect(write).toHaveBeenCalledWith('backgrounded');
  });

  it('does not write when the tab becomes visible again', () => {
    const write = vi.fn().mockResolvedValue(OK);
    void coalescer(write).queue('week-1', 'still being typed');

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockRestore();

    expect(write).not.toHaveBeenCalled();
  });
});
