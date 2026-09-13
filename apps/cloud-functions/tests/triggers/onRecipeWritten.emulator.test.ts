/**
 * Emulator integration test for onRecipeWritten (issue #148, Tier-2).
 *
 * Exercises the hero-image branch against the real Firestore emulator. The AI
 * flow, sharp encoding and Storage upload are mocked (the isolated Vitest stack
 * runs Firestore + Auth only — no Storage, no real Gemini), so the test focuses
 * on the edge-trigger guard logic and the Firestore write-back: a null image gets
 * a generated `{ url, source: 'ai' }`, the one-shot hint is cleared, a manual
 * upload / hidden / already-set image is left untouched, and the kill-switch and
 * nonce paths behave.
 *
 * Run via: pnpm test:emulator
 */

process.env['FIRESTORE_EMULATOR_HOST'] =
  `127.0.0.1:${process.env['VITE_EMULATOR_FIRESTORE_PORT'] ?? '8080'}`;

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { RecipeDoc } from '@salt/domain/schemas';

// ─── Mocks (everything except firebase-admin/firestore) ──────────────────────

vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_opts: unknown, handler: unknown) => handler,
}));

vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({ value: () => '' }),
}));

vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Typed as the real function, not inferred: `vi.fn(async () => …)` infers a
// ZERO-argument mock, so every recorded call is an empty tuple and reading
// `mock.calls[0][n]` — which this suite does throughout — cannot compile, while
// `mockResolvedValue` is pinned to the one literal used here (#1135).
const mockGenerateImage = vi.fn<
  (input: Record<string, unknown>) => Promise<{ imageBase64: string; contentType: string }>
>(async () => ({ imageBase64: 'QUJD', contentType: 'image/png' }));
vi.mock('../../src/flows/generateRecipeImage.js', () => ({
  generateRecipeImageFlow: mockGenerateImage,
}));

const mockEncode = vi.fn(async () => Buffer.from([1, 2, 3]));
vi.mock('../../src/imaging/encodeHeroImage.js', () => ({ encodeHeroImage: mockEncode }));

const mockSave = vi.fn(async () => undefined);
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({
      name: 'demo-salt.appspot.com',
      file: (path: string) => {
        void path;
        return { save: mockSave };
      },
    }),
  }),
}));

const { onRecipeWritten } = await import('../../src/triggers/onRecipeWritten.js');

// ─── Setup ───────────────────────────────────────────────────────────────────

const PROJECT_ID = 'demo-salt';
const EMULATOR_HOST = process.env['FIRESTORE_EMULATOR_HOST'] as string;

let adminApp: App;

