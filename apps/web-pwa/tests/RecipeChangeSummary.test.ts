import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/svelte';
import type { RecipeDiff, RecipePhase } from '@salt/domain';

vi.mock('../src/lib/featureGate.js', () => ({
  breadGate: {
    subscribe: (fn: (v: unknown) => void) => (fn({ enabled: true, settled: true }), () => {}),
  },
  featureGate: () => ({
    subscribe: (fn: (v: unknown) => void) => (fn({ enabled: true, settled: true }), () => {}),
  }),
  isFeatureEnabled: () => true,
}));

import RecipeChangeSummary from '../src/routes/recipes/RecipeChangeSummary.svelte';

// The review gate reads as a diff, not a wall of text (issue #825). What is
// pinned here is the ONE rule the design rests on: how a change is drawn follows
// from the change itself, never from which field it came out of. The same
// component that puts `750 g → 1.1 kg` on a single line must mark the words in a
// reworded step and must refuse to mark anything in a rewritten one.

afterEach(() => {
  cleanup();
});

const EMPTY: RecipeDiff = {
  hasChanges: true,
  ingredients: { added: [], removed: [], changed: [] },
  steps: { added: [], removed: [], changed: [] },
  metadata: {},
  tags: { added: [], removed: [] },
};

function open(diff: Partial<RecipeDiff>): void {
  render(RecipeChangeSummary, {
    props: {
      diff: { ...EMPTY, ...diff },
      open: true,
      applying: false,
      onApply: vi.fn(),
      onDiscard: vi.fn(),
    },
  });
}

/** The single card in the sheet, whichever group it landed in. */
function onlyCard(): HTMLElement {
  const cards = screen.getAllByRole('listitem');
  expect(cards).toHaveLength(1);
  return cards[0]!;
}

// Both sides comfortably over the 42-character short-value cut-off, so the
// rendering is decided by how much of the sentence survived and nothing else.
const ORIGINAL_STEP = 'Give the potatoes a scrub and cut any larger ones in half';
const ADJUSTED_STEP = 'Give the potatoes a scrub and halve any larger ones';
const UNRELATED_STEP = 'Bring a large pan of salted water to a rolling boil first';

describe('RecipeChangeSummary — how a change is drawn follows from the change', () => {
  it('keeps a short value on one line, with no word marks to read', () => {
    // The compactness test. A quantity edit is no more verbose than the flat
    // list this replaced — one line, both values, an arrow.
    open({ metadata: { servings: { from: 4, to: 6 } } });

    const card = onlyCard();
    expect(card.textContent).toContain('4');
    expect(within(card).getByTestId('recipe-change-proposed')).toHaveTextContent('6');
    expect(card.querySelector('del')).toBeNull();
    expect(card.querySelector('ins')).toBeNull();
    expect(within(card).queryByTestId('recipe-change-inline')).toBeNull();
  });

  it('renders an unset numeric field as a one-line value, not as an absence', () => {
    // "none → 6" is a value change, not a creation: a number that is unset still
    // has a readable one-line rendering, so it stays an ordinary edit.
    open({ metadata: { servings: { from: null, to: 6 } } });

    const card = onlyCard();
    expect(card.textContent).toContain('none');
    expect(within(card).getByTestId('recipe-change-proposed')).toHaveTextContent('6');
  });

  it('marks only the words that moved in an adjusted sentence', () => {
    open({
      steps: {
        added: [],
        removed: [],
        changed: [{ id: 's1', position: 2, text: { from: ORIGINAL_STEP, to: ADJUSTED_STEP } }],
      },
    });

    const card = onlyCard();
    expect(within(card).getByTestId('recipe-change-inline')).toBeInTheDocument();
    // The handful that actually moved — and nothing else.
    expect([...card.querySelectorAll('del')].map((n) => n.textContent?.trim())).toEqual([
      'cut',
      'in half',
    ]);
    expect([...card.querySelectorAll('ins')].map((n) => n.textContent?.trim())).toEqual(['halve']);
    // The words that survived are still there, unmarked.
    expect(card.textContent).toContain('Give the potatoes a scrub');
  });

  it('stops pretending a rewritten passage is an edit', () => {
    // THE case the rule exists for: interleaving marks through a wholesale
    // rewrite produces dozens of alternating fragments that read slower than
    // either version alone. Old above new, said plainly.
    open({
      steps: {
        added: [],
        removed: [],
        changed: [{ id: 's1', position: 2, text: { from: ORIGINAL_STEP, to: UNRELATED_STEP } }],
      },
    });

    const card = onlyCard();
    expect(within(card).queryByTestId('recipe-change-inline')).toBeNull();
    expect(card.querySelector('del')).toBeNull();
    expect(card.querySelector('ins')).toBeNull();
    expect(card.textContent).toContain(ORIGINAL_STEP);
    expect(within(card).getByTestId('recipe-change-proposed')).toHaveTextContent(UNRELATED_STEP);
    expect(card.textContent?.toLowerCase()).toContain('rewritten');
  });

  it('chips a step of the same length by content, not by length alone', () => {
    // Two changes of near-identical size, one adjusted and one rewritten: the
    // only thing separating them is how much survived, which is the whole claim.
    open({
      steps: {
        added: [],
        removed: [],
        changed: [
          { id: 's1', position: 1, text: { from: ORIGINAL_STEP, to: ADJUSTED_STEP } },
          { id: 's2', position: 2, text: { from: ORIGINAL_STEP, to: UNRELATED_STEP } },
        ],
      },
    });

    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent?.toLowerCase()).toContain('edit');
    expect(cards[1]!.textContent?.toLowerCase()).toContain('rewritten');
  });
});

