import { describe, expect, it } from 'vitest';

import { hasBlockingFindings, judgePr, reviewSections } from '../lib/prEligibility.mjs';

const REVIEWED = '2026-09-01T10:00:00Z';
const BEFORE = '2026-09-01T09:00:00Z';
const AFTER = '2026-09-01T11:00:00Z';

const body = (blocking) =>
  [
    '## Blocking',
    blocking,
    '',
    '## Should-fix',
    '- rename the helper',
    '',
    '## Notes',
    '- reads well',
  ].join('\n');

/** A PR that satisfies every condition, which each case then breaks one of. */
const green = (over = {}) => ({
  isDraft: false,
  state: 'OPEN',
  headRefName: 'feat/thing-123',
  statusCheckRollup: [{ name: 'unit', conclusion: 'SUCCESS' }],
  reviews: [{ submittedAt: REVIEWED, body: body('None.') }],
  commits: [{ committedDate: BEFORE }],
  ...over,
});

describe('reviewSections', () => {
  it('splits a review body on its severity headings', () => {
    expect(reviewSections(body('None.')).map((s) => s.heading)).toEqual([
      'Blocking',
      'Should-fix',
      'Notes',
    ]);
  });

  it('returns nothing for a body with no headings, rather than guessing', () => {
    expect(reviewSections('looks fine to me')).toEqual([]);
  });
});

describe('hasBlockingFindings', () => {
  it.each([['None.'], ['n/a'], ['No blocking findings.'], ['nothing here'], ['']])(
    'reads %j as no findings',
    (text) => {
      expect(hasBlockingFindings(reviewSections(body(text)))).toBe(false);
    },
  );

  // #1414: the marked-up spellings of "nothing here" that reviewers actually
  // write. Each is long enough to clear the 20-character floor on its own, so
  // the floor cannot be what saves them - only stripping the leading marker can.
  it.each([
    ['_None._ Read for correctness, duplication and test gaps.'],
    ['**None.** Verified the two mutators against the fixture.'],
    ['- None. Nothing CI does not already cover.'],
    ['> None — the diff is confined to the guard and its self-tests.'],
  ])('reads %j as no findings despite the markup around the word', (text) => {
    expect(hasBlockingFindings(reviewSections(body(text)))).toBe(false);
  });

  it('reads a real finding as a finding', () => {
    const text =
      '- `recipeAmend.ts:97` re-splits the pair, so a fresh strip lands under a stale one.';
    expect(hasBlockingFindings(reviewSections(body(text)))).toBe(true);
  });

  it('still reads an emphasised real finding as a finding', () => {
    const text = '**`recipeAmend.ts:97`** re-splits the pair, so a fresh strip lands under a stale one.'; // prettier-ignore
    expect(hasBlockingFindings(reviewSections(body(text)))).toBe(true);
  });
});

