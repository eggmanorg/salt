import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRAY_DEPTH_CM,
  EMPTY_DOUGH_ANSWER,
  LOAF_TIN_CHIP_GRAMS,
  doughAmountFrom,
  seedDoughAnswer,
  suggestedTrayGrams,
  vesselFrom,
  type DoughAnswerFields,
} from '../src/routes/recipes/doughAnswer.js';

// "What are you filling?" as arithmetic (issue #1274) — the rule the bake sheet
// and the formula screen share, tested without mounting either.
//
// The two screens are deliberately NOT one form rendered twice (they mean
// different things and only one records a vessel), which is exactly why the rule
// that turns boxes into a `DoughAmount` has to live in one place: it is the one
// thing they must never disagree about.

function fields(overrides: Partial<DoughAnswerFields> = {}): DoughAnswerFields {
  return { ...EMPTY_DOUGH_ANSWER, ...overrides };
}

describe('doughAmountFrom', () => {
  it('starts the pieces answer at a plausible count, so only the grams need typing', () => {
    // Two, not one: "a number of pieces" is the answer you pick when there is more
    // than one of them, and a plain weight is the answer for one.
    expect(EMPTY_DOUGH_ANSWER.pieceCountText).toBe('2');
    expect(EMPTY_DOUGH_ANSWER.tinCountText).toBe('1');
  });

  it('reads a tin as its size × how many tins, with no coefficient in between', () => {
    // A UK tin is sold by the dough it takes, so the size IS the grams.
    expect(doughAmountFrom('tin', fields({ tinGramsText: '900', tinCountText: '2' }))).toEqual({
      count: 2,
      unitDoughGrams: 900,
    });
  });

  it('reads a count of pieces as itself', () => {
    expect(
      doughAmountFrom('pieces', fields({ pieceCountText: '8', pieceGramsText: '120' })),
    ).toEqual({ count: 8, unitDoughGrams: 120 });
  });

  it('reads a plain weight as one of itself', () => {
    // Which is why it reads back as "1.4 kg of dough" and not "1 × 1400 g".
    expect(doughAmountFrom('weight', fields({ totalGramsText: '1400' }))).toEqual({
      count: 1,
      unitDoughGrams: 1400,
    });
  });

  it('is nothing rather than a default while an answer is half-typed, with no anchor to divide', () => {
    // A gap is not a lenient answer with a number filled in — it is no
    // declaration yet, and `null` is what has always disabled Save.
    //
    // NARROWED BY ISSUE #1325: a blank per-unit weight is no longer a gap when the
    // caller hands over a dough total to divide. Every case below therefore passes
    // NO anchor, which is what the bake sheet does and what these four assertions
    // have always actually been about.
    expect(doughAmountFrom('tin', fields())).toBeNull();
    expect(doughAmountFrom('tin', fields({ tinGramsText: '900', tinCountText: '' }))).toBeNull();
    expect(doughAmountFrom('pieces', fields({ pieceCountText: '' }))).toBeNull();
    expect(doughAmountFrom('weight', fields())).toBeNull();
  });
});

