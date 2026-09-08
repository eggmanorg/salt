import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/svelte';
import type { Recipe } from '@salt/domain';
import type { RecipeDoc } from '@salt/domain/schemas';
import type { ChatSessionDoc } from '@salt/domain/schemas';

// ⋮ → Refresh (issue #890): ask the chef to write THIS dish out again, then run
// the review gate over the reply without being asked twice.
//
// It used to be a fourth librarian mode (#784) — no chat, no conversation, a
// document re-transcribed at temperature 0. What is under test now is the
// sequence, because the sequence IS the feature: one canned user turn, one chef
// reply, and then the same propose/merge/apply seam every chat amendment uses.
//
// `recipeAmend` is deliberately NOT mocked. The propose/merge/apply seam is the
// thing under test at this level, so the mocks stop at the chef (`sendMessage`),
// the librarian (`authorRecipeTraced`) and the write (`saveRecipe`), exactly as
// the "save as new recipe" suite does.
//
// The load-bearing case is the guided plan. An amendment that re-mints a step id
// leaves the plan's `stepNotes` pointing at steps that no longer exist, so the plan
// is silently WRONG rather than merely stale. Since issue #1178 an id can also
// survive a step being rewritten from end to end, which is wrong in the same silent
// way — the note resolves, onto words it was not written against. So the question
// asked here is about the steps themselves, id AND wording, not about where the
// proposal came from, which is what #784 asked and which was wrong about the chat
// path all along.

