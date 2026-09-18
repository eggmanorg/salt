import type { Formula, FormulaComponent, SaltProduct } from '../schemas/formula.js';
import { boundsPatch, type ComponentPercentBounds } from './adjustComponent.js';
import { roundPercent } from './rounding.js';

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
//
// `withCureSaltSubstituted` at the foot of this file does arithmetic and RESTAMPS
// the window of the product it named, from the table above. It checks no dose: an
// out-of-window result is `solveFormula`'s to refuse, exactly as a hand-typed
// percentage is. What it refuses are the things that are not a DOSE question at all
// — a pair it may not cross, and a salt total that cannot be rebalanced.
//
// ─── AND WHAT A SUBSTITUTION DOES NOT DO ──────────────────────────────────────
//
//   • IT HOLDS THE NITRITE DOSE CONSTANT AND THE NITRATE DIVERGES. Nitrite is the
//     acute safety number, so it is the one that must not move — and the two cannot
//     both be matched: cure #2 is ~6.25% nitrite / ~4% nitrate and Salvianda is
//     0.6% / 0.9%, so matching nitrite leaves ingoing nitrate roughly 2.3× apart
//     (pinned in `cureSalt.test.ts`). Splitting the difference would move the
//     number that matters to flatter the one that does not.
//   • IT NEVER CROSSES A PAIR. Nitrite-only swaps with nitrite-only and
//     nitrate-bearing with nitrate-bearing (`CURE_SALT_PAIRS`), because crossing
//     changes what the cure is FIT FOR rather than merely its concentration. Which
//     product suits which cure is the suitability question above, and a converter
//     that crossed the line would answer it by accident.
//   • IT SAYS NOTHING ABOUT WHETHER THE SUBSTITUTE IS THE RIGHT PRODUCT for what
//     is being made. It says the nitrite dose is the same one.

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
   * Potassium nitrate as a percentage of the product, by mass — 0 for the
   * nitrite-only products and for plain salt.
   *
   * IT BOUNDS NOTHING AND IS MATCHED BY NOTHING (issue #1402, phase 3). It is here
   * for two jobs, both mechanical rather than decorative: it is what makes
   * `CURE_SALT_PAIRS` checkable — a pair's two members must agree about whether they
   * carry nitrate, which is the whole reason the pairs exist — and it is what lets
   * `cureSalt.test.ts` state the divergence a substitution leaves behind, rather
   * than asserting "roughly 2.3×" in prose nobody can falsify.
   *
   * A SUBSTITUTION DOES NOT MATCH IT, deliberately. Nitrite is the acute number and
   * the two cannot both be held: see this file's header.
   */
  nitratePercent: number;
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
   *
   * EMPTY FOR A PRODUCT THAT CARRIES NO NITRITE — which is `plain` and, by
   * construction, only `plain`: a window is derived from ingoing nitrite, so a
   * product with none has nothing to derive one from. That equivalence is pinned in
   * `cureSalt.test.ts` rather than left to this sentence, so a fifth product cannot
   * arrive carrying nitrite and no window.
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
   *
   * WORD BOUNDARIES ARE NOT ENOUGH ON THEIR OWN, because two of these keywords end
   * in a bare digit and English puts a duration in exactly that slot: "cure 2 days"
   * is a step, not a product. `DURATION_WORDS` below is the second half of the
   * guard — see `guessSaltProduct`.
   */
  keywords: readonly string[];
};

