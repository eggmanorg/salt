/**
 * The chef's `writeKitchenNote` tool (issue #1377, phase 2).
 *
 * These are the Rule 12 obligations, not optional coverage. The phase claims four
 * safety properties, and each is pinned by something that goes red when it breaks:
 *
 *  1. THE TOOL CANNOT DELETE A NOTE. Not "does not today" — there is no delete
 *     path in the whole flow module, and the scan at the bottom of this file is
 *     what says so. The Firestore stub has no delete method to call either, so a
 *     handler that reached for one would throw rather than quietly pass.
 *  2. EVERY REPLACEMENT GOES THROUGH `pushRevision`. The version that was
 *     replaced comes back in `revisions[0]`, and the cap still holds — asserted
 *     against a page already sitting at the cap.
 *  3. IT WRITES TO `libraryPages` AND NOWHERE ELSE. The stub throws for any other
 *     collection name, so a stray write is an exception and not a silent pass.
 *  4. NO UID IS EVER WRITTEN INTO A DOCUMENT. The audit fields are display names,
 *     and the whole written document is asserted field by field.
 *
 * The gate — that a household member outside the `library` flag cannot cause a
 * note to be written at all, because the tool is not in their request's array —
 * is pinned in `chefChat.kitchenNotes.test.ts`, where the gate itself lives.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from 'firebase-functions';
import {
  LIBRARY_PAGE_BODY_MAX,
  LIBRARY_PAGE_REVISION_CAP,
  LIBRARY_PAGE_TITLE_MAX,
} from '@salt/domain/schemas';

// A SPY on the real logger rather than a fifth `vi.mock` for it — the four below
// are the architectural seams this file cannot import for real.
const mockWarn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

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
vi.mock('../../src/adapters/withAiTimeout.js', () => ({
  AI_TEXT_FLOW_TIMEOUT: { timeoutMs: 55_000, retries: 0 },
  withAiTimeout: (_flow: string, fn: () => Promise<unknown>) => fn(),
  withAiStreamTimeout: (_flow: string, stream: AsyncIterable<unknown>) => stream,
}));

const mockGetFirestore = vi.fn();
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => mockGetFirestore() }));

const { writeKitchenNoteForChef, writeKitchenNoteTool } =
  await import('../../src/flows/chefChat.js');

beforeEach(() => {
  mockWarn.mockClear();
});

// ─── A Firestore that records writes and cannot delete ───────────────────────

interface Written {
  readonly id: string;
  readonly doc: Record<string, unknown>;
}

function pageDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p-jars',
    schemaVersion: 1,
    kind: 'note',
    title: 'The Weck jars',
    body: 'A tapered 1 L jar.',
    tags: ['storage'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    createdBy: 'Daniel',
    lastEditedBy: 'Daniel',
    revisions: [],
    ...over,
  };
}

/**
 * A db holding `libraryPages` and nothing else, whose documents can be read and
 * `set`, and CANNOT be deleted or updated in place — there is no method for it.
 */
function dbWith(stored: Record<string, Record<string, unknown>>): {
  db: never;
  writes: Written[];
} {
  const writes: Written[] = [];
  const db = {
    collection: (name: string) => {
      if (name !== 'libraryPages') throw new Error(`unexpected collection ${name}`);
      return {
        doc: (id: string) => ({
          get: () =>
            Promise.resolve({
              exists: stored[id] !== undefined,
              id,
              data: () => stored[id],
            }),
          set: (doc: Record<string, unknown>) => {
            writes.push({ id, doc });
            return Promise.resolve();
          },
        }),
      };
    },
  };
  return { db: db as never, writes };
}

// ─── Creating ─────────────────────────────────────────────────────────────────

