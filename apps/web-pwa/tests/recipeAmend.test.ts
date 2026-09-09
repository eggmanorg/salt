import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Recipe } from '@salt/domain';
import type { RecipeDoc } from '@salt/domain/schemas';

// The merge behind the chat review gate (issue #764). These tests are the pin on
// the `null` semantic: a metadata field the librarian omitted means "the model
// forgot", so the existing value is PRESERVED. The bug this replaces spread the
// draft straight through on the full chat page, so "add some chilli" came back
// also proposing to erase Serves 4, every time and every tag.
//
// The merge is pure, so nothing here needs a store or a network — the module's
// two async siblings pull in firebase-sync and recipeService, hence the mocks.

vi.mock('@salt/firebase-sync', () => ({
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/recipeService.js', () => ({
  authorRecipeTraced: vi.fn(),
  // Identity — attribution (#845) has its own suite; these tests are about the
  // guided plan and the merge.
  stampRecipeAttribution: <T>(recipe: T) => recipe,
}));
vi.mock('../src/lib/guidedPlanService.js', () => ({ discardGuidedPlan: vi.fn() }));

import {
  mergeAmendedRecipe,
  proposeRecipeAmendment,
  applyRecipeAmendment,
  type RecipeAmendment,
} from '../src/lib/recipeAmend.js';
import { authorRecipeTraced } from '../src/lib/recipeService.js';
import { discardGuidedPlan } from '../src/lib/guidedPlanService.js';
import { saveRecipe } from '@salt/firebase-sync';
import { diffRecipe } from '@salt/domain';

const NOW = '2026-08-11T12:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
});

