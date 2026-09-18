<script lang="ts">
  import {
    Button,
    CanonIcon,
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    ComboboxTrigger,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '@salt/ui-components';
  import { push } from 'svelte-spa-router';
  import {
    isCanonIconRenderable,
    resolveKitEntryItem,
    suggestKitchenToolParent,
  } from '@salt/domain';
  import { sentenceCase } from '../../lib/sentenceCase.js';
  import type { BorrowedPictureDoc, KitchenToolDoc, RecipeKitEntryDoc } from '@salt/domain/schemas';
  import { equipment, equipmentIcons, setBorrowedPictureFor } from '../../lib/equipmentService.js';
  import {
    kitchenTools,
    toolPicture,
    addKitchenTool,
    addKitchenToolMatcher,
  } from '../../lib/kitchenToolService.js';
  import { addToast } from '../../lib/toastStore.js';

  // Give a pictureless kit row a picture, from the recipe you noticed it on
  // (issue #1465, Phase 3).
  //
  // WHY HERE AND NOT IN ADMIN. This overturns #1458's rejection of "a per-recipe
  // one-tap add at the point of the miss", and Daniel's reason is that the miss is
  // NOTICED on the recipe: sending the person to an admin page is the friction
  // that leaves gaps open for months. #1458's own concern — one-row-at-a-time
  // minting is how #956's near-duplicates arose — is answered by ORDER rather than
  // by removal. Salt's suggested existing tool leads (`suggestKitchenToolParent`,
  // built for exactly this), the searchable list of drawings that already exist
  // comes next, and "draw a new one" sits underneath both. #1458's review surface
  // stays useful as the place the whole set is visible at once.
  //
  // ─── TWO ROWS, TWO DIFFERENT ACTS, and conflating them is the trap ──────────
  // A row that RESOLVES TO one of your things — through `resolveKitEntryItem`,
  // the recorded link or, absent one, the words — is an identity: "this Tefal
  // 28cm looks like the generic frying pan" is a fact about the pan, written
  // onto the manifest as a BORROWED PICTURE — a reference, so redrawing the
  // source reaches every pan borrowing it. That includes a row with no recorded
  // link at all whose label already names one of your things by words — every
  // unlinked stored recipe reaches this dialog that way until Phase 4 re-runs
  // them — because `resolveKitEntryItem` is the exact function `kitIcons.ts`
  // renders through, and a row this dialog opened on "no picture" cannot be
  // answered by a different, narrower question than the one that put it here.
  //
  // A row that resolves to nothing is ORDINARY WORDS, and words are vocabulary:
  // "this 'heatproof bowl' means the mixing bowl you already draw" is a MATCHER
  // on the tool, which lights up every recipe that already said those words,
  // with nothing migrated (#882). So the unlinked side offers tools only — an
  // equipment record has no matchers and could not be taught a word.
  //
  // WHAT THIS DOES NOT DO: re-point the recipe's link. "This 'large frying pan' is
  // my Tefal 28cm" is a per-recipe edit of which thing the line MEANS, which is a
  // different act from attaching a picture to a thing, and the issue leaves it out
  // deliberately.

  interface Props {
    open: boolean;
    onClose: () => void;
    entry: RecipeKitEntryDoc;
  }
  let { open, onClose, entry }: Props = $props();

  const items = $derived($equipment?.items ?? []);
  /**
   * Which of the household's things this row names — the link where it has
   * one, the words where it does not — or null for ordinary words. The SAME
   * question `kitIcons.ts` asks to decide what to render, through the same
   * function: a row the strip already draws as "one of your things" (an
   * unlinked recipe whose label resolves by name, which is every stored kit
   * until Phase 4 re-runs it) must take the linked branch here too, or this
   * dialog writes a matcher the renderer never reaches and "draw new" mints a
   * duplicate, instance-named tool (#956).
   */
  const linked = $derived(resolveKitEntryItem(entry, items));

  // Salt's guess, and it leads for the reason #956 exists: minting is two taps
  // and aliasing is a search, so the cheap act has to be the obvious one.
  // Advisory only — `suggestKitchenToolParent` answers null rather than guess when
  // nothing shares the label's head noun, and is filtered here on actually having
  // a drawing, the same filter `drawnTools` applies below: an undrawn tool is a
  // valid alias TARGET on the admin curation queue (`KitchenToolsPage.svelte`,
  // this function's other caller) but a useless one-tap choice here, since
  // choosing it would still resolve to no picture.
  const suggestion = $derived(
    ((): KitchenToolDoc | null => {
      const candidate = suggestKitchenToolParent(entry.label, $kitchenTools);
      return candidate && toolPicture(candidate) !== null ? candidate : null;
    })(),
  );

  /** Every drawing that already exists, as `family:id` choices for the combobox. */
  const drawnTools = $derived($kitchenTools.filter((t) => toolPicture(t) !== null));
  const choices = $derived([
    ...drawnTools.map((t) => ({ value: `kitchenTool:${t.id}`, label: t.label })),
    // Equipment pictures are offered only for one of your own things: they are
    // borrowed by reference, and there is nothing on an equipment record for an
    // ordinary word to be taught.
    ...(linked
      ? items.flatMap((item) => [
          ...(isDrawn(item.id) ? [{ value: `equipment:${item.id}`, label: item.name }] : []),
          ...item.accessories
            .filter((a) => isDrawn(a.id))
            .map((a) => ({ value: `equipment:${a.id}`, label: `${a.name} — ${item.name}` })),
        ])
      : []),
  ]);

  function isDrawn(id: string): boolean {
    const thumbnail = $equipmentIcons.get(id)?.thumbnail ?? null;
    return thumbnail !== null && isCanonIconRenderable(thumbnail);
  }

  let chosen = $state('');
  let busy = $state(false);

  function parseChoice(value: string): BorrowedPictureDoc | null {
    const [family, ...rest] = value.split(':');
    const id = rest.join(':');
    if (!id || (family !== 'equipment' && family !== 'kitchenTool')) return null;
    return { family, id };
  }

  async function useChoice(picture: BorrowedPictureDoc): Promise<void> {
    busy = true;
    const result = linked
      ? await setBorrowedPictureFor(linked.item.id, linked.accessory?.id ?? null, picture)
      : await aliasOntoTool(picture);
    busy = false;
    if (result.kind !== 'ok') {
      addToast("Couldn't set the picture.", 'destructive');
      return;
    }
    addToast('Picture set — every recipe that says this gains it.', 'success');
    onClose();
  }

  /**
   * The unlinked half: teach the chosen TOOL this row's words. Nothing is drawn,
   * which is the whole point — a vocabulary that gains "heatproof bowl" beside
   * "mixing bowl" and draws both is the bloat #956 is about.
   */
  async function aliasOntoTool(picture: BorrowedPictureDoc) {
    const tool = $kitchenTools.find((t) => t.id === picture.id);
    if (!tool) return { kind: 'err' as const, error: { kind: 'NotFound' as const } };
    return addKitchenToolMatcher(tool, entry.label);
  }

  async function handleUseChosen(): Promise<void> {
    const picture = parseChoice(chosen);
    if (picture) await useChoice(picture);
  }

  async function handleUseSuggestion(tool: KitchenToolDoc): Promise<void> {
    await useChoice({ family: 'kitchenTool', id: tool.id });
  }

  /**
   * Draw something new.
   *
   * FOR ONE OF YOUR THINGS this hands over to the equipment record's own page
   * rather than re-hosting the drawing panel here. That page IS #877's
   * read-the-description-then-Draw gate — the item's panel and, since Phase 2,
   * each entry's own dialog — and the issue's "must not touch" list forbids
   * bypassing it. A second host for the same panel would be a second place for
   * the gate to drift out of.
   *
   * FOR ORDINARY WORDS it mints a tool named after them, and
   * `onKitchenToolWritten` draws it. That is the trip to Admin this whole dialog
   * exists to remove.
   */
  async function handleDrawNew(): Promise<void> {
    if (linked) {
      onClose();
      push(`/equipment/${linked.item.id}`);
      return;
    }
    busy = true;
    const label = sentenceCase(entry.label.trim());
    const result = await addKitchenTool({ label, matchers: [] });
    busy = false;
    if (result.kind === 'ok') {
      addToast(`Added ${label}. Drawing its picture…`, 'success');
      onClose();
      return;
    }
    // `createKitchenTool` refuses an identical slug as a `conflict`, not an
    // `err` — it would otherwise replace a curated tool with a blank one — so the
    // two refusals arrive as different Result arms and say different things.
    addToast(
      result.kind === 'conflict'
        ? 'Something with that name is already drawn — choose it above instead.'
        : "Couldn't add it.",
      'destructive',
    );
  }
</script>

<Dialog
  {open}
  onOpenChange={(v) => {
    if (!v) onClose();
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="kit-picture-picker">
      <DialogHeader>
        <DialogTitle>A picture for "{sentenceCase(entry.label)}"</DialogTitle>
        <DialogDescription>
          {#if linked}
            This line is your {linked.accessory?.name ?? linked.item.name}. The picture goes on the
            thing, so every recipe that names it gains the picture too.
          {:else}
            These are ordinary words, so the picture goes on the words — every recipe that says them
            gains it.
          {/if}
        </DialogDescription>
      </DialogHeader>

      {#if suggestion}
        <!-- Salt's guess, first and one tap, because minting is easy and searching
             is not — which is how #956's near-duplicates got in. -->
        <button
          type="button"
          class="flex items-center gap-3 rounded border border-border bg-card px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
          onclick={() => void handleUseSuggestion(suggestion)}
          disabled={busy}
          data-testid="kit-picture-suggestion"
        >
          <CanonIcon
            thumbnail={toolPicture(suggestion)?.thumbnail ?? null}
            version={toolPicture(suggestion)?.version}
            name={suggestion.label}
            size={32}
          />
          <span>Use the <strong>{suggestion.label}</strong></span>
        </button>
      {/if}

      <div class="flex flex-col gap-2" data-testid="kit-picture-choices">
        <span class="text-sm font-medium">Choose an existing picture</span>
        <Combobox
          items={choices}
          value={chosen}
          onValueChange={(v) => (chosen = v)}
          placeholder="Search pictures…"
          restrict
        >
          <ComboboxField>
            <ComboboxInput />
            <ComboboxTrigger />
          </ComboboxField>
          <ComboboxContent>
            {#snippet children({ filteredItems })}
              {#each filteredItems as cbItem, i (cbItem.value)}
                <ComboboxItem item={cbItem} index={i} />
              {/each}
              {#if filteredItems.length === 0}
                <ComboboxEmpty>Nothing drawn matches.</ComboboxEmpty>
              {/if}
            {/snippet}
          </ComboboxContent>
        </Combobox>
        <Button
          onclick={handleUseChosen}
          loading={busy}
          disabled={busy || !chosen}
          data-testid="kit-picture-use-chosen"
        >
          Use this picture
        </Button>
      </div>

      <DialogFooter>
        <Button variant="outline" onclick={onClose} disabled={busy}>Cancel</Button>
        <Button
          variant="outline"
          onclick={handleDrawNew}
          disabled={busy}
          data-testid="kit-picture-draw-new"
        >
          {linked ? 'Draw one for it…' : 'Draw a new one'}
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>
