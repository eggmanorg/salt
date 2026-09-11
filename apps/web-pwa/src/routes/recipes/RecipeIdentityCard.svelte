<script lang="ts">
  import {
    Button,
    Card,
    CardContent,
    Chip,
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    ComboboxTrigger,
    Icon,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Textarea,
    TextField,
    type ComboboxItemType,
  } from '@salt/ui-components';
  import {
    isCookable,
    memberFirstName,
    normaliseTags,
    recipePhaseTotals,
    type Recipe,
  } from '@salt/domain';
  import { canonItems } from '../../lib/canonService.js';
  import { people } from '../../lib/membersService.js';
  import { recipes } from '../../lib/recipeService.js';
  import { kindOf } from './recipeKind.js';
  import EditableZone from './EditableZone.svelte';
  import RecipePhaseTimeline from './RecipePhaseTimeline.svelte';

  /**
   * The identity card: everything the recipe page says about the dish before its
   * ingredients — description, the fact chips, the tags, the phase timeline and
   * the link to where it came from.
   *
   * Extracted from `RecipeViewPage.svelte` by issue #1319, which needed all of it
   * editable in place and could not put that in a 3,300-line file. Page-local on
   * purpose: one consumer, and a design-system primitive would need a ui-spec
   * amendment first.
   *
   * Every editor here writes through `onEdit` as you type and holds its own DRAFT
   * while open. That is what settles #1319's concurrent-change question: an open
   * input is never bound to the store, so a snapshot arriving from another device
   * — or from a chat amendment applied in the docked pane — cannot yank text out
   * from under the cursor. The incoming change lands in the store as usual and is
   * read the moment the field is closed, which is also the moment it could no
   * longer surprise anybody mid-word.
   */
  let {
    recipe,
    editing,
    onEdit,
  }: {
    recipe: Recipe;
    editing: boolean;
    /** Called with the whole next recipe. The page decides how it is written. */
    onEdit: (next: Recipe) => void;
  } = $props();

  // Outbound link to the original recipe, only for url-sourced (imported) recipes
  // with a non-empty url. Manual/legacy recipes (source null) render nothing.
  const sourceUrl = $derived(
    recipe.source?.type === 'url' && (recipe.source.url ?? '').trim() !== ''
      ? recipe.source.url!
      : null,
  );

  // "Makes: <name>" chip — resolve the produces canon link to its display name.
  // null when the recipe isn't linked or the canon item has since been deleted.
  const producesCanonName = $derived(
    recipe.producesCanonId
      ? ($canonItems.find((c) => c.id === recipe.producesCanonId)?.name ?? null)
      : null,
  );

  // "Added by X · edited by Y" chip (issue #845). Audit only: it records who did
  // what and gates nothing. `null` — and so no chip at all, rather than a
  // placeholder — whenever there is no attribution on record, which is every
  // recipe written before the field existed. A `lastEditedBy` that is the creator
  // (they added it and they are still the only one to have touched it) adds
  // nothing to read, so only a DIFFERENT last editor earns the second half.
  //
  // First names on screen, full names in the comparison. The stored value is the
  // verbatim `Member.name`, and `memberFirstName` shortens it only for reading — a
  // household shares a surname, so the rest is noise. The "is this the same
  // person" test deliberately stays on the FULL values: comparing first names
  // would silently merge two genuinely different people who share one.
  const attribution = $derived(
    !recipe.createdBy
      ? null
      : recipe.lastEditedBy && recipe.lastEditedBy !== recipe.createdBy
        ? `Added by ${memberFirstName(recipe.createdBy)} · edited by ${memberFirstName(recipe.lastEditedBy)}`
        : `Added by ${memberFirstName(recipe.createdBy)}`,
  );

  // ─── Facts, and why they are not tags (issue #878) ──────────────────────────
  // Six different things used to render as the same grey pill: what the dish
  // makes, how many it serves, three durations, who added it, and every tag on
  // it. Two of those are different KINDS of thing. A fact is measured from the
  // dish — you can check it — and gets a glyph that carries its meaning before
  // the number is read. A tag is an arbitrary word somebody typed, and any icon
  // beside it would be a guess (ui-spec-v09 §8.23.8). So: facts on a tinted
  // ground with an icon, tags as quiet outlines with none, on their own rows.
  //
  // ── What the tint means here ────────────────────────────────────────────────
  // `Chip`'s `tone` is named for a palette role and says nothing about what the
  // hue means (ui-spec-v09 §8.23.9) — deciding that is this page's job, and this
  // is where it is written down. The tint splits the row by what each fact
  // measures:
  //
  //   sage      what comes OUT of it — Makes, Serves. The palette's "fresh /
  //             organic" accent (design.md), and already this page's colour for
  //             a part of something: the ingredient group headings below, and a
  //             matched pictogram tile.
  //   neutral   anything that is not that: who added the recipe, which is a fact
  //             about the document rather than about the dish.
  //
  // The row used to carry three durations on three further tints; issue #1213
  // retired them and the phase timeline below states the timing instead. One tint
  // and a default is not an impoverished version of that scheme — a row where
  // every chip is a different colour teaches the reader that the colour carries
  // nothing. And nothing is carried by colour ALONE — every chip says its own kind
  // in words, so the tint only lets the row be scanned instead of read
  // (ui-spec-v02 §7).
  //
  // Since #1319 the three facts are three zones rather than one derived list. The
  // ROW is what became editable, never the chip: ui-spec-v09 §8.23.8 is explicit
  // that `fact` and `tag` render a span and not a button with its handler
  // omitted, so the pencil sits beside the chip and `Chip` is untouched.

  // The phase strip (issue #1122), ungated as of issue #1213 — the strip is now
  // the whole of a recipe's timing on this page and there is nothing left to fall
  // back to.
  //
  // `metadata.phases` is optional on the schema, so it is resolved to a list once,
  // here. `recipePhaseTotals` then sums exactly what is drawn, and it is the only
  // permitted source of a duration (docs/recipe-module.md's single funnel).
  const phases = $derived(recipe.metadata.phases ?? []);
  const phaseTotals = $derived(recipePhaseTotals(phases));

  // What this entry can do (issue #637) — never a comparison against the kind.
  const showCooking = $derived(isCookable(kindOf(recipe)));
  const hasServings = $derived(showCooking && recipe.metadata.servings !== null);

  const hasFacts = $derived(Boolean(producesCanonName) || hasServings || Boolean(attribution));

  // Both chips are resolved to strings HERE rather than interpolated from a
  // nullable inside the snippet that only renders when they are set: an inline
  // `{maybeNull}` compiles to a fallback no test could ever reach.
  const producesLabel = $derived(`Makes: ${producesCanonName ?? ''}`);
  const servesLabel = $derived(`Serves ${recipe.metadata.servings ?? ''}`);

  // The card is gated on having something to say — but never while editing, when
  // its whole job is to offer the slots this recipe has never filled in.
  const hasContent = $derived(
    Boolean(recipe.description) ||
      hasFacts ||
      recipe.metadata.tags.length > 0 ||
      Boolean(sourceUrl) ||
      phaseTotals.hasPhases,
  );

  // ─── Editors ────────────────────────────────────────────────────────────────
  // Each holds a draft seeded when its zone opens and writes through on input.
  // `recipe` is read INSIDE each handler, so every edit composes the newest
  // document rather than one captured when the editor mounted.

  let descriptionDraft = $state('');
  let servingsDraft = $state('');
  let sourceDraft = $state('');
  let tagInput = $state('');

  function setDescription(value: string): void {
    descriptionDraft = value;
    onEdit({ ...recipe, description: value.trim() === '' ? null : value });
  }

  // An empty or non-numeric servings box means "not stated", which is `null` —
  // the schema's absent value, and what the read card tests for. Zero is not a
  // serving count, so it is absent too.
  function setServings(value: string): void {
    servingsDraft = value;
    const n = Number.parseInt(value, 10);
    const servings = Number.isFinite(n) && n > 0 ? n : null;
    onEdit({ ...recipe, metadata: { ...recipe.metadata, servings } });
  }

  // An empty url clears the source entirely (back to a manual recipe); a
  // non-empty one marks it url-sourced. The same rule the retired editor applied.
  function setSourceUrl(value: string): void {
    sourceDraft = value;
    const trimmed = value.trim();
    onEdit({ ...recipe, source: trimmed === '' ? null : { type: 'url', url: trimmed } });
  }

  // ─── Tags ───────────────────────────────────────────────────────────────────
  const allExistingTags = $derived([...new Set($recipes.flatMap((r) => r.metadata.tags))].sort());
  const availableSuggestions = $derived(
    allExistingTags.filter((t) => !recipe.metadata.tags.includes(t)),
  );

  // Tag normalisation is `@salt/domain`'s `normaliseTags` (issue #1054) — the
  // same rule the recipe-authoring flows apply to what the model emits. One raw
  // string can yield more than one tag, because the rule splits on commas.
  function addTag(raw: string): void {
    const fresh = normaliseTags([raw]).filter((t) => !recipe.metadata.tags.includes(t));
    if (fresh.length > 0) {
      onEdit({
        ...recipe,
        metadata: { ...recipe.metadata, tags: [...recipe.metadata.tags, ...fresh] },
      });
    }
    tagInput = '';
  }

  function removeTag(tag: string): void {
    onEdit({
      ...recipe,
      metadata: { ...recipe.metadata, tags: recipe.metadata.tags.filter((t) => t !== tag) },
    });
  }

  function handleTagKeydown(e: KeyboardEvent, close: () => void): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (tagInput.trim()) addTag(tagInput);
    } else if (e.key === 'Backspace' && !tagInput && recipe.metadata.tags.length > 0) {
      removeTag(recipe.metadata.tags[recipe.metadata.tags.length - 1]!);
    } else if (e.key === 'Escape') {
      close();
    }
  }

  // ─── "Added by" (issue #845) ────────────────────────────────────────────────
  // The one attribution field a person may set. `createdBy` holds a snapshot of
  // `Member.name`, and every recipe that predates the field got its name from a
  // backfill that could only GUESS — so the record can be wrong, and this is
  // where it is put right.
  //
  // Pick-from-roster, never free text: the list's "Added by me" chip compares
  // with `===` against `Member.name`, so a typo would silently stop matching.
  // `lastEditedBy` deliberately gets no control at all — a field recording the
  // last edit that you can type into contradicts itself. And none of it gates
  // anything: attribution is a record, not a permission.
  //
  // `$people`, never `$members` (issue #1300): this is a people-picker, so a
  // system account is not offered. A recipe ALREADY stamped with one keeps its
  // name — it arrives through `recipe.createdBy` below, the same path an
  // off-roster name takes. Nothing to pick from is not a control, so an empty
  // roster (still loading, or a permission-denied stream) offers no slot at all.
  const rosterNames = $derived($people.map((m) => m.name));
  const authorOptions = $derived([
    ...new Set(recipe.createdBy ? [...rosterNames, recipe.createdBy] : rosterNames),
  ]);
  const showAddedBy = $derived(authorOptions.length > 0);

  // ─── "This recipe makes…" (produces canon link) ─────────────────────────────
  // A searchable picker over the canon store: link this recipe to the grocery
  // item it produces (e.g. a Mayonnaise recipe makes "Mayonnaise"), or clear it.
  // The filter also matches synonyms via a lowercased name+synonyms index.
  const canonComboItems: ComboboxItemType[] = $derived(
    $canonItems.map((c) => ({ value: c.id, label: c.name })),
  );
  const canonSearchIndex = $derived(
    new Map($canonItems.map((c) => [c.id, [c.name, ...c.synonyms].join(' ').toLowerCase()])),
  );
  function canonFilter(input: string, item: ComboboxItemType): boolean {
    const hay = canonSearchIndex.get(item.value) ?? item.label.toLowerCase();
    return hay.includes(input.trim().toLowerCase());
  }
