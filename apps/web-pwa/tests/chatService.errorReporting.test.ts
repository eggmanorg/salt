import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { DomainError } from '@salt/shared-types';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// Stable, gated report() spy — delegates to the REAL category gate so suppressed
// write failures genuinely no-op (see canonService.errorReporting.test.ts).
const { reportSpy } = vi.hoisted(() => ({ reportSpy: vi.fn() }));

vi.mock('@salt/observability', async () => {
  const actual = await vi.importActual<typeof import('@salt/observability')>('@salt/observability');
  return {
    isReportableCategory: actual.isReportableCategory,
    // Usage events (issue #684) are inert here — this suite is about the
    // report/suppress gate, not telemetry.
    trackUsageEvent: vi.fn(),
    createObservabilityErrorReportingAdapter: vi.fn(() => ({
      report: (error: unknown, category: DomainError['kind']) => {
        if (!actual.isReportableCategory(category)) return;
        reportSpy(error, category);
      },
    })),
  };
});

vi.mock('@salt/firebase-sync', () => ({
  subscribeChatSessions: vi.fn(() => vi.fn()),
  saveChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  streamChefChat: vi.fn(),
  callGenerateChatTitle: vi.fn().mockResolvedValue({ kind: 'ok', value: '' }),
  isAuthTransitioning: vi.fn(() => false),
}));

// chatService reaches the kitchen-memory service for `/remember` (issue #816), and
// the real one drags in membersService → auth.svelte.ts → firebase.ts, which calls
// initFirebase() at module load. Mocked HERE rather than by widening the
// @salt/firebase-sync mock above: this suite is about the report/suppress gate, and
// the narrower seam keeps it that way. The note service does its own reporting
// through the same helpers, tested where it lives.
vi.mock('../src/lib/kitchenMemoryService.js', () => ({
  rememberNote: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

// chatService now reads the signed-in member's display NAME, to tell the chef who
// it is talking to (issue #816, phase 2). Mocked at the same seam and for the same
// reason as kitchenMemoryService above: the real module reaches auth.svelte.ts →
// firebase.ts, which calls initFirebase() at module load.
vi.mock('../src/lib/membersService.js', () => ({
  currentMember: {
    subscribe(fn: (m: unknown) => void) {
      fn({ id: 'm1', name: 'Kate', email: 'kate@example.com' });
      return () => {};
    },
  },
}));

import * as firebaseSync from '@salt/firebase-sync';
import {
  createChatSession,
  persistSession,
  removeSession,
  sendMessage,
} from '../src/lib/chatService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

const STORAGE_ERR: DomainError = { kind: 'StorageError', reason: 'unavailable' };
const SYNC_ERR: DomainError = { kind: 'SyncError', reason: 'push-failed' };
const NETWORK_ERR: DomainError = { kind: 'NetworkError', reason: 'offline' };
const AUTH_ERR: DomainError = { kind: 'AuthError', reason: 'forbidden' };

function makeSession(): ChatSessionDoc {
  // "now", not a fixed date, so this session is never accidentally read-only
  // (issue #1270) under the real clock the guard reads.
  const ts = new Date().toISOString();
  return {
    id: 'sess-1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: null,
    title: 'New chat',
    messages: [],
    basedOnRecipeId: null,
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    expiresAt: ts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reportSpy.mockReset();
  fs.saveChatSession.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.deleteChatSession.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.callGenerateChatTitle.mockResolvedValue({ kind: 'ok', value: '' });
});

describe('chatService — write/command failure reporting (Phase 2)', () => {
  describe('createChatSession (saveChatSession adapter)', () => {
    it('reports a StorageError save failure', async () => {
      fs.saveChatSession.mockResolvedValueOnce({ kind: 'err', error: STORAGE_ERR });
      await createChatSession('u1');
      expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
    });

    it('does NOT surface a NetworkError save failure (gate suppresses)', async () => {
      fs.saveChatSession.mockResolvedValueOnce({ kind: 'err', error: NETWORK_ERR });
      await createChatSession('u1');
      expect(reportSpy).not.toHaveBeenCalled();
    });
  });

  describe('persistSession (saveChatSession adapter)', () => {
    it('reports a SyncError save failure', async () => {
      fs.saveChatSession.mockResolvedValueOnce({ kind: 'err', error: SYNC_ERR });
      await persistSession(makeSession());
      expect(reportSpy).toHaveBeenCalledWith(SYNC_ERR, 'SyncError');
    });
  });

  describe('removeSession (deleteChatSession adapter)', () => {
    it('reports a StorageError delete failure', async () => {
      fs.deleteChatSession.mockResolvedValueOnce({ kind: 'err', error: STORAGE_ERR });
      await removeSession('sess-1');
      expect(reportSpy).toHaveBeenCalledWith(STORAGE_ERR, 'StorageError');
    });
  });

  describe('sendMessage (chefChat AI stream callable)', () => {
    it('reports an AuthError stream failure (write-path AuthError IS reportable)', async () => {
      fs.streamChefChat.mockResolvedValueOnce({ kind: 'err', error: AUTH_ERR });
      await sendMessage(makeSession(), 'hi', () => {});
      expect(reportSpy).toHaveBeenCalledWith(AUTH_ERR, 'AuthError');
    });

    it('does NOT surface a NetworkError stream failure (gate suppresses)', async () => {
      fs.streamChefChat.mockResolvedValueOnce({ kind: 'err', error: NETWORK_ERR });
      await sendMessage(makeSession(), 'hi', () => {});
      expect(reportSpy).not.toHaveBeenCalled();
    });
  });
});
