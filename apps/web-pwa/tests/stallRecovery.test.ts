import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stuck-write recovery (issue #1667, Phase 2). Each guard has a test that goes
// red if the guard is removed: the healthy baseline below says `reload`, and
// each case changes exactly one input.

import {
  decideStallRecovery,
  holdsDraft,
  MIN_PAGE_AGE_FOR_STALL_RELOAD_MS,
  type StallRecoveryEnvironment,
} from '../src/lib/stallRecovery.js';

function env(overrides: Partial<StallRecoveryEnvironment> = {}): StallRecoveryEnvironment {
  return {
    isVisible: () => true,
    activeElement: () => null,
    hasPendingCoalescedWrites: () => false,
    pageAgeMs: () => MIN_PAGE_AGE_FOR_STALL_RELOAD_MS,
    isReloading: () => false,
    ...overrides,
  };
}

function focused<T extends HTMLElement>(el: T): T {
  document.body.appendChild(el);
  el.focus();
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('decideStallRecovery', () => {
  it('reloads a visible, idle page old enough to have outlived the guard', () => {
    expect(decideStallRecovery(env())).toBe('reload');
  });

  it('(a) defers while a focused field holds a half-typed draft', () => {
    const input = Object.assign(document.createElement('input'), { value: 'oat mi' });
    expect(decideStallRecovery(env({ activeElement: () => input }))).toBe('deferred-draft');
  });

  it('(b) defers while a coalescer holds an edit not yet handed to the SDK', () => {
    expect(decideStallRecovery(env({ hasPendingCoalescedWrites: () => true }))).toBe(
      'deferred-coalescer',
    );
  });

  it('(c) defers while the page is hidden', () => {
    expect(decideStallRecovery(env({ isVisible: () => false }))).toBe('deferred-hidden');
  });

  it('(d) never reloads a page younger than the minimum age', () => {
    expect(
      decideStallRecovery(env({ pageAgeMs: () => MIN_PAGE_AGE_FOR_STALL_RELOAD_MS - 1 })),
    ).toBe('skipped-young-page');
  });

  it('(e) stands down when another reload is already on its way', () => {
    expect(decideStallRecovery(env({ isReloading: () => true }))).toBe('skipped-already-reloading');
  });

  it('reads the real page by default', () => {
    // jsdom: visible, nothing focused, no coalescer pending. The page's age is
    // performance.now(), pinned here — a long test run outlives the guard.
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    expect(decideStallRecovery()).toBe('skipped-young-page');
    now.mockReturnValue(MIN_PAGE_AGE_FOR_STALL_RELOAD_MS);
    expect(decideStallRecovery()).toBe('reload');
    now.mockRestore();
  });
});

describe('holdsDraft', () => {
  it('is false with nothing focused', () => {
    expect(holdsDraft(null)).toBe(false);
  });

  it('counts a text input or textarea with a value, and not an empty one', () => {
    expect(
      holdsDraft(focused(Object.assign(document.createElement('input'), { value: 'a' }))),
    ).toBe(true);
    expect(holdsDraft(focused(document.createElement('input')))).toBe(false);
    expect(
      holdsDraft(focused(Object.assign(document.createElement('textarea'), { value: 'note' }))),
    ).toBe(true);
    expect(holdsDraft(focused(document.createElement('textarea')))).toBe(false);
  });

  it('does not count a checked checkbox as typed text', () => {
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: 'on' });
    expect(holdsDraft(focused(box))).toBe(false);
  });

  it('counts a contenteditable with text, and not a blank one', () => {
    const editable = document.createElement('div');
    // jsdom does not implement isContentEditable; stub what the browser reports.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    editable.textContent = 'Simmer for';
    expect(holdsDraft(editable)).toBe(true);
    editable.textContent = '  ';
    expect(holdsDraft(editable)).toBe(false);
  });

  it('does not count a plain focused button', () => {
    expect(holdsDraft(focused(document.createElement('button')))).toBe(false);
  });
});

describe('applyStallRecovery — the shared reload latch', () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reloads on a reload decision, and only once', async () => {
    const { applyStallRecovery } = await import('../src/lib/stallRecovery.js');
    applyStallRecovery('reload');
    applyStallRecovery('reload');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a deferral', async () => {
    const { applyStallRecovery } = await import('../src/lib/stallRecovery.js');
    applyStallRecovery('deferred-draft');
    expect(reload).not.toHaveBeenCalled();
  });

  it('(e) does not reload again after another caller has, and says so', async () => {
    const { reloadPage } = await import('../src/lib/pageReload.js');
    const { applyStallRecovery, decideStallRecovery: decide } =
      await import('../src/lib/stallRecovery.js');
    // pwa.ts's update flow (or its stale-chunk recovery) reloads first.
    expect(reloadPage()).toBe(true);
    applyStallRecovery('reload');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(decide()).toBe('skipped-already-reloading');
  });
});
