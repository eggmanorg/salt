import { hasLiveCanonMatch, type CanonItem } from '../../canon/index.js';
import type { ProductForm } from '../../productForm/index.js';
import type { Ingredient } from '../entities/Ingredient.js';
import { ingredientMatchIssue } from './matchIssues.js';

/**
 * Why a recipe line carries a mark. `ingredientMatchIssue`'s four kinds, plus the
 * two states it deliberately leaves out because a line in them plainly is not
 * finished:
 *
 * - `not_matched` — no live match: never matched (`pending`), or the canon half of
 *   a match failed (`failed` with `parsed` set).
 * - `unreadable` — the parse itself returned nothing (`failed` with `parsed:
 *   null`), which is the shape `matchIngredient` writes for a line it cannot read.
 */
export type IngredientLineIssue =
  | 'not_matched'
  | 'unreadable'
  | 'dangling_canon'
  | 'missing_amount'
  | 'missing_form'
  | 'missing_count';

/**
 * What clears a line's mark. A `…_then_…` remedy is a ladder: try the first step,
 * and if the mark is still there, the second. Each one's reach is stated below
 * and pinned in `tests/recipe/ingredientLineMark.test.ts`.
 *
 * - `match_again` — `not_matched`, `dangling_canon`, `missing_amount`. A
 *   successful match leaves none of the three. Not unconditional: a re-parse that
 *   returns nothing turns any of them into `unreadable`, a different mark with
 *   its own remedy.
 * - `match_again_then_reword` — `unreadable`. The parse may read the line on a
 *   second try; if not, rewording it is the only way forward.
 * - `match_again_then_add_form` — `missing_form`. Whether a re-match mints the
 *   missing product form is arbitration's call (it can answer `none`), so nothing
 *   here can know in advance; a form added in the catalogue is the second rung.
 *   A COUNT form covering a line that states no count turns it into `missing_count` instead.
 * - `match_again_then_state_count` — `missing_count` on a line parsed before
 *   #1643 (`statedCount` absent). The re-parse records a count only if the line
 *   states one; a line giving only a weight comes back as `state_count`.
 * - `state_count` — `missing_count` on a line the #1643 parse already read
 *   (`statedCount: null`: it looked, and the line states no count). Matching
 *   again reads the same words and changes nothing; the line must be edited to
 *   say how many, then matched.
 *
 * What the tests cannot pin is model behaviour: that the parser does record a
 * count for "2 chicken breasts", and that arbitration does mint a form. That is
 * why those two are ladders rather than single steps.
 */
export type IngredientLineRemedy =
  | 'match_again'
  | 'match_again_then_reword'
  | 'match_again_then_add_form'
  | 'match_again_then_state_count'
  | 'state_count';

export interface IngredientLineMark {
  issue: IngredientLineIssue;
  remedy: IngredientLineRemedy;
}

/**
 * The mark a recipe line carries, and what clears it — or null for a clean line.
 *
 * Composed, not re-derived: the live-match test first (`hasLiveCanonMatch`, the
 * rule behind the recipe page's ✗), then `ingredientMatchIssue` for a line that
 * is live. So the set of marked lines is exactly `!hasLiveCanonMatch ||
 * ingredientMatchIssue !== null`, and the recipe card's count — which reads
 * `ingredientMatchIssue` alone — is unaffected by anything here.
 *
 * `canonById` doubles as the live-canon set, as it does for `ingredientMatchIssue`.
 */
export function ingredientLineMark(
  ing: Ingredient,
  canonById: ReadonlyMap<string, CanonItem>,
  forms: readonly ProductForm[],
): IngredientLineMark | null {
  if (!hasLiveCanonMatch(ing, canonById)) {
    if (ing.matchState === 'failed' && ing.parsed === null) {
      return { issue: 'unreadable', remedy: 'match_again_then_reword' };
    }
    if (ing.canonId !== null && !canonById.has(ing.canonId)) {
      return { issue: 'dangling_canon', remedy: 'match_again' };
    }
    return { issue: 'not_matched', remedy: 'match_again' };
  }
  const issue = ingredientMatchIssue(ing, canonById, forms);
  switch (issue) {
    case null:
      return null;
    case 'dangling_canon':
    case 'missing_amount':
      return { issue, remedy: 'match_again' };
    case 'missing_form':
      return { issue, remedy: 'match_again_then_add_form' };
    case 'missing_count':
      // `undefined` means "parsed before #1643": `parseRecipeIngredients` writes
      // the key on every line it has returned since, `null` when none is stated.
      return {
        issue,
        remedy:
          ing.parsed?.statedCount === undefined ? 'match_again_then_state_count' : 'state_count',
      };
  }
}
