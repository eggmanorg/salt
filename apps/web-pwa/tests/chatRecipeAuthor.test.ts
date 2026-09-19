import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RecipeDoc } from '@salt/domain/schemas';

// The one create leg behind every "save this conversation as a recipe" button
// (issue #798). Three surfaces call in here — the full `/chat/:id` page and the
// recipe page's chat column and drawer — so what these tests pin is that the
// recipe does not depend on which door was used: always the create path, always
// attributed, always one `recipe.created`, and never a claim.
//
// Since issue #1431 they pin one more thing, and it is the sharpest: **this leg
// writes nothing.** The flow writes the recipe it authored, because the browser
// was not reliably alive to do it — so `saveRecipe` is mocked below purely so
// that a write creeping back in fails a test rather than shipping.

vi.mock('@salt/firebase-sync', () => ({
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('@salt/observability', () => ({ trackUsageEvent: vi.fn() }));
// `currentMemberName` is who is signed in, and since #1431 that name goes over
// the WIRE rather than into a stamp applied here — so it is a real input to pin,
// not something to stub to identity.
vi.mock('../src/lib/recipeService.js', () => ({
  authorRecipeTraced: vi.fn(),
  currentMemberName: vi.fn(() => ''),
  stashImportedDraft: vi.fn(),
}));
// Not imported by the module under test — which is the point. If the create leg
// ever grows a claim, this mock stops being unused and the last test fails.
vi.mock('../src/lib/chatService.js', () => ({
  // Issue #1480: the recipe page and the full chat page read the save request
  // the chef recorded. Never fires here — no fixture carries one — but the
  // whole-module mock has to carry every export the page names.
  consumeSaveIntent: vi.fn().mockResolvedValue(false),
  claimRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import { authorRecipeFromChat } from '../src/lib/chatRecipeAuthor.js';
import {
  authorRecipeTraced,
  currentMemberName,
  stashImportedDraft,
} from '../src/lib/recipeService.js';
import { claimRecipe } from '../src/lib/chatService.js';
import { saveRecipe } from '@salt/firebase-sync';
import { trackUsageEvent } from '@salt/observability';

/**
 * What the flow hands back: the complete recipe it has ALREADY WRITTEN, carrying
 * the server's id, the server's clock and the server's attribution stamp.
 */
function written(): RecipeDoc {
  return {
    cureCategory: null,
    componentRecipeIds: [],
    kit: [],
    createdBy: 'Daniel',
    lastEditedBy: 'Daniel',
    id: 'salad',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Fennel, Orange & Olive Salad',
    description: 'Sharp and cold, against the lamb.',
    ingredients: [],
    steps: [],
    metadata: {
      servings: 4,
      tags: ['side'],
    },
    source: { type: 'manual' },
    notes: null,
    producesCanonId: null,
    image: null,
    createdAt: '2026-09-18T10:00:05.000Z',
    updatedAt: '2026-09-18T10:00:05.000Z',
  };
}

const MESSAGES = [
  {
    id: 'm1',
    role: 'user' as const,
    text: 'what goes with this?',
    createdAt: '2026-08-13T10:00:00.000Z',
  },
  {
    id: 'm2',
    role: 'assistant' as const,
    text: 'a fennel salad',
    createdAt: '2026-08-13T10:00:01.000Z',
  },
];

function ok() {
  vi.mocked(authorRecipeTraced).mockResolvedValue({ kind: 'ok', value: written() } as Awaited<
    ReturnType<typeof authorRecipeTraced>
  >);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentMemberName).mockReturnValue('Daniel');
});

describe('authorRecipeFromChat — the happy path', () => {
  it('authors in create mode and reports the recipe the flow wrote', async () => {
    ok();

    const result = await authorRecipeFromChat({
      messages: MESSAGES,
      existingTags: ['midweek'],
      basedOnRecipeId: null,
    });

    // Create mode is the whole safety argument, on both sides now: no `recipeId`
    // means the flow assembles with no base recipe AND that its own write is
    // armed — an edit-mode call is a proposal and writes nothing.
    const input = vi.mocked(authorRecipeTraced).mock.calls[0]![0];
    expect(input.recipeId).toBeUndefined();
    expect(input.basedOnRecipeId).toBeNull();
    expect(input.existingTags).toEqual(['midweek']);

    // Handed back exactly as it came, so the caller navigates to the document
    // that is actually in Firestore.
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.value).toEqual(written());
  });

  it('writes nothing from the browser — the flow is the writer (#1431)', async () => {
    ok();

    await authorRecipeFromChat({ messages: MESSAGES, existingTags: [] });

    // The regression. This `setDoc` was the statement after the `await`, so a
    // phone that locked during the minute the librarian took performed none of
    // it. Bringing it back would also write `recipes/{id}` twice and fire
    // `onRecipeWritten` twice — two hero images for one recipe.
    expect(saveRecipe).not.toHaveBeenCalled();
  });

  it('re-stamps neither timestamp, so the copy it returns matches Firestore', async () => {
    ok();

    const result = await authorRecipeFromChat({ messages: MESSAGES, existingTags: [] });

    expect(result.kind === 'ok' && result.value.createdAt).toBe('2026-09-18T10:00:05.000Z');
    expect(result.kind === 'ok' && result.value.updatedAt).toBe('2026-09-18T10:00:05.000Z');
  });

  it('sends the signed-in name so the flow can attribute what it writes', async () => {
    ok();

    await authorRecipeFromChat({ messages: MESSAGES, existingTags: [] });

    expect(vi.mocked(authorRecipeTraced).mock.calls[0]![0].authorName).toBe('Daniel');
  });

  it('sends no name when the roster has not resolved a member', async () => {
    ok();
    vi.mocked(currentMemberName).mockReturnValue('');

    await authorRecipeFromChat({ messages: MESSAGES, existingTags: [] });

    // Undefined, never '' and never a placeholder: the flow then leaves both
    // attribution fields alone rather than recording somebody called "Someone".
    expect(vi.mocked(authorRecipeTraced).mock.calls[0]![0].authorName).toBeUndefined();
  });

  it('stashes the recipe for the page it is about to navigate to', async () => {
    ok();

    await authorRecipeFromChat({ messages: MESSAGES, existingTags: [] });

    // A server-written document only arrives on the listener's round trip, so
    // without this the recipe page can paint "Recipe not found."
    expect(stashImportedDraft).toHaveBeenCalledWith(written());
  });

  it('forwards a base recipe when the caller asks for one (the variation path)', async () => {
    ok();

    await authorRecipeFromChat({ messages: MESSAGES, existingTags: [], basedOnRecipeId: 'pilaf' });

    expect(vi.mocked(authorRecipeTraced).mock.calls[0]![0].basedOnRecipeId).toBe('pilaf');
  });

  it('fires one recipe.created, as a chat-authored recipe', async () => {
    ok();

    await authorRecipeFromChat({ messages: MESSAGES, existingTags: [] });

    expect(trackUsageEvent).toHaveBeenCalledTimes(1);
    expect(trackUsageEvent).toHaveBeenCalledWith('recipe.created', {
      recipe_id: 'salad',
      recipe_kind: 'recipe',
      recipe_method: 'chat',
    });
  });
});

describe('authorRecipeFromChat — when it does not land', () => {
  it('returns the failure and neither stashes nor reports when the librarian fails', async () => {
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as Awaited<ReturnType<typeof authorRecipeTraced>>);

    const result = await authorRecipeFromChat({ messages: MESSAGES, existingTags: [] });

    expect(result.kind).toBe('err');
    // The error crosses unchanged. There is no `stage` any more: the flow's write
    // is best-effort and never fails the call, so "it was written but not kept"
    // is not an outcome this side can be told about (#1431).
    expect(result.kind === 'err' && result.error.kind).toBe('NetworkError');
    expect(stashImportedDraft).not.toHaveBeenCalled();
    expect(trackUsageEvent).not.toHaveBeenCalled();
    expect(saveRecipe).not.toHaveBeenCalled();
  });
});

describe('authorRecipeFromChat — what it deliberately does not do', () => {
  it('never claims the conversation for the recipe it produced', async () => {
    ok();

    await authorRecipeFromChat({ messages: MESSAGES, existingTags: [] });

    // Claiming is the CALLER's decision, and it differs by surface: a general
    // chat claims, a chat attached to a dish must not (the conversation belongs
    // to the dish it is attached to). Putting it in here would take that choice away.
    expect(claimRecipe).not.toHaveBeenCalled();
  });
});
