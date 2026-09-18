import type { SaltProduct } from '../schemas/formula.js';
import type { ComponentPercentBounds } from './adjustComponent.js';

// The curing salts, and the window each one has to sit in (issue #1402, phase 04 of
// epic #778).
//
// CHECKED-IN REFERENCE DATA IN `domain`, not a service and not a branch in the
// logic — the species `docs/formulas-schedules-batches.md` sanctions and the shape
// `LEAVENING_PERCENT_BOUNDS` and `DENSITY_G_PER_ML` already take. If a figure moves
// it moves here and nowhere else.
//
// ─── THERE IS NO SINGLE CURE-SALT PERCENTAGE ──────────────────────────────────
//
// Two families of product are in ordinary use and their safe doses differ by more
// than tenfold. The CONCENTRATED ones — cure #1, cure #2 — are ~6.25% sodium
// nitrite and go in at about 0.25% of the meat, ALONGSIDE your ordinary salt. The
// DILUTE European ones — nitrited curing salt, Salvianda — are well under 1%
// nitrite and *are* the salt, at about 3%. One window wide enough for both would
// permit a twelvefold overdose of the other, which is worse than no check at all.
// So every window below is read off a PRODUCT, and a component that names no
// product has no window.
//
// ─── WHAT THIS DOES NOT DO, STATED HERE RATHER THAN ONLY IN THE ISSUE ─────────
//
// The check is on the dose of a NAMED product, and nothing else (CLAUDE.md rule 12
// — never the unqualified "Salt prevents an unsafe cure"):
//
//   • NO PRODUCT NAMED MEANS NO BOUND. An ingredient nobody has identified carries
//     no window, and the solve has nothing to refuse it against.
//   • CELERY-POWDER "NATURAL" CURES ARE DELIBERATELY ABSENT. Their nitrite content
//     varies by brand and batch, so any fixed percentage would be a guess wearing a
//     safety rail's clothes — actively worse than the honest absence, which at
//     least does not tell anyone their dose is fine.
//   • NOTHING HERE CHECKS THE REST OF THE SALT. A window says the nitrite dose is
//     plausible; it says nothing about whether the formula is otherwise right.
//   • NOTHING HERE CHECKS SUITABILITY. Whether a nitrite-only product is fit for a
//     ninety-day dry is a different question from whether its dose is safe, and it
//     is not asked anywhere.
//   • SCALING IS NEVER THE DANGER FOR THE STORED PERCENTAGE. Percentages scale
//     linearly, so a dose that is safe at 500 g is safe at 5 kg AS A PERCENTAGE.
//     This stops holding for the PRINTED weight below roughly 70 g of basis: a
//     cure-salt gram figure that small falls under `GRAM_DECIMAL_THRESHOLD` and
//     rounds to one decimal place, and that rounding step can push the number
//     someone actually weighs out over the ppm ceiling even though the stored
//     percentage never moved (pinned in `cureSalt.test.ts`). Above that boundary,
//     what the rail earns its place catching is a mis-typed percentage, a basis
//     mapped to the wrong ingredient, and a scraped recipe that arrived wrong.
//
// So a formula that saves is NOT a formula Salt has pronounced safe.
//
// ─── AND THERE IS NO SECOND CHECK ─────────────────────────────────────────────
//
// Nothing here validates anything. The window is DATA; `deriveFormula` stamps it
// onto the component as `minPercent`/`maxPercent`; `solveFormula` has refused a
// violation since #782 (`boundViolationsIn` → `{ kind: 'boundViolation' }`). A
// safety check with two implementations has two behaviours, so there is one — see
// `adjustComponent.ts`'s header, which argues the same case for leavening.