const {
  mockRecipes,
  mockCanonItems,
  mockGuidedPlan,
  mockIsLoading,
  mockDefaultListId,
  mockSessions,
  mockEquipment,
} = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockRecipes: makeStore<readonly Recipe[]>([]),
    mockCanonItems: makeStore<readonly { id: string }[]>([]),
    mockGuidedPlan: makeStore<unknown>(null),
    mockIsLoading: makeStore<boolean>(false),
    mockDefaultListId: makeStore<string | null>('list-1'),
    mockSessions: makeStore<readonly ChatSessionDoc[]>([]),
    mockEquipment: makeStore<{ items: readonly { name: string }[] } | null>(null),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({
  auth: { user: { uid: 'uid-1', email: 'cook@test' } },
}));
// #867: the ingredient rows gate their ✗/⚠ markers on canon AND product forms
// having landed, so both stores must read loaded here or no marker ever renders.
vi.mock('../src/lib/canonService.js', () => ({
  canonItems: mockCanonItems,
  isLoadingAisles: {
    subscribe(fn: (v: boolean) => void) {
      fn(false);
      return () => {};
    },
  },
}));
vi.mock('../src/lib/productFormService.js', () => {
  const loaded = <T>(v: T) => ({
    subscribe(fn: (x: T) => void) {
      fn(v);
      return () => {};
    },
  });
  return { productForms: loaded([]), isLoadingProductForms: loaded(false) };
});
vi.mock('../src/lib/guidedPlanService.js', () => ({
  guidedPlan: mockGuidedPlan,
  initGuidedPlanSync: vi.fn(() => () => {}),
  discardGuidedPlan: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
// #812: the page subscribes to the recipe's formula to decide whether to offer
// "Bake a batch" and a link to the formula screen. `null` is loaded-and-there-is-
// none, which is what every recipe in this file is — so neither entry appears and
// nothing else on the page changes.
vi.mock('../src/lib/formulaService.js', () => ({
  formula: {
    subscribe: (fn: (value: unknown) => void) => {
      fn(null);
      return () => {};
    },
  },
  initFormulaSync: vi.fn(() => () => {}),
}));
vi.mock('../src/lib/shoppingListService.svelte.js', () => ({ defaultListId: mockDefaultListId }));
vi.mock('@salt/firebase-sync', () => ({
  saveRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/chatService.js', () => ({
  sessions: mockSessions,
  createChatSession: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock('../src/lib/equipmentService.js', () => ({
  equipment: mockEquipment,
  // The equipment pictogram store `kitIcons` reads (issue #954). Empty here: these
  // fixtures name no owned appliance, so every kit label falls through to the tool
  // vocabulary exactly as it did before.
  equipmentIcons: {
    subscribe(fn: (v: Map<string, never>) => void) {
      fn(new Map<string, never>());
      return () => {};
    },
  },
}));
vi.mock('../src/lib/clipboardImage.js', () => ({
  clipboardImageReadSupported: () => false,
  readClipboardImage: vi.fn(),
  imageFromClipboardData: vi.fn(),
}));
vi.mock('../src/lib/recipeService.js', () => ({
  recipes: mockRecipes,
  isLoadingRecipes: mockIsLoading,
  removeRecipe: vi.fn(),
  canonicaliseIngredients: vi.fn(),
  matchIngredient: vi.fn(),
  persistRecipe: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  stashImportedDraft: vi.fn(),
  authorRecipeTraced: vi.fn(),
  // Identity — attribution (#845) has its own suite; this one is about the page.
  stampRecipeAttribution: <T>(recipe: T) => recipe,
  regenerateRecipeImage: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  reviseRecipeSceneBrief: vi.fn(),
  startOverRecipeSceneBrief: vi.fn(),
  setRecipeImageUpload: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  buildRecipeAddPlan: vi.fn().mockReturnValue([]),
  buildMadeSubRows: vi.fn().mockReturnValue([]),
  commitRecipeAddPlan: vi.fn(),
  recipeAddPlanItemCount: vi.fn().mockReturnValue(0),
}));

import RecipeViewPage from '../src/routes/recipes/RecipeViewPage.svelte';
import { authorRecipeTraced } from '../src/lib/recipeService.js';
import { createChatSession, sendMessage } from '../src/lib/chatService.js';
import { discardGuidedPlan } from '../src/lib/guidedPlanService.js';
import { saveRecipe } from '@salt/firebase-sync';

const RECIPE_ID = 'pilaf';
const REFRESHED_TITLE = 'Chorizo & Red Pepper Pilaf, re-written';

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    lastEditedBy: '',
    createdBy: '',
    kit: [],
    producesCanonId: null,
    id: RECIPE_ID,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Chorizo & Red Pepper Pilaf',
    description: 'A one-pan supper.',
    ingredients: [],
    steps: [{ id: 'step-1', text: 'Fry the chorizo.', note: null, timer: null }],
    metadata: {
      servings: 4,
      tags: ['midweek'],
    },
    source: { type: 'manual' },
    notes: null,
    componentRecipeIds: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// What the librarian hands back. The title moves so the diff has something to show,
// and the step arrives both re-minted AND reworded — the ordinary shape of a refresh,
// and why the guided plan cannot survive one. The two tests below peel those apart.
function librarianDraft(): RecipeDoc {
  return {
    producesCanonId: null,
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    id: 'draft-id',
    schemaVersion: 1,
    kind: 'recipe',
    title: REFRESHED_TITLE,
    description: 'A one-pan supper.',
    ingredients: [],
    steps: [
      {
        id: 'step-fresh',
        text: 'Fry the chorizo until the oil runs red.',
        note: null,
        timer: null,
      },
    ],
    metadata: {
      servings: null,
      tags: [],
    },
    source: { type: 'manual' },
    notes: null,
    componentRecipeIds: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeSession(messages: ChatSessionDoc['messages']): ChatSessionDoc {
  // createdAt is "now", not a fixed date, so this session is never accidentally
  // read-only (issue #1270) under the real clock the guard reads.
  const ts = new Date().toISOString();
  return {
    id: 'session-1',
    schemaVersion: 1,
    ownerUid: 'uid-1',
    recipeId: RECIPE_ID,
    title: 'Pilaf chat',
    messages,
    basedOnRecipeId: null,
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    expiresAt: '2026-01-15T00:00:00.000Z',
  };
}

// What the chef writes back to a Refresh: the whole dish, not a list of changes.
const CHEF_REPLY = 'Chorizo & Red Pepper Pilaf, serves 4. 15 minutes prep, 30 to cook…';

const CHAT_TURNS = [
  {
    id: 'm1',
    role: 'user' as const,
    text: 'add some chilli',
    createdAt: '2026-08-13T10:00:00.000Z',
    offered: [],
  },
  {
    id: 'm2',
    role: 'assistant' as const,
    text: 'Half a teaspoon of chilli flakes, stirred in.',
    createdAt: '2026-08-13T10:00:01.000Z',
    // The chef declared a change to this dish (#1299), which is what makes
    // "Review changes" available to `amendAndReview` below.
    offered: ['dish-change' as const],
  },
];

/** A guided plan for this recipe, as the store would hold it. */
function makePlan() {
  return {
    id: RECIPE_ID,
    schemaVersion: 1,
    recipeId: RECIPE_ID,
    recipeUpdatedAtAtSave: '2026-01-01T00:00:00.000Z',
    prep: [],
    // The reference that a refresh breaks: it names a step id the refreshed
    // recipe will not have.
    stepNotes: [{ stepId: 'step-1', text: 'Get the pan properly hot first.' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  cleanup();
  document.body.style.pointerEvents = '';
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveRecipe).mockResolvedValue({ kind: 'ok', value: undefined });
  vi.mocked(discardGuidedPlan).mockResolvedValue({ kind: 'ok', value: undefined });
  vi.mocked(authorRecipeTraced).mockResolvedValue({
    kind: 'ok',
    value: librarianDraft(),
  } as Awaited<ReturnType<typeof authorRecipeTraced>>);
  mockCanonItems._set([]);
  mockIsLoading._set(false);
  mockRecipes._set([makeRecipe()]);
  mockSessions._set([]);
  mockGuidedPlan._set(makePlan());
  // The chef: creating a session lands it in the store, and answering appends
  // both turns to it — because the review gate reads the session back out of the
  // store, and a stubbed send that quietly changed nothing would let a broken
  // sequence pass.
  vi.mocked(createChatSession).mockImplementation(async () => {
    const session = makeSession([]);
    mockSessions._set([session]);
    return { kind: 'ok', value: session } as Awaited<ReturnType<typeof createChatSession>>;
  });
  vi.mocked(sendMessage).mockImplementation(async (session, text) => {
    const answered = makeSession([
      ...session.messages,
      {
        id: 'm-user',
        role: 'user' as const,
        text,
        createdAt: '2026-08-13T10:00:00.000Z',
        offered: [],
      },
      {
        id: 'm-chef',
        role: 'assistant' as const,
        text: CHEF_REPLY,
        createdAt: '2026-08-13T10:00:01.000Z',
        offered: ['dish-change' as const],
      },
    ]);
    mockSessions._set([answered]);
    return { kind: 'ok', value: answered } as Awaited<ReturnType<typeof sendMessage>>;
  });
  mockEquipment._set({ items: [{ name: 'Sage Pizzaiolo' }] });
});

function renderPage() {
  return render(RecipeViewPage, { props: { params: { id: RECIPE_ID } } });
}

// Refresh lives in the ⋮ menu, which since #735 is its ONLY surface at any width.
// bits-ui renders PopoverContent lazily and portals it, so the menu has to be
// opened first and the items are reached through `screen`, not the container.
async function clickOverflowItem(testid: string): Promise<void> {
  await fireEvent.click(screen.getByTestId('recipe-actions-overflow'));
  await waitFor(() => expect(screen.getByTestId(testid)).toBeInTheDocument());
  await fireEvent.click(screen.getByTestId(testid));
}

/** ⋮ → Refresh, settled on the open review sheet. */
async function refreshAndReview(): Promise<void> {
  await clickOverflowItem('recipe-refresh-menu-item');
  await waitFor(() => expect(screen.getByTestId('recipe-change-summary')).toBeInTheDocument());
}

/** "Review changes" on the chat sidebar, settled on the same sheet. */
async function amendAndReview(): Promise<void> {
  await fireEvent.click(screen.getByTestId('sidebar-apply-changes-btn'));
  await waitFor(() => expect(screen.getByTestId('recipe-change-summary')).toBeInTheDocument());
}

describe('RecipeViewPage — Refresh asks the chef, then proposes', () => {
  it('sends one canned turn and reviews the reply, all from one tap', async () => {
    renderPage();

    await refreshAndReview();

    // The chef was asked, on a session opened for the purpose.
    expect(createChatSession).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sentText = vi.mocked(sendMessage).mock.calls[0]![1];
    // Not a word-for-word pin of the prompt — that would break on every wording
    // improvement — but the two loads that make it a REPAIR rather than a tidy-up,
    // and the one that makes it transcribable at all.
    expect(sentText).toContain('complete recipe, not a list of changes');
    expect(sentText).toMatch(/servings/i);
    expect(sentText).toMatch(/timings/i);

    // …and the reply went straight to the librarian as an ordinary conversation.
    const input = vi.mocked(authorRecipeTraced).mock.calls[0]![0];
    expect(input.recipeId).toBe(RECIPE_ID);
    expect(input.messages.map((m) => m.text)).toContain(CHEF_REPLY);

    // The proposal really is a proposal: the sheet is open and nothing is written.
    expect(screen.getByTestId('recipe-change-summary')).toBeInTheDocument();
    expect(saveRecipe).not.toHaveBeenCalled();
  });

  it('continues the conversation this dish already has', async () => {
    // A recipe with a chat gets its Refresh in that chat, not in a second one —
    // the reply belongs beside everything else that has been said about the dish,
    // and "Chat" would otherwise take you somewhere the answer is not.
    mockSessions._set([makeSession(CHAT_TURNS)]);
    renderPage();

    await refreshAndReview();

    expect(createChatSession).not.toHaveBeenCalled();
    const messages = vi.mocked(authorRecipeTraced).mock.calls[0]![0].messages;
    expect(messages.map((m) => m.text)).toEqual([
      ...CHAT_TURNS.map((m) => m.text),
      expect.stringContaining('Write this recipe out again'),
      CHEF_REPLY,
    ]);
  });

  it('offers the tag vocabulary of the whole collection, not just this dish', async () => {
    // "Prefer a tag the collection already uses" is a house rule, so the
    // vocabulary comes from every recipe — exactly as the chat path builds it.
    mockRecipes._set([
      makeRecipe(),
      makeRecipe({ id: 'other', metadata: { ...makeRecipe().metadata, tags: ['sunday'] } }),
    ]);
    renderPage();

    await refreshAndReview();

    const input = vi.mocked(authorRecipeTraced).mock.calls[0]![0];
    expect([...input.existingTags].sort()).toEqual(['midweek', 'sunday']);
  });

  it('proposes nothing when the chef never answers', async () => {
    // `chat.send` has already toasted the failure. Running the librarian over a
    // conversation whose answer never arrived would propose to overwrite the dish
    // with whatever it made of the question alone.
    vi.mocked(sendMessage).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as Awaited<ReturnType<typeof sendMessage>>);
    renderPage();

    await clickOverflowItem('recipe-refresh-menu-item');

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(authorRecipeTraced).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recipe-change-summary')).toBeNull();
  });

  it('discarding leaves the recipe exactly as it was, and keeps the plan', async () => {
    renderPage();
    await refreshAndReview();

    await fireEvent.click(screen.getByTestId('recipe-change-discard'));

    await waitFor(() => expect(screen.queryByTestId('recipe-change-summary')).toBeNull());
    expect(saveRecipe).not.toHaveBeenCalled();
    // Nothing was applied, so there is no broken step reference to clean up —
    // throwing away the plan here would be a plain loss.
    expect(discardGuidedPlan).not.toHaveBeenCalled();
  });
});

describe('RecipeViewPage — an applied amendment takes the guided plan with it', () => {
  it('saves the re-written recipe and discards the plan whose steps it invalidated', async () => {
    renderPage();
    await refreshAndReview();

    await fireEvent.click(screen.getByTestId('recipe-change-apply'));

    await waitFor(() => expect(saveRecipe).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(saveRecipe).mock.calls[0]![0];
    expect(saved.id).toBe(RECIPE_ID);
    expect(saved.title).toBe(REFRESHED_TITLE);
    // …and the plan goes, keyed on the recipe that was just written.
    await waitFor(() => expect(discardGuidedPlan).toHaveBeenCalledWith(RECIPE_ID));
  });

  it('keeps the plan when the save fails — the plan is only stale once the write lands', async () => {
    vi.mocked(saveRecipe).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'offline' },
    } as Awaited<ReturnType<typeof saveRecipe>>);
    renderPage();
    await refreshAndReview();

    await fireEvent.click(screen.getByTestId('recipe-change-apply'));

    await waitFor(() => expect(saveRecipe).toHaveBeenCalledTimes(1));
    // The recipe still has its original step ids, so the plan still resolves.
    // Discarding it for a write that never happened would cost the user a
    // document for nothing.
    expect(discardGuidedPlan).not.toHaveBeenCalled();
  });

  // The case #784 got wrong, and the reason this is decided on ids now. A chat
  // amendment was believed to preserve the ids of steps it did not change; it
  // never did — `assembleRecipeDraft` mints a fresh uuid for EVERY step on every
  // amend — so the plan was left pointing at steps that no longer existed, with
  // nothing to tell the cook.
  it('discards the plan for a chat amendment too, because that re-mints the ids as well', async () => {
    mockSessions._set([makeSession(CHAT_TURNS)]);
    renderPage();

    await amendAndReview();
    await fireEvent.click(screen.getByTestId('recipe-change-apply'));

    await waitFor(() => expect(saveRecipe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(discardGuidedPlan).toHaveBeenCalledWith(RECIPE_ID));
  });

  it('keeps the plan when the amendment leaves every step untouched', async () => {
    // The other half of the same question. An amendment that touched only the title
    // hands the steps back unchanged — same id, same wording — so every `stepNotes`
    // reference still resolves onto the words it was written against, and the plan
    // is merely stale, which the banner already covers.
    const draft = librarianDraft();
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'ok',
      value: {
        ...draft,
        steps: [{ ...draft.steps[0]!, id: 'step-1', text: 'Fry the chorizo.' }],
      },
    } as Awaited<ReturnType<typeof authorRecipeTraced>>);
    mockSessions._set([makeSession(CHAT_TURNS)]);
    renderPage();

    await amendAndReview();
    await fireEvent.click(screen.getByTestId('recipe-change-apply'));

    await waitFor(() => expect(saveRecipe).toHaveBeenCalledTimes(1));
    expect(discardGuidedPlan).not.toHaveBeenCalled();
  });

  it('discards the plan when a step kept its id but the wording moved (issue #1178)', async () => {
    // The case the librarian's step citation newly creates: the id is honoured
    // because the model said this step came from that one, and the words changed
    // anyway. A surviving id is no longer evidence the note still applies.
    const draft = librarianDraft();
    vi.mocked(authorRecipeTraced).mockResolvedValue({
      kind: 'ok',
      value: { ...draft, steps: [{ ...draft.steps[0]!, id: 'step-1' }] },
    } as Awaited<ReturnType<typeof authorRecipeTraced>>);
    mockSessions._set([makeSession(CHAT_TURNS)]);
    renderPage();

    await amendAndReview();
    await fireEvent.click(screen.getByTestId('recipe-change-apply'));

    await waitFor(() => expect(saveRecipe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(discardGuidedPlan).toHaveBeenCalledWith(RECIPE_ID));
  });
});

// Refresh is gated on `isAuthorable` — "can the librarian WRITE this kind?" —
// the same predicate "Make a variation" uses, and never on the kind directly. An
// outing has no ingredients and no method to write out; a placeholder is a
// photograph of a good dinner and not a dish at all. Cocktails joined the
// authorable set in #765 and turned up here with no edit to this page, which is
// what a predicate gate buys over a hand-written list of the obvious kinds.
describe('RecipeViewPage — Refresh carries no equipment gate', () => {
  it('is offered to a household that owns nothing', async () => {
    // Optimise is hidden with an empty manifest, because it asks a question about
    // kit. Refresh does not: the servings it puts back and the four-operation step
    // it splits are repairs to the WRITING, and a household with one pan needs
    // them exactly as much.
    mockEquipment._set({ items: [] });
    renderPage();

    await fireEvent.click(screen.getByTestId('recipe-actions-overflow'));
    await waitFor(() => expect(screen.getByTestId('recipe-edit-menu-item')).toBeInTheDocument());

    expect(screen.getByTestId('recipe-refresh-menu-item')).toBeInTheDocument();
    expect(screen.queryByTestId('recipe-optimise-kitchen-menu-item')).toBeNull();
  });
});

describe('RecipeViewPage — Refresh is offered only where the librarian can write', () => {
  it.each([
    ['recipe', true],
    ['cocktail', true],
    ['outing', false],
    ['placeholder', false],
  ] as const)('is offered for a %s: %s', async (kind, offered) => {
    mockRecipes._set([makeRecipe({ kind })]);
    renderPage();

    await fireEvent.click(screen.getByTestId('recipe-actions-overflow'));
    // Edit is unconditional, so it is the reliable signal that the menu really
    // mounted — an assertion about what is MISSING would otherwise pass against a
    // menu that never opened.
    await waitFor(() => expect(screen.getByTestId('recipe-edit-menu-item')).toBeInTheDocument());

    if (offered) {
      expect(screen.getByTestId('recipe-refresh-menu-item')).toBeInTheDocument();
    } else {
      expect(screen.queryByTestId('recipe-refresh-menu-item')).toBeNull();
    }
  });
});