function makeRecipe(id: string, overrides: Partial<RecipeDoc> = {}): RecipeDoc {
  return {
    id,
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Roast chicken',
    description: 'A whole roast chicken with lemon and thyme.',
    ingredients: [],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    image: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function clearEmulator(): Promise<void> {
  const url = `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const resp = await fetch(url, { method: 'DELETE' });
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`Failed to clear emulator: HTTP ${resp.status}`);
  }
}

function makeEvent(id: string, after: RecipeDoc | null, before?: RecipeDoc | null) {
  return {
    params: { id },
    data: {
      before: before
        ? { exists: true, data: () => before }
        : { exists: false, data: () => undefined },
      after: after ? { exists: true, data: () => after } : { exists: false, data: () => undefined },
    },
  };
}

beforeAll(() => {
  adminApp = initializeApp({ projectId: PROJECT_ID });
});

afterAll(async () => {
  await deleteApp(adminApp);
});

beforeEach(async () => {
  await clearEmulator();
  vi.clearAllMocks();
  mockGenerateImage.mockResolvedValue({ imageBase64: 'QUJD', contentType: 'image/png' });
  mockEncode.mockResolvedValue(Buffer.from([1, 2, 3]));
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('onRecipeWritten — Firestore emulator', () => {
  it('generates a hero and writes its public URL + source "ai" when image is null', async () => {
    const db = getFirestore(adminApp);
    const recipe = makeRecipe('r1', { image: null });
    await db.collection('recipes').doc('r1').set(recipe);

    await (onRecipeWritten as Function)(makeEvent('r1', recipe));

    expect(mockGenerateImage).toHaveBeenCalledOnce();
    expect(mockEncode).toHaveBeenCalledOnce();
    expect(mockSave).toHaveBeenCalledOnce();

    const snap = await db.collection('recipes').doc('r1').get();
    expect(snap.data()!['image']).toEqual({
      url: 'https://firebasestorage.googleapis.com/v0/b/demo-salt.appspot.com/o/recipe-images%2Fr1.webp?alt=media',
      source: 'ai',
    });
  });

  it('passes the title + description to the flow', async () => {
    const db = getFirestore(adminApp);
    const recipe = makeRecipe('r-desc', {
      title: 'Lemon drizzle cake',
      description: 'A moist sponge soaked in lemon syrup.',
    });
    await db.collection('recipes').doc('r-desc').set(recipe);

    await (onRecipeWritten as Function)(makeEvent('r-desc', recipe));

    expect(mockGenerateImage).toHaveBeenCalledWith({
      title: 'Lemon drizzle cake',
      description: 'A moist sponge soaked in lemon syrup.',
      kind: 'recipe',
      tags: [],
    });
  });

  it('passes a one-shot imageHint to the flow and clears it after success', async () => {
    const db = getFirestore(adminApp);
    const recipe = makeRecipe('r-hint', { image: null, imageHint: 'on a rustic board' });
    await db.collection('recipes').doc('r-hint').set(recipe);

    await (onRecipeWritten as Function)(makeEvent('r-hint', recipe));

    expect(mockGenerateImage).toHaveBeenCalledWith({
      title: 'Roast chicken',
      description: 'A whole roast chicken with lemon and thyme.',
      kind: 'recipe',
      hint: 'on a rustic board',
      tags: [],
    });

    const snap = await db.collection('recipes').doc('r-hint').get();
    expect(snap.data()!['image']?.['source']).toBe('ai');
    // The one-shot hint is cleared.
    expect(snap.data()!['imageHint']).toBeUndefined();
  });

  it('skips generation when the dev kill-switch is off (issue #238)', async () => {
    const db = getFirestore(adminApp);
    await db
      .collection('devSettings')
      .doc('singleton')
      .set({ recipeImageGenerationEnabled: false, schemaVersion: 1 });
    const recipe = makeRecipe('r-off', { image: null });
    await db.collection('recipes').doc('r-off').set(recipe);

    await (onRecipeWritten as Function)(makeEvent('r-off', recipe));

    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    const snap = await db.collection('recipes').doc('r-off').get();
    expect(snap.data()!['image']).toBeNull();
  });

  it('generates when the dev kill-switch is explicitly on', async () => {
    const db = getFirestore(adminApp);
    await db
      .collection('devSettings')
      .doc('singleton')
      .set({ recipeImageGenerationEnabled: true, schemaVersion: 1 });
    const recipe = makeRecipe('r-on', { image: null });
    await db.collection('recipes').doc('r-on').set(recipe);

    await (onRecipeWritten as Function)(makeEvent('r-on', recipe));

    expect(mockGenerateImage).toHaveBeenCalledOnce();
  });

  it('never clobbers a manual upload', async () => {
    const db = getFirestore(adminApp);
    const uploaded = { url: 'https://example.com/my-photo.jpg', source: 'upload' as const };
    const recipe = makeRecipe('r-upload', { image: uploaded });
    await db.collection('recipes').doc('r-upload').set(recipe);

    await (onRecipeWritten as Function)(makeEvent('r-upload', recipe));

    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    const snap = await db.collection('recipes').doc('r-upload').get();
    expect(snap.data()!['image']).toEqual(uploaded);
  });

  it('generates regardless of the retired imageHidden field (now inert)', async () => {
    // imageHidden was retired (Phase 1): the trigger no longer honors it, so a
    // null-image recipe still generates even when the field is set.
    const db = getFirestore(adminApp);
    const recipe = makeRecipe('r-hidden', { image: null, imageHidden: true });
    await db.collection('recipes').doc('r-hidden').set(recipe);

    await (onRecipeWritten as Function)(makeEvent('r-hidden', recipe));

    expect(mockGenerateImage).toHaveBeenCalledOnce();
  });

  it('does not regenerate when an ai image already exists', async () => {
    const db = getFirestore(adminApp);
    const existing = { url: 'https://example.com/old.webp', source: 'ai' as const };
    const recipe = makeRecipe('r-has', { image: existing });
    await db.collection('recipes').doc('r-has').set(recipe);

    await (onRecipeWritten as Function)(makeEvent('r-has', recipe));

    expect(mockGenerateImage).not.toHaveBeenCalled();
    const snap = await db.collection('recipes').doc('r-has').get();
    expect(snap.data()!['image']).toEqual(existing);
  });

  // Edge-trigger regression: the trigger fires on every write, but generation
  // must start only on the write that transitions the recipe into "needs an
  // image". A re-fire while the create-fire's generation is still in flight
  // (image still null) — here an unrelated title edit — must NOT start a second.
  it('does not regenerate when an unrelated field changes while image stays null', async () => {
    const before = makeRecipe('r-reentry', { image: null });
    const after = makeRecipe('r-reentry', { image: null, title: 'Roast chicken (edited)' });

    await (onRecipeWritten as Function)(makeEvent('r-reentry', after, before));

    expect(mockGenerateImage).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('regenerates when image transitions from a set image to null', async () => {
    const db = getFirestore(adminApp);
    const before = makeRecipe('r-regen', {
      image: { url: 'https://example.com/old.webp', source: 'ai' },
    });
    const after = makeRecipe('r-regen', { image: null });
    await db.collection('recipes').doc('r-regen').set(after);

    await (onRecipeWritten as Function)(makeEvent('r-regen', after, before));

    expect(mockGenerateImage).toHaveBeenCalledOnce();
  });

  // Issue #637: a special — a takeaway, a picnic, a meal out — is a `recipes` doc
  // with no ingredients and no method. It goes through the SAME hero pipeline (the
  // regenerate dialog seeds its textarea from `imageBrief`, so skipping the brief
  // step would leave it empty); only the prompts differ, selected by `kind`. This
  // pins the end-to-end path against the real Firestore round-trip: the kind
  // survives write → schema parse → flow input, and the hero still lands.
  it('generates a hero for a special and forwards its kind to the image flow', async () => {
    const db = getFirestore(adminApp);
    const special = makeRecipe('r-special', {
      kind: 'special',
      title: 'Friday night curry',
      description: 'From the place on the corner. Always the same order.',
      ingredients: [],
      steps: [],
      image: null,
    });
    await db.collection('recipes').doc('r-special').set(special);

    await (onRecipeWritten as Function)(makeEvent('r-special', special));

    expect(mockGenerateImage).toHaveBeenCalledOnce();
    expect(mockGenerateImage.mock.calls[0]![0]).toMatchObject({
      title: 'Friday night curry',
      kind: 'special',
    });

    const snap = await db.collection('recipes').doc('r-special').get();
    expect(snap.data()!['image']).toEqual({
      url: 'https://firebasestorage.googleapis.com/v0/b/demo-salt.appspot.com/o/recipe-images%2Fr-special.webp?alt=media',
      source: 'ai',
    });
  });

  // Back-compat: every recipe already in production predates `kind`. RecipeSchema
  // defaults it on read, so the doc round-trips through Firestore without the field
  // and still reaches the flow as a plain recipe — today's prompt, unchanged.
  it('defaults a stored doc with no kind field to "recipe"', async () => {
    const db = getFirestore(adminApp);
    const legacy = makeRecipe('r-legacy', { image: null }) as Record<string, unknown>;
    delete legacy['kind'];
    await db.collection('recipes').doc('r-legacy').set(legacy);

    const stored = (await db.collection('recipes').doc('r-legacy').get()).data()!;
    expect(stored['kind']).toBeUndefined();

    await (onRecipeWritten as Function)(makeEvent('r-legacy', stored as never));

    expect(mockGenerateImage.mock.calls[0]![0]).toMatchObject({ kind: 'recipe' });
  });

  it('regenerates when imageRequestedAt is bumped even though image was already null', async () => {
    const db = getFirestore(adminApp);
    const before = makeRecipe('r-nonce', { image: null, imageRequestedAt: 1 });
    const after = makeRecipe('r-nonce', { image: null, imageRequestedAt: 2 });
    await db.collection('recipes').doc('r-nonce').set(after);

    await (onRecipeWritten as Function)(makeEvent('r-nonce', after, before));

    expect(mockGenerateImage).toHaveBeenCalledOnce();
  });
});
