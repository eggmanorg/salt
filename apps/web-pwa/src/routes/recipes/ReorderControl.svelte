<script lang="ts" generics="T">
  import { Button, Icon } from '@salt/ui-components';

  /**
   * REORDERING A LIST ON THE RECIPE PAGE — the one place it lives (issue #1319).
   *
   * Daniel's call on this issue: up/down arrows rather than a drag handle, and
   * **provisionally** — "build the first surface with up/down arrows as the
   * cheaper option, ship it to dev, and switch if it feels wrong once you've used
   * it". Because it is provisional, the affordance AND the move it performs live
   * here and nowhere else. The timing strip (Phase 2), "Made from" (Phase 3), the
   * method rail (Phase 4) and the ingredient rows (Phase 5) each render this
   * component rather than their own pair of buttons, so switching the whole app to
   * a drag handle later is one file rather than four.
   *
   * The prop contract is a list, a position in it, and "here is that list in its
   * new order" — arrow-neutral in the narrow sense that no caller or test here
   * assumes a chevron specifically. It is NOT neutral against the shape a drag
   * swap actually needs, and an earlier version of this comment claimed
   * otherwise (#1332 review, should-fix 1 — the third Rule 12 instance on this
   * issue). Two real costs, stated rather than papered over:
   *
   * `SortableList` (`@salt/ui-components`, what the retired editor uses for a
   * meal's components) is LIST-level — it owns the `{#each}` and the `<ul>/<li>`
   * and hands each row back to the caller as a snippet — while THIS component is
   * rendered once PER ROW, inside the caller's own each-block. A swap to
   * `SortableList` is therefore a rewrite at every call site, which every caller
   * gives up its iteration and row markup to, not a same-file change.
   *
   * `SortableList` also keys rows by id (`getId`), and `RecipePhaseSchema` is a
   * label and two numbers with no id to key by — the same is true of the method
   * steps and ingredient rows Phases 4 and 5 will reorder. A drag version cannot
   * exist at all until a stable identity is invented for those rows, which is a
   * domain-level decision this file cannot make and does not attempt.
   *
   * What genuinely IS in one place, and the reason this file exists rather than
   * four copies of a pair of buttons: the MOVE algorithm and the disabled-ends
   * guard below. No caller writes its own splice or its own bounds check, and
   * that much of Daniel's ruling holds regardless of the two costs above.
   *
   * THE ENDS ARE GUARDED BY `disabled`, NOT BY A BOUNDS CHECK INSIDE `move`. One
   * guard, and the one the cook can see: the first row's up arrow and the last
   * row's down arrow are visibly inert rather than live controls that quietly do
   * nothing. That bounds the claim — `move` is correct for every index the
   * RENDERED buttons can hand it, and it is not a defensive API for an arbitrary
   * caller. `ReorderControl.test.ts` pins both disabled ends, which is what makes
   * the single guard sufficient rather than merely intended.
   */
  let {
    items,
    index,
    noun,
    onReorder,
  }: {
    /** The list as it stands. Never mutated; a reordered copy is handed back. */
    items: readonly T[];
    /** This control's row within `items`. */
    index: number;
    /** Singular noun for the accessible names: "phase" gives "Move phase up". */
    noun: string;
    onReorder: (next: T[]) => void;
  } = $props();

  // Composed here rather than interpolated into the attribute: a `{value}` in an
  // attribute compiles to `value ?? ''`, and on a prop that is always a string
  // that fallback is a branch no test can reach.
  const upLabel = $derived(`Move ${noun} up`);
  const downLabel = $derived(`Move ${noun} down`);
  const atTop = $derived(index === 0);
  const atBottom = $derived(index === items.length - 1);

  function move(delta: number): void {
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved!);
    onReorder(next);
  }
</script>

<div class="flex shrink-0 flex-col">
  <Button variant="ghost" size="sm" onclick={() => move(-1)} disabled={atTop} aria-label={upLabel}>
    <Icon name="ChevronUp" size={16} />
  </Button>
  <Button
    variant="ghost"
    size="sm"
    onclick={() => move(1)}
    disabled={atBottom}
    aria-label={downLabel}
  >
    <Icon name="ChevronDown" size={16} />
  </Button>
</div>
