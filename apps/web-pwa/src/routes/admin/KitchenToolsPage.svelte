<script lang="ts">
  import {
    Button,
    Chip,
    ChipGroup,
    CollapsibleSection,
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
    ListPage,
    Text,
    TextField,
  } from '@salt/ui-components';
  import { untrack } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { resolveKitchenTool, suggestKitchenToolParent, unresolvedKitLabels } from '@salt/domain';
  import type { KitchenToolDoc, GuidedPlanDoc } from '@salt/domain/schemas';
  import AdminGuard from './AdminGuard.svelte';
  import KitchenToolEditor from './KitchenToolEditor.svelte';
  import KitchenToolRow from './KitchenToolRow.svelte';
  import { goBack } from '../../lib/nav.js';
  import {
    kitchenTools,
    isLoadingKitchenTools,
    addKitchenTool,
    addKitchenToolMatcher,
    moveKitchenToolMatcher,
    promoteKitchenToolMatcher,
    removeKitchenTool,
    removeKitchenToolMatcher,
  } from '../../lib/kitchenToolService.js';
  import { equipment } from '../../lib/equipmentService.js';
  import { recipes } from '../../lib/recipeService.js';
  import { loadAllGuidedPlansForCuration } from '../../lib/guidedPlanService.js';
  import { createDeferredDelete } from '../../lib/deferredDelete.svelte.js';
  import { SPLIT_QUERY, createMediaQuery } from '../../lib/mediaQuery.svelte.js';
  import { addToast } from '../../lib/toastStore.js';

  // The kitchen-tool vocabulary, and the queue of words our own content used that
  // it cannot name (issue #882, Phase 4).
  //
  // DELIBERATELY NOT A CATALOG RECORD KIND. The Catalog holds two GROCERY kinds
  // that share an aisle, a match pipeline and one `needs_approval` review queue; a
  // tool has none of the three. Threading a third kind through it would churn
  // `CatalogRecordKey`, the arrival routing and every `record.kind === 'canon'`
  // branch across two components to gain a list that shares nothing with the other
  // two. This page is a sibling. It WEARS the Catalog's shape since #1489 — one
  // list, a docked editor, rows that open onto their contents, all built from the
  // same `@salt/ui-components` pieces and none of its components — which is a
  // different claim from being the same record kind, and leaves every sentence
  // above standing.

  // `params` is OPTIONAL: this page serves `/admin/kitchen-tools` (static, no
  // params) as well as `/admin/kitchen-tools/:id`. svelte-spa-router passes a
  // `params` prop only for parameterised routes.
  let { params }: { params?: { id?: string } } = $props();

  // ─── The unresolved queue ─────────────────────────────────────────────────────
  //
  // Recipes are already subscribed app-wide, so only the plans need fetching, and
  // that is ONE SHOT on arrival (see `loadAllGuidedPlansForCuration`). A curation
  // backlog that is a page-load old is exactly as useful as one that is a second
  // old — and the rows that matter still vanish live, because they disappear the
  // moment the vocabulary store gains the tool that resolves them, with no reread
  // of anything and no write to a recipe or a plan.

  let plans = $state<GuidedPlanDoc[]>([]);
  let plansLoaded = $state(false);

  $effect(() => {
    let live = true;
    void loadAllGuidedPlansForCuration().then((result) => {
      if (!live) return;
      if (result.kind === 'ok') plans = result.value;
      plansLoaded = true;
    });
    return () => {
      live = false;
    };
  });

  // Each row carries the tool it probably belongs to, so the cheap action can be
  // the obvious one. The suggestion is ADVISORY — `suggestKitchenToolParent`'s
  // header says why a head noun is a good hint and a terrible rule — so it is
  // only ever a button a person presses, never a fold that happens on its own.
  //
  // The manifest goes in too (issue #954): a kit label may now name an appliance
  // the household owns, and `equipmentIcons` already holds a drawing of it — so
  // offering it here would invite a second pictogram of the same machine, and the
  // row could never clear, because the strip resolves equipment before tools.
  const queue = $derived(
    unresolvedKitLabels($recipes, plans, $kitchenTools, $equipment?.items ?? []).map((row) => ({
      ...row,
      suggestion: suggestKitchenToolParent(row.label, $kitchenTools),
    })),
  );

  const sortedTools = $derived(
    $kitchenTools.slice().sort((a, b) => a.label.localeCompare(b.label)),
  );

  // ─── View state — in memory only (Rule 3) ─────────────────────────────────────

  type KitchenToolFilter = 'all' | 'has-names';

  const FILTERS: { id: KitchenToolFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'has-names', label: 'Has other names' },
  ];

  let filterText = $state('');
  let filter = $state<KitchenToolFilter>('all');
  let expandedRows = $state(new Set<string>());
  let vocabularyExpanded = $state(true);

  function toggleRow(id: string): void {
    const next = new Set(expandedRows);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedRows = next;
  }

  // ─── Two panes, one gate ──────────────────────────────────────────────────────
  // Is the editor docked in a column of its own? From `split:` up it is. This must
  // stay the SAME GATE as the `split:` variant the columns are laid out with, and
  // it is what `fill` is passed from as well — one gate, so the classes and the
  // prop cannot disagree (ui-spec-v07 §1.4). The read itself, and the four ways
  // it can fail, are `lib/mediaQuery.svelte.ts`.
  const split = createMediaQuery(SPLIT_QUERY);
  const docked = $derived(split.matches);

  // ─── Which tool the editor is on ──────────────────────────────────────────────
  // Seeded from the route, then owned by the page: on the two-pane breakpoint
  // choosing a row must NOT navigate, because the router remounts this page on a
  // route change and the list would lose its scroll position. `untrack` because
  // this is the value AT MOUNT — the `$effect` below is what follows the route
  // afterwards. The `:id` is the tool's slug, unnamespaced: unlike the catalog,
  // this list holds one kind of thing.
  const mountedId = untrack(() => params?.id) ?? null;
  let openId = $state<string | null>(mountedId);
  let syncedRouteId = $state<string | null>(mountedId);
  const routeId = $derived(params?.id ?? null);

  $effect(() => {
    if (routeId === syncedRouteId) return;
    syncedRouteId = routeId;
    openId = routeId;
  });

  const deferredDelete = createDeferredDelete();

  const openTool = $derived(
    openId === null ? null : ($kitchenTools.find((t) => t.id === openId) ?? null),
  );

  function openToolById(id: string): void {
    if (docked) openId = id;
    else push(`/admin/kitchen-tools/${id}`);
  }

  // Back, which only the full-page editor offers — the docked pane has no back
  // button, because the list is already beside it.
  function closeTool(): void {
    goBack('/admin/kitchen-tools');
  }

  // ─── The list ─────────────────────────────────────────────────────────────────

  const rows = $derived.by((): KitchenToolDoc[] => {
    const q = filterText.trim().toLowerCase();
    return sortedTools.filter((tool) => {
      if (deferredDelete.isPending(tool.id)) return false;
      if (filter === 'has-names' && tool.matchers.length === 0) return false;
      if (q === '') return true;
      return (
        tool.label.toLowerCase().includes(q) ||
        tool.matchers.some((m) => m.toLowerCase().includes(q))
      );
    });
  });

  // ─── Add a tool ───────────────────────────────────────────────────────────────
  //
  // ONE FIELD. The comma-separated "Also called" box is gone: names are added one
  // at a time in the editor, and a field that rewrote the whole list on blur
  // cannot coexist with a row per name.

  let showAdd = $state(false);
  let formLabel = $state('');
  let formError = $state('');
  let saving = $state(false);

  function openCreate(label = ''): void {
    formLabel = label;
    formError = '';
    showAdd = true;
  }

  // The name being typed already belongs to a drawn tool. A WARNING, never a
  // refusal: `Small bowl` beside `Mixing bowl` is a deliberate second tool and the
  // seeded vocabulary contains several such pairs, so a hard guard would forbid
  // its own contents. What it stops is the accident — `Large frying pan` minted
  // beside `Frying pan`, one more document, one more Gemini image, and plain
  // "frying pan" still undrawn because a specific tool covers nothing but itself.
  //
  // `createKitchenTool`'s `ConflictError` is a different and stricter thing: an
  // IDENTICAL slug, which would overwrite a curated tool. That one still refuses.
  const nearDuplicateOf = $derived(
    !formLabel.trim() ? null : resolveKitchenTool(formLabel, $kitchenTools),
  );

  async function handleAdd(): Promise<void> {
    formError = '';
    saving = true;
    const result = await addKitchenTool({ label: formLabel, matchers: [] });
    saving = false;
    if (result.kind === 'ok') {
      showAdd = false;
      addToast('Added. Drawing its picture…', 'success');
      openToolById(result.value.id);
      return;
    }
    // The two refusals say different things and want different next moves, so
    // they are not folded into one "could not save".
    formError =
      result.kind === 'err' && result.error.kind === 'ConflictError'
        ? 'A tool with that name is already in the list — edit that one instead.'
        : 'Give the tool a name.';
  }

  // ─── The names a tool answers to ──────────────────────────────────────────────
  //
  // The expanded list row and the editor offer the same three verbs, so each
  // write lives here once and both sites call it — one command, one call path.

  async function handleRemoveName(tool: KitchenToolDoc, phrase: string): Promise<void> {
    const result = await removeKitchenToolMatcher(tool, phrase);
    if (result.kind !== 'ok') addToast('Failed to remove the name.', 'destructive');
  }

  /**
   * Give a name a picture of its own. The expensive verb: it mints a document and
   * spends one Gemini image. No gate in front of it — Salt records rather than
   * polices — but it says what it did, and a refused second write says exactly
   * what to repair rather than "something went wrong".
   */
  async function handlePromoteName(tool: KitchenToolDoc, phrase: string): Promise<void> {
    const result = await promoteKitchenToolMatcher(tool, phrase);
    if (result.kind === 'ok') {
      addToast(`“${phrase}” is a tool of its own now. Drawing its picture…`, 'success');
      openToolById(result.value.id);
      return;
    }
    if (result.kind === 'err' && result.error.kind === 'ConflictError') {
      // Nothing was written: `createKitchenTool` refuses a slug collision before
      // the first write, so the honest message names the tool in the way.
      addToast(`A tool called “${phrase}” is already in the list.`, 'destructive');
      return;
    }
    // The duplicate window, made loud. See `promoteKitchenToolMatcher`'s header
    // for why the phrase is on two documents here and why that is the recoverable
    // half rather than a bug to reorder away.
    addToast(
      `“${phrase}” is a tool now, but ${tool.label} still answers to it — remove it there.`,
      'destructive',
    );
  }

  // Which name is being moved, and where to. The dialog is the page's because the
  // choice is over the whole vocabulary, which only the page holds.
  let moveTarget = $state<{ tool: KitchenToolDoc; phrase: string } | null>(null);
  let moveToId = $state('');
  let moveBusy = $state(false);

  function openMove(tool: KitchenToolDoc, phrase: string): void {
    moveTarget = { tool, phrase };
    moveToId = '';
  }

  // Every tool but the one the phrase is already on.
  const moveChoices = $derived(
    sortedTools
      .filter((t) => t.id !== moveTarget?.tool.id)
      .map((t) => ({ value: t.id, label: t.label })),
  );

  async function handleMoveName(): Promise<void> {
    const target = moveTarget;
    const to = $kitchenTools.find((t) => t.id === moveToId);
    if (!target || !to) return;
    moveBusy = true;
    const result = await moveKitchenToolMatcher(target.tool, to, target.phrase);
    moveBusy = false;
    moveTarget = null;
    if (result.kind === 'ok') {
      addToast(`“${target.phrase}” now shows the ${to.label}.`, 'success');
      return;
    }
    addToast(
      `${to.label} answers to “${target.phrase}” now, but ${target.tool.label} still does too — remove it there.`,
      'destructive',
    );
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────
  //
  // Deferred delete + Undo in place of the confirm dialog this page used to carry.
  // Nothing is deleted until the toast lapses, so "are you sure?" has nothing left
  // to ask — Salt records, it does not police. The id and the words are read
  // BEFORE the deferral: `openTool` derives off the live subscription.

  function handleDelete(tool: KitchenToolDoc): void {
    const { id, label } = tool;
    openId = null;
    deferredDelete.request(
      [id],
      async () => {
        const result = await removeKitchenTool(id);
        if (result.kind !== 'ok') addToast('Failed to remove the tool.', 'destructive');
      },
      {
        message: `“${label}” removed — every recipe and plan that says it keeps its words and loses the picture`,
        noun: 'tool',
      },
    );
    // A deleted tool leaves the pane AND the URL: a path still naming it would be
    // a dead bookmark. The undo toast outlives this page, so the deferred delete
    // is unaffected by the list remounting under it.
    push('/admin/kitchen-tools');
  }

  // ─── Alias: teach an existing tool one more phrase ─────────────────────────────
  //
  // The action that keeps the vocabulary from bloating. "masher" and "potato
  // masher" want the same drawing, and every near-duplicate tool is another image
  // the pipeline pays to generate and another row somebody has to keep in step.

  let aliasFor = $state<string | null>(null);
  let aliasToolId = $state('');
  let aliasBusy = $state(false);
  // Which queue row's one-click alias is in flight, by label. A row-level flag
  // rather than a page-level one so the other rows stay usable.
  let suggestBusy = $state<string | null>(null);

  /**
   * The queue's suggested alias, taken in one click. It reuses `addKitchenToolMatcher`
   * — the same write the dialog performs — rather than adding a second path to the
   * same effect: appending a phrase to `matchers` and saving is the whole of it.
   */
  async function acceptSuggestion(label: string, tool: KitchenToolDoc): Promise<void> {
    suggestBusy = label;
    const result = await addKitchenToolMatcher(tool, label);
    suggestBusy = null;
    if (result.kind === 'ok') addToast(`“${label}” now shows the ${tool.label}.`, 'success');
    else addToast('Failed to add the alias.', 'destructive');
  }

  const aliasChoices = $derived(sortedTools.map((t) => ({ value: t.id, label: t.label })));

  function openAlias(label: string): void {
    aliasFor = label;
    aliasToolId = '';
  }

  async function handleAlias(): Promise<void> {
    const phrase = aliasFor;
    const tool = $kitchenTools.find((t) => t.id === aliasToolId);
    if (!phrase || !tool) return;
    aliasBusy = true;
    const result = await addKitchenToolMatcher(tool, phrase);
    aliasBusy = false;
    aliasFor = null;
    if (result.kind === 'ok') addToast(`“${phrase}” now shows the ${tool.label}.`, 'success');
    else addToast('Failed to add the alias.', 'destructive');
  }
</script>

<AdminGuard>
  {#if openTool && !docked}
    <!-- The phone: a chosen tool is the whole screen, and Back returns to the
         list. `DetailPage` here is an ORDINARY page — it must not be `fill`, and
         it is never nested inside the filled list below. -->
    {@const tool = openTool}
    <div class="p-4 sm:p-6">
      <KitchenToolEditor
        {tool}
        variant="page"
        onClose={closeTool}
        onDelete={() => handleDelete(tool)}
        onPromoteName={handlePromoteName}
        onMoveName={openMove}
        onRemoveName={handleRemoveName}
      />
    </div>
  {:else}
    <ListPage
      title="Kitchen tools"
      description="The drawn vocabulary. Recipes and plans store words; the picture is looked up from those words every time a row is drawn — so adding a tool here gives every recipe that already says it a picture, with nothing rewritten."
      isLoading={$isLoadingKitchenTools}
      isEmpty={false}
      class="p-4 sm:p-6"
      fill={docked}
    >
      {#snippet actions()}
        <Button size="sm" variant="outline" onclick={() => goBack('/admin')}>Back to admin</Button>
        <Button size="sm" onclick={() => openCreate()} data-testid="kitchen-tool-add"
          >Add tool</Button
        >
      {/snippet}

      {#snippet children()}
        <!-- Two panes from `split:` up, one column below it. The height comes from
             `ListPage`'s fill chain (ui-spec-v05 §1, ui-spec-v07 §1.4) resolving
             against AppShell's <main> — there is deliberately no `calc(100dvh - …)`
             and nothing measures chrome. -->
        <div class="grid gap-4 split:min-h-0 split:flex-1 split:grid-cols-2 split:gap-6">
          <div
            class="flex min-w-0 flex-col gap-4 split:min-h-0 split:overflow-y-auto split:salt-focus-gutter"
          >
            <div class="flex flex-col gap-2">
              <input
                class="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                placeholder="Filter kitchen tools…"
                type="search"
                data-testid="kitchen-tool-filter-text"
                bind:value={filterText}
              />
              <ChipGroup ariaLabel="Filter the kitchen tools">
                {#each FILTERS as chip (chip.id)}
                  <Chip
                    pressed={filter === chip.id}
                    onclick={() => (filter = chip.id)}
                    data-testid="kitchen-tool-filter-{chip.id}"
                  >
                    {chip.label}
                  </Chip>
                {/each}
              </ChipGroup>
            </div>

            <!-- The queue. Present only when there is something in it: an empty
                 "Not drawn yet" heading reads as a broken screen rather than a
                 vocabulary that has caught up with the content. -->
            {#if queue.length > 0}
              <section class="flex flex-col gap-2" data-testid="kitchen-tool-queue">
                <div>
                  <h2 class="text-sm font-medium text-foreground">Not drawn yet</h2>
                  <p class="text-xs text-muted-foreground">
                    Words your recipes and plans already use that nothing draws, commonest first.
                    {#if !plansLoaded}
                      Counting the guided plans…
                    {/if}
                  </p>
                </div>
                <ul class="divide-y divide-border rounded border">
                  {#each queue as row (row.label)}
                    <li
                      class="flex items-center gap-3 px-3 py-2"
                      data-testid="kitchen-tool-queue-row"
                      data-kit-label={row.label}
                    >
                      <span class="min-w-0 flex-1 truncate text-sm">{row.label}</span>
                      <span
                        class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                        data-testid="kitchen-tool-queue-count"
                      >
                        {row.count}
                      </span>
                      <!-- The row leads with the action that COSTS NOTHING. Aliasing
                           reuses a picture the vocabulary already has; "New tool"
                           spends a Gemini image and a document, and does it again for
                           the next adjective. Where there is a likely parent, the
                           one-click alias is solid and the other two are demoted; where
                           there is not, "New tool" is the right first move and leads. -->
                      {#if row.suggestion}
                        {@const parent = row.suggestion}
                        <Button
                          size="sm"
                          onclick={() => void acceptSuggestion(row.label, parent)}
                          loading={suggestBusy === row.label}
                          disabled={suggestBusy !== null}
                          data-testid="kitchen-tool-queue-suggest"
                        >
                          Alias to {parent.label}
                        </Button>
                      {/if}
                      <Button
                        variant={row.suggestion ? 'ghost' : 'solid'}
                        size="sm"
                        onclick={() => openCreate(row.label)}
                        data-testid="kitchen-tool-queue-new"
                      >
                        New tool
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onclick={() => openAlias(row.label)}
                        data-testid="kitchen-tool-queue-alias"
                      >
                        {row.suggestion ? 'Another…' : 'Alias…'}
                      </Button>
                    </li>
                  {/each}
                </ul>
              </section>
            {/if}

            <CollapsibleSection
              title="The vocabulary"
              expanded={vocabularyExpanded}
              onToggle={() => (vocabularyExpanded = !vocabularyExpanded)}
              collapsedCount={rows.length}
              triggerTestId="kitchen-tool-vocabulary-toggle"
              data-testid="kitchen-tool-vocabulary"
            >
              <ul class="flex flex-col gap-1" data-testid="kitchen-tool-list">
                {#each rows as tool (tool.id)}
                  <KitchenToolRow
                    {tool}
                    expanded={expandedRows.has(tool.id)}
                    onToggle={() => toggleRow(tool.id)}
                    open={openId === tool.id}
                    onOpen={openToolById}
                    onPromoteName={handlePromoteName}
                    onMoveName={openMove}
                    onRemoveName={handleRemoveName}
                  />
                {:else}
                  <li>
                    <Text muted>Nothing matches this view.</Text>
                  </li>
                {/each}
              </ul>
            </CollapsibleSection>
          </div>

          <!-- The editor, docked from `split:` up. Below that it does not render at
               all — the tool takes the whole screen instead. -->
          <div class="hidden min-w-0 flex-col split:flex split:min-h-0">
            {#if openTool}
              {@const tool = openTool}
              <KitchenToolEditor
                {tool}
                variant="pane"
                onClose={closeTool}
                onDelete={() => handleDelete(tool)}
                onPromoteName={handlePromoteName}
                onMoveName={openMove}
                onRemoveName={handleRemoveName}
              />
            {:else}
              <Text muted>Choose a tool to edit it here.</Text>
            {/if}
          </div>
        </div>
      {/snippet}
    </ListPage>
  {/if}
</AdminGuard>

<!-- Add a tool -->
<Dialog
  open={showAdd}
  onOpenChange={(v) => {
    if (!v) showAdd = false;
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="kitchen-tool-add-dialog">
      <DialogHeader>
        <DialogTitle>Add tool</DialogTitle>
        <DialogDescription>
          The name is what gets drawn. A picture is generated as soon as you save, and the editor
          opens on it.
        </DialogDescription>
      </DialogHeader>
      <TextField
        label="Name"
        bind:value={formLabel}
        placeholder="e.g. Potato masher"
        data-testid="kitchen-tool-label-input"
      />
      {#if nearDuplicateOf}
        <p class="text-sm text-warning-text" data-testid="kitchen-tool-duplicate-warning">
          “{nearDuplicateOf.label}” already answers to that name. Saving draws a second picture of
          the same thing — if it is the same thing, cancel and add these words to {nearDuplicateOf.label}
          instead.
        </p>
      {/if}
      {#if formError}
        <span class="text-sm text-destructive" data-testid="kitchen-tool-error">{formError}</span>
      {/if}
      <DialogFooter>
        <Button variant="outline" onclick={() => (showAdd = false)} disabled={saving}>
          Cancel
        </Button>
        <Button
          onclick={handleAdd}
          loading={saving}
          disabled={saving}
          data-testid="kitchen-tool-save"
        >
          Add
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

<!-- Alias an unresolved name onto a tool that already has a picture -->
<Dialog
  open={aliasFor !== null}
  onOpenChange={(v) => {
    if (!v) aliasFor = null;
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="kitchen-tool-alias-dialog">
      <DialogHeader>
        <DialogTitle>Another name for…</DialogTitle>
        <DialogDescription>
          “{aliasFor}” will show that tool's existing picture. Nothing new is drawn.
        </DialogDescription>
      </DialogHeader>
      <div data-testid="kitchen-tool-alias-select">
        <Combobox
          items={aliasChoices}
          value={aliasToolId}
          onValueChange={(v) => (aliasToolId = v)}
          placeholder="Search tools…"
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
                <ComboboxEmpty>No tools match.</ComboboxEmpty>
              {/if}
            {/snippet}
          </ComboboxContent>
        </Combobox>
      </div>
      <DialogFooter>
        <Button variant="outline" onclick={() => (aliasFor = null)} disabled={aliasBusy}>
          Cancel
        </Button>
        <Button
          onclick={handleAlias}
          loading={aliasBusy}
          disabled={aliasBusy || !aliasToolId}
          data-testid="kitchen-tool-alias-confirm"
        >
          Add as another name
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

<!-- Move one name from the tool it is on to a different one. Two writes, no
     image, no cost — `moveKitchenToolMatcher` states the ordering and its one
     stated boundary. -->
<Dialog
  open={moveTarget !== null}
  onOpenChange={(v) => {
    if (!v) moveTarget = null;
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="kitchen-tool-move-dialog">
      <DialogHeader>
        <DialogTitle>Move “{moveTarget?.phrase}” to…</DialogTitle>
        <DialogDescription>
          It stops being one of {moveTarget?.tool.label}'s names and becomes one of theirs. Nothing
          new is drawn.
        </DialogDescription>
      </DialogHeader>
      <div data-testid="kitchen-tool-move-select">
        <Combobox
          items={moveChoices}
          value={moveToId}
          onValueChange={(v) => (moveToId = v)}
          placeholder="Search tools…"
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
                <ComboboxEmpty>No tools match.</ComboboxEmpty>
              {/if}
            {/snippet}
          </ComboboxContent>
        </Combobox>
      </div>
      <DialogFooter>
        <Button variant="outline" onclick={() => (moveTarget = null)} disabled={moveBusy}>
          Cancel
        </Button>
        <Button
          onclick={handleMoveName}
          loading={moveBusy}
          disabled={moveBusy || !moveToId}
          data-testid="kitchen-tool-move-confirm"
        >
          Move it
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>
