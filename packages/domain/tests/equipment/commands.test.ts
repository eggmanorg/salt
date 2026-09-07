import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@salt/shared-types';
import {
  addEquipment,
  removeEquipment,
  renameEquipment,
  addAccessory,
  removeAccessory,
  setAccessoryOwned,
  addRule,
  removeRule,
  editRule,
} from '@salt/domain';
import type { EquipmentManifest } from '@salt/domain';
import type { IdGenerator } from '../../src/equipment/ports/IdGenerator.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const NOW = '2026-01-01T00:00:00.000Z';
const NOW2 = '2026-01-02T00:00:00.000Z';

let seq = 0;
function makeIds(): IdGenerator {
  return {
    newEquipmentId: () => `eq-${++seq}`,
    newAccessoryId: () => `acc-${++seq}`,
  };
}

function emptyManifest(): EquipmentManifest {
  return { schemaVersion: 1, updatedAt: NOW, items: [] };
}

function manifestWith(items: EquipmentManifest['items']): EquipmentManifest {
  return { schemaVersion: 1, updatedAt: NOW, items };
}

function makeItem(
  id: string,
  overrides: Partial<EquipmentManifest['items'][number]> = {},
): EquipmentManifest['items'][number] {
  return {
    id,
    schemaVersion: 1 as const,
    name: 'Stand Mixer',
    accessories: [],
    rules: [],
    environment: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAccessory(
  id: string,
  overrides: Partial<{ name: string; owned: boolean; included: boolean }> = {},
) {
  return { id, name: 'Dough Hook', owned: true, included: true, ...overrides };
}

// ── addEquipment ─────────────────────────────────────────────────────────────

describe('addEquipment', () => {
  it('appends a new item to an empty manifest', () => {
    const result = addEquipment(emptyManifest(), { name: 'KitchenAid', now: NOW }, makeIds());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0]!.name).toBe('KitchenAid');
    expect(result.value.items[0]!.schemaVersion).toBe(1);
    expect(result.value.items[0]!.updatedAt).toBe(NOW);
    expect(result.value.items[0]!.accessories).toEqual([]);
    expect(result.value.items[0]!.rules).toEqual([]);
  });

  it('trims whitespace from name', () => {
    const result = addEquipment(emptyManifest(), { name: '  KitchenAid  ', now: NOW }, makeIds());
    expect(result.kind === 'ok' && result.value.items[0]!.name).toBe('KitchenAid');
  });

  it('returns INVALID_EQUIPMENT_NAME for blank name', () => {
    const result = addEquipment(emptyManifest(), { name: '   ', now: NOW }, makeIds());
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.INVALID_EQUIPMENT_NAME,
    });
  });

  it('does not mutate the original manifest', () => {
    const manifest = emptyManifest();
    addEquipment(manifest, { name: 'Blender', now: NOW }, makeIds());
    expect(manifest.items).toHaveLength(0);
  });
});

// ── removeEquipment ───────────────────────────────────────────────────────────

describe('removeEquipment', () => {
  it('removes the item with the given id', () => {
    const manifest = manifestWith([makeItem('eq-1'), makeItem('eq-2')]);
    const result = removeEquipment(manifest, { id: 'eq-1' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.items).toHaveLength(1);
    expect(result.value.items[0]!.id).toBe('eq-2');
  });

  it('returns NotFound for unknown id', () => {
    const result = removeEquipment(emptyManifest(), { id: 'no-such' });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'NotFound', resource: 'equipment', id: 'no-such' });
  });
});

// ── renameEquipment ───────────────────────────────────────────────────────────

describe('renameEquipment', () => {
  it('renames the item and stamps updatedAt', () => {
    const manifest = manifestWith([makeItem('eq-1', { name: 'Old Name' })]);
    const result = renameEquipment(manifest, { id: 'eq-1', name: 'New Name', now: NOW2 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.items[0]!.name).toBe('New Name');
    expect(result.value.items[0]!.updatedAt).toBe(NOW2);
  });

  it('trims whitespace from name', () => {
    const manifest = manifestWith([makeItem('eq-1')]);
    const result = renameEquipment(manifest, { id: 'eq-1', name: '  Trimmed  ', now: NOW });
    expect(result.kind === 'ok' && result.value.items[0]!.name).toBe('Trimmed');
  });

  it('returns INVALID_EQUIPMENT_NAME for blank name', () => {
    const manifest = manifestWith([makeItem('eq-1')]);
    const result = renameEquipment(manifest, { id: 'eq-1', name: '', now: NOW });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.INVALID_EQUIPMENT_NAME,
    });
  });

  it('returns NotFound for unknown id', () => {
    const result = renameEquipment(emptyManifest(), { id: 'no-such', name: 'X', now: NOW });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'NotFound', resource: 'equipment', id: 'no-such' });
  });
});

// ── addAccessory ──────────────────────────────────────────────────────────────

