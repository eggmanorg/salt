import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { MAX_RECIPE_PAGE_PHOTOS } from '@salt/domain/schemas';
import { setNextCrop } from './fixtures/cropStub.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────
// Only the cropper is swapped out of @salt/ui-components — the Dialog, Button
// and Icon primitives are the real ones, so the dialog is exercised as it ships.
vi.mock('@salt/ui-components', async () => {
  const actual = await vi.importActual<typeof import('@salt/ui-components')>('@salt/ui-components');
  const stub = await import('./fixtures/StubImageCropper.svelte');
  return { ...actual, ImageCropper: stub.default };
});

vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/recipeService.js', () => ({
  importRecipeFromPhoto: vi.fn(),
  photoImportMessage: vi.fn((code: string) => `copy-for:${code}`),
}));

import RecipeImportPhotoDialog from '../src/routes/recipes/RecipeImportPhotoDialog.svelte';
import { importRecipeFromPhoto } from '../src/lib/recipeService.js';
import { addToast } from '../src/lib/toastStore.js';

const importMock = vi.mocked(importRecipeFromPhoto);
const toastMock = vi.mocked(addToast);

// jsdom ships no object-URL implementation, and the capture flow's whole
// lifecycle is create-then-revoke — so stub both and record the revokes, which
// is the only way to assert that no blob is leaked.
const revoked: string[] = [];
let objectUrlSeq = 0;

const DRAFT = { id: 'imported-9', title: 'Braised Beef' };
// What the import answers since issue #1601: the draft and whether the server
// saved it. The dialog hands it to its host untouched.
const AUTHORED = { recipe: DRAFT, persistence: 'written' };

function openDialog(onImported = vi.fn()) {
  render(RecipeImportPhotoDialog, { props: { open: true, onImported } });
  return onImported;
}

async function shoot(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const input = screen.getByTestId('recipe-import-photo-input');
  await user.upload(input, new File(['bytes'], 'page.jpg', { type: 'image/jpeg' }));
}

// One captured page: shoot it, then accept the framing.
async function capturePage(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await shoot(user);
  await user.click(await screen.findByTestId('recipe-import-photo-use'));
}