</script>

<!-- Description, facts, tags, the phase strip and the source link.
     `phaseTotals.hasPhases` joins the card's gate rather than sitting outside it:
     a recipe whose only stated fact is its timing still has something to say here
     (issue #1122). Read through `recipePhaseTotals` rather than `phases.length` —
     the single funnel docs/recipe-module.md names (issue #1122 review,
     should-fix 6). While editing, the card is always there: an empty one is the
     offer of every slot this recipe has never filled in. -->
{#if hasContent || editing}
  <Card>
    <CardContent class="flex flex-col gap-3 p-4">
      <EditableZone
        {editing}
        filled={Boolean(recipe.description)}
        label="Edit description"
        slotLabel="Description"
        testId="recipe-edit-description"
        onOpen={() => (descriptionDraft = recipe.description ?? '')}
      >
        {#snippet view()}
          <p class="text-sm text-muted-foreground">{recipe.description}</p>
        {/snippet}
        {#snippet edit(close)}
          <Textarea
            label="Description"
            placeholder="A short description"
            value={descriptionDraft}
            onValueChange={setDescription}
            onblur={close}
            rows={2}
            autoresize
            data-testid="recipe-description-input"
          />
        {/snippet}
      </EditableZone>

      <!-- Two rows, two kinds of thing (issue #878). Facts are measured from the
           dish and carry a glyph; tags are words somebody typed and carry none.
           Separate rows rather than one wrapped row so the difference survives a
           narrow screen, where a single row would interleave them again. -->
      {#if hasFacts || editing}
        <div class="flex flex-wrap items-center gap-2">
          <EditableZone
            {editing}
            filled={Boolean(producesCanonName)}
            label="Edit what this recipe makes"
            slotLabel="Makes"
            testId="recipe-edit-produces"
          >
            {#snippet view()}
              <Chip variant="fact" tone="secondary" icon="Soup" data-testid="recipe-produces-chip">
                {producesLabel}
              </Chip>
            {/snippet}
            {#snippet edit(close)}
              <div class="flex w-full items-center gap-2" data-testid="recipe-produces">
                <div class="relative flex-1">
                  <Combobox
                    items={canonComboItems}
                    value={recipe.producesCanonId ?? ''}
                    filterFn={canonFilter}
                    restrict
                    placeholder="Search grocery items…"
                    onValueChange={(canonId) => onEdit({ ...recipe, producesCanonId: canonId })}
                  >
                    <ComboboxField>
                      <ComboboxInput />
                      <ComboboxTrigger />
                    </ComboboxField>
                    <ComboboxContent>
                      {#snippet children({ filteredItems })}
                        {#each filteredItems as item, i (item.value)}
                          <ComboboxItem {item} index={i} />
                        {/each}
                        {#if filteredItems.length === 0}
                          <ComboboxEmpty>No grocery items found</ComboboxEmpty>
                        {/if}
                      {/snippet}
                    </ComboboxContent>
                  </Combobox>
                </div>
                {#if recipe.producesCanonId}
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => onEdit({ ...recipe, producesCanonId: null })}
                    data-testid="recipe-produces-clear"
                  >
                    Clear
                  </Button>
                {/if}
                <Button variant="ghost" size="sm" onclick={close}>Done</Button>
              </div>
            {/snippet}
          </EditableZone>

          {#if showCooking}
            <EditableZone
              {editing}
              filled={hasServings}
              label="Edit servings"
              slotLabel="Servings"
              testId="recipe-edit-servings"
              onOpen={() =>
                (servingsDraft =
                  recipe.metadata.servings === null ? '' : String(recipe.metadata.servings))}
            >
              {#snippet view()}
                <Chip variant="fact" tone="secondary" icon="Users">{servesLabel}</Chip>
              {/snippet}
              {#snippet edit(close)}
                <TextField
                  label="Servings"
                  inputmode="numeric"
                  class="w-28"
                  value={servingsDraft}
                  onValueChange={setServings}
                  onblur={close}
                  data-testid="recipe-servings-input"
                />
              {/snippet}
            </EditableZone>
          {/if}

          <EditableZone
            editing={editing && showAddedBy}
            filled={Boolean(attribution)}
            label="Edit who added this"
            slotLabel="Added by"
            testId="recipe-edit-added-by"
          >
            {#snippet view()}
              <Chip variant="fact" data-testid="recipe-attribution-chip">{attribution}</Chip>
            {/snippet}
            {#snippet edit(close)}
              <div class="flex w-full items-center gap-2" data-testid="recipe-added-by">
                <Select
                  value={recipe.createdBy}
                  onValueChange={(v) => onEdit({ ...recipe, createdBy: v })}
                >
                  <!-- The label is rendered here rather than left to the
                         trigger's default, as everywhere else in the app:
                         `SelectItem`s only exist while the listbox is open, so a
                         closed Select has no registered item to resolve
                         `displayLabel` from. -->
                  <SelectTrigger aria-label="Added by" data-testid="recipe-added-by-select">
                    <span class={recipe.createdBy ? 'text-foreground' : 'text-placeholder italic'}>
                      {recipe.createdBy ? memberFirstName(recipe.createdBy) : 'Not recorded'}
                    </span>
                    <Icon name="ChevronDown" size={16} class="text-muted-foreground" />
                  </SelectTrigger>
                  <SelectContent>
                    <!-- `value` and the key stay the VERBATIM `Member.name`;
                           only the label is shortened. Shortening the identity
                           would collapse two different people into one option. -->
                    {#each authorOptions as name (name)}
                      <SelectItem value={name}>{memberFirstName(name)}</SelectItem>
                    {/each}
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="sm" onclick={close}>Done</Button>
              </div>
            {/snippet}
          </EditableZone>
        </div>
      {/if}

      <!-- No leading `#`. The hash was doing the job the outline now does —
           saying "this is a tag, not a fact" — back when a tag and a fact were
           the same grey pill and the punctuation was the only thing telling them
           apart. With the two kinds visibly different it is just a character in
           front of every word, and "summer" reads better than "#summer" on a page
           about dinner. -->
      <EditableZone
        {editing}
        filled={recipe.metadata.tags.length > 0}
        label="Edit tags"
        slotLabel="Tags"
        testId="recipe-edit-tags"
        onOpen={() => (tagInput = '')}
      >
        {#snippet view()}
          <div class="flex flex-wrap items-center gap-2">
            {#each recipe.metadata.tags as tag (tag)}
              <Chip variant="tag">{tag}</Chip>
            {/each}
          </div>
        {/snippet}
        {#snippet edit(close)}
          <div class="flex flex-col gap-1.5">
            <div
              class="salt-focus-ring-within flex min-h-9 flex-wrap items-center gap-1.5 rounded border border-input bg-background px-3 py-1.5"
            >
              {#each recipe.metadata.tags as tag (tag)}
                <span
                  class="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-medium"
                >
                  {tag}
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground"
                    onclick={() => removeTag(tag)}
                    aria-label="Remove {tag}"
                  >
                    <Icon name="X" size={10} />
                  </button>
                </span>
              {/each}
              <input
                type="text"
                class="min-w-24 flex-1 bg-transparent py-0.5 text-sm outline-none"
                placeholder={recipe.metadata.tags.length === 0 ? 'Add tags…' : ''}
                bind:value={tagInput}
                onkeydown={(e) => handleTagKeydown(e, close)}
                data-testid="recipe-tags-input"
              />
              <Button variant="ghost" size="sm" onclick={close}>Done</Button>
            </div>
            {#if availableSuggestions.length > 0}
              <div class="flex flex-wrap gap-1.5">
                {#each availableSuggestions as tag (tag)}
                  <button
                    type="button"
                    class="rounded border border-dashed border-muted-foreground/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
                    onclick={() => addTag(tag)}
                  >
                    + {tag}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/snippet}
      </EditableZone>

      <!-- The planning timeline (issue #1122), and as of #1213 the only timing
           graphic on this page. Everything drawn and every figure shown is derived
           inside the component from this list — nothing is passed in pre-summed.
           Still read-only here; the phase strip becomes editable in its own right
           with the rest of the recipe body. -->
      {#if phaseTotals.hasPhases}
        <RecipePhaseTimeline {phases} timingSummary={recipe.metadata.timingSummary ?? null} />
      {/if}

      <EditableZone
        {editing}
        filled={Boolean(sourceUrl)}
        label="Edit source link"
        slotLabel="Source link"
        testId="recipe-edit-source"
        onOpen={() => (sourceDraft = sourceUrl ?? '')}
      >
        {#snippet view()}
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1.5 self-start text-sm text-primary hover:underline"
            data-testid="recipe-source-link"
          >
            <Icon name="ExternalLink" size={14} />
            View original recipe
          </a>
        {/snippet}
        {#snippet edit(close)}
          <TextField
            label="Source URL"
            type="url"
            placeholder="https://example.com/original-recipe"
            value={sourceDraft}
            onValueChange={setSourceUrl}
            onblur={close}
            data-testid="recipe-source-input"
          />
        {/snippet}
      </EditableZone>
    </CardContent>
  </Card>
{/if}
