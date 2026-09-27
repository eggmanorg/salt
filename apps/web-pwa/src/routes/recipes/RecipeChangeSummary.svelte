<script lang="ts">
  import {
    Button,
    Icon,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
  } from '@salt/ui-components';
  import { diffWords, phaseElapsedMinutes, unchangedRatio } from '@salt/domain';
  import type { DiffPart, RecipePhase } from '@salt/domain';
  import type { NullableStringChange, RecipeDiff } from '@salt/domain';
  import type { StepTimerDoc } from '@salt/domain/schemas';
  import { formatMinutes } from '../../lib/durationDisplay.js';

  // Review-and-approve gate for an AI-chef recipe edit. Renders the pure
  // `RecipeDiff` produced by `diffRecipe` as a DIFF: one card per change,
  // grouped into the same five sections, each chipped with what kind of change
  // it is and labelled with what it applies to. Two choices only: Apply (commit
  // the merge + save, owned by the caller via `onApply`) or Discard / keep
  // chatting (drop the proposal, no write). A diff that draws no card at all
  // shows "No changes" with nothing to apply — decided from the cards this
  // component actually built (`hasAnyCards` below), not from `diff.hasChanges`:
  // `diffRecipe` can report a change this component is not drawing (the Timing
  // card gated off, or its key-on counterpart), and Apply must never sit next
  // to a blank body (#1216). Self-contained review sheet; both edit surfaces
  // (chat page + recipe-view sidebar) reuse it so the review UX is identical.
  //
  // It replaced a flat list that drew every edit as the whole old value, an
  // arrow, and the whole new value: on a real house-rules refresh that came to
  // 31 rows and 4,264 characters, the worst of them 493 characters of two
  // paragraphs joined by an arrow on a 390px phone. You could not tell
  // "reworded three words" from "replaced the sentence", so the only safe read
  // was to read all of it (issue #825).
  //
  // HOW a change is drawn is derived from the change itself and never chosen per
  // field — there are exactly three renderings, picked by `makeCard` below.
  //
  // From the fold up (the `split:` seam) each card lays its two sides out as
  // Now | Proposed columns under one sticky heading row, so a long list can be
  // skimmed down a single column. That is layout and nothing else: the seam is
  // the CSS variant, no JS media query, and the three renderings above are
  // unchanged by it.
  interface Props {
    diff: RecipeDiff | null;
    open: boolean;
    applying: boolean;
    onApply: () => void;
    onDiscard: () => void;
  }
  let { diff, open = $bindable(), applying, onApply, onDiscard }: Props = $props();

  // ── Rendering thresholds ───────────────────────────────────────────────────
  // Presentation policy, deliberately NOT in the domain: `diffWords` decides what
  // moved, these two decide how it should look. Both were tuned against a real
  // refresh and a real chat amendment on staging data.

  // Where a value stops being a value and starts being prose. Under this on both
  // sides, an edit stays on one line as `750 g → 1.1 kg` — exactly as compact as
  // the flat list it replaced, and no word-level marks to read.
  const SHORT_VALUE_MAX = 42;

  // Where "the same sentence, adjusted" becomes "a different sentence". Below
  // this share of surviving content, interleaving word marks through the passage
  // produces dozens of alternating fragments that take longer to read than
  // either version alone — so it stops pretending to be an edit and shows the
  // old struck through above the new.
  const REWRITE_RATIO_FLOOR = 0.4;

  // ── Card model ─────────────────────────────────────────────────────────────
  // `from`/`to` are null when that side does not exist (an added ingredient has
  // no `from`). `mode` and `parts` are derived from the content, once, here.
  type ChangeKind = 'new' | 'gone' | 'edit';
  type RenderMode = 'value' | 'inline' | 'rewritten';

  interface ChangeCard {
    key: string;
    kind: ChangeKind;
    label: string;
    from: string | null;
    to: string | null;
    mode: RenderMode;
    parts: DiffPart[];
  }

  function makeCard(
    key: string,
    label: string,
    kind: ChangeKind,
    from: string | null,
    to: string | null,
  ): ChangeCard {
    // One side missing, or both sides short enough to sit on a line: nothing to
    // word-diff. Otherwise let the content pick between marks and a rewrite.
    if (from === null || to === null)
      return { key, label, kind, from, to, mode: 'value', parts: [] };
    if (from.length <= SHORT_VALUE_MAX && to.length <= SHORT_VALUE_MAX)
      return { key, label, kind, from, to, mode: 'value', parts: [] };
    const parts = diffWords(from, to);
    return unchangedRatio(parts) >= REWRITE_RATIO_FLOOR
      ? { key, label, kind, from, to, mode: 'inline', parts }
      : { key, label, kind, from, to, mode: 'rewritten', parts: [] };
  }

  // ── Friendly line builders ─────────────────────────────────────────────────
  function timerLabel(t: StepTimerDoc | null): string {
    if (!t) return 'no timer';
    return t.description
      ? `${formatMinutes(t.durationMinutes)} (${t.description})`
      : formatMinutes(t.durationMinutes);
  }

  function servingsValue(n: number | null): string {
    return n === null ? 'none' : String(n);
  }

  // Prose absence is a real change of kind: a description that did not exist is
  // "new", not an edit of the word "none". A number or a timer is different —
  // unset still has a readable one-line value ("none", "no timer"), so those stay
  // ordinary edits. Both sides blank (null ↔ "") is not a human-visible change at
  // all, so it yields no card rather than an empty one.
  function textOrNull(v: string | null): string | null {
    return v === null || v.trim() === '' ? null : v;
  }

  function proseCard(key: string, label: string, change: NullableStringChange): ChangeCard | null {
    const from = textOrNull(change.from);
    const to = textOrNull(change.to);
    if (from === null && to === null) return null;
    const kind: ChangeKind = from === null ? 'new' : to === null ? 'gone' : 'edit';
    return makeCard(key, label, kind, from, to);
  }

  // The strip, as ONE readable value. Per-phase add/remove/change cards were
  // rejected deliberately: a reorder would read as six edits and bury the single
  // question this gate exists to ask. `phaseElapsedMinutes` is the domain's sum —
  // elapsed time is never stored, here or anywhere.
  //
  // Both figures are printed, not just the elapsed total: a change that keeps a
  // phase's label and its elapsed sum but moves minutes between hands-on and
  // hands-off (the model re-classifying attended time as a wait, say) would
  // otherwise render Now and Proposed as the identical string — a card that
  // asserts something changed while showing the reviewer nothing that did
  // (#1216). Hands-on is the one figure this whole feature exists to surface.
  //
  // A blank label is what a half-typed row in the editor stores, so it is given a
  // placeholder rather than rendered as an empty gap. That is presentation, not a
  // reading of the word: nothing branches on what a label says.
  function phasesValue(phases: RecipePhase[]): string {
    if (phases.length === 0) return 'none';
    return phases
      .map((p) => {
        const label = p.label.trim() === '' ? 'Untitled' : p.label;
        return `${label} ${formatMinutes(phaseElapsedMinutes(p))} (${formatMinutes(p.handsOnMinutes)} hands-on)`;
      })
      .join(' · ');
  }

  // One side of the Timing card. The strip and the sentence over it are two halves
  // of one fact (`reconcileRecipePhases`), so they share a side rather than
  // getting a card each.
  //
  // Each half is included ONLY when that half is in the diff, and that is a
  // correctness rule rather than a tidiness one: `RecipeDiff` carries changed
  // fields and nothing else, so an unchanged strip is not available to draw. A
  // card that filled the gap with `[]` would tell a reviewer the recipe has no
  // phases at the exact moment it is asking them to approve something else.
  function timingSide(phases: RecipePhase[] | null, summary: string | null | undefined): string {
    const parts: string[] = [];
    if (phases !== null) parts.push(phasesValue(phases));
    if (summary !== undefined)
      parts.push(summary === null || summary.trim() === '' ? 'no summary' : summary.trim());
    return parts.join(' — ');
  }

  // ── Cards, per section, in a stable order ──────────────────────────────────
  const basicsCards = $derived.by(() => {
    if (!diff) return [] as ChangeCard[];
    const cards: ChangeCard[] = [];
    if (diff.title) cards.push(makeCard('title', 'Title', 'edit', diff.title.from, diff.title.to));
    const description =
      diff.description && proseCard('description', 'Description', diff.description);
    if (description) cards.push(description);
    const notes = diff.notes && proseCard('notes', 'Notes', diff.notes);
    if (notes) cards.push(notes);
    return cards;
  });

  // An ingredient card names the item, not the group it sits in: `RecipeDiff`
  // flattens ingredients across groups and carries only id + rawText, so the
  // group is not knowable from the data this component is given (issue #825).
  const INGREDIENT_LABEL = 'Ingredient';

  const ingredientCards = $derived.by(() => {
    if (!diff) return [] as ChangeCard[];
    const cards: ChangeCard[] = [];
    for (const ing of diff.ingredients.added)
      cards.push(makeCard(`ing-new-${ing.id}`, INGREDIENT_LABEL, 'new', null, ing.rawText));
    for (const ing of diff.ingredients.removed)
      cards.push(makeCard(`ing-gone-${ing.id}`, INGREDIENT_LABEL, 'gone', ing.rawText, null));
    for (const ing of diff.ingredients.changed)
      cards.push(makeCard(`ing-edit-${ing.id}`, INGREDIENT_LABEL, 'edit', ing.from, ing.to));
    return cards;
  });

  const stepCards = $derived.by(() => {
    if (!diff) return [] as ChangeCard[];
    const cards: ChangeCard[] = [];
    for (const step of diff.steps.added)
      cards.push(makeCard(`step-new-${step.id}`, `Step ${step.position}`, 'new', null, step.text));
    for (const step of diff.steps.removed)
      cards.push(
        makeCard(`step-gone-${step.id}`, `Step ${step.position}`, 'gone', step.text, null),
      );
    // text / timer / note are independent facets of one changed step, so a single
    // step can contribute up to three cards — each is a separate thing to read.
    for (const step of diff.steps.changed) {
      if (step.text)
        cards.push(
          makeCard(
            `step-edit-${step.id}`,
            `Step ${step.position}`,
            'edit',
            step.text.from,
            step.text.to,
          ),
        );
      if (step.timer)
        cards.push(
          makeCard(
            `step-timer-${step.id}`,
            `Step ${step.position} timer`,
            'edit',
            timerLabel(step.timer.from),
            timerLabel(step.timer.to),
          ),
        );
      if (step.note) {
        const note = proseCard(`step-note-${step.id}`, `Step ${step.position} note`, step.note);
        if (note) cards.push(note);
      }
    }
    return cards;
  });

  // Ordered metadata cards (only the fields present in the diff).
  const metadataCards = $derived.by(() => {
    if (!diff) return [] as ChangeCard[];
    const m = diff.metadata;
    const cards: ChangeCard[] = [];
    if (m.servings)
      cards.push(
        makeCard(
          'servings',
          'Servings',
          'edit',
          servingsValue(m.servings.from),
          servingsValue(m.servings.to),
        ),
      );
    // ONE "Timing" card, present when either half of the pair moved, and since
    // issue #1233 the only timing card there is: the Prep / Cook / Total cards
    // restored in PR #1231 went when `recipeAmend.ts` stopped merging the fields
    // they showed, so there is nothing left for them to propose.
    const phases = m.phases;
    const summary = m.timingSummary;
    if (phases || summary) {
      const before = timingSide(phases ? phases.from : null, summary ? summary.from : undefined);
      const after = timingSide(phases ? phases.to : null, summary ? summary.to : undefined);
      // A strip movement ALWAYS draws. `diffRecipe` has already compared the two
      // strips field by field (`phasesEqual`), so `phases` being present is proof
      // the stored document moved — proof computed on the data, which this
      // component cannot improve on by re-deriving it from its own prose. When it
      // tried, it lost: `phasesValue` collapses a blank label to `Untitled` and
      // never prints hands-off at all, so `'' → 'Untitled'` and `-5 → 0` rendered
      // alike, the card was dropped, and with no other card in the diff
      // `hasAnyCards` took the Apply button with it — a real change, plainly
      // visible on the recipe page, that nobody could accept (#1239).
      //
      // The rendered comparison therefore governs the SENTENCE alone, which is
      // the half #1217 was written about: `timingSide` collapses null, "" and
      // whitespace to the one literal `no summary` and trims the rest, so a
      // stored `timingSummary` going null → "" is a change to the document and no
      // change at all on screen. That collapse is enumerable and is the whole of
      // the rule; nothing here claims `phasesValue` is injective, and nothing
      // needs it to be.
      //
      // Accepted cost: a strip pair that happens to render alike now draws a card
      // whose two columns read the same. That is the lesser failure — #1216's
      // complaint was a card asserting a change invisible EVERYWHERE, whereas
      // this change is visible on the recipe page, so the reviewer can act on it.
      // Its boundary, stated rather than asserted away: a stored NaN minute makes
      // `phasesEqual` report a change on every comparison (NaN !== NaN), which
      // would draw that identical-looking card on every proposal. No write path
      // can produce one — the editor and `AuthoredRecipePhasesSchema` both clamp
      // to non-negative integers — but `RecipePhaseSchema` is deliberately
      // permissive on read (#1123), so this is a limit of that boundary rather
      // than an impossibility.
      if (phases || before !== after)
        cards.push(makeCard('timing', 'Timing', 'edit', before, after));
    }
    return cards;
  });

  const tagCards = $derived.by(() => {
    if (!diff) return [] as ChangeCard[];
    const cards: ChangeCard[] = [];
    for (const tag of diff.tags.added)
      cards.push(makeCard(`tag-new-${tag}`, 'Tag', 'new', null, tag));
    for (const tag of diff.tags.removed)
      cards.push(makeCard(`tag-gone-${tag}`, 'Tag', 'gone', tag, null));
    return cards;
  });

  // Whether each section has anything to show. An empty section renders NOTHING —
  // not an empty shell — which is the signal both e2e specs read as "the chef
  // proposed no change here" via toHaveCount(0).
  const hasBasics = $derived(basicsCards.length > 0);
  const hasIngredients = $derived(ingredientCards.length > 0);
  const hasSteps = $derived(stepCards.length > 0);
  const hasMetadata = $derived(metadataCards.length > 0);
  const hasTags = $derived(tagCards.length > 0);

  // Whether the sheet has anything to show at all. Deliberately NOT
  // `diff?.hasChanges`: `diffRecipe` reports a change whenever a field moved,
  // but a section renders only what THIS component chose to draw from it — the
  // Timing card declines to draw a SENTENCE-only pair whose two sides render
  // identically (the strip half always draws, #1239) — so
  // the two can disagree, and when they do, `hasChanges` alone would draw the
  // "here's what will change" sheet with a live Apply button over zero cards
  // (#1216). Deciding from the cards actually built keeps this exact everywhere
  // `diff.hasChanges` used to be read below.
  const hasAnyCards = $derived(
    !!diff && (hasBasics || hasIngredients || hasSteps || hasMetadata || hasTags),
  );

  // ── Surfaces ───────────────────────────────────────────────────────────────
  // The sage container marks what arrives, its destructive counterpart what
  // leaves — symmetric on purpose, so a removal does not read weaker than an
  // addition on a phone. Both are @salt/ui-components tokens.
  const ADDED = 'rounded-sm bg-secondary-container px-1 text-secondary-container-foreground';
  const REMOVED = 'rounded-sm bg-destructive-container px-1 text-destructive-container-foreground';
  const CHIP = 'rounded-sm px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider';
  const HEADING = 'text-xs font-semibold uppercase tracking-wider text-muted-foreground';

  // ── The seam ───────────────────────────────────────────────────────────────
  // `split:` is the app's one page-layout breakpoint (`src/app.css`), and it is
  // used here as a Tailwind variant rather than read in script on purpose: no
  // behaviour hangs off the width, only the card's grid template, and the query
  // string is already duplicated in two places that must move together — a third
  // copy would be a maintenance trap for a layout that CSS can express on its own.
  //
  // Applied to the two renderings that HAVE two sides. The inline one does not:
  // its whole point is that old and new are interleaved in place, so it spans
  // both columns instead of being torn in half to fit them.
  const COLUMNS = 'split:grid split:grid-cols-2 split:items-start split:gap-x-4';

  // What a card puts in the column it is not changing. An added row with a blank
  // Now cell reads as missing data rather than as an addition, so each says so.
  const EMPTY_SIDE = 'hidden split:block text-muted-foreground';

  function chipLabel(card: ChangeCard): string {
    if (card.kind !== 'edit') return card.kind;
    return card.mode === 'rewritten' ? 'rewritten' : 'edit';
  }

  function chipClass(card: ChangeCard): string {
    if (card.kind === 'new')
      return `${CHIP} bg-secondary-container text-secondary-container-foreground`;
    if (card.kind === 'gone')
      return `${CHIP} bg-destructive-container text-destructive-container-foreground`;
    return `${CHIP} bg-muted text-muted-foreground`;
  }
