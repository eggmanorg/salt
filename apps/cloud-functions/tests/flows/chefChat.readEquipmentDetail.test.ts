/**
 * The chef's look-up-the-kit tool (issue #1373) — the third, and the one the
 * "TWO tools, and the whole surface" comment required a new issue for.
 *
 * Four claims, each pinned rather than asserted:
 *
 *  1. THE WARNING MOVED, IT WAS NOT LOST. Decision 8 stops sending the household
 *     a roll-call of what it does not own — 28 entries across the live manifest —
 *     on every call to five AI flows. That is only defensible because the chef
 *     still gets it, marked, the moment it looks an item up. Pinned directly: an
 *     unowned accessory comes back flagged.
 *  2. A MISS, NEVER A GUESS. Name resolution is `resolveEquipmentItem`'s, so a
 *     name matching nothing — or matching two records equally — is `found: false`
 *     rather than one of them picked at random.
 *  3. IT CANNOT WRITE, AND NOTHING NEXT TO IT CAN EITHER. "No, and not ever" is
 *     a comment at the declaration, and a comment guarantees nothing; this is the
 *     mechanical half. The tool list is enumerated and asserted to contain no
 *     equipment writer, so a helpfully-added sibling goes red here.
 *  4. THE DESCRIPTION STILL CARRIES ITS "WHEN NOT TO CALL" CLAUSE and still tells
 *     the model it cannot change anything. Prompt text is falsifiable only by
 *     content assertion.
 */
import { describe, it, expect, vi } from 'vitest';
import { logger } from 'firebase-functions';

vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

const defineToolCalls: { name: string; description: string }[] = [];
vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    defineTool: (config: { name: string; description: string }, handler: unknown) => {
      defineToolCalls.push(config);
      return { __tool: config.name, handler };
    },
    generateStream: vi.fn(),
  },
}));
vi.mock('../../src/ai/fakeModel.js', () => ({ flowModel: vi.fn(async () => 'fake-model') }));
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));
vi.mock('../../src/observability/reportServerError.js', () => ({
  reportFlowError: vi.fn(async () => undefined),
}));
// The manifest the tool sees when it is called through its own declaration
// rather than through the exported handler — the wiring test at the bottom is
// the only thing that reads this, and it is what makes the one-line thunk in
// `ai.defineTool` a tested line rather than an assumed one.
const { liveManifest } = vi.hoisted(() => ({
  liveManifest: { items: [] as unknown[] },
}));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: () => ({
      doc: () => ({
        get: () =>
          Promise.resolve({
            exists: true,
            data: () => ({
              schemaVersion: 1,
              updatedAt: '2026-09-14T00:00:00.000Z',
              items: liveManifest.items,
            }),
          }),
      }),
    }),
  }),
}));

const { readEquipmentDetailForChef, readEquipmentDetailTool } =
  await import('../../src/flows/chefChat.js');

// ─── Firestore stub ───────────────────────────────────────────────────────────

function accessory(name: string, owned: boolean, note = '') {
  return { id: `acc-${name}`, name, owned, included: false, note };
}

function item(
  name: string,
  opts: {
    kind?: 'equipment' | 'family';
    accessories?: ReturnType<typeof accessory>[];
    rules?: string[];
    note?: string;
  } = {},
) {
  return {
    id: `eq-${name}`,
    schemaVersion: 1 as const,
    name,
    kind: opts.kind ?? ('equipment' as const),
    accessories: opts.accessories ?? [],
    rules: opts.rules ?? [],
    note: opts.note ?? '',
    environment: null,
    updatedAt: '2026-09-14T00:00:00.000Z',
  };
}

/** A Firestore stub whose equipmentManifest/current holds `items`. */
function dbWith(items: ReturnType<typeof item>[]): never {
  return {
    collection: () => ({
      doc: () => ({
        get: () =>
          Promise.resolve({
            exists: true,
            data: () => ({ schemaVersion: 1, updatedAt: '2026-09-14T00:00:00.000Z', items }),
          }),
      }),
    }),
  } as never;
}

const MAGIMIX = item('Magimix Cook Expert', {
  accessories: [
    accessory('Thermo Bowl', true, 'the seal is perished'),
    accessory('XL Steamer Attachment', false),
  ],
  rules: ['has the upgraded firmware'],
  note: 'on a high shelf and takes ages to wash',
});

const PANS = item('Frying pans', {
  kind: 'family',
  accessories: [
    accessory('28cm cast iron', true, 'the only one that goes in the oven'),
    accessory('20cm non-stick', true, 'never sear in this'),
  ],
  note: 'the cast iron lives in the bottom drawer',
});

