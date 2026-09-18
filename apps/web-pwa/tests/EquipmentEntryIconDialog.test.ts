import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { Accessory, EquipmentItem } from '@salt/domain';
import type { EquipmentIconDoc } from '@salt/domain/schemas';
import { ErrorCode } from '@salt/shared-types';

// One entry's picture (issue #1465, Phase 2).
//
// What this pins is the ONE thing that differs from the item panel: an entry has
// no description until somebody asks for it, so the dialog opens on an empty
// state and "Describe it" is the first act. Everything after that is the item
// pipeline called with the entry's own document id — which is the accessory's
// uuid — and the assertions below are on that id rather than on the item's,
// because passing the wrong one is the whole of how this feature would silently
// draw over the appliance's picture instead.

const { mockEquipmentIcons } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return { mockEquipmentIcons: makeStore<Map<string, EquipmentIconDoc>>(new Map()) };
});

vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
// The two shared child dialogs are the item page's, reused unchanged and pointed
// at the entry's own document id. Their own behaviour is not this file's subject;
// what is, is that they are handed the ACCESSORY id.
vi.mock('../src/lib/imagePromptService.js', () => ({
  getImagePrompt: vi
    .fn()
    .mockResolvedValue({ kind: 'ok', value: { prompt: 'p', model: 'm', seedFile: null } }),
}));
vi.mock('../src/lib/iconUploadService.js', () => ({
  uploadIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/equipmentService.js', () => ({
  equipmentIcons: mockEquipmentIcons,
  equipmentIconFor: (icons: Map<string, EquipmentIconDoc>, id: string) => icons.get(id) ?? null,
  authorEntryIconBrief: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  drawEquipmentIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  hideEquipmentIcon: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
  reviseEquipmentBrief: vi.fn().mockResolvedValue({ kind: 'ok', value: 'a perforated basket' }),
}));

import EquipmentEntryIconDialog from '../src/routes/equipment/EquipmentEntryIconDialog.svelte';
import {
  authorEntryIconBrief,
  drawEquipmentIcon,
  hideEquipmentIcon,
  reviseEquipmentBrief,
} from '../src/lib/equipmentService.js';
import { addToast } from '../src/lib/toastStore.js';
import { getImagePrompt } from '../src/lib/imagePromptService.js';

const ITEM_ID = 'eq-cosori';
const ACCESSORY_ID = 'acc-steam-basket';
const NOW = '2026-09-18T00:00:00.000Z';

const ITEM: EquipmentItem = {
  id: ITEM_ID,
  schemaVersion: 1,
  name: 'Cosori 5L Rice Cooker',
  kind: 'equipment',
  accessories: [],
  rules: [],
  note: '',
  environment: null,
  borrowedPicture: null,
  updatedAt: NOW,
};

const ACCESSORY: Accessory = {
  id: ACCESSORY_ID,
  name: 'Steam Basket',
  owned: true,
  included: true,
  note: '',
  borrowedPicture: null,
};

function open(icon: Partial<EquipmentIconDoc> | null = null): void {
  mockEquipmentIcons._set(
    icon === null ? new Map() : new Map([[ACCESSORY_ID, icon as EquipmentIconDoc]]),
  );
  render(EquipmentEntryIconDialog, {
    props: { open: true, onClose: vi.fn(), item: ITEM, accessory: ACCESSORY },
  });
}

const DESCRIBED: Partial<EquipmentIconDoc> = {
  subjectBrief: 'a shallow perforated basket',
  briefSourceName: 'Steam Basket (Cosori 5L Rice Cooker)',
  thumbnail: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockEquipmentIcons._set(new Map());
});

afterEach(cleanup);

describe('EquipmentEntryIconDialog — nothing is described until asked', () => {
  it('offers Describe it, and no drawing controls, when the entry has no document', () => {
    open(null);
    expect(screen.getByTestId('equipment-entry-describe-btn')).toBeTruthy();
    expect(screen.queryByTestId('equipment-entry-draw-btn')).toBeNull();
    expect(screen.queryByTestId('equipment-entry-brief')).toBeNull();
  });

  it('asks for the description with the ITEM and the ENTRY, which is what names the subject', async () => {
    open(null);
    await userEvent.click(screen.getByTestId('equipment-entry-describe-btn'));
    await waitFor(() => expect(authorEntryIconBrief).toHaveBeenCalledWith(ITEM_ID, ACCESSORY_ID));
  });
});

