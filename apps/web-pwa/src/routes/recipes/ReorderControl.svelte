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
   * The prop contract is deliberately affordance-NEUTRAL: a list, a position in
   * it, and "here is that list in its new order". A drag handle answers exactly
   * that same question, so a swap rewrites this file's markup and its `move` and
   * touches no caller. `SortableList` (`@salt/ui-components`, what the retired
   * editor uses for a meal's components) is what a drag version would be built on;
   * it keys rows by id, which is the other reason arrows are the cheap option on a
   * phase strip — `RecipePhaseSchema` is a label and two numbers, and a phase has
   * no id to key by.
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
