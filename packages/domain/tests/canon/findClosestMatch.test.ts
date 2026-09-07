import { describe, it, expect, vi } from 'vitest';
import { findClosestMatch } from '../../src/canon/queries/findClosestMatch.js';
import { findExactCanonMatch } from '../../src/canon/queries/findExactCanonMatch.js';
import { normaliseName } from '../../src/canon/queries/normaliseName.js';
import { MATCH_THRESHOLDS } from '../../src/canon/queries/matchThresholds.js';
import type { CanonItem } from '../../src/canon/entities/CanonItem.js';
import type { StageLog } from '../../src/canon/entities/MatchLogEntry.js';
import { MatchLogBuilder } from '../../src/canon/commands/buildMatchLog.js';

function item(overrides: Partial<CanonItem> & { id: string; name: string }): CanonItem {
  return {
    schemaVersion: 5,
    synonyms: [],
    aisleId: null,
    thumbnail: null,
    embedding: null,
    needs_approval: false,
    shoppingBehavior: 'needed',
    updatedAt: '',
    ...overrides,
  };
}

const catalog: readonly CanonItem[] = [
  item({ id: '1', name: 'Tomato', synonyms: ['tom', 'tomate'] }),
  item({ id: '2', name: 'Olive Oil', synonyms: ['EVOO'] }),
  item({ id: '3', name: 'Butter', synonyms: [] }),
  item({ id: '4', name: 'Peanut Butter', synonyms: [] }),
];

// More than 5 items — needed so the top-5 slice in `runScoredStage` is
// actually reachable (see the structural-parity block below).
const bigCatalog: readonly CanonItem[] = [
  ...catalog,
  item({ id: '5', name: 'Basil', synonyms: [] }),
  item({ id: '6', name: 'Oregano', synonyms: [] }),
  item({ id: '7', name: 'Garlic', synonyms: [] }),
];

describe('findClosestMatch — stage 1: exact normalised name match', () => {
  it('returns stage 1 match for exact name after normalisation', () => {
    const result = findClosestMatch(catalog, '  TOMATO  ');
    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.candidate.stage).toBe(1);
      expect(result.candidate.item.id).toBe('1');
      expect(result.candidate.confidence).toBe(1.0);
    }
  });

  it('handles multi-word exact match', () => {
    const result = findClosestMatch(catalog, 'olive oil');
    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.candidate.stage).toBe(1);
      expect(result.candidate.item.id).toBe('2');
    }
  });

  it('handles plurals via singularization', () => {
    const result = findClosestMatch(catalog, 'tomatoes');
    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.candidate.stage).toBe(1);
      expect(result.candidate.item.id).toBe('1');
    }
  });

  it('returns ambiguous when two items share the same normalised name', () => {
    const a = item({ id: 'a', name: 'apple' });
    const b = item({ id: 'b', name: 'Apple' }); // same normalised name
    const result = findClosestMatch([a, b], 'apple');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });
});

