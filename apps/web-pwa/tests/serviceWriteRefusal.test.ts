import { describe, it, expect, beforeEach, afterEach, vi, type Mocked } from 'vitest';
import type { Aisle, CanonItem, EquipmentManifest, ProductForm } from '@salt/domain';
import type { KitchenToolDoc } from '@salt/domain/schemas';
import {
  failure,
  success,
  type DomainError,
  type ReadResult,
  type Result,
} from '@salt/shared-types';

/**
 * The refused-write contract (#931), one table over every service command that
 * gained one.
 *
 * WHAT THIS PINS. Six adapter writers stopped throwing raw Firestore errors past
 * the boundary and started answering `Failure<DomainError>` (Rule 10). The half
 * of that change which lives in `apps/web-pwa/src/lib` is that a command whose
 * DOMAIN step succeeded must still answer `err` when the document never landed —
 * previously the write outcome was discarded and the caller was told `ok` over a
 * write that never happened. That is a behaviour, not a wiring detail: the row
 * asserts the returned `kind` and the `DomainError` that came back, never that a
 * mock was called (UT-A1).
 *
 * WHY A TABLE. Twenty-two commands across five services differ only in which
 * writer they go through and what they hand back; twenty-two copied bodies would
 * be the same defect one level up (UT-D1). Each row names itself (UT-D2), and
 * every row runs BOTH halves — `ok` when the write lands, `err` when it is
 * refused — because only the pair proves the `err` came from the write rather
 * than from the command refusing on its own.
 *
 * THE SEAM. `@salt/firebase-sync` is the adapter boundary the architecture
 * already defines (UT-B3), and `@salt/observability` is mocked because these
 * services construct a real PostHog reporting adapter at first use. Two mocks,
 * both at a declared seam (UT-B1).
 */

vi.mock('@salt/firebase-sync', () => ({
  // Subscriptions — wired per test by `wire()`; the stores under test are fed
  // through them rather than by reaching into module internals.
  subscribeCanonItems: vi.fn(),
  subscribeAisles: vi.fn(),
  subscribeEquipmentManifest: vi.fn(),
  subscribeEquipmentIcons: vi.fn(() => () => {}),
  subscribeKitchenTools: vi.fn(),
  subscribeProductForms: vi.fn(),
  // Writers — the subject.
  upsertCanonItem: vi.fn(),
  saveAisles: vi.fn(),
  saveEquipmentManifest: vi.fn(),
  upsertKitchenTool: vi.fn(),
  upsertProductForm: vi.fn(),
  // Everything else the five services import, defaulted so nothing under test
  // reaches a real network path.
  deleteCanonItem: vi.fn(),
  deleteKitchenTool: vi.fn(),
  deleteProductForm: vi.fn(),
  loadCanonPurchaseCounts: vi
    .fn()
    .mockResolvedValue({ kind: 'ok', value: { counts: {}, lastAt: {} } }),
  callMatchOrCreate: vi.fn(),
  callRegenerateCanonIcon: vi.fn(),
  callRegenerateProductFormIcon: vi.fn(),
  callIdentifyEquipment: vi.fn(),
  callPopulateEquipmentEntry: vi.fn(),
  callDrawEquipmentIcon: vi.fn(),
  callDescribeEquipmentSubject: vi.fn(),
  isAuthTransitioning: vi.fn(() => false),
}));

vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
  createObservabilityMatchLoggingAdapter: vi.fn(() => ({
    write: vi.fn().mockResolvedValue(undefined),
  })),
  startSpan: vi.fn(() => ({ setAttribute: vi.fn(), end: vi.fn() })),
}));

import * as firebaseSync from '@salt/firebase-sync';

import {
  addAisle,
  addAislesBulk,
  renameAisle,
  reorderAisles,
  deleteAisles,
  mergeAisles,
} from '../src/lib/aisleService.js';
import {
  addCanonItem,
  approveCanonItemWithOverrides,
  approveCanonItems,
  initCanonSync,
  splitMostRecentSynonym,
  updateCanonItemAisle,
  updateCanonItemName,
  updateCanonItemShoppingBehavior,
  updateCanonItemSynonyms,
  updateCanonItemThreshold,
  __resetCanonServiceForTest,
} from '../src/lib/canonService.js';
import {
  addEquipmentItem,
  captureEquipmentItem,
  initEquipmentSync,
  removeEquipmentItems,
  renameEquipmentItem,
  seedEquipmentManifest,
  __resetEquipmentServiceForTest,
} from '../src/lib/equipmentService.js';
import {
  addKitchenTool,
  editKitchenTool,
  hideKitchenToolIcon,
  initKitchenToolSync,
  regenerateKitchenToolIcon,
  removeKitchenToolMatcher,
  __resetKitchenToolServiceForTest,
} from '../src/lib/kitchenToolService.js';
import {
  addProductForm,
  confirmProductForm,
  editProductForm,
  hideProductFormIcon,
  initProductFormSync,
  __resetProductFormServiceForTest,
} from '../src/lib/productFormService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