// ─── "Divide what's already there" (issue #1325) ───────────────────────────────
//
// The formula screen hands over the dough its weight boxes already come to. A
// count with a blank per-unit box then shares that out instead of resolving to
// nothing — "five rolls out of this dough", which is how the question is usually
// asked and which used to be division done on paper.
//
// The bake sheet passes no anchor, so every one of these is `null` there. That is
// pinned on the sheet's own suite, not inferred from the default argument here.
describe('doughAmountFrom — a dough total to divide', () => {
  it('shares the dough out when the per-piece weight is blank', () => {
    expect(doughAmountFrom('pieces', fields({ pieceCountText: '5' }), 400)).toEqual({
      count: 5,
      unitDoughGrams: 80,
    });
  });

  it('does the same for a count of tins', () => {
    expect(doughAmountFrom('tin', fields({ tinCountText: '2' }), 1800)).toEqual({
      count: 2,
      unitDoughGrams: 900,
    });
  });

  it('multiplies back to exactly the anchor, so a restate moves nothing', () => {
    // UNROUNDED on purpose. 867 ÷ 5 is 173.4, and `5 × 173.4` is 867 again — the
    // restate factor is precisely 1. Round it to 173 here and the same gesture
    // would quietly reweigh the dough to 865 g.
    const amount = doughAmountFrom('pieces', fields({ pieceCountText: '5' }), 867);
    expect(amount).not.toBeNull();
    expect(amount!.count * amount!.unitDoughGrams).toBeCloseTo(867, 10);
  });

  it('lets the typed figure win, always', () => {
    // The anchor is what a blank box falls back to, never something layered over
    // one: 5 × 100 g is 500 g of dough, whatever the boxes above currently sum to.
    expect(
      doughAmountFrom('pieces', fields({ pieceCountText: '5', pieceGramsText: '100' }), 400),
    ).toEqual({ count: 5, unitDoughGrams: 100 });
  });

  it('still refuses a count that is not a count', () => {
    // A blank count is still no declaration — there is nothing to divide BY. The
    // anchor softens the weight box and nothing else.
    expect(doughAmountFrom('pieces', fields({ pieceCountText: '' }), 400)).toBeNull();
    expect(doughAmountFrom('pieces', fields({ pieceCountText: '2.5' }), 400)).toBeNull();
    expect(doughAmountFrom('tin', fields({ tinCountText: '0' }), 400)).toBeNull();
  });

  it('has nothing to divide when the formula is empty', () => {
    expect(doughAmountFrom('pieces', fields({ pieceCountText: '5' }), 0)).toBeNull();
    expect(doughAmountFrom('pieces', fields({ pieceCountText: '5' }), null)).toBeNull();
  });

  it('leaves the two answers with nothing to share out alone', () => {
    // A tray already has its suggest button, and a plain weight of dough has no
    // count to divide by. Neither reads the anchor at all.
    expect(doughAmountFrom('weight', fields(), 400)).toBeNull();
    expect(doughAmountFrom('tray', fields(), 400)).toBeNull();
  });

  it('names no vessel for a divided tin', () => {
    // `vesselFrom` reads the TIN BOX, never the resolved amount. A divided figure
    // is a dough weight — nobody said anything about a tin of that size, and a
    // vessel descriptor invented from one would be a fact nobody stated.
    expect(vesselFrom('tin', fields({ tinCountText: '2' }))).toBeUndefined();
  });

  it('refuses what the schema would refuse, rather than rounding it into shape', () => {
    // `DoughAmountSchema` is `count: int positive` and `unitDoughGrams: positive`.
    expect(doughAmountFrom('tin', fields({ tinGramsText: '900', tinCountText: '2.5' }))).toBeNull();
    expect(doughAmountFrom('tin', fields({ tinGramsText: '0', tinCountText: '1' }))).toBeNull();
    expect(doughAmountFrom('tin', fields({ tinGramsText: '-900', tinCountText: '1' }))).toBeNull();
    expect(doughAmountFrom('weight', fields({ totalGramsText: 'nine hundred' }))).toBeNull();
  });
});

describe('vesselFrom', () => {
  it('names the tin, and never how many of them', () => {
    // How many is already on the batch at `totals.units.count`; a second copy is
    // the drift a snapshot note exists to avoid.
    expect(vesselFrom('tin', fields({ tinGramsText: '900', tinCountText: '2' }))).toBe(
      '900 g loaf tin',
    );
  });

  it('names nothing for the two answers that describe no vessel', () => {
    expect(vesselFrom('pieces', fields({ pieceGramsText: '120' }))).toBeUndefined();
    expect(vesselFrom('weight', fields({ totalGramsText: '1400' }))).toBeUndefined();
  });

  it('names nothing while the tin size is unreadable', () => {
    expect(vesselFrom('tin', fields())).toBeUndefined();
    expect(vesselFrom('tin', fields({ tinGramsText: 'big' }))).toBeUndefined();
  });
});

describe('seedDoughAnswer', () => {
  it('leads with the tin for one unit, carrying its weight into both weight boxes', () => {
    const seeded = seedDoughAnswer({ count: 1, unitDoughGrams: 900 });
    expect(seeded.mode).toBe('tin');
    expect(seeded.fields.tinGramsText).toBe('900');
    expect(seeded.fields.tinCountText).toBe('1');
    // Switching to "a weight of dough" must not lose the figure.
    expect(seeded.fields.totalGramsText).toBe('900');
  });

  it('reads more than one unit as pieces — a run of eight is rolls, not eight tins', () => {
    const seeded = seedDoughAnswer({ count: 8, unitDoughGrams: 120 });
    expect(seeded.mode).toBe('pieces');
    expect(seeded.fields.pieceCountText).toBe('8');
    expect(seeded.fields.pieceGramsText).toBe('120');
  });

  it('seeds nothing from a basis-driven formula, and still leads with the tin', () => {
    const seeded = seedDoughAnswer(null);
    expect(seeded.mode).toBe('tin');
    expect(doughAmountFrom(seeded.mode, seeded.fields)).toBeNull();
  });

  it('round-trips every seeded answer back to the amount it came from', () => {
    for (const amount of [
      { count: 1, unitDoughGrams: 900 },
      { count: 2, unitDoughGrams: 450 },
      { count: 12, unitDoughGrams: 120 },
    ]) {
      const seeded = seedDoughAnswer(amount);
      expect(doughAmountFrom(seeded.mode, seeded.fields)).toEqual(amount);
    }
  });
});