describe('findClosestMatch — stage 2: token overlap', () => {
  it('returns stage 2 match when token overlap meets threshold', () => {
    const hit = findClosestMatch(
      [item({ id: 'x', name: 'Extra Virgin Olive Oil Sauce', synonyms: [] })],
      'extra virgin olive oil',
    );
    expect(hit.kind).toBe('match');
    if (hit.kind === 'match') {
      expect(hit.candidate.stage).toBe(2);
      expect(hit.candidate.confidence).toBeGreaterThanOrEqual(0.8);
    }
  });

  it('does not proceed beyond stage 2 when threshold met with clear gap', () => {
    const items = [item({ id: 'x', name: 'Extra Virgin Olive Oil Sauce', synonyms: ['evoos'] })];
    const result = findClosestMatch(items, 'extra virgin olive oil');
    // Only one candidate above threshold → gap is large → match at stage 2
    expect(result.kind).toBe('match');
    if (result.kind === 'match') expect(result.candidate.stage).toBe(2);
  });

  it('returns ambiguous when two candidates score above stage2Stop within ambiguityGap', () => {
    // Both items have the same token overlap score against 'peanut butter'
    const pb1 = item({ id: 'pb1', name: 'peanut butter smooth' });
    const pb2 = item({ id: 'pb2', name: 'peanut butter crunchy' });
    // Both score: tokenMatch('peanut butter', 'peanut butter smooth') and 'peanut butter crunchy'
    // 'peanut butter' (2 tokens) vs 'peanut butter smooth' (3 tokens): overlap=2, max=3 → 0.67 < 0.8
    // Need a case where best >= 0.8 but gap < 0.05
    // 'peanut butter smooth extra' (4 tokens) vs 'peanut butter' (2 tokens):
    //   tokenMatch = 2/4 = 0.5 < 0.8
    // Direct tie: two identical-scoring items that both pass stage2Stop
    const a = item({ id: 'a', name: 'extra virgin olive oil' });
    const b = item({ id: 'b', name: 'extra virgin olive oil' }); // identical normalised name
    // Stage 1 catches identical names → won't reach stage 2.
    // So test a real near-tie at stage 2:
    // 'a b c d e' vs 'a b c d e f' = 5/6 ≈ 0.833 and 'a b c d e g' = 5/6 ≈ 0.833 → tie
    const item1 = item({ id: 'i1', name: 'alpha beta gamma delta epsilon zeta' });
    const item2 = item({ id: 'i2', name: 'alpha beta gamma delta epsilon eta' });
    const result = findClosestMatch([item1, item2], 'alpha beta gamma delta epsilon');
    // Both items score 5/max(5,6)=5/6≈0.833 ≥ stage2Stop(0.8), gap=0 < ambiguityGap(0.05)
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.length).toBeGreaterThanOrEqual(2);
      expect(result.candidates.every((c) => c.stage === 2)).toBe(true);
    }
  });

  it('auto-matches the clear winner when gap >= ambiguityGap at stage 2', () => {
    // Only one candidate above stage2Stop → gap is large → clear match
    const items = [
      item({ id: 'x', name: 'Extra Virgin Olive Oil Sauce' }),
      item({ id: 'y', name: 'Tomato' }),
    ];
    const result = findClosestMatch(items, 'extra virgin olive oil');
    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.candidate.item.id).toBe('x');
      expect(result.candidate.stage).toBe(2);
    }
  });
});

describe('findClosestMatch — stage 3: synonym match', () => {
  it('returns stage 3 for exact synonym hit', () => {
    const result = findClosestMatch(catalog, 'tom');
    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.candidate.stage).toBe(3);
      expect(result.candidate.item.id).toBe('1');
      expect(result.candidate.confidence).toBe(1.0);
    }
  });

  it('is case-insensitive for synonyms', () => {
    const result = findClosestMatch(catalog, 'evoo');
    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.candidate.stage).toBe(3);
      expect(result.candidate.item.id).toBe('2');
    }
  });

  it('matches synonym plurals via singularization', () => {
    const result = findClosestMatch(catalog, 'toms');
    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.candidate.stage).toBe(3);
      expect(result.candidate.item.id).toBe('1');
    }
  });
});

describe('findClosestMatch — stage 4: string similarity', () => {
  it('returns stage 4 for a near-match above threshold', () => {
    // 'tomatoe' → distance 1 from 'tomato', score ~0.857 >= 0.85
    const result = findClosestMatch(catalog, 'tomatoe');
    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.candidate.stage).toBe(4);
      expect(result.candidate.item.id).toBe('1');
      expect(result.candidate.confidence).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('returns ambiguous when two candidates score above stage4Stop within ambiguityGap', () => {
    // Two very similar strings, both score >= 0.85 with a small gap between them
    const itemA = item({ id: 'a', name: 'tomatoe' }); // edit distance 1 from 'tomato' → ~0.857
    const itemB = item({ id: 'b', name: 'tomatox' }); // edit distance 1 from 'tomato' → ~0.857
    const result = findClosestMatch([itemA, itemB], 'tomato');
    // Both score ~0.857, gap ≈ 0 < ambiguityGap (0.05) → ambiguous
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.length).toBe(2);
      expect(result.candidates.every((c) => c.stage === 4)).toBe(true);
    }
  });
});