describe('addAccessory', () => {
  it('appends accessory to the correct item', () => {
    const manifest = manifestWith([makeItem('eq-1')]);
    const result = addAccessory(
      manifest,
      { equipmentId: 'eq-1', name: 'Dough Hook', owned: true, included: true, now: NOW2 },
      makeIds(),
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const item = result.value.items[0]!;
    expect(item.accessories).toHaveLength(1);
    expect(item.accessories[0]!.name).toBe('Dough Hook');
    expect(item.accessories[0]!.owned).toBe(true);
    expect(item.accessories[0]!.included).toBe(true);
    expect(item.updatedAt).toBe(NOW2);
  });

  it('trims whitespace from accessory name', () => {
    const manifest = manifestWith([makeItem('eq-1')]);
    const result = addAccessory(
      manifest,
      { equipmentId: 'eq-1', name: '  Hook  ', owned: false, included: false, now: NOW },
      makeIds(),
    );
    expect(result.kind === 'ok' && result.value.items[0]!.accessories[0]!.name).toBe('Hook');
  });

  it('returns INVALID_ACCESSORY_NAME for blank name', () => {
    const manifest = manifestWith([makeItem('eq-1')]);
    const result = addAccessory(
      manifest,
      { equipmentId: 'eq-1', name: '  ', owned: false, included: false, now: NOW },
      makeIds(),
    );
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.INVALID_ACCESSORY_NAME,
    });
  });

  it('returns NotFound when equipmentId does not exist', () => {
    const result = addAccessory(
      emptyManifest(),
      { equipmentId: 'no-such', name: 'Hook', owned: false, included: false, now: NOW },
      makeIds(),
    );
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'NotFound', resource: 'equipment', id: 'no-such' });
  });
});

// ── removeAccessory ───────────────────────────────────────────────────────────

describe('removeAccessory', () => {
  it('removes the accessory from the item', () => {
    const manifest = manifestWith([
      makeItem('eq-1', { accessories: [makeAccessory('acc-1'), makeAccessory('acc-2')] }),
    ]);
    const result = removeAccessory(manifest, {
      equipmentId: 'eq-1',
      accessoryId: 'acc-1',
      now: NOW2,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.items[0]!.accessories).toHaveLength(1);
    expect(result.value.items[0]!.accessories[0]!.id).toBe('acc-2');
    expect(result.value.items[0]!.updatedAt).toBe(NOW2);
  });

  it('returns NotFound when equipmentId does not exist', () => {
    const result = removeAccessory(emptyManifest(), {
      equipmentId: 'no-such',
      accessoryId: 'acc-1',
      now: NOW,
    });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'NotFound', resource: 'equipment', id: 'no-such' });
  });

  it('returns EQUIPMENT_ACCESSORY_NOT_FOUND when accessoryId does not exist', () => {
    const manifest = manifestWith([makeItem('eq-1')]);
    const result = removeAccessory(manifest, {
      equipmentId: 'eq-1',
      accessoryId: 'no-such',
      now: NOW,
    });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.EQUIPMENT_ACCESSORY_NOT_FOUND,
    });
  });
});

// ── setAccessoryOwned ─────────────────────────────────────────────────────────

describe('setAccessoryOwned', () => {
  it('toggles owned to false', () => {
    const manifest = manifestWith([
      makeItem('eq-1', { accessories: [makeAccessory('acc-1', { owned: true })] }),
    ]);
    const result = setAccessoryOwned(manifest, {
      equipmentId: 'eq-1',
      accessoryId: 'acc-1',
      owned: false,
      now: NOW2,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.items[0]!.accessories[0]!.owned).toBe(false);
    expect(result.value.items[0]!.updatedAt).toBe(NOW2);
  });

  it('toggles owned to true', () => {
    const manifest = manifestWith([
      makeItem('eq-1', { accessories: [makeAccessory('acc-1', { owned: false })] }),
    ]);
    const result = setAccessoryOwned(manifest, {
      equipmentId: 'eq-1',
      accessoryId: 'acc-1',
      owned: true,
      now: NOW,
    });
    expect(result.kind === 'ok' && result.value.items[0]!.accessories[0]!.owned).toBe(true);
  });

  it('returns NotFound when equipmentId does not exist', () => {
    const result = setAccessoryOwned(emptyManifest(), {
      equipmentId: 'no-such',
      accessoryId: 'acc-1',
      owned: false,
      now: NOW,
    });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'NotFound', resource: 'equipment', id: 'no-such' });
  });

  it('returns EQUIPMENT_ACCESSORY_NOT_FOUND when accessoryId does not exist', () => {
    const manifest = manifestWith([makeItem('eq-1')]);
    const result = setAccessoryOwned(manifest, {
      equipmentId: 'eq-1',
      accessoryId: 'no-such',
      owned: false,
      now: NOW,
    });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({
      kind: 'ValidationError',
      code: ErrorCode.EQUIPMENT_ACCESSORY_NOT_FOUND,
    });
  });
});

