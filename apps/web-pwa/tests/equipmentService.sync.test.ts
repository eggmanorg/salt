import { describe, it, expect, beforeEach, afterEach, vi, type Mocked } from 'vitest';
import { get } from 'svelte/store';
import type { EquipmentManifest } from '@salt/domain';

vi.mock('@salt/firebase-sync', () => ({
  subscribeEquipmentManifest: vi.fn(),
  saveEquipmentManifest: vi.fn().mockResolvedValue({ kind: 'ok' as const, value: undefined }),
  callIdentifyEquipment: vi.fn(),
  callPopulateEquipmentEntry: vi.fn(),
  // Pictograms (issue #877) ride the same init lifecycle. Defaulted to a no-op
  // unsubscribe so every case here keeps testing the MANIFEST store; the icon
  // collection is a separate store over a separate collection and is asserted
  // in its own cases below.
  subscribeEquipmentIcons: vi.fn(() => () => {}),
  callDrawEquipmentIcon: vi.fn(),
}));

import * as firebaseSync from '@salt/firebase-sync';

import {
  equipment,
  isLoadingEquipment,
  initEquipmentSync,
  addEquipmentItem,
  removeEquipmentItem,
  renameEquipmentItem,
  captureEquipmentItem,
  addEquipmentAccessory,
  removeEquipmentAccessory,
  toggleEquipmentAccessoryOwned,
  addEquipmentRule,
  removeEquipmentRule,
  editEquipmentRule,
  setEquipmentEnvironmentFor,
  memEquipmentManifestStore,
  __resetEquipmentServiceForTest,
} from '../src/lib/equipmentService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

type ManifestCb = (manifest: EquipmentManifest | null) => void;

function wireSubscription(): {
  emit: (manifest: EquipmentManifest | null) => void;
  unsub: ReturnType<typeof vi.fn>;
} {
  const unsub = vi.fn();
  let cb: ManifestCb | null = null;
  fs.subscribeEquipmentManifest.mockImplementation((onManifest) => {
    cb = onManifest as ManifestCb;
    return unsub;
  });
  return {
    emit: (m) => cb!(m),
    unsub,
  };
}

function makeManifest(items: EquipmentManifest['items'] = []): EquipmentManifest {
  return { schemaVersion: 1, updatedAt: '2026-05-13T00:00:00.000Z', items };
}

describe('equipmentService — subscription-fed store', () => {
  beforeEach(() => {
    __resetEquipmentServiceForTest();
    vi.clearAllMocks();
    fs.saveEquipmentManifest.mockResolvedValue({ kind: 'ok' as const, value: undefined });
  });

  afterEach(() => {
    __resetEquipmentServiceForTest();
  });

  it('equipment starts null and isLoadingEquipment starts true', () => {
    expect(get(equipment)).toBeNull();
    expect(get(isLoadingEquipment)).toBe(true);
  });

  it('initEquipmentSync subscribes via firebase-sync', () => {
    wireSubscription();
    initEquipmentSync();
    expect(fs.subscribeEquipmentManifest).toHaveBeenCalledOnce();
  });

  it('clears loading and populates store on first snapshot', () => {
    const { emit } = wireSubscription();
    initEquipmentSync();
    expect(get(isLoadingEquipment)).toBe(true);

    const manifest = makeManifest();
    emit(manifest);

    expect(get(isLoadingEquipment)).toBe(false);
    expect(get(equipment)).toEqual(manifest);
  });

  it('clears loading even when subscription delivers null (new user, no doc)', () => {
    const { emit } = wireSubscription();
    initEquipmentSync();
    emit(null);
    expect(get(isLoadingEquipment)).toBe(false);
    expect(get(equipment)).toBeNull();
  });

  it('returned cleanup invokes the firestore unsub', () => {
    const { unsub } = wireSubscription();
    const cleanup = initEquipmentSync();
    cleanup();
    expect(unsub).toHaveBeenCalledOnce();
  });
});

