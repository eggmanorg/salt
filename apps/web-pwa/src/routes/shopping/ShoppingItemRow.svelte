<!--
  One shopping list item row. Lifted out of `ShoppingListPage`'s `plainItemRow`
  snippet unchanged, then given the check-off celebration (lively list, Phase 1).

  It renders every plain row on the page: singles in an aisle, the Other bucket,
  the recipe-sorted view, the Checked section, and the per-contributor breakdown
  under a combined row (`subordinate`). The combined row itself stays in the page
  — it is a different shape — but shares this row's `CheckOffButton` and the same
  `salt-row-collapse` shell, so both celebrate identically.

  The outermost element is the collapse shell, not the row: `salt-row-collapse`
  walks the row's real height to zero on the way out, which needs a wrapper it can
  own. `data-testid="shopping-item-row"` stays on the row proper.
-->
<script lang="ts">
  import { CanonIcon, Icon, RowSelectCheckbox, Spinner } from '@salt/ui-components';
  import type { ListSelection } from '@salt/ui-components';
  import {
    isRecipeSourced,
    isResolvedMatchState,
    resolveItemDisplayName,
    resolveProductForm,
  } from '@salt/domain';
  import type { ProductForm, ShoppingListItem } from '@salt/domain';
  import type { Snippet } from 'svelte';
  import type { TransitionConfig } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from '../../lib/reducedMotion.js';
  import { titleCase } from '../../lib/titleCase.js';
  import { productForms } from '../../lib/productFormService.js';
  import { canonItems } from '../../lib/canonService.js';
  import { swipe } from '../../lib/swipe.svelte.js';
  import { revealProgress } from '../../lib/swipe.js';
  import {
    shoppingRowClass,
    shoppingRowCollapseClass,
    SHOPPING_ROW_INNER_CLASS,
  } from './shoppingRowShell.js';
  import { describeSource } from '../../lib/shoppingSource.js';
  import CheckOffButton from './CheckOffButton.svelte';

  // Only the canon name is read here (for a product-form row's parent headline);
  // the page's richer map satisfies this.
  interface CanonNameInfo {
    readonly name: string;
  }

  interface Props {
    item: ShoppingListItem;
    /** Show a spinner: the row is still waiting on its canon match. */
    pending: boolean;
    /** Rendered inside a combined row's breakdown — indented, no icon. */
    subordinate?: boolean;
    /** Show the source recipe / "Added by" line. */
    showSource?: boolean;
    /** Held open mid-celebration: tinted, disc popped, collapsing out. */
    exiting?: boolean;
    /**
     * The row's match just landed — play the one-shot CanonIcon shimmer (lively
     * list, Phase 3). Held true only for the reveal window by the page.
     */
    revealing?: boolean;
    /**
     * Which half of the Other→aisle match-reveal move this row can play:
     * `'send'` in the Other bucket (collapse-out on unmount), `'receive'` in a
     * resolved aisle (rise-in on mount), `'none'` everywhere else (breakdown /
     * checked / recipe / manual). The role only ARMS the transition — it fires
     * solely when `isRevealing` says the id's match just landed.
     */
    revealRole?: 'send' | 'receive' | 'none';
    /**
     * Live gate for the reveal transitions, read at transition start (a closure
     * over the page's `createMatchReveal`, NOT the `revealing` prop: the
     * collapsing "Other" copy is being destroyed, so its props are frozen at
     * their pre-reveal values — only a function call can see the fresh set).
     */
    isRevealing?: (id: string) => boolean;
    selectionMode: boolean;
    selection: ListSelection;
    canonMap: ReadonlyMap<string, CanonNameInfo>;
    thumbnailFor: (canonId: string | null) => string | null;
    iconVersionFor: (canonId: string | null) => string | number | undefined;
    /** The page's "Need it?" confirm/drop pair, so both row shapes share one copy. */
    verifyControls: Snippet<[string[]]>;
    onEdit: (item: ShoppingListItem) => void;
    onToggleChecked: (item: ShoppingListItem) => void;
    /** Delete this single row through the shared deferred-delete + undo snackbar. */
    onDelete: (item: ShoppingListItem) => void;
  }

  let {
    item,
    pending,
    subordinate = false,
    showSource = false,
    exiting = false,
    revealing = false,
    revealRole = 'none',
    isRevealing = () => false,
    selectionMode,
    selection,
    canonMap,
    thumbnailFor,
    iconVersionFor,
    verifyControls,
    onEdit,
    onToggleChecked,
    onDelete,
  }: Props = $props();

  // ─── Match-reveal move (#571 Treatment 2, lively list Phase 3) ───────────────
  // When a row's canon match lands it leaves "Other" and arrives in its aisle —
  // two different keyed `{#each}` blocks, so Svelte destroys one element and
  // creates another. The treatment's move is exactly the spec's two halves: the
  // Other copy COLLAPSES OUT (height/opacity, 300ms) while the aisle copy RISES
  // IN (opacity 0→1, translateY -8→0, 380ms). No crossfade/FLIP pairing — the
  // halves are independent, which is what the spec describes and what survives
  // the two copies living in different containers.
  //
  // Both are gated at start-time by `isRevealing(item.id)`: the page marks the id
  // (in `$effect.pre`, BEFORE this flush's DOM changes) only for a genuine
  // unresolved→resolved landing. Every other unmount/mount of a row — delete,
  // check-off, stream-in, aisle collapse, filter/sort switches, route change —
  // sees the gate closed and stays today's instant snap (`duration: 0`).
  //
  // `|global` on both directives is required, not decorative: resolving the LAST
  // "Other" item unmounts the whole Other section (its `{#if}` empties), and the
  // first item matched into an aisle mounts a whole NEW aisle section — local
  // transitions skip elements whose ancestor block is the thing being created or
  // destroyed, which are precisely those two cases.
  const REVEAL_OUT_MS = 300; // #571: Other row collapses out (height/opacity)
  const REVEAL_IN_MS = 380; // #571: aisle row enters (fade + translateY(-8 → 0))

  function collapseOut(node: Element): TransitionConfig {
    if (revealRole !== 'send' || !isRevealing(item.id) || prefersReducedMotion()) {
      return { duration: 0 };
    }
    const height = (node as HTMLElement).offsetHeight;
    return {
      duration: REVEAL_OUT_MS,
      easing: cubicOut,
      // The rows beneath close the gap smoothly: real height walks to 0 and the
      // negative margin swallows the parent's `gap-1`, mirroring what
      // `salt-row-collapse-out` does for the check-off outro.
      css: (t, u) =>
        `overflow: hidden; height: ${t * height}px; opacity: ${t}; ` +
        `margin-bottom: calc(var(--spacing) * -${u});`,
    };
  }

  function riseIn(node: Element): TransitionConfig {
    void node;
    if (revealRole !== 'receive' || !isRevealing(item.id) || prefersReducedMotion()) {
      return { duration: 0 };
    }
    return {
      // SEQUENCED after the collapse, not concurrent with it: #571's steps are
      // "collapses out (300ms)" THEN "appears in its aisle (380ms)" — ~680ms of
      // travel, which is what its 700ms shimmer is sized to sit under. Run
      // together, the whole move was over in 380ms and read as too quick to see:
      // the eye is on the Other row when the match lands, and by the time the
      // fold registers the arrival has already finished. The delay gives the eye
      // a path — fold away, space opens, drop in.
      delay: REVEAL_OUT_MS,
      duration: REVEAL_IN_MS,
      easing: cubicOut,
      css: (t, u) => `opacity: ${t}; transform: translateY(${-8 * u}px);`,
    };
  }

  // The item is matched to a canon — its bare tile reads sage, not grey. Real
  // reactive state; observed, never written (Phase 3). Uses the domain predicate
  // so it agrees with `hasLiveCanonMatch`, which is what decides the row has left
  // the "Other" bucket: `needs_approval` is resolved-and-flagged, so it must light
  // up like any other match rather than relocate silently.
  const matched = $derived(isResolvedMatchState(item.matchState));

  const isSelected = $derived(selection.isSelected(item.id));
  const amountStr = $derived(formatAmount(item.amount, item.unit));
  const recipeQuantity = $derived(isRecipeSourced(item) ? leadingQuantity(item) : null);
  const productForm = $derived(productFormFor(item));

  // A row mid-celebration reads as done even though the copy it was handed still
  // says `checked: false` (that inversion is what keeps it rendering here at all —
  // see `holdInPlace`). Struck through and dimmed from the moment of the tap, so
  // it looks the way it will look in the Checked section it is on its way to.
  const done = $derived(item.checked || exiting);

  // Verify controls replace the check button, so a flagged row can never be
  // checked off — but if one ever is mid-flight, the celebration wins the slot.
  const flagged = $derived(needsVerify(item) && !exiting);

  // ─── Swipe (lively list, Phase 4) ────────────────────────────────────────────
  // Touch-only horizontal drag: swipe right past +78px to check off, left past
  // -78px to delete. The gesture is EXCLUDED from the breakdown-under-combined row,
  // the product-form row and the "Need it?" verify row (each is a different shape
  // with its own affordance), and from selection mode / a row mid-celebration.
  // Coarse-pointer + reduced-motion gating lives in the action itself, so on a
  // desktop the row simply is not draggable and the buttons stay primary.
  const swipeEnabled = $derived(
    !subordinate && productForm === null && !flagged && !selectionMode && !exiting,
  );
  // Live drag offset, fed by the action, driving the reveal-behind layers. The
  // action owns the row's `translateX`; this only fades the layer beneath it.
  let swipeDx = $state(0);
  const revealFraction = $derived(revealProgress(swipeDx)); // -1 (delete) … +1 (check)
  const checkRevealOpacity = $derived(Math.max(0, revealFraction));
  const deleteRevealOpacity = $derived(Math.max(0, -revealFraction));

  // The row proper's classes, lifted to a binding so the swipeable and plain
  // branches below share exactly one source of truth. A swipeable row always
  // lands on the opaque `bg-card` arm (selection / verify / exiting are excluded),
  // which is what hides the reveal layer beneath it at rest.
  //
  // The words themselves live in `shoppingRowShell.ts` since #930, because the
  // combined aisle row in `ShoppingListPage` renders the same shell and had
  // written its own copy of it.
  const rowClass = $derived(
    shoppingRowClass({ exiting, isSelected, needsVerify: needsVerify(item), subordinate }),
  );

  function toSentenceCase(text: string): string {
    if (!text) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Label a single row, title-cased: the user's / recipe's wording with the
  // amount, unit and context the parser lifts out removed ("1 whole chicken" →
  // "Whole Chicken"), so it reads as the item without the quantity that's shown
  // separately, and without collapsing to the leaner canon name ("Chicken").
  // Combined aggregate rows label by canon name instead — see the page's rowLabel.
  function displayLabel(value: ShoppingListItem): string {
    return titleCase(resolveItemDisplayName(value));
  }

  // A resolved product-form row (issue #500): a recipe row bound to a buyable
  // parent canon and carrying a whole parent-count (the recipeService 'count' unit
  // sentinel), re-derived from the productForms snapshot rather than a stored id
  // (additive / back-compat). null for manual rows, non-count rows, and any row
  // whose form no longer resolves to its own canon — those keep today's label.
  // When non-null the row reads "Lime ×3" with the original wording underneath.
  function productFormFor(value: ShoppingListItem): ProductForm | null {
    if (value.unit !== 'count' || !value.canonId || value.amount === undefined) return null;
    // `$canonItems` feeds the contested-phrase rule (issue #1180); an unsynced
    // (empty) canon store leaves it inert, i.e. today's answer.
    const form = resolveProductForm(value.rawText, $productForms, $canonItems);
    return form && form.parentCanonId === value.canonId ? form : null;
  }

  // The row describes its FIRST source only, and deliberately: it has one line of
  // room, and the edit sheet is where every source is listed. What it says about
  // that source is now `describeSource` — the same function the sheet uses
  // (issue #933) — where the row previously carried a second answer that
  // disagreed for a hand-added item with no attributed adder.
  const source = $derived(item.sources[0] ? describeSource(item.sources[0]) : null);
  const sourceText = $derived(
    source === null ? null : source.kind === 'manual' ? source.text : source.name,
  );

  function formatAmount(amount: number | undefined, unit: string | undefined): string | null {
    if (amount === undefined) return null;
    return unit ? `${amount} ${unit}` : `${amount}`;
  }

  // The quantity a recipe row LEADS with, formatted the way the recipe detail
  // page writes it (`IngredientText`): tight against its unit — "400g", "1.5kg" —
  // and the bare number when the line carried no unit ("2" eggs).
  //
  // null means the row keeps today's trailing "(400 g)" shape. That covers a row
  // with no amount at all, and — deliberately — the product-form 'count'
  // sentinel: a whole parent-count is not a measure, so a row whose form no
  // longer resolves (and has therefore fallen past the ×N branch above) keeps its
  // existing wording rather than reading as "3count Lime".
  function leadingQuantity(value: ShoppingListItem): string | null {
    if (value.amount === undefined || value.unit === 'count') return null;
    return value.unit ? `${value.amount}${value.unit}` : String(value.amount);
  }

  // A flagged item (recipe-add "check" item, #185) gets a quick confirm/drop
  // affordance instead of the check circle.
  function needsVerify(value: ShoppingListItem): boolean {
    return value.needsCheck && !value.checked;
  }
</script>

<!--
  The row's own content, lifted to a snippet so the swipeable and plain branches
  below render exactly one copy of it. Only the wrapping row-proper `<div>` (its
  class, `use:swipe`, `touch-pan-y`) differs between the two.
-->
{#snippet rowContents()}
  {#if selectionMode}
    <RowSelectCheckbox {selection} id={item.id} label="" aria-label="Select {item.rawText}" />
  {/if}
  {#if !subordinate}
    <CanonIcon
      thumbnail={thumbnailFor(item.canonId)}
      name={displayLabel(item)}
      dimmed={done}
      size={40}
      version={iconVersionFor(item.canonId)}
      {matched}
      shimmer={revealing}
    />
  {/if}
  <button
    type="button"
    class="flex-1 min-w-0 text-left"
    onclick={() => onEdit(item)}
    aria-label="Edit {item.rawText}"
    data-testid="shopping-item-edit-btn"
  >
    {#if productForm && subordinate}
      <!-- Under a combined parent the headline is inverted (issue #530): the
           parent row already carries "Whole Chicken ×1", so repeating it here
           adds nothing and reads as one chicken PER CHILD — the parent count is
           an aggregate (Σwhole + MAXforms, see countSubtotal) that must never be
           summed down the column. Lead with this contributor's own wording
           instead; the recipe name follows from the showSource block below. -->
      {#each item.originalText?.length ? item.originalText : [titleCase(resolveItemDisplayName(item))] as line (line)}
        <span class="block truncate {done ? 'line-through text-muted-foreground' : ''}">{line}</span
        >
      {/each}
    {:else if productForm}
      <span class="block truncate {done ? 'line-through text-muted-foreground' : ''}">
        {titleCase(canonMap.get(item.canonId ?? '')?.name ?? '')}{' '}<span
          class="text-muted-foreground">×{item.amount}</span
        >
      </span>
      <!-- The headline is the PARENT product ("Lime ×3"), which by design reads
           nothing like the recipe's own line, so show the wording that justified
           the count beneath it (issue #528). Sibling of the truncating label
           span, and unclipped itself — a long line wraps rather than clips.
           Items written before the field fall back to today's cleaned name. -->
      {#if item.originalText?.length}
        {#each item.originalText as line (line)}
          <span
            class="block text-xs text-muted-foreground"
            data-testid="shopping-item-original-text">{line}</span
          >
        {/each}
      {:else}
        <span class="block text-xs text-muted-foreground truncate"
          >{resolveItemDisplayName(item)}</span
        >
      {/if}
    {:else if recipeQuantity}
      <!-- A recipe row reads the way the recipe detail page reads it: the
           quantity first, tight against its unit, then the item — "1.5kg Whole
           Chicken". Preparation is already absent by the time a line reaches the
           list (recipeService writes the parser's clean `parsed.item` as the row's
           rawText), and the detail page's muted "(6 cloves)" note follows it in
           the same muted style — `parsed.displayText`, carried onto the item as
           `measureNote` so a line the parser flattened to grams still says what
           to reach for in the shop. That note is written only on an UNSCALED add
           (it is a frozen string with no structure to multiply), so on a scaled
           row it is simply absent and the amount stands alone.

           A MANUALLY added row is excluded and keeps the trailing shape below:
           what a person typed onto the list is what they should read back. The
           test is the domain's `isRecipeSourced`, the same one that decides which
           rows may combine, so a row can never be a recipe's for one purpose and
           a person's for the other.

           A COUNTED row (issue #1643) carries its weight as `weightGrams`
           instead, scaled with the count, so "1 Red Onion (150g)" never pairs a
           scaled count with an unscaled weight. -->
      <span class="block truncate {done ? 'line-through text-muted-foreground' : ''}">
        {recipeQuantity}{' '}{displayLabel(item)}{#if item.measureNote}<span
            class="ml-1 text-xs text-muted-foreground">({item.measureNote})</span
          >{:else if item.weightGrams !== undefined}<span class="ml-1 text-xs text-muted-foreground"
            >({item.weightGrams}g)</span
          >{/if}
      </span>
    {:else}
      <span class="block truncate {done ? 'line-through text-muted-foreground' : ''}">
        {displayLabel(item)}{#if amountStr}{' '}<span class="text-muted-foreground"
            >({amountStr})</span
          >{/if}
      </span>
    {/if}
    {#if item.notes}
      <span class="block text-xs text-muted-foreground truncate">{toSentenceCase(item.notes)}</span>
    {/if}
    <!-- "Is there a source at all", not "is the label non-empty": a hand-added
         item with no attributed adder now says "Added manually" here, as it has
         always said in the edit sheet (issue #933, Behaviour Exception 3). -->
    {#if showSource && sourceText !== null}
      <span class="block text-xs text-muted-foreground/70">{sourceText}</span>
    {/if}
  </button>
  {#if pending}
    <Spinner size={14} />
  {/if}
  {#if flagged}
    {@render verifyControls([item.id])}
  {:else}
    <CheckOffButton checked={item.checked} {exiting} onSelect={() => onToggleChecked(item)} />
  {/if}
{/snippet}

<div class={shoppingRowCollapseClass(exiting)} out:collapseOut|global in:riseIn|global>
  <div class={SHOPPING_ROW_INNER_CLASS}>
    {#if swipeEnabled}
      <!-- Swipe surface (lively list, Phase 4). The reveal-behind layers and the
           `translateX` drag live HERE, on an inner wrapper — NEVER on the
           `salt-row-collapse` root above, whose Phase 1 collapse and Phase 3
           crossfade assume it is the untransformed direct `{#each}` child. The
           layers are `pointer-events-none` so they never swallow a button tap, and
           the opaque `bg-card` row proper hides them until it slides. -->
      <div class="relative overflow-hidden rounded">
        <!-- Swipe RIGHT past +78px → check: sage layer on the revealed left edge. -->
        <div
          class="pointer-events-none absolute inset-0 flex items-center justify-start px-4 bg-secondary-container text-accent-foreground"
          style:opacity={checkRevealOpacity}
          aria-hidden="true"
        >
          <Icon name="Check" size={20} />
        </div>
        <!-- Swipe LEFT past -78px → delete: destructive layer on the revealed right edge. -->
        <div
          class="pointer-events-none absolute inset-0 flex items-center justify-end px-4 bg-destructive text-destructive-foreground"
          style:opacity={deleteRevealOpacity}
          aria-hidden="true"
        >
          <Icon name="Trash2" size={20} />
        </div>
        <div
          use:swipe={{
            enabled: swipeEnabled,
            onCheck: () => onToggleChecked(item),
            onDelete: () => onDelete(item),
            onProgress: (d) => (swipeDx = d),
          }}
          class="relative touch-pan-y {rowClass}"
          data-testid="shopping-item-row"
          data-item-id={item.id}
        >
          {@render rowContents()}
        </div>
      </div>
    {:else}
      <div class={rowClass} data-testid="shopping-item-row" data-item-id={item.id}>
        {@render rowContents()}
      </div>
    {/if}
  </div>
</div>