describe('writeKitchenNote — a new note', () => {
  it('writes a schema-valid document, attributed to a NAME and never a uid', async () => {
    const { db, writes } = dbWith({});

    const result = await writeKitchenNoteForChef(db, {
      title: '  My Weck jars  ',
      body: '| Jar | Capacity |\n| --- | --- |\n| Tapered | 1 L |',
    });

    expect(result).toEqual({ saved: true, id: expect.any(String), created: true, problem: null });
    expect(writes).toHaveLength(1);
    const written = writes[0]!;
    expect(written.id).toBe(result.id);
    expect(written.doc).toEqual({
      id: result.id,
      schemaVersion: 1,
      kind: 'note',
      title: 'My Weck jars',
      body: '| Jar | Capacity |\n| --- | --- |\n| Tapered | 1 L |',
      tags: [],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      createdBy: 'The chef',
      lastEditedBy: 'The chef',
      revisions: [],
    });
    // The audit fields are display names. Nothing uid-shaped may reach the
    // document, from any field.
    expect(JSON.stringify(written.doc)).not.toMatch(/uid/i);
  });

  it('mints a fresh id per note rather than reusing one', async () => {
    const { db, writes } = dbWith({});
    await writeKitchenNoteForChef(db, { title: 'One', body: 'a' });
    await writeKitchenNoteForChef(db, { title: 'Two', body: 'b' });

    expect(writes[0]!.id).not.toBe(writes[1]!.id);
  });
});

// ─── Replacing ────────────────────────────────────────────────────────────────

describe('writeKitchenNote — replacing a note', () => {
  it('files the version it replaced, so a bad write is restorable', async () => {
    const { db, writes } = dbWith({ 'p-jars': pageDoc() });

    const result = await writeKitchenNoteForChef(db, {
      id: 'p-jars',
      title: 'The Weck jars',
      body: 'A tapered 1 L jar and a 580 ml tulip.',
    });

    expect(result).toMatchObject({ saved: true, id: 'p-jars', created: false });
    expect(writes[0]!.doc).toMatchObject({
      body: 'A tapered 1 L jar and a 580 ml tulip.',
      lastEditedBy: 'The chef',
      // Created-by is the household's, untouched: replacing a note does not make
      // the chef its author.
      createdBy: 'Daniel',
      createdAt: '2026-01-01T00:00:00.000Z',
      revisions: [
        {
          title: 'The Weck jars',
          body: 'A tapered 1 L jar.',
          savedAt: expect.any(String),
          savedBy: 'The chef',
        },
      ],
    });
  });

  it('keeps the revision cap when the history is already full', async () => {
    // `pushRevision` is the only thing that grows the array, which is what makes
    // the cap a bound rather than an intention — this is that bound, exercised
    // through the tool.
    const full = Array.from({ length: LIBRARY_PAGE_REVISION_CAP }, (_, i) => ({
      title: `v${i}`,
      body: `body ${i}`,
      savedAt: '2026-01-01T00:00:00.000Z',
      savedBy: 'Daniel',
    }));
    const { db, writes } = dbWith({ 'p-jars': pageDoc({ revisions: full }) });

    await writeKitchenNoteForChef(db, { id: 'p-jars', title: 'The Weck jars', body: 'newer' });

    const revisions = (writes[0]!.doc as { revisions: { body: string }[] }).revisions;
    expect(revisions).toHaveLength(LIBRARY_PAGE_REVISION_CAP);
    expect(revisions[0]).toMatchObject({ body: 'A tapered 1 L jar.' });
    expect(revisions.at(-1)).toMatchObject({ body: `body ${LIBRARY_PAGE_REVISION_CAP - 2}` });
  });

  it('leaves the collection untouched when the id names nothing', async () => {
    const { db, writes } = dbWith({});

    await expect(
      writeKitchenNoteForChef(db, { id: 'p-guessed', title: 'x', body: 'y' }),
    ).resolves.toMatchObject({ saved: false, id: null, created: false });
    expect(writes).toEqual([]);
  });

  it('leaves a note it could not read exactly as it was', async () => {
    // Writing over a document that no longer parses destroys it with no snapshot
    // taken — the one case the revision history cannot rescue.
    const { db, writes } = dbWith({ 'p-jars': { nonsense: true } });

    const result = await writeKitchenNoteForChef(db, { id: 'p-jars', title: 'x', body: 'y' });

    expect(result.saved).toBe(false);
    expect(result.problem).toMatch(/left exactly as it was/);
    expect(writes).toEqual([]);
    expect(mockWarn).toHaveBeenCalled();
  });
});

// ─── Refusing, without ever throwing ─────────────────────────────────────────

