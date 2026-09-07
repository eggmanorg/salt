import { describe, it, expect } from 'vitest';
import { diffProcess } from '../../src/index.js';
import type {
  ProcessStage,
  ProposedStage,
  StageDuration,
  StageEnvironment,
} from '../../src/schemas/index.js';

// The overnight white tin again, and the question the review screen asks of it:
// what did the proposal actually change?

const fixed = (minutes: number): StageDuration => ({ kind: 'fixed', minutes });
// A stage temperature the recipe means exactly, with no place named (#1281).
const env = (celsius: number): StageEnvironment => ({
  temperature: { kind: 'fixed', celsius },
  equipmentId: null,
});
const range = (minMinutes: number, maxMinutes: number): StageDuration => ({
  kind: 'range',
  minMinutes,
  maxMinutes,
});

function stage(id: string, label: string, overrides: Partial<ProcessStage> = {}): ProcessStage {
  return {
    id,
    label,
    kind: 'wait',
    environment: env(20),
    duration: fixed(60),
    until: null,
    stepId: null,
    optional: false,
    ...overrides,
  };
}

// A proposed stage is CONTENT plus a citation — no id of its own, because nothing
// has minted one and nothing should until a run is frozen.
function proposed(
  label: string,
  sourceStageId: string | null,
  overrides: Partial<ProposedStage> = {},
): ProposedStage {
  return {
    label,
    kind: 'wait',
    environment: env(20),
    duration: fixed(60),
    until: null,
    stepId: null,
    optional: false,
    sourceStageId,
    ...overrides,
  };
}

const REFERENCE: ProcessStage[] = [
  stage('mix', 'Mix and knead', { kind: 'active', environment: null, duration: fixed(20) }),
  stage('bulk', 'Bulk ferment', { duration: fixed(90) }),
  stage('shape', 'Shape into the tin', { kind: 'active', environment: null, duration: fixed(15) }),
  stage('prove', 'Final prove', { duration: range(45, 60) }),
  stage('bake', 'Bake', { kind: 'active', environment: env(230), duration: fixed(45) }),
];

// The reference as the model would return it if it changed nothing: same content,
// each stage citing itself.
const UNCHANGED: ProposedStage[] = REFERENCE.map((s) =>
  proposed(s.label, s.id, {
    kind: s.kind,
    environment: s.environment,
    duration: s.duration,
    until: s.until,
    stepId: s.stepId,
    optional: false,
  }),
);

