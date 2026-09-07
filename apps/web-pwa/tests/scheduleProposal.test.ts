import { describe, it, expect } from 'vitest';
import { diffProcess } from '@salt/domain';
import type { ProcessStage, ProposedStage } from '@salt/domain/schemas';
import { reviewRows } from '../src/routes/recipes/scheduleProposal';

// How a proposed restructure reads (issue #812, phase 2 of epic #778).
//
// The rows are driven through the REAL `diffProcess` rather than a hand-built
// `ProcessDiff`: the thing worth protecting is that #778's worked restructure —
// ninety counter minutes becoming twenty plus an eight-hour retard — arrives on
// screen as a removal plus two additions, and a fixture diff would let this file
// agree with itself while disagreeing with the domain.

function stage(id: string, over: Partial<ProcessStage> = {}): ProcessStage {
  return {
    id,
    label: id,
    kind: 'wait',
    environment: null,
    duration: null,
    until: null,
    stepId: null,
    optional: false,
    ...over,
  };
}

function proposed(sourceStageId: string | null, over: Partial<ProposedStage> = {}): ProposedStage {
  return {
    sourceStageId,
    label: sourceStageId ?? 'new',
    kind: 'wait',
    environment: null,
    duration: null,
    until: null,
    stepId: null,
    optional: false,
    ...over,
  };
}

function rows(reference: ProcessStage[], stages: ProposedStage[]) {
  return reviewRows(diffProcess(reference, stages), reference, stages);
}

describe('reviewRows — a change reads as before → after', () => {
  it('words a shortened, chilled bulk in both facets', () => {
    const reference = [
      stage('bulk', {
        label: 'Bulk ferment',
        duration: { kind: 'fixed', minutes: 90 },
        environment: { temperature: { kind: 'fixed', celsius: 20 }, equipmentId: null },
      }),
    ];
    const stages = [
      proposed('bulk', {
        label: 'Bulk ferment',
        duration: { kind: 'fixed', minutes: 20 },
        environment: { temperature: { kind: 'fixed', celsius: 4 }, equipmentId: null },
      }),
    ];

    const { changed } = rows(reference, stages);

    expect(changed).toHaveLength(1);
    expect(changed[0]!.label).toBe('Bulk ferment');
    // "1 hr 30 min", not "90 min": `formatMinutes` is shared with the formula screen
    // and the batch screens, so a stage reads the same way while it is reviewed and
    // once the run is going. The spelling is `hr` since issue #933 retired the
    // second `formatMinutes` the recipe page used to keep beside this one.
    expect(changed[0]!.details).toEqual(['1 hr 30 min → 20 min', '20 °C → 4 °C']);
  });

  it('names a renamed stage on both sides, since neither name alone is the truth', () => {
    const reference = [stage('bulk', { label: 'Bulk ferment' })];
    const stages = [proposed('bulk', { label: 'Bulk ferment, counter' })];

    expect(rows(reference, stages).changed[0]!.label).toBe('Bulk ferment → Bulk ferment, counter');
  });

  it('says a range collapsed to a fixed time rather than quietly showing the new number', () => {
    // The schema kept "45–60 min" a range precisely so this could be said out loud.
    const reference = [
      stage('prove', {
        label: 'Prove',
        duration: { kind: 'range', minMinutes: 45, maxMinutes: 60 },
      }),
    ];
    const stages = [
      proposed('prove', { label: 'Prove', duration: { kind: 'fixed', minutes: 30 } }),
    ];

    expect(rows(reference, stages).changed[0]!.details).toEqual(['45 min – 1 hr → 30 min']);
  });

  it('spells out a stage arriving at or losing a length and a criterion', () => {
    const reference = [stage('prove', { label: 'Prove', until: 'until doubled' })];
    const stages = [
      proposed('prove', {
        label: 'Prove',
        duration: { kind: 'fixed', minutes: 480 },
        until: null,
        kind: 'active',
      }),
    ];

    expect(rows(reference, stages).changed[0]!.details).toEqual([
      'no set time → 8 hr',
      'Wait → Active',
      'until doubled → no criterion',
    ]);
  });
});

describe('reviewRows — a restructure is a removal plus additions', () => {
  // #778's worked example, and the one shape the review must never soften into a
  // "split": there is no honest answer to which half inherited the ninety minutes.
  const reference = [
    stage('mix', { label: 'Mix', kind: 'active', duration: { kind: 'fixed', minutes: 10 } }),
    stage('bulk', {
      label: 'Bulk ferment',
      duration: { kind: 'fixed', minutes: 90 },
      environment: { temperature: { kind: 'fixed', celsius: 20 }, equipmentId: null },
    }),
  ];
  const stages = [
    proposed('mix', { label: 'Mix', kind: 'active', duration: { kind: 'fixed', minutes: 10 } }),
    proposed('bulk', {
      label: 'Bulk ferment, counter',
      duration: { kind: 'fixed', minutes: 20 },
      environment: { temperature: { kind: 'fixed', celsius: 20 }, equipmentId: null },
    }),
    proposed('bulk', {
      label: 'Cold retard',
      duration: { kind: 'fixed', minutes: 480 },
      environment: { temperature: { kind: 'fixed', celsius: 4 }, equipmentId: null },
    }),
  ];

  it('renders the ninety-minute bulk as gone and both halves as new', () => {
    const review = rows(reference, stages);

    expect(review.changed).toEqual([]);
    expect(review.removed.map((r) => r.label)).toEqual(['Bulk ferment']);
    expect(review.added.map((r) => r.label)).toEqual(['Bulk ferment, counter', 'Cold retard']);
  });

  it('joins each added and removed row back to what the stage actually was', () => {
    // `ProcessStageDiffEntry` carries only a label; "Added: Cold retard" is a poor
    // row when "8 hr at 4 °C" is the part worth arguing with.
    const review = rows(reference, stages);

    expect(review.removed[0]!.details).toEqual(['1 hr 30 min', '20 °C']);
    expect(review.added[1]!.details).toEqual(['8 hr', '4 °C']);
  });

  it('leaves an untouched stage out of every list', () => {
    // Kept stages are the silent majority; listing them would bury the rows that
    // matter.
    const review = rows(reference, stages);

    expect(
      [...review.changed, ...review.added, ...review.removed].map((r) => r.label),
    ).not.toContain('Mix');
  });
});

describe('reviewRows — declining to restructure', () => {
  it('produces no rows at all, which is the answer and not an absence', () => {
    const reference = [stage('bulk', { label: 'Bulk ferment' })];
    const stages = [proposed('bulk', { label: 'Bulk ferment' })];

    const diff = diffProcess(reference, stages);
    expect(diff.hasChanges).toBe(false);
    expect(reviewRows(diff, reference, stages)).toEqual({ changed: [], added: [], removed: [] });
  });
});