describe('equipmentService — hydration guard', () => {
  beforeEach(() => {
    __resetEquipmentServiceForTest();
    vi.clearAllMocks();
    fs.saveEquipmentManifest.mockResolvedValue({ kind: 'ok' as const, value: undefined });
  });

  afterEach(() => {
    __resetEquipmentServiceForTest();
  });

  it('addEquipmentItem refuses to write before the subscription has hydrated', async () => {
    const result = await addEquipmentItem('Mixer');
    expect(result.kind).toBe('err');
    expect(fs.saveEquipmentManifest).not.toHaveBeenCalled();
  });

  it('captureEquipmentItem refuses to write before the subscription has hydrated', async () => {
    const result = await captureEquipmentItem('Mixer', []);
    expect(result.kind).toBe('err');
    expect(fs.saveEquipmentManifest).not.toHaveBeenCalled();
  });

  it.each([
    ['removeEquipmentItem', () => removeEquipmentItem('x')],
    ['renameEquipmentItem', () => renameEquipmentItem('x', 'y')],
    ['addEquipmentAccessory', () => addEquipmentAccessory('x', 'a', false, false)],
    ['removeEquipmentAccessory', () => removeEquipmentAccessory('x', 'a')],
    ['toggleEquipmentAccessoryOwned', () => toggleEquipmentAccessoryOwned('x', 'a', true)],
    ['addEquipmentRule', () => addEquipmentRule('x', 'r')],
    ['removeEquipmentRule', () => removeEquipmentRule('x', 0)],
    ['editEquipmentRule', () => editEquipmentRule('x', 0, 'r')],
  ])('%s refuses to write before the subscription has hydrated', async (_, op) => {
    const result = await op();
    expect(result.kind).toBe('err');
    expect(fs.saveEquipmentManifest).not.toHaveBeenCalled();
  });
});

