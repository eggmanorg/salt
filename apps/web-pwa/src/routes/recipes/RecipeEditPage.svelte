<script lang="ts">
  import {
    Button,
    Combobox,
    ComboboxContent,
    ComboboxEmpty,
    ComboboxField,
    ComboboxInput,
    ComboboxItem,
    ComboboxTrigger,
    DetailPage,
    Icon,
    Markdown,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SortableList,
    Switch,
    Textarea,
    TextField,
    type ComboboxItemType,
  } from '@salt/ui-components';
  import MinutesField from './MinutesField.svelte';
  import { push, router } from 'svelte-spa-router';
  import { goBack } from '../../lib/nav.js';
  import { readMealParam } from '../../lib/mealReturn.js';
  import { trackUsageEvent } from '@salt/observability';
  import {
    recipeHeroUrl,
    emptyRecipe,
    emptyIngredientGroup,
    newIngredient,
    newStep,
    canBeComponentOf,
    clearIngredientMatch,
    hasLiveCanonMatch,
    insertComponentByElapsedTime,
    isCookable,
    resolveComponents,
    takesComponents,
    takesIngredients,
    type Recipe,
    type RecipeKind,
    type IngredientGroup,
    memberFirstName,
    normaliseTags,
    type Ingredient,
    type Step,
    type RecipeMetadata,
    type RecipePhase,
  } from '@salt/domain';
  import {
    recipes,
    attachComponentToMeal,
    persistRecipe,
    parseIngredients,
    matchIngredient,
    takeImportedDraft,
  } from '../../lib/recipeService.js';
  import { MAX_RECIPE_PHASES, RecipeKindSchema } from '@salt/domain/schemas';
  import { componentTimeLabel } from './recipeTiming.js';
  import { canonItems } from '../../lib/canonService.js';
  import { members } from '../../lib/membersService.js';
  import { addToast } from '../../lib/toastStore.js';
  import { KIND_COPY, kindOf } from './recipeKind.js';
  import NotesFormattingToolbar from './NotesFormattingToolbar.svelte';

  interface Props {
    // `id` is present on /recipes/:id/edit; `kind` on /recipes/new/:kind. Both
    // absent on /recipes/new, which is still the plain new-recipe route.
    params?: { id?: string; kind?: string };
  }
  let { params }: Props = $props();

  const editingId = $derived(params?.id ?? null);

  // The meal this editor was opened FROM, if any (issue #752, Phase 3). Carried
  // in the querystring — `?meal=<id>` — and read live off the router, so a reload
  // mid-edit keeps it. See lib/mealReturn.ts for why it lives nowhere else.
  const mealReturnId = $derived(readMealParam(router.querystring));

  // The kind arrives as a raw URL segment, so it is user input: validate it and
  // fall back rather than persisting whatever was typed. /recipes/new/pudding
  // opens an ordinary new recipe instead of writing a document with a kind
  // nothing downstream can read. /recipes/new (no segment) takes the same path,
  // which is why that route's behaviour is untouched.
  function parseKindParam(raw: string | undefined): RecipeKind {
    const parsed = RecipeKindSchema.safeParse(raw);
    return parsed.success ? parsed.data : 'recipe';
  }

  // Live canon ids drive the unmatched indicator: an ingredient whose canon
  // item has since been deleted reads as unmatched (re-matchable), same as the
  // view page and shopping list (reference-integrity, #188).
  const liveCanonIds = $derived(new Set($canonItems.map((c) => c.id)));

  // Did the editor open on a handed-off draft rather than a blank form? A stashed
  // draft (a duplicate, #735; a share-target import) arrives fully populated and
  // already titled, so the first thing you do is rename it — the title takes
  // focus. A blank "New recipe" does not grab the keyboard.
  let openedFromStash = $state(false);

  // The draft is a local, mutable copy of the recipe entity assembled with the
  // Phase 1 builders. It is validated only on read (adapter/schema); the whole
  // document is persisted on save. `rawText` is preserved verbatim.
  let draft = $state<Recipe>(buildInitialDraft());
  let loaded = $state(false);

  function buildInitialDraft(): Recipe {
    // Consume a one-shot imported draft if the URL-import flow stashed one
    // (single-use: takeImportedDraft clears it). Clone so editing doesn't mutate
    // the stashed object.
    //
    // Since #616 the import callable PERSISTS the recipe, so an import arrives
    // here as /recipes/{id}/edit rather than /recipes/new — the stash is then
    // just a way to paint the editor immediately instead of waiting for the
    // Firestore listener to deliver a doc the server wrote moments ago. The id
    // must match: a stale stash must never bleed into a different recipe's
    // editor. /recipes/new still consumes an unmatched stash for back-compat
    // with any older stash-then-navigate path.
    const id = params?.id ?? null;
    if (id === null) {
      const imported = takeImportedDraft();
      if (imported) {
        openedFromStash = true;
        return cloneRecipe(imported);
      }
    }
    return emptyRecipe(crypto.randomUUID(), new Date().toISOString(), parseKindParam(params?.kind));
  }

  // Which sections this entry gets. Sourced from the DRAFT, never from the URL:
  // on /recipes/:id/edit there is no kind segment and the answer must follow the
  // loaded recipe, and the draft is the one object that is right in both modes.
  // Both questions go through the domain predicates — nothing here compares
  // against `'outing'`.
  const draftKind = $derived(kindOf(draft));
  const showIngredients = $derived(takesIngredients(draftKind));
  const showCooking = $derived(isCookable(draftKind));
  // Whether other dishes can be hung off this one (issue #752). A capability, so
  // it asks the domain: a recipe or a cocktail can be built from components, an
  // outing and a placeholder cannot.
  const showComponents = $derived(takesComponents(draftKind));

  // Hydrate the draft from the store in edit mode. Depends on `$recipes` so a
  // cold deep-link (store not yet hydrated) populates once the subscription
  // delivers the recipe; new-recipe mode starts from a blank draft immediately.
  $effect(() => {
    if (loaded) return;
    if (editingId === null) {
      loaded = true;
      return;
    }
    const existing = $recipes.find((r) => r.id === editingId);
    if (existing) {
      // Deep-clone into mutable structures so editing doesn't touch the store copy.
      draft = cloneRecipe(existing);
      loaded = true;
      return;
    }
    // Not in the store yet. A URL import (#616) is persisted server-side and
    // routed straight here, so the listener may not have delivered it — the
    // stashed copy of the very same recipe paints the editor now instead of
    // showing a blank form until the round-trip lands. Id-matched, so an
    // unrelated recipe's editor leaves the stash untouched.
    const imported = takeImportedDraft(editingId);
    if (imported) {
      draft = cloneRecipe(imported);
      loaded = true;
    }
  });

  function cloneRecipe(r: Recipe): Recipe {
    return {
      ...r,
      ingredients: r.ingredients.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i })) })),
      steps: r.steps.map((s) => ({ ...s, timer: s.timer ? { ...s.timer } : null })),
      metadata: {
        ...r.metadata,
        tags: [...r.metadata.tags],
        // Value-cloned like `tags`: `phases` is edited on this page (add/
        // remove/move/update a row) and must never reach into the store's
        // copy. Conditional — a literal `phases: undefined` written back
        // would reach `setDoc` and store a key that was never there.
        ...(r.metadata.phases ? { phases: r.metadata.phases.map((p) => ({ ...p })) } : {}),
      },
      // Value-cloned like `metadata.tags`: the draft's component order is edited
      // here and must never reach into the store's copy of the recipe.
      componentRecipeIds: [...r.componentRecipeIds],
    };
  }

  // ─── Metadata helpers ───────────────────────────────────────────────────────
  function setMetadata(patch: Partial<RecipeMetadata>): void {
    draft = { ...draft, metadata: { ...draft.metadata, ...patch } };
  }

  function parseNumberOrNull(value: string): number | null {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  // Servings only (issue #1123). A 0 typed here is not an answer — it is what
  // "not stated" means, and `null` is this field's existing sentinel for that,
  // which every consumer already handles (the chip hides, the scaler falls back
  // to a base of 1). Deliberately NOT folded into `parseNumberOrNull`: the other
  // callers of that helper are the phase minute boxes and a step timer, where a
  // typed 0 is a real answer — a prove has no hands-on time at all (issue #739).
  function positiveOrNull(value: number | null): number | null {
    return value !== null && value > 0 ? value : null;
  }

  let tagInput = $state('');

  const allExistingTags = $derived([...new Set($recipes.flatMap((r) => r.metadata.tags))].sort());

  const availableSuggestions = $derived(
    allExistingTags.filter((t) => !draft.metadata.tags.includes(t)),
  );

  // Tag normalisation is `@salt/domain`'s `normaliseTags` (issue #1054) — the
  // same rule the recipe-authoring flows apply to what the model emits, which
  // live in an app this one cannot import. One raw string can yield more than
  // one tag, because the rule splits on commas.
  function addTag(raw: string): void {
    const fresh = normaliseTags([raw]).filter((t) => !draft.metadata.tags.includes(t));
    if (fresh.length > 0) setMetadata({ tags: [...draft.metadata.tags, ...fresh] });
    tagInput = '';
  }

  function removeTag(tag: string): void {
    setMetadata({ tags: draft.metadata.tags.filter((t) => t !== tag) });
  }

  function handleTagKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (tagInput.trim()) addTag(tagInput);
    } else if (e.key === 'Backspace' && !tagInput && draft.metadata.tags.length > 0) {
      removeTag(draft.metadata.tags[draft.metadata.tags.length - 1]!);
    }
  }

  // ─── Source helpers ───────────────────────────────────────────────────────────
  // The source URL is surfaced so imported recipes show their provenance and it
  // survives an edit/save. An empty url clears the source entirely (back to a
  // manual recipe); a non-empty url marks it as url-sourced.
  const sourceUrl = $derived(draft.source?.type === 'url' ? (draft.source.url ?? '') : '');

  function setSourceUrl(value: string): void {
    const trimmed = value.trim();
    draft = { ...draft, source: trimmed === '' ? null : { type: 'url', url: trimmed } };
  }

  // ─── "Added by" (issue #845) ────────────────────────────────────────────────
  // The one attribution field a person may set. `createdBy` holds a snapshot of
  // `Member.name` taken at write time, and every recipe that predates the field
  // got its name from a backfill that could only GUESS — so the record can be
  // wrong, and this is where it is put right.
  //
  // Offered only when EDITING an existing entry: on the create routes the author
  // is whoever is typing, by definition, and `stampRecipeAttribution` writes it.
  // That helper fills `createdBy` only when it is EMPTY, so a name chosen here
  // survives the save untouched while `lastEditedBy` is re-stamped as usual.
  //
  // Pick-from-roster, never free text: the list's "Added by me" chip compares with
  // `===` against `Member.name`, so a typo, a trimmed variant or a uid would
  // silently stop matching. `lastEditedBy` deliberately gets no control at all —
  // a field recording the last edit that you can type into contradicts itself.
  // And none of this gates anything: attribution is a record, not a permission.
  const rosterNames = $derived($members.map((m) => m.name));

  // A `createdBy` that is not on the roster — a member since removed, a name from
  // another environment — is carried as an extra option rather than dropped. The
  // trigger is driven by the draft, so an unlisted value would still be shown and
  // still be saved; listing it means the picker can also be OPENED on it without
  // the current record vanishing from the choices, and correcting it stays a
  // decision rather than a side effect of visiting the editor.
  //
  // De-duplicated because the NAME is the identity here, not the member id: two
  // members called the same thing are one option, exactly as they are one answer
  // to "added by me" on the list. Both the `Set` and the `{#each}` key operate on
  // the FULL name — the option LABELS are shortened to first names for reading
  // (a household shares a surname), but shortening the identity would collapse
  // two genuinely different people into one option and one stored value.
  const authorOptions = $derived([
    ...new Set(draft.createdBy ? [...rosterNames, draft.createdBy] : rosterNames),
  ]);

  // Nothing to pick from is not a control: an empty roster (still loading, or a
  // permission-denied stream) would otherwise render a dropdown that opens on
  // nothing.
  const showAddedBy = $derived(editingId !== null && authorOptions.length > 0);

  // ─── "This recipe makes…" (produces canon link) ─────────────────────────────
  // A searchable picker over the canon store: link this recipe to the grocery
  // item it produces (e.g. a Mayonnaise recipe makes "Mayonnaise"), or clear it.
  // Items are {value: canonId, label: name}; the filter also matches synonyms via
  // a lowercased name+synonyms index. The picker is remounted via `{#key}` on the
  // selection so an external change — the blank→hydrated draft on a cold deep
  // link, or the Clear button — re-initialises the input label (the Combobox only
  // syncs its input from `value` at mount).
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
  const producesKey = $derived(
    `${draft.producesCanonId ?? ''}|${canonComboItems.some((i) => i.value === draft.producesCanonId)}`,
  );
  function setProduces(canonId: string): void {
    draft = { ...draft, producesCanonId: canonId };
  }
  function clearProduces(): void {
    draft = { ...draft, producesCanonId: null };
  }

  // ─── Components: the dishes this dinner is made of (issue #752) ──────────────
  // A meal is an ordinary recipe that points at other recipes, so all of this
  // mutates the DRAFT and nothing else — it is saved by the page's existing save
  // path, with the page's existing dirty tracking, and there is no second write.
  //
  // Candidates: anything that is not this recipe (`canBeComponentOf` — a dish
  // inside itself is the one meaningless relationship), not already attached, and
  // COOKABLE. A component is a dish you make, which is exactly `recipe` and
  // `cocktail`; an outing is eaten and a placeholder is a photograph, so neither
  // has anything to contribute to a dinner.
  const componentPickerItems: ComboboxItemType[] = $derived(
    $recipes
      .filter(
        (r) =>
          canBeComponentOf(draft.id, r.id) &&
          !draft.componentRecipeIds.includes(r.id) &&
          isCookable(kindOf(r)),
      )
      .map((r) => ({ value: r.id, label: r.title })),
  );

  function componentFilter(input: string, item: ComboboxItemType): boolean {
    return item.label.toLowerCase().includes(input.trim().toLowerCase());
  }

  // Remount key: bumped after each attach so the Combobox input clears — it only
  // syncs its label from `value` at mount, exactly as the produces picker above
  // and the planner's recipe picker both handle it.
  let componentPickerKey = $state(0);

  // The attached dishes, resolved for display. An id whose recipe was deleted
  // elsewhere resolves to nothing and is skipped, so the row never breaks; one
  // level only, so a component's own components are neither shown nor read.
  const componentRecipes = $derived(resolveComponents(draft, $recipes));

  function addComponent(id: string): void {
    if (!id) return;
    // Position is domain policy — longest-cooking-first, with the self-reference
    // and already-attached guards folded in — so the page never computes an index.
    draft = {
      ...draft,
      componentRecipeIds: insertComponentByElapsedTime(
        draft.id,
        draft.componentRecipeIds,
        id,
        $recipes,
      ),
    };
    componentPickerKey += 1;
  }

  function removeComponent(id: string): void {
    draft = {
      ...draft,
      componentRecipeIds: draft.componentRecipeIds.filter((c) => c !== id),
    };
  }

  // The drag order IS the stored order — the cook's own running order, which no
  // later attach re-sorts. `SortableList` hands back the new id order directly,
  // and it is taken verbatim.
  function reorderComponents(orderedIds: string[]): void {
    draft = { ...draft, componentRecipeIds: orderedIds };
  }

  // ─── Ingredient-group helpers ─────────────────────────────────────────────────
  function setGroups(groups: IngredientGroup[]): void {
    draft = { ...draft, ingredients: groups };
  }

  function addGroup(): void {
    setGroups([...draft.ingredients, emptyIngredientGroup(crypto.randomUUID())]);
  }

  function removeGroup(groupId: string): void {
    setGroups(draft.ingredients.filter((g) => g.id !== groupId));
  }

  function moveGroup(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= draft.ingredients.length) return;
    const groups = [...draft.ingredients];
    const [g] = groups.splice(index, 1);
    groups.splice(target, 0, g!);
    setGroups(groups);
  }

  function setGroupName(groupId: string, name: string): void {
    const trimmed = name.trim();
    setGroups(
      draft.ingredients.map((g) =>
        g.id === groupId ? { ...g, name: trimmed === '' ? null : trimmed } : g,
      ),
    );
  }

  function updateGroupItems(groupId: string, items: Ingredient[]): void {
    setGroups(draft.ingredients.map((g) => (g.id === groupId ? { ...g, items } : g)));
  }

  function addIngredient(group: IngredientGroup): void {
    updateGroupItems(group.id, [...group.items, newIngredient(crypto.randomUUID(), '')]);
  }

  function removeIngredient(group: IngredientGroup, ingredientId: string): void {
    updateGroupItems(
      group.id,
      group.items.filter((i) => i.id !== ingredientId),
    );
  }

  function setIngredientRawText(
    group: IngredientGroup,
    ingredientId: string,
    rawText: string,
  ): void {
    updateGroupItems(
      group.id,
      group.items.map((i) => {
        if (i.id !== ingredientId) return i;
        if (i.rawText === rawText) return i;
        return { ...clearIngredientMatch(i), rawText };
      }),
    );
  }

  function setIngredientOptional(
    group: IngredientGroup,
    ingredientId: string,
    isOptional: boolean,
  ): void {
    updateGroupItems(
      group.id,
      group.items.map((i) => (i.id === ingredientId ? { ...i, isOptional } : i)),
    );
  }

  // ─── Phase helpers (issue #1212) ────────────────────────────────────────────
  // The hand editor for the timing strip. Deliberately the SAME plain row editor
  // as the method steps above — add / remove / move up / move down — because the
  // model gets the strip right often enough that most recipes are never touched,
  // and a rarely-used editor is the wrong place to spend a week on drag-and-drop.
  //
  // A phase has no id (`RecipePhaseSchema` is settled: label + two minute figures
  // and nothing else), so rows are addressed by INDEX rather than keyed. That is
  // sound here because every mutation below rebuilds the whole array from
  // `draft.metadata.phases` in one go — there is no per-row identity to preserve
  // across a reorder, and the fields are re-read from the array on every render.
  //
  // TWO minute fields per row, never three: elapsed time is
  // `handsOnMinutes + handsOffMinutes` computed at the point of use, and is never
  // stored (issue #1122). Nothing here reads `label` for meaning — the cook may
  // type anything into it.
  const draftPhases = $derived(draft.metadata.phases ?? []);

  function setPhases(phases: RecipePhase[]): void {
    setMetadata({ phases });
  }

  function addPhaseRow(): void {
    setPhases([...draftPhases, { label: '', handsOnMinutes: 0, handsOffMinutes: 0 }]);
  }

  function removePhase(index: number): void {
    setPhases(draftPhases.filter((_, i) => i !== index));
  }

  function movePhase(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= draftPhases.length) return;
    const phases = [...draftPhases];
    const [p] = phases.splice(index, 1);
    phases.splice(target, 0, p!);
    setPhases(phases);
  }

  function updatePhase(index: number, patch: Partial<RecipePhase>): void {
    setPhases(draftPhases.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  // Whole non-negative minutes, and nothing stricter (the spec's own bound). An
  // empty or unparseable box means 0 rather than `null`: unlike Servings, a phase
  // minute figure is REQUIRED by the schema, and 0 is a real answer — a prove has
  // no hands-on time at all.
  function phaseMinutesOrZero(value: string): number {
    const n = parseNumberOrNull(value);
    if (n === null || n < 0) return 0;
    return Math.floor(n);
  }

  // The cap is INBOUND ONLY (issue #1123). It stops this editor ADDING a seventh
  // block; it never truncates, hides or refuses a stored strip that already has
  // one, which still renders row for row and stays fully editable.
  const canAddPhase = $derived(draftPhases.length < MAX_RECIPE_PHASES);

  // ─── Step helpers ───────────────────────────────────────────────────────────
  function setSteps(steps: Step[]): void {
    draft = { ...draft, steps };
  }

  function addStepRow(): void {
    setSteps([...draft.steps, newStep(crypto.randomUUID(), '')]);
  }

  function removeStep(stepId: string): void {
    setSteps(draft.steps.filter((s) => s.id !== stepId));
  }

  function moveStep(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= draft.steps.length) return;
    const steps = [...draft.steps];
    const [s] = steps.splice(index, 1);
    steps.splice(target, 0, s!);
    setSteps(steps);
  }

  function setStepText(stepId: string, text: string): void {
    setSteps(draft.steps.map((s) => (s.id === stepId ? { ...s, text } : s)));
  }

  function toggleStepTimer(stepId: string, on: boolean): void {
    setSteps(
      draft.steps.map((s) =>
        s.id === stepId
          ? { ...s, timer: on ? { durationMinutes: 0, description: null } : null }
          : s,
      ),
    );
  }

  // Deliberately NOT `phaseMinutesOrZero`: that one floors and clamps negatives
  // and this one never has. Issue #1221 moved where the parse is CALLED FROM, not
  // what it does — a step timer that accepted `-5` before still does, and tying
  // the two rules together is a behaviour change for a different issue.
  function stepTimerMinutes(value: string): number {
    return parseNumberOrNull(value) ?? 0;
  }

  function setStepTimerMinutes(stepId: string, minutes: number): void {
    setSteps(
      draft.steps.map((s) =>
        s.id === stepId && s.timer ? { ...s, timer: { ...s.timer, durationMinutes: minutes } } : s,
      ),
    );
  }

  function setStepTimerDescription(stepId: string, value: string): void {
    const trimmed = value.trim();
    setSteps(
      draft.steps.map((s) =>
        s.id === stepId && s.timer
          ? { ...s, timer: { ...s.timer, description: trimmed === '' ? null : trimmed } }
          : s,
      ),
    );
  }

  function setStepNote(stepId: string, value: string): void {
    const trimmed = value.trim();
    setSteps(
      draft.steps.map((s) =>
        s.id === stepId ? { ...s, note: trimmed === '' ? null : trimmed } : s,
      ),
    );
  }

  // ─── Per-row match ───────────────────────────────────────────────────────────
  let matchingIds = $state<Record<string, boolean>>({});

  async function handleMatchIngredient(group: IngredientGroup, ing: Ingredient): Promise<void> {
    if (matchingIds[ing.id]) return;
    matchingIds = { ...matchingIds, [ing.id]: true };
    const result = await matchIngredient(ing);
    matchingIds = { ...matchingIds, [ing.id]: false };
    if (result.kind !== 'ok') {
      addToast('Failed to match ingredient.', 'destructive');
      return;
    }
    // Discard stale result if text was edited while the match was in flight.
    const currentGroup = draft.ingredients.find((g) => g.id === group.id);
    if (!currentGroup) return;
    const currentIng = currentGroup.items.find((i) => i.id === ing.id);
    if (!currentIng || currentIng.rawText !== ing.rawText) return;
    updateGroupItems(
      group.id,
      currentGroup.items.map((i) => (i.id === ing.id ? result.value : i)),
    );
  }

  // ─── Notes editing (issue #717) ──────────────────────────────────────────────
  // Both are view state only — the text itself lives in `draft.notes`, so
  // flipping to preview and back cannot lose an edit. `notesEl` is the
  // textarea the formatting toolbar acts on; it is re-bound whenever the
  // textarea is re-created by the mode switch, and is undefined in preview.
  let notesMode = $state<'edit' | 'preview'>('edit');
  let notesEl = $state<HTMLTextAreaElement | undefined>(undefined);

  // ─── AI parse ────────────────────────────────────────────────────────────────
  let showPasteArea = $state(false);
  let pasteText = $state('');
  let parsing = $state(false);

  async function handleParse(): Promise<void> {
    if (parsing || pasteText.trim() === '') return;
    parsing = true;
    const result = await parseIngredients(pasteText);
    parsing = false;
    if (result.kind !== 'ok') {
      addToast('Failed to parse ingredients.', 'destructive');
      return;
    }
    setGroups(result.value);
    showPasteArea = false;
    pasteText = '';
  }

  // ─── Save ─────────────────────────────────────────────────────────────────────
  let saving = $state(false);
  const canSave = $derived(draft.title.trim().length > 0);

  // Drop editor noise on save: ingredient rows with no rawText, groups left
  // empty once those are removed, and stepless steps. `rawText` itself is never
  // trimmed or rewritten — only blank rows are dropped, so the sacred original
  // of every kept ingredient survives verbatim.
  function pruneDraft(r: Recipe): Recipe {
    const ingredients = r.ingredients
      .map((g) => ({ ...g, items: g.items.filter((i) => i.rawText.trim() !== '') }))
      .filter((g) => g.items.length > 0);
    const steps = r.steps.filter((s) => s.text.trim() !== '' || s.note !== null);
    // Saving from the editor IS the human review (issue #616): a person read the
    // AI's output and committed it, so the unreviewed flag comes off. Dropped
    // rather than set false — absent means reviewed, matching the schema.
    const { needs_approval: _wasUnreviewed, ...reviewed } = r;
    return { ...reviewed, title: r.title.trim(), ingredients, steps };
  }

  async function handleSave(): Promise<void> {
    if (!canSave || saving) return;
    saving = true;
    const toSave: Recipe = pruneDraft(draft);
    const result = await persistRecipe(toSave);
    if (result.kind !== 'ok') {
      saving = false;
      addToast('Failed to save recipe.', 'destructive');
      return;
    }
    // Creation is a route-level fact (/recipes/new[/:kind] has no id) —
    // persistRecipe is a blind upsert and cannot tell create from edit. Meals
    // deliberately do NOT change this: "created by hand" still means the manual
    // route, whoever sent the user down it.
    if (editingId === null)
      trackUsageEvent('recipe.created', {
        recipe_id: toSave.id,
        recipe_kind: draftKind,
        recipe_method: 'manual',
      });

    // Came here from a meal? Then finishing this dish means hanging it off that
    // meal and going back to it (issue #752, Phase 3).
    //
    // Gated on the PARAM, never on `editingId === null`. Two of the four create
    // paths — URL import and photo import — persist server-side first and arrive
    // at `/recipes/{id}/edit?meal=…`, an EDIT route, so a first-save gate would
    // silently skip half the feature. Presence of the param IS the intent, and
    // `attachComponentToMeal` is idempotent, so re-saving the same editor
    // attaches once and costs nothing.
    const mealId = mealReturnId;
    if (mealId !== null) {
      const attached = await attachComponentToMeal(mealId, toSave.id);
      saving = false;
      if (attached.kind !== 'ok') {
        // The meal was deleted while the user was away writing the dish. The
        // dish itself is saved — that must not be lost to a failed attach — so
        // say what happened and land them on what they just wrote.
        addToast('Saved — but that meal is no longer in the library.', 'destructive');
        push(`/recipes/${toSave.id}`);
        return;
      }
      addToast(`${toSave.title} added to the meal.`, 'success');
      push(`/recipes/${mealId}`);
      return;
    }

    saving = false;
    const copy = KIND_COPY[draftKind];
    addToast(editingId === null ? copy.createdToast : copy.savedToast, 'success');
    push(`/recipes/${toSave.id}`);
  }

  function handleCancel(): void {
    goBack(editingId === null ? '/recipes' : `/recipes/${editingId}`);
  }

  const pageTitle = $derived(
    editingId === null ? KIND_COPY[draftKind].newTitle : KIND_COPY[draftKind].editTitle,
  );
</script>

<DetailPage title={pageTitle} onBack={handleCancel} backLabel="Back" class="p-4 sm:p-6">
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={handleCancel} disabled={saving}>Cancel</Button>
    <Button
      size="sm"
      onclick={handleSave}
      loading={saving}
      disabled={!canSave || saving}
      data-testid="recipe-save-btn"
    >
      Save
    </Button>
  {/snippet}

  <div class="flex flex-col gap-8" data-testid="recipe-editor">
    <!-- Basics -->
    <section class="flex flex-col gap-3">
      <TextField
        label="Title"
        placeholder="e.g. Spiced lentil dahl"
        value={draft.title}
        onValueChange={(v) => (draft = { ...draft, title: v })}
        required
        autofocus={openedFromStash}
        data-testid="recipe-title-input"
      />
      <Textarea
        label="Description"
        placeholder="A short description (optional)"
        value={draft.description ?? ''}
        onValueChange={(v) => (draft = { ...draft, description: v.trim() === '' ? null : v })}
        rows={2}
        autoresize
        data-testid="recipe-description-input"
      />
    </section>

    <!-- Made from (issue #752). Above Ingredients, mirroring the view page: what a
         Sunday roast is built from is the headline fact about it, and the
         ingredients below are the roast's own. Attaching a dish here is what turns
         an ordinary recipe into a meal — there is no "new meal" and no kind to
         pick, which is why this section is the whole of the feature's way in. -->
    {#if showComponents}
      <section class="flex flex-col gap-3" data-testid="recipe-components-editor">
        <div class="flex flex-col gap-1">
          <p class="text-sm font-medium">Made from</p>
          <p class="text-xs text-muted-foreground">
            Build a dinner out of dishes you already have — a roast is chicken, potatoes and gravy.
            They arrive longest-cooking first; drag to set your own running order. Each dish keeps
            its own ingredients and method.
          </p>
        </div>

        {#if componentRecipes.length > 0}
          <SortableList
            items={componentRecipes}
            getId={(r) => r.id}
            onReorder={reorderComponents}
            class="divide-y divide-border rounded border"
          >
            {#snippet row(component)}
              <div
                class="flex items-center gap-3 px-3 py-2"
                data-testid="recipe-component-row"
                data-recipe-id={component.id}
              >
                <span
                  class="cursor-grab text-muted-foreground"
                  data-testid={`recipe-component-drag-handle-${component.id}`}
                >
                  <Icon name="GripVertical" size={16} />
                </span>
                <span
                  class="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted text-muted-foreground/60"
                >
                  {#if component.image?.url}
                    <img
                      src={recipeHeroUrl(component)}
                      alt=""
                      loading="lazy"
                      class="h-full w-full object-cover"
                    />
                  {:else}
                    <span class="flex h-full w-full items-center justify-center">
                      <!-- The kind's own placeholder icon, as on the view page. -->
                      <Icon name={KIND_COPY[kindOf(component)].thumbIcon} size={16} />
                    </span>
                  {/if}
                </span>
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate text-sm font-medium">{component.title}</span>
                  {#if componentTimeLabel(component) !== null}
                    <span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Icon name="Clock" size={12} />
                      {componentTimeLabel(component)}
                    </span>
                  {/if}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => removeComponent(component.id)}
                  aria-label={`Remove ${component.title}`}
                  data-testid={`recipe-component-remove-${component.id}`}
                >
                  <Icon name="X" size={16} />
                </Button>
              </div>
            {/snippet}
          </SortableList>
        {/if}

        {#key componentPickerKey}
          <Combobox
            items={componentPickerItems}
            value=""
            filterFn={componentFilter}
            restrict
            placeholder="Add a dish…"
            onValueChange={addComponent}
          >
            <ComboboxField>
              <ComboboxInput data-testid="recipe-component-picker" />
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
      </section>
    {/if}

    <!-- Ingredient groups. Absent entirely for a kind that takes no ingredients
         (a takeaway has none to list) — an empty section you can add rows to
         would invite filling in something the rest of the app never reads. -->
    {#if showIngredients}
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium">Ingredients</p>
          <div class="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onclick={() => (showPasteArea = !showPasteArea)}
              data-testid="recipe-parse-toggle-btn"
            >
              {#snippet leading()}<Icon name="Wand" size={16} />{/snippet}
              Parse from text
            </Button>
            <Button
              variant="outline"
              size="sm"
              onclick={addGroup}
              data-testid="recipe-add-group-btn"
            >
              {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
              Add group
            </Button>
          </div>
        </div>

        {#if showPasteArea}
          <div
            class="flex flex-col gap-2 rounded border border-border bg-muted/50 p-3"
            data-testid="recipe-parse-area"
          >
            <p class="text-sm text-muted-foreground">
              Paste an ingredient list. The AI will detect groups and structure each ingredient
              while preserving the original text.
            </p>
            <Textarea
              label="Ingredient list"
              placeholder="e.g. 1 cup plain flour, sifted&#10;2 eggs&#10;&#10;For the sauce:&#10;2 cloves garlic, crushed"
              value={pasteText}
              onValueChange={(v) => (pasteText = v)}
              rows={6}
              autoresize
              data-testid="recipe-parse-text-input"
            />
            <div class="flex gap-2">
              <Button
                size="sm"
                onclick={handleParse}
                loading={parsing}
                disabled={pasteText.trim() === '' || parsing}
                data-testid="recipe-parse-btn"
              >
                Parse
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onclick={() => {
                  showPasteArea = false;
                  pasteText = '';
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        {/if}

        {#if draft.ingredients.length === 0}
          <p class="text-sm text-muted-foreground">
            No ingredient groups yet. Add a group to start entering ingredients.
          </p>
        {/if}

        {#each draft.ingredients as group, gIdx (group.id)}
          <div
            class="flex flex-col gap-3 rounded border border-border bg-card p-3"
            data-testid="recipe-group"
            data-group-id={group.id}
          >
            <div class="flex items-end gap-2">
              <TextField
                label="Group name"
                placeholder="e.g. For the sauce (leave blank for the main list)"
                value={group.name ?? ''}
                onValueChange={(v) => setGroupName(group.id, v)}
                class="flex-1"
                data-testid="recipe-group-name-input"
              />
              <Button
                variant="ghost"
                size="sm"
                onclick={() => moveGroup(gIdx, -1)}
                disabled={gIdx === 0}
                aria-label="Move group up"
              >
                <Icon name="ChevronUp" size={16} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onclick={() => moveGroup(gIdx, 1)}
                disabled={gIdx === draft.ingredients.length - 1}
                aria-label="Move group down"
              >
                <Icon name="ChevronDown" size={16} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onclick={() => removeGroup(group.id)}
                aria-label="Remove group"
                data-testid="recipe-remove-group-btn"
              >
                <Icon name="Trash2" size={16} />
              </Button>
            </div>

            {#each group.items as ingredient (ingredient.id)}
              <div
                class="flex items-center gap-2"
                data-testid="recipe-ingredient"
                data-ingredient-id={ingredient.id}
              >
                <TextField
                  label="Ingredient"
                  placeholder="e.g. 1 ½ cups plain flour, sifted"
                  value={ingredient.rawText}
                  onValueChange={(v) => setIngredientRawText(group, ingredient.id, v)}
                  class="flex-1"
                  data-testid="recipe-ingredient-input"
                />
                {#if ingredient.rawText.trim() !== '' && !hasLiveCanonMatch(ingredient, liveCanonIds)}
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => handleMatchIngredient(group, ingredient)}
                    loading={matchingIds[ingredient.id] ?? false}
                    disabled={matchingIds[ingredient.id] ?? false}
                    aria-label="Not matched — tap to match this ingredient"
                    title="Not matched — tap to match this ingredient"
                    class="shrink-0 text-destructive"
                    data-testid="recipe-ingredient-match-btn"
                  >
                    <Icon name="CircleX" size={16} />
                  </Button>
                {/if}
                <Switch
                  label="Optional"
                  checked={ingredient.isOptional}
                  onCheckedChange={(c) => setIngredientOptional(group, ingredient.id, c)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => removeIngredient(group, ingredient.id)}
                  aria-label="Remove ingredient"
                >
                  <Icon name="X" size={16} />
                </Button>
              </div>
            {/each}

            <Button
              variant="ghost"
              size="sm"
              onclick={() => addIngredient(group)}
              class="self-start"
              data-testid="recipe-add-ingredient-btn"
            >
              {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
              Add ingredient
            </Button>
          </div>
        {/each}
      </section>
    {/if}

    <!-- Steps. Gated on the same capability as the Cook button and the timings:
         an outing is eaten, not cooked, so there is no method to write. -->
    {#if showCooking}
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium">Method</p>
          <Button
            variant="outline"
            size="sm"
            onclick={addStepRow}
            data-testid="recipe-add-step-btn"
          >
            {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
            Add step
          </Button>
        </div>

        {#if draft.steps.length === 0}
          <p class="text-sm text-muted-foreground">No steps yet.</p>
        {/if}

        {#each draft.steps as step, sIdx (step.id)}
          <div
            class="flex flex-col gap-2 rounded border border-border bg-card p-3"
            data-testid="recipe-step"
            data-step-id={step.id}
          >
            <div class="flex items-start gap-2">
              <span class="mt-2 text-sm font-medium text-muted-foreground">{sIdx + 1}.</span>
              <Textarea
                label="Step"
                placeholder="Describe this step"
                value={step.text}
                onValueChange={(v) => setStepText(step.id, v)}
                rows={2}
                autoresize
                class="flex-1"
                data-testid="recipe-step-input"
              />
              <div class="flex flex-col">
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => moveStep(sIdx, -1)}
                  disabled={sIdx === 0}
                  aria-label="Move step up"
                >
                  <Icon name="ChevronUp" size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => moveStep(sIdx, 1)}
                  disabled={sIdx === draft.steps.length - 1}
                  aria-label="Move step down"
                >
                  <Icon name="ChevronDown" size={16} />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onclick={() => removeStep(step.id)}
                aria-label="Remove step"
              >
                <Icon name="Trash2" size={16} />
              </Button>
            </div>

            <div class="flex items-center gap-3 pl-6">
              <Switch
                label="Timer"
                checked={step.timer !== null}
                onCheckedChange={(c) => toggleStepTimer(step.id, c)}
              />
              {#if step.timer}
                <MinutesField
                  label="Minutes"
                  value={step.timer.durationMinutes}
                  parse={stepTimerMinutes}
                  onValueChange={(m) => setStepTimerMinutes(step.id, m)}
                  class="w-28"
                  data-testid="recipe-step-timer-minutes"
                />
                <TextField
                  label="Timer label"
                  placeholder="e.g. until golden"
                  value={step.timer.description ?? ''}
                  onValueChange={(v) => setStepTimerDescription(step.id, v)}
                  class="flex-1"
                  data-testid="recipe-step-timer-description"
                />
              {/if}
            </div>

            <div class="pl-6">
              <Textarea
                label="Note (optional)"
                placeholder="Any note for this step"
                value={step.note ?? ''}
                onValueChange={(v) => setStepNote(step.id, v)}
                rows={2}
                autoresize
                data-testid="recipe-step-note-input"
              />
            </div>
          </div>
        {/each}
      </section>
    {/if}

    <!-- Metadata -->
    <section class="flex flex-col gap-3">
      <p class="text-sm font-medium">Details</p>
      <!-- Servings and timings only where they mean something. Source URL and
           "makes…" below stay: a takeaway can still have a menu page it came
           from. -->
      {#if showCooking}
        <!-- Servings alone. The Prep / Cook / Total boxes that stood beside it are
             gone as of issue #1233: the phase strip below is now the only timing
             control anywhere in Salt, and the cook plan works its start times back
             from it. The grid columns are kept so the box keeps the width it has
             always had rather than stretching across the card. -->
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <TextField
            label="Servings"
            inputmode="numeric"
            value={draft.metadata.servings === null ? '' : String(draft.metadata.servings)}
            onValueChange={(v) => setMetadata({ servings: positiveOrNull(parseNumberOrNull(v)) })}
            data-testid="recipe-servings-input"
          />
        </div>
      {/if}

      <!-- Timing, as the cook actually experiences it: the phases in the order
           they happen, each with how long it lasts and how much of that is you at
           the counter (issue #1212). Ungated as of issue #1213, and the only
           timing control shown for cook duration itself — Prep/Cook/Total above
           still cover what `scheduleFor` and the "Made from" ordering read. -->
      {#if showCooking}
        <section class="flex flex-col gap-3" data-testid="recipe-phase-editor">
          <div class="flex items-center justify-between">
            <p class="text-sm font-medium">Timing</p>
            {#if canAddPhase}
              <Button
                variant="outline"
                size="sm"
                onclick={addPhaseRow}
                data-testid="recipe-add-phase-btn"
              >
                {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
                Add phase
              </Button>
            {/if}
          </div>

          {#if draftPhases.length === 0}
            <p class="text-sm text-muted-foreground">No phases yet.</p>
          {/if}

          {#each draftPhases as phase, pIdx}
            <div
              class="flex flex-col gap-2 rounded border border-border bg-card p-3"
              data-testid="recipe-phase"
            >
              <div class="flex items-start gap-2">
                <span class="mt-2 text-sm font-medium text-muted-foreground">{pIdx + 1}.</span>
                <TextField
                  label="Phase"
                  placeholder="What happens in this block"
                  value={phase.label}
                  onValueChange={(v) => updatePhase(pIdx, { label: v })}
                  class="flex-1"
                  data-testid="recipe-phase-label-input"
                />
                <div class="flex flex-col">
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => movePhase(pIdx, -1)}
                    disabled={pIdx === 0}
                    aria-label="Move phase up"
                  >
                    <Icon name="ChevronUp" size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onclick={() => movePhase(pIdx, 1)}
                    disabled={pIdx === draftPhases.length - 1}
                    aria-label="Move phase down"
                  >
                    <Icon name="ChevronDown" size={16} />
                  </Button>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => removePhase(pIdx)}
                  aria-label="Remove phase"
                >
                  <Icon name="Trash2" size={16} />
                </Button>
              </div>

              <div class="grid grid-cols-2 gap-3 pl-6">
                <MinutesField
                  label="Hands-on (min)"
                  value={phase.handsOnMinutes}
                  parse={phaseMinutesOrZero}
                  onValueChange={(m) => updatePhase(pIdx, { handsOnMinutes: m })}
                  data-testid="recipe-phase-hands-on-input"
                />
                <MinutesField
                  label="Hands-off (min)"
                  value={phase.handsOffMinutes}
                  parse={phaseMinutesOrZero}
                  onValueChange={(m) => updatePhase(pIdx, { handsOffMinutes: m })}
                  data-testid="recipe-phase-hands-off-input"
                />
              </div>
            </div>
          {/each}
        </section>
      {/if}
      <!-- Source -->
      <TextField
        label="Source URL"
        type="url"
        placeholder="https://example.com/original-recipe (optional)"
        value={sourceUrl}
        onValueChange={setSourceUrl}
        data-testid="recipe-source-input"
      />
      <!-- Added by (issue #845). Beside Source because it is the same kind of
           fact: where this entry came from. Edit-only, and a roster pick rather
           than a text field — see the derivations above for why both. -->
      {#if showAddedBy}
        <div class="flex flex-col gap-1.5" data-testid="recipe-added-by">
          <p class="text-sm font-medium">Added by</p>
          <p class="text-xs text-muted-foreground">
            Who the library records as having added this. Put it right if it is wrong — it decides
            whose “Added by me” filter finds it, and nothing else.
          </p>
          <Select
            value={draft.createdBy}
            onValueChange={(v) => (draft = { ...draft, createdBy: v })}
          >
            <!-- The label is rendered here rather than left to the trigger's
                 default, as everywhere else in the app: `SelectItem`s only exist
                 while the listbox is open, so a closed Select has no registered
                 item to resolve `displayLabel` from. The empty branch carries the
                 same two channels as every other placeholder in Salt — colour and
                 italic (ui-spec-v03 §3.4). -->
            <SelectTrigger aria-label="Added by" data-testid="recipe-added-by-select">
              <span class={draft.createdBy ? 'text-foreground' : 'text-placeholder italic'}>
                {draft.createdBy ? memberFirstName(draft.createdBy) : 'Not recorded'}
              </span>
              <Icon name="ChevronDown" size={16} class="text-muted-foreground" />
            </SelectTrigger>
            <SelectContent>
              <!-- `value` and the key stay the VERBATIM `Member.name`; only the
                   label is shortened. What is stored, compared and de-duplicated
                   is the full name — see `authorOptions` above. -->
              {#each authorOptions as name (name)}
                <SelectItem value={name}>{memberFirstName(name)}</SelectItem>
              {/each}
            </SelectContent>
          </Select>
        </div>
      {/if}
      <!-- Produces: link this recipe to the grocery item it makes -->
      <div class="flex flex-col gap-1.5" data-testid="recipe-produces">
        <p class="text-sm font-medium">This recipe makes…</p>
        <p class="text-xs text-muted-foreground">
          Optionally link this recipe to the grocery item it produces (e.g. a Mayonnaise recipe
          makes “Mayonnaise”).
        </p>
        <div class="flex items-center gap-2">
          <div class="relative flex-1">
            {#key producesKey}
              <Combobox
                items={canonComboItems}
                value={draft.producesCanonId ?? ''}
                filterFn={canonFilter}
                restrict
                placeholder="Search grocery items…"
                onValueChange={setProduces}
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
            {/key}
          </div>
          {#if draft.producesCanonId}
            <Button
              variant="ghost"
              size="sm"
              onclick={clearProduces}
              data-testid="recipe-produces-clear"
            >
              Clear
            </Button>
          {/if}
        </div>
      </div>
      <!-- Tag picker -->
      <div class="flex flex-col gap-1.5">
        <p class="text-sm font-medium">Tags</p>
        <div
          class="flex min-h-9 flex-wrap items-center gap-1.5 rounded border border-input bg-background px-3 py-1.5 focus-within:ring-2 focus-within:ring-ring"
        >
          {#each draft.metadata.tags as tag (tag)}
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
            placeholder={draft.metadata.tags.length === 0 ? 'Add tags…' : ''}
            bind:value={tagInput}
            onkeydown={handleTagKeydown}
            data-testid="recipe-tags-input"
          />
        </div>
        {#if KIND_COPY[draftKind].tagsHint}
          <p class="text-xs text-muted-foreground" data-testid="recipe-tags-hint">
            {KIND_COPY[draftKind].tagsHint}
          </p>
        {/if}
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
    </section>

    <!-- Notes (issue #717). Notes render as Markdown on the view page, so the
         editor offers the three formats worth having without knowing the
         syntax, and a preview to check the result before saving. Preview
         renders through the same `<Markdown … breaks />` the view page uses, so
         the two cannot disagree. `draft.notes` stays a plain nullable string
         throughout — none of this touches the save path. -->
    <section class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm font-medium">Notes</p>
        <div class="flex items-center gap-1" role="group" aria-label="Notes mode">
          <Button
            size="sm"
            variant={notesMode === 'edit' ? 'solid' : 'ghost'}
            onclick={() => (notesMode = 'edit')}
            data-testid="recipe-notes-edit-btn"
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant={notesMode === 'preview' ? 'solid' : 'ghost'}
            onclick={() => (notesMode = 'preview')}
            data-testid="recipe-notes-preview-btn"
          >
            Preview
          </Button>
        </div>
      </div>

      {#if notesMode === 'edit'}
        <!-- The toolbar drives the textarea's DOM node, so it is rendered only
             beside a live one; in preview there is no selection to act on. -->
        <NotesFormattingToolbar element={notesEl} />
        <Textarea
          bind:element={notesEl}
          label="Notes"
          placeholder="Anything else worth remembering"
          value={draft.notes ?? ''}
          onValueChange={(v) => (draft = { ...draft, notes: v.trim() === '' ? null : v })}
          rows={3}
          autoresize
          data-testid="recipe-notes-input"
        />
      {:else}
        <div
          class="rounded-md border border-input px-4 py-2 min-h-9"
          data-testid="recipe-notes-preview"
        >
          {#if draft.notes}
            <Markdown text={draft.notes} breaks class="text-sm text-muted-foreground" />
          {:else}
            <p class="text-sm text-muted-foreground">Nothing to preview yet.</p>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</DetailPage>
