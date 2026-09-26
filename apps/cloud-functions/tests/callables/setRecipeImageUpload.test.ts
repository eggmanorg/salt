import { describe, it, expect, vi, beforeEach } from 'vitest';

// The recipe hero upload (issue #455), pinned for issue #1575: the upload write must
// delete `imageBrief`. That field means "the art direction behind the photo you are
// looking at", and no art direction produced an uploaded photo — a brief left over
// from the previous AI hero seeds the Regenerate dialog, is used verbatim by the
// onRecipeWritten trigger, and feeds the prompt viewer.
//
// Mocking follows setObservationImageUpload.test.ts (onCall returns the raw handler,
// a fake HttpsError carrying `.code`, Storage down to `file().save()`, encodeHeroImage
// stubbed, dynamic import after mocks). The Firestore mock additionally keeps an
// in-memory copy of each recipe and applies every partial update to it, honouring
// the delete sentinel, so the last test can follow one document across two callables.

const DELETE_SENTINEL = Symbol('FieldValue.delete');

type RecipeState = Record<string, unknown>;
const recipes = new Map<string, RecipeState>();

const mockUpdate = vi.fn<(id: string, patch: RecipeState) => Promise<undefined>>(
  async (id, patch) => {
    const next = { ...recipes.get(id) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === DELETE_SENTINEL) delete next[key];
      else next[key] = value;
    }
    recipes.set(id, next);
    return undefined;
  },
);
const mockDoc = vi.fn((id: string) => ({
  update: (patch: RecipeState) => mockUpdate(id, patch),
}));
const mockCollection = vi.fn(() => ({ doc: mockDoc }));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: mockCollection }),
  FieldValue: { delete: () => DELETE_SENTINEL },
}));

const mockSave = vi.fn(async () => undefined);
const mockFile = vi.fn(() => ({ save: mockSave }));

vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({ name: 'demo-salt.appspot.com', file: mockFile }),
  }),
}));

const mockEncode = vi.fn(async () => Buffer.from('webp-bytes'));
vi.mock('../../src/imaging/encodeHeroImage.js', () => ({
  encodeHeroImage: (...args: unknown[]) => mockEncode(...(args as [])),
}));

const mockReport = vi.fn(async () => undefined);
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportFlowError: (...args: unknown[]) => mockReport(...(args as [])),
  reportServerError: (...args: unknown[]) => mockReport(...(args as [])),
}));

class FakeHttpsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

vi.mock('firebase-functions/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  HttpsError: FakeHttpsError,
}));

const { setRecipeImageUpload } = await import('../../src/callables/setRecipeImageUpload.js');
const { regenerateRecipeImage } = await import('../../src/callables/regenerateRecipeImage.js');

const NOW = 1_700_000_000_000;
const IMAGE_BASE64 = Buffer.from('a photograph of a stew').toString('base64');
const AI_BRIEF = 'A cast-iron pot on a scrubbed oak table, steam rising, shot from above.';

function upload(data: unknown, auth: unknown = { uid: 'uid-a' }) {
  return (setRecipeImageUpload as unknown as Function)({ auth, data });
}

function regenerate(data: unknown) {
  return (regenerateRecipeImage as unknown as Function)({ auth: { uid: 'uid-a' }, data });
}

beforeEach(() => {
  vi.clearAllMocks();
  recipes.clear();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

describe('setRecipeImageUpload callable', () => {
  it('rejects unauthenticated callers before writing anything', async () => {
    await expect(upload({ recipeId: 'r1', imageBase64: IMAGE_BASE64 }, null)).rejects.toMatchObject(
      { code: 'unauthenticated' },
    );
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload before writing anything', async () => {
    await expect(upload({ recipeId: '', imageBase64: IMAGE_BASE64 })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('stamps the uploaded hero, bumps the nonce and deletes the previous brief, in one partial update', async () => {
    const result = await upload({ recipeId: 'recipe-123', imageBase64: IMAGE_BASE64 });

    expect(mockFile).toHaveBeenCalledWith('recipe-images/recipe-123.webp');
    expect(mockCollection).toHaveBeenCalledWith('recipes');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith('recipe-123', {
      image: {
        url: expect.stringContaining(encodeURIComponent('recipe-images/recipe-123.webp')),
        source: 'upload',
      },
      imageBrief: DELETE_SENTINEL,
      imageRequestedAt: NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  // Daniel's ruling on #1575: Regenerate over an uploaded photo must behave exactly
  // like a first-time AI generation, carrying nothing over from an earlier AI image's
  // brief. So follow two recipes through an unedited Regenerate — one uploaded over
  // an AI hero that had a brief, one that has never had an image or a brief — and
  // require the trigger to find them in the same state.
  it('leaves Regenerate after an upload on the same path as a first-time generation', async () => {
    recipes.set('uploaded', {
      title: 'Stew',
      image: { url: 'https://example.test/ai.webp', source: 'ai' },
      imageBrief: AI_BRIEF,
    });
    recipes.set('never-generated', { title: 'Stew', image: null });

    await upload({ recipeId: 'uploaded', imageBase64: IMAGE_BASE64 });
    // The guard. With no saved brief, the client's unedited Regenerate sends no brief
    // (RecipeViewPage.svelte's openRegenerate, pinned in
    // apps/web-pwa/tests/RecipeViewPage.imageBrief.test.ts) — so both calls below are
    // what the dialog sends only while this assertion holds.
    expect(recipes.get('uploaded')).not.toHaveProperty('imageBrief');

    await regenerate({ recipeId: 'uploaded' });
    await regenerate({ recipeId: 'never-generated' });

    const afterUpload = recipes.get('uploaded');
    expect(afterUpload).toEqual(recipes.get('never-generated'));
    expect(afterUpload).not.toHaveProperty('imageBrief');
    expect(afterUpload).toMatchObject({ image: null });
  });
});
