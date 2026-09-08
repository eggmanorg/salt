import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// `/remember` writes a note and DOES NOT CALL THE CHEF (issue #816, phase 1).
//
// The negative assertions are the contract, not decoration: capture involves no AI
// at all, so a regression that quietly restored the chef call would cost a model
// round-trip on every note and would otherwise pass every other test in the suite.

vi.mock('@salt/observability', () => ({
  trackUsageEvent: vi.fn(),
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  isReportableCategory: vi.fn(() => false),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeChatSessions: vi.fn(() => vi.fn()),
  saveChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  deleteChatSession: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  streamChefChat: vi.fn().mockResolvedValue({ kind: 'ok', value: 'a reply' }),
  callGenerateChatTitle: vi.fn().mockResolvedValue({ kind: 'ok', value: 'A title' }),
}));

// The service, not the adapter: importing the real one drags in membersService →
// auth.svelte.ts → firebase.ts, which initialises Firebase at module load.
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
import { trackUsageEvent } from '@salt/observability';
import { rememberNote } from '../src/lib/kitchenMemoryService.js';
import { sendMessage } from '../src/lib/chatService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;
const remember = vi.mocked(rememberNote);

function makeSession(): ChatSessionDoc {
  // "now", not a fixed date, so this session is never accidentally read-only
  // (issue #1270) under the real clock the guard reads.
  const ts = new Date().toISOString();
  return {
    id: 'sess-1',
    schemaVersion: 1,
    ownerUid: 'u1',
    recipeId: null,
    basedOnRecipeId: null,
    title: 'New chat',
    messages: [],
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    expiresAt: ts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.saveChatSession.mockResolvedValue({ kind: 'ok', value: undefined });
  fs.streamChefChat.mockResolvedValue({ kind: 'ok', value: { text: 'a reply', offered: [] } });
  fs.callGenerateChatTitle.mockResolvedValue({ kind: 'ok', value: 'A title' });
  remember.mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('sendMessage — /remember never reaches the chef', () => {
  it('saves the note and makes no AI call at all', async () => {
    const result = await sendMessage(makeSession(), '/remember we hate coriander', () => {});

    expect(result.kind).toBe('ok');
    expect(remember).toHaveBeenCalledWith('we hate coriander');
    expect(fs.streamChefChat).not.toHaveBeenCalled();
    // The title flow is an AI call too — a conversation opened with a note has not
    // been started in any sense a generated title would describe.
    expect(fs.callGenerateChatTitle).not.toHaveBeenCalled();
  });

  it('does not count as a message to the chef', async () => {
    await sendMessage(makeSession(), '/remember the oven runs hot', () => {});

    const sent = vi
      .mocked(trackUsageEvent)
      .mock.calls.filter(([name]) => name === 'chat.message_sent');
    expect(sent).toHaveLength(0);
  });

  it('records the line in the transcript, verbatim, as an ordinary user turn', async () => {
    const result = await sendMessage(makeSession(), '/remember we hate coriander', () => {});

    const saved = fs.saveChatSession.mock.calls.at(-1)?.[0] as ChatSessionDoc;
    expect(saved.messages).toHaveLength(1);
    expect(saved.messages[0]!.role).toBe('user');
    expect(saved.messages[0]!.text).toBe('/remember we hate coriander');
    expect(result.kind === 'ok' && result.value.messages).toHaveLength(1);
  });

  it('matches however the keyboard capitalised it', async () => {
    await sendMessage(makeSession(), '/Remember buy more salt', () => {});

    expect(remember).toHaveBeenCalledWith('buy more salt');
    expect(fs.streamChefChat).not.toHaveBeenCalled();
  });

  it('appends nothing when the note fails to save', async () => {
    remember.mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    });

    const result = await sendMessage(makeSession(), '/remember something', () => {});

    expect(result.kind).toBe('err');
    expect(fs.saveChatSession).not.toHaveBeenCalled();
    expect(fs.streamChefChat).not.toHaveBeenCalled();
  });
});

describe('sendMessage — what the chef is actually sent (phase 2)', () => {
  function turn(role: 'user' | 'assistant', text: string) {
    return { id: `msg-${text}`, role, text, createdAt: '2026-08-15T09:00:00.000Z', offered: [] };
  }

  it('names the speaker, so the chef knows whose notes are whose', async () => {
    await sendMessage(makeSession(), 'what shall we have tonight?', () => {});

    const [input] = fs.streamChefChat.mock.calls[0]!;
    expect(input.speaker).toBe('Kate');
  });

  it('withholds the stored /remember lines from the history it sends', async () => {
    const session: ChatSessionDoc = {
      ...makeSession(),
      messages: [
        turn('user', '/remember we hate coriander'),
        turn('user', 'what shall we have tonight?'),
        turn('assistant', 'How about a pilaf?'),
      ],
    };

    await sendMessage(session, 'and for pudding?', () => {});

    // The note is already in the system prompt, attributed to its author. Left on
    // the wire it only invites the chef to acknowledge a save it played no part in.
    const [input] = fs.streamChefChat.mock.calls[0]!;
    expect(input.messages.map((m) => m.text)).toEqual([
      'what shall we have tonight?',
      'How about a pilaf?',
    ]);
  });

  it('keeps the /remember lines in the stored transcript', async () => {
    const session: ChatSessionDoc = {
      ...makeSession(),
      messages: [turn('user', '/remember we hate coriander')],
    };

    await sendMessage(session, 'ideas for tonight?', () => {});

    // Only what is SENT changes — the chip still renders from the transcript.
    const saved = fs.saveChatSession.mock.calls.at(-1)?.[0] as ChatSessionDoc;
    expect(saved.messages.map((m) => m.text)).toContain('/remember we hate coriander');
  });
});

describe('sendMessage — everything else still goes to the chef', () => {
  it('sends an ordinary message and saves no note', async () => {
    const result = await sendMessage(makeSession(), 'what can I do with leftover rice?', () => {});

    expect(result.kind).toBe('ok');
    expect(fs.streamChefChat).toHaveBeenCalledTimes(1);
    expect(remember).not.toHaveBeenCalled();
  });

  // The composer rejects a bare `/remember` in place, so this only ever arrives via
  // a caller that did not — and "not a note" is the honest reading of it here.
  it('treats a bare /remember as an ordinary message', async () => {
    await sendMessage(makeSession(), '/remember', () => {});

    expect(remember).not.toHaveBeenCalled();
    expect(fs.streamChefChat).toHaveBeenCalledTimes(1);
  });

  it('does not fire on a word that merely starts with the command', async () => {
    await sendMessage(makeSession(), '/rememberings are lovely', () => {});

    expect(remember).not.toHaveBeenCalled();
    expect(fs.streamChefChat).toHaveBeenCalledTimes(1);
  });
});
