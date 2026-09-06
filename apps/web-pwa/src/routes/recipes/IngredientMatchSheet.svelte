<!--
  "What does this line actually buy?" — the match behind one recipe ingredient,
  opened by tapping the line on the recipe detail page.

  The whole sheet is DERIVED, not stored. An ingredient records only `canonId`
  and `matchState`; which product form carried it there is re-resolved here from
  the live `productForms` snapshot — the same `resolveProductForm(parsed.item)`
  call under the same parent guard that `ShoppingItemRow` and
  `recipeService.formCountFor` already use. That is deliberate, and it is why
  this needed no schema change: the answer must be what the pipeline WOULD say
  now, not a stale copy of what it said at import. Edit a form's matchers in
  admin and this sheet moves with them, which is the point — it exists to explain
  a mis-bought ingredient (#854 bought millilitres of juice instead of limes, and
  nothing in the app could show why).

  The one action it carries is "Match again" — the same full-pipeline re-run the
  ✗ performs, but reachable on a line that already looks matched. That asymmetry
  is the reason it exists: delete a CANON ITEM and the ingredient is left holding
  a dangling id, so the ✗ appears and the line can be re-matched; delete a
  PRODUCT FORM and nothing dangles at all, because the ingredient's canonId
  points at the form's parent canon, which is still alive. The line goes on
  looking perfectly matched while quietly buying millilitres of a countable
  thing. Re-running finds no form, falls through to product-form arbitration
  (`canonicaliseRecipeIngredients` proposes BEFORE it matches), and writes a
  fresh one — which is how a form deleted for being wrong gets regenerated.

  Everything else here is read-only. A wrong match is fixed in canon /
  product-form admin, which the two links jump to for admins (those pages are
  admin-guarded, so a non-admin is not offered a door that shuts in their face).
-->
<script lang="ts">
  import {
    Button,
    CanonIcon,
    Icon,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
  } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import { ingredientMatchIssue, isResolvedMatchState, resolveProductForm } from '@salt/domain';
  import type { Ingredient } from '@salt/domain';
  import { canonItems } from '../../lib/canonService.js';
  import { canonIndex } from '../../lib/canonIndex.js';
  import { productForms } from '../../lib/productFormService.js';
  import { aisles } from '../../lib/aisleService.js';
  import { currentMember } from '../../lib/membersService.js';
  import { titleCase } from '../../lib/titleCase.js';

  interface Props {
    /** The tapped ingredient. Null between openings. */
    ingredient: Ingredient | null;
    open: boolean;
    /** Re-run the full parse + canon pipeline on this line. */
    onRematch: () => void;
    /** That re-run is in flight. */
    rematching?: boolean;
  }
  let { ingredient, open = $bindable(), onRematch, rematching = false }: Props = $props();

  const canonId = $derived(ingredient?.canonId ?? null);

  const canon = $derived(canonId ? ($canonItems.find((c) => c.id === canonId) ?? null) : null);

  // The recipe list's pip and this sheet must never disagree about what is
  // wrong, so both ask the same pure query rather than re-deriving it.
  const canonById = $derived(canonIndex($canonItems));
  const issue = $derived(
    ingredient === null ? null : ingredientMatchIssue(ingredient, canonById, $productForms),
  );

  // The form is claimed only when it resolves to THIS ingredient's own canon —
  // the same guard both existing call sites apply. Without it a form since
  // repointed elsewhere would be reported as the route taken, which it isn't.
  const form = $derived.by(() => {
    const parsed = ingredient?.parsed;
    if (!parsed || !canonId) return null;
    const f = resolveProductForm(parsed.item, $productForms, $canonItems);
    return f && f.parentCanonId === canonId ? f : null;
  });

  const aisleName = $derived(
    canon?.aisleId ? ($aisles.find((a) => a.id === canon.aisleId)?.name ?? null) : null,
  );

  // Yield in the direction a cook thinks in: one of the buyable thing gives this
  // much of the form. `count` carries no unit word, so the form's own label is
  // the noun ("1 Chicken → 2 chicken legs"); a mass/volume form reads
  // "1 Lime → 30 ml lime juice".
  const yieldLine = $derived.by(() => {
    if (!canon || !form) return null;
    const { amountPerParent, formUnit } = form.yield;
    const measure = formUnit === 'count' ? `${amountPerParent}` : `${amountPerParent} ${formUnit}`;
    return `1 ${titleCase(canon.name)} → ${measure} ${form.label.toLowerCase()}`;
  });

  const missingForm = $derived(issue === 'missing_form');
  const missingAmount = $derived(issue === 'missing_amount');
  const dangling = $derived(issue === 'dangling_canon');

  const isAdmin = $derived($currentMember?.admin === true);

  // What matching actually ran on. Both canon and product-form resolution use the
  // PARSED item, not the raw line, so showing only the raw line would misexplain
  // a miss ("2 large eggs, beaten" is matched on "egg").
  const matchedOn = $derived(ingredient?.parsed?.item ?? null);

  function go(path: string): void {
    open = false;
    push(path);
  }
</script>

