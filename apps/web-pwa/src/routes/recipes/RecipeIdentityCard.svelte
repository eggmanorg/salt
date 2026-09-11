<script lang="ts">
  import {
    Button,
    Card,
    CardContent,
    Chip,
    Icon,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Textarea,
    TextField,
    valueChipVariants,
    type ChipTone,
    type IconName,
  } from '@salt/ui-components';
  import {
    isCookable,
    memberFirstName,
    normaliseTags,
    recipePhaseTotals,
    type Recipe,
  } from '@salt/domain';
  import { canonItems } from '../../lib/canonService.js';
  import { recipes } from '../../lib/recipeService.js';
  import { kindOf } from './recipeKind.js';
  import EditableZone from './EditableZone.svelte';
  import RecipePhaseTimeline from './RecipePhaseTimeline.svelte';

  /**
   * The identity card: everything the recipe page says about the dish before its
   * ingredients — description, the fact chips, the tags, the phase timeline and
   * the link to where it came from.
   *
   * Extracted from `RecipeViewPage.svelte` by issue #1324, which needed most of
   * it editable in place and could not put that in a 3,600-line file. Page-local
   * on purpose: one consumer, and a design-system primitive would need a ui-spec
   * amendment first.
   *
   * Each editor here writes through `onEdit` as you type and holds its own DRAFT
   * while open. That is what settles #1319's concurrent-change question: an open
   * input is never bound to the store, so a snapshot arriving from another device
   * — or from a chat amendment applied in the docked pane — cannot yank text out
   * from under the cursor. The incoming change lands in the store as usual and is
   * read the moment the field is closed, which is also the moment it could no
   * longer surprise anybody mid-word.
   *
   * The three FACT pills are read-only here, in both modes, exactly as they
   * render on the page today; #1324's Phase 4 is what makes them editable.
   */
  let {
    recipe,
    editing,
    onEdit,
    scaling,
    servingsOptions,
    setServings,
  }: {
    recipe: Recipe;
    editing: boolean;
    /** Called with the whole next recipe. The page decides how it is written. */
    onEdit: (next: Recipe) => void;
    /**
     * The page's read-mode scaling state (issue #1314/#1317), or `null` when this
     * recipe has no usable stated count. Threaded in rather than derived here:
     * the number being read lives in the URL and nowhere else, which is the
     * page's business — `servingsParam.ts` argues why.
     */
    scaling: { base: number; active: number } | null;
    servingsOptions: (base: number, active: number) => number[];
    setServings: (next: number, base: number) => void;
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
  // The one EXCEPTION is Serves, and it is deliberate (issue #1314): since the
  // pill became a control it renders as the value-chip SURFACE worn by a
  // `SelectTrigger` (ui-spec-v09 §8.27) rather than as a sage `Chip
  // variant="fact"`. It therefore carries the value chip's own treatment —
  // bordered, on `bg-background` — and no tint at all. That difference is the
  // honest part: every other pill in this row is a measurement you can only
  // read, and a control that looked identical to them would be undiscoverable.
  // `Chip variant="fact"` renders a `<span>` and §8.23.8 closed the door on making
  // it pressable; nothing shared changes here.
  interface RecipeFact {
    readonly key: string;
    /** Absent only for the one fact with no honest glyph — see `attribution` above. */
    readonly icon?: IconName;
    readonly label: string;
    /** Which kind of fact this is. See the tint note above. */
    readonly tone?: ChipTone;
    /** Only the two facts an e2e spec names carry one. */
    readonly testId?: string;
  }

  // The phase strip (issue #1122), ungated as of issue #1213 — the strip is now
  // the whole of a recipe's timing on this page and there is nothing left to fall
  // back to.
  //
  // `metadata.phases` is optional on the schema, so it is resolved to a list once,
  // here, and everything below reads that list — the template never asks the recipe
  // for it again. `recipePhaseTotals` then sums exactly what is drawn, and it is the
  // only permitted source of a duration (docs/recipe-module.md's single funnel).
  //
  // It is declared ABOVE `facts` because the card's gate reads it: a recipe whose
  // only stated fact is its timing still has something to say in that card.
  const phases = $derived(recipe.metadata.phases ?? []);
  const phaseTotals = $derived(recipePhaseTotals(phases));

  const facts = $derived.by((): RecipeFact[] => {
    const out: RecipeFact[] = [];
    // What the dish makes leads: it is the fact that says what this document IS
    // when the document is a component of something else.
    if (producesCanonName) {
      out.push({
        key: 'produces',
        icon: 'Soup',
        label: `Makes: ${producesCanonName}`,
        tone: 'secondary',
        testId: 'recipe-produces-chip',
      });
    }
    // Serves / Prep / Cook / Total are COOKING facts. An outing has none of
    // them, and gating here covers the chips and, through this card's own gate,
    // the card.
    if (isCookable(kindOf(recipe))) {
      const m = recipe.metadata;
      if (m.servings !== null) {
        out.push({
          key: 'servings',
          icon: 'Users',
          // The number being READ, which is the stored one until somebody changes
          // it. `metadata.servings` itself is never touched by scaling.
          label: `Serves ${scaling?.active ?? m.servings}`,
          tone: 'secondary',
        });
      }
      // No timing chip of any kind. Prep / Cook / Total were retired here by issue
      // #1213, and nothing phase-derived takes their place: the timeline a few lines
      // below states its own total, and a chip repeating it is #1122's own complaint
      // — two accounts of the same fact side by side — at a smaller scale.
    }
    // Provenance is a fact about the document rather than about the dish, and it
    // is the one fact with no honest glyph — `Users` is already Serves, and a
    // pencil would say "edited" for a chip that usually says "added". It sits in
    // the fact row without an icon rather than being promoted to a row of its
    // own for one pill. Its text is asserted verbatim by
    // `e2e/recipe-author-filter.spec.ts`, so nothing may be interpolated into it.
    if (attribution) {
      out.push({ key: 'attribution', label: attribution, testId: 'recipe-attribution-chip' });
    }
    return out;
  });

  // The card is gated on having something to say — but never while editing, when
  // its whole job is to offer the slots this recipe has never filled in. The read
  // half of this condition is the page's own, moved here unchanged.
  const hasContent = $derived(
    Boolean(recipe.description) ||
      facts.length > 0 ||
      recipe.metadata.tags.length > 0 ||
      Boolean(sourceUrl) ||
      phaseTotals.hasPhases,
  );

  // ─── Editors ────────────────────────────────────────────────────────────────
  // Each holds a draft seeded when its zone opens and writes through on input.
  // `recipe` is read INSIDE each handler, so every edit composes the newest
  // document rather than one captured when the editor mounted.

  let descriptionDraft = $state('');
  let sourceDraft = $state('');
  let tagInput = $state('');

  function setDescription(value: string): void {
    descriptionDraft = value;
    onEdit({ ...recipe, description: value.trim() === '' ? null : value });
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
           narrow screen, where a single row would interleave them again.

           READ-ONLY in BOTH modes, deliberately: the three pills become editable
           in #1324's Phase 4, which is also what gives the Serves pill its second
           identity. This block moved here from the page unaltered. -->
      {#if facts.length > 0}
        <div class="flex flex-wrap items-center gap-2">
          {#each facts as fact (fact.key)}
            {#if fact.key === 'servings' && scaling}
              <!-- The one fact that is also a control (issue #1314). The
                   value-chip SURFACE worn by the `SelectTrigger` that owns
                   the interaction — ui-spec-v09 §8.27.4's exact shape, the
                   same one the catalog's review row wears, down to the
                   width-setting wrapper the surface deliberately does not
                   provide. It is NOT a `Chip`: §8.23.8 renders `fact` as a
                   `<span>` and closed off making one pressable, and a
                   button inside a chip inside a button is the shape that
                   rule exists to prevent.
                   The pill shows no label of its own, so the accessible
                   name comes from `aria-label` (§8.27.6). -->
              <div class="w-32">
                <Select
                  value={String(scaling.active)}
                  onValueChange={(v) => setServings(Number(v), scaling.base)}
                >
                  <SelectTrigger
                    class={valueChipVariants()}
                    aria-label="How many this recipe is shown for"
                    data-testid="recipe-servings-chip"
                  >
                    <span class="flex items-center gap-1.5">
                      <Icon name="Users" size={12} />
                      {fact.label}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {#each servingsOptions(scaling.base, scaling.active) as option (option)}
                      <SelectItem
                        value={String(option)}
                        label={option === scaling.base ? `${option} (as written)` : String(option)}
                      />
                    {/each}
                  </SelectContent>
                </Select>
              </div>
            {:else}
              <Chip
                variant="fact"
                tone={fact.tone ?? 'neutral'}
                icon={fact.icon}
                data-testid={fact.testId}
              >
                {fact.label}
              </Chip>
            {/if}
          {/each}
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
          <div class="flex w-full flex-col gap-1.5">
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
              <Button variant="ghost" size="sm" onclick={close} data-testid="recipe-tags-done">
                Done
              </Button>
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
           graphic on this page — the #878 ribbon it used to sit above is gone,
           along with the Prep/Cook/Total chips.
           Everything drawn and every figure shown is derived inside the
           component from this list — nothing is passed in pre-summed.
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
