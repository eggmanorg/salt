/**
 * Taking the save request the chef recorded (issue #1480) — `consumeSaveIntent`.
 *
 * Five claims, each of which is a real defect if it is wrong:
 *
 *  1. IT CLEARS BEFORE IT ANSWERS. The caller runs the save on `true`, so the
 *     write that clears the request has to have happened by the time that `true`
 *     comes back — otherwise a save that fails, or a tab that closes mid-flight,
 *     leaves the request on the document to re-fire on the next reload. An
 *     unasked-for write is how this issue came to exist.
 *  2. ONE ANSWER PER REQUEST. A second call for the same recorded request says
 *     no, so a re-render or a second mounted surface cannot double-save.
 *  3. A SECOND, GENUINELY NEW REQUEST IS NOT THE ECHO OF THE FIRST. Asking twice
 *     in one conversation saves twice, which is why the field carries the turn's
 *     id rather than a boolean.
 *  4. A CLEAR THAT FAILS ANSWERS FALSE (review of #1490, Finding 2). Answering
 *     `true` regardless of whether the clearing write landed lets the save run
 *     while the request stays armed on the document — the next tab or reload
 *     takes it again and writes a second recipe. Answering `false` costs one
 *     retry and removes the duplicate.
 *  5. THE FEATURE KEY IS READ HERE, not at each call site (issue #1512) — this
 *     is the one seam every surface goes through, so a recorded request is
 *     inert end to end while the key is off, with nothing taken, nothing
 *     cleared and nothing saved. This file is where that claim is pinned: both
 *     page suites mock `consumeSaveIntent` wholesale and so cannot prove
 *     anything about the flag, only that they reach this seam.
 *
 * THE BOUNDARY, stated because "exactly once" would be too strong: this holds per
 * request per TAB (Finding 4 — narrower than "browser": two tabs on the SAME
 * device are two independent takers too, not just two different devices). The
 * clear is an ordinary LWW write, so two tabs sitting in the same conversation
 * can each take the same request before the other's clear arrives — two recipes
 * to delete, the same exposure the Save button has always had.
 */
import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { ChatSessionDoc } from '@salt/domain/schemas';

vi.mock('@salt/observability', () => ({
  trackUsageEvent: vi.fn(),
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  isReportableCategory: vi.fn(() => false),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeChatSessions: vi.fn(() => vi.fn()),
  saveChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  streamChefChat: vi.fn(),
  callGenerateChatTitle: vi.fn().mockResolvedValue({ kind: 'ok', value: '' }),
}));

