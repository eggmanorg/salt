import type { DoughAmount } from '@salt/domain/schemas';
import { parseUnitCount } from './unitCount.js';

// "What are you filling?" — the answers, as arithmetic (issue #1274).
//
// The two screens that ask are the bake sheet and the formula screen, and they are
// DELIBERATELY NOT one form rendered twice: they mean different things (tonight's
// run versus an edit to the recipe), they carry different warnings, and only one of
// them records a vessel. Collapsing them is how the defect this reworks got in.
//
// What they do share is the rule that turns a set of half-typed boxes into a
// `DoughAmount`, and that rule is here so the two screens cannot disagree about
// what "8 × 120 g" means. Everything below is pure and holds no component state.
//
// PAGE-LOCAL, in the shape `unitCount.ts` establishes: both consumers live in this
// folder, and `lib/` is for rules a `.ts` service also needs (issue #1055).

/**
 * The three answers phase 1 offers, in the order the screens list them.
 *
 * `tin` leads because it is how the question is actually asked — "I have a 900 g
 * loaf tin, what do I put in to fill it". A UK tin is SOLD BY THE DOUGH IT TAKES,
 * so it needs no coefficient and no sum: the tin size IS the grams. Phase 2 adds a
 * fourth answer for vessels with no such trade name.
 */
export type DoughAnswerMode = 'tin' | 'pieces' | 'weight';

/** The raw text of every box the three answers use, exactly as typed. */
export interface DoughAnswerFields {
  /** `tin`: the size stamped on the tin, in grams of dough. */
  tinGramsText: string;
  /** `tin`: how many tins. */
  tinCountText: string;
  /** `pieces`: how many. */
  pieceCountText: string;
  /** `pieces`: dough per piece, in grams. */
  pieceGramsText: string;
  /** `weight`: the whole dough, in grams. */
  totalGramsText: string;
}

export const EMPTY_DOUGH_ANSWER: DoughAnswerFields = {
  tinGramsText: '',
  tinCountText: '1',
  pieceCountText: '2',
  pieceGramsText: '',
  totalGramsText: '',
};

/** UK tins are sold as 1 lb and 2 lb. Quick fills beside the box, never instead of it. */
export const LOAF_TIN_CHIP_GRAMS: readonly number[] = [450, 900];

function parseGrams(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The answer as a dough amount, or nothing.
 *
 * NOTHING RATHER THAN A DEFAULT: a half-typed answer is not a lenient one with a
 * gap filled in, it is no declaration yet, and the same `null` that has always
 * disabled Save covers it without a second rule.
 *
 * A plain weight is one of itself — `count: 1` — which is why the read-back for it
 * is "1.4 kg of dough" and not "1 × 1400 g".
 */
export function doughAmountFrom(
  mode: DoughAnswerMode,
  fields: DoughAnswerFields,
): DoughAmount | null {
  if (mode === 'tin') {
    const unitDoughGrams = parseGrams(fields.tinGramsText);
    const count = parseUnitCount(fields.tinCountText);
    return unitDoughGrams === null || count === null ? null : { count, unitDoughGrams };
  }
  if (mode === 'pieces') {
    const unitDoughGrams = parseGrams(fields.pieceGramsText);
    const count = parseUnitCount(fields.pieceCountText);
    return unitDoughGrams === null || count === null ? null : { count, unitDoughGrams };
  }
  const unitDoughGrams = parseGrams(fields.totalGramsText);
  return unitDoughGrams === null ? null : { count: 1, unitDoughGrams };
}

/**
 * How a run describes the tin it was baked in, for `BatchSchema.vessel`.
 *
 * The vessel names the VESSEL and never the number of them: "900 g loaf tin", not
 * "2 × 900 g loaf tins". How many is already on the batch, at
 * `totals.units.count`, and a second copy is exactly the drift a snapshot note
 * must not introduce.
 *
 * Returned only for the tin answer. A count of pieces and a plain weight of dough
 * name no vessel, and an invented one would be a fact nobody stated.
 */
export function vesselFrom(mode: DoughAnswerMode, fields: DoughAnswerFields): string | undefined {
  if (mode !== 'tin') return undefined;
  const grams = parseGrams(fields.tinGramsText);
  return grams === null ? undefined : `${grams} g loaf tin`;
}

/**
 * Which answer a stored amount comes back as, when a screen is seeded from one.
 *
 * A formula stores grams and nothing else, so this cannot know whether one 900 g
 * unit was a tin or a boule — and it leads with the tin, because that is the
 * commonest thing one lot of dough goes into and because the bake sheet's whole
 * framing starts there. More than one unit is pieces: a run of eight is rolls, not
 * eight tins, far more often than not. Either way the person starting the bake is
 * looking at the answer before they press Start.
 */
export function seedDoughAnswer(amount: DoughAmount | null): {
  mode: DoughAnswerMode;
  fields: DoughAnswerFields;
} {
  if (amount === null) return { mode: 'tin', fields: { ...EMPTY_DOUGH_ANSWER } };
  const grams = String(amount.unitDoughGrams);
  if (amount.count === 1) {
    return {
      mode: 'tin',
      fields: { ...EMPTY_DOUGH_ANSWER, tinGramsText: grams, totalGramsText: grams },
    };
  }
  return {
    mode: 'pieces',
    fields: {
      ...EMPTY_DOUGH_ANSWER,
      pieceCountText: String(amount.count),
      pieceGramsText: grams,
    },
  };
}
