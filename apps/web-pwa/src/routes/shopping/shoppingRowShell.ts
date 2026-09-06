// The shopping list's row shell, as three class strings, in one place
// (issue #930, Phase 8).
//
// Two surfaces render a row: `ShoppingItemRow`, and the combined aisle row that
// `ShoppingListPage` builds inline when several recipes want the same canon.
// They looked identical because both had been written out — the same collapse
// wrapper, the same twelve geometry classes, and the same colour ladder — and
// they had already drifted apart in two places nobody had noticed.
//
// Class strings rather than a shared component, deliberately. The two rows'
// MARKUP genuinely differs and must keep differing:
//
//   - `ShoppingItemRow`'s collapse root carries `out:collapseOut` / `in:riseIn`
//     and the combined row's does not. A Svelte transition is a directive on an
//     element, not a class, so a shared component would have to render the same
//     wrapper twice behind an `{#if}` to keep the asymmetry — more markup than
//     it saves. (#930 rules the asymmetry deliberate for now; whether it is a
//     bug is a separate question, not this one's to answer.)
//   - `ShoppingItemRow`'s swipe layers sit on an inner wrapper below the
//     collapse root, which must stay untransformed. Nothing here may move them.
//
// So what is shared is the part that actually drifted — the words — and each
// row keeps the structure it needs.

/** The colour arms a row can land on, in the order the ladder tests them. */
const ARM = {
  exiting: 'border-secondary/40 bg-secondary-container/50',
  selected: 'border-ring ring-2 ring-ring bg-card',
  // `review`, and the same /10 ground the callouts use: a flagged row is
  // "nobody has confirmed this", not "this is wrong". It reads as a peer of the
  // sage `exiting` rung above rather than as an alarm, which is the ladder's
  // whole point (#993). The dark arm is gone — the token flips for both themes.
  needsVerify: 'border-review bg-review/10',
  resting: 'border-border bg-card',
} as const;

/** Geometry and transition — everything a row has before a colour is chosen. */
const GEOMETRY =
  'flex items-center gap-3 rounded border px-3 py-2 text-sm ' +
  'transition-colors duration-base ease-standard motion-reduce:transition-none';

export interface ShoppingRowState {
  /** Mid check-off celebration: held in place while the outro runs. */
  readonly exiting?: boolean;
  /**
   * Picked in selection mode. The combined row never passes this — it has no
   * selected state, and that is the asymmetry, expressed as a call site not
   * asking for a rung rather than as a second copy of the ladder.
   */
  readonly isSelected?: boolean;
  /** Flagged for a look before it is bought. */
  readonly needsVerify?: boolean;
  /** A contributor row beneath a combined header, indented to clear its icon. */
  readonly subordinate?: boolean;
}

/**
 * The row proper's classes.
 *
 * The ladder is ordered, not additive: `exiting` beats everything, because a row
 * on its way out should read as leaving rather than as selected or flagged.
 */
export function shoppingRowClass(state: ShoppingRowState = {}): string {
  const arm = state.exiting
    ? ARM.exiting
    : state.isSelected
      ? ARM.selected
      : state.needsVerify
        ? ARM.needsVerify
        : ARM.resting;
  return `${GEOMETRY} ${state.subordinate ? 'ml-[46px]' : ''} ${arm}`;
}

/**
 * The collapse root's classes. The element itself stays at the call site: it is
 * where the Svelte transitions attach, and the two rows differ there.
 */
export function shoppingRowCollapseClass(exiting = false): string {
  return `salt-row-collapse motion-reduce:transition-none ${exiting ? 'salt-row-collapse-out' : ''}`;
}

/**
 * The wrapper between the collapse root and the row. It exists so the collapsing
 * root has something with no min-height to collapse; both rows need it and
 * neither varies it.
 */
export const SHOPPING_ROW_INNER_CLASS = 'min-h-0 overflow-hidden';