/** One product, as the jar and the reference literature describe it. */
export type CureSaltProductInfo = {
  /**
   * The product's NAME, which is a fact about the jar rather than app copy about
   * it. It lives here beside the composition, the window and the words that
   * recognise it so that a fifth product cannot be added with three of the four —
   * the same argument `DENSITY_G_PER_ML` makes for keeping its classes together.
   */
  label: string;
  /**
   * Sodium nitrite as a percentage of the product, by mass. THIS IS WHAT SETS THE
   * WINDOW, and it is here so that relationship is mechanical rather than asserted
   * in a comment: `cureSalt.test.ts` computes ingoing nitrite from it and fails if
   * any window's top exceeds the 200 ppm ceiling.
   */
  nitritePercent: number;
  /**
   * The window this product's dose has to sit inside, as a percentage of the basis.
   *
   * THE TOP IS SET BY INGOING NITRITE, not by taste, and it is checked
   * mechanically (`cureSalt.test.ts`): 0.30% of a 6.25% product lands at 187.5 ppm
   * and 3.15% of a 0.6% one lands at 189 ppm, both comfortably under the 200 ppm
   * ceiling, with the standard doses sitting strictly inside rather than at an
   * edge.
   *
   * THE BOTTOM IS THERE BECAUSE UNDER-DOSING IS THE HAZARD, not an aesthetic
   * failure — too little nitrite is a cure that does not protect, which is the
   * whole reason this rail refuses rather than clamping. UNLIKE THE TOP, THE
   * BOTTOM IS NOT CHECKED AGAINST AN EXTERNAL PPM FIGURE: the literature gives a
   * protective range rather than a bright line the way 200 ppm is one, so no
   * "minimum protective ppm" constant is asserted here. What `cureSalt.test.ts`
   * pins on the floor is internal consistency only — positive, below the top,
   * below every dose this file calls ordinary — never a figure computed from an
   * independent minimum (CLAUDE.md rule 12: this is that claim's real boundary).
   */
  bounds: Readonly<ComponentPercentBounds>;
  /**
   * The words that PROPOSE this product from an ingredient's own text.
   *
   * Deliberately short, and deliberately not a taxonomy — the same bargain
   * `guessBasis.ts` makes, for the same reason: `guessSaltProduct` proposes and the
   * screen confirms in one tap, so the list does not have to be right, it has to
   * save the common case.
   *
   * "CURING SALT" ALONE IS NOT HERE, on purpose. It names both families, so a
   * keyword for it would be a coin toss between 0.25% and 3% — which is exactly the
   * recognition-that-decides this file refuses to do. Nor is bare "pink salt":
   * Himalayan pink salt is ordinary salt and is the commoner reading by far.
   *
   * Matched with word boundaries over text normalised by `normalise` below, so
   * "cure #1", "Cure No. 1" and "cure 1" are one keyword and no compound word can
   * match by accident.
   */
  keywords: readonly string[];
};

export const CURE_SALT_PRODUCTS: Readonly<Record<SaltProduct, Readonly<CureSaltProductInfo>>> = {
  // 6.25% sodium nitrite, no nitrate. Cooked or briefly cured: bacon, gammon,
  // pastrami. ~0.25% of the meat, alongside ordinary salt.
  cure1: {
    label: 'Cure #1 (Prague powder #1)',
    nitritePercent: 6.25,
    bounds: { minPercent: 0.15, maxPercent: 0.3 },
    keywords: ['cure 1', 'cure no 1', 'prague powder 1', 'insta cure 1'],
  },
  // 6.25% sodium nitrite plus ~4% potassium nitrate. Long dries: coppa, bresaola,
  // salami. Same dose as cure #1 and therefore the same window — the nitrate is
  // what it is FOR, not what bounds it.
  cure2: {
    label: 'Cure #2 (Prague powder #2)',
    nitritePercent: 6.25,
    bounds: { minPercent: 0.15, maxPercent: 0.3 },
    keywords: ['cure 2', 'cure no 2', 'prague powder 2', 'insta cure 2'],
  },
  // ~0.4–0.6% sodium nitrite, no nitrate, and it IS the salt: ~2.5–3% of the meat.
  // The window is computed from the TOP of that composition range (0.6%), which is
  // the conservative end for a ceiling on ingoing nitrite.
  nitritedCuringSalt: {
    label: 'Nitrited curing salt',
    nitritePercent: 0.6,
    // 3.15, not 3: the literature's own standard dose is 3%, and a window whose
    // top equals its standard dose puts ordinary practice one rounding away from a
    // refusal (#1402 review, should-fix 2). 3.15% is still 189 ppm — comfortably
    // under the 200 ppm ceiling — and leaves the standard dose real headroom.
    bounds: { minPercent: 2, maxPercent: 3.15 },
    keywords: ['nitrited curing salt', 'nitritpokelsalz', 'sel nitrite', 'peklosol', 'colorozo'],
  },
  // 0.6% sodium nitrite plus 0.9% potassium nitrate, used as the whole salt at
  // ~2.5–3%. The long-dry equivalent of the one above.
  salvianda: {
    label: 'Salvianda',
    nitritePercent: 0.6,
    // Same composition and the same standard-dose-at-the-edge problem as
    // `nitritedCuringSalt` above; widened for the same reason.
    bounds: { minPercent: 2, maxPercent: 3.15 },
    keywords: ['salvianda'],
  },
};