</script>

<!--
  One card, drawn by whichever of the three renderings its content chose.
  `recipe-change-proposed` marks the element holding exactly the proposed value,
  so a spec can assert the new value directly rather than against text that
  word-level marks have split into fragments. The inline rendering has no such
  element by construction — its whole point is that old and new are interleaved
  in place — so it carries `recipe-change-inline` instead.
-->
{#snippet changeCard(card: ChangeCard)}
  <li class="flex flex-col gap-1.5 rounded border border-border bg-card p-2.5">
    <div class="flex items-baseline gap-2">
      <span class={chipClass(card)}>{chipLabel(card)}</span>
      <span class="text-xs text-muted-foreground">{card.label}</span>
    </div>

    {#if card.mode === 'value'}
      <!--
        Stacked, this is `old → new` on one line. Above the seam the arrow goes
        (the columns say which way it reads) and the two sides become the two
        cells. A `display:none` child occupies no grid cell, so the arrow and
        whichever empty-side line is inert simply drop out of the template.
      -->
      <p class={`flex flex-wrap items-baseline gap-x-1.5 gap-y-1 ${COLUMNS}`}>
        {#if card.from !== null}
          <span class={card.kind === 'gone' ? `${REMOVED} line-through` : 'text-muted-foreground'}>
            {card.from}
          </span>
        {:else}
          <span class={EMPTY_SIDE}>Not in the recipe yet</span>
        {/if}
        {#if card.from !== null && card.to !== null}
          <span class="split:hidden text-muted-foreground">→</span>
        {/if}
        {#if card.to !== null}
          <span
            class={card.kind === 'new' ? ADDED : 'font-medium'}
            data-testid="recipe-change-proposed"
          >
            {card.to}
          </span>
        {:else}
          <span class={EMPTY_SIDE}>Removed</span>
        {/if}
      </p>
    {:else if card.mode === 'inline'}
      <p data-testid="recipe-change-inline">
        {#each card.parts as part, i (i)}
          {#if part.kind === 'same'}{part.text}{:else if part.kind === 'del'}<del
              class={`${REMOVED} decoration-1`}>{part.text}</del
            >{:else}<ins class={`${ADDED} no-underline`}>{part.text}</ins>{/if}
        {/each}
      </p>
    {:else}
      <div class={`flex flex-col gap-1.5 ${COLUMNS}`}>
        <p class={`${REMOVED} line-through`}>{card.from}</p>
        <p data-testid="recipe-change-proposed">{card.to}</p>
      </div>
    {/if}
  </li>
{/snippet}

{#snippet group(testid: string, heading: string, cards: ChangeCard[])}
  <section class="flex flex-col gap-1.5" data-testid={testid}>
    <h3 class={HEADING}>{heading}</h3>
    <ul class="flex flex-col gap-2">
      {#each cards as card (card.key)}
        {@render changeCard(card)}
      {/each}
    </ul>
  </section>
{/snippet}

<Sheet bind:open side="bottom">
  <SheetContent class="flex flex-col gap-4">
    <SheetHeader>
      <SheetTitle>Review changes</SheetTitle>
      <SheetDescription>
        {#if hasAnyCards}
          Here's what the chef will change. Nothing is saved until you apply.
        {:else}
          The chef didn't propose any changes to this recipe.
        {/if}
      </SheetDescription>
    </SheetHeader>

    <div class="flex flex-col gap-4 overflow-y-auto text-sm" data-testid="recipe-change-summary">
      {#if !hasAnyCards}
        <!-- Deliberately NOT an `EmptyState` (#930 Phase 9). That primitive is a
           dashed-border PANEL with an `<h3>` title — a page saying "this place
           holds nothing". This is one sentence inside a bottom sheet, with no
           title to head it, nothing to explain and nothing to do next; a
           bordered box around it would read as a second surface inside the
           sheet's own. -->
        <p class="py-6 text-center text-muted-foreground" data-testid="recipe-change-summary-none">
          No changes.
        </p>
      {:else}
        <!--
          The column headings, above the seam only. They sit inside the scroller
          rather than above it so they pin to the top of the list while it moves —
          the answer to "which column am I reading?" has to survive scrolling past
          the first card. `px-2.5` matches a card's padding so the two labels line
          up with the cells beneath them.

          aria-hidden: this is orientation for the eye. Every card already names
          its own kind in a chip, so a screen reader loses nothing, and a loose
          "Now Proposed" landing between the description and the first section
          would be noise in the reading order.
        -->
        <div
          class={`sticky top-0 z-10 hidden gap-x-4 border-b border-border bg-background px-2.5 pb-1.5 split:grid split:grid-cols-2 ${HEADING}`}
          aria-hidden="true"
        >
          <span>Now</span>
          <span>Proposed</span>
        </div>
        {#if hasBasics}
          {@render group('recipe-change-group-basics', 'Overview', basicsCards)}
        {/if}
        {#if hasIngredients}
          {@render group('recipe-change-group-ingredients', 'Ingredients', ingredientCards)}
        {/if}
        {#if hasSteps}
          {@render group('recipe-change-group-steps', 'Steps', stepCards)}
        {/if}
        {#if hasMetadata}
          {@render group('recipe-change-group-metadata', 'Timing & servings', metadataCards)}
        {/if}
        {#if hasTags}
          {@render group('recipe-change-group-tags', 'Tags', tagCards)}
        {/if}
      {/if}
    </div>

    <SheetFooter class="flex justify-end gap-2">
      <Button
        variant="ghost"
        size="sm"
        onclick={onDiscard}
        disabled={applying}
        data-testid="recipe-change-discard"
      >
        {hasAnyCards ? 'Discard / keep chatting' : 'Close'}
      </Button>
      {#if hasAnyCards}
        <Button
          size="sm"
          onclick={onApply}
          loading={applying}
          disabled={applying}
          data-testid="recipe-change-apply"
        >
          {#snippet leading()}<Icon name="Check" size={14} />{/snippet}
          Apply changes
        </Button>
      {/if}
    </SheetFooter>
  </SheetContent>
</Sheet>
