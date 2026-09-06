import { describe, it, expect } from 'vitest';
import { roundGrams } from '@salt/domain';
import type { BatchDoc, BatchStageDoc } from '@salt/domain/schemas';
import {
  defaultObservationStageId,
  formatGrams,
  formatStatedDuration,
  formatWhen,
  nextAction,
  orderBatches,
  stageLabelById,
  yieldSummary,
} from '../src/routes/batches/batchDisplay.js';

// The words and formats the two batch screens share (issue #812, phase 1 of epic
// #778). Pure, and the clock is injected, so every case here is a fixed string.
//
// Every instant below is built with the local-time `Date` constructor and rendered
// in local time, so none of these assertions depends on the machine's timezone —
// which is the same reason `formatWhen` compares local calendar days rather than
// UTC ones. "Tomorrow" is a fact about the kitchen's morning.

function at(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function stage(over: Partial<BatchStageDoc> = {}): BatchStageDoc {
  return {
    id: 'stage-1',
    label: 'Bulk ferment',
    kind: 'wait',
    environment: null,
    duration: { kind: 'fixed', minutes: 180 },
    until: null,
    stepId: null,
    optional: false,
    plannedStartAt: '2026-08-14T09:00:00.000Z',
    plannedEndAt: '2026-08-14T12:00:00.000Z',
    actualStartAt: null,
    actualEndAt: null,
    skipped: null,
    ...over,
  };
}

function batch(over: Partial<BatchDoc> = {}): BatchDoc {
  return {
    id: 'batch-1',
    schemaVersion: 1,
    recipeId: 'recipe-1',
    recipeTitle: 'Overnight white tin',
    state: 'running',
    quantities: [],
    totals: { basisGrams: 841, totalGrams: 1483, usableGrams: 1440, units: null },
    stages: [stage()],
    rationale: null,
    createdAt: '2026-08-14T08:00:00.000Z',
    updatedAt: '2026-08-14T08:00:00.000Z',
    ...over,
  };
}

describe('formatWhen', () => {
  const now = at(2026, 8, 14, 9, 0);

  it('gives today and tomorrow their words', () => {
    expect(formatWhen(at(2026, 8, 14, 12, 30).toISOString(), now)).toBe('today 12:30');
    expect(formatWhen(at(2026, 8, 15, 7, 30).toISOString(), now)).toBe('tomorrow 07:30');
    expect(formatWhen(at(2026, 8, 13, 22, 0).toISOString(), now)).toBe('yesterday 22:00');
  });

  it('names the weekday once a run reaches past tomorrow — a cure runs for weeks', () => {
    expect(formatWhen(at(2026, 8, 21, 7, 30).toISOString(), now)).toBe('Fri 21 Aug, 07:30');
  });

  it('never renders an unreadable instant as a date', () => {
    expect(formatWhen('not a time', now)).toBe('—');
  });
});

describe('formatStatedDuration', () => {
  it('keeps a range as a range — the recipe said 45 to 60, not 52.5', () => {
    expect(formatStatedDuration({ kind: 'range', minMinutes: 45, maxMinutes: 60 })).toBe(
      '45 min – 1 hr',
    );
  });

  it('reads a hand-typed range backwards without printing a negative span', () => {
    expect(formatStatedDuration({ kind: 'range', minMinutes: 60, maxMinutes: 45 })).toBe(
      '45 min – 1 hr',
    );
  });

  it('says nothing at all for a stage with no duration', () => {
    // "Until doubled" has no length. The caller says so in words rather than
    // printing a figure nobody gave.
    expect(formatStatedDuration(null)).toBeNull();
  });

  it('spells a fixed duration in hours and minutes', () => {
    expect(formatStatedDuration({ kind: 'fixed', minutes: 90 })).toBe('1 hr 30 min');
    expect(formatStatedDuration({ kind: 'fixed', minutes: 15 })).toBe('15 min');
  });
});

describe('nextAction', () => {
  it('is the first stage not yet marked done', () => {
    const action = nextAction(
      batch({
        stages: [
          stage({ id: 's1', label: 'Mix', actualEndAt: '2026-08-14T09:10:00.000Z' }),
          stage({ id: 's2', label: 'Bulk ferment' }),
        ],
      }),
    );
    expect(action).toEqual({ kind: 'stage', stage: expect.objectContaining({ id: 's2' }) });
  });

  it('is "done" when every stage is finished — there is no finished STATE', () => {
    expect(
      nextAction(batch({ stages: [stage({ actualEndAt: '2026-08-14T12:00:00.000Z' })] })).kind,
    ).toBe('done');
  });

  it('is "abandoned" for a stopped run, whatever its stages say', () => {
    expect(nextAction(batch({ state: 'abandoned' })).kind).toBe('abandoned');
  });

  // ─── Skipped and in-progress stages (issue #1275) ─────────────────────────────

  it('STEPS OVER a skipped stage — it is never what the run is waiting for', () => {
    const action = nextAction(
      batch({
        stages: [
          stage({
            id: 's1',
            label: 'Brush with milk',
            skipped: { at: '2026-08-14T09:10:00.000Z', note: '' },
          }),
          stage({ id: 's2', label: 'Bake' }),
        ],
      }),
    );
    expect(action).toEqual({ kind: 'stage', stage: expect.objectContaining({ id: 's2' }) });
  });

  it('is "done" when the LAST stage was skipped rather than done', () => {
    // A run that ends on a skip finishes exactly as a fully-done one does. The
    // surfaces read this and nothing else, so they cannot disagree about it.
    expect(
      nextAction(
        batch({
          stages: [
            stage({ id: 's1', actualEndAt: '2026-08-14T12:00:00.000Z' }),
            stage({ id: 's2', skipped: { at: '2026-08-14T12:05:00.000Z', note: 'no glaze' } }),
          ],
        }),
      ).kind,
    ).toBe('done');
  });

  it('still names a stage that is in progress — under way is not finished with', () => {
    const action = nextAction(
      batch({ stages: [stage({ id: 's1', actualStartAt: '2026-08-14T09:00:00.000Z' })] }),
    );
    expect(action).toEqual({ kind: 'stage', stage: expect.objectContaining({ id: 's1' }) });
  });
});

describe('orderBatches', () => {
  it('is unchanged by a skip — it orders by the clock the run waits against', () => {
    // Pinned rather than assumed (issue #1275): `orderBatches` reads `nextAction`
    // and nothing else, so a skipped stage reaches it only through that. A run
    // whose first stage was skipped sorts on its NEXT stage's planned time, and a
    // run finished by a skip falls to the bottom with the rest.
    const skippedFirst = batch({
      id: 'skipped-first',
      stages: [
        stage({
          id: 's1',
          plannedStartAt: '2026-08-14T09:00:00Z',
          skipped: { at: '2026-08-14T08:00:00Z', note: '' },
        }),
        stage({ id: 's2', plannedStartAt: '2026-08-14T12:00:00Z' }),
      ],
    });
    const earlier = batch({
      id: 'earlier',
      stages: [stage({ plannedStartAt: '2026-08-14T10:00:00Z' })],
    });
    const endedOnASkip = batch({
      id: 'ended',
      stages: [
        stage({
          plannedStartAt: '2026-08-14T07:00:00Z',
          skipped: { at: '2026-08-14T07:00:00Z', note: '' },
        }),
      ],
    });

    expect(orderBatches([skippedFirst, endedOnASkip, earlier]).map((b) => b.id)).toEqual([
      'earlier',
      'skipped-first',
      'ended',
    ]);
  });

  it('puts what needs doing soonest first, and everything finished at the bottom', () => {
    const soon = batch({ id: 'soon', stages: [stage({ plannedStartAt: '2026-08-14T09:00:00Z' })] });
    const later = batch({
      id: 'later',
      stages: [stage({ plannedStartAt: '2026-08-14T18:00:00Z' })],
    });
    const done = batch({
      id: 'done',
      createdAt: '2026-08-10T08:00:00.000Z',
      stages: [stage({ actualEndAt: '2026-08-10T12:00:00.000Z' })],
    });
    const stopped = batch({
      id: 'stopped',
      state: 'abandoned',
      createdAt: '2026-08-12T08:00:00.000Z',
    });

    expect(orderBatches([done, later, stopped, soon]).map((b) => b.id)).toEqual([
      'soon',
      'later',
      // The ended ones read as a log: most recently started first.
      'stopped',
      'done',
    ]);
  });
});

describe('yieldSummary', () => {
  it('counts the shapes when the solve had one', () => {
    expect(
      yieldSummary({
        basisGrams: 841,
        totalGrams: 1483,
        usableGrams: 1440,
        units: { label: '120 g roll', count: 12, unitDoughGrams: 120, bakedUnitGrams: 108 },
      }),
    ).toBe('12 × 120 g roll');
  });

  it('falls back to the weight for a basis-driven run — a cure yields no count', () => {
    expect(
      yieldSummary({ basisGrams: 2400, totalGrams: 2460, usableGrams: 2460, units: null }),
    ).toBe('2460 g');
  });
});

/**
 * Characterisation net for `formatGrams` (issue #933, Phase 1). This describe did
 * not exist; the function had no direct coverage at all, which is how a third
 * copy on `FormulaPage.svelte` came to round where these two do not.
 *
 * The rule this pins is the one the module header states and the one Phase 3 must
 * not break: **it formats, it does not compute.** A figure arrives already rounded
 * by the domain's one rounding authority (`roundGrams`), and this only chooses
 * words for it. The rows below are what makes that sentence checkable rather than
 * merely written down.
 */
describe('formatGrams', () => {
  const cases = [
    { name: 'a whole-gram total', grams: 1483, rendered: '1483 g' },
    { name: 'a single gram', grams: 1, rendered: '1 g' },
    { name: 'nothing at all', grams: 0, rendered: '0 g' },
    { name: 'the one-decimal figure a small quantity keeps', grams: 2.5, rendered: '2.5 g' },
    { name: 'a large basis', grams: 2460, rendered: '2460 g' },
  ];

  it.each(cases)('$name — $grams → $rendered', ({ grams, rendered }) => {
    expect(formatGrams(grams)).toBe(rendered);
  });

  it('renders the number it was handed, unrounded — the rounding is the caller’s', () => {
    // The load-bearing assertion. `FormulaPage.svelte:596` carries a third copy
    // that reads `${roundGrams(grams)} g`, so the same float renders two ways in
    // the app today. Phase 3 deletes that copy and makes the round EXPLICIT at
    // FormulaPage's four call sites — which is behaviour-preserving only while
    // this function goes on doing no arithmetic of its own.
    expect(formatGrams(1234.56)).toBe('1234.56 g');
    expect(formatGrams(roundGrams(1234.56))).toBe('1235 g');

    // Below the decimal threshold the authority keeps one decimal, so the two
    // spellings can agree — the divergence is not everywhere, which is exactly
    // why it survived.
    expect(formatGrams(roundGrams(2.5))).toBe('2.5 g');
  });
});

// ─── Which stage a reading is about (issue #1276) ───────────────────────────────
//
// One rule answering all four run conditions, so that no surface re-derives "which
// stage is now". Each case below is one of those four.

describe('defaultObservationStageId', () => {
  it('picks the stage in progress — the one the cook is standing in front of', () => {
    const run = batch({
      stages: [
        stage({ id: 'mix', actualEndAt: '2026-08-14T07:15:00.000Z' }),
        stage({ id: 'bulk', actualStartAt: '2026-08-14T07:15:00.000Z' }),
        stage({ id: 'bake' }),
      ],
    });

    expect(defaultObservationStageId(run)).toBe('bulk');
  });

  it('picks the EARLIEST of two in progress — the oven can go on mid-prove (#1275)', () => {
    const run = batch({
      stages: [
        stage({ id: 'prove', actualStartAt: '2026-08-14T09:00:00.000Z' }),
        stage({ id: 'oven', actualStartAt: '2026-08-14T09:30:00.000Z' }),
      ],
    });

    expect(defaultObservationStageId(run)).toBe('prove');
  });

  it('falls back to the stage next up when nothing has been started', () => {
    const run = batch({ stages: [stage({ id: 'mix' }), stage({ id: 'bulk' })] });

    expect(defaultObservationStageId(run)).toBe('mix');
    expect(nextAction(run)).toEqual({ kind: 'stage', stage: run.stages[0] });
  });

  it('steps over a skipped stage exactly as the run does', () => {
    const run = batch({
      stages: [
        stage({ id: 'autolyse', skipped: { at: '2026-08-14T07:00:00.000Z', note: '' } }),
        stage({ id: 'mix' }),
      ],
    });

    expect(defaultObservationStageId(run)).toBe('mix');
  });

  it('answers "the whole batch" for a finished run — which is when the prompt asks', () => {
    // Nothing in progress and nothing next. "How did it go?" is a verdict on the run,
    // and filing it against the bake would make the field mean two things.
    const run = batch({
      stages: [
        stage({ id: 'mix', actualEndAt: '2026-08-14T07:15:00.000Z' }),
        stage({ id: 'bake', actualEndAt: '2026-08-14T09:00:00.000Z' }),
      ],
    });

    expect(nextAction(run)).toEqual({ kind: 'done' });
    expect(defaultObservationStageId(run)).toBeNull();
  });

  it('answers "the whole batch" for a stopped run with nothing under way', () => {
    const run = batch({ state: 'abandoned', stages: [stage({ id: 'mix' })] });

    expect(defaultObservationStageId(run)).toBeNull();
  });

  it('still names the stage that was under way when a run was stopped', () => {
    // `nextAction` has nothing to say about an abandoned run, but a note written
    // afterwards is about the stage it went wrong in — so in-progress wins first.
    const run = batch({
      state: 'abandoned',
      stages: [stage({ id: 'cure', actualStartAt: '2026-08-14T07:15:00.000Z' })],
    });

    expect(nextAction(run)).toEqual({ kind: 'abandoned' });
    expect(defaultObservationStageId(run)).toBe('cure');
  });
});

describe('stageLabelById', () => {
  const run = batch({
    stages: [stage({ id: 'bulk', label: 'Bulk ferment' }), stage({ id: 'bake', label: 'Bake' })],
  });

  it('joins against the run’s own frozen stages', () => {
    expect(stageLabelById(run, 'bulk')).toBe('Bulk ferment');
    expect(stageLabelById(run, 'bake')).toBe('Bake');
  });

  it('says nothing for an entry about the whole run', () => {
    expect(stageLabelById(run, null)).toBeNull();
  });

  it('says nothing for an id this run does not have, rather than inventing a word', () => {
    expect(stageLabelById(run, 'stage-from-another-run')).toBeNull();
  });
});