describe('LOAF_TIN_CHIP_GRAMS', () => {
  it('is the two sizes UK tins are sold as, and nothing resembling a catalogue', () => {
    // 1 lb and 2 lb. They are quick fills BESIDE the number box, never instead of
    // it: a size carries no thing-name and no loss figure, so a longer list would
    // be an affordance masquerading as data (issue #1274).
    expect([...LOAF_TIN_CHIP_GRAMS]).toEqual([450, 900]);
  });
});

// ─── The fourth answer: a vessel with no trade name (issue #1274, phase 2) ──────
describe('a tray or dish', () => {
  it('scales by the GRAMS BOX, never by the measurement', () => {
    // The measurement only ever proposes a figure. What the bake is scaled by is
    // whatever is in the box — which is what stops the coefficient becoming
    // load-bearing (rule-12 claim 4).
    expect(
      doughAmountFrom('tray', fields({ trayLengthText: '30', trayWidthText: '40' })),
    ).toBeNull();
    expect(
      doughAmountFrom(
        'tray',
        fields({ trayLengthText: '30', trayWidthText: '40', trayGramsText: '850' }),
      ),
    ).toEqual({ count: 1, unitDoughGrams: 850 });
  });

  it('suggests the same weight whichever way the same vessel is described', () => {
    const bySize = suggestedTrayGrams(
      fields({ trayBy: 'size', trayLengthText: '20', trayWidthText: '25', trayDepthText: '4' }),
    );
    const byVolume = suggestedTrayGrams(
      fields({ trayBy: 'volume', trayVolumeText: '2', trayVolumeUnit: 'l' }),
    );
    expect(bySize).toBe(byVolume);
  });

  it('reads litres as a thousand millilitres', () => {
    expect(suggestedTrayGrams(fields({ trayBy: 'volume', trayVolumeText: '2000' }))).toBe(
      suggestedTrayGrams(fields({ trayBy: 'volume', trayVolumeText: '2', trayVolumeUnit: 'l' })),
    );
  });

  it('takes the default dough depth when the depth box is left empty', () => {
    // The one OPTIONAL measurement. An empty depth is not a tray of no depth.
    expect(
      suggestedTrayGrams(fields({ trayLengthText: '30', trayWidthText: '40', trayDepthText: '' })),
    ).toBe(
      suggestedTrayGrams(
        fields({
          trayLengthText: '30',
          trayWidthText: '40',
          trayDepthText: String(DEFAULT_TRAY_DEPTH_CM),
        }),
      ),
    );
  });

  it('suggests nothing while the measurement is incomplete', () => {
    expect(suggestedTrayGrams(fields())).toBeNull();
    expect(suggestedTrayGrams(fields({ trayLengthText: '30' }))).toBeNull();
    expect(suggestedTrayGrams(fields({ trayBy: 'volume' }))).toBeNull();
  });

  it('lands in the domestic ballpark on both anchors', () => {
    // The claim and its boundary are stated in `doughAmount.ts` and pinned in the
    // domain; this is the same check through the screens' own path, so a unit slip
    // here cannot pass while the domain test stays green.
    const dish = suggestedTrayGrams(
      fields({ trayBy: 'volume', trayVolumeText: '2', trayVolumeUnit: 'l' }),
    )!;
    const tray = suggestedTrayGrams(fields({ trayLengthText: '30', trayWidthText: '40' }))!;
    expect(Math.abs(dish - 900) / 900).toBeLessThanOrEqual(0.15);
    expect(Math.abs(tray - 1000) / 1000).toBeLessThanOrEqual(0.15);
  });

  it('names the tray it was baked in, from the measurement and not the weight', () => {
    // So a run whose suggested weight was typed over still names its tray.
    expect(
      vesselFrom(
        'tray',
        fields({ trayLengthText: '30', trayWidthText: '40', trayGramsText: '1500' }),
      ),
    ).toBe('30 × 40 cm tray');
    expect(
      vesselFrom('tray', fields({ trayBy: 'volume', trayVolumeText: '2', trayVolumeUnit: 'l' })),
    ).toBe('2 l dish');
  });

  it('names nothing while the measurement is incomplete', () => {
    expect(vesselFrom('tray', fields({ trayGramsText: '900' }))).toBeUndefined();
    expect(
      vesselFrom('tray', fields({ trayLengthText: '30', trayGramsText: '900' })),
    ).toBeUndefined();
  });

  it('carries no grams in the descriptor — the grams already live on the batch', () => {
    const vessel = vesselFrom(
      'tray',
      fields({ trayLengthText: '30', trayWidthText: '40', trayGramsText: '1080' }),
    )!;
    expect(vessel).not.toMatch(/1080|\bg\b/);
  });
});
