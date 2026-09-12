<script lang="ts">
  import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    ComboboxTrigger,
    Icon,
    type ComboboxItemType,
  } from '@salt/ui-components';
  import {
    canBeComponentOf,
    hasComponents,
    isCookable,
    recipeHeroUrl,
    takesComponents,
    type Recipe,
  } from '@salt/domain';
  import type { Snippet } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { attachComponentToMeal, recipes } from '../../lib/recipeService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { KIND_COPY, kindOf } from './recipeKind.js';
  import { componentTimeLabel } from './recipeTiming.js';
  import EditableZone from './EditableZone.svelte';
  import ReorderControl from './ReorderControl.svelte';

  /**
   * "Made from" — the dishes a meal is built out of, read and written in the same
   * place (issue #752 for the card, issue #1319 Phase 3 for the editing).
   *
   * Extracted from `RecipeViewPage.svelte`, which is 3,400 lines and must not
   * absorb this feature. Page-local on purpose: one consumer, and a design-system
   * primitive would need a ui-spec amendment first.
   *
   * A meal's components lead, above its own ingredients: what a Sunday roast IS —
   * chicken, potatoes, gravy — is the headline fact about it, and the ingredient
   * list below belongs to the roast itself, not to the three dishes. Nothing is
   * aggregated. Each card is a link to that dish, ONE LEVEL ONLY; a component's
   * own components are neither shown nor read, which is what makes a cycle inert.
   *
   * THIS EDITOR HOLDS NO DRAFT, and that is a departure from `RecipePhaseEditor`
   * rather than an oversight. The draft there exists so an incoming snapshot —
   * another phone, or a chat amendment applied in the docked pane — cannot repaint
   * a box a cook is typing into. There is no such box here: every gesture in this
   * region is a discrete tap (attach a dish, remove one, move one) that writes as
   * it happens, so there is nothing in flight for a snapshot to land on top of, and
   * binding the rows straight to `recipe` is what keeps them honest. The one text
   * box on the surface is the picker's filter, which belongs to the `Combobox`, is
   * never fed from `recipe`, and is discarded on attach by `pickerKey`.
   * `RecipeMadeFromCard.test.ts` pins the repaint as intended behaviour rather
   * than leaving it an untested consequence.
   *
   * THE ATTACH IS THE ONE IMMEDIATE WRITE on this surface, and it is deliberate:
   * `attachComponentToMeal` -> `persistRecipe`, which is where the ordering policy
   * (`insertComponentByElapsedTime`) and the self/duplicate guards already live,
   * and which is one deliberate tap rather than a burst of keystrokes — the same
   * split `recipeService.ts` draws between `persistRecipe` and `queueRecipeEdit`.
   * A coalesced edit already pending on THIS meal is arbitrated by the coalescer's
   * guarded `cancel` rather than bypassed (issue #1319 standing requirement 2);
   * `recipeService.coalescedEdit.test.ts` pins both directions of that guard.
   * Remove and reorder carry no such policy, so they compose onto `recipe` and go
   * out through `onEdit` like every other in-place edit.
   *
   * REORDER IS `ReorderControl` AND NOTHING ELSE (#1332's ruling) — no pair of
   * buttons is inlined here, so switching the campaign to a drag handle stays one
   * file. Read its header before using it.
   *
   * THE CARD OWNS ITS OWN MOUNT GATE (issue #1343), in the idiom `RecipeNotesCard`
   * already uses: it renders when the document HAS dishes, or when the page is
   * editing and the kind CAN take them. The second half is the door in — an
   * ordinary recipe pressed into edit mode gets the dashed `+ Dishes` slot and
   * becomes a meal through the picker that is already here, which is the
   * capability the retired editor's picker used to be the only holder of.
   *
   * Capability comes from `takesComponents` and never from a comparison against
   * `recipe.kind` (CLAUDE.md -> Data model conventions). A cocktail gets the slot
   * because that is the domain's existing answer, not a new claim made here.
   *
   * The same line is why a meal can no longer vanish under the finger editing it.
   * `EditableZone` ignores `filled` entirely while its editor is open
   * (`EditableZone.svelte:90`), so taking the last dish off leaves the rows and
   * the picker exactly where they were; the demotion lands on Done, when
   * `editing` goes false and the gate is back to reading presence alone.
   *
   * THE GATE'S BOUNDARY, stated rather than left an unqualified absolute: a kind
   * that takes no components but already carries ids — an outing seeded before
   * this campaign, say — still shows its card in BOTH modes, because
   * `hasComponents` is the first clause and a document with dishes on it is a
   * meal whatever kind it declares. `RecipeMadeFromCard.test.ts` pins that
   * reading rather than leaving it to this sentence.
   */
  let {
    recipe,
    components,
    editing,
    onEdit,
    newMenu,
  }: {
    recipe: Recipe;
    /**
     * The attached dishes RESOLVED for display, one level deep — the page's own
     * `resolveComponents`, which skips an id whose recipe has been deleted
     * elsewhere. Shorter than `recipe.componentRecipeIds` whenever one dangles.
     */
    components: readonly Recipe[];
    editing: boolean;
    /** Called with the whole next recipe. The page decides how it is written. */
    onEdit: (next: Recipe) => void;
    /**
     * The "New" menu in the card's header — the three ways to start a dish FROM
     * this meal (it was four until #1319 Phase 6 retired hand-authoring). It stays
     * on the page because it owns page state (the two import dialogs) and page
     * navigation, which issue #1319's Phase 7 re-points; this card owns where it
     * sits, and since #1343 WHETHER it sits there at all — see the gate at the
     * render — and nothing about what it does.
     */
    newMenu: Snippet;
  } = $props();

  const isMeal = $derived(hasComponents(recipe));
  const canTakeDishes = $derived(takesComponents(kindOf(recipe)));

  /**
   * A stored id's dish, or the plain truth about it. The edit rows iterate the
   * STORED id list rather than the resolved one, so a dangling id keeps its place
   * in a reorder and can be removed, rather than being silently dropped by the
   * first write this surface makes. The read view above still skips it.
   *
   * A linear scan rather than an id map: a meal is built out of a handful of
   * dishes, and `lib/canonIndex.ts`/`lib/attachedRecipes.ts` own the two
   * by-id maps this app has decided to share — neither is this question, and a
   * third map here would be a helper-shaped thing with one caller.
   */
  function rowTitle(id: string): string {
    return components.find((c) => c.id === id)?.title ?? 'No longer in the library';
  }

  // Candidates: anything that is not this meal (`canBeComponentOf` — a dish
  // inside itself is meaningless), is not already attached, and is something you
  // actually make. The last is a capability predicate, never a comparison against
  // the kind: an outing has no dish to compose and a placeholder is a photograph
  // and a title.
  const pickerItems: ComboboxItemType[] = $derived(
    $recipes
      .filter(
        (r) =>
          canBeComponentOf(recipe.id, r.id) &&
          !recipe.componentRecipeIds.includes(r.id) &&
          isCookable(kindOf(r)),
      )
      .map((r) => ({ value: r.id, label: r.title })),
  );

  function componentFilter(input: string, item: ComboboxItemType): boolean {
    return item.label.toLowerCase().includes(input.trim().toLowerCase());
  }

  // Remount key: bumped after each attach so the Combobox input clears — it only
  // syncs its label from `value` at mount, which is how the retired editor's own
  // picker and the planner's recipe picker both handle it.
  let pickerKey = $state(0);

  function setComponentIds(next: string[]): void {
    onEdit({ ...recipe, componentRecipeIds: next });
  }

  function removeComponent(id: string): void {
    setComponentIds(recipe.componentRecipeIds.filter((c) => c !== id));
  }

  // No "is this id empty" guard, deliberately, and the boundary is worth stating
  // (CLAUDE.md Rule 12): `Combobox` reaches `onValueChange` from `selectItem`
  // alone — `createCustom` is the other `setValue` path and needs `onCreate`,
  // which this picker does not pass — so the id is always one of `pickerItems`'
  // own values as that primitive stands today. A guard for the empty string would
  // be a branch no test could reach. If the primitive ever did emit one,
  // `insertComponentByElapsedTime` would store it as a dangling id, which the read
  // view skips and the edit rows above offer a Remove button for.
  async function addComponent(id: string): Promise<void> {
    pickerKey += 1;
    const result = await attachComponentToMeal(recipe.id, id);
    // Rule 10: the failure crosses as a `Failure<DomainError>` and is said out
    // loud once, because there is no Save button left to fail visibly.
    if (result.kind !== 'ok') addToast('Could not add that dish.', 'destructive');
  }
