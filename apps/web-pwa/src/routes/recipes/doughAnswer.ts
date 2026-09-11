import {
  DEFAULT_DOUGH_DEPTH_CM,
  doughGramsFromArea,
  doughGramsFromVolumeMl,
  roundGrams,
} from '@salt/domain';
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
// ONE PLACE WHERE THEY DIVERGE, AND IT IS AN ARGUMENT RATHER THAN A FORK (issue
// #1325). `doughAmountFrom` takes an optional dough-total anchor: with a count and
// a blank per-unit weight, the amount divides that anchor instead of resolving to
// nothing. "Five rolls out of this dough" is the commonest way the question gets
// asked, and on the formula screen it used to be division done on paper.
//
// THE BAKE SHEET PASSES NONE, and the reason is principled rather than scoping: a
// null amount there ALREADY MEANS "the formula's own reference yield"
// (`RecipeBakeBatchSheet.svelte`, and `canStart` never required an amount), so
// dividing would silently change what Start Bake does. Whether that screen should
// eventually offer the same gesture is open, and it needs its own decision about
// what a blank box means there.
//
// PAGE-LOCAL, in the shape `unitCount.ts` establishes: both consumers live in this
// folder, and `lib/` is for rules a `.ts` service also needs (issue #1055).

/**
 * The four answers, in the order the screens list them.
 *
 * `tin` leads because it is how the question is actually asked — "I have a 900 g
 * loaf tin, what do I put in to fill it". A UK tin is SOLD BY THE DOUGH IT TAKES,
 * so it needs no coefficient and no sum: the tin size IS the grams.
 *
 * `tray` is the only one that needs an estimate, and it is last for that reason: it
 * covers vessels sold with no trade name, where nothing about the thing says how
 * much dough it holds.
 */
export type DoughAnswerMode = 'tin' | 'pieces' | 'weight' | 'tray';

/** How an un-named vessel is being described. Two ways of saying the same volume. */
export type TrayBy = 'size' | 'volume';

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
  /** `tray`: which way the vessel is being described. */
  trayBy: TrayBy;
  /** `tray`, by size: the footprint in centimetres, and how deep the dough sits. */
  trayLengthText: string;
  trayWidthText: string;
  trayDepthText: string;
  /** `tray`, by volume: the figure, and whether it is millilitres or litres. */
  trayVolumeText: string;
  trayVolumeUnit: 'ml' | 'l';
  /**
   * `tray`: THE DOUGH WEIGHT, and an ordinary editable box like every other one
   * here. `suggestedTrayGrams` proposes a figure for it and the person can type
   * straight over the answer — which is the whole reason the coefficient can never
   * become load-bearing. See `doughAmount.ts` for why that matters.
   */
  trayGramsText: string;
}

// Aliased from the domain rather than re-declared, so the depth box's default and
// the depth the suggestion is computed at cannot drift apart.
export const DEFAULT_TRAY_DEPTH_CM = DEFAULT_DOUGH_DEPTH_CM;

