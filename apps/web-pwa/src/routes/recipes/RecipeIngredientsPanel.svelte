<script lang="ts">
  import {
    Button,
    CanonIcon,
    Card,
    CardContent,
    CardHeader,
    Icon,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Switch,
    TextField,
  } from '@salt/ui-components';
  import {
    clearIngredientMatch,
    emptyIngredientGroup,
    hasLiveCanonMatch,
    newIngredient,
    type Ingredient,
    type IngredientGroup,
    type Recipe,
  } from '@salt/domain';
  import EditableZone from './EditableZone.svelte';
  import IngredientText from './IngredientText.svelte';
  import ReorderControl from './ReorderControl.svelte';

  /**
   * The ingredients panel, read and written in the same place (issue #878 for the
   * three-column list, issue #1319 Phase 5 for the editing).
   *
   * Lifted out of `RecipeViewPage.svelte` unchanged in read mode: the same
   * Canonicalise header, the same scaled notice, the same group headings, the same
   * tile / name / amount columns and the same three match markers, testid for
   * testid. Edit mode adds a pencil beside each line and each group heading, a
   * dashed `+ Group name` slot on an unnamed group, reorder and remove on both,
   * and `+ Add an ingredient` / `+ Add a group`.
   *
   * TWO BOUNDARIES on "unchanged", because the unqualified version is false and
   * the review on this campaign has caught that sentence four times. (a) The
   * testids and their nesting are identical; the DOM is not — `EditableZone` wraps
   * the value it shows in one `<div>` so the pencil can be its sibling rather than
   * its parent, which is that component's own contract. (b) A row with NO WORDS AT
   * ALL reads differently: `EditableZone`'s `filled` is false for it, so read mode
   * draws its tile and nothing else, where the page used to draw an empty inspect
   * button. Such a row only exists between `+ Add an ingredient` and the next exit
   * from edit mode, because `dropBlankRows` takes it off at all three of them —
   * and one that a pre-#1319 document somehow carries is taken off by the first
   * Done pressed on it.
   *
   * ─── THE GESTURE COLLISION, AND HOW IT IS RESOLVED ──────────────────────────
   *
   * This is the one panel on the page whose row was ALREADY a tap target: the line
   * is a `<button>` that opens the match inspector (`recipe-view-ingredient-inspect`)
   * and the ✗ / ? / ⚠ marker beside it is a second button, its SIBLING rather than
   * its child, because buttons cannot nest. Edit mode cannot simply add a third
   * control and hope.
   *
   * Two rules settle it, and both are visible in the markup below:
   *
   *   1. THE LINE'S OWN TAP STOPS BEING A TAP. While editing, the name and the
   *      amount render inside a plain `<span>` (`recipe-view-ingredient-text`)
   *      rather than inside the inspect `<button>`, and `EditableZone`'s pencil
   *      beside it is what opens the line. So the inspect gesture is not
   *      overloaded, not intercepted and not racing anything — in edit mode it is
   *      not there, which also restores `EditableZone`'s own contract that a
   *      `view` snippet is never interactive. Read mode renders the button exactly
   *      as it always did.
   *
   *   2. THE MARKERS GO WITH IT. `{#if !editing}` around the marker block. The
   *      markers act on the MATCH, and a match is derived from the very text you
   *      are in the middle of rewriting — `rewordRow` below clears the match on
   *      every keystroke, so a re-match fired mid-word would be undone by the next
   *      letter. It also removes a marker that could not be honoured at all: a row
   *      you have just added has no text, which `rowMarker` reads as unmatched, and
   *      tapping its ✗ would send an empty line to the matcher (the retired editor
   *      gated its own match button on `rawText.trim() !== ''` for exactly that).
   *
   * THE BOUNDARY OF "the per-row re-match keeps working", stated rather than
   * rounded up: it keeps working WHERE IT LIVES, which is read mode. Press Done
   * and every marker is back, unchanged, doing what it did before this phase.
   * Nothing about `handleRematch`, `inspectMatch` or the inspector sheet is
   * altered here — they stay on the page and are passed in.
   *
   * ─── SCALING ────────────────────────────────────────────────────────────────
   *
   * `ingredientScale` is a prop and this component does not derive it: the page's
   * `scaling` derivation already pins `active` to `base` while `editing` (issue
   * #1324, Daniel's call), so an edit-mode row is ALREADY unscaled before it gets
   * here, and every box below is fed `rawText` — the stored line — never the
   * derived quantity. This phase's job was to pin that rather than re-implement
   * it, and the pin is `RecipeViewPage.scaling.test.ts` → *"the box and the list
   * never disagree about the amount"*, which drives a genuinely scaled `?serves=6`
   * URL and goes red if the `editing` clause is removed from that derivation.
   *
   * ─── THIS COMPONENT HOLDS A DRAFT ───────────────────────────────────────────
   *
   * `RecipeMethodRail`'s pattern, for its reason: there is real typing here (a
   * line, a group name), so a snapshot arriving from another phone or from a chat
   * amendment must not repaint a box mid-word. `groupsDraft` is what every box and
   * every row DRAW while editing; `recipe.ingredients` is what read mode draws.
   * The draft is seeded from the store in exactly three places and nowhere else:
   * when edit mode opens, when a zone opens, and when `recipe.id` changes.
   *
   * DRAWING and WRITING read from different places. Every gesture goes straight out
   * through `onEdit` — there is no Save — but the WRITE is composed off the
   * freshest `recipe.ingredients`, patching in only what that one gesture owns, and
   * it NEVER sends the whole draft back (that is what silently reverted a
   * concurrent amendment on #1336). Symmetrically, `commitWrite` never touches
   * `groupsDraft`: each gesture applies its own operation to the draft itself, so a
   * row a gesture is not about — including one a concurrent write just reworded —
   * is left alone.
   *
   * The boundary, stated rather than implied: while a box is open, a concurrent
   * write to this recipe's own ingredients stays out of the panel's DRAWING until
   * the draft is re-seeded. A line you are not touching goes on showing what it
   * showed when the box opened, through every later gesture. Visibility lags; the
   * write does not.
   *
   * ─── BLANK ROWS ─────────────────────────────────────────────────────────────
   *
   * Nothing here prunes. A row you added and never typed into is KEPT while you are
   * editing and dropped on every exit from edit mode, by `dropBlankRows` in
   * `blankRows.ts` — issue #1319's settled rule, extended by this phase to
   * ingredient rows and the groups they empty INSIDE that same function rather than
   * answered a second time here.
   *
   * REORDER IS `ReorderControl` AND NOTHING ELSE (#1332's ruling) — no pair of
   * buttons is inlined here, on either list.
   *
   * THIS FILE'S TWO UNCOVERABLE BRANCHES are both in the scaled notice, stated
   * rather than left to be found: `{scaling.active}` and `{scaling.base}` in a
   * text node each compile to `value ?? ''`, and on a number that is always
   * present that fallback is unreachable. Both came with the markup out of
   * `RecipeViewPage.svelte` rather than being added here, and composing the
   * sentence into one derived string would remove one of the two at the cost of
   * changing read markup this phase is meant to move verbatim.
   */
  let {
    recipe,
    editing,
    onEdit,
    ingredientScale,
    scaling,
    isScaled,
    setServings,
    thumbnailFor,
    iconVersionFor,
    ingredientLabel,
    rowMarker,
    liveCanonIds,
    matchingIds,
    handleRematch,
    inspectMatch,
    hasParsedPending,
    canonalising,
    handleCanonicalise,
  }: {
    recipe: Recipe;
    editing: boolean;
    /** Called with the whole next recipe. The page decides how it is written. */
    onEdit: (next: Recipe) => void;
    /** Always 1 while editing — the page's `scaling` derivation guarantees it. */
    ingredientScale: number;
    scaling: { base: number; active: number } | null;
    isScaled: boolean;
    setServings: (next: number, base: number) => void;
    thumbnailFor: (canonId: string | null) => string | null;
    iconVersionFor: (canonId: string | null) => string | number | undefined;
    /** The tile's label. One helper, on the page — the method rail's first-use row uses it too. */
    ingredientLabel: (ing: Ingredient) => string;
    rowMarker: (ing: Ingredient) => 'unmatched' | 'no-amount' | 'mismatched' | null;
    liveCanonIds: ReadonlySet<string>;
    matchingIds: Record<string, boolean>;
    handleRematch: (group: IngredientGroup, ing: Ingredient) => void;
    inspectMatch: (ing: Ingredient) => void;
    hasParsedPending: boolean;
    canonalising: boolean;
    handleCanonicalise: () => void;
  } = $props();

  // What every box reads while editing. Seeded in `seedDraft` and never re-synced
  // from the store for any other reason — see the header for why.
  let groupsDraft = $state<IngredientGroup[]>([]);

  // The list the panel draws. Read mode draws what is STORED; edit mode draws the
  // draft, so a box cannot be repainted by a write arriving mid-word.
  const groups = $derived(editing ? groupsDraft : recipe.ingredients);

  // Value-cloned two levels deep, because a group owns its items: the draft is only
  // ever replaced through an assignment below, but cloning is what stops a straight
  // reference to the store's own objects from being restyled as "the draft".
  function seedDraft(): void {
    groupsDraft = recipe.ingredients.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i })) }));
  }

  // Re-seeds on entering edit mode and on the document changing underneath, and on
  // nothing else. The early return is the whole protection: a concurrent write to
  // the SAME recipe re-runs this effect (it reads `recipe`) and leaves through the
  // guard without touching the draft. Keyed on the id STRING plus the mode, never
  // on the `recipe` object — `/recipes/:id` is one route, so a "Made from" tap
  // reuses this instance with a different document.
  let seededFor: string | undefined;
  $effect(() => {
    const key = `${recipe.id}|${editing}`;
    if (key === seededFor) return;
    seededFor = key;
    seedDraft();
  });

  // The one place any gesture here reaches `onEdit`. `next` is always composed by
  // the CALLER off `recipe.ingredients` — never off `groupsDraft` — and this NEVER
  // touches `groupsDraft` itself: re-seeding the whole draft from the write's own
  // result is what let a concurrent rewording of a line get pulled back in by the
  // very next unrelated gesture (#1336 review round 2).
  function commitWrite(next: IngredientGroup[]): void {
    onEdit({ ...recipe, ingredients: next });
  }

  // A keystroke in a group's name. The WRITE patches only that group's `name` onto
  // the freshest `recipe.ingredients`; the DRAFT gets the identical patch, so a
  // sibling group's draft entry is untouched.
  //
  // `''` is stored as `null`, never as an empty string — that is what makes "this
  // group has a heading" a question the dashed slot can answer, and it is the
  // retired editor's own rule (`setGroupName`) kept verbatim.
  function setGroupName(groupId: string, value: string): void {
    const trimmed = value.trim();
    const name = trimmed === '' ? null : trimmed;
    commitWrite(recipe.ingredients.map((g) => (g.id === groupId ? { ...g, name } : g)));
    groupsDraft = groupsDraft.map((g) => (g.id === groupId ? { ...g, name } : g));
  }

  /** Replace one group's items, in the write and in the draft, and nothing else. */
  function patchItems(
    groupId: string,
    next: (items: readonly Ingredient[]) => Ingredient[],
    draftNext: (items: readonly Ingredient[]) => Ingredient[],
  ): void {
    commitWrite(
      recipe.ingredients.map((g) => (g.id === groupId ? { ...g, items: next(g.items) } : g)),
    );
    groupsDraft = groupsDraft.map((g) =>
      g.id === groupId ? { ...g, items: draftNext(g.items) } : g,
    );
  }

  // Rewording a line drops the match it had: the canon item the old words bought is
  // not what the new words buy, and leaving it attached is how a line ends up
  // silently shopping for something nobody asked for. `clearIngredientMatch` is the
  // domain's own answer and is the editor's rule kept verbatim, including the no-op
  // guard — an `onValueChange` that fires with the text unchanged must not throw
  // away a good match.
  function rewordRow(items: readonly Ingredient[], id: string, rawText: string): Ingredient[] {
    return items.map((i) => {
      if (i.id !== id) return i;
      if (i.rawText === rawText) return i;
      return { ...clearIngredientMatch(i), rawText };
    });
  }

  function setRowText(groupId: string, id: string, rawText: string): void {
    patchItems(
      groupId,
      (items) => rewordRow(items, id, rawText),
      (items) => rewordRow(items, id, rawText),
    );
  }

  function setRowOptional(groupId: string, id: string, isOptional: boolean): void {
    const patch = (items: readonly Ingredient[]): Ingredient[] =>
      items.map((i) => (i.id === id ? { ...i, isOptional } : i));
    patchItems(groupId, patch, patch);
  }

  // Add / remove / reorder carry no in-flight text at all, so the WRITE composes
  // straight off `recipe.ingredients`; the DRAFT gets the same structural change
  // applied to its own objects, so an open box elsewhere in the list keeps what it
  // has typed.
  //
  // `Add an ingredient` is an imperative and writes the row it promises, exactly as
  // `Add step` and `+ Add a phase` do. Backing straight out therefore leaves a
  // blank row until edit mode ends, which is where `dropBlankRows` takes it off
  // again.
  function addRow(groupId: string): void {
    const created = newIngredient(crypto.randomUUID(), '');
    patchItems(
      groupId,
      (items) => [...items, created],
      (items) => [...items, created],
    );
  }

  function removeRow(groupId: string, id: string): void {
    const patch = (items: readonly Ingredient[]): Ingredient[] => items.filter((i) => i.id !== id);
    patchItems(groupId, patch, patch);
  }

  // `ReorderControl` hands back the list it was given — which while editing IS the
  // draft — reordered by one swap. Its CONTENT can be stale against the store, so
  // only the ORDER OF IDS is taken from it and replayed against the fresh objects;
  // anything the fresh list has that the reordered input did not (added by a
  // concurrent write since the draft was seeded) is appended rather than silently
  // dropped. The DRAFT takes `next` verbatim: `move` splices POSITIONS and never
  // content, so `next` still holds the draft's own objects, open box included,
  // merely reordered.
  function replayOrder<T extends { id: string }>(
    order: readonly string[],
    fresh: readonly T[],
  ): T[] {
    const byId = new Map(fresh.map((x) => [x.id, x] as const));
    const reordered = order.map((id) => byId.get(id)).filter((x): x is T => x !== undefined);
    const appended = fresh.filter((x) => !order.includes(x.id));
    return [...reordered, ...appended];
  }

  function reorderRows(groupId: string, next: Ingredient[]): void {
    const order = next.map((i) => i.id);
    patchItems(
      groupId,
      (items) => replayOrder(order, items),
      () => next,
    );
  }

  function addGroup(): void {
    const created = emptyIngredientGroup(crypto.randomUUID());
    commitWrite([...recipe.ingredients, created]);
    groupsDraft = [...groupsDraft, created];
  }

  function removeGroup(groupId: string): void {
    commitWrite(recipe.ingredients.filter((g) => g.id !== groupId));
    groupsDraft = groupsDraft.filter((g) => g.id !== groupId);
  }

  function reorderGroups(next: IngredientGroup[]): void {
    const order = next.map((g) => g.id);
    commitWrite(replayOrder(order, recipe.ingredients));
    groupsDraft = next;
  }

  // MOVING A LINE FROM ONE GROUP TO ANOTHER — the one behaviour on this panel the
  // retired editor never had, so it is designed rather than copied.
  //
  // It is a `Select` inside the line's own open editor, offered only when there is
  // somewhere to move to (`groups.length > 1`), and it drops the line at the END of
  // the group it joins. Reasons, in order: it is where you already are once you have
  // decided a line is in the wrong place; it reuses the list's existing vocabulary
  // (a group is named, or it is the main list) rather than inventing a cross-group
  // drag the rows have no stable identity to support (see `ReorderControl`'s header
  // on why a drag cannot exist here at all yet); and a destination chosen from a
  // list is the one gesture that works the same on a phone and on a desktop.
  //
  // The line's editor CLOSES as it moves, because the zone is keyed by the row's id
  // inside its group's `{#each}` and the row is now in a different one. That is the
  // honest outcome — the thing you were editing is not where it was — and the text
  // is already written, so nothing is lost.
  //
  // Composed off the freshest stored groups on BOTH sides: the row taken is the
  // stored one, which after `queueRecipeEdit`'s synchronous optimistic apply is at
  // least as fresh as the draft's own copy for anything typed this session.
  function moveRowToGroup(fromGroupId: string, id: string, toGroupId: string): void {
    if (fromGroupId === toGroupId) return;
    const row = storedRow(fromGroupId, id);
    if (!row) return;
    const move = (gs: readonly IngredientGroup[]): IngredientGroup[] =>
      gs.map((g) => {
        if (g.id === fromGroupId) return { ...g, items: g.items.filter((i) => i.id !== id) };
        if (g.id === toGroupId) return { ...g, items: [...g.items, row] };
        return g;
      });
    commitWrite(move(recipe.ingredients));
    groupsDraft = move(groupsDraft);
  }

  function storedRow(groupId: string, id: string): Ingredient | undefined {
    return recipe.ingredients.find((g) => g.id === groupId)?.items.find((i) => i.id === id);
  }

  /**
   * What a group is called in the move picker. An unnamed group is "the main list",
   * which is the words the list itself uses — and the reason the picker cannot
   * distinguish a SECOND unnamed group from the first: neither draws a heading in
   * read mode either, so the picker is no vaguer than the page. Name one and both
   * become addressable.
   */
  function groupLabel(group: IngredientGroup): string {
    return group.name ?? 'Main list';
  }

  function rowBusy(ing: Ingredient): boolean {
    return matchingIds[ing.id] ?? false;
  }