/** The refusal every row is handed. A StorageError is the reportable category, so
 *  a row that accidentally swallowed the failure would also lose the §7.6 report. */
const REFUSED: DomainError = { kind: 'StorageError', reason: 'unavailable' };

// ─── Fixtures ───────────────────────────────────────────────────────────────────

const NOW = '2026-08-24T00:00:00.000Z';

function makeItem(id: string, overrides: Partial<CanonItem> = {}): CanonItem {
  return {
    id,
    schemaVersion: 5,
    name: id,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAisle(id: string, name: string, order = 0): Aisle {
  return { id, name, order };
}

function makeTool(id: string, label: string): KitchenToolDoc {
  return {
    id,
    schemaVersion: 1,
    label,
    matchers: [label],
    thumbnail: 'https://example.test/tool.webp',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeForm(overrides: Partial<ProductForm> = {}): ProductForm {
  return {
    id: 'f1',
    schemaVersion: 1,
    matchers: ['lime juice'],
    parentCanonId: 'c-lime',
    label: 'Lime juice',
    yield: { formUnit: 'ml', amountPerParent: 30 },
    // Stated, never omitted: `upsertProductForm` writes the whole document and
    // Firestore rejects `undefined` (see the entity's own note).
    thumbnail: null,
    updatedAt: NOW,
    ...overrides,
  };
}

/** The full edit payload both product-form update commands re-validate. */
const FORM_EDIT = {
  matchers: ['lime juice', 'fresh lime juice'],
  parentCanonId: 'c-lime',
  label: 'Lime juice, fresh',
  formUnit: 'ml' as const,
  amountPerParent: 30,
};

function makeManifest(items: EquipmentManifest['items'] = []): EquipmentManifest {
  return { schemaVersion: 1, updatedAt: NOW, items };
}

// ─── Harness ────────────────────────────────────────────────────────────────────

/**
 * Feed every store under test through its own subscription, the way the running
 * app does. A row that needs an aisle, a canon item, a tool or a manifest states
 * it in `seed`; nothing here writes module state directly.
 */
function wire(): {
  canon: (items: CanonItem[]) => void;
  aisles: (list: Aisle[]) => void;
  equipment: (manifest: EquipmentManifest | null) => void;
  tools: (list: KitchenToolDoc[]) => void;
  forms: (list: ProductForm[]) => void;
} {
  const emit = <T>(mock: {
    mockImplementation: (fn: (on: (v: T) => void) => () => void) => void;
  }) => {
    let cb: ((v: T) => void) | null = null;
    mock.mockImplementation((on: (v: T) => void) => {
      cb = on;
      return () => {};
    });
    return (v: T) => cb?.(v);
  };

  const canon = emit<CanonItem[]>(fs.subscribeCanonItems as never);
  const aisles = emit<Aisle[]>(fs.subscribeAisles as never);
  const equipment = emit<EquipmentManifest | null>(fs.subscribeEquipmentManifest as never);
  const tools = emit<KitchenToolDoc[]>(fs.subscribeKitchenTools as never);
  const forms = emit<ProductForm[]>(fs.subscribeProductForms as never);

  initCanonSync();
  initEquipmentSync();
  initKitchenToolSync();
  initProductFormSync();

  return { canon, aisles, equipment, tools, forms };
}

type Wired = ReturnType<typeof wire>;

/** The writers a row may refuse, by the name the mock is registered under. */
type Writer =
  | 'upsertCanonItem'
  | 'saveAisles'
  | 'saveEquipmentManifest'
  | 'upsertKitchenTool'
  | 'upsertProductForm';

const WRITERS: Record<Writer, () => Mocked<typeof firebaseSync>[Writer]> = {
  upsertCanonItem: () => fs.upsertCanonItem,
  saveAisles: () => fs.saveAisles,
  saveEquipmentManifest: () => fs.saveEquipmentManifest,
  upsertKitchenTool: () => fs.upsertKitchenTool,
  upsertProductForm: () => fs.upsertProductForm,
};

interface Row {
  /** `<service>.<command>` — what a failing row names. */
  readonly name: string;
  /** The adapter writer this command's persistence goes through. */
  readonly writer: Writer;
  /** Store state the command needs, delivered through the subscriptions. */
  readonly seed?: (w: Wired) => void;
  // `Result` as well as `ReadResult`: the canon and product-form commands are
  // WRITE results, whose union carries a third `conflict` arm.
  readonly run: () => Promise<Result<unknown, DomainError> | ReadResult<unknown, DomainError>>;
}

const rows: Row[] = [
  // ─── aisleService ─────────────────────────────────────────────────────────
  {
    name: 'aisleService.addAisle',
    writer: 'saveAisles',
    run: () => addAisle('Produce'),
  },
  {
    name: 'aisleService.addAislesBulk',
    writer: 'saveAisles',
    run: () => addAislesBulk(['Produce', 'Dairy']),
  },
  {
    name: 'aisleService.renameAisle',
    writer: 'saveAisles',
    seed: (w) => w.aisles([makeAisle('a1', 'Produce')]),
    run: () => renameAisle('a1', 'Fruit & veg'),
  },
  {
    name: 'aisleService.reorderAisles',
    writer: 'saveAisles',
    seed: (w) => w.aisles([makeAisle('a1', 'Produce', 0), makeAisle('a2', 'Dairy', 1)]),
    run: () => reorderAisles(['a2', 'a1']),
  },
  {
    name: 'aisleService.deleteAisles',
    writer: 'saveAisles',
    seed: (w) => {
      w.aisles([makeAisle('a1', 'Produce')]);
      w.canon([makeItem('c1', { aisleId: 'a1' })]);
    },
    run: () => deleteAisles(['a1']),
  },
  {
    // The canon half of the same fan-out: the aisle write lands and the canon
    // re-point is refused, which the sibling row above cannot distinguish.
    name: 'aisleService.deleteAisles (canon re-point refused)',
    writer: 'upsertCanonItem',
    seed: (w) => {
      w.aisles([makeAisle('a1', 'Produce')]);
      w.canon([makeItem('c1', { aisleId: 'a1' })]);
    },
    run: () => deleteAisles(['a1']),
  },
  {
    name: 'aisleService.mergeAisles',
    writer: 'saveAisles',
    seed: (w) => {
      w.aisles([makeAisle('a1', 'Produce', 0), makeAisle('a2', 'Fruit', 1)]);
      w.canon([makeItem('c1', { aisleId: 'a2' })]);
    },
    run: () => mergeAisles({ sourceIds: ['a2'], targetId: 'a1', perItemChoices: [] }),
  },

  // ─── canonService ─────────────────────────────────────────────────────────
  {
    // The fast path: a stage 1-4 hit that appends a synonym writes the item
    // itself, without ever reaching the callable.
    name: 'canonService.addCanonItem (fast-path synonym append)',
    writer: 'upsertCanonItem',
    seed: (w) => w.canon([makeItem('c1', { name: 'Carrot' })]),
    run: () => addCanonItem('carrott'),
  },
  {
    name: 'canonService.updateCanonItemName',
    writer: 'upsertCanonItem',
    run: () => updateCanonItemName(makeItem('c1', { name: 'Carrot' }), 'Carrots'),
  },
  {
    name: 'canonService.updateCanonItemAisle',
    writer: 'upsertCanonItem',
    seed: (w) => w.aisles([makeAisle('a1', 'Produce')]),
    run: () => updateCanonItemAisle(makeItem('c1', { name: 'Carrot' }), 'a1'),
  },
  {
    name: 'canonService.updateCanonItemSynonyms',
    writer: 'upsertCanonItem',
    run: () => updateCanonItemSynonyms(makeItem('c1', { name: 'Carrot' }), ['baby carrot']),
  },
  {
    name: 'canonService.updateCanonItemShoppingBehavior',
    writer: 'upsertCanonItem',
    run: () => updateCanonItemShoppingBehavior(makeItem('c1', { name: 'Carrot' }), 'stocked'),
  },
  {
    name: 'canonService.updateCanonItemThreshold',
    writer: 'upsertCanonItem',
    run: () => updateCanonItemThreshold(makeItem('c1', { name: 'Carrot' }), 500, 'g'),
  },
  {
    name: 'canonService.approveCanonItemWithOverrides',
    writer: 'upsertCanonItem',
    run: () =>
      approveCanonItemWithOverrides(makeItem('c1', { name: 'Carrot', needs_approval: true })),
  },
  {
    name: 'canonService.approveCanonItems',
    writer: 'upsertCanonItem',
    seed: (w) => w.canon([makeItem('c1', { name: 'Carrot', needs_approval: true })]),
    run: () => approveCanonItems(['c1']),
  },
  {
    name: 'canonService.splitMostRecentSynonym',
    writer: 'upsertCanonItem',
    seed: (w) => w.canon([makeItem('c1', { name: 'Carrot', synonyms: ['parsnip'] })]),
    run: () => splitMostRecentSynonym(makeItem('c1', { name: 'Carrot', synonyms: ['parsnip'] })),
  },

  // ─── equipmentService ─────────────────────────────────────────────────────
  {
    name: 'equipmentService.addEquipmentItem',
    writer: 'saveEquipmentManifest',
    seed: (w) => w.equipment(makeManifest()),
    run: () => addEquipmentItem('Stand mixer'),
  },
  {
    name: 'equipmentService.renameEquipmentItem',
    writer: 'saveEquipmentManifest',
    seed: (w) => w.equipment(makeManifest()),
    run: async () => {
      const added = await addEquipmentItem('Stand mixer');
      if (added.kind !== 'ok') return added;
      const id = added.value.items[added.value.items.length - 1]!.id;
      return renameEquipmentItem(id, 'Mixer');
    },
  },
  {
    name: 'equipmentService.removeEquipmentItems',
    writer: 'saveEquipmentManifest',
    seed: (w) => w.equipment(makeManifest()),
    run: async () => {
      const added = await addEquipmentItem('Stand mixer');
      if (added.kind !== 'ok') return added;
      const id = added.value.items[added.value.items.length - 1]!.id;
      return removeEquipmentItems([id]);
    },
  },
  {
    name: 'equipmentService.captureEquipmentItem',
    writer: 'saveEquipmentManifest',
    seed: (w) => w.equipment(makeManifest()),
    run: () =>
      captureEquipmentItem('Stand mixer', [{ name: 'Dough hook', owned: true, included: true }]),
  },
  {
    name: 'equipmentService.seedEquipmentManifest',
    writer: 'saveEquipmentManifest',
    run: () => seedEquipmentManifest(makeManifest()),
  },

  // ─── kitchenToolService ───────────────────────────────────────────────────
  {
    name: 'kitchenToolService.addKitchenTool',
    writer: 'upsertKitchenTool',
    run: () => addKitchenTool({ label: 'Mandoline', matchers: ['mandoline'] }),
  },
  {
    name: 'kitchenToolService.editKitchenTool',
    writer: 'upsertKitchenTool',
    run: () =>
      editKitchenTool(makeTool('t1', 'Mandoline'), {
        label: 'Mandoline',
        matchers: ['mandoline', 'slicer'],
      }),
  },
  {
    name: 'kitchenToolService.removeKitchenToolMatcher',
    writer: 'upsertKitchenTool',
    run: () => removeKitchenToolMatcher(makeTool('t1', 'Mandoline'), 'slicer'),
  },
  {
    name: 'kitchenToolService.regenerateKitchenToolIcon',
    writer: 'upsertKitchenTool',
    seed: (w) => w.tools([makeTool('t1', 'Mandoline')]),
    run: () => regenerateKitchenToolIcon('t1'),
  },
  {
    name: 'kitchenToolService.hideKitchenToolIcon',
    writer: 'upsertKitchenTool',
    run: () => hideKitchenToolIcon(makeTool('t1', 'Mandoline')),
  },

  // ─── productFormService ───────────────────────────────────────────────────
  {
    name: 'productFormService.addProductForm',
    writer: 'upsertProductForm',
    run: () =>
      addProductForm({
        matchers: ['lime juice'],
        parentCanonId: 'c-lime',
        label: 'Lime juice',
        formUnit: 'ml',
        amountPerParent: 30,
      }),
  },
  {
    name: 'productFormService.editProductForm',
    writer: 'upsertProductForm',
    run: () => editProductForm(makeForm(), FORM_EDIT),
  },
  {
    name: 'productFormService.confirmProductForm',
    writer: 'upsertProductForm',
    run: () => confirmProductForm(makeForm({ needs_approval: true }), FORM_EDIT),
  },
  {
    name: 'productFormService.hideProductFormIcon',
    writer: 'upsertProductForm',
    run: () => hideProductFormIcon(makeForm()),
  },
];

function resetAll(): void {
  __resetCanonServiceForTest();
  __resetEquipmentServiceForTest();
  __resetKitchenToolServiceForTest();
  __resetProductFormServiceForTest();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAll();
  for (const make of Object.values(WRITERS)) {
    (make() as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(
      success(undefined),
    );
  }
});

afterEach(() => {
  resetAll();
});

describe.each(rows)('$name', (row) => {
  it('answers ok when the write lands', async () => {
    const wired = wire();
    row.seed?.(wired);

    const result = await row.run();

    expect(result.kind).toBe('ok');
  });

  it('answers err with the writer’s DomainError when the write is refused', async () => {
    const wired = wire();
    row.seed?.(wired);
    (
      WRITERS[row.writer]() as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue(failure(REFUSED));

    const result = await row.run();

    // The command's domain step still succeeded — what changed is that the
    // refused write is no longer discarded. Both halves matter: `err`, and the
    // adapter's own categorised error rather than one invented on the way out.
    expect(result.kind).toBe('err');
    expect(result.kind === 'err' && result.error).toEqual(REFUSED);
  });
});