export const CURE_SALT_PRODUCTS: Readonly<Record<SaltProduct, Readonly<CureSaltProductInfo>>> = {
  // 6.25% sodium nitrite, no nitrate. Cooked or briefly cured: bacon, gammon,
  // pastrami. ~0.25% of the meat, alongside ordinary salt.
  cure1: {
    label: 'Cure #1 (Prague powder #1)',
    nitritePercent: 6.25,
    nitratePercent: 0,
    bounds: { minPercent: 0.15, maxPercent: 0.3 },
    keywords: ['cure 1', 'cure no 1', 'prague powder 1', 'insta cure 1'],
  },
  // 6.25% sodium nitrite plus ~4% potassium nitrate. Long dries: coppa, bresaola,
  // salami. Same dose as cure #1 and therefore the same window — the nitrate is
  // what it is FOR, not what bounds it.
  cure2: {
    label: 'Cure #2 (Prague powder #2)',
    nitritePercent: 6.25,
    nitratePercent: 4,
    bounds: { minPercent: 0.15, maxPercent: 0.3 },
    keywords: ['cure 2', 'cure no 2', 'prague powder 2', 'insta cure 2'],
  },
  // ~0.4–0.6% sodium nitrite, no nitrate, and it IS the salt: ~2.5–3% of the meat.
  // The window is computed from the TOP of that composition range (0.6%), which is
  // the conservative end for a ceiling on ingoing nitrite.
  nitritedCuringSalt: {
    label: 'Nitrited curing salt',
    nitritePercent: 0.6,
    nitratePercent: 0,
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
    nitratePercent: 0.9,
    // Same composition and the same standard-dose-at-the-edge problem as
    // `nitritedCuringSalt` above; widened for the same reason.
    bounds: { minPercent: 2, maxPercent: 3.15 },
    keywords: ['salvianda'],
  },
  // ORDINARY SALT, and the reason this enum is named for the salt-bearing product
  // rather than for cure salt (issue #1402, phase 3). A substitution moves mass
  // between the curing salt and the plain salt, so the plain salt has to be
  // findable; a second field for "this is the ordinary salt" would be one field too
  // many.
  //
  // NO NITRITE, NO NITRATE, NO WINDOW. Ordinary salt has no safe-dose ceiling to
  // read off a composition — too much is a dish nobody eats — so it is bounded by
  // nothing, exactly as a component naming no product is.
  //
  // AND NO KEYWORDS, WHICH IS A DECISION RATHER THAN AN OVERSIGHT. Bare "salt" is
  // the obvious keyword and it is the wrong one: word-boundary matched, it reaches
  // "pink curing salt" and "curing salt" — the very lines the entries above
  // deliberately refuse to guess at, because those words name both families. A
  // proposal of "Plain salt" on a curing salt is a confident false claim where "you
  // pick" is an honest one, and it is the recognition-that-decides this file exists
  // to avoid. So `guessSaltProduct` never proposes this, and the plain salt is
  // named in the same one tap the curing salt costs (pinned in `cureSalt.test.ts`).
  plain: {
    label: 'Plain salt',
    nitritePercent: 0,
    nitratePercent: 0,
    bounds: {},
    keywords: [],
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

/**
 * The words that turn a keyword's trailing digit into a COUNT rather than a name.
 *
 * "cure 2" is a product and "cure 2 days" is a step, and word-boundary matching alone
 * cannot tell them apart: ' cure 2 ' is a genuine, boundary-respecting occurrence
 * inside ' cure 2 days ' (#1442, PR #1427 review). Both digit-ending keywords —
 * `cure 1` and `cure 2` — sit in the one slot English also uses for a duration, so a
 * step or a note wording can make the recogniser propose the wrong jar.
 *
 * DELIBERATELY A SHORT BLOCKLIST rather than a grammar, and applied to every keyword
 * rather than only the digit-ending ones: "salvianda weeks" is not a phrase anyone
 * writes, so the uniform rule costs nothing and has no second branch to drift. Its
 * real boundary, stated rather than hidden (CLAUDE.md rule 12): it catches the
 * duration that FOLLOWS the keyword and nothing else — "cure 2 d", an abbreviation
 * not listed here, still proposes. That is the same bargain the keyword list itself
 * makes, and it costs a tap either way, never a bound.
 */
const DURATION_WORDS: readonly string[] = [
  'min',
  'mins',
  'minute',
  'minutes',
  'hr',
  'hrs',
  'hour',
  'hours',
  'day',
  'days',
  'night',
  'nights',
  'week',
  'weeks',
  'month',
  'months',
  'year',
  'years',
];

/**
 * Does this keyword occur in the text as a NAME rather than as a count?
 *
 * Every occurrence is considered, not just the first, so "cure 2 days in cure 2"
 * still finds the product on the second pass. `normalise` leaves the needle
 * space-delimited on both sides, so the text immediately after a match begins at the
 * next word.
 */
function occursAsName(text: string, keyword: string): boolean {
  const needle = normalise(keyword);
  for (let from = 0; ; from += 1) {
    const at = text.indexOf(needle, from);
    if (at === -1) return false;
    const nextWord = text.slice(at + needle.length).split(' ')[0] ?? '';
    if (!DURATION_WORDS.includes(nextWord)) return true;
    from = at;
  }
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
    if (info.keywords.some((keyword) => occursAsName(text, keyword))) {
      return product as SaltProduct;
    }
  }
  return null;
}

// ─── The jar you actually have (issue #1402, phase 3) ─────────────────────────

/**
 * Does this product carry nitrite — which is to say, is it a CURING salt at all?
 *
 * READ OFF THE COMPOSITION rather than off a second hand-kept list, so it cannot
 * drift from the table: a curing salt is a salt that carries nitrite, and `plain` is
 * the one member that does not. It is also what "has a window" means, because a
 * window is derived from ingoing nitrite — `cureSalt.test.ts` pins that equivalence
 * in both directions rather than leaving it to this sentence.
 */
export function isCuringSalt(product: SaltProduct): boolean {
  return CURE_SALT_PRODUCTS[product].nitritePercent > 0;
}

/**
 * THE TWO PAIRS, AND A SUBSTITUTION NEVER CROSSES THEM.
 *
 * Nitrite-only swaps with nitrite-only (cure #1 ↔ nitrited curing salt) and
 * nitrate-bearing with nitrate-bearing (cure #2 ↔ Salvianda). Crossing changes what
 * the cure is FIT FOR rather than merely its concentration — nitrite alone depletes
 * over a long dry with no reservoir behind it — and that suitability question is
 * deliberately unasked anywhere in Salt. A converter that crossed the line would
 * answer it by accident.
 *
 * The pairing is not merely asserted here: each pair's members must agree about
 * whether they carry nitrate, checked against `nitratePercent` in
 * `cureSalt.test.ts`, so a pair written the wrong way round goes red.
 */
export const CURE_SALT_PAIRS: readonly (readonly [SaltProduct, SaltProduct])[] = [
  ['cure1', 'nitritedCuringSalt'],
  ['cure2', 'salvianda'],
];

/** The other member of this product's pair, or null for one that has no pair. */
export function pairOf(product: SaltProduct): SaltProduct | null {
  for (const [one, other] of CURE_SALT_PAIRS) {
    if (product === one) return other;
    if (product === other) return one;
  }
  return null;
}

/** Why a substitution produced no formula. Figures, never sentences — the screen words it. */
export type CureSaltSubstitutionFailure =
  // Not an available substitution at all: no curing salt named on the formula, more
  // than one, or a `to` that is not this product's pair member. The sheet only ever
  // offers the pair member of a single named product, so this is the guard behind
  // that offer rather than a state a person can tap their way into.
  | { kind: 'notAvailable' }
  // A NAMED plain-salt component exists and its weight, together with the cure's
  // own, still cannot carry the dose in the substitute's dilute form. REFUSED WITH
  // BOTH FIGURES AND NEVER CLAMPED: clamping the substitute under-cures and
  // clamping the residual over-salts, so both ways of hiding this are harmful. The
  // remedy this names — raising the NAMED plain-salt row — is reachable exactly
  // because that row already carries some weight; see `noPlainSalt` for the state
  // where nothing named `plain` does (#1402 review, blocking 1).
  | { kind: 'saltTooLow'; needsPercent: number; saltBearingPercent: number }
  // NOTHING NAMED `plain` CARRIES ANY WEIGHT — whether because no component names
  // it at all (the ordinary state every formula is in today, since phase 2 stamps
  // no formula with `plain` and `guessSaltProduct` never proposes it) or because a
  // named plain-salt row sits at 0 g (#1402 review, should-fix 2). Either way the
  // swap has no row to move the difference into or out of, in EITHER direction.
  // `residualPercent` carries the sign:
  // positive means the substitute needs LESS mass and the surplus has nowhere to
  // go (dropping it would be a quietly less salty cure); negative means the
  // substitute needs MORE than the named cure alone provides, and the shortfall is
  // salt this formula may well already have — just not under a name the swap can
  // read. `needsPercent`/`saltBearingPercent` ride along for the same reason
  // `saltTooLow` carries them: so the screen can print a real figure rather than a
  // sentence. Either way the remedy is the same and it is the one this states:
  // name the ordinary salt on the formula screen. "Put the salt up" is NOT this
  // failure's remedy — an unnamed row's weight never reaches `saltBearingPercent`,
  // so raising it changes nothing here.
  | {
      kind: 'noPlainSalt';
      residualPercent: number;
      needsPercent: number;
      saltBearingPercent: number;
    };

export type CureSaltSubstitutionResult =
  { ok: true; formula: Formula } | { ok: false; reason: CureSaltSubstitutionFailure };

/**
 * One component with a product named on it and the window that product dictates.
 *
 * REBUILT FROM THE TABLE, so a bound cannot survive the swap: the component is
 * copied, any window it arrived with is dropped, and the named product's own is put
 * back — through `boundsPatch` (`adjustComponent.ts`), the ONE place that patch is
 * built. `boundsOn` in `deriveFormula` decides the PRECEDENCE between a product's
 * window and a caller's — there is no precedence question here, because this names
 * a product outright — but both it and this function apply the winning window
 * through the same `boundsPatch`, so the two cannot independently drift the way two
 * hand-written copies could (#1402 review, should-fix 4). `cureSalt.test.ts` asserts
 * that no component NAMING A PRODUCT disagrees with the table — not every
 * component, since a component naming none may legitimately carry a caller's own
 * bounds (`boundsOn`'s precedence rule), and this function leaves that one alone.
 */
function withProductStamped(component: FormulaComponent, product: SaltProduct): FormulaComponent {
  const next: FormulaComponent = { ...component, saltProduct: product };
  delete next.minPercent;
  delete next.maxPercent;
  return { ...next, ...boundsPatch(saltProductBounds(product)) };
}

/**
 * Swap the curing salt a formula names for the other member of its pair, holding the
 * NITRITE DOSE CONSTANT and letting the plain salt absorb the difference.
 *
 * The arithmetic, in percent-of-basis, which is how everything here is already
 * expressed:
 *
 *     nitrite%        = curing.percent × curing nitrite fraction
 *     substitute%     = nitrite% ÷ substitute nitrite fraction
 *     residual plain% = (curing.percent + plain.percent) − substitute%
 *
 * 1000 g of meat, 2.5 g of cure #1 (6.25% nitrite ⇒ 0.156 g nitrite) and 25 g of
 * salt: 0.156 ÷ 0.006 is 26 g of nitrited curing salt, leaving 1.5 g of plain salt.
 * Reversed, the same recipe collapses back to 2.5 g and 25 g exactly.
 *
 * PURE, and A NEW FORMULA EVERY TIME — the original is untouched, nothing is written
 * anywhere, and the shape is `withComponentPercentScaled`'s (`adjustComponent.ts`).
 * It CHECKS NO DOSE: the substituted percentage carries the substitute's own window
 * and `solveFormula` refuses an out-of-window result exactly as it refuses a
 * hand-typed one. There is no second rail here and must not be.
 *
 * WHAT IT DOES REFUSE is what is not a dose question: a pair it may not cross, and a
 * salt total that cannot be rebalanced. Unlike a refused leavening opinion — dropped
 * silently, because nobody asked for it — a refused substitution is the person's own
 * explicit choice, so the caller is expected to SURFACE it.
 *
 * SEVERAL PLAIN-SALT COMPONENTS share the residual in proportion to what they
 * already hold, and the exact-round-trip claim above is pinned for the ordinary
 * single one: with two, each is re-rounded to four decimals, so a round trip can land
 * a ten-thousandth of a point off where it started.
 */
export function withCureSaltSubstituted(
  formula: Formula,
  substitution: { to: SaltProduct },
): CureSaltSubstitutionResult {
  const { to } = substitution;
  const notAvailable: CureSaltSubstitutionResult = { ok: false, reason: { kind: 'notAvailable' } };

  const curing = formula.components.filter(
    (component) => component.saltProduct !== undefined && isCuringSalt(component.saltProduct),
  );
  const [source] = curing;
  // More than one curing salt has no single answer to "which one is being swapped",
  // so it is refused rather than guessed at.
  if (source === undefined || curing.length > 1) return notAvailable;
  const from = source.saltProduct;
  if (from === undefined || pairOf(from) !== to) return notAvailable;

  const fromNitrite = CURE_SALT_PRODUCTS[from].nitritePercent;
  const toNitrite = CURE_SALT_PRODUCTS[to].nitritePercent;
  // Both members of a pair carry nitrite by construction, so neither is zero. Guarded
  // anyway rather than trusted: a division is where a mistaken table edit would reach
  // a scale as `Infinity g`.
  if (fromNitrite <= 0 || toNitrite <= 0) return notAvailable;

  const substitutePercent = roundPercent((source.percent * fromNitrite) / toNitrite);
  const plain = formula.components.filter((component) => component.saltProduct === 'plain');
  const plainPercent = plain.reduce((sum, component) => sum + component.percent, 0);
  const saltBearingPercent = roundPercent(source.percent + plainPercent);
  const residualPercent = roundPercent(saltBearingPercent - substitutePercent);

  // NO COMPONENT NAMED `plain` HAS ANY WEIGHT TO OFFER — checked on `plainPercent`
  // rather than `plain.length` (#1402 review, should-fix 2: a plain row present at
  // 0 g must refuse exactly as an absent one does, not silently drop the residual)
  // — and checked FIRST, ahead of `saltTooLow` below (#1402 review, blocking 1).
  // `saltBearingPercent` above only ever counts a NAMED plain-salt row, so on the
  // formula every real recipe is in today — no row named `plain`, because phase 2
  // stamps none and the recogniser never proposes it — a deficit here is not
  // evidence the recipe lacks salt, only that this swap cannot see any. Telling
  // that person to "put the salt up" would send them chasing a number that can
  // never move, because an unnamed row's weight never reaches `saltBearingPercent`.
  // The honest and actionable fact in both directions (surplus or deficit) is the
  // same one: nothing here is named as the ordinary salt.
  if (residualPercent !== 0 && plainPercent === 0) {
    return {
      ok: false,
      reason: {
        kind: 'noPlainSalt',
        residualPercent,
        needsPercent: substitutePercent,
        saltBearingPercent,
      },
    };
  }
  // Reached only once a NAMED plain-salt row's weight has already been counted
  // into `saltBearingPercent` and it is still not enough — so raising that row on
  // the formula screen is a remedy this refusal can actually promise.
  if (residualPercent < 0) {
    return {
      ok: false,
      reason: { kind: 'saltTooLow', needsPercent: substitutePercent, saltBearingPercent },
    };
  }

  // `plainPercent` is provably nonzero here: the guard above has already returned
  // for `residualPercent !== 0 && plainPercent === 0`, and `residualPercent === 0`
  // makes `plainFactor` irrelevant since nothing is being redistributed. Kept
  // rather than asserted, so a future change to the guard above fails safe.
  const plainFactor = plainPercent === 0 ? 0 : residualPercent / plainPercent;
  return {
    ok: true,
    formula: {
      ...formula,
      components: formula.components.map((component) => {
        if (component.ingredientId === source.ingredientId) {
          return withProductStamped({ ...component, percent: substitutePercent }, to);
        }
        if (component.saltProduct === 'plain') {
          return withProductStamped(
            { ...component, percent: roundPercent(component.percent * plainFactor) },
            'plain',
          );
        }
        return component;
      }),
    },
  };
}
