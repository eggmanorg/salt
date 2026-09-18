import { describe, it, expect } from 'vitest';
import { guidedPrepBoard, guidedMiseProgress, guidedPrepCardProgress } from '@salt/domain';
import type { Recipe } from '@salt/domain';
import type { GuidedPrepEntryDoc, IngredientDoc } from '@salt/domain/schemas';

// The shape of the guided prep screen (issue #767): jobs grouped under the
// container that leads them, ingredients as the rows the cook ticks, and the two
// counts read off that — the card's own and the whole screen's.

function ingredient(id: string, over: Partial<IngredientDoc> = {}): IngredientDoc {
  return {
    id,
    rawText: `${id} of something`,
    parsed: null,
    canonId: null,
    matchState: 'matched',
    isOptional: false,
    firstUsedInStepId: null,
    ...over,
  };
}

function recipe(ids: string[]): Recipe {
  return {
    cureCategory: null,
    id: 'r1',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Weeknight ragù',
    description: null,
    ingredients: [{ id: 'g1', name: null, items: ids.map((id) => ingredient(id)) }],
    steps: [],
    metadata: {
      servings: null,
      tags: [],
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    kit: [],
    createdBy: '',
    lastEditedBy: '',
    image: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
  };
}

function prep(
  id: string,
  container: string | null,
  ingredientIds: string[] = [],
): GuidedPrepEntryDoc {
  return { id, text: `do ${id}`, container, ingredientIds };
}

const R = recipe(['i1', 'i2', 'i3', 'i4']);

describe('guidedPrepBoard — grouping', () => {
  it('collects every job that names the same container under one card', () => {
    const board = guidedPrepBoard(R, [
      prep('p1', 'Small bowl', ['i1', 'i2']),
      prep('p2', 'Small bowl', ['i3']),
    ]);
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0]!.jobs.map((j) => j.id)).toEqual(['p1', 'p2']);
  });

  it('groups by the normalised name but shows the name AS AUTHORED, first wins', () => {
    const board = guidedPrepBoard(R, [
      prep('p1', 'Small  Bowl ', ['i1']),
      prep('p2', 'small bowl', ['i2']),
    ]);
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0]!.key).toBe('small bowl');
    expect(board.cards[0]!.name).toBe('Small  Bowl');
  });

  it('orders cards by the plan order of each container-s FIRST appearance', () => {
    const board = guidedPrepBoard(R, [
      prep('p1', 'jug', ['i1']),
      prep('p2', 'small bowl', ['i2']),
      prep('p3', 'jug', ['i3']),
    ]);
    expect(board.cards.map((c) => c.key)).toEqual(['jug', 'small bowl']);
  });

  it('puts every containerless job on ONE unheaded card, in its first-appearance place', () => {
    const board = guidedPrepBoard(R, [
      prep('p1', 'jug', ['i1']),
      prep('p2', null, ['i2']),
      prep('p3', 'small bowl', ['i3']),
      prep('p4', null, ['i4']),
    ]);
    expect(board.cards.map((c) => c.key)).toEqual(['jug', '', 'small bowl']);
    const unheaded = board.cards[1]!;
    expect(unheaded.name).toBeNull();
    expect(unheaded.jobs.map((j) => j.id)).toEqual(['p2', 'p4']);
  });

  it('treats a blank container as no container at all', () => {
    const board = guidedPrepBoard(R, [prep('p1', '   ', ['i1']), prep('p2', null, ['i2'])]);
    expect(board.cards.map((c) => c.key)).toEqual(['']);
    expect(board.cards[0]!.jobs).toHaveLength(2);
  });
});

describe('guidedPrepBoard — tick rows', () => {
  it('gives a job one row per ingredient, keyed by the INGREDIENT, in recipe order', () => {
    const board = guidedPrepBoard(R, [prep('p1', 'small bowl', ['i3', 'i1'])]);
    const job = board.cards[0]!.jobs[0]!;
    expect(job.rows.map((r) => r.id)).toEqual(['i1', 'i3']);
    expect(job.rows.map((r) => r.ingredient?.id)).toEqual(['i1', 'i3']);
  });

  it('gives a job that names no ingredient one row of its own, keyed by the JOB', () => {
    const board = guidedPrepBoard(R, [prep('p1', 'small bowl')]);
    const job = board.cards[0]!.jobs[0]!;
    expect(job.rows).toEqual([{ id: 'p1', ingredient: null }]);
  });

  it('drops an id for an ingredient the recipe no longer has, rather than an empty row', () => {
    const board = guidedPrepBoard(R, [prep('p1', 'small bowl', ['i1', 'i-gone'])]);
    expect(board.cards[0]!.jobs[0]!.rows.map((r) => r.id)).toEqual(['i1']);
  });

  it('falls back to the job row when EVERY id it holds is dangling', () => {
    const board = guidedPrepBoard(R, [prep('p1', 'small bowl', ['i-gone'])]);
    expect(board.cards[0]!.jobs[0]!.rows).toEqual([{ id: 'p1', ingredient: null }]);
  });

  it('a repeated id inside one job is one row', () => {
    const board = guidedPrepBoard(R, [prep('p1', 'small bowl', ['i1', 'i1'])]);
    expect(board.cards[0]!.jobs[0]!.rows.map((r) => r.id)).toEqual(['i1']);
  });

  it('flattens the card-s tick ids in reading order, repeats and all', () => {
    const board = guidedPrepBoard(R, [
      prep('p1', 'small bowl', ['i1', 'i2']),
      prep('p2', 'small bowl', ['i1']),
      prep('p3', 'small bowl'),
    ]);
    expect(board.cards[0]!.tickIds).toEqual(['i1', 'i2', 'i1', 'p3']);
  });
});

