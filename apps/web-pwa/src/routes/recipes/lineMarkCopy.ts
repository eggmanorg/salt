// The words for a marked recipe line (issue #1647): what is wrong with it, and
// what clears it. WHICH problem and WHICH remedy is the domain's decision —
// `ingredientLineMark` — and this module only words them (and picks the glyph), so
// the match sheet and the row marks that read it cannot disagree with each other
// or with the domain.
//
// Both tables are exhaustive by type: a seventh issue or a sixth remedy fails to
// compile until it has words. The remedy sentence is keyed by the remedy alone,
// so it must be true of every issue that remedy serves — which is why none of
// them names a glyph (✗ and ? share `match_again`).

import {
  resolveProductForm,
  type CanonItem,
  type Ingredient,
  type IngredientLineIssue,
  type IngredientLineMark,
  type IngredientLineRemedy,
  type ProductForm,
} from '@salt/domain';
import { titleCase } from '../../lib/titleCase.js';

/** What a problem sentence can name. Each is null when the line has none. */
export interface LineMarkContext {
  /** The matched canon item's display name. */
  canonName: string | null;
  /** The product form the line resolves to. */
  formLabel: string | null;
  /** The line's metric unit. */
  unit: 'g' | 'ml' | null;
}

/**
 * The names a line's problem sentence uses, read off the live snapshot. One
 * function for the match sheet and the row marks, so the two cannot word the same
 * line differently. The form is claimed only when it resolves to the line's OWN
 * canon — the guard the sheet, `ShoppingItemRow` and `formCountFor` all apply.
 */
export function lineMarkContext(
  ing: Ingredient,
  canonById: ReadonlyMap<string, CanonItem>,
  forms: readonly ProductForm[],
  canonItems: readonly CanonItem[],
): LineMarkContext {
  const canon = ing.canonId === null ? null : (canonById.get(ing.canonId) ?? null);
  const parsed = ing.parsed;
  const form = parsed && canon ? resolveProductForm(parsed.item, forms, canonItems) : null;
  return {
    canonName: canon ? titleCase(canon.name) : null,
    formLabel: form && canon && form.parentCanonId === canon.id ? form.label : null,
    unit: parsed?.unit ?? null,
  };
}

/** What is wrong with the line, in one sentence. */
export function lineIssueProblem(issue: IngredientLineIssue, ctx: LineMarkContext): string {
  switch (issue) {
    case 'not_matched':
      return 'Not matched yet, so nothing is bought for this line.';
    case 'unreadable':
      return "This line couldn't be read as an ingredient, so nothing is bought for it.";
    case 'dangling_canon':
      return 'The item this line was matched to has been deleted or merged away, so nothing is bought for it.';
    case 'missing_amount':
      return "No amount was read off this line, so it doesn't scale with the servings and adds nothing to the shopping list.";
    case 'missing_form': {
      const canon = ctx.canonName ?? 'This item';
      const measure = ctx.unit ? `${ctx.unit} of ${canon}` : `a weight of ${canon}`;
      return `${canon} is bought whole and nothing says how many this line needs, so it goes on the list as ${measure}.`;
    }
    case 'missing_count': {
      const form = ctx.formLabel?.toLowerCase() ?? 'this item';
      return `This line gives a weight, but ${form} is bought by the count, so it goes on the list by weight.`;
    }
  }
}

/** What clears the mark — for a ladder, both rungs. */
export const LINE_REMEDY: Readonly<Record<IngredientLineRemedy, string>> = {
  match_again: 'Match again to put it right.',
  match_again_then_reword:
    "Match again to try reading it again. If it still can't be read, edit the recipe so this line gives an amount and one ingredient, then match it.",
  match_again_then_add_form:
    'Match again to have that worked out. If the mark is still here afterwards, a product form has to be added in the catalogue — an admin can add one from the canon item.',
  match_again_then_state_count:
    'Match again to read the count from the line. If the line only gives a weight, edit it to say how many, then match it.',
  state_count:
    'Reading the line again won\'t change that. Edit the recipe so this line says how many (for example "2", not a weight), then tap its ✗ to match it.',
};

/**
 * The mark each issue wears on the recipe page's ingredient tile. Colour and glyph
 * answer "does this line look finished?" and "does tapping it re-run the match?".
 * Every issue with no live match wears the ✗, as before #1647; the glyph per
 * issue is asserted in `RecipeViewPage.matchMarkers.test.ts`.
 */
export type LineMarkGlyph = 'unmatched' | 'no-amount' | 'mismatched';

export const LINE_MARK_GLYPH: Readonly<Record<IngredientLineIssue, LineMarkGlyph>> = {
  not_matched: 'unmatched',
  unreadable: 'unmatched',
  dangling_canon: 'unmatched',
  missing_amount: 'no-amount',
  missing_form: 'mismatched',
  missing_count: 'mismatched',
};

/** What tapping the mark itself does — the ✗ and ? re-run the match, the ⚠ explains. */
const GLYPH_ACTION: Readonly<Record<LineMarkGlyph, string>> = {
  unmatched: 'Tapping this mark matches the line again.',
  'no-amount': 'Tapping this mark matches the line again.',
  mismatched: 'Tap this mark to see the match.',
};

/** A row mark: which glyph, and its hover / screen-reader label. */
export interface RowMark {
  glyph: LineMarkGlyph;
  label: string;
}

/** The row mark for a marked line: problem, remedy, then what the tap does. */
export function rowMark(mark: IngredientLineMark, ctx: LineMarkContext): RowMark {
  const glyph = LINE_MARK_GLYPH[mark.issue];
  return {
    glyph,
    label: `${lineIssueProblem(mark.issue, ctx)} ${LINE_REMEDY[mark.remedy]} ${GLYPH_ACTION[glyph]}`,
  };
}