describe('RecipeChangeSummary — a card says what kind of change it is', () => {
  it('chips an added ingredient "new" and shows only the proposed side', () => {
    open({
      ingredients: { added: [{ id: 'i1', rawText: '2 tbsp capers' }], removed: [], changed: [] },
    });

    const card = onlyCard();
    expect(card.textContent?.toLowerCase()).toContain('new');
    expect(within(card).getByTestId('recipe-change-proposed')).toHaveTextContent('2 tbsp capers');
  });

  it('chips a removed ingredient "gone" and offers no proposed side at all', () => {
    open({
      ingredients: { added: [], removed: [{ id: 'i1', rawText: '2 tbsp capers' }], changed: [] },
    });

    const card = onlyCard();
    expect(card.textContent?.toLowerCase()).toContain('gone');
    expect(card.textContent).toContain('2 tbsp capers');
    // Nothing is being proposed in its place — an empty proposed element would
    // be a lie about what Apply is going to write.
    expect(within(card).queryByTestId('recipe-change-proposed')).toBeNull();
  });

  it('chips a reworded ingredient "edit" and shows both sides of it', () => {
    // The third ingredient shape, and the only one with two sides: the same item
    // reworded keeps its place in the list rather than reading as a delete plus
    // an add, which is what the flat list it replaced made of it.
    open({
      ingredients: {
        added: [],
        removed: [],
        changed: [{ id: 'i1', from: '2 tbsp capers', to: '1 tbsp capers, rinsed' }],
      },
    });

    const card = onlyCard();
    expect(card.textContent?.toLowerCase()).toContain('edit');
    expect(card.textContent).toContain('2 tbsp capers');
    expect(within(card).getByTestId('recipe-change-proposed')).toHaveTextContent(
      '1 tbsp capers, rinsed',
    );
  });

  it('labels a step card with the step it applies to', () => {
    open({
      steps: {
        added: [{ id: 's1', position: 3, text: 'Rest for ten minutes' }],
        removed: [],
        changed: [],
      },
    });

    expect(onlyCard().textContent).toContain('Step 3');
  });

  it('chips a deleted step "gone", names it, and proposes nothing in its place', () => {
    // A step the chef wants to DROP is the one change Apply makes that leaves
    // less than it found, so it has to be as readable as an addition: the label
    // says which step goes, and there is no proposed side to mistake for a
    // replacement.
    open({
      steps: {
        added: [],
        removed: [{ id: 's1', position: 2, text: 'Rest for ten minutes' }],
        changed: [],
      },
    });

    const card = onlyCard();
    expect(card.textContent).toContain('Step 2');
    expect(card.textContent?.toLowerCase()).toContain('gone');
    expect(card.textContent).toContain('Rest for ten minutes');
    expect(within(card).queryByTestId('recipe-change-proposed')).toBeNull();
  });

  it('splits one step into a card per facet it changed', () => {
    // text / timer / note are independent facets on the same StepChange, and each
    // is a separate thing to read and agree to.
    open({
      steps: {
        added: [],
        removed: [],
        changed: [
          {
            id: 's1',
            position: 1,
            text: { from: 'Simmer gently', to: 'Simmer hard' },
            timer: { from: null, to: { durationMinutes: 15, description: null } },
            note: { from: null, to: 'Watch it does not catch' },
          },
        ],
      },
    });

    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    expect(cards[1]!.textContent).toContain('no timer');
    expect(cards[2]!.textContent?.toLowerCase()).toContain('new');
  });
});

