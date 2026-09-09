import { describe, it, expect } from 'vitest';
import { ChatSessionSchema } from '@salt/domain/schemas';

// `basedOnRecipeId` (issue #763) is the field a variation chat carries. It is
// pinned here rather than left to the flows because of one specific failure
// mode: `chatSessions` holds live production documents and the realtime
// subscription SKIPS docs that fail validation, so a required field would not
// throw anywhere visible — every chat written before this change would simply
// stop appearing in the list.
describe('ChatSessionSchema.basedOnRecipeId', () => {
  // A chat document exactly as it was written before #763 existed.
  const preExistingDoc = {
    id: 'sess-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: null,
    title: 'New chat',
    messages: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-15T00:00:00.000Z',
  };

  it('parses a chat written before the field existed, defaulting it to null', () => {
    const result = ChatSessionSchema.safeParse(preExistingDoc);
    expect(result.success).toBe(true);
    expect(result.success && result.data.basedOnRecipeId).toBe(null);
  });

  it('carries the base recipe id when one is set', () => {
    const result = ChatSessionSchema.safeParse({
      ...preExistingDoc,
      basedOnRecipeId: 'recipe-42',
    });
    expect(result.success && result.data.basedOnRecipeId).toBe('recipe-42');
  });

  it('is independent of recipeId — a variation belongs to nothing until it is saved', () => {
    // The two fields answer different questions: `recipeId` is the dish this
    // conversation BELONGS to, `basedOnRecipeId` the dish it STARTED FROM. A
    // variation chat has the second and not the first, and once "Save as recipe"
    // claims the new dish it has both, pointing at two different recipes.
    const variation = ChatSessionSchema.parse({
      ...preExistingDoc,
      basedOnRecipeId: 'original-recipe',
    });
    expect(variation.recipeId).toBe(null);
    expect(variation.basedOnRecipeId).toBe('original-recipe');

    const saved = ChatSessionSchema.parse({
      ...preExistingDoc,
      recipeId: 'new-recipe',
      basedOnRecipeId: 'original-recipe',
    });
    expect(saved.recipeId).toBe('new-recipe');
    expect(saved.basedOnRecipeId).toBe('original-recipe');
  });

  it('rejects a non-string base id rather than defaulting it away', () => {
    // `.default(null)` fills in a MISSING field; it must not launder a wrong one.
    expect(ChatSessionSchema.safeParse({ ...preExistingDoc, basedOnRecipeId: 7 }).success).toBe(
      false,
    );
  });
});

// `reopenedAt` (issue #1270): the read-only clock's manual-reopen anchor. Same
// failure mode as `basedOnRecipeId` above — a required field would silently
// empty the chat list of every document written before this shipped.
describe('ChatSessionSchema.reopenedAt', () => {
  const preExistingDoc = {
    id: 'sess-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: null,
    title: 'New chat',
    messages: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-08-15T00:00:00.000Z',
  };

  it('parses a chat written before the field existed, defaulting it to null', () => {
    const result = ChatSessionSchema.safeParse(preExistingDoc);
    expect(result.success).toBe(true);
    expect(result.success && result.data.reopenedAt).toBe(null);
  });

  it('carries a reopen timestamp when one is set', () => {
    const result = ChatSessionSchema.safeParse({
      ...preExistingDoc,
      reopenedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(result.success && result.data.reopenedAt).toBe('2026-08-20T00:00:00.000Z');
  });
});

// A conversation with history, shared by the two suites below.
const legacySession = {
  id: 'sess-2',
  schemaVersion: 1,
  ownerUid: 'uid-1',
  recipeId: 'lamb',
  title: 'Lamb chat',
  messages: [
    { id: 'm1', role: 'user', text: 'less sweet?', createdAt: '2026-08-01T00:00:00.000Z' },
    { id: 'm2', role: 'assistant', text: 'Halve the honey.', createdAt: '2026-08-01T00:00:01Z' },
  ],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-08-15T00:00:00.000Z',
};

// #1310 removed `MessageSchema.offered`, and claimed no migration was needed on
// the grounds that Zod strips an unknown key rather than failing the parse. That
// is the claim, and this is the test of it: a document written while #1303 was
// live still reads, and the field is simply gone from the parsed message. The
// next whole-document `saveChatSession` (LWW, no merge) then drops it from
// storage, which is the intended end state.
describe('MessageSchema — a message written while `offered` existed (#1310)', () => {
  const declaringSession = {
    ...legacySession,
    messages: [
      { ...legacySession.messages[0], offered: [] },
      { ...legacySession.messages[1], offered: ['dish-change', 'new-dish'] },
    ],
  };

  it('parses, rather than dropping the conversation from the chat list', () => {
    expect(ChatSessionSchema.safeParse(declaringSession).success).toBe(true);
  });

  it('does not carry the removed field through to the parsed message', () => {
    const result = ChatSessionSchema.safeParse(declaringSession);

    expect(result.success && result.data.messages.every((m) => !('offered' in m))).toBe(true);
  });
});

// The damage #1303 could do, and the documents that may still carry it (issues
// #1299, #1310). While `chefChat` returned `{ text, offered }`, a browser still on
// the older bundle did not parse it and stored the whole object in `message.text`.
// Nothing validates on the write side, so it landed; `text: z.string()` then fails
// on every later read, and the realtime subscription SKIPS the document — the
// conversation disappears from the chat list for good, on an eighteen-month TTL
// that never ages it out.
//
// #1310 returned the callable to a bare string, so no client can write another
// one. The read-side unwrap stays because the documents do.
describe('MessageSchema.text — a reply written by a client that disagreed with us', () => {
  const skewedSession = {
    ...legacySession,
    messages: [
      legacySession.messages[0],
      {
        ...legacySession.messages[1],
        text: { text: 'Halve the honey.', offered: ['dish-change'] },
      },
    ],
  };

  it('keeps the conversation, and the words the chef actually said', () => {
    const result = ChatSessionSchema.safeParse(skewedSession);

    expect(result.success).toBe(true);
    expect(result.success && result.data.messages[1]?.text).toBe('Halve the honey.');
  });

  it('still refuses a `text` that is no kind of reply at all', () => {
    // The unwrap is for ONE known shape. It must not launder a number, or an
    // object with no text in it, into a message.
    expect(
      ChatSessionSchema.safeParse({
        ...skewedSession,
        messages: [{ ...skewedSession.messages[1], text: { offered: [] } }],
      }).success,
    ).toBe(false);
    expect(
      ChatSessionSchema.safeParse({
        ...skewedSession,
        messages: [{ ...skewedSession.messages[1], text: 7 }],
      }).success,
    ).toBe(false);
  });
});
