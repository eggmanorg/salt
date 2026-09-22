import { describe, it, expect, vi, beforeEach } from 'vitest';

// The equipment manifest trigger (issue #877), pinned where issue #1465 Phase 2
// made it dangerous.
//
// index.ts said of this trigger, in as many words, "NOTHING GUARDS THIS: there is
// no test for onEquipmentManifestWritten at all". That was survivable while
// `equipmentIcons` held one document per ITEM, because the reconcile pass's live
// set and the manifest's item list were the same list by construction. Phase 2
// makes an ACCESSORY a legitimate owner of a document in that collection, and the
// pass deletes everything outside the set it is handed — so the set being wrong is
// now a silent, irreversible loss of every entry picture in the kit, triggered by
// any unrelated manifest edit.
//
// Two properties are pinned here, and both are stated as the failure they prevent:
//
//   1. AN ENTRY'S ICON DOCUMENT SURVIVES A MANIFEST WRITE. Break the live set back
//      to `items.map(i => i.id)` and the first case goes red.
//   2. THE BRIEF LOOP NEVER REACHES AN ACCESSORY. Start authoring entry briefs and
//      the second case goes red — ~140 text calls on every manifest save is the
//      failure that one is about, and it is a cost failure, not a correctness one,
//      so nothing else would ever notice.
//
// Mocking follows drawEquipmentIcon.test.ts: the admin SDK and the trigger
// registration are faked, the flow is stubbed (a live text call otherwise), the
// kill switch answers yes, and the entrypoint wrapper is flattened. Everything
// else — `defineSecret`, the logger, the AI-fake gate, the reporting port — is
// the real module, because none of them needs standing in for to reach the two
// properties above.

/** Only `exists`, `data()` and `get(field)` are read off any snapshot here. */
function docSnap(data: Record<string, unknown> | null) {
  return {
    exists: data !== null,
    data: () => data ?? undefined,
    get: (field: string) => (data ?? {})[field],
  };
}

/** Icon documents currently in the collection, by id. Reset per test. */
let iconDocs: string[] = [];
const deleted: string[] = [];
const written: { id: string; data: Record<string, unknown> }[] = [];

const mockIconDoc = vi.fn((id: string) => ({
  get: async () => docSnap(iconDocs.includes(id) ? { briefSourceName: 'stale' } : null),
  set: async (data: Record<string, unknown>) => {
    written.push({ id, data });
  },
}));

const mockSelectGet = vi.fn(async () => ({
  docs: iconDocs.map((id) => ({
    id,
    ref: {
      delete: async () => {
        deleted.push(id);
      },
    },
  })),
}));

// Background-enrichment failure records (issue #1419) — a SECOND collection
// through the same stub, so the collection-blind version above would have made
// a failure record look like an icon document.
const recordedFailures: { id: string; data: Record<string, unknown> }[] = [];
const clearedFailures: string[] = [];
let failureSetThrows = false;
const mockFailureDoc = vi.fn((id: string) => ({
  set: async (data: Record<string, unknown>) => {
    if (failureSetThrows) throw new Error('PERMISSION_DENIED');
    recordedFailures.push({ id, data });
  },
  delete: async () => {
    clearedFailures.push(id);
  },
}));

const mockCollection = vi.fn((name: string) =>
  name === 'enrichmentFailures'
    ? { select: () => ({ get: mockSelectGet }), doc: mockFailureDoc }
    : { select: () => ({ get: mockSelectGet }), doc: mockIconDoc },
);

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: mockCollection }),
}));

// The registration façade: hand back the handler so the test can call it.
vi.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_opts: unknown, handler: unknown) => handler,
}));

const mockDescribe = vi.fn(async ({ name }: { name: string }) => ({
  brief: `a drawing of ${name}`,
}));
vi.mock('../../src/flows/describeEquipmentSubject.js', () => ({
  describeEquipmentSubjectFlow: (input: { name: string }) => mockDescribe(input),
}));

// The kill switch reads `devSettings` through the same Firestore stub as
// everything else here; stubbing it keeps that stub free to answer only the icon
// collection, and whether generation is enabled is not what this file is about.
vi.mock('../../src/triggers/iconWriteTrigger.js', () => ({
  isIconGenerationEnabled: async () => true,
}));

// The entrypoint wrapper is exercised by tests/triggers/entrypointFactory.test.ts;
// here it would only add telemetry readiness and a flush to every case.
vi.mock('../../src/triggers/triggerEntrypoint.js', () => ({
  withFirestoreTrigger:
    (handler: (event: unknown) => unknown) =>
    (event: unknown): unknown =>
      handler(event),
  traceContextFromWrittenDoc: () => undefined,
}));

const { onEquipmentManifestWritten } =
  await import('../../src/triggers/onEquipmentManifestWritten.js');

