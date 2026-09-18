import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import type { EquipmentManifest } from '@salt/domain';
import type { EquipmentIconDoc, KitchenToolDoc, RecipeKitEntryDoc } from '@salt/domain/schemas';

// The ONE composition point for every kit picture (issues #954, #1460, #1465).
//
// This suite exists because three of the four surfaces that draw a kit picture —
// the method rail, both cook decks, and the guided-cook cards — call
// `$kitIcons.kitIconFor(...)` and draw a tile IF AND ONLY IF it is non-null. So
// the answers below ARE what those surfaces render, and pinning them here pins
// the rail and the deck without standing up either page: the two that have no
// grouping pass, and therefore the two where a wrong picture used to be drawn
// unconditionally (#1460's own finding).
//
// Everything it asserts is the ORDER. The rules themselves are pinned in
// `packages/domain` — `kitchenToolForKitLabel.test.ts` drives #1460's whole case
// table, `resolveKitEntryEquipment.test.ts` the link and its degradation. What
// cannot be tested there is which of them runs first.

const mockKitchenTools = writable<readonly KitchenToolDoc[]>([]);
const mockEquipment = writable<EquipmentManifest | null>(null);
const mockEquipmentIcons = writable<Map<string, EquipmentIconDoc>>(new Map());

vi.mock('../src/lib/equipmentService.js', () => ({
  equipment: mockEquipment,
  equipmentIcons: mockEquipmentIcons,
}));

// Only the VOCABULARY is stood in for. `toolPicture` — the tri-state fold and the
// cache-bust rule — stays the real one, so what this suite asserts is what the
// app renders rather than a re-statement of it.
vi.mock('../src/lib/kitchenToolService.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/lib/kitchenToolService.js')>()),
  kitchenTools: mockKitchenTools,
}));

const { kitIcons } = await import('../src/lib/kitIcons.js');
type KitIconLookup = import('../src/lib/kitIcons.js').KitIconLookup;

