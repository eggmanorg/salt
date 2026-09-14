import { describe, it, expect } from 'vitest';
import {
  LibraryPageSchema,
  LIBRARY_PAGE_BODY_MAX,
  LIBRARY_PAGE_TITLE_MAX,
  LIBRARY_PAGE_REVISION_CAP,
  pushRevision,
  type LibraryPageDoc,
  type LibraryPageRevisionDoc,
} from '../../src/schemas/libraryPage.js';

// The library page schema and the one helper that grows its history (epic #1372).
//
// Two of these describe shape. The rest exist because the document carries its own
// history inside itself, which is the one thing about this collection that can go
// wrong quietly: an unbounded `revisions` array grows until a write starts failing
// at Firestore's 1 MiB document limit, and the page is then unsaveable rather than
// merely large.

function revision(over: Partial<LibraryPageRevisionDoc> = {}): LibraryPageRevisionDoc {
  return {
    title: 'Weck jars',
    body: 'The 742 holds 580 g of kraut.',
    savedAt: '2026-09-14T09:00:00.000Z',
    savedBy: 'Daniel',
    ...over,
  };
}

function page(over: Partial<LibraryPageDoc> = {}): LibraryPageDoc {
  return {
    id: 'page-1',
    schemaVersion: 1,
    kind: 'note',
    title: 'Weck jars',
    body: '## Weck jars\n\n| Model | Brim |\n| --- | --- |\n| 742 | 580 g |',
    tags: ['Fermentation'],
    createdAt: '2026-09-14T09:00:00.000Z',
    updatedAt: '2026-09-14T09:00:00.000Z',
    createdBy: 'Daniel',
    lastEditedBy: 'Daniel',
    revisions: [],
    ...over,
  };
}

describe('LibraryPageSchema', () => {
  it('parses a page', () => {
    expect(LibraryPageSchema.safeParse(page()).success).toBe(true);
  });

  it('defaults the fields a page written before them would lack', () => {
    const parsed = LibraryPageSchema.parse({
      id: 'page-1',
      title: 'Weck jars',
      body: 'text',
      createdAt: '2026-09-14T09:00:00.000Z',
      updatedAt: '2026-09-14T09:00:00.000Z',
      createdBy: 'Daniel',
      lastEditedBy: 'Daniel',
    });
    expect(parsed).toMatchObject({ schemaVersion: 1, kind: 'note', tags: [], revisions: [] });
  });

  // The bound has to be the schema's, not the textarea's: the textarea is one
  // writer and Phase 4 adds another.
  it('refuses a body past the maximum', () => {
    expect(
      LibraryPageSchema.safeParse(page({ body: 'x'.repeat(LIBRARY_PAGE_BODY_MAX) })).success,
    ).toBe(true);
    expect(
      LibraryPageSchema.safeParse(page({ body: 'x'.repeat(LIBRARY_PAGE_BODY_MAX + 1) })).success,
    ).toBe(false);
  });

  it('refuses a title past the maximum', () => {
    expect(
      LibraryPageSchema.safeParse(page({ title: 'x'.repeat(LIBRARY_PAGE_TITLE_MAX + 1) })).success,
    ).toBe(false);
  });

  // `revisions` deliberately carries NO `.max()` — see the constant's comment. A
  // page that somehow held more than the cap must still be readable, because the
  // alternative is that the page vanishes from the list.
  it('still reads a page holding more revisions than the cap', () => {
    const overfull = page({
      revisions: Array.from({ length: LIBRARY_PAGE_REVISION_CAP + 5 }, (_, i) =>
        revision({ body: `version ${i}` }),
      ),
    });
    expect(LibraryPageSchema.safeParse(overfull).success).toBe(true);
  });
});

// CLAUDE.md Rule 12. The sizing claim in `LIBRARY_PAGE_BODY_MAX`'s docblock is an
// absolute — "a page with a full body and a full history fits inside a Firestore
// document" — so it is measured here rather than asserted there. Raising either
// constant past what the limit can carry turns this red.
describe('the document cannot outgrow Firestore', () => {
  const FIRESTORE_DOC_LIMIT_BYTES = 1_048_576;

  it('fits with a maximal body and a full history of maximal bodies', () => {
    // The DENSEST character a `.max()` can admit, which is not the astral one it
    // looks like it should be: Zod counts UTF-16 code units, and a surrogate pair
    // spends two of them on four bytes (2 bytes/unit) where this BMP ideograph
    // spends one on three (3 bytes/unit). Filling with astral characters would
    // measure a case 33% cheaper than the worst and call it the worst.
    const fill = (units: number) => '中'.repeat(units);
    const worst = page({
      title: fill(LIBRARY_PAGE_TITLE_MAX),
      body: fill(LIBRARY_PAGE_BODY_MAX),
      tags: Array.from({ length: 20 }, () => fill(40)),
      revisions: Array.from({ length: LIBRARY_PAGE_REVISION_CAP }, () =>
        revision({ title: fill(LIBRARY_PAGE_TITLE_MAX), body: fill(LIBRARY_PAGE_BODY_MAX) }),
      ),
    });

    expect(LibraryPageSchema.safeParse(worst).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(worst)).byteLength).toBeLessThan(
      FIRESTORE_DOC_LIMIT_BYTES,
    );
  });
});

describe('pushRevision', () => {
  it('puts the newest version at the front', () => {
    const after = pushRevision([revision({ body: 'older' })], revision({ body: 'newer' }));
    expect(after.map((r) => r.body)).toEqual(['newer', 'older']);
  });

  it('never grows past the cap, dropping the oldest', () => {
    let history: LibraryPageRevisionDoc[] = [];
    for (let i = 0; i < LIBRARY_PAGE_REVISION_CAP + 4; i += 1) {
      history = pushRevision(history, revision({ body: `v${i}` }));
    }
    expect(history).toHaveLength(LIBRARY_PAGE_REVISION_CAP);
    expect(history[0]?.body).toBe(`v${LIBRARY_PAGE_REVISION_CAP + 3}`);
    expect(history.at(-1)?.body).toBe('v4');
  });

  // Opening the editor and closing it again is not a version.
  it('drops a snapshot identical to the newest one', () => {
    const history = [revision({ body: 'same' })];
    const after = pushRevision(history, revision({ body: 'same', savedBy: 'Someone else' }));
    expect(after).toHaveLength(1);
    expect(after[0]?.savedBy).toBe('Daniel');
  });

  it('keeps a snapshot that matches an OLDER revision but not the newest', () => {
    const history = [revision({ body: 'b' }), revision({ body: 'a' })];
    expect(pushRevision(history, revision({ body: 'a' })).map((r) => r.body)).toEqual([
      'a',
      'b',
      'a',
    ]);
  });

  it('does not mutate what it is given', () => {
    const history = [revision({ body: 'older' })];
    pushRevision(history, revision({ body: 'newer' }));
    expect(history).toHaveLength(1);
  });
});