describe('findClosestMatch — no match', () => {
  it('returns none for an unrelated query', () => {
    expect(findClosestMatch(catalog, 'chia seeds').kind).toBe('none');
  });

  it('returns none for blank input', () => {
    expect(findClosestMatch(catalog, '   ').kind).toBe('none');
    expect(findClosestMatch(catalog, '').kind).toBe('none');
  });

  it('returns none for empty catalog', () => {
    expect(findClosestMatch([], 'tomato').kind).toBe('none');
  });
});

// Additive (issue #937, Phase 2). A candidate this function returns was built at
// exactly one stage, so its provenance is that stage and nothing else — the
// accumulation across signals happens later, in `buildShortlist`. Asserted rather
// than assumed because the degraded AI-failure fallback now reads this field to
// decide whether edit distance is a candidate's ONLY support, and a stage that
// forgot to populate it would not fail to compile once the field exists.
describe('findClosestMatch — candidate provenance', () => {
  it('records the constructing stage as the sole supporting signal', () => {
    const cases: Array<{ query: string; items: readonly CanonItem[]; stage: number }> = [
      { query: 'tomato', items: catalog, stage: 1 },
      {
        query: 'extra virgin olive oil',
        items: [item({ id: 'x', name: 'Extra Virgin Olive Oil Sauce' })],
        stage: 2,
      },
      { query: 'evoo', items: catalog, stage: 3 },
      { query: 'buttter', items: [item({ id: '3', name: 'Butter' })], stage: 4 },
    ];

    for (const { query, items, stage } of cases) {
      const result = findClosestMatch(items, query);
      expect(result.kind, query).toBe('match');
      if (result.kind === 'match') {
        expect(result.candidate.stage, query).toBe(stage);
        expect(result.candidate.supportedStages, query).toEqual([stage]);
      }
    }
  });

  it('records provenance on ambiguous candidates too', () => {
    const twins = [item({ id: 'a', name: 'Tomato' }), item({ id: 'b', name: 'tomato' })];
    const result = findClosestMatch(twins, 'tomato');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      for (const c of result.candidates) expect(c.supportedStages).toEqual([1]);
    }
  });
});

