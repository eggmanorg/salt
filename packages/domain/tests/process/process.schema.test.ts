import { describe, it, expect } from 'vitest';
import { FormulaSchema, StageDurationSchema } from '../../src/schemas/index.js';
import {
  ProcessSchema,
  ProcessStageContentSchema,
  ProcessStageSchema,
} from '../../src/schemas/process.js';

// The stage shape (issue #806, phase 2 of epic #778). What these pin, in order of
// how much it would cost to get wrong:
//
//   • a stage may be vague — no duration, no `until`, no temperature — and still
//     parse. A refine forcing one of them would fail the WHOLE formula document on
//     read and take the screen down over "I'll time it by eye";
//   • a range stays a range. The discriminated union is what stops 45–60 minutes
//     silently becoming 52.5;
//   • the AI's half of the shape carries no id.

const BULK_FERMENT = {
  id: 'stage-1',
  label: 'Bulk ferment',
  kind: 'wait' as const,
  environment: { celsius: 20 },
  duration: { kind: 'range' as const, minMinutes: 240, maxMinutes: 300 },
  until: 'until risen by half',
  stepId: 'step-2',
  optional: false,
};

describe('ProcessStageSchema', () => {
  it('parses a full stage', () => {
    expect(ProcessStageSchema.parse(BULK_FERMENT)).toEqual(BULK_FERMENT);
  });

  it('accepts a stage with no duration, no until and no environment', () => {
    // The vague stage. There is deliberately NO refine forcing a duration or an
    // `until`: `formulas/{recipeId}` is read as one document, so one under-filled
    // stage would surface as a corruption Failure and cost the user the whole
    // screen. Far too harsh a punishment for leaving a rest untimed.
    const vague = {
      ...BULK_FERMENT,
      environment: null,
      duration: null,
      until: null,
      stepId: null,
    };
    expect(ProcessStageSchema.safeParse(vague).success).toBe(true);
  });

  it('rejects a stage with no id — identity is the write path’s to mint', () => {
    const { id: _id, ...content } = BULK_FERMENT;
    expect(ProcessStageSchema.safeParse(content).success).toBe(false);
    // …and the content half, which is what the AI is asked for, parses without one.
    expect(ProcessStageContentSchema.safeParse(content).success).toBe(true);
  });

  it('has no id on the content half at all', () => {
    // Belt and braces on the split that keeps ids out of the model's hands: an id
    // that arrives from the AI is silently dropped rather than carried.
    const parsed = ProcessStageContentSchema.parse(BULK_FERMENT);
    expect(parsed).not.toHaveProperty('id');
  });

  it('only knows two kinds', () => {
    expect(ProcessStageSchema.safeParse({ ...BULK_FERMENT, kind: 'preheat' }).success).toBe(false);
  });

  it('caps relative humidity at a percentage', () => {
    const chamber = { ...BULK_FERMENT, environment: { celsius: 12, relativeHumidityPercent: 75 } };
    expect(ProcessStageSchema.safeParse(chamber).success).toBe(true);
    expect(
      ProcessStageSchema.safeParse({
        ...BULK_FERMENT,
        environment: { celsius: 12, relativeHumidityPercent: 175 },
      }).success,
    ).toBe(false);
  });

  it('allows a temperature at or below zero — a freezer is an environment', () => {
    expect(
      ProcessStageSchema.safeParse({ ...BULK_FERMENT, environment: { celsius: -18 } }).success,
    ).toBe(true);
  });
});

describe('ProcessStageSchema.optional — the recipe\u2019s opinion (issue #1275)', () => {
  it('defaults false over a document written before the field existed', () => {
    // THE BACK-COMPAT PIN. `formulas/{recipeId}` holds live documents, every one of
    // them written without this key, and the whole formula is read as ONE document:
    // a stage that failed to parse would take the screen down. A read default is
    // what makes the field free.
    const { optional: _optional, ...beforeTheField } = BULK_FERMENT;
    const parsed = ProcessStageSchema.safeParse(beforeTheField);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.optional).toBe(false);
  });

  it('carries a true through, on the content half as well as the stored one', () => {
    const { id: _id, ...content } = BULK_FERMENT;
    expect(ProcessStageSchema.parse({ ...BULK_FERMENT, optional: true }).optional).toBe(true);
    expect(ProcessStageContentSchema.parse({ ...content, optional: true }).optional).toBe(true);
  });

  it('is a boolean, not a permission — nothing else is expressible', () => {
    // The field gates nothing (see its comment in schemas/process.ts). Keeping it a
    // plain boolean is what stops it growing into a policy: there is no third value
    // for "optional but only if…" to land in.
    expect(ProcessStageSchema.safeParse({ ...BULK_FERMENT, optional: 'sometimes' }).success).toBe(
      false,
    );
  });
});

describe('StageDurationSchema', () => {
  it('keeps a range as a range rather than a min/max pair with a degenerate case', () => {
    // The union is the point: `{ fixed, 60 }` and `{ range, 45, 60 }` are different
    // claims, and a shape that could express the second as the first invites a
    // reader to average it.
    expect(StageDurationSchema.parse({ kind: 'fixed', minutes: 60 })).toEqual({
      kind: 'fixed',
      minutes: 60,
    });
    expect(StageDurationSchema.parse({ kind: 'range', minMinutes: 45, maxMinutes: 60 })).toEqual({
      kind: 'range',
      minMinutes: 45,
      maxMinutes: 60,
    });
  });

  it('refuses a duration of no time at all', () => {
    expect(StageDurationSchema.safeParse({ kind: 'fixed', minutes: 0 }).success).toBe(false);
  });
});

describe('FormulaSchema.process', () => {
  const FORMULA = {
    recipeId: 'overnight-white-tin',
    components: [{ ingredientId: 'ing-flour', percent: 100, inBasis: true }],
    referenceYield: { kind: 'basis', grams: 500 },
  };

  it('is optional — a formula with no process carries no empty scaffolding', () => {
    const parsed = FormulaSchema.parse(FORMULA);
    expect(parsed.process).toBeUndefined();
    // And the version does NOT move for it. `formulas` is greenfield; an added
    // optional field is not a migration.
    expect(parsed.schemaVersion).toBe(1);
  });

  it('carries the stages as a bare ordered array, not a wrapper object', () => {
    const parsed = FormulaSchema.parse({ ...FORMULA, process: [BULK_FERMENT] });
    expect(parsed.process).toEqual([BULK_FERMENT]);
    expect(ProcessSchema.safeParse([BULK_FERMENT]).success).toBe(true);
  });
});