describe('EquipmentEntryIconDialog — once described, it is the item flow', () => {
  it('draws from the words on screen, against the ENTRY’s own document id', async () => {
    open(DESCRIBED);
    await userEvent.click(screen.getByTestId('equipment-entry-draw-btn'));
    // The accessory id, never the item's: drawing against the item's would
    // replace the appliance's picture with a picture of one of its parts.
    await waitFor(() =>
      expect(drawEquipmentIcon).toHaveBeenCalledWith(ACCESSORY_ID, 'a shallow perforated basket'),
    );
  });

  it('reads "Redraw" only once something has been drawn from this description', () => {
    open({ ...DESCRIBED, sourceName: 'Steam Basket (Cosori 5L Rice Cooker)' });
    expect(screen.getByTestId('equipment-entry-draw-btn').textContent).toContain('Redraw');
    cleanup();
    open(DESCRIBED);
    expect(screen.getByTestId('equipment-entry-draw-btn').textContent).toContain('Draw it');
  });

  it('revises against the QUALIFIED subject name, not the entry’s bare words', async () => {
    open(DESCRIBED);
    // fireEvent, not userEvent: bits-ui's focus trap eats keystrokes inside a
    // Dialog, which is the standing web-pwa unit-suite flake.
    await fireEvent.input(screen.getByTestId('equipment-entry-steer'), {
      target: { value: "it's stainless" },
    });
    await userEvent.click(screen.getByTestId('equipment-entry-revise-btn'));
    // "a steam basket for what?" — revising prose about an appliance without
    // knowing which appliance is the drift the describe step exists to prevent.
    await waitFor(() =>
      expect(reviseEquipmentBrief).toHaveBeenCalledWith(
        'Steam Basket (Cosori 5L Rice Cooker)',
        'a shallow perforated basket',
        "it's stainless",
      ),
    );
  });

  it('hides this entry’s picture and offers no Hide once it is hidden', async () => {
    open(DESCRIBED);
    await userEvent.click(screen.getByTestId('equipment-entry-hide-btn'));
    await waitFor(() => expect(hideEquipmentIcon).toHaveBeenCalledWith(ACCESSORY_ID));
    cleanup();
    open({ ...DESCRIBED, thumbnail: 'hidden' });
    expect(screen.queryByTestId('equipment-entry-hide-btn')).toBeNull();
  });

  it('asks the Prompt window about the ENTRY, not about its record', async () => {
    open(DESCRIBED);
    await userEvent.click(screen.getByTestId('equipment-entry-prompt-btn'));
    await waitFor(() => expect(getImagePrompt).toHaveBeenCalledWith('equipment', ACCESSORY_ID));
  });

  it('closes the Prompt window back to this dialog, not to the page', async () => {
    open(DESCRIBED);
    await userEvent.click(screen.getByTestId('equipment-entry-prompt-btn'));
    await waitFor(() => expect(screen.getByTestId('image-prompt-dialog')).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    // The entry dialog is still open behind it: closing a child window is not
    // closing the row's.
    await waitFor(() => expect(screen.queryByTestId('image-prompt-dialog')).toBeNull());
    expect(screen.getByTestId('equipment-entry-icon-dialog')).toBeTruthy();
  });

  it('opens the upload window, which writes to the entry’s own Storage object', async () => {
    open(DESCRIBED);
    await userEvent.click(screen.getByTestId('equipment-entry-upload-btn'));
    // The object path is `equipment-icons/{docId}.webp` and the doc id here is
    // the accessory's, so an upload replaces the entry's picture and never the
    // appliance's.
    await waitFor(() => expect(screen.getByTestId('image-upload-dialog')).toBeTruthy());
  });

  it('hands the close back to the page, which owns which row is open', async () => {
    const onClose = vi.fn();
    mockEquipmentIcons._set(new Map([[ACCESSORY_ID, DESCRIBED as EquipmentIconDoc]]));
    render(EquipmentEntryIconDialog, {
      props: { open: true, onClose, item: ITEM, accessory: ACCESSORY },
    });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // The entry was deleted on another device while this was open: the document
  // goes with it, and the box must empty rather than keep offering to draw words
  // that describe nothing.
  it('empties the description when the entry’s document disappears', async () => {
    open(DESCRIBED);
    expect((screen.getByTestId('equipment-entry-brief') as HTMLTextAreaElement).value).toBe(
      'a shallow perforated basket',
    );
    mockEquipmentIcons._set(new Map());
    await waitFor(() => expect(screen.queryByTestId('equipment-entry-brief')).toBeNull());
    expect(screen.getByTestId('equipment-entry-describe-btn')).toBeTruthy();
  });

  it('re-describes on request, which is how a renamed entry gets fresh words', async () => {
    open(DESCRIBED);
    await userEvent.click(screen.getByTestId('equipment-entry-redescribe-btn'));
    await waitFor(() => expect(authorEntryIconBrief).toHaveBeenCalledWith(ITEM_ID, ACCESSORY_ID));
  });
});

describe('EquipmentEntryIconDialog — a refusal costs the words nothing', () => {
  it('says so when the description could not be written, and stays on the empty state', async () => {
    vi.mocked(authorEntryIconBrief).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    open(null);
    await userEvent.click(screen.getByTestId('equipment-entry-describe-btn'));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Couldn't write a description.", 'destructive'),
    );
    expect(screen.getByTestId('equipment-entry-describe-btn')).toBeTruthy();
  });

  // The kill switch being off reaches the client as a ValidationError, and it is
  // a different sentence from a failure: nothing went wrong and nothing was spent.
  it('distinguishes "drawing is switched off" from a draw that failed', async () => {
    vi.mocked(drawEquipmentIcon).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'ValidationError', code: ErrorCode.EQUIPMENT_ICON_NOT_DRAWABLE },
    });
    open(DESCRIBED);
    await userEvent.click(screen.getByTestId('equipment-entry-draw-btn'));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        'Drawing is switched off for this environment.',
        'destructive',
      ),
    );
    cleanup();
    vi.mocked(drawEquipmentIcon).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    open(DESCRIBED);
    await userEvent.click(screen.getByTestId('equipment-entry-draw-btn'));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('Failed to draw the picture.', 'destructive'),
    );
  });

  it('leaves the description exactly as it was when a revision fails', async () => {
    vi.mocked(reviseEquipmentBrief).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    open(DESCRIBED);
    await fireEvent.input(screen.getByTestId('equipment-entry-steer'), {
      target: { value: 'it is stainless' },
    });
    await userEvent.click(screen.getByTestId('equipment-entry-revise-btn'));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(
        "Couldn't rewrite the description — your text is unchanged.",
        'destructive',
      ),
    );
    expect((screen.getByTestId('equipment-entry-brief') as HTMLTextAreaElement).value).toBe(
      'a shallow perforated basket',
    );
  });

  // Enter in the correction field is the one route into Revise that the button's
  // own disabled state does not guard, so the handler's own guard is the only
  // thing standing between an empty correction and a wasted call.
  it('does nothing on Enter with no correction typed', async () => {
    open(DESCRIBED);
    await fireEvent.keyDown(screen.getByTestId('equipment-entry-steer'), { key: 'Enter' });
    await waitFor(() => expect(reviseEquipmentBrief).not.toHaveBeenCalled());
  });

  it('leaves an ordinary keystroke in the correction field alone', async () => {
    open(DESCRIBED);
    await fireEvent.keyDown(screen.getByTestId('equipment-entry-steer'), { key: 'a' });
    await waitFor(() => expect(reviseEquipmentBrief).not.toHaveBeenCalled());
  });

  // Every control is disabled while EITHER call is in flight, not just its own:
  // a draw started over a description a revision is about to replace would pay
  // for a picture of the wrong words.
  it('disables Draw while a revision is still running', async () => {
    let settle!: (v: { kind: 'ok'; value: string }) => void;
    vi.mocked(reviseEquipmentBrief).mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    open(DESCRIBED);
    await fireEvent.input(screen.getByTestId('equipment-entry-steer'), {
      target: { value: 'it is stainless' },
    });
    await userEvent.click(screen.getByTestId('equipment-entry-revise-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('equipment-entry-draw-btn').getAttribute('data-disabled')).not.toBe(
        null,
      ),
    );
    settle({ kind: 'ok', value: 'a perforated basket' });
  });

  it('says so when hiding fails', async () => {
    vi.mocked(hideEquipmentIcon).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });
    open(DESCRIBED);
    await userEvent.click(screen.getByTestId('equipment-entry-hide-btn'));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith('Failed to hide the picture.', 'destructive'),
    );
  });
});