/**
 * The window a product's dose has to sit inside.
 *
 * A LOOKUP AND NOTHING MORE — it checks nothing and decides nothing. The caller is
 * `deriveFormula`, which stamps what comes back onto the component; the refusal is
 * `solveFormula`'s and always has been.
 */
export function saltProductBounds(product: SaltProduct): Readonly<ComponentPercentBounds> {
  return CURE_SALT_PRODUCTS[product].bounds;
}

/**
 * The ppm of sodium nitrite a dose of a product puts on the meat.
 *
 * Exposed so the window edges above can be justified mechanically rather than in
 * prose: 0.3% of a 6.25% product is 187.5 ppm. Pure arithmetic, no ceiling applied
 * — the ceiling is a test's assertion, not a runtime check, because nothing at
 * runtime has a ppm figure to check.
 */
export function ingoingNitritePpm(product: SaltProduct, percentOfBasis: number): number {
  return percentOfBasis * CURE_SALT_PRODUCTS[product].nitritePercent * 100;
}

/**
 * Text as the keyword match sees it: lowercase, diacritics dropped, every run of
 * anything that is not a letter or a digit collapsed to one space.
 *
 * So "Nitritpökelsalz" and "nitritpokelsalz" are one word, and "cure #1", "Cure
 * No. 1" and "cure 1" are one phrase. Space-delimited on both sides at the match,
 * which is word-boundary matching by construction — substring matching would be one
 * compound word away from an embarrassment.
 */
function normalise(text: string): string {
  return ` ${text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/** An ingredient as the recogniser sees it — text the CALLER has already resolved. */
export type SaltProductGuessEntry = {
  /**
   * The canon item this ingredient resolved to, if it resolved to one. Canon is the
   * tidier name, so it LEADS — the same rule `BasisGuessEntry` states.
   */
  canonName: string | null;
  /** The recipe's own line, used only when there is no canon name. */
  rawText: string;
};

/**
 * PROPOSE which curing salt an ingredient is, or nothing.
 *
 * A GUESS, and never a decision. The bound that is actually enforced is read from
 * the product RECORDED ON THE COMPONENT, never from this text — so a wrong guess
 * costs a tap and a missing guess costs a tap, which is the whole bargain
 * `guessBasis.ts` already makes and the reason the keyword list can stay short.
 *
 * ITS COST WHEN IT MISSES IS A TAP AND NOT A BOUND, and that is a property of the
 * screen rather than of this function: `FormulaPage` offers the product control on
 * every included row, not only on the rows this recognises, so an unrecognised
 * curing salt can still be named. A recogniser that gated the control would make
 * this keyword list load-bearing on safety, which is precisely what it must not be.
 *
 * Pure and total: no I/O, no clock, no canon lookup. `null` means "you pick".
 */
export function guessSaltProduct(entry: SaltProductGuessEntry): SaltProduct | null {
  const text = normalise(entry.canonName ?? entry.rawText);
  for (const [product, info] of Object.entries(CURE_SALT_PRODUCTS)) {
    if (info.keywords.some((keyword) => text.includes(normalise(keyword)))) {
      return product as SaltProduct;
    }
  }
  return null;
}
