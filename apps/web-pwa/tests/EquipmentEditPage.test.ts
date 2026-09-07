import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { EquipmentManifest } from '@salt/domain';
import type { EquipmentIconDoc } from '@salt/domain/schemas';
import { setNextCrop } from './fixtures/cropStub.js';

// The description panel's revision loop (issue #885). Revise and Start over both
// rewrite the words in the box and PERSIST NOTHING — Draw is still the only thing
// that writes a description to the item, and the only thing that spends money.
// Use a photo (issue #947) is the third of the three: it opens the real
// EquipmentPhotoDialog (only its ImageCropper stubbed, same seam
// RecipeImportPhotoDialog's own test uses — jsdom cannot answer a real crop), so
// this exercises the actual lazy-load and the actual wiring into runBriefAction.

const { mockEquipment, mockEquipmentIcons } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockEquipment: makeStore<EquipmentManifest | null>(null),
    mockEquipmentIcons: makeStore<Map<string, EquipmentIconDoc>>(new Map()),
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/nav.js', () => ({ goBack: vi.fn() }));
vi.mock('@salt/ui-components', async () => {
  const actual = await vi.importActual<typeof import('@salt/ui-components')>('@salt/ui-components');
  const stub = await import('./fixtures/StubImageCropper.svelte');
  return { ...actual, ImageCropper: stub.default };
});
vi.mock('../src/lib/equipmentService.js', () => ({
  equipment: mockEquipment,
  equipmentIcons: mockEquipmentIcons,
  equipmentIconFor: (icons: Map<string, EquipmentIconDoc>, id: string) => icons.get(id) ?? null,
  equipmentThumbnailFor: () => null,
  equipmentIconVersionFor: () => undefined,
  drawEquipmentIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  hideEquipmentIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  reviseEquipmentBrief: vi.fn(),
  restartEquipmentBrief: vi.fn(),
  describeEquipmentFromPhoto: vi.fn(),
  renameEquipmentItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  removeEquipmentItem: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  addEquipmentAccessory: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  removeEquipmentAccessory: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  toggleEquipmentAccessoryOwned: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  addEquipmentRule: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  removeEquipmentRule: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  editEquipmentRule: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  setEquipmentEnvironmentFor: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));

import EquipmentEditPage from '../src/routes/equipment/EquipmentEditPage.svelte';
import {
  drawEquipmentIcon,
  reviseEquipmentBrief,
  restartEquipmentBrief,
  describeEquipmentFromPhoto,
} from '../src/lib/equipmentService.js';

const ITEM_ID = 'mixer-1';
const NAME = 'Kenwood Chef KVC3100S';
const STORED_BRIEF = 'A tilt-head stand mixer with a cream enamel body and a chrome bowl.';

function seed(brief = STORED_BRIEF): void {
  mockEquipment._set({
    schemaVersion: 1,
    updatedAt: '2026-08-22T00:00:00.000Z',
    items: [
      {
        id: ITEM_ID,
        schemaVersion: 1,
        name: NAME,
        accessories: [],
        rules: [],
        environment: null,
        updatedAt: '2026-08-22T00:00:00.000Z',
      },
    ],
  });
  mockEquipmentIcons._set(
    new Map<string, EquipmentIconDoc>([
      [
        ITEM_ID,
        {
          subjectBrief: brief,
          briefSourceName: NAME,
          thumbnail: null,
          updatedAt: '2026-08-22T00:00:00.000Z',
        },
      ],
    ]),
  );
}

function renderPage() {
  return render(EquipmentEditPage, { props: { params: { id: ITEM_ID } } });
}

function brief(): HTMLTextAreaElement {
  return screen.getByTestId('equipment-icon-brief') as HTMLTextAreaElement;
}

let objectUrlSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  setNextCrop('stub-cropped-base64');
  objectUrlSeq = 0;
  globalThis.URL.createObjectURL = vi.fn(() => `blob:photo-${++objectUrlSeq}`);
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('EquipmentEditPage — Revise', () => {
  it('rewrites the description from a correction, and draws nothing', async () => {
    vi.mocked(reviseEquipmentBrief).mockResolvedValue({
      kind: 'ok',
      value: 'A matte black tilt-head stand mixer with a chrome bowl.',
    });
    renderPage();

    await fireEvent.input(screen.getByTestId('equipment-icon-steer'), {
      target: { value: "it's matte black, not cream" },
    });
    await fireEvent.click(screen.getByTestId('equipment-icon-revise-btn'));

    await waitFor(() => {
      expect(brief().value).toBe('A matte black tilt-head stand mixer with a chrome bowl.');
    });
    expect(vi.mocked(reviseEquipmentBrief)).toHaveBeenCalledWith(
      NAME,
      STORED_BRIEF,
      "it's matte black, not cream",
    );
    // Nothing is drawn and nothing is saved: Draw is still the only writer.
    expect(vi.mocked(drawEquipmentIcon)).not.toHaveBeenCalled();
  });

  it('spends the correction — the steer box empties so a second Revise is a new one', async () => {
    vi.mocked(reviseEquipmentBrief).mockResolvedValue({
      kind: 'ok',
      value: 'A matte black mixer.',
    });
    renderPage();

    const steer = screen.getByTestId('equipment-icon-steer') as HTMLInputElement;
    await fireEvent.input(steer, { target: { value: "it's matte black" } });
    await fireEvent.click(screen.getByTestId('equipment-icon-revise-btn'));

    await waitFor(() => expect(steer.value).toBe(''));
  });

  it('revises what is ON SCREEN, including a hand edit, not the stored words', async () => {
    vi.mocked(reviseEquipmentBrief).mockResolvedValue({ kind: 'ok', value: 'Revised.' });
    renderPage();

    await fireEvent.input(brief(), { target: { value: 'My own hand-typed description.' } });
    await fireEvent.input(screen.getByTestId('equipment-icon-steer'), {
      target: { value: 'add the tank' },
    });
    await fireEvent.click(screen.getByTestId('equipment-icon-revise-btn'));

    await waitFor(() => {
      expect(vi.mocked(reviseEquipmentBrief)).toHaveBeenCalledWith(
        NAME,
        'My own hand-typed description.',
        'add the tank',
      );
    });
  });

  it('a failure leaves the box EXACTLY as it was and says so', async () => {
    vi.mocked(reviseEquipmentBrief).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    renderPage();

    // Several edits deep — precisely the text a failed revision must not cost.
    await fireEvent.input(brief(), { target: { value: 'Six edits deep.' } });
    await fireEvent.input(screen.getByTestId('equipment-icon-steer'), {
      target: { value: 'make it black' },
    });
    await fireEvent.click(screen.getByTestId('equipment-icon-revise-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('equipment-icon-brief-error')).toBeTruthy();
    });
    expect(brief().value).toBe('Six edits deep.');
    // And the correction survives too, so pressing again costs no retyping.
    expect((screen.getByTestId('equipment-icon-steer') as HTMLInputElement).value).toBe(
      'make it black',
    );
  });

  it('is not offered without a correction to apply', () => {
    renderPage();
    expect((screen.getByTestId('equipment-icon-revise-btn') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('EquipmentEditPage — Start over', () => {
  it('writes a fresh description from the name, discarding accumulated edits', async () => {
    vi.mocked(restartEquipmentBrief).mockResolvedValue({
      kind: 'ok',
      value: 'A tilt-head stand mixer, as first described.',
    });
    renderPage();

    await fireEvent.input(brief(), { target: { value: 'Edited into a corner.' } });
    await fireEvent.click(screen.getByTestId('equipment-icon-start-over-btn'));

    await waitFor(() => {
      expect(brief().value).toBe('A tilt-head stand mixer, as first described.');
    });
    // The name alone — no brief, no steer — which is what the trigger sends too.
    expect(vi.mocked(restartEquipmentBrief)).toHaveBeenCalledWith(NAME);
    expect(vi.mocked(drawEquipmentIcon)).not.toHaveBeenCalled();
  });

  it('a failure leaves the box exactly as it was', async () => {
    vi.mocked(restartEquipmentBrief).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    renderPage();

    await fireEvent.input(brief(), { target: { value: 'Edited into a corner.' } });
    await fireEvent.click(screen.getByTestId('equipment-icon-start-over-btn'));

    await waitFor(() => expect(screen.getByTestId('equipment-icon-brief-error')).toBeTruthy());
    expect(brief().value).toBe('Edited into a corner.');
  });
});

describe('EquipmentEditPage — Draw still owns the words', () => {
  it('draws exactly what is in the box after a revision', async () => {
    vi.mocked(reviseEquipmentBrief).mockResolvedValue({
      kind: 'ok',
      value: 'A matte black tilt-head stand mixer.',
    });
    renderPage();

    await fireEvent.input(screen.getByTestId('equipment-icon-steer'), {
      target: { value: "it's matte black" },
    });
    await fireEvent.click(screen.getByTestId('equipment-icon-revise-btn'));
    await waitFor(() => expect(brief().value).toBe('A matte black tilt-head stand mixer.'));

    await fireEvent.click(screen.getByTestId('equipment-icon-draw-btn'));

    await waitFor(() => {
      expect(vi.mocked(drawEquipmentIcon)).toHaveBeenCalledWith(
        ITEM_ID,
        'A matte black tilt-head stand mixer.',
      );
    });
  });
});

describe('EquipmentEditPage — Use a photo (issue #947)', () => {
  async function openPhotoDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByTestId('equipment-icon-photo-btn'));
    await screen.findByTestId('equipment-photo-dialog');
  }

  async function pickAndDescribe(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    const input = await screen.findByTestId('equipment-photo-input');
    await user.upload(input, new File(['bytes'], 'mixer.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByTestId('equipment-photo-describe-btn'));
  }

  it('opens the dialog lazily on Use a photo', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.queryByTestId('equipment-photo-dialog')).toBeNull();
    await openPhotoDialog(user);

    expect(screen.getByTestId('equipment-photo-dialog')).toBeInTheDocument();
  });

  it('cancelling closes the dialog and changes nothing', async () => {
    const user = userEvent.setup();
    renderPage();

    await openPhotoDialog(user);
    await user.click(screen.getByTestId('equipment-photo-cancel'));

    await waitFor(() => expect(screen.queryByTestId('equipment-photo-dialog')).toBeNull());
    expect(vi.mocked(describeEquipmentFromPhoto)).not.toHaveBeenCalled();
    expect(brief().value).toBe(STORED_BRIEF);
  });

  it('rewrites the description from the photo, spends the steer, draws nothing, and closes', async () => {
    vi.mocked(describeEquipmentFromPhoto).mockResolvedValue({
      kind: 'ok',
      value: 'A squat matte-black bean-to-cup machine.',
    });
    const user = userEvent.setup();
    renderPage();

    // A leftover steer is "Start over, but with a picture" — spent the same way
    // Start over spends it, since the photo discards whatever was in the box.
    await fireEvent.input(screen.getByTestId('equipment-icon-steer'), {
      target: { value: 'leftover steer text' },
    });
    await openPhotoDialog(user);
    await pickAndDescribe(user);

    await waitFor(() => {
      expect(brief().value).toBe('A squat matte-black bean-to-cup machine.');
    });
    expect(vi.mocked(describeEquipmentFromPhoto)).toHaveBeenCalledWith(NAME, {
      base64: 'stub-cropped-base64',
      contentType: 'image/webp',
    });
    // Nothing is drawn and nothing is saved: Draw is still the only writer.
    expect(vi.mocked(drawEquipmentIcon)).not.toHaveBeenCalled();
    expect((screen.getByTestId('equipment-icon-steer') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(screen.queryByTestId('equipment-photo-dialog')).toBeNull());
  });

  it('a failure leaves the box EXACTLY as it was and says so', async () => {
    vi.mocked(describeEquipmentFromPhoto).mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    const user = userEvent.setup();
    renderPage();

    // Several edits deep — precisely the text a failed describe must not cost.
    await fireEvent.input(brief(), { target: { value: 'Six edits deep.' } });
    await openPhotoDialog(user);
    await pickAndDescribe(user);

    await waitFor(() => {
      expect(screen.getByTestId('equipment-icon-brief-error')).toBeTruthy();
    });
    expect(brief().value).toBe('Six edits deep.');
  });
});