</script>

<!-- The thing first, the amount last. Amounts led this column until #878 and the
     order was backwards for how the list is actually used: you scan for THE
     INGREDIENT — do I have chorizo — and only then read what it says beside it.
     Names on the left edge means nineteen of them start at the same x; amounts
     pinned right means they still line up as a column, which is what makes "how
     much flour, how much water" one question rather than nineteen. `min-w-0` so a
     long name wraps inside its cell rather than shoving the amount off the row.

     One snippet, two wrappers: a `<button>` that opens the match inspector in read
     mode and an inert `<span>` while editing. The columns themselves are identical
     in both, which is what makes "the page does not move when you press Edit" true
     of this panel rather than merely intended. -->
{#snippet rowColumns(ingredient: Ingredient)}
  <span class="min-w-0 flex-1">
    <IngredientText {ingredient} part="name" scale={ingredientScale} />
  </span>
  <!-- The metric amount, and the measure the source actually printed sitting UNDER
       it: "1 ½ cups" is a second way of saying 300g, so it belongs beneath the
       number it restates rather than trailing the end of a sentence about lentils,
       where it read as a third fact about the ingredient. An UNPARSED line has no
       separable amount, so both are empty and the whole raw text sits in the name
       cell — which is what keeps a part-parsed list from ragging. -->
  <span class="shrink-0 text-right tabular-nums leading-tight">
    <IngredientText {ingredient} part="quantity" scale={ingredientScale} /><IngredientText
      {ingredient}
      part="display"
      scale={ingredientScale}
    />
  </span>
{/snippet}

<Card>
  <!-- The tab names the panel, so the card no longer repeats the word. The header
       survives only to carry Canonicalise, which is why it is gated on the button
       rather than always rendered. -->
  {#if hasParsedPending}
    <CardHeader class="px-4 pt-4 pb-0">
      <div class="flex items-center justify-end">
        <Button
          size="sm"
          variant="outline"
          onclick={handleCanonicalise}
          loading={canonalising}
          disabled={canonalising}
          data-testid="recipe-canonicalise-button"
        >
          {#snippet leading()}<Icon name="Link" size={14} />{/snippet}
          Canonicalise
        </Button>
      </div>
    </CardHeader>
  {/if}
  <CardContent class={hasParsedPending ? 'px-4 pb-4 pt-3' : 'p-4'}>
    <!-- What scaling did, and what it did NOT do (issue #1314). Stated rather than
         left obvious: a recipe that genuinely does not scale linearly — a cake, a
         loaf, anything where the tin is the real constraint — scales linearly here
         too, and the only honest answer to that is to say so where the amounts are
         read. The line names both numbers so the reader can see what was changed
         from, and carries the way back in one tap. -->
    {#if scaling && isScaled}
      <div
        class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-tertiary-variant bg-tertiary-variant/15 px-3 py-2 text-xs text-muted-foreground"
        data-testid="recipe-scaled-notice"
      >
        <span>
          Amounts scaled for {scaling.active} — the recipe is written for {scaling.base}. Nothing
          else changed: the method, the timings and any tin or pan size are as written.
        </span>
        <Button
          size="sm"
          variant="ghost"
          onclick={() => setServings(scaling.base, scaling.base)}
          data-testid="recipe-scaled-reset"
        >
          Reset
        </Button>
      </div>
    {/if}
    {#if groups.length === 0}
      <p class="text-sm text-muted-foreground">No ingredients.</p>
    {/if}
    {#each groups as group, gIdx (group.id)}
      <div class="flex flex-col gap-1.5 [&+&]:mt-4" data-testid="recipe-view-group">
        <div class="flex items-start gap-2">
          <EditableZone
            {editing}
            filled={(group.name ?? '') !== ''}
            label="Edit group name"
            slotLabel="Group name"
            testId="recipe-edit-group-name"
            class="min-w-0 flex-1"
            onOpen={seedDraft}
          >
            {#snippet view()}
              <!-- Sage, not muted grey (issue #878). A component heading — "For the
                   punchy vinaigrette" — divides the list into the sub-recipes you
                   actually make one at a time, and in grey it read as a caption on
                   the rows above it. The palette's secondary is the app's "this is a
                   part of something" colour and it is already what a matched tile
                   settles to, so the heading and the pictograms below it agree.

                   No `{#if group.name}` around this: `EditableZone` renders a `view`
                   snippet only when `filled` is true, which for this zone IS "the
                   group has a heading", so a guard here would be a branch nothing
                   can reach. -->
              <p
                class="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wider text-secondary"
                data-testid="recipe-view-group-name"
              >
                {group.name}
              </p>
            {/snippet}
            {#snippet edit(close)}
              <div class="flex w-full flex-col gap-2">
                <TextField
                  label="Group name"
                  placeholder="e.g. For the sauce (leave blank for the main list)"
                  value={group.name ?? ''}
                  onValueChange={(v) => setGroupName(group.id, v)}
                  data-testid="recipe-edit-group-name-field"
                />
                <div class="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={close}
                    data-testid="recipe-edit-group-name-done"
                  >
                    Done
                  </Button>
                </div>
              </div>
            {/snippet}
          </EditableZone>
          {#if editing}
            <span class="flex shrink-0 items-start gap-1" data-testid="recipe-edit-group-tools">
              <ReorderControl items={groups} index={gIdx} noun="group" onReorder={reorderGroups} />
              <Button
                variant="ghost"
                size="sm"
                onclick={() => removeGroup(group.id)}
                aria-label="Remove group"
                data-testid="recipe-edit-group-remove"
              >
                <Icon name="Trash2" size={16} />
              </Button>
            </span>
          {/if}
        </div>
        <!-- `gap-0` and a hairline instead: the rows used to float 1.5 units apart
             with nothing between them, which reads as nineteen separate things
             rather than one list. A rule per row does the separating, so the gap can
             close and the column becomes something you run your eye down. Drawn on
             the bottom edge and dropped on the last child, so a group never ends on
             a line pointing at the group below it. -->
        <ul class="flex flex-col">
          {#each group.items as ingredient, rIdx (ingredient.id)}
            {@const marker = rowMarker(ingredient)}
            <!-- Three columns (issue #878): the pictogram, the thing, the amount. The
                 tile is the shopping list's since #571 and cook mode's since #532 —
                 one ingredient wears the same picture wherever the app names it —
                 and it is rendered for every row, matched or not, because a bare tile
                 is what holds the text column straight instead of ragging in and out.
                 `matched` lets a matched-but-iconless line settle to sage rather than
                 sitting in unmatched grey while its icon generates.

                 The marker is the line's SIBLING, not a child: buttons cannot nest,
                 and the two do different jobs — one explains the match, the other
                 acts on what is wrong with it. At most one marker: a line is
                 unmatched, without an amount, or mis-bought — never more than one at
                 a time. The marker sits on the CORNER OF THE TILE rather than at the
                 end of the line, because what it describes is the match, and the
                 match is what the tile is a picture of.

                 While editing the whole marker block is absent, and the line's own
                 tap with it — see the gesture-collision note at the top of this
                 file. -->
            <li
              class="flex items-center gap-2 border-b border-border py-1.5 text-sm last:border-b-0"
              data-testid="recipe-view-ingredient"
            >
              <div class="relative shrink-0">
                <CanonIcon
                  thumbnail={thumbnailFor(ingredient.canonId)}
                  name={ingredientLabel(ingredient)}
                  version={iconVersionFor(ingredient.canonId)}
                  matched={marker === null && hasLiveCanonMatch(ingredient, liveCanonIds)}
                  size={40}
                />
                {#if !editing}
                  {#if marker === 'unmatched'}
                    <button
                      type="button"
                      class="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-xs leading-none text-destructive-foreground ring-2 ring-card disabled:opacity-50"
                      title="Not matched — tap to match"
                      aria-label="Not matched — tap to match"
                      onclick={() => handleRematch(group, ingredient)}
                      disabled={rowBusy(ingredient)}
                      data-testid="match-state-unmatched">{rowBusy(ingredient) ? '…' : '✗'}</button
                    >
                  {:else if marker === 'no-amount'}
                    <!-- Terracotta, like the ⚠ — this line looks finished too. The
                         glyph and the action are the ✗'s, because the remedy is the
                         ✗'s: matchIngredient re-parses the line before it matches it,
                         which is precisely the repair that populated these rows by
                         hand (issue #949). Nothing to explain first, so nothing
                         opens. -->
                    <button
                      type="button"
                      class="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-tertiary-variant text-xs leading-none text-tertiary-foreground ring-2 ring-card disabled:opacity-50"
                      title="No amount — tap to read the line again"
                      aria-label="No amount — tap to read the line again"
                      onclick={() => handleRematch(group, ingredient)}
                      disabled={rowBusy(ingredient)}
                      data-testid="match-state-no-amount">{rowBusy(ingredient) ? '…' : '?'}</button
                    >
                  {:else if marker === 'mismatched'}
                    <!-- Terracotta, the palette's warning accent (design.md), and
                         never the ✗'s red: the two say different things and want
                         different actions. This one opens the sheet the row already
                         opens, because the sheet explains BOTH causes and offers the
                         re-match — no new copy. -->
                    <button
                      type="button"
                      class="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-tertiary-variant text-xs leading-none text-tertiary-foreground ring-2 ring-card"
                      title="Matched, but buys the wrong thing — tap to see why"
                      aria-label="Matched, but buys the wrong thing — tap to see why"
                      onclick={() => inspectMatch(ingredient)}
                      data-testid="match-state-mismatched">⚠</button
                    >
                  {/if}
                {/if}
              </div>
              <EditableZone
                {editing}
                filled={ingredient.rawText.trim() !== ''}
                label="Edit ingredient"
                slotLabel="Ingredient"
                testId="recipe-edit-ingredient"
                class="min-w-0 flex-1"
                onOpen={seedDraft}
              >
                {#snippet view()}
                  {#if editing}
                    <!-- The same three columns, with no tap on them. -->
                    <span
                      class="flex min-w-0 flex-1 items-center gap-3 text-left"
                      data-testid="recipe-view-ingredient-text"
                    >
                      {@render rowColumns(ingredient)}
                    </span>
                  {:else}
                    <button
                      type="button"
                      class="salt-focus-ring-inset flex min-w-0 flex-1 items-center gap-3 rounded text-left"
                      title="See what this ingredient matched"
                      onclick={() => inspectMatch(ingredient)}
                      data-testid="recipe-view-ingredient-inspect"
                    >
                      {@render rowColumns(ingredient)}
                    </button>
                  {/if}
                {/snippet}
                {#snippet edit(close)}
                  <div class="flex w-full flex-col gap-2">
                    <!-- The RAW line, never the derived quantity: an amount on this
                         page is computed from `rawText` (and restated by a scale that
                         is always 1 while editing), so the thing you type is the
                         thing that is stored. -->
                    <TextField
                      label="Ingredient"
                      placeholder="e.g. 1 ½ cups plain flour, sifted"
                      value={ingredient.rawText}
                      onValueChange={(v) => setRowText(group.id, ingredient.id, v)}
                      data-testid="recipe-edit-ingredient-field"
                    />
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <!-- `Switch` takes no `data-testid` of its own (ui-spec-v02
                           §8.5), so the hook goes on a wrapper rather than on a
                           prop the primitive does not have. -->
                      <span data-testid="recipe-edit-ingredient-optional">
                        <Switch
                          label="Optional"
                          checked={ingredient.isOptional}
                          onCheckedChange={(c) => setRowOptional(group.id, ingredient.id, c)}
                        />
                      </span>
                      {#if groups.length > 1}
                        <Select
                          value={group.id}
                          onValueChange={(v) => moveRowToGroup(group.id, ingredient.id, v)}
                        >
                          <SelectTrigger
                            class="h-8 w-44 text-xs"
                            aria-label="Which group this ingredient is in"
                            data-testid="recipe-edit-ingredient-group"
                          >
                            {groupLabel(group)}
                          </SelectTrigger>
                          <SelectContent>
                            {#each groups as target (target.id)}
                              <SelectItem value={target.id} label={groupLabel(target)} />
                            {/each}
                          </SelectContent>
                        </Select>
                      {/if}
                      <Button
                        variant="ghost"
                        size="sm"
                        onclick={close}
                        data-testid="recipe-edit-ingredient-done"
                      >
                        Done
                      </Button>
                    </div>
                  </div>
                {/snippet}
              </EditableZone>
              {#if editing}
                <span
                  class="flex shrink-0 items-start gap-1"
                  data-testid="recipe-edit-ingredient-tools"
                >
                  <ReorderControl
                    items={group.items}
                    index={rIdx}
                    noun="ingredient"
                    onReorder={(next) => reorderRows(group.id, next)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => removeRow(group.id, ingredient.id)}
                    aria-label="Remove ingredient"
                    data-testid="recipe-edit-ingredient-remove"
                  >
                    <Icon name="Trash2" size={16} />
                  </Button>
                </span>
              {/if}
            </li>
          {/each}
        </ul>
        {#if editing}
          <Button
            variant="ghost"
            size="sm"
            onclick={() => addRow(group.id)}
            class="self-start"
            data-testid="recipe-edit-ingredient-add"
          >
            {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
            Add an ingredient
          </Button>
        {/if}
      </div>
    {/each}
    {#if editing}
      <Button
        variant="outline"
        size="sm"
        onclick={addGroup}
        class="mt-4"
        data-testid="recipe-edit-group-add"
      >
        {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
        Add a group
      </Button>
    {/if}
  </CardContent>
</Card>