describe('writeKitchenNote — what it refuses', () => {
  it('refuses anything that would not parse back, writing nothing', async () => {
    // Every one of these is a `.max()` on `LibraryPageSchema`, so a document
    // written past it fails to parse on the next read and the page disappears
    // from the list. A refusal the chef can repeat is the whole point.
    const { db, writes } = dbWith({});

    const blank = await writeKitchenNoteForChef(db, { title: '   ', body: 'x' });
    const longTitle = await writeKitchenNoteForChef(db, {
      title: 'T'.repeat(LIBRARY_PAGE_TITLE_MAX + 1),
      body: 'x',
    });
    const huge = await writeKitchenNoteForChef(db, {
      title: 'Long one',
      body: 'x'.repeat(LIBRARY_PAGE_BODY_MAX + 1),
    });

    expect(blank).toMatchObject({ saved: false, id: null });
    expect(blank.problem).toMatch(/title/i);
    expect(longTitle).toMatchObject({ saved: false, id: null });
    expect(longTitle.problem).toMatch(new RegExp(String(LIBRARY_PAGE_TITLE_MAX)));
    expect(huge).toMatchObject({ saved: false, id: null });
    expect(huge.problem).toMatch(new RegExp(String(LIBRARY_PAGE_BODY_MAX)));
    expect(writes).toEqual([]);
  });

  it('accepts a body of exactly the limit', async () => {
    // The refusal above is a boundary, and a boundary that is one out is a bug
    // the household only meets at the worst moment.
    const { db, writes } = dbWith({});

    await expect(
      writeKitchenNoteForChef(db, {
        title: 'At the limit',
        body: 'x'.repeat(LIBRARY_PAGE_BODY_MAX),
      }),
    ).resolves.toMatchObject({ saved: true });
    expect(writes).toHaveLength(1);
  });

  it('reports a Firestore failure as a refusal rather than throwing (Rule 10)', async () => {
    const db = {
      collection: () => ({ doc: () => ({ set: () => Promise.reject(new Error('boom')) }) }),
    } as never;

    await expect(writeKitchenNoteForChef(db, { title: 'x', body: 'y' })).resolves.toMatchObject({
      saved: false,
      id: null,
      created: false,
    });
    expect(mockWarn).toHaveBeenCalled();
  });
});

// ─── The tool the model is shown ─────────────────────────────────────────────

describe('the write tool the model is shown', () => {
  const tool = defineToolCalls.find((c) => c.name === 'writeKitchenNote');

  it('is registered, and its handler writes through the live Firestore', async () => {
    const { db, writes } = dbWith({});
    mockGetFirestore.mockReturnValue(db);
    const registered = writeKitchenNoteTool as unknown as {
      handler: (i: unknown) => Promise<{ saved: boolean }>;
    };

    await expect(
      registered.handler({ title: 'Through the tool', body: 'x' }),
    ).resolves.toMatchObject({ saved: true });
    expect(writes).toHaveLength(1);
  });

  it('tells the model to write ONLY when it has been asked to', () => {
    // Prompt text, and therefore NOT a mechanism — this is the whole of what
    // stops an ordinary conversation leaving a note behind, and saying so plainly
    // is the point of CLAUDE.md rule 12 rather than claiming a guarantee.
    expect(tool?.description).toContain('CALL THIS ONLY WHEN THEY HAVE ASKED YOU TO WRITE ONE');
    expect(tool?.description).toContain('DO NOT CALL IT');
    expect(tool?.description).toMatch(/not permission to rewrite/i);
  });

  it('tells the model that the body REPLACES the note, and that it cannot delete', () => {
    expect(tool?.description).toMatch(/REPLACES everything the note held/);
    expect(tool?.description).toMatch(/cannot delete a note/i);
  });

  it('never calls these pages a library', () => {
    expect(tool?.description).not.toMatch(/library/i);
  });
});

// ─── No delete path, anywhere in the module ──────────────────────────────────

describe('the chef’s tools cannot delete a note', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/flows/chefChat.ts', import.meta.url)),
    'utf8',
  );

  it('scans the module the tools actually live in', () => {
    // UT-E2: the scan must fail when its target moves, rather than pass over an
    // empty string.
    expect(source).toContain("name: 'writeKitchenNote'");
    expect(source).toContain("name: 'readKitchenNote'");
  });

  it('contains no Firestore delete of any shape', () => {
    // Every way the Admin SDK removes data. A delete path arriving in ANY tool in
    // this module — not only the write one — turns this red, which is the claim
    // the issue asks to be made mechanical.
    for (const shape of [
      /\.delete\s*\(/,
      /\bdeleteDoc\b/,
      /\brecursiveDelete\b/,
      /FieldValue\.delete/,
      /\bbulkWriter\b/i,
    ]) {
      expect(source, `chefChat.ts gained a delete path: ${String(shape)}`).not.toMatch(shape);
    }
  });
});
