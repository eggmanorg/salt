import type {
  DensityClass,
  Formula,
  FormulaComponent,
  ReferenceYield,
  SaltProduct,
} from '../schemas/formula.js';
import type { FormulaFailure } from './failure.js';
import { boundsPatch } from './adjustComponent.js';
import { saltProductBounds } from './cureSalt.js';
import { PERCENT_DECIMALS, roundPercent } from './rounding.js';

// Turn a recipe's gram figures plus a basis selection into percentages — the one
// direction that creates a formula (issue #782). Everything else in this module
// reads percentages back out.

export type FormulaComponentInput = {
  ingredientId: string;
  // Required, always. There is exactly one scaling mechanism: an ingredient
  // either carries a gram figure or is not a component. A second "passthrough"
  // set scaling on a plain yield ratio would give you 1.68 eggs at a 1.68× yield
  // and then need its own rounding rule; and a trace ingredient — 5 ml of oil for
  // greasing the bowl — would be scaled to 8.4 ml, which nobody wants. Those
  // arrive with no amount at all, `gramsFromParsed` returns null for them, and the
  // caller simply leaves them out.
  grams: number;
  inBasis: boolean;
  density?: DensityClass;
  // WHICH SALT-BEARING PRODUCT THIS IS, carried through onto the derived component
  // (issue #1402). The screen has to be able to hand this back on a re-save, which
  // is what makes the choice survive a reload.
  saltProduct?: SaltProduct;
  // Bounds a caller wants declared on this component, when it has an opinion of its
  // own. A NAMED PRODUCT OUTRANKS THEM: see `boundsOn` below for why there is a
  // precedence rule here at all rather than a merge.
  minPercent?: number;
  maxPercent?: number;
};

export type DeriveFormulaInput = {
  recipeId: string;
  components: readonly FormulaComponentInput[];
  // Defaults to the basis weight the percentages were derived at, which is the
  // honest reference: these ratios came from this much flour. A caller that knows
  // the recipe as written makes 2 × 900 g of dough can say so instead.
  referenceYield?: ReferenceYield;
};

export type DeriveFormulaResult =
  { ok: true; formula: Formula } | { ok: false; reason: FormulaFailure };

// ─── Reconciling the basis to 100 (issue #1364) ───────────────────────────────
//
// Rounding each basis member on its own loses the residual: three equal flours
// round to 33.3333 apiece and the basis sums to 99.9999, so everything measured
// AGAINST that basis is measured against 0.999999 of the 100% it is supposed to
// be. One derive is harmless — a ten-thousandth of a point, two orders below what
// any screen prints — but `FormulaPage` round-trips derive → solve → derive on
// every commit, and each pass divides the out-of-basis percentages by 0.999999
// again. Unbounded, stored, and cumulative across sessions.
//
// So the basis is reconciled by LARGEST REMAINDER: every member floors to a whole
// four-decimal unit, and the units the flooring lost are handed back one at a
// time to the members that lost most of one. The members' UNIT COUNTS then sum to
// 100 exactly, on every split; no member moves more than one unit — a
// ten-thousandth of a point — off its true share; and the derive → solve → derive
// round trip is a fixed point for a basis of any size.
// `tests/formula/basisRoundTrip.test.ts` pins all three, and states the one
// boundary: adding the stored floats back up is a separate act, and a seven-way
// split sums to 100.00000000000001 in IEEE 754. That gap is fourteen orders below
// `BASIS_PERCENT_TOLERANCE`, which is what actually reads the sum.
//
// WHAT IT COSTS, STATED: one member carries the whole residual (33.3334 against
// its neighbours' 33.3333), so that figure now depends on the others. `rounding.ts`
// rejects exactly that coupling for GRAMS, and this is a deliberately different
// call on a different quantity — see the amended comment there.

/**
 * The window to stamp on one component — the ONE place a bound is decided.
 *
 * A NAMED PRODUCT WINS OUTRIGHT, and that is the whole mechanism (issue #1402). The
 * window is a fact about the product, so it is recomputed from `saltProduct` on
 * every derive: a stored bound therefore cannot drift from the table, cannot be lost
 * on a re-save the way `FormulaPage.componentsFrom` silently lost one before this,
 * and cannot be widened except by naming a DIFFERENT PRODUCT — which changes what
 * the ingredient is, and is exactly the sort of thing the person mapping a formula
 * is looking straight at.
 *
 * Precedence rather than a merge, because a merge would let a caller's `maxPercent`
 * widen a product's window one end at a time, which is the one thing that must not
 * be possible. A caller's bounds are honoured only where no product is named —
 * which is how `withComponentPercentScaled`'s leavening rail still works.
 *
 * THE PATCH ITSELF COMES FROM `boundsPatch` (`adjustComponent.ts`), the one place
 * that decides how a bounds record replaces whatever a component already carries.
 * `cureSalt.ts`'s substitution stamp reads from the same function, so the two
 * cannot independently drift on a case like `plain`'s (#1402 review, should-fix 4).
 * The PRECEDENCE decided here — which record wins — is this function's alone.
 *
 * NOTHING IS CHECKED HERE. This returns data; `solveFormula` is what refuses.
 */
function boundsOn(component: FormulaComponentInput): {
  minPercent?: number;
  maxPercent?: number;
} {
  if (component.saltProduct !== undefined) {
    return boundsPatch(saltProductBounds(component.saltProduct));
  }
  return boundsPatch({ minPercent: component.minPercent, maxPercent: component.maxPercent });
}

