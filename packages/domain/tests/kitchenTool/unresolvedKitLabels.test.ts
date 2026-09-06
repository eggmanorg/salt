import { describe, it, expect } from 'vitest';
import { unresolvedKitLabels } from '../../src/kitchenTool/index.js';
import type { KitchenToolDoc } from '../../src/schemas/kitchenTool.js';

// The curation queue (issue #882, Phase 4). It answers one question — which words
// has our own content already used that nothing draws — and it must answer it with
// the SAME resolver the app renders through, or the queue and the screen disagree.

function tool(over: Partial<KitchenToolDoc> & { id: string; label: string }): KitchenToolDoc {
  return {
    schemaVersion: 1,
    matchers: [],
    thumbnail: 'https://example.com/kit/x.webp',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as KitchenToolDoc;
}

function recipe(...labels: string[]) {
  return { kit: labels.map((label) => ({ label })) };
}

function plan(prep: (string | null)[], stepNotes: (string | null)[] = []) {
  return {
    prep: prep.map((container) => ({ container })),
    stepNotes: stepNotes.map((container) => ({ container })),
  };
}

describe('unresolvedKitLabels', () => {
  it('returns nothing for empty inputs', () => {
    expect(unresolvedKitLabels([], [], [], [])).toEqual([]);
  });

  it('ranks by how often the miss came up', () => {
    // The point of the ranking: the person curating spends their first write on
    // the name twelve recipes wanted, not the one that turned up once.
    const rows = unresolvedKitLabels(
      [recipe('tagine'), recipe('tagine', 'mandoline'), recipe('tagine')],
      [],
      [],
      [],
    );

    expect(rows).toEqual([
      { label: 'tagine', count: 3 },
      { label: 'mandoline', count: 1 },
    ]);
  });

  it('folds case and whitespace variants into ONE row', () => {
    // "Large Bowl" and "large bowl " are one gap that one write closes, so they
    // are one row with a count of 2 — never two rows inviting two tools.
    const rows = unresolvedKitLabels([recipe('Large Bowl', 'large  bowl ')], [], [], []);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
  });

  it('shows the spelling the content used most', () => {
    const rows = unresolvedKitLabels([recipe('tagine', 'Tagine', 'tagine')], [], [], []);

    expect(rows).toEqual([{ label: 'tagine', count: 3 }]);
  });

  it('leaves out a label the vocabulary already names', () => {
    const rows = unresolvedKitLabels(
      [recipe('Colander', 'tagine')],
      [],
      [tool({ id: 'colander', label: 'Colander' })],
      [],
    );

    expect(rows.map((r) => r.label)).toEqual(['tagine']);
  });

  it('leaves out a label that resolves only through a matcher', () => {
    // The queue must not offer "skillet" as a gap when the frying pan already
    // answers to it — that is the alias action having already been taken.
    const rows = unresolvedKitLabels(
      [recipe('skillet')],
      [],
      [tool({ id: 'frying-pan', label: 'Frying pan', matchers: ['skillet'] })],
      [],
    );

    expect(rows).toEqual([]);
  });

  it('reads both container fields on a plan, and ignores blank and null ones', () => {
    // `null` is the schema's honest "this job puts nothing anywhere"; a blank
    // string is the same thing typed. Neither is evidence of a missing picture.
    const rows = unresolvedKitLabels(
      [],
      [plan([null, '  ', 'tagine'], [null, 'mandoline'])],
      [],
      [],
    );

    expect(rows).toEqual([
      { label: 'mandoline', count: 1 },
      { label: 'tagine', count: 1 },
    ]);
  });

  it('adds a recipe mention and a plan mention into one count', () => {
    const rows = unresolvedKitLabels([recipe('tagine')], [plan(['Tagine'], ['tagine'])], [], []);

    expect(rows).toEqual([{ label: 'tagine', count: 3 }]);
  });

  it('breaks a tie alphabetically, so the list does not reorder under the cursor', () => {
    const rows = unresolvedKitLabels([recipe('zester', 'apple corer', 'mandoline')], [], [], []);

    expect(rows.map((r) => r.label)).toEqual(['apple corer', 'mandoline', 'zester']);
  });

  it('ignores a quantity that wandered into a container field', () => {
    // `normaliseName` strips pure-number tokens, so "500g" normalises away
    // entirely. It names no tool and never could.
    expect(unresolvedKitLabels([], [plan(['500g'])], [], [])).toEqual([]);
  });
});

describe('unresolvedKitLabels — equipment the household owns (issue #954)', () => {
  const magimix = {
    id: 'eq-1',
    schemaVersion: 1 as const,
    name: 'Magimix Cook Expert',
    accessories: [],
    rules: [],
    environment: null,
    updatedAt: '2026-08-01T00:00:00.000Z',
  };

  it('leaves out a label that names an appliance the household owns', () => {
    // `equipmentIcons` already holds a drawing of it (#877/#879). Offering it as a
    // gap would invite a SECOND pictogram of the same machine — and adding one
    // would not change the strip, which resolves equipment first.
    const rows = unresolvedKitLabels([recipe('Magimix Cook Expert', 'tagine')], [], [], [magimix]);

    expect(rows.map((r) => r.label)).toEqual(['tagine']);
  });

  it('still lists a generic label the manifest cannot name', () => {
    // "mandoline" resolves to no owned item (the household owns two, and neither
    // is called that), so it stays a real gap in the drawn vocabulary.
    const rows = unresolvedKitLabels([recipe('mandoline')], [], [], [magimix]);

    expect(rows).toEqual([{ label: 'mandoline', count: 1 }]);
  });
});