// ── addRule ───────────────────────────────────────────────────────────────────

describe('addRule', () => {
  it('appends rule to item', () => {
    const manifest = manifestWith([makeItem('eq-1')]);
    const result = addRule(manifest, {
      equipmentId: 'eq-1',
      rule: 'Use on speed 4 only',
      now: NOW2,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.items[0]!.rules).toEqual(['Use on speed 4 only']);
    expect(result.value.items[0]!.updatedAt).toBe(NOW2);
  });

  it('trims whitespace from rule', () => {
    const manifest = manifestWith([makeItem('eq-1')]);
    const result = addRule(manifest, { equipmentId: 'eq-1', rule: '  rule  ', now: NOW });
    expect(result.kind === 'ok' && result.value.items[0]!.rules[0]).toBe('rule');
  });

  it('returns INVALID_RULE for blank rule', () => {
    const manifest = manifestWith([makeItem('eq-1')]);
    const result = addRule(manifest, { equipmentId: 'eq-1', rule: '   ', now: NOW });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'ValidationError', code: ErrorCode.INVALID_RULE });
  });

  it('returns NotFound when equipmentId does not exist', () => {
    const result = addRule(emptyManifest(), { equipmentId: 'no-such', rule: 'rule', now: NOW });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'NotFound', resource: 'equipment', id: 'no-such' });
  });
});

// ── removeRule ────────────────────────────────────────────────────────────────

describe('removeRule', () => {
  it('removes the rule at the given index', () => {
    const manifest = manifestWith([makeItem('eq-1', { rules: ['rule A', 'rule B', 'rule C'] })]);
    const result = removeRule(manifest, { equipmentId: 'eq-1', ruleIndex: 1, now: NOW2 });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.items[0]!.rules).toEqual(['rule A', 'rule C']);
    expect(result.value.items[0]!.updatedAt).toBe(NOW2);
  });

  it('returns NotFound when equipmentId does not exist', () => {
    const result = removeRule(emptyManifest(), { equipmentId: 'no-such', ruleIndex: 0, now: NOW });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'NotFound', resource: 'equipment', id: 'no-such' });
  });

  it('returns INVALID_RULE for out-of-range index', () => {
    const manifest = manifestWith([makeItem('eq-1', { rules: ['only rule'] })]);
    const result = removeRule(manifest, { equipmentId: 'eq-1', ruleIndex: 5, now: NOW });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'ValidationError', code: ErrorCode.INVALID_RULE });
  });

  it('returns INVALID_RULE for negative index', () => {
    const manifest = manifestWith([makeItem('eq-1', { rules: ['only rule'] })]);
    const result = removeRule(manifest, { equipmentId: 'eq-1', ruleIndex: -1, now: NOW });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'ValidationError', code: ErrorCode.INVALID_RULE });
  });
});

// ── editRule ──────────────────────────────────────────────────────────────────

describe('editRule', () => {
  it('replaces the rule at the given index', () => {
    const manifest = manifestWith([makeItem('eq-1', { rules: ['old rule'] })]);
    const result = editRule(manifest, {
      equipmentId: 'eq-1',
      ruleIndex: 0,
      rule: 'new rule',
      now: NOW2,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.items[0]!.rules).toEqual(['new rule']);
    expect(result.value.items[0]!.updatedAt).toBe(NOW2);
  });

  it('trims whitespace from the new rule text', () => {
    const manifest = manifestWith([makeItem('eq-1', { rules: ['old rule'] })]);
    const result = editRule(manifest, {
      equipmentId: 'eq-1',
      ruleIndex: 0,
      rule: '  trimmed  ',
      now: NOW,
    });
    expect(result.kind === 'ok' && result.value.items[0]!.rules[0]).toBe('trimmed');
  });

  it('returns INVALID_RULE for blank rule text', () => {
    const manifest = manifestWith([makeItem('eq-1', { rules: ['a rule'] })]);
    const result = editRule(manifest, { equipmentId: 'eq-1', ruleIndex: 0, rule: '   ', now: NOW });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'ValidationError', code: ErrorCode.INVALID_RULE });
  });

  it('returns INVALID_RULE for out-of-range index', () => {
    const manifest = manifestWith([makeItem('eq-1', { rules: ['a rule'] })]);
    const result = editRule(manifest, {
      equipmentId: 'eq-1',
      ruleIndex: 99,
      rule: 'new',
      now: NOW,
    });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'ValidationError', code: ErrorCode.INVALID_RULE });
  });

  it('returns NotFound when equipmentId does not exist', () => {
    const result = editRule(emptyManifest(), {
      equipmentId: 'no-such',
      ruleIndex: 0,
      rule: 'rule',
      now: NOW,
    });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error).toEqual({ kind: 'NotFound', resource: 'equipment', id: 'no-such' });
  });
});