const tool = (id: string, label: string, thumbnail: string | null, matchers: string[] = []) =>
  ({
    id,
    schemaVersion: 1,
    label,
    matchers,
    thumbnail,
    createdAt: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as KitchenToolDoc;

const MANIFEST: EquipmentManifest = {
  schemaVersion: 1,
  updatedAt: '',
  items: [
    {
      id: 'eq-magimix',
      schemaVersion: 1,
      name: 'Magimix Cook Expert',
      kind: 'equipment',
      accessories: [
        { id: 'acc-thermo', name: 'Thermo Bowl', owned: true, included: true, note: '' },
      ],
      rules: [],
      note: '',
      environment: null,
      updatedAt: '',
    },
    {
      id: 'eq-pans',
      schemaVersion: 1,
      name: 'Frying Pans',
      kind: 'family',
      accessories: [
        { id: 'acc-tefal', name: 'Tefal non-stick 28cm', owned: true, included: false, note: '' },
      ],
      rules: [],
      note: '',
      environment: null,
      updatedAt: '',
    },
  ],
};

const entry = (label: string, equipment: RecipeKitEntryDoc['equipment'] = null) =>
  ({ label, stepIds: [], equipment }) as RecipeKitEntryDoc;

const iconFor = (subject: Parameters<KitIconLookup['kitIconFor']>[0]) =>
  get(kitIcons).kitIconFor(subject);

beforeEach(() => {
  mockKitchenTools.set([
    tool('mixing-bowl', 'Mixing bowl', 'https://example.test/bowl.webp', ['bowl']),
    tool('frying-pan', 'Frying pan', 'https://example.test/pan.webp'),
  ]);
  mockEquipment.set(MANIFEST);
  mockEquipmentIcons.set(
    new Map([
      [
        'eq-magimix',
        { thumbnail: 'https://example.test/magimix.webp', iconRequestedAt: 7 } as EquipmentIconDoc,
      ],
      ['eq-pans', { thumbnail: 'https://example.test/pans.webp' } as EquipmentIconDoc],
    ]),
  );
});

describe('kitIcons — the order', () => {
  it('reads the link first, and reaches a family member the words never could', () => {
    // "Tefal non-stick 28cm" shares no word with "Frying Pans", so no rule over
    // the words can find it. Unlinked it draws nothing; linked it is the family's.
    expect(iconFor(entry('Tefal non-stick 28cm'))).toBeNull();
    expect(
      iconFor(entry('Tefal non-stick 28cm', { itemId: 'eq-pans', accessoryId: 'acc-tefal' })),
    ).toBe('https://example.test/pans.webp');
  });

  it('lets the link beat the words, whatever the words would have said', () => {
    // A linked entry never consults the vocabulary, so a label that WOULD have
    // drawn a generic bowl draws the machine it actually belongs to.
    expect(iconFor(entry('large mixing bowl'))).toBe('https://example.test/bowl.webp');
    expect(
      iconFor(entry('large mixing bowl', { itemId: 'eq-magimix', accessoryId: 'acc-thermo' })),
    ).toBe('https://example.test/magimix.webp');
  });

  it('draws nothing rather than a borrowed tool when the linked item has no picture', () => {
    // A resolved thing is authoritative: its own miss degrades to no tile, never
    // to a different object's drawing.
    mockEquipmentIcons.set(new Map([['eq-magimix', { thumbnail: null } as EquipmentIconDoc]]));
    expect(
      iconFor(entry('large mixing bowl', { itemId: 'eq-magimix', accessoryId: 'acc-thermo' })),
    ).toBeNull();
  });

  it('falls back to the words when the link no longer answers to anything', () => {
    expect(iconFor(entry('large mixing bowl', { itemId: 'eq-gone', accessoryId: null }))).toBe(
      'https://example.test/bowl.webp',
    );
  });

  it('draws no tile for a bare accessory name, on a surface with no grouping (#1460)', () => {
    // The method rail and the cook deck hand the raw `kit[]` entry straight to
    // this lookup, with no siblings and no grouping pass — so this answer IS what
    // they render. "Thermo Bowl" used to draw a plain mixing bowl there
    // unconditionally, whether or not the recipe named the Magimix.
    expect(iconFor(entry('Thermo Bowl'))).toBeNull();
    // …and the ordinary label beside it is untouched.
    expect(iconFor(entry('large mixing bowl'))).toBe('https://example.test/bowl.webp');
  });

  it('still answers for a bare label, for the guided-cook cards that have only words', () => {
    expect(iconFor('large mixing bowl')).toBe('https://example.test/bowl.webp');
    expect(iconFor('Thermo Bowl')).toBeNull();
    expect(iconFor(null)).toBeNull();
    expect(iconFor('   ')).toBeNull();
  });

  it('carries the linked item’s cache-bust nonce', () => {
    expect(
      get(kitIcons).kitIconVersionFor(
        entry('the thermo bowl', { itemId: 'eq-magimix', accessoryId: 'acc-thermo' }),
      ),
    ).toBe(7);
  });

  // ─── The entry's own picture (issue #1465, Phase 2) ───────────────────────
  // Four states, and the third is the one nothing else would catch: HIDDEN and
  // NOT-YET-DRAWN are both "no renderable picture on the entry", and they must
  // answer differently — one ends the search, the other falls back.
  it("prefers the entry's own picture to its record's", () => {
    mockEquipmentIcons.update((icons) =>
      new Map(icons).set('acc-tefal', {
        thumbnail: 'https://example.test/tefal.webp',
        iconRequestedAt: 42,
      } as EquipmentIconDoc),
    );
    const linked = entry('Tefal non-stick 28cm', { itemId: 'eq-pans', accessoryId: 'acc-tefal' });
    expect(iconFor(linked)).toBe('https://example.test/tefal.webp');
    expect(get(kitIcons).kitIconVersionFor(linked)).toBe(42);
    // Every other member of the family still shows the family's.
    expect(iconFor(entry('another pan', { itemId: 'eq-pans', accessoryId: null }))).toBe(
      'https://example.test/pans.webp',
    );
  });

  it("falls back to the record's picture for an entry described but not yet drawn", () => {
    mockEquipmentIcons.update((icons) =>
      new Map(icons).set('acc-tefal', { thumbnail: null } as EquipmentIconDoc),
    );
    expect(
      iconFor(entry('Tefal non-stick 28cm', { itemId: 'eq-pans', accessoryId: 'acc-tefal' })),
    ).toBe('https://example.test/pans.webp');
  });

  it("draws nothing for an entry whose picture the user HID, rather than its record's", () => {
    mockEquipmentIcons.update((icons) =>
      new Map(icons).set('acc-tefal', { thumbnail: 'hidden' } as EquipmentIconDoc),
    );
    expect(
      iconFor(entry('Tefal non-stick 28cm', { itemId: 'eq-pans', accessoryId: 'acc-tefal' })),
    ).toBeNull();
    // And the record's own hide is unchanged by any of this.
    expect(iconFor(entry('another pan', { itemId: 'eq-pans', accessoryId: null }))).toBe(
      'https://example.test/pans.webp',
    );
  });

  it('answers from the words alone before the manifest lands', () => {
    // The cold load: no manifest means no link can resolve and no label can be an
    // accessory name, so every answer is the vocabulary's.
    mockEquipment.set(null);
    expect(iconFor(entry('Thermo Bowl'))).toBe('https://example.test/bowl.webp');
    expect(
      iconFor(entry('anything', { itemId: 'eq-magimix', accessoryId: 'acc-thermo' })),
    ).toBeNull();
  });
});