function existingRecipe(): Recipe {
  return {
    componentRecipeIds: [],
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    id: 'pilaf',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Chorizo & Red Pepper Pilaf',
    description: 'A one-pan supper.',
    ingredients: [],
    steps: [],
    metadata: {
      servings: 4,
      tags: ['midweek', 'one-pan'],
    },
    source: { type: 'url', url: 'https://example.com/pilaf' },
    notes: null,
    producesCanonId: null,
    image: { url: 'https://example.com/pilaf.webp', source: 'ai' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  };
}

/** What the librarian returns: a complete recipe, but with the metadata dropped. */
function draftWithoutMetadata(overrides: Partial<RecipeDoc['metadata']> = {}): RecipeDoc {
  return {
    componentRecipeIds: [],
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    id: 'draft-id',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Chorizo & Red Pepper Pilaf',
    description: 'A one-pan supper, with chilli.',
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
      ...overrides,
    },
    source: { type: 'manual' },
    notes: null,
    producesCanonId: null,
    image: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('mergeAmendedRecipe — a metadata field the librarian omitted is preserved', () => {
  it('keeps servings the draft left null', () => {
    const merged = mergeAmendedRecipe(existingRecipe(), draftWithoutMetadata(), NOW);
    expect(merged.metadata.servings).toBe(4);
  });

  it('keeps the tag list the draft returned empty', () => {
    // The empty-tag case reads the same way as a null number: nothing came back,
    // so the recipe keeps what it had. This is what makes the last tag
    // un-removable through chat — a deliberate cost, not an oversight.
    const merged = mergeAmendedRecipe(existingRecipe(), draftWithoutMetadata(), NOW);
    expect(merged.metadata.tags).toEqual(['midweek', 'one-pan']);
  });
});

describe('mergeAmendedRecipe — a metadata value the librarian DID return wins', () => {
  it('takes the draft servings', () => {
    const merged = mergeAmendedRecipe(existingRecipe(), draftWithoutMetadata({ servings: 6 }), NOW);
    expect(merged.metadata.servings).toBe(6);
  });

  it('takes the draft tag list, including a shorter one', () => {
    const merged = mergeAmendedRecipe(
      existingRecipe(),
      draftWithoutMetadata({ tags: ['spicy'] }),
      NOW,
    );
    expect(merged.metadata.tags).toEqual(['spicy']);
  });

  it('preserves each field independently — one returned value does not carry the rest', () => {
    const merged = mergeAmendedRecipe(existingRecipe(), draftWithoutMetadata({ servings: 6 }), NOW);
    expect(merged.metadata.servings).toBe(6);
    expect(merged.metadata.tags).toEqual(['midweek', 'one-pan']);
  });
});

// ─── the phase strip and its summary move together (issue #1203) ───────────────
//
// The one field pair in this merge that is NOT two independent scalars. Every
// case below is the same question asked from a different side: can the saved
// document end up holding a strip and a sentence that describe different
// timings? The pre-fix merge answered yes — `phases` and `timingSummary` each
// fell back to `existing` on their own, and `draft.metadata.phases` is always a
// defined array, so a fresh strip always won while an omitted sentence came
// back `null` and quietly restored the stored recipe's old one underneath it.

const STORED_PHASES = [
  { label: 'Prep', handsOnMinutes: 20, handsOffMinutes: 0 },
  { label: 'Rise', handsOnMinutes: 0, handsOffMinutes: 90 },
  { label: 'Bake', handsOnMinutes: 5, handsOffMinutes: 30 },
];
const STORED_SUMMARY = 'About 40 minutes of you, spread over 2¼ hours — start it the night before.';
const FRESH_PHASES = [{ label: 'Shake', handsOnMinutes: 2, handsOffMinutes: 0 }];

/** A recipe stored WITH a phase strip and the sentence written over it. */
function recipeWithStrip(): Recipe {
  const recipe = existingRecipe();
  return {
    ...recipe,
    metadata: { ...recipe.metadata, phases: STORED_PHASES, timingSummary: STORED_SUMMARY },
  };
}

describe('mergeAmendedRecipe — the phase strip and its summary are one fact', () => {
  it('does not pair a fresh strip with the stored sentence when the draft omitted the summary', () => {
    // The reported case: "make it a traybake" comes back with a one-block strip
    // and no sentence. `null` there is a real answer — nothing worth a sentence
    // — not a gap to fill from a recipe that no longer exists.
    const merged = mergeAmendedRecipe(
      recipeWithStrip(),
      draftWithoutMetadata({ phases: FRESH_PHASES, timingSummary: null }),
      NOW,
    );
    expect(merged.metadata.phases).toEqual(FRESH_PHASES);
    expect(merged.metadata.timingSummary).toBeNull();
  });

  it('takes both halves from the draft when it returned both', () => {
    const merged = mergeAmendedRecipe(
      recipeWithStrip(),
      draftWithoutMetadata({
        phases: FRESH_PHASES,
        timingSummary: 'Two minutes, start to finish.',
      }),
      NOW,
    );
    expect(merged.metadata.phases).toEqual(FRESH_PHASES);
    expect(merged.metadata.timingSummary).toBe('Two minutes, start to finish.');
  });

  it('does not pair a fresh sentence with the stored strip when the draft returned no phases', () => {
    // The inverse, and the reason the pair cannot be merged field by field in
    // either direction: a sentence with no strip behind it is not an answer
    // about this recipe's timing, so the stored pair stands whole.
    const merged = mergeAmendedRecipe(
      recipeWithStrip(),
      draftWithoutMetadata({ phases: [], timingSummary: 'Ready in five minutes flat.' }),
      NOW,
    );
    expect(merged.metadata.phases).toEqual(STORED_PHASES);
    expect(merged.metadata.timingSummary).toBe(STORED_SUMMARY);
  });

  it('keeps the stored pair whole when the draft returned neither — the no-loss floor', () => {
    // The #1201 floor this fix must not trade away, exercised directly against
    // a draft with no strip. It is not yet what a real chat amend produces: the
    // librarian is always asked for 3-6 phases (`PHASE_RULES`) and is never
    // shown the stored strip (`formatRecipeForPrompt`), so `draftWithoutMetadata`
    // here is not a case an unrelated "add some chilli" turn currently reaches —
    // see the boundary note on `mergeAmendedRecipe`.
    const merged = mergeAmendedRecipe(recipeWithStrip(), draftWithoutMetadata(), NOW);
    expect(merged.metadata.phases).toEqual(STORED_PHASES);
    expect(merged.metadata.timingSummary).toBe(STORED_SUMMARY);
  });

  it('stores an absent pair as the empty strip and a null sentence, never undefined', () => {
    // A recipe from before #1122 amended by chat: neither side has a strip.
    // Firestore has no `undefined`, so the pair is written as what "no strip"
    // is stored as — the same shape `assembleRecipeDraft` and the re-estimate
    // trigger write.
    const merged = mergeAmendedRecipe(existingRecipe(), draftWithoutMetadata(), NOW);
    expect(merged.metadata.phases).toEqual([]);
    expect(merged.metadata.timingSummary).toBeNull();
  });
});

describe('mergeAmendedRecipe — identity and the fields the librarian never returns', () => {
  it('keeps the existing id, createdAt, image and source, and stamps updatedAt', () => {
    const merged = mergeAmendedRecipe(existingRecipe(), draftWithoutMetadata(), NOW);
    expect(merged.id).toBe('pilaf');
    expect(merged.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(merged.updatedAt).toBe(NOW);
    expect(merged.image).toEqual({ url: 'https://example.com/pilaf.webp', source: 'ai' });
    expect(merged.source).toEqual({ type: 'url', url: 'https://example.com/pilaf' });
  });

  it('takes the draft prose — an amend is what the conversation was about', () => {
    const merged = mergeAmendedRecipe(existingRecipe(), draftWithoutMetadata(), NOW);
    expect(merged.description).toBe('A one-pan supper, with chilli.');
  });

  it('is pure — the same inputs give the same document, and neither input is mutated', () => {
    // The Definition of Done for #764: the same conversation reviewed from either
    // surface writes a byte-identical document. That holds because the merge is
    // the only thing deciding the content, and it is deterministic.
    const existing = existingRecipe();
    const draft = draftWithoutMetadata();
    const a = mergeAmendedRecipe(existing, draft, NOW);
    const b = mergeAmendedRecipe(existing, draft, NOW);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
    expect(existing).toEqual(existingRecipe());
    expect(draft).toEqual(draftWithoutMetadata());
  });
});

// ─── the one propose entry point (issues #764, #890) ────────────────────────────
//
// There were two, briefly: Refresh had a sibling entry point that asked the
// librarian to read the DOCUMENT rather than a conversation (#784). Refresh is
// now a chef turn followed by an ordinary amendment (#890), so the librarian has
// exactly one caller shape again and the merge contract below is the whole of
// what a proposal means.

/** The librarian answered; hand back a draft that forgot every metadata field. */
function librarianReturns(draft: RecipeDoc = draftWithoutMetadata()): void {
  vi.mocked(authorRecipeTraced).mockResolvedValue({ kind: 'ok', value: draft } as Awaited<
    ReturnType<typeof authorRecipeTraced>
  >);
}

describe('proposeRecipeAmendment — what the librarian is asked to read', () => {
  it('sends the conversation and the recipe id, and nothing else', async () => {
    librarianReturns();
    const messages = [{ id: 'm1', role: 'user' as const, text: 'add some chilli', createdAt: NOW }];

    await proposeRecipeAmendment(existingRecipe(), messages, ['midweek', 'sunday']);

    expect(authorRecipeTraced).toHaveBeenCalledTimes(1);
    // The tag vocabulary rides along: it is a house rule like any other, and a
    // re-authored recipe should land on the words the collection already uses.
    expect(vi.mocked(authorRecipeTraced).mock.calls[0]![0]).toEqual({
      messages,
      existingTags: ['midweek', 'sunday'],
      recipeId: 'pilaf',
    });
  });

  it('preserves the metadata the librarian forgot, and the image it never returns', async () => {
    // The merge contract, reached through the only door there is. The librarian
    // forgets servings and returns a null image, so without this a Refresh —
    // which now arrives here like any other amendment — would quietly propose to
    // erase Serves 4 and the hero photo every time it ran.
    librarianReturns();

    const result = await proposeRecipeAmendment(existingRecipe(), [], []);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.updated.metadata.servings).toBe(4);
    expect(result.value.updated.metadata.tags).toEqual(['midweek', 'one-pan']);
    expect(result.value.updated.image).toEqual({
      url: 'https://example.com/pilaf.webp',
      source: 'ai',
    });
    expect(result.value.updated.source).toEqual({ type: 'url', url: 'https://example.com/pilaf' });
    // Identity is the existing dish's — an amendment re-writes it, never replaces it.
    expect(result.value.updated.id).toBe('pilaf');
  });

  it('proposes nothing when the librarian fails', async () => {
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as Awaited<ReturnType<typeof authorRecipeTraced>>);

    const result = await proposeRecipeAmendment(existingRecipe(), [], []);

    expect(result.kind).toBe('err');
  });
});

// The guided plan, decided on the ONE path both surfaces apply through (issue
// #918). This lived in the recipe page's apply handler and nowhere else, so the
// same amendment applied from `/chat/:id` left the plan pointing at steps that
// no longer existed. These tests pin the rule where it now lives; a surface that
// forgets it can no longer exist, because there is nothing left to forget.

function step(id: string, text: string) {
  return { id, text, timer: null, note: null };
}

// `updatedText` defaults to the existing wording, so a call that says nothing
// about text is asking purely about identity. Since issue #1178 the two are
// separable questions — an id can now survive a step being rewritten — and a
// helper that silently reworded every step would make half the rule untestable.
function amendmentWith(
  existingStepIds: string[],
  updatedStepIds: string[],
  updatedText = 'Chop.',
): RecipeAmendment {
  const existing = { ...existingRecipe(), steps: existingStepIds.map((id) => step(id, 'Chop.')) };
  const updated = { ...existing, steps: updatedStepIds.map((id) => step(id, updatedText)) };
  return { existing, updated, diff: diffRecipe(existing, updated) };
}

describe('applyRecipeAmendment — whether the guided plan survives the write', () => {
  it('discards the plan when the write re-mints the step ids its notes point at', async () => {
    // Still the outcome whenever the librarian cites nothing usable — an omitted
    // citation, a hallucinated id, a duplicate — because `assembleRecipeDraft`
    // then falls back to a fresh `crypto.randomUUID()` for that step (issue #1178).
    const result = await applyRecipeAmendment(amendmentWith(['s1', 's2'], ['new-1', 'new-2']));

    expect(result.kind).toBe('ok');
    expect(discardGuidedPlan).toHaveBeenCalledExactlyOnceWith('pilaf');
  });

  it('leaves the plan alone when every step survives, wording and all', async () => {
    // An edit that touches only metadata or ingredient text keeps its ids AND its
    // step wording, and the plan's `stepNotes` still resolve onto the words they
    // were written against. Deleting it would be a plain loss.
    await applyRecipeAmendment(amendmentWith(['s1', 's2'], ['s1', 's2']));

    expect(discardGuidedPlan).not.toHaveBeenCalled();
  });

  it('discards the plan when a step kept its id but was reworded (issue #1178)', async () => {
    // The half that did not exist before the librarian started citing. A surviving
    // id used to be proof the step was untouched; now it only proves the librarian
    // said this step CAME FROM that one, which a complete rewrite also satisfies.
    // A note left annotating wording it was not written against is worse than a
    // note that is gone, because nothing shows it.
    await applyRecipeAmendment(amendmentWith(['s1', 's2'], ['s1', 's2'], 'Chop very finely.'));

    expect(discardGuidedPlan).toHaveBeenCalledExactlyOnceWith('pilaf');
  });

  it('leaves the plan alone when a new step is added beside untouched ones', async () => {
    // A genuine addition annotates nothing, so it invalidates nothing. The rule
    // asks only about the steps the plan could already be pointing at.
    await applyRecipeAmendment(amendmentWith(['s1'], ['s1', 'new-1']));

    expect(discardGuidedPlan).not.toHaveBeenCalled();
  });

  it('does not discard when the save failed', async () => {
    // Throwing away the plan for a write that never landed is a loss with
    // nothing bought for it — the recipe still has the steps the plan names.
    vi.mocked(saveRecipe).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'corruption' },
    } as Awaited<ReturnType<typeof saveRecipe>>);

    const result = await applyRecipeAmendment(amendmentWith(['s1'], ['new-1']));

    expect(result.kind).toBe('err');
    expect(discardGuidedPlan).not.toHaveBeenCalled();
  });

  it('reports the save result, not the plan delete — a stale plan is not a failed save', async () => {
    // Best-effort by design: a failed delete leaves the situation we were
    // already in, so it must not turn a successful save into an error the user
    // has to interpret.
    vi.mocked(discardGuidedPlan).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'corruption' },
    } as Awaited<ReturnType<typeof discardGuidedPlan>>);

    const result = await applyRecipeAmendment(amendmentWith(['s1'], ['new-1']));

    expect(result.kind).toBe('ok');
  });
});