describe('equipmentService — mutations after hydration', () => {
  beforeEach(() => {
    __resetEquipmentServiceForTest();
    vi.clearAllMocks();
    fs.saveEquipmentManifest.mockResolvedValue({ kind: 'ok' as const, value: undefined });
  });

  afterEach(() => {
    __resetEquipmentServiceForTest();
  });

  function hydrateEmpty(): () => void {
    const { emit } = wireSubscription();
    const cleanup = initEquipmentSync();
    emit(makeManifest());
    return cleanup;
  }

  it('addEquipmentItem appends an item and triggers exactly one save', async () => {
    const cleanup = hydrateEmpty();
    const result = await addEquipmentItem('Stand Mixer');
    expect(result.kind).toBe('ok');
    expect(fs.saveEquipmentManifest).toHaveBeenCalledTimes(1);
    const saved = fs.saveEquipmentManifest.mock.calls[0]![0];
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]!.name).toBe('Stand Mixer');
    cleanup();
  });

  it('captureEquipmentItem creates the item with all accessories in ONE save', async () => {
    const cleanup = hydrateEmpty();
    const result = await captureEquipmentItem('KitchenAid', [
      { name: 'Dough hook', owned: true, included: true },
      { name: 'Whisk', owned: false, included: true },
      { name: 'Pasta roller', owned: false, included: false },
    ]);

    expect(result.kind).toBe('ok');
    expect(fs.saveEquipmentManifest).toHaveBeenCalledTimes(1);

    const saved = fs.saveEquipmentManifest.mock.calls[0]![0];
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]!.accessories).toHaveLength(3);
    expect(saved.items[0]!.accessories.map((a) => a.name)).toEqual([
      'Dough hook',
      'Whisk',
      'Pasta roller',
    ]);
    expect(saved.items[0]!.accessories[0]!.owned).toBe(true);
    cleanup();
  });

  it('captureEquipmentItem returns the new item id (no name-based lookup)', async () => {
    const cleanup = hydrateEmpty();
    const result = await captureEquipmentItem('Mixer', []);
    if (result.kind !== 'ok') throw new Error('expected ok');

    const expectedId = result.value.manifest.items[0]!.id;
    expect(result.value.itemId).toBe(expectedId);
    cleanup();
  });

  it('captureEquipmentItem is robust against a same-name collision (returns the NEW id)', async () => {
    const { emit } = wireSubscription();
    const cleanup = initEquipmentSync();

    // Hydrate a manifest that already has an item with the name we're about to capture.
    const existing: EquipmentManifest['items'][number] = {
      id: 'pre-existing-id',
      schemaVersion: 1,
      name: 'Stand Mixer',
      accessories: [],
      rules: [],
      environment: null,
      updatedAt: '2026-05-12T00:00:00.000Z',
    };
    emit(makeManifest([existing]));

    const result = await captureEquipmentItem('Stand Mixer', []);
    if (result.kind !== 'ok') throw new Error('expected ok');

    expect(result.value.itemId).not.toBe('pre-existing-id');
    expect(result.value.manifest.items).toHaveLength(2);
    cleanup();
  });

  it('rule and accessory mutations each emit exactly one save', async () => {
    const cleanup = hydrateEmpty();
    const captured = await captureEquipmentItem('Mixer', []);
    if (captured.kind !== 'ok') throw new Error('expected ok');
    const itemId = captured.value.itemId;
    fs.saveEquipmentManifest.mockClear();

    await addEquipmentAccessory(itemId, 'Whisk', false, true);
    await addEquipmentRule(itemId, 'Use low speed for bread');
    await renameEquipmentItem(itemId, 'KitchenAid Artisan');

    expect(fs.saveEquipmentManifest).toHaveBeenCalledTimes(3);
    cleanup();
  });

  // Places (issue #1281). The UI half of the shared/dedicated claim is tested
  // against the component; this is the seam between the page and the domain
  // command, and that a place is written like any other equipment mutation.
  it('setEquipmentEnvironmentFor writes the place and drops a setpoint a dedicated one cannot have', async () => {
    const cleanup = hydrateEmpty();
    const captured = await captureEquipmentItem('Dough proofer', []);
    if (captured.kind !== 'ok') throw new Error('expected ok');
    const itemId = captured.value.itemId;
    fs.saveEquipmentManifest.mockClear();

    const result = await setEquipmentEnvironmentFor(itemId, {
      control: 'dedicated',
      minCelsius: 20,
      maxCelsius: 50,
      humidity: null,
      standing: { celsius: 28, relativeHumidityPercent: null },
    });

    expect(result.kind).toBe('ok');
    expect(fs.saveEquipmentManifest).toHaveBeenCalledTimes(1);
    const written = get(equipment)!.items.find((i) => i.id === itemId)!;
    expect(written.environment?.maxCelsius).toBe(50);
    expect(written.environment?.standing).toBeNull();
    cleanup();
  });

  it('setEquipmentEnvironmentFor(null) turns a place back into ordinary equipment', async () => {
    const cleanup = hydrateEmpty();
    const captured = await captureEquipmentItem('Dough proofer', []);
    if (captured.kind !== 'ok') throw new Error('expected ok');
    const itemId = captured.value.itemId;
    await setEquipmentEnvironmentFor(itemId, {
      control: 'dedicated',
      minCelsius: 20,
      maxCelsius: 50,
      humidity: null,
      standing: null,
    });

    await setEquipmentEnvironmentFor(itemId, null);

    expect(get(equipment)!.items.find((i) => i.id === itemId)!.environment).toBeNull();
    cleanup();
  });

  it('setEquipmentEnvironmentFor refuses before the subscription has hydrated', async () => {
    __resetEquipmentServiceForTest();
    const result = await setEquipmentEnvironmentFor('eq-1', null);
    expect(result.kind).toBe('err');
    expect(fs.saveEquipmentManifest).not.toHaveBeenCalled();
  });
});

describe('memEquipmentManifestStore', () => {
  it('load returns seed manifest', async () => {
    const seed = makeManifest();
    const { store } = memEquipmentManifestStore(seed);
    const result = await store.load();
    expect(result).toEqual({ kind: 'ok', value: seed });
  });

  it('load returns null when no seed is provided', async () => {
    const { store } = memEquipmentManifestStore();
    const result = await store.load();
    expect(result).toEqual({ kind: 'ok', value: null });
  });

  it('save records the written manifest and load reflects it', async () => {
    const { store, getWritten } = memEquipmentManifestStore();
    expect(getWritten()).toBeNull();
    const next = makeManifest();
    await store.save(next);
    expect(getWritten()).toEqual(next);
    const loaded = await store.load();
    expect(loaded).toEqual({ kind: 'ok', value: next });
  });
});
