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
