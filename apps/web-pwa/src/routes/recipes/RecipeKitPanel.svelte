<script lang="ts">
  import {
    Button,
    CanonIcon,
    Card,
    CardContent,
    Combobox,
    ComboboxContent,
    ComboboxCreate,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    ComboboxTrigger,
    Icon,
  } from '@salt/ui-components';
  import type { EquipmentItem, KitEquipmentGroup, Recipe } from '@salt/domain';
  import type { KitchenToolDoc, RecipeKitEntryDoc } from '@salt/domain/schemas';
  import { sentenceCase } from '../../lib/sentenceCase.js';
  import ReorderControl from './ReorderControl.svelte';

  /**
   * The Equipment panel, read and written in the same place (issue #1140 for the
   * tab, issue #1496 for the editing).
   *
   * Lifted out of `RecipeViewPage.svelte` unchanged in read mode: the grouped
   * rows, the reserved 40px gutter with NO tile drawn on a picture miss, the
   * "with the …" accessory continuation, `sentenceCase` on the label and not on
   * the continuation, and the pictureless row staying a button that opens
   * `KitPicturePicker`. Same testids, same nesting.
   *
   * ── WHY THIS PANEL EDITS THE FLAT STORED LIST ────────────────────────────────
   *
   * Read mode renders `kitGroups` — `groupKitByEquipment` folds an accessory
   * entry into its appliance's row, so ONE rendered row can be SEVERAL stored
   * entries. Remove on such a row has no single entry to delete and reorder has
   * no stored order to move. Edit mode therefore draws `recipe.kit` itself, one
   * row per stored entry, which is also what the read list looked like before
   * #1465 Phase 4.
   *
   * ── WHY THERE IS NO DRAFT HERE, AND NO `EditableZone` ────────────────────────
   *
   * `RecipeIngredientsPanel` needs both because its editor is a `TextField`: a
   * write per keystroke, so a concurrent write landing mid-word would repaint the
   * box. A kit row's editor is a `Combobox`, whose commit is a DISCRETE act —
   * pick an option, or press Enter / Tab / "Use these words" on what you typed —
   * so there is exactly one write per row edit and nothing to repaint mid-word.
   * With no draft, #1319's standing requirement 1 ("editing state must not
   * outlive its recipe") is satisfied by construction rather than by an effect:
   * the only state in this file is each `Combobox`'s own `inputValue`, and the
   * whole edit branch is inside `{#if editing}`, so leaving edit mode — including
   * the page's id-keyed reset setting `editing = false` on a route change —
   * unmounts every one of them. Pinned by `RecipeKitPanel.edit.test.ts`.
   *
   * A row is always live rather than tap-to-open for the same reason: with no
   * read-mode gesture on the row to preserve while editing (the picture button is
   * gated `{#if !editing}` below), an `EditableZone` would add a tap and a dashed
   * `+ Equipment` slot directly beneath the `+ Add equipment` button that wrote
   * the row — two affordances for one act.
   *
   * ── A ROW POINTS AT ONE OF YOUR THINGS, OR IT IS WORDS ───────────────────────
   *
   * NO `kitchenTools` ID IS EVER WRITTEN ONTO A RECIPE. The combobox OFFERS the
   * drawn vocabulary, because those are the words a picture already exists for —
   * but choosing one writes its LABEL and `equipment: null`, exactly as typing
   * the same words by hand would. The vocabulary grows and shrinks and every
   * recipe that already says the word gains a picture for free; an id would
   * freeze that (`recipe.ts`'s `RecipeKitEntrySchema` header, and
   * `docs/recipe-module.md`). Pinned by `RecipeKitPanel.edit.test.ts`.
   *
   * Equipment is IDENTITY and does get a link: choosing an item writes
   * `{ itemId, accessoryId: null }`, choosing one of its accessories or family
   * members writes both ids — and in both cases the label becomes THAT ENTRY'S
   * MANIFEST NAME. The schema comment at `recipe.ts` keeps the kit FLOW's prose
   * ("steam basket") over the manifest's ("Steam Basket") because the flow was
   * told to write prose; that argument does not reach a human picking from a
   * list, who chose those words.
   *
   * `stepIds` is carried through every gesture untouched and is not editable here
   * (Daniel's call on #1496: a step-assignment control is a multi-select per row
   * against the whole method, several times the UI for a much rarer correction).
   * A hand-added row therefore carries `stepIds: []` and shows in this tab but
   * beside no step; Redo kit remains the way to get per-step links back.
   *
   * ── TWO BOUNDARIES, stated rather than rounded up (CLAUDE.md rule 12) ────────
   *
   * (a) A gesture addresses its row BY INDEX, because `RecipeKitEntrySchema` has
   * no id to key by. So a write landing from elsewhere between the render and the
   * tap — in practice only Redo kit, which replaces the whole list — can move a
   * row under an open combobox, and the gesture then lands on whatever now sits
   * at that index. This is the same exposure the read list's picture picker has
   * and it is not defended against; the alternative is inventing an identity for
   * kit entries, which is a schema change this issue forbids.
   *
   * (b) An option's `value` is a synthetic key (`equipment:<id>`,
   * `kitchenTool:<id>`); free text is anything that is not one of those keys.
   * Typing a string character-for-character equal to one of them therefore reads
   * as that choice rather than as words. Nobody types `equipment:eq-pizzaiolo`,
   * and the outcome when they do is the item they named.
   */
  let {
    recipe,
    editing,
    onEdit,
    kitGroups,
    equipmentItems,
    kitchenTools,
    kitIconFor,
    kitIconVersionFor,
    onPicture,
  }: {
    recipe: Recipe;
    editing: boolean;
    /** Called with the whole next recipe. The page decides how it is written. */
    onEdit: (next: Recipe) => void;
    /** Read mode's display order, accessories folded in. `groupKitByEquipment`. */
    kitGroups: readonly KitEquipmentGroup[];
    /** The household's manifest — the combobox's own things. */
    equipmentItems: readonly EquipmentItem[];
    /** The drawn tool vocabulary — offered as words, never written as an id. */
    kitchenTools: readonly KitchenToolDoc[];
    kitIconFor: (entry: RecipeKitEntryDoc) => string | null;
    kitIconVersionFor: (entry: RecipeKitEntryDoc) => string | number | undefined;
    /** A pictureless read-mode row was tapped, by label. The page opens the picker. */
    onPicture: (label: string) => void;
  } = $props();

  const kit = $derived(recipe.kit);

  // The accessories of one appliance, as the tail of "with the …". `Intl.ListFormat`
  // rather than `join(', ')`: three accessories read "a, b and c", and the Oxford-less
  // en-GB conjunction is exactly what a cook would say out loud, which is the register
  // the labels themselves are written in.
  //
  // The literal "with the " is composed HERE rather than sitting beside the
  // interpolation in the markup: a text node reading `with the {expr}` compiles to
  // `expr ?? ''`, and on an expression that is always a string that fallback is a
  // branch no test can ever reach (the same reasoning `EditableZone` and
  // `ReorderControl` give for composing their own strings in script).
  const accessoryList = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' });
  function accessoryTail(accessories: readonly { label: string }[]): string {
    return `with the ${accessoryList.format(accessories.map((a) => a.label))}`;
  }

  /**
   * One offered thing: what the DROPDOWN reads, and what choosing it WRITES.
   *
   * The two differ for an accessory — the dropdown says "Steam Basket — Cosori
   * 5L Rice Cooker" so two identically named entries under different machines
   * are tellable apart, while the row should say what the thing is called, not
   * where it lives. Both are settled here, where the manifest record is already
   * in hand, rather than re-derived from the key afterwards: re-deriving meant
   * parsing the key back into a lookup that could not fail, and a `?? null`
   * nothing can reach is exactly the branch that has no test to write.
   */
  type Choice = {
    value: string;
    /** The dropdown's words. */
    label: string;
    /** The row's words. `stepIds` is never in here. */
    write: string;
    equipment: RecipeKitEntryDoc['equipment'];
  };

  // Built the same way `KitPicturePicker` builds its own list — each item, then
  // each of its accessories / family members. That picker answers a DIFFERENT
  // question (borrow a picture, hence its `isDrawn` filter and its
  // linked/unlinked split), so the shape is reused and the component is not.
  const choices = $derived.by(() => {
    const out = new Map<string, Choice>();
    for (const item of equipmentItems) {
      const value = `equipment:${item.id}`;
      out.set(value, {
        value,
        label: item.name,
        write: item.name,
        equipment: { itemId: item.id, accessoryId: null },
      });
      // `?? []` stays, exactly as `resolveKitEntryEquipment` carries it and for
      // the same reason: the schema defaults `accessories`, so a PARSED item
      // always has the array — but a partial item (a page fixture, a projection)
      // must degrade to "offers nothing of its own" rather than throw inside a
      // render. Pinned by a test.
      for (const accessory of item.accessories ?? []) {
        const key = `${value}:${accessory.id}`;
        out.set(key, {
          value: key,
          label: `${accessory.name} — ${item.name}`,
          write: accessory.name,
          equipment: { itemId: item.id, accessoryId: accessory.id },
        });
      }
    }
    for (const t of kitchenTools) {
      // WORDS, NOT AN ID — see the header. The option's `value` carries the id
      // only so the combobox can tell two identically-worded tools apart; what is
      // written is `write`, with no link at all.
      out.set(`kitchenTool:${t.id}`, {
        value: `kitchenTool:${t.id}`,
        label: t.label,
        write: t.label,
        equipment: null,
      });
    }
    return out;
  });

  /**
   * The options this row offers. The base list, plus the row's own current words
   * when they are not already one of them — without that the `Combobox` finds no
   * option matching its seeded `value` and paints an EMPTY input, hiding the very
   * thing you came to change. Re-picking it is a no-op, which is the correct
   * reading of "leave this row as it is".
   */
  function rowItems(entry: RecipeKitEntryDoc): { value: string; label: string }[] {
    const base = [...choices.values()].map((c) => ({ value: c.value, label: c.label }));
    const current = rowValue(entry);
    return choices.has(current) || current === ''
      ? base
      : [{ value: current, label: current }, ...base];
  }

  /** Which option this row currently IS — its link's key, or its own words. */
  function rowValue(entry: RecipeKitEntryDoc): string {
    const link = entry.equipment;
    if (!link) return entry.label;
    const key =
      link.accessoryId === null
        ? `equipment:${link.itemId}`
        : `equipment:${link.itemId}:${link.accessoryId}`;
    // A link nothing answers to any more is not a choice — the row reads as its
    // words, which is exactly what `resolveKitEntryEquipment` does with a dangling
    // link everywhere else.
    return choices.has(key) ? key : entry.label;
  }

  /** The one place any gesture here reaches `onEdit`. Composed off the stored kit. */
  function commit(next: RecipeKitEntryDoc[]): void {
    onEdit({ ...recipe, kit: next });
  }

  function patch(index: number, change: Pick<RecipeKitEntryDoc, 'label' | 'equipment'>): void {
    commit(kit.map((e, i) => (i === index ? { ...e, ...change } : e)));
  }

  function chooseRow(index: number, value: string): void {
    const choice = choices.get(value);
    if (choice) {
      patch(index, { label: choice.write, equipment: choice.equipment });
      return;
    }
    // Free text, and the row's own current words arrive here too (`rowItems` adds
    // them as a synthetic option, and they are not in `choices`) — re-picking them
    // writes the same label back with the same null link, which is a no-op the
    // coalescer swallows.
    patch(index, { label: value.trim(), equipment: null });
  }

  // `Add equipment` is an imperative and writes the row it promises, exactly as
  // `+ Add an ingredient` and `Add step` do. Backing straight out therefore leaves
  // a labelless row until edit mode ends, which is where `dropBlankRows` takes it
  // off again.
  function addRow(): void {
    commit([...kit, { label: '', stepIds: [], equipment: null }]);
  }

  function removeRow(index: number): void {
    commit(kit.filter((_, i) => i !== index));
  }

  // `ReorderControl` hands back the list it was given, reordered by one swap. It is
  // handed `kit` itself — the stored array, not a draft — so what comes back is
  // already composed off the freshest entries and needs no replay.
  function reorderRows(next: RecipeKitEntryDoc[]): void {
    commit(next);
  }