export const EMPTY_DOUGH_ANSWER: DoughAnswerFields = {
  tinGramsText: '',
  tinCountText: '1',
  pieceCountText: '2',
  pieceGramsText: '',
  totalGramsText: '',
  trayBy: 'size',
  trayLengthText: '',
  trayWidthText: '',
  trayDepthText: String(DEFAULT_TRAY_DEPTH_CM),
  trayVolumeText: '',
  trayVolumeUnit: 'ml',
  trayGramsText: '',
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
 * What a blank per-unit box resolves to: the dough already there, shared out.
 *
 * UNROUNDED, deliberately. The divided amount then multiplies back to exactly the
 * anchor, so a caller that restates its weights at this declaration scales them by
 * a factor of precisely 1 and nothing moves — which is the whole point of the
 * gesture. Rounding here would put a factor of 0.999-something in its place, and
 * "five rolls out of this dough" would quietly reweigh the dough. A screen that
 * wants to SHOW the figure rounds it at the call, where the round can be seen.
 *
 * Nothing without both halves — a blank count is still no declaration, and no
 * anchor (or a formula with nothing in it) is nothing to divide.
 */
function dividedUnitGrams(count: number | null, anchorDoughGrams: number | null): number | null {
  if (count === null || anchorDoughGrams === null) return null;
  return Number.isFinite(anchorDoughGrams) && anchorDoughGrams > 0
    ? anchorDoughGrams / count
    : null;
}

/**
 * The answer as a dough amount, or nothing.
 *
 * NOTHING RATHER THAN A DEFAULT: a half-typed answer is not a lenient one with a
 * gap filled in, it is no declaration yet, and the same `null` that has always
 * disabled Save covers it without a second rule. `anchorDoughGrams` does not
 * soften that — it answers a DIFFERENT question ("how much does each of N get out
 * of this much dough") for the two answers that have an N, and only once the count
 * itself reads as a count.
 *
 * The typed figure always wins. The anchor is what a blank box falls back to, never
 * something layered over one.
 *
 * A plain weight is one of itself — `count: 1` — which is why the read-back for it
 * is "1.4 kg of dough" and not "1 × 1400 g". It takes no anchor, and neither does a
 * tray: a tray has its own suggest button, and a plain weight has nothing to divide.
 */
export function doughAmountFrom(
  mode: DoughAnswerMode,
  fields: DoughAnswerFields,
  anchorDoughGrams: number | null = null,
): DoughAmount | null {
  if (mode === 'tin') {
    const count = parseUnitCount(fields.tinCountText);
    const unitDoughGrams =
      parseGrams(fields.tinGramsText) ?? dividedUnitGrams(count, anchorDoughGrams);
    return unitDoughGrams === null || count === null ? null : { count, unitDoughGrams };
  }
  if (mode === 'pieces') {
    const count = parseUnitCount(fields.pieceCountText);
    const unitDoughGrams =
      parseGrams(fields.pieceGramsText) ?? dividedUnitGrams(count, anchorDoughGrams);
    return unitDoughGrams === null || count === null ? null : { count, unitDoughGrams };
  }
  if (mode === 'tray') {
    // The GRAMS BOX, never the measurement. The suggestion only ever proposes a
    // figure for that box; what scales the bake is whatever is in it.
    const unitDoughGrams = parseGrams(fields.trayGramsText);
    return unitDoughGrams === null ? null : { count: 1, unitDoughGrams };
  }
  const unitDoughGrams = parseGrams(fields.totalGramsText);
  return unitDoughGrams === null ? null : { count: 1, unitDoughGrams };
}

/**
 * What we would suggest a tray of this size takes, EXACT and unrounded.
 *
 * `null` while the measurement is incomplete — a tray with no width is not a
 * lenient tray with a default one. The depth is the ONE optional measurement, and
 * `doughGramsFromArea` owns its default so the box's initial value and the sum
 * cannot drift apart.
 */
function trayGramsExact(fields: DoughAnswerFields): number | null {
  if (fields.trayBy === 'volume') {
    const stated = parseGrams(fields.trayVolumeText);
    if (stated === null) return null;
    return doughGramsFromVolumeMl(fields.trayVolumeUnit === 'l' ? stated * 1000 : stated);
  }
  const lengthCm = parseGrams(fields.trayLengthText);
  const widthCm = parseGrams(fields.trayWidthText);
  if (lengthCm === null || widthCm === null) return null;
  const depthCm = parseGrams(fields.trayDepthText);
  return depthCm === null
    ? doughGramsFromArea(lengthCm, widthCm)
    : doughGramsFromArea(lengthCm, widthCm, depthCm);
}

/**
 * The suggestion, rounded for a box.
 *
 * A STARTING POINT, not an answer — the caller writes it into an ordinary editable
 * field and the person types over it if they disagree. The coefficient and its
 * stated boundary live in `packages/domain/src/formula/doughAmount.ts`; nothing
 * here has an opinion beyond turning a measurement into one.
 *
 * `doughGramsFromArea` delegates to `doughGramsFromVolumeMl`, so the same vessel
 * described two ways suggests the same weight — there is one coefficient, not two.
 */
export function suggestedTrayGrams(fields: DoughAnswerFields): number | null {
  const exact = trayGramsExact(fields);
  return exact === null ? null : roundGrams(exact);
}

/**
 * How a run describes what it was baked in, for `BatchSchema.vessel`.
 *
 * The vessel names the VESSEL and never the number of them: "900 g loaf tin", not
 * "2 × 900 g loaf tins". How many is already on the batch, at
 * `totals.units.count`, and a second copy is exactly the drift a snapshot note
 * must not introduce.
 *
 * Returned for the two answers that describe a vessel — a tin and a tray. A count
 * of pieces and a plain weight of dough name none, and an invented one would be a
 * fact nobody stated.
 */
export function vesselFrom(mode: DoughAnswerMode, fields: DoughAnswerFields): string | undefined {
  if (mode === 'tin') {
    const grams = parseGrams(fields.tinGramsText);
    // ROUNDED (issue #1325 review, blocking-1). The box this reads is ordinarily
    // already clean, but a batch's `vessel` snapshot is permanent the moment it is
    // written, so a float that slipped past `seedDoughAnswer`'s own round — or a
    // decimal typed by hand — must not freeze into it as "1031.9999999999998 g
    // loaf tin".
    return grams === null ? undefined : `${roundGrams(grams)} g loaf tin`;
  }
  if (mode === 'tray') {
    // FROM THE MEASUREMENT, never from the grams box — so a run whose suggested
    // weight was typed over still names the tray it was baked in. The descriptor
    // names the vessel; the number is `totals.units.unitDoughGrams`.
    if (fields.trayBy === 'volume') {
      const stated = parseGrams(fields.trayVolumeText);
      return stated === null ? undefined : `${stated} ${fields.trayVolumeUnit} dish`;
    }
    const lengthCm = parseGrams(fields.trayLengthText);
    const widthCm = parseGrams(fields.trayWidthText);
    return lengthCm === null || widthCm === null ? undefined : `${lengthCm} × ${widthCm} cm tray`;
  }
  return undefined;
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
  // ROUNDED (issue #1325 review, blocking-1). `amount.unitDoughGrams` can carry a
  // percentage round-trip's noise — a stored `1031.9999999999998` — and this is
  // the figure that lands verbatim in an editable box (the formula screen's "Tin
  // size (g)", the bake sheet's own boxes) and, from there, into a batch's
  // `vessel` string. The box stays an ordinary editable one; only what SEEDS it
  // is rounded.
  const grams = String(roundGrams(amount.unitDoughGrams));
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