// Additive (issue #937, Phase 3). Stages 2 and 4 are now one helper run with a
// different scorer, threshold, ordinal and name. That removes the divergence risk
// the duplication carried — but only for as long as they stay merged, and nothing
// stops a later edit inlining one of them again. These assertions are what make
// the property survive that: they compare the two stages' emitted StageLogs
// directly, so a divergence in the gap convention on miss and pass,
// `consideredCount`, `skipReason`, the StageLog key set, or the top-5 slicing
// landing in one half and not the other fails here rather than in production
// telemetry months later. A per-stage threshold value itself is NOT pinned by
// this block — both gap assertions derive their expectation from the same
// emitted log, so they are self-consistent with any threshold; only a
// gap-CONVENTION change is caught.
//
// Deliberately NOT asserted against stages 1 and 3: those are set-membership
// shaped and use a different gap convention (1.0 single / 0.0 tie / null miss),
// which is why they were left out of the extraction.
describe('findClosestMatch — stages 2 and 4 stay structurally identical', () => {
  function stagesFor(items: readonly CanonItem[], query: string): Map<number, StageLog> {
    const log = new MatchLogBuilder();
    log.start(query, query);
    findClosestMatch(items, query, log);
    const entry = log.complete('run', 'created', null);
    return new Map(entry.stages.map((s) => [s.stage, s]));
  }

  it('emits the same StageLog keys for both scored stages', () => {
    // "tomato paste" clears neither stage 2's 0.80 nor stage 4's 0.85 against this
    // catalog (both best out at 0.5), so both stages run to completion and log.
    const stages = stagesFor(catalog, 'tomato paste');
    const s2 = stages.get(2);
    const s4 = stages.get(4);
    expect(s2).toBeDefined();
    expect(s4).toBeDefined();
    expect(Object.keys(s2!).sort()).toEqual(Object.keys(s4!).sort());
  });

  it('uses the same gap convention on a miss: bestScore − threshold, never null', () => {
    const stages = stagesFor(catalog, 'tomato paste');
    for (const stage of [2, 4] as const) {
      const s = stages.get(stage)!;
      expect(s.passed, `stage ${stage}`).toBe(false);
      expect(s.bestScore, `stage ${stage}`).not.toBeNull();
      expect(s.gap, `stage ${stage}`).toBeCloseTo(s.bestScore! - s.threshold, 10);
    }
  });

  it('uses the same gap convention on a pass: bestScore − secondScore', () => {
    // One run per stage, because a passing stage 2 returns before stage 4 runs.
    const cases = [
      {
        stage: 2 as const,
        items: [item({ id: 'x', name: 'Extra Virgin Olive Oil Sauce' })],
        query: 'extra virgin olive oil',
      },
      { stage: 4 as const, items: [item({ id: 'y', name: 'Butter' })], query: 'buttter' },
    ];

    for (const { stage, items, query } of cases) {
      const s = stagesFor(items, query).get(stage);
      expect(s, `stage ${stage}`).toBeDefined();
      expect(s!.passed, `stage ${stage}`).toBe(true);
      // Single candidate → second score is 0, so gap === bestScore. Asserted via
      // the top-candidate list rather than restating the arithmetic, so the two
      // stages are compared on the same derivation.
      const second = s!.topCandidates[1]?.score ?? 0;
      expect(s!.gap, `stage ${stage}`).toBeCloseTo(s!.bestScore! - second, 10);
    }
  });

  it('records consideredCount and skipReason identically — both stages score the whole catalog', () => {
    const stages = stagesFor(catalog, 'tomato paste');
    for (const stage of [2, 4] as const) {
      const s = stages.get(stage)!;
      expect(s.consideredCount, `stage ${stage}`).toBe(catalog.length);
      expect(s.skipReason, `stage ${stage}`).toBeNull();
    }
  });

  // A 4-item catalog can never exercise the top-5 slice — the bound is
  // unreachable, and the two stages are never actually compared to each
  // other, so a re-inlined stage 4 sliced to e.g. `slice(0, 2)` would still
  // pass a `toBeLessThanOrEqual(5)` assertion taken per stage. `bigCatalog`
  // has more than five items, all scoring well below both stop thresholds
  // against 'tomato paste' (verified: token and Levenshtein both ≤ 0.5), so
  // both stages miss, both log to completion, and the slice is compared
  // directly between the two stages rather than against a constant.
  it('slices to the same top-5 bound in both stages — compared to each other, not just to 5', () => {
    const stages = stagesFor(bigCatalog, 'tomato paste');
    const s2 = stages.get(2)!;
    const s4 = stages.get(4)!;
    expect(s2.topCandidates.length).toBeLessThanOrEqual(5);
    expect(s4.topCandidates.length).toBe(s2.topCandidates.length);
  });
});

// Two items whose names normalise to the same string — the stage-1 tie.
const nameTwins: readonly CanonItem[] = [
  item({ id: 'a', name: 'apple' }),
  item({ id: 'b', name: 'Apple' }),
];

// Six items that all normalise to 'apple'. Six, not five, because the stage-1
// log slices its candidate list to 5 and nothing in the suite reached that bound
// before: with five or fewer the slice is unobservable and a rewrite could drop
// it, or slice to a different width, with every assertion still green.
const sixNameTwins: readonly CanonItem[] = [
  item({ id: 't1', name: 'apple' }),
  item({ id: 't2', name: 'Apple' }),
  item({ id: 't3', name: 'APPLE' }),
  item({ id: 't4', name: 'Apples' }),
  item({ id: 't5', name: 'APPLES' }),
  item({ id: 't6', name: 'ApPlE' }),
];

function stage1For(items: readonly CanonItem[], query: string): StageLog | undefined {
  const log = new MatchLogBuilder();
  log.start(query, query);
  findClosestMatch(items, query, log);
  return log.complete('run', 'created', null).stages.find((s) => s.stage === 1);
}