describe('RecipeChangeSummary — two columns from the fold up', () => {
  // The seam is the `split:` Tailwind variant and nothing else — no matchMedia,
  // no width in script — so what these pin is the CLASS CONTRACT: the element is
  // in the DOM at every width and CSS alone decides whether it is seen. jsdom
  // loads no stylesheet, so asserting the variant is the honest way to say "this
  // is gated on the app's one layout breakpoint and not on a re-derived one".
  // Whether 700px is the right number is settled in `app.css`; that it is the
  // number used here is what would silently rot.

  it('shows the column headings only above the seam, pinned to the top of the list', () => {
    open({ title: { from: 'Pilaf', to: 'Chorizo Pilaf' } });

    const row = screen.getByText('Now').parentElement!;
    expect(row).toContainElement(screen.getByText('Proposed'));
    // Never on a phone: on 390px the headings would eat a line and explain
    // nothing, because there is only one column under them.
    expect(row).toHaveClass('hidden', 'split:grid', 'split:grid-cols-2');
    // Pinned inside the scroller, not stacked above it — the question they
    // answer has to survive scrolling past the first card.
    expect(row).toHaveClass('sticky', 'top-0');
  });

  it('names the empty side of an addition instead of leaving a blank column', () => {
    open({
      ingredients: { added: [{ id: 'i1', rawText: '2 tbsp capers' }], removed: [], changed: [] },
    });

    const card = onlyCard();
    // An empty Now cell reads as missing data; "Not in the recipe yet" reads as
    // an addition. Below the seam it is display:none, so the phone rendering
    // still shows the value alone.
    expect(within(card).getByText('Not in the recipe yet')).toHaveClass('hidden', 'split:block');
  });

  it('names the empty side of a removal, without offering it as a proposed value', () => {
    open({
      ingredients: { added: [], removed: [{ id: 'i1', rawText: '2 tbsp capers' }], changed: [] },
    });

    const card = onlyCard();
    const empty = within(card).getByText('Removed');
    expect(empty).toHaveClass('hidden', 'split:block');
    // It fills the column; it is not a value Apply is going to write, so it must
    // stay out of the id specs read the proposed side by.
    expect(empty).not.toHaveAttribute('data-testid');
    expect(within(card).queryByTestId('recipe-change-proposed')).toBeNull();
  });

  it('turns a two-sided card into the two cells, and drops the arrow with them', () => {
    open({ metadata: { servings: { from: 4, to: 6 } } });

    const card = onlyCard();
    expect(within(card).getByTestId('recipe-change-proposed').parentElement).toHaveClass(
      'split:grid',
      'split:grid-cols-2',
    );
    // `old → new` is how one line reads; two columns under headings say it
    // already, and a stray arrow between them would be read as a third cell.
    expect(within(card).getByText('→')).toHaveClass('split:hidden');
  });

  it('lets an interleaved rendering span both columns rather than tearing it in half', () => {
    // The inline rendering has no two sides by construction — old and new are in
    // one sentence. Splitting it would mean abandoning the highlight, which is
    // the whole reason it exists.
    open({
      steps: {
        added: [],
        removed: [],
        changed: [{ id: 's1', position: 2, text: { from: ORIGINAL_STEP, to: ADJUSTED_STEP } }],
      },
    });

    const inline = within(onlyCard()).getByTestId('recipe-change-inline');
    expect(inline.className).not.toContain('split:grid');
  });
});