const ITEM_ID = 'eq-magimix';
const ACCESSORY_ID = 'acc-thermo-bowl';

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    updatedAt: '2026-09-18T00:00:00.000Z',
    items: [
      {
        id: ITEM_ID,
        schemaVersion: 1,
        name: 'Magimix Cook Expert',
        kind: 'equipment',
        rules: [],
        note: '',
        updatedAt: '2026-09-18T00:00:00.000Z',
        accessories: [
          { id: ACCESSORY_ID, name: 'Thermo Bowl', owned: true, included: true, note: '' },
        ],
      },
    ],
  };
}

function run(data: Record<string, unknown> | null) {
  return (onEquipmentManifestWritten as unknown as (event: unknown) => Promise<void>)({
    data: { after: docSnap(data) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  iconDocs = [];
  deleted.length = 0;
  written.length = 0;
  recordedFailures.length = 0;
  clearedFailures.length = 0;
  failureSetThrows = false;
});

describe('onEquipmentManifestWritten — the reconcile pass', () => {
  // THE PIN (CLAUDE.md rule 12). Verified red by narrowing the live set back to
  // the items: the accessory's document is then deleted on a write that had
  // nothing to do with it.
  it("keeps an ENTRY's icon document, which the item-only live set would delete", async () => {
    iconDocs = [ITEM_ID, ACCESSORY_ID];
    await run(manifest());
    expect(deleted).toEqual([]);
  });

  it('still deletes a document whose owner has left the manifest entirely', async () => {
    iconDocs = [ITEM_ID, ACCESSORY_ID, 'eq-sold-the-breadmaker', 'acc-lost-blade'];
    await run(manifest());
    expect(deleted.sort()).toEqual(['acc-lost-blade', 'eq-sold-the-breadmaker']);
  });

  it('deletes an entry document once its entry is removed from the record', async () => {
    iconDocs = [ITEM_ID, ACCESSORY_ID];
    const withoutEntry = manifest();
    (withoutEntry['items'] as { accessories: unknown[] }[])[0]!.accessories = [];
    await run(withoutEntry);
    expect(deleted).toEqual([ACCESSORY_ID]);
  });

  it('reconciles nothing when the manifest document has been deleted outright', async () => {
    iconDocs = [ITEM_ID, ACCESSORY_ID];
    await run(null);
    expect(deleted).toEqual([]);
  });
});

describe('onEquipmentManifestWritten — the brief loop', () => {
  // THE SECOND PIN. ~140 entries would be ~140 'fast'-tier text calls on every
  // manifest save, for descriptions nobody asked for. Nothing but this notices:
  // the writes are valid, the trigger is green, and the only symptom is a bill.
  it('authors a brief for the ITEM and never for its entries', async () => {
    await run(manifest());
    expect(mockDescribe).toHaveBeenCalledTimes(1);
    expect(mockDescribe).toHaveBeenCalledWith({ name: 'Magimix Cook Expert' });
    expect(written.map((w) => w.id)).toEqual([ITEM_ID]);
  });
});

// A brief that gives up says so (issue #1419). This branch is the one where the
// failure was most completely invisible: on the other eight, something on the
// enriched document is at least left unstamped, but here the
// `equipmentIcons/{itemId}` document is never created at all — and both
// `drawEquipmentIcon` and `setIconUpload` bail on `!snap.exists`, so there was
// no handle to retry from either.
describe('onEquipmentManifestWritten — the failure record', () => {
  it('records a brief that gave up, and clears it when the next one lands', async () => {
    mockDescribe.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    await run(manifest());
    expect(recordedFailures).toEqual([
      {
        id: `equipmentBrief_${ITEM_ID}`,
        data: expect.objectContaining({
          enrichment: 'equipmentBrief',
          subjectId: ITEM_ID,
          subjectLabel: 'Magimix Cook Expert',
          reason: 'upstream',
        }),
      },
    ]);

    recordedFailures.length = 0;
    await run(manifest());
    expect(recordedFailures).toEqual([]);
    expect(clearedFailures).toEqual([`equipmentBrief_${ITEM_ID}`]);
  });

  // THE PIN THAT MATTERS HERE, and the reason this property is asserted on THIS
  // trigger rather than on `onRecipeWritten`. The brief loop is SEQUENTIAL and
  // has no `Promise.allSettled` to absorb a throw: if recording a failure could
  // reject, one unwritable record would abandon the loop and every later item in
  // the manifest would silently lose its description too. Verified red by
  // removing the inner catch from `recordEnrichmentFailure`.
  it('a record that cannot be written does not abandon the rest of the manifest', async () => {
    failureSetThrows = true;
    mockDescribe.mockRejectedValueOnce(new Error('boom'));

    const two = manifest();
    (two['items'] as Record<string, unknown>[]).push({
      id: 'eq-thermapen',
      schemaVersion: 1,
      name: 'Thermapen',
      kind: 'equipment',
      rules: [],
      note: '',
      updatedAt: '2026-09-18T00:00:00.000Z',
      accessories: [],
    });

    await expect(run(two)).resolves.toBeUndefined();
    // The SECOND item's brief was still authored and still written.
    expect(mockDescribe).toHaveBeenCalledWith({ name: 'Thermapen' });
    expect(written.map((w) => w.id)).toEqual(['eq-thermapen']);
  });
});