// Additive (issue #971, Phase 1). Characterization, written and verified green
// against UNCHANGED source before stage 1's hand-rolled winner loop was replaced
// by the shared `exactNameMatch` helper. Every existing stage-1 test reads the
// RETURN value; none read the emitted StageLog, so `bestScore`, `gap`,
// `topCandidates` ordering and the ≤5 slice were unpinned telemetry — a rewrite
// of that block could have changed all four with the suite still green. These
// assertions describe today's output exactly; if one of them ever needs a source
// edit to pass, the assertion is what is wrong, not the code.
//
// `durationMs` is deliberately not asserted: it is wall-clock and unpinnable.
describe('findClosestMatch — stage 1 emits a fully-specified StageLog', () => {
  it('logs a single winner: passed, bestScore 1.0, gap 1.0, one candidate', () => {
    const s = stage1For(catalog, '  TOMATO  ');
    expect(s).toBeDefined();
    expect(s!.stage).toBe(1);
    expect(s!.stageName).toBe('exact_name');
    expect(s!.threshold).toBe(MATCH_THRESHOLDS.stage1Stop);
    expect(s!.passed).toBe(true);
    expect(s!.consideredCount).toBe(catalog.length);
    expect(s!.skipReason).toBeNull();
    expect(s!.bestScore).toBe(1.0);
    expect(s!.gap).toBe(1.0);
    expect(s!.topCandidates).toEqual([{ itemId: '1', itemName: 'Tomato', score: 1.0 }]);
  });

  it('logs a two-way tie: passed, bestScore 1.0, gap 0.0, both candidates in catalog order', () => {
    const s = stage1For(nameTwins, 'apple');
    expect(s).toBeDefined();
    expect(s!.passed).toBe(true);
    expect(s!.consideredCount).toBe(2);
    expect(s!.skipReason).toBeNull();
    expect(s!.bestScore).toBe(1.0);
    expect(s!.gap).toBe(0.0);
    expect(s!.topCandidates).toEqual([
      { itemId: 'a', itemName: 'apple', score: 1.0 },
      { itemId: 'b', itemName: 'Apple', score: 1.0 },
    ]);
  });

  it('logs a miss: not passed, bestScore null, gap null, no candidates', () => {
    const s = stage1For(catalog, 'chia seeds');
    expect(s).toBeDefined();
    expect(s!.stageName).toBe('exact_name');
    expect(s!.threshold).toBe(MATCH_THRESHOLDS.stage1Stop);
    expect(s!.passed).toBe(false);
    expect(s!.consideredCount).toBe(catalog.length);
    expect(s!.skipReason).toBeNull();
    expect(s!.bestScore).toBeNull();
    expect(s!.gap).toBeNull();
    expect(s!.topCandidates).toEqual([]);
  });

  it('slices the logged candidates to 5 on a six-way tie, in catalog order', () => {
    const s = stage1For(sixNameTwins, 'apple');
    expect(s).toBeDefined();
    expect(s!.passed).toBe(true);
    expect(s!.consideredCount).toBe(6);
    expect(s!.gap).toBe(0.0);
    expect(s!.topCandidates).toEqual([
      { itemId: 't1', itemName: 'apple', score: 1.0 },
      { itemId: 't2', itemName: 'Apple', score: 1.0 },
      { itemId: 't3', itemName: 'APPLE', score: 1.0 },
      { itemId: 't4', itemName: 'Apples', score: 1.0 },
      { itemId: 't5', itemName: 'APPLES', score: 1.0 },
    ]);
  });

  it('slices the LOG only — the returned ambiguous set still carries all six', () => {
    const result = findClosestMatch(sixNameTwins, 'apple');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((c) => c.item.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    }
  });
});

