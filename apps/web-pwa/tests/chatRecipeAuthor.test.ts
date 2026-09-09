import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RecipeDoc } from '@salt/domain/schemas';

// The one create leg behind every "save this conversation as a recipe" button
// (issue #798). Three surfaces call in here — the full `/chat/:id` page and the
// recipe page's chat column and drawer — so what these tests pin is that the
// saved document does not depend on which door was used: always the create path,
// always stamped, always one `recipe.created`, and never a claim.

vi.mock('@salt/firebase-sync', () => ({
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('@salt/observability', () => ({ trackUsageEvent: vi.fn() }));
// `stampRecipeAttribution` is the identity here: who saved it is the real
// service's business (and has its own suite, #845) — what these tests pin is the
// document, which must not change shape because a name was or wasn't available.
vi.mock('../src/lib/recipeService.js', () => ({
  authorRecipeTraced: vi.fn(),
  stampRecipeAttribution: <T>(recipe: T) => recipe,
}));
// Not imported by the module under test — which is the point. If the create leg
// ever grows a claim, this mock stops being unused and the last test fails.
vi.mock('../src/lib/chatService.js', () => ({
  claimRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import { authorRecipeFromChat } from '../src/lib/chatRecipeAuthor.js';
import { authorRecipeTraced } from '../src/lib/recipeService.js';
import { claimRecipe } from '../src/lib/chatService.js';
import { saveRecipe } from '@salt/firebase-sync';
import { trackUsageEvent } from '@salt/observability';

/** What the librarian hands back: a complete recipe with no timestamps of its own. */
function draft(): RecipeDoc {
  return {
    componentRecipeIds: [],
    kit: [],
    createdBy: '',
    lastEditedBy: '',
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
    createdAt: '',
    updatedAt: '',
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
  vi.mocked(authorRecipeTraced).mockResolvedValue({ kind: 'ok', value: draft() } as Awaited<
    ReturnType<typeof authorRecipeTraced>
  >);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveRecipe).mockResolvedValue({ kind: 'ok', value: undefined });
});

describe('authorRecipeFromChat — the happy path', () => {
  it('authors in create mode, stamps the clock, saves and reports the created recipe', async () => {
    ok();

    const result = await authorRecipeFromChat({
      messages: MESSAGES,
      existingTags: ['midweek'],
      basedOnRecipeId: null,
    });

    // Create mode is the whole safety argument: no `recipeId` means the flow
    // assembles with no base recipe, so nothing existing can be returned or written.
    const input = vi.mocked(authorRecipeTraced).mock.calls[0]![0];
    expect(input.recipeId).toBeUndefined();
    expect(input.basedOnRecipeId).toBeNull();
    expect(input.existingTags).toEqual(['midweek']);

    expect(result.kind).toBe('ok');
    const saved = vi.mocked(saveRecipe).mock.calls[0]![0];
    expect(saved.title).toBe('Fennel, Orange & Olive Salad');
    // Both stamps set, to the same instant — the librarian has no clock.
    expect(saved.createdAt).not.toBe('');
    expect(saved.createdAt).toBe(saved.updatedAt);
    // The caller gets back exactly the document that was written, so it can
    // navigate to it without re-reading the store.
    expect(result.kind === 'ok' && result.value).toEqual(saved);
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
  it('reports the AUTHOR stage and writes nothing when the librarian fails', async () => {
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as Awaited<ReturnType<typeof authorRecipeTraced>>);

    const result = await authorRecipeFromChat({ messages: MESSAGES, existingTags: [] });

    expect(result.kind).toBe('err');
    // The stage is what lets every surface say "could not generate" rather than
    // the wrong half of the story.
    expect(result.kind === 'err' && result.error.stage).toBe('author');
    expect(saveRecipe).not.toHaveBeenCalled();
    expect(trackUsageEvent).not.toHaveBeenCalled();
  });

  it('reports the SAVE stage, and does not claim a recipe was created', async () => {
    ok();
    vi.mocked(saveRecipe).mockResolvedValue({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'unavailable' },
    } as Awaited<ReturnType<typeof saveRecipe>>);

    const result = await authorRecipeFromChat({ messages: MESSAGES, existingTags: [] });

    expect(result.kind === 'err' && result.error.stage).toBe('save');
    // Telemetry follows the write, not the intent — a failed save is not a created recipe.
    expect(trackUsageEvent).not.toHaveBeenCalled();
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
