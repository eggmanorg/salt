import { describe, it, expect } from 'vitest';
import type { Recipe, RecipePhase } from '@salt/domain';
import { phaseTimelineBlocks, WAIT_CAP_MINUTES } from '../src/routes/recipes/phaseTimeline.js';
import { phaseMinutes } from '../src/routes/recipes/recipeTiming.js';

// The two rules the phase timeline rests on (issue #1122), tested without a DOM.
//
// `phaseTimelineBlocks` decides how wide a block is drawn — the ONLY judgement in
// the component, and the one place a lie is told on purpose (a twelve-hour prove
// is not drawn twelve hours wide). `phaseMinutes` decides when the phases answer
// "how long does this take" and when the old fields still do, which is what makes
// the migration invisible on five surfaces at once.

function phase(label: string, on: number, off: number): RecipePhase {
  return { label, handsOnMinutes: on, handsOffMinutes: off };
}

const BREAD = [
  phase('Mix & knead', 15, 0),
  phase('First rise', 0, 90),
  phase('Shape', 5, 0),
  phase('Prove overnight', 0, 720),
  phase('Bake', 2, 35),
];

describe('phaseTimelineBlocks — what the strip draws', () => {
  it('keeps the phases in the order they were written', () => {
    expect(phaseTimelineBlocks(BREAD).map((b) => b.label)).toEqual([
      'Mix & knead',
      'First rise',
      'Shape',
      'Prove overnight',
      'Bake',
    ]);
  });

  it('states each phase in true minutes, however it is drawn', () => {
    const overnight = phaseTimelineBlocks(BREAD)[3]!;
    expect(overnight.handsOffMinutes).toBe(720);
    expect(overnight.elapsedMinutes).toBe(720);
    expect(overnight.bands[0]!.minutes).toBe(720);
  });

  // The rule the whole component exists for. Drawn honestly, the 90-minute rise
  // and the 12-hour prove would be 10% and 82% of the strip and every hands-on
  // block would be a hairline. Capped, they are equal — which is the honest
  // reading of "you are out of the kitchen either way".
  it('draws a wait no wider than the cap, and marks the block that was shortened', () => {
    const blocks = phaseTimelineBlocks(BREAD);
    const rise = blocks[1]!;
    const overnight = blocks[3]!;

    expect(rise.compressed).toBe(true);
    expect(overnight.compressed).toBe(true);
    expect(overnight.widthPercent).toBeCloseTo(rise.widthPercent, 5);

    // And it is genuinely capped rather than merely small: 60 of a drawn total of
    // 15 + 60 + 5 + 60 + (2 + 35).
    const drawnTotal = 15 + WAIT_CAP_MINUTES + 5 + WAIT_CAP_MINUTES + 37;
    expect(overnight.widthPercent).toBeCloseTo((WAIT_CAP_MINUTES / drawnTotal) * 100, 5);
  });

  it('leaves a wait at or under the cap alone, and never marks it', () => {
    const [only] = phaseTimelineBlocks([phase('Rest', 10, WAIT_CAP_MINUTES)]);
    expect(only!.compressed).toBe(false);
    expect(only!.bands.map((b) => b.kind)).toEqual(['hands-on', 'wait']);
    // 10 hands-on against 60 of wait, drawn at its true length.
    expect(only!.bands[0]!.widthPercent).toBeCloseTo((10 / 70) * 100, 5);
  });

  it('never compresses hands-on time, however long it is', () => {
    const [marathon] = phaseTimelineBlocks([phase('Stir', 240, 0), phase('Rest', 0, 240)]);
    expect(marathon!.compressed).toBe(false);
    expect(marathon!.bands[0]!.widthPercent).toBe(100);
    // 240 of hands-on against a wait drawn at 60: the counter time dominates,
    // which is the thing the reader opened the page to find out.
    expect(marathon!.widthPercent).toBeCloseTo((240 / 300) * 100, 5);
  });

  it('gives a phase timed at zero no bands, and splits the strip evenly when every phase is', () => {
    const blocks = phaseTimelineBlocks([phase('A', 0, 0), phase('B', 0, 0)]);
    expect(blocks.map((b) => b.bands.length)).toEqual([0, 0]);
    expect(blocks.map((b) => b.widthPercent)).toEqual([50, 50]);
  });

  // Downstream of a permissive read boundary: `RecipePhaseSchema` types these as
  // plain `number`, so a stored document can carry any of the three.
  it('draws a NaN, an Infinity and a negative as nothing at all', () => {
    const [block] = phaseTimelineBlocks([
      phase('Broken', Number.NaN, Number.POSITIVE_INFINITY),
      phase('Real', 30, 0),
    ]);
    expect(block!.bands).toEqual([]);
    expect(block!.widthPercent).toBe(0);
    expect(phaseTimelineBlocks([phase('Negative', -5, 20)])[0]!.bands.map((b) => b.kind)).toEqual([
      'wait',
    ]);
  });

  // #1208 bullet 4. Three of the legend's four figures per row come through this
  // file's private `drawable` clamp; the fourth, `elapsedMinutes`, comes through
  // domain's `phaseElapsedMinutes` and its own unexported `safeMinutes`. The two
  // clamps are identical today and nothing but this test says they must stay so —
  // a drift shows up on screen as a legend row that does not add up.
  it('gives a legend row that adds up, for every value the schema admits', () => {
    const blocks = phaseTimelineBlocks([
      phase('Not a number', Number.NaN, 10),
      phase('Endless', 5, Number.POSITIVE_INFINITY),
      phase('Negative', -5, 20),
      phase('Zeroed by hand', 0, 0),
      phase('Ordinary', 15, 90),
    ]);
    for (const block of blocks) {
      expect(block.elapsedMinutes).toBe(block.handsOnMinutes + block.handsOffMinutes);
    }
  });

  it('has nothing to draw for an empty strip', () => {
    expect(phaseTimelineBlocks([])).toEqual([]);
  });
});

function recipeWith(phases: readonly RecipePhase[] | undefined): Recipe {
  return {
    cureCategory: null,
    id: 'r1',
    schemaVersion: 1,
    kind: 'recipe',
    title: 'Loaf',
    description: null,
    ingredients: [],
    steps: [],
    kit: [],
    metadata: {
      servings: null,
      tags: [],
      ...(phases === undefined ? {} : { phases: [...phases] }),
    },
    source: null,
    notes: null,
    producesCanonId: null,
    componentRecipeIds: [],
    image: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: '',
    lastEditedBy: '',
  };
}

describe('phaseMinutes — the strip answers, or nothing does', () => {
  it('sums the strip when there is one', () => {
    expect(phaseMinutes(recipeWith(BREAD))).toBe(867);
  });

  // Issue #1213 deleted the `phasesEnabled` argument and every per-surface
  // fallback. These fixtures all carry prep 20 / cook 40 / total 60, so a
  // fallback creeping back in would show up here as a number instead of a null
  // — which is the mechanical half of "no screen shows a prep, cook or total
  // time", pinned once rather than asserted on five surfaces in prose.
  it('answers null for a recipe written before the strip existed', () => {
    expect(phaseMinutes(recipeWith(undefined))).toBeNull();
  });

  it('answers null for a stored strip that is empty', () => {
    expect(phaseMinutes(recipeWith([]))).toBeNull();
  });

  // A cook who zeroed every phase has still stated a timing of nothing, which is
  // not the same as an unknown.
  it('answers zero — not null — for a strip a cook has zeroed by hand', () => {
    expect(phaseMinutes(recipeWith([phase('Assemble', 0, 0)]))).toBe(0);
  });
});
