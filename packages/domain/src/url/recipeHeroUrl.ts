import { appendCacheBuster } from './appendCacheBuster.js';

// The hero image a recipe shows, cache-busted (issue #933). Pure — no I/O, no
// Node/browser/Firebase APIs (CLAUDE.md Rule 1).
//
// This rule was written out at EIGHT sites in seven files: five private
// `heroUrl` functions (`MealDayEditor`, `MealDayDetail`, `WeekShopSheet`,
// `RecipeListPage`, `MinePage`) and three inline expressions (`RecipeViewPage`
// twice, and the recipe editor retired in #1319). They agreed, which is why
// nothing ever caught them —
// but "eight copies that happen to agree" is a fact about today, and the nonce
// precedence below is the kind of thing a well-meaning edit gets subtly wrong at
// one site.
//
// WHY THE NONCE PRECEDENCE IS `imageRequestedAt ?? updatedAt`, in that order:
// `imageRequestedAt` is stamped when a regeneration is REQUESTED, before the new
// bytes exist, and cleared when they land. While it is set it is the newer of the
// two, so it is what makes the browser drop the image it is currently showing.
// `updatedAt` is the resting nonce — it moves whenever anything about the recipe
// moves, which is more often than the image changes, and that is harmless: a
// spurious re-fetch costs a request, a missed one shows the wrong picture.

/**
 * The minimal shape this rule needs.
 *
 * Structural rather than `Recipe` on purpose: the same rule renders a top-level
 * recipe's hero AND a sub-recipe component's thumbnail, and the component sites
 * hold a narrower object than a full `Recipe`. Anything carrying an image, a
 * requested-at stamp and an updated-at stamp is enough.
 */
export interface HeroImageSource {
  // `| undefined` on both optional members is load-bearing under
  // `exactOptionalPropertyTypes`, which this repo has on: without it a `Recipe`
  // — whose `imageRequestedAt` is `number | undefined` because the schema marks
  // it `.optional()` — is not assignable here, and `svelte-check` says so at
  // every call site while `tsc` stays quiet.
  readonly image?: { readonly url: string } | null | undefined;
  readonly imageRequestedAt?: number | null | undefined;
  readonly updatedAt: string;
}

/**
 * The `src` for a recipe's hero image, or `null` when it has none.
 *
 * `null` rather than `''` is load-bearing: every call site branches on it to
 * decide whether to render an `<img>` at all, and an empty `src` makes a browser
 * re-request the current page.
 */
export function recipeHeroUrl(recipe: HeroImageSource): string | null {
  const url = recipe.image?.url;
  if (!url) return null;
  return appendCacheBuster(url, recipe.imageRequestedAt ?? recipe.updatedAt);
}