// Additive (issue #971, Phase 1). WHAT THIS BLOCK IS FOR: `findClosestMatch`
// stage 1 and `findExactCanonMatch` both answer one question — "does this text
// spell out this item's own name?" — and they answered it in two hand-written
// copies of the same expression, in two files. #971 replaces both with a single
// `exactNameMatch` helper, but a helper can always be inlined again by a later
// edit, and nothing about the extraction itself stops the two halves drifting.
//
// Per CLAUDE.md Rule 12 the anti-drift claim is made mechanical rather than
// asserted in a comment: this block runs both functions over one input table and
// fails if they ever disagree about which item a string exactly names. It is
// deliberately written against the two PUBLIC functions, not against the shared
// helper, so it keeps working — and keeps failing on divergence — whether the
// predicate lives in one place or two.
//
// Verified red before being trusted: re-inlining a DIFFERENT name predicate in
// `findExactCanonMatch` (raw `item.name === target`, skipping normalisation)
// fails the case/space/plural and synonym-precedence rows here.
//
// Stage 1's winner set is read off its StageLog rather than guessed, so the
// oracle for "did stage 1 hit" is the code's own emitted decision.
describe('findClosestMatch stage 1 and findExactCanonMatch never disagree', () => {
  const impostorAndReal: readonly CanonItem[] = [
    item({ id: 'imp', name: 'Something Else', synonyms: ['tomato'] }),
    item({ id: '1', name: 'Tomato' }),
  ];

  // Folding fixtures (issue #1269). The original table was all-ASCII, so a
  // re-inlined predicate that skipped `normalize('NFD')` or the hyphen rule
  // would have agreed with stage 1 on every row and gone green. These three name
  // the foldings `normaliseName` performs that nothing else here exercised.
  const accented: readonly CanonItem[] = [item({ id: 'cf', name: 'Crème Fraîche' })];
  const plainNamed: readonly CanonItem[] = [item({ id: 'cf2', name: 'Creme Fraiche' })];
  const hyphenated: readonly CanonItem[] = [item({ id: 'so', name: 'Spring-Onion' })];

  const table: ReadonlyArray<{
    readonly label: string;
    readonly items: readonly CanonItem[];
    readonly query: string;
  }> = [
    { label: 'exact name', items: catalog, query: 'Tomato' },
    { label: 'case and spacing folded', items: catalog, query: '  TOMATO  ' },
    { label: 'plural folded', items: catalog, query: 'tomatoes' },
    { label: 'multi-word exact name', items: catalog, query: 'olive oil' },
    {
      label: 'name beats another item holding it as a synonym',
      items: impostorAndReal,
      query: 'tomato',
    },
    {
      label: 'diacritics stripped — accented name, plain query',
      items: accented,
      query: 'creme fraiche',
    },
    {
      label: 'diacritics stripped — plain name, accented query',
      items: plainNamed,
      query: 'Crème Fraîche',
    },
    { label: 'hyphen folded to a space', items: hyphenated, query: 'spring onions' },
    {
      label: 'accented query against its own accented name',
      items: accented,
      query: 'CRÈME FRAÎCHE',
    },
    // The looser-predicate direction: a prefix that shares a token with two
    // catalog names must NOT be a stage-1 hit. Every other miss row here is a
    // total stranger, which a too-loose predicate can still get right.
    { label: 'near-miss — shares a token, names nothing', items: catalog, query: 'peanut' },
    { label: 'synonym only — stage 1 misses', items: catalog, query: 'evoo' },
    { label: 'two-way name tie', items: nameTwins, query: 'apple' },
    { label: 'six-way name tie', items: sixNameTwins, query: 'apple' },
    { label: 'no match at all', items: catalog, query: 'chia seeds' },
    { label: 'blank input', items: catalog, query: '   ' },
    { label: 'empty catalog', items: [], query: 'tomato' },
  ];

  it.each(table)('$label', ({ items, query }) => {
    const stage1 = stage1For(items, query);
    const exact = findExactCanonMatch(items, query);
    const result = findClosestMatch(items, query);

    if (stage1 === undefined) {
      // Blank target — stage 1 never ran, so neither function may name anything.
      expect(exact).toBeNull();
      expect(result.kind).toBe('none');
      return;
    }

    const winners = stage1.topCandidates;

    if (stage1.passed && winners.length === 1) {
      // One item's own name spells the target: both must pick that same item.
      expect(result.kind).toBe('match');
      if (result.kind === 'match') {
        expect(result.candidate.stage).toBe(1);
        expect(result.candidate.item.id).toBe(winners[0]!.itemId);
      }
      expect(exact?.id).toBe(winners[0]!.itemId);
      return;
    }

    if (stage1.passed) {
      // A tie is not an answer. `findClosestMatch` hands back every claimant as
      // ambiguous; `findExactCanonMatch` hands back null. Both refuse to pick.
      expect(result.kind).toBe('ambiguous');
      expect(exact).toBeNull();
      return;
    }

    // Stage 1 missed, so no item's own name spells the target. `findClosestMatch`
    // must not claim a stage-1 match, and anything `findExactCanonMatch` returns
    // must have come from stage 3's synonyms — never from a name.
    expect(stage1.bestScore).toBeNull();
    if (result.kind === 'match') expect(result.candidate.stage).not.toBe(1);
    if (exact !== null) expect(normaliseName(exact.name)).not.toBe(normaliseName(query));
  });
});
