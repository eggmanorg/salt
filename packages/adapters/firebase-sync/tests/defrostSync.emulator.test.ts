/**
 * Firestore emulator integration tests for using packs from the freezer
 * (issue #1685).
 *
 * The writer-contract row pins the batch's SHAPE. What only a real Firestore can
 * prove is that it is atomic: a commit against an item another phone has removed
 * applies NOTHING — the shopping row stays, no Kitchen item appears, and the
 * removed item is not brought back — including on the last-pack path, where the
 * entry's delete would succeed on its own.
 *
 * Requires the isolated Vitest emulator stack (issue #84 Phase 3).
 * Run via: pnpm test:emulator
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getApp } from 'firebase/app';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
import type { Defrost, FreezerItem } from '@salt/domain';
import { commitFromFreezer } from '../src/defrostSync.js';
import { deleteFreezerItem, saveFreezerItem } from '../src/freezerItemSync.js';
import { clearFirestoreEmulator, resetDefaultApp } from './emulatorHelpers.js';

beforeEach(async () => {
  await clearFirestoreEmulator();
  await resetDefaultApp();
});

const NOW = '2026-10-12T09:00:00.000Z';

function item(amount: number): FreezerItem {
  return {
    schemaVersion: 1,
    number: 47,
    name: 'Pork loin',
    freezerId: 'fz-garage',
    shelf: 'B',
    amount,
    canonId: 'canon-pork',
    recipeId: null,
    purchasedFrom: null,
    addedAt: NOW,
    updatedAt: NOW,
  };
}

const DEFROST: Defrost = {
  schemaVersion: 1,
  freezerNumber: 47,
  name: 'Pork loin',
  location: 'Garage · shelf B',
  recipeId: 'recipe-chilli',
  recipeTitle: 'Chilli',
  amount: 1,
  committedAt: NOW,
};

const ROW = { listId: 'list-1', itemId: 'item-1' };

async function exists(...path: [string, ...string[]]): Promise<boolean> {
  return (await getDoc(doc(getFirestore(getApp()), ...path))).exists();
}

async function seedRow(): Promise<void> {
  await setDoc(doc(getFirestore(getApp()), 'shoppingLists', ROW.listId, 'items', ROW.itemId), {
    rawText: 'pork loin',
  });
}

describe('commitFromFreezer — Firestore emulator', () => {
  it('takes the pack, writes the Kitchen item and removes the one row, together', async () => {
    await saveFreezerItem(item(3));
    await seedRow();

    await expect(
      commitFromFreezer({
        itemNumber: 47,
        take: -1,
        removeItem: false,
        defrost: DEFROST,
        shoppingRow: ROW,
      }),
    ).resolves.toEqual({ kind: 'ok', value: undefined });

    const stored = await getDoc(doc(getFirestore(getApp()), 'freezerItems', '047'));
    expect(stored.data()?.['amount']).toBe(2);
    expect(await exists('defrosts', '047_recipe-chilli')).toBe(true);
    expect(await exists('shoppingLists', ROW.listId, 'items', ROW.itemId)).toBe(false);
  });

  it('removes the entry with the last pack', async () => {
    await saveFreezerItem(item(1));

    await commitFromFreezer({ itemNumber: 47, take: -1, removeItem: true, defrost: DEFROST });

    expect(await exists('freezerItems', '047')).toBe(false);
    expect(await exists('defrosts', '047_recipe-chilli')).toBe(true);
  });

  it.each([false, true])(
    'applies nothing when another phone removed the item (last pack: %s)',
    async (removeItem) => {
      await saveFreezerItem(item(1));
      await seedRow();
      await deleteFreezerItem(47);

      await expect(
        commitFromFreezer({
          itemNumber: 47,
          take: -1,
          removeItem,
          defrost: DEFROST,
          shoppingRow: ROW,
        }),
      ).resolves.toEqual({
        kind: 'err',
        error: { kind: 'NotFound', resource: 'freezerItem', id: '47' },
      });

      expect(await exists('shoppingLists', ROW.listId, 'items', ROW.itemId)).toBe(true);
      expect(await exists('defrosts', '047_recipe-chilli')).toBe(false);
      expect(await exists('freezerItems', '047')).toBe(false);
    },
  );
});