describe('guidedPrepBoard — the remainder', () => {
  it('carries the ingredients no job names', () => {
    const board = guidedPrepBoard(R, [prep('p1', 'small bowl', ['i2'])]);
    expect(board.alsoGetOut.map((i) => i.id)).toEqual(['i1', 'i3', 'i4']);
  });

  it('is empty for a plan in sync', () => {
    const board = guidedPrepBoard(R, [prep('p1', 'small bowl', ['i1', 'i2', 'i3', 'i4'])]);
    expect(board.alsoGetOut).toEqual([]);
  });

  it('an empty plan is no cards and the whole recipe to get out', () => {
    const board = guidedPrepBoard(R, []);
    expect(board.cards).toEqual([]);
    expect(board.alsoGetOut.map((i) => i.id)).toEqual(['i1', 'i2', 'i3', 'i4']);
  });

  it('is pure — reads the plan and writes nothing', () => {
    const entries = [prep('p1', 'small bowl', ['i1'])];
    guidedPrepBoard(R, entries);
    expect(entries).toEqual([prep('p1', 'small bowl', ['i1'])]);
  });
});

describe('guidedPrepCardProgress', () => {
  const BOARD = guidedPrepBoard(R, [
    prep('p1', 'small bowl', ['i1', 'i2']),
    prep('p2', 'small bowl', ['i3']),
    prep('p3', 'jug', ['i4']),
  ]);

  it('counts the card-s own tick rows and nothing else', () => {
    expect(guidedPrepCardProgress(BOARD.cards[0]!, new Set(['i1', 'i4']))).toEqual({
      total: 3,
      checked: 1,
      allChecked: false,
    });
  });

  it('is done only when every job under the container is', () => {
    expect(guidedPrepCardProgress(BOARD.cards[0]!, new Set(['i1', 'i2']))).toMatchObject({
      allChecked: false,
    });
    expect(guidedPrepCardProgress(BOARD.cards[0]!, new Set(['i1', 'i2', 'i3']))).toEqual({
      total: 3,
      checked: 3,
      allChecked: true,
    });
  });

  it('a stale tick for a row this card does not show never finishes it', () => {
    expect(guidedPrepCardProgress(BOARD.cards[1]!, new Set(['i-gone', 'p-gone']))).toEqual({
      total: 1,
      checked: 0,
      allChecked: false,
    });
  });
});

describe('guidedMiseProgress', () => {
  const BOARD = guidedPrepBoard(R, [
    prep('p1', 'small bowl', ['i1', 'i2']),
    prep('p2', null),
    prep('p3', 'jug', ['i3']),
  ]);

  it('counts every tick row on the screen — ingredients, job rows and the remainder', () => {
    // i1, i2, p2, i3 across the cards; i4 is the remainder.
    expect(guidedMiseProgress(BOARD, new Set(['i1']))).toEqual({
      total: 5,
      checked: 1,
      allChecked: false,
    });
  });

  it('an INGREDIENT tick is what advances it, not a job tick', () => {
    expect(guidedMiseProgress(BOARD, new Set(['p1']))).toMatchObject({ checked: 0 });
    expect(guidedMiseProgress(BOARD, new Set(['i1', 'i2']))).toMatchObject({ checked: 2 });
  });

  it('is allChecked only when the remainder is ticked too', () => {
    expect(guidedMiseProgress(BOARD, new Set(['i1', 'i2', 'p2', 'i3']))).toMatchObject({
      checked: 4,
      allChecked: false,
    });
    expect(guidedMiseProgress(BOARD, new Set(['i1', 'i2', 'p2', 'i3', 'i4']))).toEqual({
      total: 5,
      checked: 5,
      allChecked: true,
    });
  });

  it('counts over the board, not over the tick list — stale ids never inflate it', () => {
    expect(guidedMiseProgress(BOARD, new Set(['i1', 'p-gone', 'i-gone']))).toEqual({
      total: 5,
      checked: 1,
      allChecked: false,
    });
  });

  it('"0 of 0 ready" is not an accomplishment', () => {
    const empty = guidedPrepBoard(recipe([]), []);
    expect(guidedMiseProgress(empty, new Set())).toEqual({
      total: 0,
      checked: 0,
      allChecked: false,
    });
    expect(guidedMiseProgress(empty, new Set(['p-gone']))).toMatchObject({ allChecked: false });
  });

  it('is pure — reads its inputs and writes nothing', () => {
    const checked = new Set(['i1']);
    guidedMiseProgress(BOARD, checked);
    expect([...checked]).toEqual(['i1']);
    expect(BOARD.cards.map((c) => c.key)).toEqual(['small bowl', '', 'jug']);
  });
});
