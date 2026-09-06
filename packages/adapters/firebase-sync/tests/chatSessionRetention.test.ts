import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// Retention (issues #696, #939, #1008). Every chat is written with a finite
// `expiresAt` and the length is the whole of the policy: a fortnight for a
// general kitchen chat, eighteen months for one attached to a recipe. The longer
// window is #696 — the recipe page lists every conversation about a dish, and a
// fortnightly sweep would empty that list for the recipes you have lived with
// longest — sized in #939 to survive a dish cooked once a year.
//
// What #939 removed was the `9999-12-31` sentinel that window replaced. A chat
// claims its recipe as soon as it produces one, so "never" was the majority case
// and the collection had no bound at all. THE ASSERTION BELOW IS THAT THE WINDOW
// IS FINITE as much as that it is long: a test that only checked "later than a
// fortnight" would pass on the sentinel again.
//
// #1008 is the enforcement half: a Firestore TTL policy only acts on a
// `Timestamp`, so the write site must produce one — the type assertion below is
// the guard that keeps the field and the TTL machinery in agreement — and the
// read paths must keep accepting the ISO strings every pre-migration document
// still holds, because the realtime subscription SKIPS a doc that fails
// validation and a too-tight read would silently empty the chat list.

const { mockSetDoc, mockDoc, mockGetFirestore, mockGetDoc, mockOnSnapshot, FakeTimestamp } =
  vi.hoisted(() => {
    // The slice of `firebase/firestore`'s `Timestamp` this adapter touches:
    // `fromDate` at the write site, `instanceof` + `toDate` on read.
    class FakeTimestamp {
      private readonly ms: number;
      constructor(ms: number) {
        this.ms = ms;
      }
      static fromDate(date: Date): FakeTimestamp {
        return new FakeTimestamp(date.getTime());
      }
      toDate(): Date {
        return new Date(this.ms);
      }
    }
    return {
      mockSetDoc: vi.fn().mockResolvedValue(undefined),
      mockDoc: vi.fn(() => 'mock-doc-ref'),
      mockGetFirestore: vi.fn(() => 'mock-db'),
      mockGetDoc: vi.fn(),
      mockOnSnapshot: vi.fn(),
      FakeTimestamp,
    };
  });

vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({})) }));

vi.mock('firebase/firestore', () => ({
  getFirestore: mockGetFirestore,
  collection: vi.fn(() => 'mock-collection-ref'),
  doc: mockDoc,
  onSnapshot: mockOnSnapshot,
  query: vi.fn(() => 'mock-query'),
  where: vi.fn(() => 'mock-where'),
  setDoc: mockSetDoc,
  deleteDoc: vi.fn(),
  getDoc: mockGetDoc,
  Timestamp: FakeTimestamp,
}));

import {
  saveChatSession,
  loadChatSession,
  subscribeChatSessions,
} from '../src/chatSessionSubscription.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const FOURTEEN_DAYS_MS = 14 * DAY_MS;
const EIGHTEEN_MONTHS_MS = 540 * DAY_MS;

function makeSession(overrides: Partial<ChatSessionDoc> = {}): ChatSessionDoc {
  return {
    id: 'session-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: null,
    basedOnRecipeId: null,
    title: 'New chat',
    messages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    reopenedAt: null,
    expiresAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** The wire payload `saveChatSession` handed to `setDoc`. */
function writtenDoc(): Record<string, unknown> {
  return mockSetDoc.mock.calls[0]![1] as Record<string, unknown>;
}

function writtenExpiry(): InstanceType<typeof FakeTimestamp> {
  return writtenDoc()['expiresAt'] as InstanceType<typeof FakeTimestamp>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetDoc.mockResolvedValue(undefined);
  mockOnSnapshot.mockReturnValue(vi.fn());
});

// The two windows, and the fact that each is bounded at BOTH ends. The upper
// bound is what the sentinel would fail (UT-D1: one table, two rows, each naming
// itself).
const WINDOWS = [
  { name: 'a general kitchen chat', recipeId: null, ttlMs: FOURTEEN_DAYS_MS },
  { name: 'a chat attached to a recipe', recipeId: 'recipe-1', ttlMs: EIGHTEEN_MONTHS_MS },
] as const;

describe('saveChatSession — expiry', () => {
  it.each(WINDOWS)('$name expires $ttlMs ms from the write', async ({ recipeId, ttlMs }) => {
    const before = Date.now();
    const result = await saveChatSession(makeSession({ recipeId }));
    const after = Date.now();

    expect(result.kind).toBe('ok');
    const expiry = writtenExpiry().toDate().getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiry).toBeLessThanOrEqual(after + ttlMs);
  });

  it('writes the TTL field as a Firestore Timestamp, never a string', async () => {
    // The enforceable half of "the field type and the TTL machinery never
    // disagree again" (#1008): a policy on `expiresAt` skips a string in
    // silence, so a write site that regresses to one goes red here.
    await saveChatSession(makeSession());

    expect(writtenExpiry()).toBeInstanceOf(FakeTimestamp);
  });

  it('overwrites whatever expiry the caller passed in', async () => {
    // The caller's `expiresAt` is never authoritative — the adapter owns it, which
    // is what moves a general chat onto the eighteen-month window the moment it
    // claims a recipe, whatever expiry the document it was read from carried.
    await saveChatSession(
      makeSession({ recipeId: 'recipe-1', expiresAt: '2026-01-02T00:00:00.000Z' }),
    );

    expect(writtenExpiry().toDate().toISOString()).not.toBe('2026-01-02T00:00:00.000Z');
  });

  it('returns a Failure rather than throwing when the write fails', async () => {
    mockSetDoc.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'unavailable' }));

    const result = await saveChatSession(makeSession());

    expect(result.kind).toBe('err');
  });
});

