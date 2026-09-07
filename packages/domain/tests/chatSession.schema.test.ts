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

// `MessageSchema.offered` (issue #1299) carries a `.default([])` for exactly the
// reason above, one level down: the field lives on every message inside a live
// `chatSessions` document, so making it required would fail the whole SESSION's
// parse and the realtime subscription would drop the conversation — every chat
// with any history at all, not merely the ones written before the change.
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

describe('MessageSchema.offered', () => {
  it('parses a whole conversation written before the field existed', () => {
    const result = ChatSessionSchema.safeParse(legacySession);

    expect(result.success).toBe(true);
    // Empty, not absent — which is what makes the fail-closed gate answer "no
    // buttons" for an old conversation rather than throwing at the call site.
    expect(result.success && result.data.messages.map((m) => m.offered)).toEqual([[], []]);
  });

  it('carries what the chef declared when a reply has one', () => {
    const result = ChatSessionSchema.safeParse({
      ...legacySession,
      messages: [{ ...legacySession.messages[1], offered: ['dish-change', 'new-dish'] }],
    });

    expect(result.success && result.data.messages[0]?.offered).toEqual(['dish-change', 'new-dish']);
  });

  it('keeps a conversation whose reply names a kind this build does not know', () => {
    // A THIRD `CHEF_OFFER_KIND` reaches `chatSessions` the moment the Cloud
    // Function deploys, which is always before every browser has the bundle that
    // knows the word. Typed as the enum, an older client would fail the message,
    // fail the session, and `subscribeCollection` would drop the whole
    // conversation from its list — for a field whose entire job is choosing
    // which buttons to draw.
    const result = ChatSessionSchema.safeParse({
      ...legacySession,
      messages: [{ ...legacySession.messages[1], offered: ['dish-change', 'sous-vide-it'] }],
    });

    expect(result.success).toBe(true);
    // And the word is KEPT, not laundered away. `saveChatSession` writes the
    // whole document back (LWW, no merge), so an older client that dropped it
    // here would erase it from the household's data on the next message.
    // `latestChefOffers` is where a word this build does not know stops
    // mattering, and `latestChefOffers.test.ts` pins that half.
    expect(result.success && result.data.messages[0]?.offered).toEqual([
      'dish-change',
      'sous-vide-it',
    ]);
  });

  it('still refuses an `offered` that is not a list at all', () => {
    // The tolerance is for words, not for shapes. Nothing writes this, and
    // widening far enough to swallow it would need the `.catch()` that #1114
    // forbids on a stored document.
    expect(
      ChatSessionSchema.safeParse({
        ...legacySession,
        messages: [{ ...legacySession.messages[1], offered: 'new-dish' }],
      }).success,
    ).toBe(false);
  });
});

// The deploy skew that runs the OTHER way (issue #1299, PR #1303 review), and
// the only one that destroys anything: a browser on the pre-#1299 bundle gets
// `{ text, offered }` back from the widened Cloud Function, does not parse it,
// and stores the whole object in `message.text`. Nothing validates on the write
// side, so it lands; `text: z.string()` then fails on every later read, and the
// realtime subscription SKIPS the document — the conversation disappears from the
// chat list for good, on an eighteen-month TTL that never ages it out. `pwa.ts`
// defers a new service worker's reload by ~20 minutes and prefers a route change,
// so the exposed user is the one sitting on a chat route typing at the chef.
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

  it('does not lift the declaration out of the wrapper', () => {
    // Fail closed: a message written by accident is not evidence of an offer, and
    // the cost of ignoring it is a missing button on one old reply.
    const result = ChatSessionSchema.safeParse(skewedSession);

    expect(result.success && result.data.messages[1]?.offered).toEqual([]);
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