</script>

{#if isMeal || (editing && canTakeDishes)}
  <Card>
    <CardHeader class="px-4 pt-4 pb-0">
      <div class="flex items-center justify-between gap-2">
        <CardTitle class="text-sm">Made from</CardTitle>
        <!-- The "New" menu stays PRESENCE-gated while the card no longer is
             (issue #1343), and the two are deliberately not the same question.
             Its three entries start a dish FOR this meal: two import over the
             network and the third navigates away into a chat — a heavy first move
             for a conversion, and one that takes you off a recipe you are
             mid-edit on. It is also the gate the page mounts the two import
             dialogs behind (`RecipeViewPage.svelte`'s `showComponents`), so
             widening it here alone would offer a menu whose dialogs are not
             mounted. That is one predicate written in two files, so
             `RecipeViewPage.mealComponents.test.ts` pins the two together rather
             than this comment asking for them to be kept in step. -->
        {#if isMeal}
          {@render newMenu()}
        {/if}
      </div>
    </CardHeader>
    <CardContent class="px-4 pt-3 pb-4">
      <!-- `filled` is the DOCUMENT's answer rather than a constant (issue #1343):
           a meal always has something to say here — its dishes, or the sentence
           explaining where they went — while a recipe that is not one yet has
           nothing to show and gets the dashed `+ Dishes` slot in its place. Both
           branches open the same editor and carry the same `testId`, which is
           what the specs key on. -->
      <EditableZone
        {editing}
        filled={isMeal}
        label="Edit the dishes"
        slotLabel="Dishes"
        testId="recipe-edit-components"
        class="w-full"
      >
        {#snippet view()}
          <div class="min-w-0 flex-1">
            {#if components.length === 0}
              <p class="text-sm text-muted-foreground">
                The dishes this was built from are no longer in the library.
              </p>
            {:else}
              <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="recipe-components">
                {#each components as component (component.id)}
                  <!-- Bound once rather than called twice. It does NOT remove
                     the `?? ''` Svelte compiles this interpolation to, which is
                     this file's one uncovered branch: the fallback needs a null
                     inside the `!== null` guard above it, so nothing can reach
                     it. The branch came with the markup out of
                     `RecipeViewPage.svelte` rather than being added here. -->
                  {@const timeLabel = componentTimeLabel(component)}
                  <li>
                    <button
                      type="button"
                      class="group flex w-full items-center gap-3 overflow-hidden rounded-lg border border-border bg-card p-2 text-left transition-shadow hover:shadow-md"
                      onclick={() => push(`/recipes/${component.id}`)}
                      data-testid="recipe-component-card"
                      data-recipe-id={component.id}
                    >
                      <span
                        class="h-14 w-14 shrink-0 overflow-hidden rounded bg-muted text-muted-foreground/60"
                      >
                        {#if component.image?.url}
                          <img
                            src={recipeHeroUrl(component)}
                            alt=""
                            loading="lazy"
                            class="h-full w-full object-cover"
                            data-testid="recipe-component-thumb"
                          />
                        {:else}
                          <span
                            class="flex h-full w-full items-center justify-center"
                            data-testid="recipe-component-thumb-fallback"
                          >
                            <!-- The kind's own placeholder icon, not a fixed pot: a
                               cocktail component wears a martini glass here exactly
                               as it does on the list and in the week's shop sheet.
                               Which picture a kind wears is COPY, which is what
                               `KIND_COPY` is for. -->
                            <Icon name={KIND_COPY[kindOf(component)].thumbIcon} size={20} />
                          </span>
                        {/if}
                      </span>
                      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span class="truncate text-sm font-medium">{component.title}</span>
                        {#if timeLabel !== null}
                          <span
                            class="inline-flex items-center gap-1 text-xs text-muted-foreground"
                            data-testid="recipe-component-cook-time"
                          >
                            <Icon name="Clock" size={12} />
                            {timeLabel}
                          </span>
                        {/if}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/snippet}
        {#snippet edit(close)}
          <div class="flex w-full flex-col gap-3" data-testid="recipe-edit-component-rows">
            <!-- Keyed by id, which a component row has and a phase row does not. The
               rows iterate the STORED ids so a dangling one is visible and
               removable here rather than dropped by the first reorder. -->
            {#each recipe.componentRecipeIds as id, i (id)}
              <div
                class="flex items-center gap-2 rounded border border-border px-3 py-2"
                data-testid="recipe-edit-component-row"
                data-recipe-id={id}
              >
                <span class="min-w-0 flex-1 truncate text-sm">{rowTitle(id)}</span>
                <ReorderControl
                  items={recipe.componentRecipeIds}
                  index={i}
                  noun="dish"
                  onReorder={setComponentIds}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => removeComponent(id)}
                  aria-label={`Remove ${rowTitle(id)}`}
                  data-testid={`recipe-edit-component-remove-${id}`}
                >
                  <Icon name="X" size={16} />
                </Button>
              </div>
            {/each}
            {#key pickerKey}
              <Combobox
                items={pickerItems}
                value=""
                filterFn={componentFilter}
                restrict
                placeholder="Add a dish…"
                onValueChange={addComponent}
              >
                <ComboboxField>
                  <ComboboxInput data-testid="recipe-edit-component-picker" />
                  <ComboboxTrigger />
                </ComboboxField>
                <ComboboxContent>
                  {#snippet children({ filteredItems })}
                    {#each filteredItems as item, i (item.value)}
                      <ComboboxItem {item} index={i} />
                    {/each}
                    {#if filteredItems.length === 0}
                      <ComboboxEmpty>Nothing found</ComboboxEmpty>
                    {/if}
                  {/snippet}
                </ComboboxContent>
              </Combobox>
            {/key}
            <div class="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onclick={close}
                data-testid="recipe-edit-components-done"
              >
                Done
              </Button>
            </div>
          </div>
        {/snippet}
      </EditableZone>
    </CardContent>
  </Card>
{/if}