// ─── The tolerant read (#1008) ───────────────────────────────────────────────
// Both shapes must parse for as long as either can exist in the collection: a
// pre-migration document holds the ISO string, everything since holds a
// `Timestamp`, and a skipped doc is a chat that silently vanishes from the list.

const EXPIRY_ISO = '2026-03-01T00:00:00.000Z';

const SHAPES = [
  {
    name: 'a Timestamp (written since #1008)',
    stored: () => FakeTimestamp.fromDate(new Date(EXPIRY_ISO)),
  },
  { name: 'a legacy ISO string (pre-migration)', stored: () => EXPIRY_ISO },
] as const;

type QueryDoc = { id: string; data: () => unknown };

function querySnap(docs: QueryDoc[]): {
  docChanges: () => Array<{ type: 'added'; doc: QueryDoc }>;
  docs: QueryDoc[];
} {
  return { docChanges: () => docs.map((d) => ({ type: 'added', doc: d })), docs };
}

describe('subscribeChatSessions — expiresAt arrives as either shape', () => {
  it.each(SHAPES)('delivers a doc whose expiresAt is $name', ({ stored }) => {
    const onSessions = vi.fn();
    subscribeChatSessions('uid-1', onSessions, vi.fn());

    const emit = mockOnSnapshot.mock.calls[0]![1] as (snap: unknown) => void;
    const raw = { ...makeSession(), expiresAt: stored() };
    emit(querySnap([{ id: 'session-1', data: () => raw }]));

    expect(onSessions).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'session-1', expiresAt: EXPIRY_ISO }),
    ]);
  });

  it('delivers both shapes side by side in one snapshot', () => {
    // The mid-migration collection: converted and unconverted docs coexist, and
    // neither may be skipped.
    const onSessions = vi.fn();
    subscribeChatSessions('uid-1', onSessions, vi.fn());

    const emit = mockOnSnapshot.mock.calls[0]![1] as (snap: unknown) => void;
    const converted = {
      ...makeSession({ id: 'chat-new' }),
      expiresAt: FakeTimestamp.fromDate(new Date(EXPIRY_ISO)),
    };
    const legacy = makeSession({ id: 'chat-old', expiresAt: EXPIRY_ISO });
    emit(
      querySnap([
        { id: 'chat-new', data: () => converted },
        { id: 'chat-old', data: () => legacy },
      ]),
    );

    expect(onSessions).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'chat-new', expiresAt: EXPIRY_ISO }),
      expect.objectContaining({ id: 'chat-old', expiresAt: EXPIRY_ISO }),
    ]);
  });
});

describe('loadChatSession — expiresAt arrives as either shape', () => {
  it.each(SHAPES)('parses a doc whose expiresAt is $name', async ({ stored }) => {
    const raw = { ...makeSession(), expiresAt: stored() };
    mockGetDoc.mockResolvedValue({ exists: () => true, data: () => raw });

    const result = await loadChatSession('session-1');

    expect(result).toEqual({
      kind: 'ok',
      value: expect.objectContaining({ id: 'session-1', expiresAt: EXPIRY_ISO }),
    });
  });
});