describe('RecipeChangeSummary — the sheet contract is unchanged', () => {
  it('renders no section at all for a group with nothing in it', () => {
    // The absence check both e2e specs read as "the chef proposed no change
    // here" — an empty shell would read as a proposal.
    open({ title: { from: 'Pilaf', to: 'Chorizo Pilaf' } });

    expect(screen.getByTestId('recipe-change-group-basics')).toBeInTheDocument();
    expect(screen.queryByTestId('recipe-change-group-ingredients')).toBeNull();
    expect(screen.queryByTestId('recipe-change-group-steps')).toBeNull();
    expect(screen.queryByTestId('recipe-change-group-metadata')).toBeNull();
    expect(screen.queryByTestId('recipe-change-group-tags')).toBeNull();
  });

  it('keeps a short title assertable as one contiguous string', () => {
    // Both e2e specs assert toContainText(<amended title>) on the basics group,
    // and Playwright reads concatenated textContent — which word-level marks
    // split apart. A title under the short-value cut-off never reaches them.
    open({ title: { from: 'Review Gate Pilaf', to: 'Stubbed Chilli Pilaf' } });

    expect(screen.getByTestId('recipe-change-group-basics').textContent).toContain(
      'Stubbed Chilli Pilaf',
    );
  });

  it('offers nothing to apply when there is nothing to change', () => {
    render(RecipeChangeSummary, {
      props: {
        diff: { ...EMPTY, hasChanges: false },
        open: true,
        applying: false,
        onApply: vi.fn(),
        onDiscard: vi.fn(),
      },
    });

    expect(screen.getByTestId('recipe-change-summary-none')).toHaveTextContent('No changes.');
    expect(screen.queryByTestId('recipe-change-apply')).toBeNull();
    expect(screen.getByTestId('recipe-change-discard')).toBeInTheDocument();
  });

  it('still offers exactly two choices, and no per-row selection', () => {
    open({ tags: { added: ['midweek'], removed: ['sunday'] } });

    expect(screen.getByTestId('recipe-change-apply')).toBeInTheDocument();
    expect(screen.getByTestId('recipe-change-discard')).toBeInTheDocument();
    // A proposal is one thing you accept or refuse (issue #824 holds the
    // deferred per-row capability) — nothing in the list is selectable.
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

// ── The Timing card (issue #1212) ───────────────────────────────────────────
//
// The gate's whole point: a chat proposal that rewrites the phase strip, or that
// quietly deletes the sentence over it, must be on screen BEFORE it is written.
// Until `diffRecipe` reported the pair, neither was.
describe('RecipeChangeSummary — the phase strip', () => {
  const MIX: RecipePhase = { label: 'Mix & knead', handsOnMinutes: 20, handsOffMinutes: 0 };
  const PROVE: RecipePhase = { label: 'First rise', handsOnMinutes: 0, handsOffMinutes: 90 };

  function openWithPhases(metadata: RecipeDiff['metadata']): void {
    open({ metadata });
  }

  it('draws ONE card for a whole rewritten strip, not one per phase', () => {
    openWithPhases({ phases: { from: [MIX], to: [MIX, PROVE] } });

    // ONE card (enforced by `onlyCard()`), naming both the unchanged phase and
    // the added one. Which of the three renderings draws it is content-derived
    // (see the component's own header comment) and not pinned here — carrying
    // the hands-on figure (#1216) is what pushes a two-phase strip past the
    // one-line cutoff into the word-diff rendering.
    const card = onlyCard();
    expect(card.textContent).toContain('Timing');
    expect(card.textContent).toContain('Mix & knead 20 min');
    expect(card.textContent).toContain('First rise');
  });

  it('shows a deleted sentence as a change rather than letting it land unseen', () => {
    openWithPhases({
      timingSummary: { from: 'About 25 minutes of you, over 2 hours.', to: null },
    });

    const card = onlyCard();
    expect(card.textContent).toContain('About 25 minutes of you');
    expect(within(card).getByTestId('recipe-change-proposed')).toHaveTextContent('no summary');
  });

  // The strip is not in the diff when it did not change, so the card must not
  // claim anything about it — "none" there would read as "this recipe has no
  // phases" at the moment the reviewer is deciding.
  it('says nothing about the strip when only the sentence moved', () => {
    openWithPhases({ timingSummary: { from: null, to: 'Mostly hands-off.' } });

    const card = onlyCard();
    expect(within(card).getByTestId('recipe-change-proposed')).toHaveTextContent(
      'Mostly hands-off.',
    );
    // No strip half at all: no phase list, and not the em-dash that joins the two
    // halves when both are in the diff.
    expect(card.textContent).not.toContain('none');
    expect(card.textContent).not.toContain(' — ');
  });

  // A diff that moves ONLY the strip draws no Prep/Cook/Total card, because
  // `diffRecipe` reports those three only when they themselves moved — not
  // because this component declines to draw them (it does, see the "still
  // live" describe block below; that coexistence is deliberate until issue
  // #1213's phase 5, PR #1231 review).
  it('draws a Timing card and no Prep, Cook or Total card, when only the strip moved', () => {
    openWithPhases({ phases: { from: [MIX], to: [PROVE] } });

    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Timing')).toBeInTheDocument();
    expect(screen.queryByText('Prep time')).toBeNull();
    expect(screen.queryByText('Cook time')).toBeNull();
    expect(screen.queryByText('Total time')).toBeNull();
  });

  it('keeps Servings its own card', () => {
    openWithPhases({
      servings: { from: 4, to: 6 },
      phases: { from: [MIX], to: [PROVE] },
    });

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  // Issue #1217. `nullableStringChange` compares by identity, so a stored
  // sentence going null → "" is a change to the document; both sides render as
  // `no summary`, so it is no change on screen. The card that used to be drawn
  // asserted movement, showed the reviewer two identical columns, and offered a
  // live Apply — approve what you cannot see, or discard what may be real.
  describe.each([
    ['null → ""', { from: null, to: '' }],
    ['"" → null', { from: '', to: null }],
    ['whitespace → ""', { from: '   ', to: '' }],
  ] as const)('a blank-to-blank timing sentence (%s)', (_name, timingSummary) => {
    it('draws no Timing card, and the sheet falls through to "No changes."', () => {
      openWithPhases({ timingSummary: { from: timingSummary.from, to: timingSummary.to } });

      expect(screen.queryAllByRole('listitem')).toHaveLength(0);
      expect(screen.queryByText('Timing')).toBeNull();
      expect(screen.getByTestId('recipe-change-summary-none')).toHaveTextContent('No changes.');
      expect(screen.queryByTestId('recipe-change-apply')).toBeNull();
    });
  });

  // The neighbour the rule must not swallow: a strip whose labels and elapsed sum
  // hold while minutes move between hands-on and hands-off renders two different
  // strings only because #1216 prints both figures. It stays a card.
  it('still draws a card when only hands-on/hands-off moved within a phase', () => {
    openWithPhases({
      phases: {
        from: [{ label: 'Prove', handsOnMinutes: 10, handsOffMinutes: 50 }],
        to: [{ label: 'Prove', handsOnMinutes: 0, handsOffMinutes: 60 }],
      },
    });

    const card = onlyCard();
    expect(card.textContent).toContain('Timing');
    expect(card.textContent).toContain('Prove 1 hr (10 min hands-on)');
    expect(card.textContent).toContain('Prove 1 hr (0 min hands-on)');
  });

  // Issue #1239. The rule the card is drawn by is stated on `metadata.phases`
  // being PRESENT — `diffRecipe` compared the two strips field by field, so its
  // saying so IS the proof — and not on what the two sides happen to render as.
  // That is the property, and it is what this table pins rather than any one
  // case: each row is a different way `phasesValue` loses a distinction
  // `phasesEqual` kept — the blank-label placeholder, the clamp
  // `phaseElapsedMinutes` applies to a hands-off figure `phasesValue` never
  // prints, and the separators a label is free to contain — and every row
  // renders the SAME string on both sides. Before the fix each drew no card, no
  // Apply and "No changes.", so a real movement (visible on the recipe page,
  // where the label prints verbatim) could not be accepted at all.
  describe.each([
    [
      'a blank label against the placeholder it is drawn as',
      [{ label: '', handsOnMinutes: 20, handsOffMinutes: 0 }],
      [{ label: 'Untitled', handsOnMinutes: 20, handsOffMinutes: 0 }],
    ],
    [
      'two hands-off figures that both clamp to zero',
      [{ label: 'Bake', handsOnMinutes: 20, handsOffMinutes: -5 }],
      [{ label: 'Bake', handsOnMinutes: 20, handsOffMinutes: 0 }],
    ],
    [
      'a non-finite hands-off figure against zero',
      [{ label: 'Bake', handsOnMinutes: 20, handsOffMinutes: Number.NaN }],
      [{ label: 'Bake', handsOnMinutes: 20, handsOffMinutes: 0 }],
    ],
    [
      'a label carrying the separator that joins two phases',
      [
        { label: 'Mix', handsOnMinutes: 5, handsOffMinutes: 0 },
        { label: 'Bake', handsOnMinutes: 5, handsOffMinutes: 0 },
      ],
      [{ label: 'Mix 5 min (5 min hands-on) · Bake', handsOnMinutes: 5, handsOffMinutes: 0 }],
    ],
  ] as [string, RecipePhase[], RecipePhase[]][])(
    'a strip movement whose two sides render identically (%s)',
    (_name, from, to) => {
      it('still draws exactly one Timing card, over a live Apply', () => {
        openWithPhases({ phases: { from, to } });

        const card = onlyCard();
        expect(card.textContent).toContain('Timing');
        expect(screen.getByTestId('recipe-change-apply')).toBeInTheDocument();
        expect(screen.queryByTestId('recipe-change-summary-none')).toBeNull();
      });
    },
  );
});

// ── The sheet matches what it drew (issue #1216) ────────────────────────────
//
// `diffRecipe` reports a metadata change whenever `timingSummary` moved — but
// the Timing card declines to draw a sentence-only pair whose two sides render
// identically (#1217; a strip movement always draws, #1239). `hasChanges` and "is there a card to look at" are two different
// questions, and the sheet must answer from the second one: a review gate that
// offers Apply next to zero cards would let a write through with nothing shown
// for the reviewer to approve.
describe('RecipeChangeSummary — the sheet matches what it drew, not what diffRecipe reported', () => {
  it('a diff whose only movement renders identically has no card to draw, so it reads as no changes', () => {
    open({ metadata: { timingSummary: { from: null, to: '   ' } } });

    expect(screen.getByTestId('recipe-change-summary-none')).toHaveTextContent('No changes.');
    expect(screen.queryByTestId('recipe-change-apply')).toBeNull();
    expect(screen.queryByTestId('recipe-change-group-metadata')).toBeNull();
    expect(screen.getByTestId('recipe-change-discard')).toHaveTextContent('Close');
  });
});

// ── The Timing card must surface a hands-on/hands-off shift (issue #1216) ──
describe('RecipeChangeSummary — the Timing card, a hands-on/hands-off shift', () => {
  it('draws Now and Proposed as different text when only the hands-on/hands-off split moved', () => {
    // Same label, same elapsed total (45 min either side) — the split is the
    // ONLY thing that changed, and it is the figure the whole feature exists
    // to surface ("how much of that is you at the counter").
    open({
      metadata: {
        phases: {
          from: [{ label: 'Bake', handsOnMinutes: 5, handsOffMinutes: 40 }],
          to: [{ label: 'Bake', handsOnMinutes: 0, handsOffMinutes: 45 }],
        },
      },
    });

    const card = onlyCard();
    const fromText = card.querySelector('p > span:first-child')?.textContent?.trim();
    const toText = within(card).getByTestId('recipe-change-proposed').textContent?.trim();
    expect(fromText).toContain('5');
    expect(toText).toContain('0');
    expect(fromText).not.toBe(toText);
  });
});