vi.mock('../src/lib/kitchenMemoryService.js', () => ({
  rememberNote: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

vi.mock('../src/lib/membersService.js', () => ({
  currentMember: {
    subscribe(fn: (m: unknown) => void) {
      fn({ id: 'm1', name: 'Kate', email: 'kate@example.com' });
      return () => {};
    },
  },
}));

// The `chatSave` gate `consumeSaveIntent` reads directly (issue #1512). `true`
// by default so the behavioural tests below stay about taking and clearing, not
// about the gate; the gate's own tests flip it.
const isFeatureEnabledMock = vi.fn((_feature: string) => true);
vi.mock('../src/lib/featureGate.js', () => ({
  isFeatureEnabled: (feature: string) => isFeatureEnabledMock(feature),
}));

import * as firebaseSync from '@salt/firebase-sync';
import { consumeSaveIntent } from '../src/lib/chatService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

let seq = 0;

function session(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  const ts = new Date().toISOString();
  return {
    // A fresh id per fixture: the "already taken" guard is deliberately
    // process-wide, so reusing one id across cases would have each test answering
    // for its predecessor.
    id: `sess-${++seq}`,
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: null,
    basedOnRecipeId: null,
    title: 'New chat',
    messages: [],
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    pendingSaveIntent: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function lastWritten(): ChatSessionDoc | undefined {
  return fs.saveChatSession.mock.calls.at(-1)?.[0] as ChatSessionDoc | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.saveChatSession.mockResolvedValue({ kind: 'ok', value: undefined });
  isFeatureEnabledMock.mockReturnValue(true);
});

describe('consumeSaveIntent', () => {
  it('says no, and writes nothing, when nobody asked', async () => {
    await expect(consumeSaveIntent(session())).resolves.toBe(false);
    expect(fs.saveChatSession).not.toHaveBeenCalled();
  });

  it('clears the request before it hands it over', async () => {
    const taken = await consumeSaveIntent(session({ pendingSaveIntent: 'm2' }));

    expect(taken).toBe(true);
    expect(fs.saveChatSession).toHaveBeenCalledTimes(1);
    expect(lastWritten()?.pendingSaveIntent).toBe(null);
  });

  it('says no the second time it is asked about the same request', async () => {
    const asked = session({ pendingSaveIntent: 'm2' });

    await expect(consumeSaveIntent(asked)).resolves.toBe(true);
    // The same document as the store still holds it — the clear has not come back
    // round on the subscription yet, which is precisely the window this guards.
    await expect(consumeSaveIntent(asked)).resolves.toBe(false);
    expect(fs.saveChatSession).toHaveBeenCalledTimes(1);
  });

  it('takes a genuinely new request in the same conversation', async () => {
    const first = session({ pendingSaveIntent: 'm2' });

    await expect(consumeSaveIntent(first)).resolves.toBe(true);
    await expect(consumeSaveIntent({ ...first, pendingSaveIntent: 'm7' })).resolves.toBe(true);
    expect(fs.saveChatSession).toHaveBeenCalledTimes(2);
  });

  it('leaves everything else on the document exactly as it was', async () => {
    // It is a whole-document `setDoc` under LWW, so what it does NOT touch is as
    // load-bearing as what it does.
    const asked = session({ pendingSaveIntent: 'm2', basedOnRecipeId: 'base-1', title: 'Pilaf' });

    await consumeSaveIntent(asked);

    const written = lastWritten();
    expect(written?.basedOnRecipeId).toBe('base-1');
    expect(written?.title).toBe('Pilaf');
    expect(written?.messages).toEqual(asked.messages);
  });

  // Finding 2 (review of #1490): answering `true` regardless of whether the
  // clearing write landed is how a save could run while the request stayed
  // armed on the document — the next tab or reload would take it again and
  // write a second recipe.
  it('says no, and leaves the request takeable again, when the clearing write fails', async () => {
    fs.saveChatSession.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });
    const asked = session({ pendingSaveIntent: 'm2' });

    await expect(consumeSaveIntent(asked)).resolves.toBe(false);
    // Attempted, not skipped — the clear is still tried before answering.
    expect(fs.saveChatSession).toHaveBeenCalledTimes(1);
  });

  // Issue #1512: the `chatSave` feature key is read inside `consumeSaveIntent`,
  // the one seam every surface goes through, rather than at each call site — so
  // a caller that only honours the return value still gets the gate, and a new
  // conforming surface cannot silently bypass it.
  describe('the chatSave feature key', () => {
    it('says no, and writes nothing, while the key is off', async () => {
      isFeatureEnabledMock.mockReturnValue(false);

      await expect(consumeSaveIntent(session({ pendingSaveIntent: 'm2' }))).resolves.toBe(false);
      expect(fs.saveChatSession).not.toHaveBeenCalled();
    });

    it('is asked about the chatSave key specifically', async () => {
      await consumeSaveIntent(session({ pendingSaveIntent: 'm2' }));

      expect(isFeatureEnabledMock).toHaveBeenCalledWith('chatSave');
    });

    // The gate sits BEFORE `takenSaveIntents`, so a refusal does not spend the
    // request for this tab. Without that ordering, a person whose flags arrive
    // late — the payload lands after the page has already looked once — would
    // find their request permanently inert until a reload.
    it('does not spend the request, so it is still takeable once the key comes on', async () => {
      const asked = session({ pendingSaveIntent: 'm2' });
      isFeatureEnabledMock.mockReturnValue(false);
      await expect(consumeSaveIntent(asked)).resolves.toBe(false);

      isFeatureEnabledMock.mockReturnValue(true);

      await expect(consumeSaveIntent(asked)).resolves.toBe(true);
      expect(fs.saveChatSession).toHaveBeenCalledTimes(1);
      expect(lastWritten()?.pendingSaveIntent).toBeNull();
    });
  });
});