describe('readEquipmentDetailForChef', () => {
  it("gives back an ordinary item's accessory notes, its own note and its rules", async () => {
    const out = await readEquipmentDetailForChef(dbWith([MAGIMIX]), {
      name: 'Magimix Cook Expert',
    });
    expect(out.found).toBe(true);
    expect(out.detail).toContain('the seal is perished');
    expect(out.detail).toContain('on a high shelf and takes ages to wash');
    expect(out.detail).toContain('has the upgraded firmware');
  });

  it("gives back a family's entry notes", async () => {
    const out = await readEquipmentDetailForChef(dbWith([PANS]), { name: 'Frying pans' });
    expect(out.found).toBe(true);
    expect(out.detail).toContain('the only one that goes in the oven');
    expect(out.detail).toContain('never sear in this');
    expect(out.detail).toContain('the cast iron lives in the bottom drawer');
  });

  // CLAIM 1. If this goes red, decision 8 has quietly become a loss: the chef is
  // told neither ambiently nor on request what the household does not have.
  it('reports an unowned accessory, marked — the warning the prompt stopped carrying', async () => {
    const out = await readEquipmentDetailForChef(dbWith([MAGIMIX]), {
      name: 'Magimix Cook Expert',
    });
    expect(out.detail).toContain('XL Steamer Attachment');
    expect(out.detail).toContain('NOT OWNED');
  });

  // CLAIM 2.
  it('returns found: false for a name nothing answers to', async () => {
    const out = await readEquipmentDetailForChef(dbWith([MAGIMIX, PANS]), { name: 'Thermomix' });
    expect(out).toEqual({ found: false, detail: null });
  });

  it('returns found: false rather than guessing between two records that both fit', async () => {
    const out = await readEquipmentDetailForChef(
      dbWith([item('Kenwood Chef'), item('Kenwood MultiPro')]),
      { name: 'Kenwood' },
    );
    expect(out).toEqual({ found: false, detail: null });
  });

  it('degrades to found: false when the manifest cannot be read, never throwing', async () => {
    const brokenDb = {
      collection: () => ({
        doc: () => ({ get: () => Promise.reject(new Error('firestore down')) }),
      }),
    } as never;
    await expect(
      readEquipmentDetailForChef(brokenDb, { name: 'Magimix Cook Expert' }),
    ).resolves.toEqual({ found: false, detail: null });
  });
});

// ─── The read-only guarantee, made mechanical ────────────────────────────────

describe('the chef cannot write equipment', () => {
  // CLAIM 3. "No, and not ever" is a sentence in a comment, and a sentence
  // guarantees nothing on its own — this is what makes it checkable. It asserts
  // the WHOLE tool list rather than the absence of one name, because a writer
  // could arrive called anything: `saveEquipment`, `addPan`, `updateKit`.
  it('declares exactly these three tools, and none of them writes', () => {
    expect(defineToolCalls.map((c) => c.name)).toEqual([
      'findRecipes',
      'readRecipe',
      'readEquipmentDetail',
    ]);
    expect(readEquipmentDetailTool).toMatchObject({ __tool: 'readEquipmentDetail' });
  });

  it('tells the model in so many words that it cannot change the kitchen', () => {
    const description =
      defineToolCalls.find((c) => c.name === 'readEquipmentDetail')?.description ?? '';
    expect(description).toContain('You cannot change anything here');
    expect(description).toMatch(/theirs to edit in the app/i);
  });

  it('tells the model when NOT to call it', () => {
    const description =
      defineToolCalls.find((c) => c.name === 'readEquipmentDetail')?.description ?? '';
    expect(description).toContain('DO NOT CALL IT');
  });

  it('tells the model that a NOT OWNED entry is never to be proposed', () => {
    const description =
      defineToolCalls.find((c) => c.name === 'readEquipmentDetail')?.description ?? '';
    expect(description).toContain('NOT OWNED');
    expect(description).toMatch(/never propose it/i);
  });

  // The declaration is wired to the handler and to the live Firestore, which is
  // the one thing asserting the handler directly cannot show: a tool declared
  // against the wrong function, or against no Firestore, would pass every test
  // above and answer nothing in production.
  it('answers through its own declaration, reading the live manifest', async () => {
    liveManifest.items = [MAGIMIX];
    const tool = readEquipmentDetailTool as unknown as {
      handler: (input: { name: string }) => Promise<{ found: boolean; detail: string | null }>;
    };
    const out = await tool.handler({ name: 'Magimix Cook Expert' });
    expect(out.found).toBe(true);
    expect(out.detail).toContain('on a high shelf and takes ages to wash');
    liveManifest.items = [];
  });
});