/** One component, measured against the basis before any reconciliation. */
type Measured = {
  component: FormulaComponentInput;
  exactPercent: number;
  percent: number;
};

type Counted = { measured: Measured; units: number; remainder: number };

/** The basis members' percentages, reconciled to 100. Keyed by identity. */
function reconciledBasisPercents(basis: readonly Measured[]): Map<Measured, number> {
  const scale = 10 ** PERCENT_DECIMALS;
  const counted: Counted[] = basis.map((measured) => {
    const scaled = measured.exactPercent * scale;
    const units = Math.floor(scaled);
    return { measured, units, remainder: scaled - units };
  });

  // ONLY EVER HANDED OUT, NEVER TAKEN BACK, and that is a property rather than an
  // assumption: no floor exceeds its own value, so the floors sum to at most the
  // members' true total — which is 100 × scale plus the float error of summing a
  // handful of terms, around 1e-8 units at this magnitude. An integer sum can only
  // overshoot by a whole unit, eight orders above that error, so `residual` is
  // always between 0 and the member count.
  let residual = 100 * scale - counted.reduce((sum, entry) => sum + entry.units, 0);

  // Largest remainder first: the members that lost most of a unit to the floor get
  // one back. `sort` is stable, so an exact tie — three equal flours — hands it to
  // the earliest member rather than to an arbitrary one.
  const rounded = new Set<Counted>();
  for (const entry of [...counted].sort((a, b) => b.remainder - a.remainder)) {
    if (residual <= 0) break;
    rounded.add(entry);
    residual -= 1;
  }

  return new Map(
    counted.map((entry) => [entry.measured, (entry.units + (rounded.has(entry) ? 1 : 0)) / scale]),
  );
}

/** Every component as a percentage of the basis, in the order given. */
function componentsAgainst(
  components: readonly FormulaComponentInput[],
  basisGrams: number,
): FormulaComponent[] {
  const measured: Measured[] = components.map((component) => {
    const exactPercent = (component.grams / basisGrams) * 100;
    return { component, exactPercent, percent: roundPercent(exactPercent) };
  });
  const reconciled = reconciledBasisPercents(measured.filter((m) => m.component.inBasis));

  return measured.map((entry) => {
    const { component } = entry;
    return {
      ingredientId: component.ingredientId,
      // A miss is an out-of-basis component, which keeps the percentage it rounded
      // to: it is measured against the basis, not part of it, so there is nothing
      // to reconcile it with.
      percent: reconciled.get(entry) ?? entry.percent,
      inBasis: component.inBasis,
      ...(component.density !== undefined ? { density: component.density } : {}),
      ...(component.saltProduct !== undefined ? { saltProduct: component.saltProduct } : {}),
      ...boundsOn(component),
    };
  });
}

/**
 * Derive a formula from grams. Pure; no clock, no I/O, no throw.
 *
 * The basis members' percentages are reconciled to 100 (see `reconciledBasisPercents`
 * above) rather than left to round where they fall, so a formula derived HERE never
 * fails `solveFormula` with `basisNotNormalised`. That is the only failure this
 * reconciliation rules out: a derived formula can still be refused for a
 * `boundViolation`, since bounds come in from the caller and are never checked
 * against each other here.
 *
 * A NAMED CURING SALT GETS ITS PRODUCT'S WINDOW STAMPED ON THE WAY THROUGH (issue
 * #1402, `boundsOn`), which is what makes a bound impossible to lose and impossible
 * to hand-edit. Still nothing is CHECKED here — a derived formula whose cure salt is
 * out of its window comes back `ok` and is refused by `solveFormula`, which is the
 * one rail and has been since #782.
 *
 * Nor is a stored formula guaranteed normalised. A hand edit can unnormalise one,
 * and so can simply having been written before this reconciliation existed
 * (#1364) — production holds those. `BASIS_PERCENT_TOLERANCE` is what forgives
 * both.
 */
export function deriveFormula(input: DeriveFormulaInput): DeriveFormulaResult {
  const { recipeId, components, referenceYield } = input;

  if (components.length === 0) return { ok: false, reason: { kind: 'emptyFormula' } };

  for (const component of components) {
    if (!Number.isFinite(component.grams) || component.grams <= 0) {
      return {
        ok: false,
        reason: {
          kind: 'invalidAmount',
          ingredientId: component.ingredientId,
          grams: component.grams,
        },
      };
    }
  }

  const basisGrams = components
    .filter((component) => component.inBasis)
    .reduce((sum, component) => sum + component.grams, 0);
  if (basisGrams <= 0) return { ok: false, reason: { kind: 'noBasis' } };

  const derived: FormulaComponent[] = componentsAgainst(components, basisGrams);

  return {
    ok: true,
    formula: {
      recipeId,
      components: derived,
      referenceYield: referenceYield ?? { kind: 'basis', grams: basisGrams },
      // NO TARGET, and nothing here can author one (issue #1407). Derivation turns
      // weights into percentages; what a run of this is AIMING AT is a separate
      // answer the screen collects and merges on the way to `saveFormula`. Written
      // explicitly rather than left to the schema's read default, for the reason
      // `schemaVersion` below is: this is a CONSTRUCTION, and a default is what a
      // stored document reads back as.
      target: null,
      schemaVersion: 1,
    },
  };
}