describe('diffProcess — declining to restructure', () => {
  it('reports no changes when the proposal reproduces the process', () => {
    // THE FEATURE, not a degenerate case: one of the spike's three recipes
    // correctly did nothing but back-solve, and this is how the review renders it.
    expect(diffProcess(REFERENCE, UNCHANGED)).toEqual({
      hasChanges: false,
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('reports no changes for two empty processes', () => {
    expect(diffProcess([], [])).toEqual({
      hasChanges: false,
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('ignores a stage that only moved', () => {
    // A pure reorder with no content change is deliberately not reported —
    // `diffRecipe`'s rule, for `diffRecipe`'s reason: add/remove/change clarity is
    // what the summary is for.
    const reordered = [UNCHANGED[3]!, ...UNCHANGED.filter((_, i) => i !== 3)];
    expect(diffProcess(REFERENCE, reordered).hasChanges).toBe(false);
  });

  it('ignores the citations themselves and the step back-reference', () => {
    // `stepId` is a machine-derived one-way key, not human signal.
    const restepped = UNCHANGED.map((s) => ({ ...s, stepId: 'step-9' }));
    expect(diffProcess(REFERENCE, restepped).hasChanges).toBe(false);
  });
});

describe('diffProcess — temperature ranges and places (issue #1281)', () => {
  it('reports a fixed temperature becoming a range', () => {
    const banded = UNCHANGED.map((s) =>
      s.sourceStageId === 'bulk'
        ? {
            ...s,
            environment: {
              temperature: { kind: 'range' as const, minCelsius: 22, maxCelsius: 26 },
              equipmentId: null,
            },
          }
        : s,
    );
    const diff = diffProcess(REFERENCE, banded);
    expect(diff.changed).toEqual([
      {
        id: 'bulk',
        position: 2,
        environment: {
          from: env(20),
          to: {
            temperature: { kind: 'range', minCelsius: 22, maxCelsius: 26 },
            equipmentId: null,
          },
        },
      },
    ]);
  });

  it('reads an identical range as no change, and a wider one as a change', () => {
    const band = (minCelsius: number, maxCelsius: number): StageEnvironment => ({
      temperature: { kind: 'range', minCelsius, maxCelsius },
      equipmentId: null,
    });
    const bandedReference = REFERENCE.map((s) =>
      s.id === 'bulk' ? { ...s, environment: band(22, 26) } : s,
    );
    const same = UNCHANGED.map((s) =>
      s.sourceStageId === 'bulk' ? { ...s, environment: band(22, 26) } : s,
    );
    const wider = UNCHANGED.map((s) =>
      s.sourceStageId === 'bulk' ? { ...s, environment: band(22, 30) } : s,
    );
    expect(diffProcess(bandedReference, same).hasChanges).toBe(false);
    expect(diffProcess(bandedReference, wider).hasChanges).toBe(true);
  });

  it('reports a stage MOVED to a place, even at the same temperature', () => {
    // The figures matching is not the same as the stage being unchanged: a prove
    // moved from the counter to the proofer is a real difference and the review
    // has to say so.
    const moved = UNCHANGED.map((s) =>
      s.sourceStageId === 'bulk'
        ? { ...s, environment: { ...env(20), equipmentId: 'eq-proofer' } }
        : s,
    );
    expect(diffProcess(REFERENCE, moved).hasChanges).toBe(true);
  });
});

describe('diffProcess — a stage the proposal altered', () => {
  it('reports only the facets that changed, at its position in the proposal', () => {
    const colder = UNCHANGED.map((s) =>
      s.sourceStageId === 'bulk'
        ? { ...s, label: 'Bulk ferment, cold', environment: env(4), duration: fixed(480) }
        : s,
    );

    const diff = diffProcess(REFERENCE, colder);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([
      {
        id: 'bulk',
        position: 2,
        label: { from: 'Bulk ferment', to: 'Bulk ferment, cold' },
        environment: { from: env(20), to: env(4) },
        duration: { from: fixed(90), to: fixed(480) },
      },
    ]);
    expect(diff.hasChanges).toBe(true);
  });

  it('carries the whole duration on each side, so a collapsed range is visible', () => {
    const flattened = UNCHANGED.map((s) =>
      s.sourceStageId === 'prove' ? { ...s, duration: fixed(30) } : s,
    );
    expect(diffProcess(REFERENCE, flattened).changed).toEqual([
      { id: 'prove', position: 4, duration: { from: range(45, 60), to: fixed(30) } },
    ]);
  });

  it('reports an environment or a criterion appearing from nothing', () => {
    const enriched = UNCHANGED.map((s) =>
      s.sourceStageId === 'shape'
        ? { ...s, environment: env(20), until: 'until it holds its shape' }
        : s,
    );
    expect(diffProcess(REFERENCE, enriched).changed).toEqual([
      {
        id: 'shape',
        position: 3,
        environment: { from: null, to: env(20) },
        until: { from: null, to: 'until it holds its shape' },
      },
    ]);
  });

  it('reports a stage changing side — active to wait', () => {
    const unattended = UNCHANGED.map((s) =>
      s.sourceStageId === 'bake' ? { ...s, kind: 'wait' as const } : s,
    );
    expect(diffProcess(REFERENCE, unattended).changed).toEqual([
      { id: 'bake', position: 5, kind: { from: 'active', to: 'wait' } },
    ]);
  });
});

describe('diffProcess — a split is a removal plus additions', () => {
  // THE CASE THE CONTRACT DOC AND THE ISSUE BOTH NAME. Ninety minutes of bulk on
  // the counter becomes twenty on the counter and eight hours in the fridge. There
  // is no `split` operation, and there must never be one: the ninety-minute bulk is
  // genuinely gone, and there is no honest answer to which half inherits it.
  const split: ProposedStage[] = [
    UNCHANGED[0]!,
    proposed('Bulk ferment, counter', 'bulk', { duration: fixed(20) }),
    proposed('Cold retard', 'bulk', { duration: fixed(480), environment: env(4) }),
    UNCHANGED[2]!,
    UNCHANGED[3]!,
    UNCHANGED[4]!,
  ];

  it('renders the original stage as removed and both halves as added', () => {
    const diff = diffProcess(REFERENCE, split);

    expect(diff.removed).toEqual([{ id: 'bulk', position: 2, label: 'Bulk ferment' }]);
    expect(diff.added).toEqual([
      { id: null, position: 2, label: 'Bulk ferment, counter' },
      { id: null, position: 3, label: 'Cold retard' },
    ]);
    expect(diff.hasChanges).toBe(true);
  });

  it('reports neither half as a change to the stage they both claim', () => {
    // The contested citation is honoured by NOBODY, which is what makes the split
    // fall out of a rule rather than out of a special case.
    expect(diffProcess(REFERENCE, split).changed).toEqual([]);
  });

  it('leaves every other stage alone', () => {
    const diff = diffProcess(REFERENCE, split);
    expect(diff.removed.map((r) => r.id)).toEqual(['bulk']);
    expect(diff.added.map((a) => a.label)).not.toContain('Mix and knead');
  });
});

describe('diffProcess — additions and removals', () => {
  it('treats an uncited stage as an addition', () => {
    // An AI-added fridge retard came from no stage at all, and says so.
    const withRetard = [
      ...UNCHANGED.slice(0, 2),
      proposed('Cold retard', null, { duration: fixed(480), environment: env(4) }),
      ...UNCHANGED.slice(2),
    ];
    const diff = diffProcess(REFERENCE, withRetard);
    expect(diff.added).toEqual([{ id: null, position: 3, label: 'Cold retard' }]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('treats a citation to a stage that is not there as an addition', () => {
    // The flow nulls a hallucinated citation before it ever gets here; this is the
    // belt to that pair of braces, and the answer is the same either way.
    const orphan = [...UNCHANGED, proposed('Second bake', 'stage-99')];
    expect(diffProcess(REFERENCE, orphan).added).toEqual([
      { id: null, position: 6, label: 'Second bake' },
    ]);
  });

  it('reports an uncited reference stage as removed, at its own position', () => {
    const withoutShape = UNCHANGED.filter((s) => s.sourceStageId !== 'shape');
    const diff = diffProcess(REFERENCE, withoutShape);
    expect(diff.removed).toEqual([{ id: 'shape', position: 3, label: 'Shape into the tin' }]);
    expect(diff.added).toEqual([]);
  });

  it('reports a whole process replaced as every stage removed and every stage added', () => {
    const replaced = [proposed('Do it differently', null)];
    const diff = diffProcess(REFERENCE, replaced);
    expect(diff.removed).toHaveLength(REFERENCE.length);
    expect(diff.added).toHaveLength(1);
    expect(diff.changed).toEqual([]);
  });
});