describe('judgePr', () => {
  it('allows a reviewed, green, blocking-free PR and reports its head branch', () => {
    const v = judgePr(green());
    expect(v.verdict).toBe('allow');
    expect(v.head).toBe('feat/thing-123');
    expect(v.hasBlocking).toBe(false);
  });

  it('denies a draft', () => {
    expect(judgePr(green({ isDraft: true })).verdict).toBe('deny');
  });

  it('denies a failing check, naming it', () => {
    const v = judgePr(green({ statusCheckRollup: [{ name: 'E2E', conclusion: 'FAILURE' }] }));
    expect(v.verdict).toBe('deny');
    expect(v.reason).toContain('E2E');
  });

  it('denies an unreviewed PR', () => {
    expect(judgePr(green({ reviews: [] })).verdict).toBe('deny');
  });

  it('denies blocking findings with nothing pushed since the review', () => {
    const v = judgePr(
      green({ reviews: [{ submittedAt: REVIEWED, body: body('- it crashes on an empty list') }] }),
    );
    expect(v.verdict).toBe('deny');
  });

  it('allows blocking findings once a commit lands after the review', () => {
    const v = judgePr(
      green({
        reviews: [{ submittedAt: REVIEWED, body: body('- it crashes on an empty list') }],
        commits: [{ committedDate: AFTER }],
      }),
    );
    expect(v.verdict).toBe('allow');
    expect(v.hasBlocking).toBe(true);
  });

  it('allows an unaddressed blocking finding only when adjudicated against an issue', () => {
    const pr = green({
      reviews: [{ submittedAt: REVIEWED, body: body('- it crashes on an empty list') }],
    });
    expect(judgePr(pr).verdict).toBe('deny');
    const v = judgePr(pr, { adjudicated: '1203' });
    expect(v.verdict).toBe('allow');
    expect(v.reason).toContain('#1203');
  });

  it('does not let adjudication excuse anything but a blocking finding', () => {
    expect(judgePr(green({ isDraft: true }), { adjudicated: '1203' }).verdict).toBe('deny');
    expect(
      judgePr(green({ statusCheckRollup: [{ name: 'E2E', conclusion: 'FAILURE' }] }), {
        adjudicated: '1203',
      }).verdict,
    ).toBe('deny');
    expect(judgePr(green({ reviews: [] }), { adjudicated: '1203' }).verdict).toBe('deny');
  });

  it.each([
    ['a closed PR', { state: 'MERGED' }],
    ['a review with no headings', { reviews: [{ submittedAt: REVIEWED, body: 'lgtm' }] }],
    [
      'unreadable timestamps',
      {
        reviews: [
          { submittedAt: 'not a date', body: body('- it crashes on an empty ingredient list') },
        ],
        commits: [{ committedDate: 'nope' }],
      },
    ],
  ])('asks rather than guessing for %s', (_label, over) => {
    expect(judgePr(green(over)).verdict).toBe('ask');
  });

  describe('a blank-bodied review is not a review', () => {
    // GitHub code scanning files a COMMENTED review with an empty body when
    // CodeQL finishes, on its own schedule. Before this, a bot landing after
    // the adversarial review hid it and stopped the merge on a human.
    const bot = { submittedAt: AFTER, body: '' };

    it('is skipped, so an earlier real review is still the one judged', () => {
      const v = judgePr(green({ reviews: [{ submittedAt: REVIEWED, body: body('None.') }, bot] }));
      expect(v.verdict).toBe('allow');
      expect(v.hasBlocking).toBe(false);
    });

    it('does not let a bot bury blocking findings either', () => {
      const v = judgePr(
        green({
          reviews: [{ submittedAt: REVIEWED, body: body('- it crashes on an empty list') }, bot],
          commits: [{ committedDate: BEFORE }],
        }),
      );
      expect(v.verdict).toBe('deny');
    });

    it('denies when it is the only review there is', () => {
      const v = judgePr(green({ reviews: [bot, { submittedAt: AFTER, body: '   ' }] }));
      expect(v.verdict).toBe('deny');
      expect(v.reason).toMatch(/none with a body/);
    });
  });

  it('reads a finding shorter than the 20-character floor as no finding', () => {
    // A stated limit, not an accident: the floor is what stops a placeholder
    // ("None", "tbd") counting as a finding, and it cuts both ways. A reviewer
    // whose blocking line is this terse gets merged past.
    const v = judgePr(green({ reviews: [{ submittedAt: REVIEWED, body: body('- it crashes') }] }));
    expect(v.verdict).toBe('allow');
    expect(v.hasBlocking).toBe(false);
  });

  it('never returns allow for anything it could not read', () => {
    // The property the whole gate rests on: ambiguity is not a pass.
    for (const over of [
      { state: 'CLOSED' },
      { reviews: [{ submittedAt: REVIEWED, body: '' }] },
      { reviews: [{ submittedAt: REVIEWED, body: 'no headings at all' }] },
    ]) {
      expect(judgePr(green(over), { adjudicated: '1203' }).verdict).not.toBe('allow');
    }
  });
});