<Sheet bind:open side="bottom">
  <SheetContent class="overflow-y-auto">
    <SheetHeader>
      <SheetTitle>Ingredient match</SheetTitle>
      <SheetDescription>{ingredient?.rawText ?? ''}</SheetDescription>
    </SheetHeader>

    <div class="flex flex-col gap-3 text-sm" data-testid="ingredient-match-sheet">
      {#if !ingredient}
        <p class="text-muted-foreground">Nothing selected.</p>
      {:else if canon}
        <div class="flex items-center gap-3">
          <CanonIcon
            thumbnail={canon.thumbnail}
            name={canon.name}
            size={40}
            version={canon.iconRequestedAt ?? canon.updatedAt}
          />
          <div class="min-w-0 flex-1">
            <p
              class="flex items-center gap-2 font-medium"
              data-testid="ingredient-match-canon-name"
            >
              <span class="truncate">{titleCase(canon.name)}</span>
              {#if canon.needs_approval}
                <span
                  class="shrink-0 rounded-full bg-review/20 px-2 py-0.5 text-xs font-medium text-review-text"
                  data-testid="ingredient-match-canon-review">Review</span
                >
              {/if}
            </p>
            <p class="text-xs text-muted-foreground">
              Canon item{#if aisleName}
                · {aisleName}{/if}{#if canon.unit}
                · {canon.unit}{/if}
            </p>
          </div>
        </div>

        {#if form}
          <div
            class="rounded-md border border-border bg-muted/40 px-3 py-2"
            data-testid="ingredient-match-form"
          >
            <p class="flex items-center gap-2">
              <Icon name="Link" size={14} class="shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1">
                via the product form <span class="font-medium">{form.label}</span>
              </span>
              {#if form.needs_approval}
                <span
                  class="shrink-0 rounded-full bg-review/20 px-2 py-0.5 text-xs font-medium text-review-text"
                  data-testid="ingredient-match-form-review">Review</span
                >
              {/if}
            </p>
            {#if yieldLine}
              <p class="mt-1 text-xs text-muted-foreground">{yieldLine}</p>
            {/if}
          </div>
        {:else if missingForm}
          <p
            class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-text"
            data-testid="ingredient-match-missing-form"
          >
            No product form covers this line, so it shops as
            {ingredient.parsed?.unit} of {titleCase(canon.name)} rather than whole ones. Match again to
            have one worked out.
          </p>
        {:else if missingAmount}
          <!-- Matched, and holding nothing to match ON. Until #949 this line read
               "Matched straight to the canon item", which was true and useless:
               the row still had no amount, scaled with nothing, and added nothing
               to the shopping list. -->
          <p
            class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-text"
            data-testid="ingredient-match-missing-amount"
          >
            No amount was read off this line, so it cannot scale with the servings and adds nothing
            to the shopping list. Match again to read it properly.
          </p>
        {:else}
          <p class="text-muted-foreground" data-testid="ingredient-match-direct">
            Matched straight to the canon item — no product form involved.
          </p>
        {/if}

        {#if matchedOn}
          <p class="text-xs text-muted-foreground">Matched on “{matchedOn}”.</p>
        {/if}
      {:else if dangling}
        <p class="text-muted-foreground" data-testid="ingredient-match-dangling">
          Matched to a canon item that no longer exists — deleted or merged away. Nothing will be
          bought for this line until it is matched again.
        </p>
      {:else if ingredient.parsed === null}
        <p class="text-muted-foreground" data-testid="ingredient-match-unparsed">
          Not parsed yet, so nothing has been matched.
        </p>
      {:else}
        <p class="text-muted-foreground" data-testid="ingredient-match-unmatched">
          {isResolvedMatchState(ingredient.matchState)
            ? 'No canon item recorded for this line.'
            : 'Not matched yet.'}{#if matchedOn}
            It would match on “{matchedOn}”.{/if}
        </p>
      {/if}

      <!-- One action row for every state. Re-matching is offered even on a line
           that already looks matched — see the header note on deleted product
           forms — and is NOT admin-gated, matching the ✗ it shares a code path
           with. The two admin jump-offs are gated, because their destinations
           are. -->
      {#if ingredient}
        <div class="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            onclick={onRematch}
            loading={rematching}
            disabled={rematching}
            data-testid="ingredient-match-rematch"
          >
            {#snippet leading()}<Icon name="RefreshCw" size={14} />{/snippet}
            Match again
          </Button>
          {#if isAdmin && canon}
            <Button size="sm" variant="outline" onclick={() => go(`/admin/catalog/c:${canon.id}`)}>
              {#snippet leading()}<Icon name="ExternalLink" size={14} />{/snippet}
              Open canon item
            </Button>
            {#if form}
              <Button size="sm" variant="outline" onclick={() => go(`/admin/catalog/f:${form.id}`)}>
                {#snippet leading()}<Icon name="ExternalLink" size={14} />{/snippet}
                Open product form
              </Button>
            {/if}
          {/if}
        </div>
        <p class="text-xs text-muted-foreground">
          Matching again re-runs the whole pipeline on this line — parse, product form, canon match.
          It is how a product form deleted for being wrong gets worked out again.
        </p>
      {/if}
    </div>
  </SheetContent>
</Sheet>
