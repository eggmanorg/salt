import { describe, it, expect } from 'vitest';
import { stageAdditions } from '../../src/index.js';

// `stageAdditions` (issue #1405) — the one grouping of ingredients over an ordered
// process. The grouping itself is three lines; what earns a test file is the
// FALLBACK, which is the claim `FormulaComponentSchema.stageId` states as its limit
// and which nothing but this file can hold (CLAUDE.md rule 12).

const STAGES = [{ id: 'stage-rub' }, { id: 'stage-wash' }, { id: 'stage-case' }];

const row = (ingredientId: string, stageId: string | null) => ({ ingredientId, stageId });

describe('stageAdditions', () => {
  it('puts every row under the stage it names', () => {
    const grouped = stageAdditions(STAGES, [
      row('ing-salt', 'stage-rub'),
      row('ing-wine', 'stage-wash'),
      row('ing-bung', 'stage-case'),
    ]);

    expect(grouped.atStart).toEqual([]);
    expect(grouped.byStageId.get('stage-rub')).toEqual([row('ing-salt', 'stage-rub')]);
    expect(grouped.byStageId.get('stage-wash')).toEqual([row('ing-wine', 'stage-wash')]);
    expect(grouped.byStageId.get('stage-case')).toEqual([row('ing-bung', 'stage-case')]);
  });

  it('reads a null stage as at the start — which is what every bread formula says', () => {
    const grouped = stageAdditions(STAGES, [row('ing-flour', null), row('ing-water', null)]);

    expect(grouped.atStart).toEqual([row('ing-flour', null), row('ing-water', null)]);
    for (const stage of STAGES) expect(grouped.byStageId.get(stage.id)).toEqual([]);
  });

  it('carries an ingredient whose stage has been DELETED, reading it as at the start', () => {
    // THE PINNED CLAIM. Deleting a stage does not cascade into the components, so a
    // dead id is ordinary — and the ingredient is still in the formula, still
    // scaled, still bought. This is what must not quietly become "the ingredient
    // vanishes": break the fallback and this goes red, because the row would be in
    // neither bucket.
    const grouped = stageAdditions(STAGES, [
      row('ing-salt', 'stage-rub'),
      row('ing-juniper', 'stage-that-was-deleted'),
    ]);

    expect(grouped.atStart).toEqual([row('ing-juniper', 'stage-that-was-deleted')]);
    expect(grouped.byStageId.get('stage-rub')).toEqual([row('ing-salt', 'stage-rub')]);

    // And nothing is lost overall, which is the property the fallback exists for.
    const placed = [...grouped.atStart, ...[...grouped.byStageId.values()].flat()];
    expect(placed).toHaveLength(2);
  });

  it('places a row exactly once, so no ingredient is weighed out twice', () => {
    const rows = [
      row('ing-salt', 'stage-rub'),
      row('ing-flour', null),
      row('ing-gone', 'stage-missing'),
    ];
    const grouped = stageAdditions(STAGES, rows);

    const placed = [...grouped.atStart, ...[...grouped.byStageId.values()].flat()];
    expect(placed).toHaveLength(rows.length);
    expect(new Set(placed.map((r) => r.ingredientId)).size).toBe(rows.length);
  });

  it('gives an entry for every stage, including the ones that take nothing', () => {
    // So a caller renders a stage's additions without having to decide what a
    // missing key means.
    const grouped = stageAdditions(STAGES, [row('ing-wine', 'stage-wash')]);

    expect([...grouped.byStageId.keys()]).toEqual(['stage-rub', 'stage-wash', 'stage-case']);
    expect(grouped.byStageId.get('stage-rub')).toEqual([]);
  });

  it('keeps the order the rows came in, within each bucket', () => {
    // The formula's own order is the order the screen shows, and re-sorting here
    // would silently reorder a weigh-out list.
    const grouped = stageAdditions(STAGES, [
      row('ing-b', 'stage-rub'),
      row('ing-a', 'stage-rub'),
      row('ing-d', null),
      row('ing-c', null),
    ]);

    expect(grouped.byStageId.get('stage-rub')?.map((r) => r.ingredientId)).toEqual([
      'ing-b',
      'ing-a',
    ]);
    expect(grouped.atStart.map((r) => r.ingredientId)).toEqual(['ing-d', 'ing-c']);
  });

  it('handles a process with no stages at all — everything is at the start', () => {
    const grouped = stageAdditions([], [row('ing-flour', null), row('ing-salt', 'stage-rub')]);

    expect(grouped.byStageId.size).toBe(0);
    expect(grouped.atStart.map((r) => r.ingredientId)).toEqual(['ing-flour', 'ing-salt']);
  });

  it('carries whatever else the row holds, because it is generic over it', () => {
    // The formula screen hands it `SolvedComponent`s and the batch pages hand it
    // frozen `BatchQuantity`s; both must come back whole.
    const grouped = stageAdditions(STAGES, [
      { ingredientId: 'ing-wine', stageId: 'stage-wash', grams: 40, label: 'red wine' },
    ]);

    expect(grouped.byStageId.get('stage-wash')).toEqual([
      { ingredientId: 'ing-wine', stageId: 'stage-wash', grams: 40, label: 'red wine' },
    ]);
  });
});
