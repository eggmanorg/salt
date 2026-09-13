import { describe, expect, it } from 'vitest';

import { forbiddenSortMessage, viewGroupFields } from '../lib/boardViews.mjs';

const view = ({ layout = 'TABLE_LAYOUT', group = [], columnField = [], sorts = [] }) => ({
  number: 1,
  name: 'a view',
  layout,
  groupByFields: { nodes: group.map((name) => ({ name })) },
  verticalGroupByFields: { nodes: columnField.map((name) => ({ name })) },
  sortByFields: { nodes: sorts.map(([name, direction]) => ({ direction, field: { name } })) },
});

describe('viewGroupFields', () => {
  it('reads Group by on a table', () => {
    expect(viewGroupFields(view({ group: ['Queue'] }))).toEqual(['Queue']);
  });

  // A board's columns ARE its grouping, and it arrives under a different key
  // with `groupByFields` empty. Reading the wrong one calls every board
  // ungrouped, which would silently exempt the one view this rule is about.
  it('reads Column field on a board, which is where a board keeps it', () => {
    expect(viewGroupFields(view({ layout: 'BOARD_LAYOUT', columnField: ['Status'] }))).toEqual([
      'Status',
    ]);
  });

  it('survives a view with neither', () => {
    expect(viewGroupFields(view({}))).toEqual([]);
    expect(viewGroupFields(undefined)).toEqual([]);
  });
});

describe('forbiddenSortMessage', () => {
  it('fails a Queue-grouped view that carries a sort — the order triage wrote is the only one anything writes', () => {
    const message = forbiddenSortMessage(view({ group: ['Queue'], sorts: [['Created', 'DESC']] }));
    expect(message).toMatch(/groups by Queue and is sorted by Created DESC/);
  });

  // The live `Workflow` board, which the rule flagged every run until it was
  // narrowed. Its columns are reached by event, not by placement, so its sort
  // hides no triage order — it is what makes Triage read oldest-first.
  it('passes the Workflow board: grouped by Status, sorted, and correctly so', () => {
    expect(
      forbiddenSortMessage(
        view({
          layout: 'BOARD_LAYOUT',
          columnField: ['Status'],
          sorts: [
            ['Closed', 'DESC'],
            ['Created', 'ASC'],
          ],
        }),
      ),
    ).toBeNull();
  });

  it('passes a Queue-grouped view with no sort, which is every queue view', () => {
    expect(forbiddenSortMessage(view({ group: ['Queue'] }))).toBeNull();
  });

  // Every other name lookup in board.mjs resolves case-insensitively, and the
  // board's own filters spell it `queue:` — so the check must too, or renaming
  // the field's display case would turn the rule off without a word.
  it('matches the field name case-insensitively', () => {
    expect(forbiddenSortMessage(view({ group: ['queue'], sorts: [['Created', 'ASC']] }))).not.toBe(
      null,
    );
  });
});
