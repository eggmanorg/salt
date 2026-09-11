<script lang="ts">
  import pluralize from 'pluralize';
  import { scaleQuantity } from '@salt/domain';
  import type { Ingredient } from '@salt/domain';
  import type { QuantityDoc } from '@salt/domain/schemas';

  // The single source of truth for how one ingredient reads as text. RecipeViewPage
  // (the recipe detail page) and CookModePage (mise-en-place + per-step first-use)
  // both render through this, so the two surfaces can never drift: amount-first
  // whenever the line HAS an amount, with the other way of saying that amount as a
  // muted "(…)" note, and the raw line verbatim otherwise. The interactive
  // canon-match (✗) affordance is NOT part of this — RecipeViewPage appends it
  // after.
  //
  // An amount is an amount whether or not it carries a unit. `parsed.unit` is
  // `'g' | 'ml' | null`, and `null` means the amount is a COUNT — a complete parse,
  // not a failed one (`packages/domain/src/schemas/recipe.ts`, `docs/recipe-module.md`).
  // So "1 large egg" splits into `1` and `large egg` exactly as "300g red lentils"
  // splits, and its `displayText` (the gram estimate, "about 50g") stacks under the
  // number just as a metric line's original measure does. Gating the split on the
  // unit made every count line render as raw text with an empty amount column —
  // 14% of the library, all of them eggs, garlic cloves and poultry joints (#951).
  //
  // `part` splits that ONE rendering into pieces rather than forking the component
  // (issue #878): the recipe page lays an ingredient out as three columns — the
  // pictogram, the thing, the amount — so it asks for the pieces separately and
  // places them itself. The words are still written in exactly one place, so a
  // change to how an amount or a preparation reads still lands on both surfaces at
  // once. `all` is the default and renders every piece in reading order, which is
  // what CookModePage and GuidedCookPage keep asking for.
  //
  // The parts, and what each is for:
  //   quantity — the amount alone: "300g" with a unit, the bare number ("1", "4")
  //              for a count. The recipe page's right column.
  //   name     — the thing and everything said ABOUT the thing: item, preparation,
  //              parenthetical notes, "(optional)". The recipe page's middle column.
  //   display  — the OTHER way of saying the amount, alone ("(1 ½ cups)" under
  //              300g; "(about 50g)" under 1 egg). The recipe page puts this UNDER
  //              the amount, because it is a second way of saying the same number
  //              and belongs beside it, not trailing the end of a sentence about
  //              lentils. It carries its own `block` in that part rather than being
  //              wrapped by the caller, so a line with no second measure renders
  //              NOTHING — a wrapper would leave an empty line box under every
  //              amount in the list.
  //
  // A line with no separable amount — unparsed (`parsed === null`), or parsed to no
  // `quantity` at all ("A crack of black pepper") — renders nothing for `quantity`
  // and `display`, and carries the whole raw line in `name`. That is what keeps the
  // recipe page's name column straight down a part-parsed list instead of ragging in
  // and out, and it stays the right answer for a line the parse genuinely could not
  // read (issue #949 rows). It is NOT the answer for a count.

  // ─── Scaling goes IN HERE, once (issue #1314) ───────────────────────────────
  //
  // A recipe can be read at a different number of servings than it states, and
  // every amount on screen restates to match. This is the only component that
  // writes an ingredient amount anywhere in the app — the recipe page's three
  // columns, cook mode's mise rows and per-step chips, guided cook's three — so
  // the multiplication happens here and at none of the eight call sites. They pass
  // a factor; they never do arithmetic.
  //
  // `scale` is the DISPLAY factor and rounds for a human ("450g", "4½"). It is not
  // what the shopping list buys: `buildRecipeAddPlan` multiplies at full float
  // precision from the same servings figure, so the shopper is never handed a
  // twice-rounded number. See `scaleQuantity`'s header for the boundary.
  interface Props {
    ingredient: Ingredient;
    part?: 'all' | 'quantity' | 'name' | 'display';
    /** 1 means "as written", and is the only value that renders exactly as before. */
    scale?: number;
  }
  let { ingredient, part = 'all', scale = 1 }: Props = $props();

  // The common cooking fractions, as the single glyph a recipe would print. Halves
  // through eighths covers what a mixed quantity actually holds; anything outside
  // the set falls back to the decimal this always rendered.
  const VULGAR: Record<string, string> = {
    '1/2': '½',
    '1/3': '⅓',
    '2/3': '⅔',
    '1/4': '¼',
    '3/4': '¾',
    '1/8': '⅛',
    '3/8': '⅜',
    '5/8': '⅝',
    '7/8': '⅞',
  };

  // `formatQty`, not `formatMetricQty`: a count is a quantity with no unit, and the
  // number itself is written the same way either way.
  //
  // The mixed case rendered `{whole:0, numerator:1, denominator:2}` as "0.5", which
  // no count line ever reached while counts fell to raw text. Splitting them out
  // without this would newly have made staging's "½ clove garlic" read "0.5 garlic
  // clove" — a row the split would have made worse. "1½" is tight, no space: it is
  // one number in the amount column, not two.
  function formatQty(q: QuantityDoc): string {
    if (q.type === 'range') return `${q.min}–${q.max}`;
    if (q.type === 'single') return String(q.value);
    const glyph = VULGAR[`${q.numerator}/${q.denominator}`];
    if (glyph === undefined) return String(q.whole + q.numerator / q.denominator);
    return q.whole === 0 ? glyph : `${q.whole}${glyph}`;
  }

  // Whether the amount is more than one, for plural agreement below. A range takes
  // its upper bound ("1–2 garlic cloves"); a mixed quantity its total, so 1½ is
  // plural and ½ is not.
  function exceedsOne(q: QuantityDoc): boolean {
    if (q.type === 'range') return q.max > 1;
    if (q.type === 'single') return q.value > 1;
    return q.whole + q.numerator / q.denominator > 1;
  }

  const parsed = $derived(ingredient.parsed);

  // The amount this line actually states, at the scale being read. Everything
  // below — the figure, and the plural agreement of the item beside it — reads
  // this and never `parsed.quantity`, so a scaled "4½ garlic cloves" agrees with
  // itself. At scale 1 `scaleQuantity` returns the stored quantity itself, so an
  // unscaled line is byte-for-byte what it was.
  const quantity = $derived(
    parsed && parsed.quantity ? scaleQuantity(parsed.quantity, scale, parsed.unit) : null,
  );

  // The amount, or null when the line has none. `quantity` alone decides whether
  // there is something to render; the unit only decides how it is spelled — appended
  // for a measure ("300g"), absent for a count ("1"), which is precisely how
  // ShoppingItemRow's `leadingQuantity` has always written the same value.
  //
  // This is also the test the name half reads: a line with no amount shows its raw
  // text, exactly as the single-run template did. Reading `unit` here as well made a
  // count indistinguishable from an unparsed line and sent it down that same raw-text
  // branch (#951).
  const amount = $derived(parsed && quantity ? `${formatQty(quantity)}${parsed.unit ?? ''}` : null);

  // `parsed.item` is not reliably plural-agreed with `quantity` — staging stores
  // `item: "garlic clove"` against `quantity: 4`. That never showed while count lines
  // rendered as raw text; composing them into a sentence (`part="all"`: cook mode's
  // mise rows, the per-step first-use chips) exposes it, so agreement happens here,
  // at render time — the only place that can repair the ~60 rows already stored.
  //
  // UPWARD ONLY, and only for a count. `pluralize(item, 1)` would also SINGULARISE an
  // item the parse deliberately stored plural: staging has `item: "chicken legs"` at
  // `quantity: 1`, off the line "Chicken legs (thigh and drum)", where "1 chicken leg"
  // would assert something the source does not. Pluralising is strictly additive —
  // `pluralize` leaves an already-plural word alone — so it cannot make a currently
  // correct row wrong.
  //
  // A dependency rather than "+s unless it ends in s", because the naive rule is
  // wrong on the schema's own sanctioned count set: bay leaf → leaves, anchovy →
  // anchovies, whole fish → whole fish, carcass → carcasses. `Intl.PluralRules`
  // returns categories, not word forms, and cannot do this.
  const itemText = $derived(
    parsed === null
      ? ''
      : parsed.unit === null && quantity !== null && exceedsOne(quantity)
        ? pluralize(parsed.item)
        : parsed.item,
  );

  // Joined in script, separator included, rather than written as a bare ", " in
  // the template: the template below is whitespace-sensitive to the character,
  // and a line long enough for the formatter to wrap would silently turn
  // ", rinsed" into ",\n      rinsed" in the rendered text.
  //
  // The separating comma lives INSIDE the muted span with the words it belongs
  // to, so ", rinsed" steps down as one phrase. What the line is is the item; how
  // it arrives at the pan is an aside, and at `text-xs` the aside stops competing
  // with nineteen item names being scanned down a column.
  const preparation = $derived(
    parsed && parsed.preparation.length > 0 ? `, ${parsed.preparation.join(', ')}` : '',
  );

  // What the source said in brackets that was not a preparation — "from a jar",
  // "any colour". Parsed since the field was added and stored on every recipe
  // since, but never rendered anywhere until #878: it reached the shopping list
  // (recipeService carries it onto the item's notes) and simply vanished from the
  // recipe it came off. Shown here rather than at the two call sites so cook mode
  // gets it too — a note about which cream to use is worth as much at the counter.
  const notes = $derived(
    parsed && parsed.notes !== null && parsed.notes.trim() !== '' ? parsed.notes.trim() : null,
  );

  const showQuantity = $derived(part === 'all' || part === 'quantity');
  const showName = $derived(part === 'all' || part === 'name');
  // The OTHER way of saying the amount — "1 ½ cups", "about 50g" — is a verbatim
  // restating of the amount the recipe STATES. The moment anything is scaled it is
  // a second figure on the row that is simply false, so a scaled line renders none
  // of it. Recomputing it is not on the table: it is the source's own wording, not
  // a conversion this app owns. `buildRecipeAddPlan` drops it on a scaled add for
  // exactly this reason (issue #724), and the two now agree.
  const showDisplay = $derived((part === 'all' || part === 'display') && scale === 1);
</script>

{#if showQuantity && amount}{amount}{/if}{#if part === 'all' && amount}{' '}{/if}{#if showName}{#if parsed && amount}{itemText}{#if preparation}<span
        class="text-xs text-muted-foreground">{preparation}</span
      >{/if}{:else}{ingredient.rawText}{/if}{#if notes}<span
      class="ml-1 text-xs text-muted-foreground">({notes})</span
    >{/if}{/if}{#if showDisplay && parsed && amount && parsed.displayText}<span
    class="text-xs text-muted-foreground"
    class:ml-1={part === 'all'}
    class:block={part === 'display'}>({parsed.displayText})</span
  >{/if}{#if showName && ingredient.isOptional}<span class="ml-1 text-xs text-muted-foreground"
    >(optional)</span
  >{/if}