</script>

<!-- Equipment (issue #1140). Was a "You'll need" card of `PictogramPill` chips
     above the strip; it is a third alternative view of the same region now, which
     is what ui-spec-v10 §8.28 is for. Read the same way the ingredients beside it
     are read: one thing per line, the picture in a fixed left gutter, a hairline
     between rows, so the names start at one left edge and the column is something
     you run your eye down rather than a heap of chips.

     THE GUTTER IS RESERVED, THE TILE IS NOT DRAWN ON A MISS. The ingredients list
     draws `CanonIcon` for every row, matched or not, because its bare tile is what
     holds the text column straight. Kit cannot borrow that: #882's contract is
     that a label the drawn vocabulary does not know renders its WORDS with no
     picture — never the bare placeholder, which reads as a broken image, and never
     another tool's drawing. A fixed-width empty gutter buys the straight column
     without the tile, so the two rules do not have to be traded off against each
     other.

     The picture comes from `kitIconFor` — the page's `$kitIcons`, equipment
     vocabulary first, then kitchen tools; that file's header explains at length
     why the order is load-bearing (#954) — so turning the icon kill-switch off
     costs the pictures and nothing else.

     AN ACCESSORY IS NOT A ROW, in read mode. It is said on the appliance's own
     row, as a second line under the name: "Cosori 5L Rice Cooker / with the steam
     basket and rice spoon". `groupKitByEquipment` decides what belongs to what — a
     pure query, so the page never guesses, and it never nests an accessory whose
     appliance this recipe did not ask for. Since #1465 Phase 4 it reads the
     entry's recorded LINK and nothing else, so a kit written before that run lists
     its parts flat until "Redo kit" is pressed.

     It used to be its own `<li>`, indented `pl-12` and muted, drawing through the
     same lookup as the head row. That lookup is what killed the design: since
     #1182 a prefixed accessory resolves to its OWNING item, so "hand blender
     attachment" drew the Ninja's picture at 40px directly beneath the Ninja's
     picture at 40px, with a full-width hairline between them. The loudest signal
     on the row said "another one of these" while the indent whispered "part of
     that" — and the indent lost. Folding it into the appliance removes the second
     tile, the second hairline and the ambiguity together: a thing that came in the
     box is not a thing you go and fetch.

     It is also what the accessibility tree wanted. The indented row needed an
     `aria-label` — "Rice Spoon, part of Cosori 5L Rice Cooker" — precisely because
     `pl-12` and `text-muted-foreground` are pixels, not structure, and a screen
     reader walking a flat `<ul>` was handed siblings. The relationship is now
     ordinary visible text inside the appliance's own `<li>`, so it is announced
     with the appliance without a parallel accessible name to keep in step with
     what is on screen. `RecipeViewPage.kit.test.ts` reads it as text.

     EACH ROW OPENS WITH A CAPITAL, and that is the only letter this page decides.
     A label is the household's own wording or the kit flow's canonical name, so
     `sentenceCase` raises the first character and leaves "Cosori 5L Rice Cooker"
     and "OXO Mandoline" untouched; `titleCase` would rewrite both. The accessory
     line under the name opens "with the …" and is left alone — it is a
     continuation, not a row. `groupKitByEquipment` reads the stored entry rather
     than the rendered text, so the capital is a rendering and nothing downstream
     sees it. -->
<Card>
  <CardContent class="p-4">
    {#if editing}
      <!-- THE FLAT STORED LIST — see the header. One row per `kit[]` entry, so
           Remove has exactly one entry to drop and reorder has a stored order to
           move. -->
      <ul class="flex flex-col" data-testid="recipe-kit-edit-list">
        {#each kit as entry, i (i)}
          <li
            class="flex items-center gap-2 border-b border-border py-1.5 text-sm last:border-b-0"
            data-testid="recipe-kit-edit-row"
          >
            <div class="flex h-10 w-10 shrink-0 items-center justify-center">
              {#if kitIconFor(entry)}
                <CanonIcon
                  thumbnail={kitIconFor(entry)}
                  version={kitIconVersionFor(entry)}
                  name={entry.label}
                  size={40}
                />
              {/if}
            </div>
            <div class="min-w-0 flex-1">
              <Combobox
                items={rowItems(entry)}
                value={rowValue(entry)}
                onValueChange={(v) => chooseRow(i, v)}
                placeholder="What is it?"
                allowCustom
              >
                <ComboboxField>
                  <ComboboxInput aria-label="Equipment" data-testid="recipe-edit-kit-field" />
                  <ComboboxTrigger />
                </ComboboxField>
                <ComboboxContent>
                  {#snippet children({ filteredItems, showCreate })}
                    {#each filteredItems as cbItem, ci (cbItem.value)}
                      <ComboboxItem item={cbItem} index={ci} />
                    {/each}
                    {#if showCreate}
                      <!-- Anything not on any of the three lists is still a real
                           piece of kit. Nothing is minted by this — the words go
                           on the recipe and nowhere else — so it does not say
                           "Create". -->
                      <ComboboxCreate>Use these words</ComboboxCreate>
                    {/if}
                    {#if filteredItems.length === 0 && !showCreate}
                      <ComboboxEmpty>Nothing matches.</ComboboxEmpty>
                    {/if}
                  {/snippet}
                </ComboboxContent>
              </Combobox>
            </div>
            <span class="flex shrink-0 items-start gap-1" data-testid="recipe-edit-kit-tools">
              <ReorderControl items={kit} index={i} noun="equipment" onReorder={reorderRows} />
              <Button
                variant="ghost"
                size="sm"
                onclick={() => removeRow(i)}
                aria-label="Remove equipment"
                data-testid="recipe-edit-kit-remove"
              >
                <Icon name="Trash2" size={16} />
              </Button>
            </span>
          </li>
        {/each}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        onclick={addRow}
        class="mt-2 self-start"
        data-testid="recipe-edit-kit-add"
      >
        {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
        Add equipment
      </Button>
    {:else}
      <ul class="flex flex-col" data-testid="recipe-kit-list">
        {#each kitGroups as group (group.entry.label)}
          <li
            class="flex items-center gap-2 border-b border-border py-1.5 text-sm last:border-b-0"
            data-testid="recipe-kit-row"
          >
            <div class="flex h-10 w-10 shrink-0 items-center justify-center">
              {#if kitIconFor(group.entry)}
                <CanonIcon
                  thumbnail={kitIconFor(group.entry)}
                  version={kitIconVersionFor(group.entry)}
                  name={group.entry.label}
                  size={40}
                />
              {/if}
            </div>
            <!-- A row with no picture is TAPPABLE, and only that row (issue #1465,
                 Phase 3). The miss is noticed here, so the fix is offered here; a
                 row that already has a picture has nothing to ask, and making the
                 whole list tappable would put a control on every line to serve the
                 few that need one. The empty gutter above is still the empty
                 gutter — the button is the words, so nothing appears where #882
                 says no tile may be drawn.

                 The whole branch is inside the read arm of `{#if editing}`, which
                 is how the row's tap gives way to "change this" while editing,
                 exactly as the ingredient row's inspect tap does. -->
            {#if kitIconFor(group.entry)}
              <span class="min-w-0 flex-1"
                >{sentenceCase(group.entry.label)}{#if group.accessories.length > 0}<span
                    class="block text-xs text-muted-foreground"
                    data-testid="recipe-kit-accessories">{accessoryTail(group.accessories)}</span
                  >{/if}</span
              >
            {:else}
              <button
                type="button"
                class="min-w-0 flex-1 text-left underline decoration-dotted decoration-muted-foreground underline-offset-4"
                onclick={() => onPicture(group.entry.label)}
                data-testid="recipe-kit-picture-btn"
                >{sentenceCase(group.entry.label)}{#if group.accessories.length > 0}<span
                    class="block text-xs text-muted-foreground no-underline"
                    data-testid="recipe-kit-accessories">{accessoryTail(group.accessories)}</span
                  >{/if}</button
              >
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </CardContent>
</Card>