beforeEach(() => {
  vi.clearAllMocks();
  revoked.length = 0;
  objectUrlSeq = 0;
  setNextCrop('stub-cropped-base64');
  globalThis.URL.createObjectURL = vi.fn(() => `blob:page-${++objectUrlSeq}`);
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(cleanup);

describe('RecipeImportPhotoDialog — capture', () => {
  it('opens on the capture prompt with nothing to import yet', () => {
    openDialog();

    expect(screen.getByTestId('recipe-import-photo-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-import-photo-input')).toBeInTheDocument();
    expect(screen.queryByTestId('recipe-import-photo-strip')).toBeNull();
    expect(screen.getByTestId('recipe-import-photo-btn')).toBeDisabled();
  });

  it('frames a shot free-aspect — a cookbook page is portrait, not 3:2', async () => {
    const user = userEvent.setup();
    openDialog();

    await shoot(user);

    const cropper = await screen.findByTestId('stub-image-cropper');
    // ui-spec-v06 §1.1: a 3:2 frame over a portrait page crops off either the
    // ingredients or the method — exactly the content being photographed.
    expect(cropper).toHaveAttribute('data-aspect', 'free');
    expect(cropper).toHaveAttribute('data-src', 'blob:page-1');
  });

  it('adds the cropped page to the thumbnail strip and releases the blob URL', async () => {
    const user = userEvent.setup();
    openDialog();

    await capturePage(user);

    const thumbs = await screen.findAllByTestId('recipe-import-photo-thumb');
    expect(thumbs).toHaveLength(1);
    // The thumbnail IS the transport payload rendered back — no second copy of
    // the bytes, and no second encode anywhere in web-pwa.
    expect(thumbs[0]).toHaveAttribute('src', 'data:image/webp;base64,stub-cropped-base64');
    expect(revoked).toContain('blob:page-1');
    expect(screen.getByTestId('recipe-import-photo-btn')).toBeEnabled();
  });

  it('treats a not-yet-ready crop as "try again", not as an error', async () => {
    const user = userEvent.setup();
    openDialog();

    // getCroppedBase64() returns null while a free-mode source is still being
    // measured (ui-spec-v06 §1.4) — the shot must stay on screen.
    setNextCrop(null);
    await capturePage(user);

    expect(screen.queryByTestId('recipe-import-photo-strip')).toBeNull();
    expect(screen.getByTestId('stub-image-cropper')).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('isn’t ready'), 'destructive');
  });

  it('discards a bad shot without capturing it', async () => {
    const user = userEvent.setup();
    openDialog();

    await shoot(user);
    await user.click(await screen.findByTestId('recipe-import-photo-discard'));

    expect(screen.queryByTestId('stub-image-cropper')).toBeNull();
    expect(screen.queryByTestId('recipe-import-photo-strip')).toBeNull();
    expect(revoked).toContain('blob:page-1');
  });

  it('drops a captured page from the strip so it can be retaken', async () => {
    const user = userEvent.setup();
    openDialog();

    await capturePage(user);
    await capturePage(user);
    expect(await screen.findAllByTestId('recipe-import-photo-thumb')).toHaveLength(2);

    await user.click(screen.getAllByTestId('recipe-import-photo-remove')[0]!);

    expect(screen.getAllByTestId('recipe-import-photo-thumb')).toHaveLength(1);
    expect(screen.getByTestId('recipe-import-photo-btn')).toBeEnabled();
  });

  it('stops at the page cap rather than sending a payload the server would refuse', async () => {
    const user = userEvent.setup();
    openDialog();

    for (let i = 0; i < MAX_RECIPE_PAGE_PHOTOS; i += 1) await capturePage(user);

    expect(screen.getAllByTestId('recipe-import-photo-thumb')).toHaveLength(MAX_RECIPE_PAGE_PHOTOS);
    expect(screen.getByTestId('recipe-import-photo-input')).toBeDisabled();
    expect(screen.getByTestId('recipe-import-photo-capacity')).toBeInTheDocument();
  });
});

describe('RecipeImportPhotoDialog — import', () => {
  it('sends every captured page as WebP and hands the draft back', async () => {
    const user = userEvent.setup();
    const onImported = openDialog();
    importMock.mockResolvedValue({ kind: 'ok', value: AUTHORED as never });

    await capturePage(user);
    setNextCrop('second-page-base64');
    await capturePage(user);
    await user.click(screen.getByTestId('recipe-import-photo-btn'));

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(AUTHORED));
    expect(importMock).toHaveBeenCalledWith([
      { base64: 'stub-cropped-base64', contentType: 'image/webp' },
      { base64: 'second-page-base64', contentType: 'image/webp' },
    ]);
  });

  // Issue #1601: a server write that failed is not a failed import — the recipe
  // still opens, and the host is the one that knows where it lands and so what to
  // say. The dialog must hand the outcome on rather than drop it or claim success.
  it('hands a recipe the server could not save to the host, outcome and all', async () => {
    const user = userEvent.setup();
    const onImported = openDialog();
    const unsaved = { recipe: DRAFT, persistence: 'failed' };
    importMock.mockResolvedValue({ kind: 'ok', value: unsaved as never });

    await capturePage(user);
    await user.click(screen.getByTestId('recipe-import-photo-btn'));

    await waitFor(() => expect(onImported).toHaveBeenCalledWith(unsaved));
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('keeps the photos when the read fails, and says why', async () => {
    const user = userEvent.setup();
    const onImported = openDialog();
    importMock.mockResolvedValue({ kind: 'err', error: 'unreadable-photos' as never });

    await capturePage(user);
    await user.click(screen.getByTestId('recipe-import-photo-btn'));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith('copy-for:unreadable-photos', 'destructive'),
    );
    // "your photos are still there to retry" — a blurry-page verdict costs a
    // re-shoot, never the whole set.
    expect(screen.getAllByTestId('recipe-import-photo-thumb')).toHaveLength(1);
    expect(screen.getByTestId('recipe-import-photo-btn')).toBeEnabled();
    expect(onImported).not.toHaveBeenCalled();
  });

  it('cannot fire a second import while one is running', async () => {
    const user = userEvent.setup();
    openDialog();
    let settle: (v: unknown) => void = () => {};
    importMock.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }) as never,
    );

    await capturePage(user);
    const button = screen.getByTestId('recipe-import-photo-btn');
    await user.click(button);

    // Honest in-flight copy rather than a bare spinner: extraction is a
    // multimodal read plus an ingredient parse and canon match.
    expect(await screen.findByTestId('recipe-import-photo-progress')).toHaveTextContent(
      'Reading 1 page',
    );
    expect(button).toBeDisabled();
    await user.click(button);
    expect(importMock).toHaveBeenCalledTimes(1);

    settle({ kind: 'err', error: 'import-failed' });
  });

  it('drops the hand-off if the dialog is dismissed before the read lands', async () => {
    const user = userEvent.setup();
    const onImported = openDialog();
    let settle: (v: unknown) => void = () => {};
    importMock.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }) as never,
    );

    await capturePage(user);
    await user.click(screen.getByTestId('recipe-import-photo-btn'));
    await user.keyboard('{Escape}');

    settle({ kind: 'ok', value: AUTHORED });

    // The recipe is saved and flagged Unreviewed regardless — it is waiting in
    // the library. Reopening an editor someone walked away from is not a favour.
    await new Promise((r) => setTimeout(r, 0));
    expect(onImported).not.toHaveBeenCalled();
  });
});
