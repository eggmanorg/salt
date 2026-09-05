<script lang="ts">
  import {
    Button,
    CanonIcon,
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    Chip,
    DetailPage,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Divider,
    Icon,
    ImageCropper,
    Markdown,
    Popover,
    PopoverContent,
    PopoverMenuItem,
    PopoverTrigger,
    Spinner,
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
    Textarea,
    TextField,
    type ChipTone,
    type IconName,
    type ImageCropperHandle,
  } from '@salt/ui-components';
  import { tick } from 'svelte';
  import { push } from 'svelte-spa-router';
  import { trackUsageEvent } from '@salt/observability';
  // The ⋮ menu's two canned chef turns, declared here until #934. They moved into
  // `@salt/domain/prompts` because Refresh states the step policy `stepRules.ts`
  // also states, and rule 6 leaves a sentence both must carry no home in either
  // package. They are still sent from here, as ordinary user turns, unchanged.
  import { OPTIMISE_FOR_KITCHEN_PROMPT, REFRESH_PROMPT } from '@salt/domain/prompts';
  import { goBack } from '../../lib/nav.js';
  import { breadGate } from '../../lib/featureGate.js';
  import { withMealParam } from '../../lib/mealReturn.js';
  import {
    recipes,
    isLoadingRecipes,
    removeRecipe,
    canonicaliseIngredients,
    matchIngredient,
    persistRecipe,
    stashImportedDraft,
    regenerateRecipeImage,
    redoRecipeKit,
    reviseRecipeSceneBrief,
    startOverRecipeSceneBrief,
    setRecipeImageUpload,
  } from '../../lib/recipeService.js';
  import RecipeImportPhotoDialog from './RecipeImportPhotoDialog.svelte';
  import RecipeImportUrlDialog from './RecipeImportUrlDialog.svelte';
  import RecipeAddToListSheet from './RecipeAddToListSheet.svelte';
  import RecipeAddToPlannerSheet from './RecipeAddToPlannerSheet.svelte';
  import RecipeBakeBatchSheet from './RecipeBakeBatchSheet.svelte';
  import IngredientMatchSheet from './IngredientMatchSheet.svelte';
  import RecipeChangeSummary from './RecipeChangeSummary.svelte';
  import RecipePhaseTimeline from './RecipePhaseTimeline.svelte';
  import { componentTimeLabel } from './recipeTiming.js';
  import RecipeChatList from './RecipeChatList.svelte';
  import RecipeChatDrawer from './RecipeChatDrawer.svelte';
  import { chatsForRecipe } from './recipeChats.js';
  import {
    proposeRecipeAmendment,
    applyRecipeAmendment,
    type RecipeAmendment,
  } from '../../lib/recipeAmend.js';
  import { authorRecipeFromChat } from '../../lib/chatRecipeAuthor.js';
  import IngredientText from './IngredientText.svelte';
  import { canonItems, isLoadingAisles } from '../../lib/canonService.js';
  import { canonIndex, matchMarkersReady } from '../../lib/canonIndex.js';
  // The ONE shared kitchen-tool lookup (issue #882). Subscribed app-wide in
  // App.svelte, so there is nothing to initialise here — and it is a store rather
  // than a plain function precisely so the pictures fill in the moment the drawn
  // vocabulary lands, which on a cold load is after first paint.
  import { kitIcons } from '../../lib/kitIcons.js';
  import { productForms, isLoadingProductForms } from '../../lib/productFormService.js';
  import {
    recipeHeroUrl,
    recipePhaseTotals,
    duplicateRecipe,
    firstUseByStep as groupIngredientsByFirstUse,
    flattenIngredients,
    hasComponents,
    hasLiveCanonMatch,
    ingredientMatchIssue,
    isAuthorable,
    isCookable,
    isPlannable,
    kitByStep as groupKitByStep,
    groupKitByEquipment,
    looksScalable,
    resolveComponents,
    takesIngredients,
    type IngredientGroup,
    memberFirstName,
    type Ingredient,
    type Recipe,
    type Step,
  } from '@salt/domain';
  import { KIND_COPY, kindOf } from './recipeKind.js';
  import { formatMinutes } from '../../lib/durationDisplay.js';
  import { SPLIT_QUERY, createMediaQuery } from '../../lib/mediaQuery.svelte.js';
  import { recipeChatPanePrefs } from '../../lib/recipeChatPanePrefs.svelte.js';
  import type { ChatSessionDoc } from '@salt/domain/schemas';
  import type { DomainError, ReadResult } from '@salt/shared-types';
  import { guidedPlan, initGuidedPlanSync } from '../../lib/guidedPlanService.js';
  import { formula, initFormulaSync } from '../../lib/formulaService.js';
  import { currentMember } from '../../lib/membersService.js';
  import { defaultListId } from '../../lib/shoppingListService.svelte.js';
  import { addToast } from '../../lib/toastStore.js';
  import { auth } from '../../lib/auth.svelte.js';
  import { createChatSession, sessions } from '../../lib/chatService.js';
  import ImagePromptDialog from '../../components/ImagePromptDialog.svelte';
  import ChatThread from '../chat/ChatThread.svelte';
  import { createChatThread } from '../chat/chatThreadState.svelte.js';
  import { equipment } from '../../lib/equipmentService.js';
  import {
    clipboardImageReadSupported,
    readClipboardImage,
    imageFromClipboardData,
  } from '../../lib/clipboardImage.js';

  interface Props {
    params: { id: string };
  }
  let { params }: Props = $props();

  const recipe = $derived($recipes.find((r) => r.id === params.id) ?? null);

  // Outbound link to the original recipe, only for url-sourced (imported) recipes
  // with a non-empty url. Manual/legacy recipes (source null) render nothing.
  const sourceUrl = $derived(
    recipe?.source?.type === 'url' && (recipe.source.url ?? '').trim() !== ''
      ? recipe.source.url!
      : null,
  );

  // "Makes: <name>" chip — resolve the produces canon link to its display name.
  // null when the recipe isn't linked or the canon item has since been deleted.
  const producesCanonName = $derived(
    recipe?.producesCanonId
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
    !recipe?.createdBy
      ? null
      : recipe.lastEditedBy && recipe.lastEditedBy !== recipe.createdBy
        ? `Added by ${memberFirstName(recipe.createdBy)} · edited by ${memberFirstName(recipe.lastEditedBy)}`
        : `Added by ${memberFirstName(recipe.createdBy)}`,
  );

  // What this entry can do (issue #637). Everything that gates a section or an
  // action on this page reads one of these two — never the kind itself. Both are
  // false while the recipe is still loading, which is the conservative side: a
  // Cook button that appears and then vanishes is worse than one that arrives
  // with the content it belongs to.
  const showIngredients = $derived(recipe !== null && takesIngredients(kindOf(recipe)));
  const showCooking = $derived(recipe !== null && isCookable(kindOf(recipe)));
  // The two halves of the recipe body are tabs (issue #878). They are always
  // both-or-neither: in the capability table `takesIngredients` and `isCookable`
  // agree for all four kinds, so there is no one-tab state to design for — a
  // recipe and a cocktail get the strip, an outing and a placeholder get no body
  // at all (and, per `e2e/recipe-alternatives`, neither word anywhere on the page).
  const showBodyTabs = $derived(showIngredients && showCooking);
  // Ingredients is the landing tab, and deliberately NOT the first one in the
  // strip: Equipment sits left of it because the strip reads in the order you do
  // the job — get the kit out, weigh the things, cook — while the tab you LAND on
  // answers the question you actually arrive with, which is whether you have the
  // ingredients. Kit is what you check once you have decided to cook it.
  // `$state`, not `$derived`, because the page moves it itself when the chat
  // drawer opens (`scrollRecipeToBody`).
  let bodyTab = $state('ingredients');
  // The count on the Ingredients tab is the number of LINES you will read, so it
  // flattens the groups — a recipe in three named groups is still nineteen
  // ingredients. Method's count is `steps.length` and needs no helper.
  const ingredientCount = $derived(recipe ? flattenIngredients(recipe).length : 0);
  // "Add to planner" offers this entry for a night, which is the same question
  // the planner's own picker asks — so it answers with the same predicate. A
  // cocktail is not dinner and a placeholder is attached, never chosen; neither
  // gets the button here, exactly as neither appears in the picker there.
  const showPlanning = $derived(recipe !== null && isPlannable(kindOf(recipe)));
  // TWO ⋮ items ask this one question, in two different groups: "Make a
  // variation" hands the dish to the librarian as the starting point for a new
  // one (issue #763), and "Refresh" hands it over to be re-transcribed (issue
  // #784). Neither is asking whether the action suits the kind — both are asking
  // whether the librarian can WRITE this kind at all, which is exactly
  // `isAuthorable`. Hence one predicate and no fifth capability: when
  // `isAuthorable` gains a kind (cocktails, #765) both items appear there with
  // no edit here.
  const canAuthor = $derived(recipe !== null && isAuthorable(kindOf(recipe)));

  // ─── The dishes this dinner is made of (issue #752) ─────────────────────────
  // Display only — attaching, reordering and removing all live in the editor,
  // because they are edits to the document and belong with every other one.
  //
  // Resolved against the same in-memory `recipes` store the rest of the page
  // reads, so an id whose recipe has been deleted elsewhere simply produces one
  // card fewer: `resolveComponents` skips what it cannot find rather than
  // rendering a row nobody can act on. ONE LEVEL ONLY — a component's own
  // components are not shown and are not read, which is what makes a cycle inert.
  const components = $derived(recipe === null ? [] : resolveComponents(recipe, $recipes));
  // The section appears for a MEAL, not for anything that could become one, and
  // the question is asked of the document rather than of the resolved list: a meal
  // all of whose components have been deleted still says it is a meal, and saying
  // so with an empty list is more honest than pretending the field is not there.
  const showComponents = $derived(recipe !== null && hasComponents(recipe));

  // ─── Adding another dish to this meal (issue #752, Phase 3) ─────────────────
  // All four ways of making a recipe, offered FROM the meal: import a link,
  // photograph a page, chat one up, or write it out. Each carries this meal's id
  // in the URL it navigates to (`?meal=<id>`, see lib/mealReturn.ts), and the
  // save at the far end attaches what it produced and comes back here.
  //
  // Gated on `showComponents` with the card, deliberately: this surface adds
  // ANOTHER dish to something that is already a meal. Turning an ordinary recipe
  // into one in the first place stays in the editor's "Made from" picker, where
  // Phase 1 put it.
  //
  // It lives on the VIEW page and not the editor for two reasons: leaving the
  // editor mid-flow would silently bin an unsaved draft of the meal, and "land
  // back on the meal" means this page — so the round trip starts and ends in the
  // same place.
  let componentMenuOpen = $state(false);
  let showComponentUrlImport = $state(false);
  let showComponentPhotoImport = $state(false);

  // Both imports are already PERSISTED by their callable (issue #616), flagged
  // unreviewed, so the hand-off is exactly the list page's: stash the draft so
  // the editor paints without waiting for the Firestore listener, then open that
  // recipe's editor — carrying the meal, which is the only difference.
  function openComponentEditor(imported: Recipe, method: 'url' | 'photo'): void {
    if (recipe === null) return;
    trackUsageEvent('recipe.created', {
      recipe_id: imported.id,
      recipe_kind: imported.kind,
      recipe_method: method,
    });
    stashImportedDraft(imported);
    showComponentUrlImport = false;
    showComponentPhotoImport = false;
    // If navigation itself fails, surface it rather than silently closing: the
    // recipe exists either way, so the user isn't stranded. Same as the list page.
    try {
      push(withMealParam(`/recipes/${imported.id}/edit`, recipe.id));
    } catch {
      addToast('Could not open the editor — please try again.', 'destructive');
    }
  }

  function startComponent(path: string): void {
    if (recipe === null) return;
    componentMenuOpen = false;
    push(withMealParam(path, recipe.id));
  }

  // ─── Does this recipe have a guided plan? (issue #751, Phase 2) ──────────────
  // Subscribed here so the action row can offer "Cook, guided" only where there is
  // something to be guided BY. There is no all-plans subscription anywhere in the
  // app — a plan is read one recipe at a time — so this is the only way to answer
  // the question, and it is answered on the page that asks it.
  //
  // The store is a module singleton the plan editor also drives, and every `init`
  // resets it to the not-loaded state first, so the two pages can never show each
  // other's plan. Its three states are load-bearing here for the same reason
  // `showCooking` is conservative: `undefined` means "not loaded", and rendering
  // the button on it would flash an action that then vanishes.
  $effect(() => {
    const id = params.id;
    if (!id) return;
    return initGuidedPlanSync(id);
  });
  const hasGuidedPlan = $derived($guidedPlan !== null && $guidedPlan !== undefined);
  // Used-but-flagged, never a gate (guidedPlan.ts): the plan is fully live either
  // way, and this only records that no human has read it. Absent means reviewed.
  const guidedPlanUnread = $derived($guidedPlan?.needs_approval === true);

  // ─── Does this recipe have a formula? (issue #812, phase 1 of epic #778) ─────
  //
  // PRESENCE, NOT KIND, and the distinction is the rule that keeps
  // `capabilities.ts` four columns wide: capabilities answer questions about the
  // KIND ("is this offered in the planner?"), presence answers questions about the
  // DOCUMENT ("does this have a formula?"). A loaf is an ordinary `recipe` — there
  // is no `bread` kind and there will not be one
  // (docs/formulas-schedules-batches.md) — so nothing here consults `kindOf`, and
  // nothing was added to the capability table for it.
  //
  // Subscribed here for the same reason the guided plan is: there is no all-formulas
  // subscription anywhere in the app, a formula is read one recipe at a time, and
  // this is the page that asks the question. The store's three states matter — with
  // `undefined` folded into "has one", both entries below would flash and vanish on
  // every recipe that has no formula, which is nearly all of them.
  //
  // GATED WHILE THE FEATURE IS BEING BUILT (issue #831). The gate sits on the
  // subscription rather than only on the two menu entries, so someone outside the
  // test group never reads `formulas/*` at all — the flag is cosmetic, but there
  // is no reason to spend a listener on an answer that can only be discarded.
  const breadEnabled = $derived($breadGate.enabled);
  $effect(() => {
    if (!breadEnabled) return;
    const id = params.id;
    if (!id) return;
    return initFormulaSync(id);
  });
  const hasFormula = $derived(breadEnabled && $formula !== null && $formula !== undefined);

  // ─── Could this recipe HAVE one? (issue #823) ────────────────────────────────
  //
  // Presence-and-shape again, one notch softer than `hasFormula`: not "does this
  // have a formula" but "does this look like something that could". The answer is
  // the domain's own basis guess asked as a yes/no — the same decision the formula
  // screen makes when it opens, so the offer can never lead somewhere the screen
  // then disagrees with. Still nothing about `kind` anywhere near it: a loaf is an
  // ordinary `recipe`, and there is no `bread` kind.
  //
  // An empty guess means "not offered" here, where the mapping screen reads it as
  // "you pick". That is the whole cost of the gate and it is bounded: a loaf whose
  // only flour line the keyword list has never heard of loses a menu item, not
  // access — `/recipes/:id/formula` is still typed-URL reachable.
  //
  // Canon LEADS and lands after first paint, so this is asked again as it arrives.
  // Every loaf in the library says "flour" in its own line too, so in practice the
  // item is there immediately; a recipe that reads as flour ONLY through its canon
  // name would see it appear a beat late, which is the accepted price of adding no
  // read here (the formula subscription above is the only one this costs).
  const canonNameById = $derived(new Map($canonItems.map((c) => [c.id, c.name])));
  const couldHaveFormula = $derived(
    recipe !== null &&
      looksScalable(
        flattenIngredients(recipe).map((ing) => ({
          ingredientId: ing.id,
          canonName: (ing.canonId ? canonNameById.get(ing.canonId) : null) ?? null,
          rawText: ing.rawText,
        })),
      ),
  );
  // Mutually exclusive with the pair above by construction: the moment a formula
  // is saved this goes false and "Bake a batch" / "Formula" take the slot.
  const showMakeScalable = $derived(breadEnabled && !hasFormula && couldHaveFormula);

  // ─── Which half of the Cook control is the primary one (issue #776) ─────────
  //
  // A per-person preference off this member's own doc, defaulting to `standard`
  // for everyone who has never set it — which is every member today, so nothing
  // changes for anyone until they choose.
  //
  // The control keeps its shape either way: the wide labelled half is your
  // default and the icon half is the other mode. That is what keeps the promise
  // that standard cook mode is always one tap away, whichever way this is set.
  const prefersGuided = $derived($currentMember?.cookMode === 'guided');
  // Guided leads only when there is a plan to be guided BY. On a recipe nobody has
  // written one for, the wide button is standard cook mode — a default should not
  // put a dead end where the obvious action was.
  const guidedIsPrimary = $derived(prefersGuided && hasGuidedPlan);
  // The second half appears when there is a plan (as before) AND, new here, when
  // guided is your default but this recipe has none: that is exactly the person
  // who wants to be offered the plan, and the screen it leads to now offers to
  // write one.
  const showGuidedHalf = $derived(hasGuidedPlan || prefersGuided);
  const primaryCookHref = $derived(
    guidedIsPrimary ? `/recipes/${params.id}/cook/guided` : `/recipes/${params.id}/cook`,
  );
  const secondaryCookHref = $derived(
    guidedIsPrimary ? `/recipes/${params.id}/cook` : `/recipes/${params.id}/cook/guided`,
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
  interface RecipeFact {
    readonly key: string;
    /** Absent only for the one fact with no honest glyph — see `attribution` below. */
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
  const phases = $derived(recipe?.metadata.phases ?? []);
  const phaseTotals = $derived(recipePhaseTotals(phases));

  const facts = $derived.by((): RecipeFact[] => {
    if (!recipe) return [];
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
    // them, and gating here covers the chips and, through `hasMeta`, the card.
    if (isCookable(kindOf(recipe))) {
      const m = recipe.metadata;
      if (m.servings !== null) {
        out.push({
          key: 'servings',
          icon: 'Users',
          label: `Serves ${m.servings}`,
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

  // The #878 cook-shape ribbon was deleted here by issue #1213, along with
  // `cookShape` itself. It drew whatever minutes somebody had happened to attach a
  // step timer to, which is the defect that started #1122 — a recipe whose method
  // says "bring a large pan of water to the boil" reported twelve minutes. Every
  // recipe now carries a real phase strip, so there is nothing left for it to say.

  // ─── Canon live-id set (for dangling-match derivation) ───────────────────────
  const liveCanonIds = $derived(new Set($canonItems.map((c) => c.id)));

  // ─── Row match markers ───────────────────────────────────────────────────────
  // The list card counts a recipe's silently-wrong lines (issue #858); this asks
  // the same pure query of one line, so the number on the card and the markers
  // here cannot disagree. `IngredientMatchSheet` states that principle and this
  // page was the one surface re-deriving it — from `hasLiveCanonMatch` alone,
  // which never reads product forms. A `missing_form` line has a perfectly live
  // canonId, so it passed that test and carried no marker at all: the card said
  // three and the recipe showed you nothing (issue #867).
  //
  // Index and gate both come from `lib/canonIndex.ts`, which carries the whole
  // of the reasoning. It is not merely the same SHAPE as the list card's gate,
  // it is the same function — which is what stops the card counting three
  // problems on a recipe whose rows show none (issue #867). The gate covers
  // BOTH markers here, not only the one #867 added.
  const canonById = $derived(canonIndex($canonItems));

  const matchMarkersKnown = $derived(
    matchMarkersReady($isLoadingAisles, $isLoadingProductForms, $canonItems.length),
  );

  // Split on the LIVE match, not on the issue kind. A line whose canon has been
  // deleted is no longer matched to anything, so its remedy is the same re-match
  // a never-matched line needs and it keeps the ✗ it has always had; ⚠ is the
  // case that had no marker — matched, and buying the wrong thing, which a
  // re-match cannot be assumed to fix because the fault may be the form.
  //
  // A never-matched line still shows ✗ without being counted on the card. That
  // asymmetry is deliberate and unchanged: the card exists to say which recipe to
  // OPEN, and an unmatched line is already plain once you have.
  //
  // Three markers now, split on TWO questions rather than one. The colour answers
  // "does this line look finished?" — red ✗ for a line that plainly is not,
  // terracotta for the two that do and aren't. The glyph and the tap answer "is a
  // re-match the known remedy?" — ✗ and ? run it, ⚠ opens the sheet, because a
  // missing product form may not be re-matchable at all and saying otherwise
  // trains the marker out of you.
  function rowMarker(ing: Ingredient): 'unmatched' | 'no-amount' | 'mismatched' | null {
    if (!matchMarkersKnown) return null;
    if (!hasLiveCanonMatch(ing, liveCanonIds)) return 'unmatched';
    const issue = ingredientMatchIssue(ing, canonById, $productForms);
    if (issue === null) return null;
    return issue === 'missing_amount' ? 'no-amount' : 'mismatched';
  }

  // ─── Ingredient pictograms (issue #878) ──────────────────────────────────────
  // The tile the shopping list and cook mode already use, on the recipe's own
  // list: a picture is faster to find in nineteen lines than a word is. The row
  // already carries its canon id and `canonById` above is already derived from the
  // app-wide store, so this is a lookup, not a read — and a Map rather than a
  // `.find()` per row, which on a long recipe is forty scans of the whole canon.
  //
  // Lookup mirrors ShoppingListPage's `thumbnailFor`/`iconVersionFor` exactly,
  // cache-bust nonce included: a regenerated icon reuses its Storage download URL,
  // so without the nonce the browser serves the stale image.
  function thumbnailFor(canonId: string | null): string | null {
    if (!canonId) return null;
    return canonById.get(canonId)?.thumbnail ?? null;
  }

  function iconVersionFor(canonId: string | null): string | number | undefined {
    if (!canonId) return undefined;
    const ci = canonById.get(canonId);
    return ci ? (ci.iconRequestedAt ?? ci.updatedAt) : undefined;
  }

  // The NAME only, which is what the tile is labelled with — never
  // `IngredientText`'s rendering. Same helper, same reasoning, as CookModePage's.
  function ingredientLabel(ing: Ingredient): string {
    return ing.parsed?.item ?? ing.rawText;
  }

  // ─── Method: first use, and what you can walk away from (issue #878) ─────────
  // The recipe stamps `firstUsedInStepId` on each ingredient at authoring/import
  // time, so a step can show exactly what it introduces. Cook mode has surfaced
  // this per step for a while; the reading list never did, which is where you
  // decide whether tonight is the night. Same domain query — there is one.
  const firstUseByStep = $derived(groupIngredientsByFirstUse(recipe?.ingredients ?? []));

  // And what the step is the first to REACH FOR (issue #882). The contiguous-run
  // rule lives in the domain query, not here: a pan used at steps 3-7 is listed
  // at 3 and nowhere else, so the method reads as "get the pan out now" rather
  // than as the same picture five times. Same query the cook deck and the guided
  // step screen call, so the three cannot disagree about when it comes out.
  const kitByStep = $derived(groupKitByStep(recipe?.kit ?? [], recipe?.steps ?? []));

  // An hour is the point at which a timer stops being something you stand over.
  // Below it you are still in the kitchen; at or above it the step is a wait you
  // plan the evening around, and the two overnight proves in a bread recipe are
  // the whole reason this exists. One threshold, no band in the middle — the same
  // rule `formatMinutes` switches on, so "12 hr" and "Hands-off" always agree.
  const HANDS_OFF_MINUTES = 60;

  function isHandsOff(step: Step): boolean {
    return (step.timer?.durationMinutes ?? 0) >= HANDS_OFF_MINUTES;
  }

  // ─── Canonicalise ────────────────────────────────────────────────────────────
  let canonalising = $state(false);

  const hasParsedPending = $derived(
    recipe !== null &&
      recipe.ingredients.some((g) =>
        g.items.some((ing) => ing.parsed !== null && !hasLiveCanonMatch(ing, liveCanonIds)),
      ),
  );

  async function handleCanonicalise(): Promise<void> {
    if (!recipe) return;
    canonalising = true;
    const result = await canonicaliseIngredients(recipe);
    canonalising = false;
    if (result.kind !== 'ok') {
      addToast('Canonicalisation failed.', 'destructive');
      return;
    }
    addToast('Ingredients matched.', 'success');
  }

  // ─── Match inspector ─────────────────────────────────────────────────────────
  // Tapping an ingredient answers "what does this line actually buy?" — the canon
  // item it resolved to and, when one carried it there, the product form. ONE
  // sheet for the whole list rather than one per row: a list of forty lines still
  // mounts a single dialog.
  //
  // The ID is the state, NOT the ingredient object: re-matching from inside the
  // sheet rewrites the line, and holding the value would leave the open sheet
  // describing the match it just replaced.
  let inspectingId = $state<string | null>(null);
  let inspectorOpen = $state(false);

  const inspecting = $derived(
    inspectingId === null || !recipe
      ? null
      : (recipe.ingredients.flatMap((g) => g.items).find((i) => i.id === inspectingId) ?? null),
  );

  const inspectingGroup = $derived(
    inspectingId === null || !recipe
      ? null
      : (recipe.ingredients.find((g) => g.items.some((i) => i.id === inspectingId)) ?? null),
  );

  function inspectMatch(ing: Ingredient): void {
    inspectingId = ing.id;
    inspectorOpen = true;
  }

  // The sheet's "Match again": the very same full-pipeline re-run the ✗ performs,
  // reachable on a line that already looks matched. That is the whole point —
  // deleting a product form leaves NOTHING dangling (the ingredient's canonId
  // points at the form's PARENT canon, which is still very much alive), so the ✗
  // never appears and the line's now-formless match is unreachable. Re-running
  // finds no form, falls to product-form arbitration, and writes a fresh one.
  //
  // It toasts on success where the ✗ stays silent: from here the outcome is
  // frequently invisible (the same canon item, now reached a different way), so
  // an unacknowledged tap would read as a dead button.
  async function rematchFromSheet(): Promise<void> {
    const group = inspectingGroup;
    const ing = inspecting;
    if (!group || !ing) return;
    if (await handleRematch(group, ing)) addToast('Ingredient re-matched.', 'success');
  }

  // ─── Per-row rematch ─────────────────────────────────────────────────────────
  // The unmatched indicator (✗) is the trigger: tapping it parses + canon-matches
  // that single ingredient and persists the recipe. Re-derives from the current
  // store copy and discards the result if the row changed mid-flight.
  let matchingIds = $state<Record<string, boolean>>({});

  async function handleRematch(group: IngredientGroup, ing: Ingredient): Promise<boolean> {
    if (!recipe || matchingIds[ing.id]) return false;
    matchingIds = { ...matchingIds, [ing.id]: true };
    const result = await matchIngredient(ing);
    matchingIds = { ...matchingIds, [ing.id]: false };
    if (result.kind !== 'ok') {
      addToast('Failed to match ingredient.', 'destructive');
      return false;
    }
    const current = $recipes.find((r) => r.id === recipe.id);
    if (!current) return false;
    const updatedGroups = current.ingredients.map((g) =>
      g.id !== group.id
        ? g
        : {
            ...g,
            items: g.items.map((i) =>
              i.id === ing.id && i.rawText === ing.rawText ? result.value : i,
            ),
          },
    );
    const persisted = await persistRecipe({ ...current, ingredients: updatedGroups });
    if (persisted.kind !== 'ok') {
      addToast('Failed to save match.', 'destructive');
      return false;
    }
    return true;
  }

  // ─── Review state (issue #616) ────────────────────────────────────────────
  // A URL-imported recipe is persisted by the callable flagged `needs_approval`
  // — raw AI output nobody has read. It is fully live regardless (cookable,
  // plannable, searchable); the flag only marks it unread. An editor save clears
  // it, and so does this: for an import that came through clean, forcing an
  // edit-and-save just to mark it read is busywork.
  let markingReviewed = $state(false);

  async function handleMarkReviewed(): Promise<void> {
    if (!recipe || markingReviewed) return;
    const current = $recipes.find((r) => r.id === recipe.id);
    if (!current) return;
    markingReviewed = true;
    // Dropped, not set false — absent means reviewed (matches the schema and the
    // full-document setDoc persistRecipe performs).
    const { needs_approval: _wasUnreviewed, ...reviewed } = current;
    const persisted = await persistRecipe(reviewed);
    markingReviewed = false;
    if (persisted.kind !== 'ok') {
      addToast('Failed to mark as reviewed.', 'destructive');
    }
  }

  // ─── Add to shopping list ─────────────────────────────────────────────────
  // The review sheet (issue #185) owns servings + per-ingredient Add/Check
  // toggles + the commit; this page only guards that a default list exists.
  let addToListOpen = $state(false);

  // ─── Add to planner ───────────────────────────────────────────────────────
  // The picker sheet owns the calendar and the write; this page only opens it.
  let addToPlannerOpen = $state(false);

  // "Bake a batch" — the scale sheet (issue #812). Opened from the overflow menu;
  // see the placement note there.
  let bakeBatchOpen = $state(false);

  // Mobile-only overflow menu (⋮) that holds the secondary header actions
  // (Ask/amend, Edit, Delete) below the `sm` breakpoint; Cook + Add to list
  // stay visible at every width. Desktop keeps all five as inline buttons.
  let overflowMenuOpen = $state(false);

  function openAddToList(): void {
    if (!$defaultListId) {
      addToast('No shopping list found. Create one first.', 'destructive');
      return;
    }
    addToListOpen = true;
  }

  // ─── This recipe's chats ─────────────────────────────────────────────────────
  // Every conversation about this dish, newest first — a client-side filter over
  // the sessions store the app already holds (issue #696).
  const recipeChats = $derived(recipe ? chatsForRecipe($sessions, recipe.id) : []);

  // Which one is on screen. An EXPLICIT selection: every entry point sets it, and
  // it falls back to the newest so a recipe you have never chosen a chat on still
  // opens on the conversation you last had. Cleared implicitly when the selected
  // session is gone, because the lookup simply misses.
  let selectedSessionId = $state<string | null>(null);
  const activeSession = $derived(
    recipeChats.find((s) => s.id === selectedSessionId) ?? recipeChats[0] ?? null,
  );

  let amendBusy = $state(false);

  // Start a fresh line of enquiry about this dish. Seeds the title from the recipe
  // ("Cauliflower Steaks chat") until the chef retitles it, and selects it so
  // whichever surface is showing a chat switches to the new one.
  async function createRecipeChat(): Promise<ChatSessionDoc | null> {
    if (!recipe) return null;
    const uid = auth.user?.uid;
    if (!uid) return null;
    amendBusy = true;
    const result = await createChatSession(uid, recipe.id, recipe.title);
    amendBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to open chat.', 'destructive');
      return null;
    }
    selectedSessionId = result.value.id;
    return result.value;
  }

  // Is the chat docked in a column of its own? From the fold up it is, and there is
  // nothing for a drawer to do; below it, opening a chat raises the drawer over the
  // live recipe. `false` — the phone path — is the honest default whenever the answer
  // cannot be read: SSR, a jsdom without `matchMedia`, a query the engine rejects.
  // This must stay the SAME GATE as the `split:` variant the column is laid out with
  // (`app.css`), and in the same RANGE SYNTAX the browser actually sees: on an engine
  // too old for range queries the emitted CSS is inert, and a `min-width:` query here
  // would answer "yes, docked" for a page that is still one column — suppressing the
  // drawer with no pane to replace it, i.e. a recipe where tapping a chat does nothing.
  // The read itself, and the four ways it can fail, are `lib/mediaQuery.svelte.ts`.
  const split = createMediaQuery(SPLIT_QUERY);
  const docked = $derived(split.matches);

  // Is the chat column actually on screen? Two independent facts, and the layout
  // needs the conjunction (issue #1141): there has to be ROOM for a second column
  // (`docked`) AND the cook has to want one (`recipeChatPanePrefs`, an in-memory
  // session preference — see its header for the Rule 3 reasoning).
  //
  // This is a derived boolean OVER the existing seam, not a second spelling of it:
  // no media query is added anywhere by this feature, and
  // `tests/sharedHelperGuard.test.ts` fails if one ever is. Everything that used to
  // branch on `docked` for LAYOUT now branches on this, so `fill`, the grid classes
  // and the column cannot disagree (ui-spec-v07 §1.4). The DRAWER deliberately does
  // not: it is the phone surface and stays on `docked` alone, so switching the pane
  // off on a wide screen never raises a sheet over the recipe.
  const chatPaneShown = $derived(docked && recipeChatPanePrefs.on);

  // The drawer's stop is in-memory only and so is whether it is open — Rule 3, and
  // nothing here is worth restoring across a reload anyway.
  let drawerOpen = $state(false);

  // Opening a chat from the recipe never leaves the recipe. Above the seam the chat is
  // already beside it, so selecting is the whole action; below it, the drawer rises.
  function openChat(session: ChatSessionDoc): void {
    selectedSessionId = session.id;
    // Selecting a conversation is never a dead press (issue #1141). With the pane
    // switched off the list sits at the foot of the recipe, and picking from it has
    // to bring the pane back — otherwise the chat is selected into a column that is
    // not there. Unconditional: below the seam nothing reads this value, and the
    // "Chat" header/⋮ action reaches the pane through here too.
    recipeChatPanePrefs.show();
    if (!docked) {
      drawerOpen = true;
      void scrollRecipeToBody();
    }
  }

  // The strip the drawer leaves visible should hold the ingredients, not the hero photo
  // — the whole point is reading the answer and the thing it is about in one glance. So
  // the page behind scrolls to its body on open, and only then: at every other moment
  // the recipe's scroll position is the user's.
  //
  // Under tabs (issue #878) that is now TWO acts rather than one. The anchor sits above
  // the tab strip and is never itself hidden, but the ingredients it exists to reveal are
  // only on screen when their panel is the selected one — an unselected `TabsContent`
  // stays mounted and `hidden` (ui-spec-v10 §8.28.3), so a `scrollIntoView` that landed on
  // it would be a silently dead scroll. Selecting first, scrolling second, is what the
  // spec's bindable `value` is for (§8.28.5).
  let bodyAnchorEl = $state<HTMLElement | undefined>(undefined);

  async function scrollRecipeToBody(): Promise<void> {
    // Ingredients, not "whichever tab was showing": this scroll exists to put the
    // ingredients above the chat, and a Method panel left selected would leave the
    // drawer talking about a dish whose parts are one tap away. `e2e/recipe-chat-drawer`
    // asserts exactly that ingredient is visible once the drawer is up.
    if (showIngredients) bodyTab = 'ingredients';
    // The panel has to be un-`hidden` before the browser will scroll anything into view,
    // and that is a DOM update away.
    await tick();
    bodyAnchorEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function handleNewChat(): Promise<void> {
    const created = await createRecipeChat();
    if (created) openChat(created);
  }

  // "Chat" in the header and in the ⋮ menu. CONTINUES the most recent conversation
  // about this dish rather than silently starting another — a new one is a
  // deliberate act, and the list's "New chat" is where you do it.
  async function handleAskAmend(): Promise<void> {
    if (!recipe) return;
    const newest = recipeChats[0];
    if (newest) {
      openChat(newest);
      return;
    }
    await handleNewChat();
  }

  // "Duplicate" in the ⋮ menu (issue #735). Nothing is written: the copy is
  // stashed as an unsaved draft and the editor picks it up, so backing out costs
  // no document and no hero-image generation. `duplicateRecipe` owns the whole
  // what-carries policy — do not reset fields here. The stash is the SAME
  // single-use seam URL and photo import already use; there is deliberately no
  // second draft-passing mechanism, no query param and no store.
  function handleDuplicate(): void {
    if (!recipe) return;
    stashImportedDraft(duplicateRecipe(recipe, crypto.randomUUID(), new Date().toISOString()));
    push('/recipes/new');
  }

  // "Make a variation" in the ⋮ menu (issue #763). Opens a NEW chat that holds
  // this recipe as its starting point and navigates AWAY to it, which is the
  // honest destination: the conversation is about a different dish, it is not
  // attached to this one, and so it deliberately does not appear in this page's
  // own chat list. Only the session document is written — no recipe and no image
  // generation until "Save as recipe".
  let variationBusy = $state(false);

  async function handleMakeVariation(): Promise<void> {
    if (!recipe || variationBusy) return;
    const uid = auth.user?.uid;
    if (!uid) return;
    variationBusy = true;
    const result = await createChatSession(uid, null, recipe.title, recipe.id);
    variationBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to start a variation.', 'destructive');
      return;
    }
    push(`/chat/${result.value.id}`);
  }

  // The transcript, the composer, the auto-scroll and the send path are all
  // ChatThread's — this page only holds the live turn state so "Optimise for my
  // kitchen" can start one on a session the component is not yet showing.
  const chat = createChatThread();

  // ─── Optimise for my kitchen ────────────────────────────────────────────────
  // Sends OPTIMISE_FOR_KITCHEN_PROMPT as an ordinary user turn, creating the
  // session first when the recipe has no chat yet. Nothing downstream is special:
  // the reply is a normal assistant turn, and "Review changes" runs authorRecipe
  // over the transcript exactly as it does for a hand-typed request.
  //
  // Hidden when the household owns no equipment — with an empty manifest the
  // server injects no kit section at all and the prompt asks the chef to reason
  // about nothing.
  const hasEquipment = $derived(($equipment?.items ?? []).length > 0);
  let optimiseBusy = $state(false);

  async function handleOptimiseForKitchen(): Promise<void> {
    if (!recipe || optimiseBusy || chat.isSending) return;
    const uid = auth.user?.uid;
    if (!uid) return;
    optimiseBusy = true;

    const session = activeSession ?? (await createRecipeChat());
    if (!session) {
      optimiseBusy = false;
      return;
    }
    // Put the transcript somewhere visible before the reply starts arriving in it.
    openChat(session);

    await chat.send(session, OPTIMISE_FOR_KITCHEN_PROMPT);
    optimiseBusy = false;
  }

  // ─── Openers for an empty conversation (issue #878) ─────────────────────────
  // A blank box is a bad question to be asked by a chef, so both recipe surfaces
  // open with a few things worth asking ABOUT THIS DISH — the full /chat/:id page
  // offers general ones instead, because it is not standing on a recipe.
  //
  // "Optimise for my kitchen" is the same prompt the overflow menu sends, not a
  // second wording of it: it is the best example of the shape, and one text means
  // one thing to maintain. It carries the same equipment gate for the same reason —
  // with an empty manifest the chef is asked to reason about no kit at all.
  //
  // These land as ordinary user turns down `ChatThread`'s one send path, so a
  // starter and the same sentence typed by hand are indistinguishable afterwards.
  const recipeStarters = $derived([
    ...(hasEquipment
      ? [{ label: 'Optimise for my kitchen', text: OPTIMISE_FOR_KITCHEN_PROMPT }]
      : []),
    {
      label: 'What can I prep ahead?',
      text: 'What parts of this can I prepare ahead of time, how far in advance, and how should I store them until I need them?',
    },
    {
      label: 'Make it quicker',
      text: 'How could I get this on the table faster on a weeknight, and what does each shortcut cost me?',
    },
    {
      label: 'What goes with it?',
      text: 'What would you serve alongside this to make it a full meal?',
    },
  ]);

  // Review-and-approve gate. "Update recipe" generates a PENDING proposal and
  // opens a diff summary; nothing is written until "Apply changes". What the
  // proposal contains and what the save writes live in `recipeAmend` and are
  // shared with the full `/chat/:id` page (issue #764) — this page holds only
  // its own busy/open state and its toasts. `sidebarIsProposing` guards the AI
  // call; `sidebarIsApplying` guards the save.
  let sidebarIsProposing = $state(false);
  let sidebarIsApplying = $state(false);
  let sidebarSummaryOpen = $state(false);
  let sidebarPending = $state<RecipeAmendment | null>(null);

  async function handleSidebarReviewChanges(): Promise<void> {
    if (!activeSession || !recipe || sidebarIsProposing) return;
    sidebarIsProposing = true;
    const existingTags = [...new Set($recipes.flatMap((r) => r.metadata.tags))];
    const result = await proposeRecipeAmendment(recipe, activeSession.messages, existingTags);
    sidebarIsProposing = false;
    if (result.kind !== 'ok') {
      addToast('Failed to generate recipe update.', 'destructive');
      return;
    }
    sidebarPending = result.value;
    sidebarSummaryOpen = true;
  }

  async function handleSidebarApplyChanges(): Promise<void> {
    if (!sidebarPending || sidebarIsApplying || !recipe) return;
    // Whether the guided plan survives the write is decided inside
    // `applyRecipeAmendment` (issue #918), not here. It used to be decided here
    // and only here, so the same amendment applied from `/chat/:id` left a plan
    // pointing at steps that no longer existed. A page owns its busy state, its
    // toasts and where it navigates; it owns nothing about what gets written.
    sidebarIsApplying = true;
    const saveResult = await applyRecipeAmendment(sidebarPending);
    sidebarIsApplying = false;
    if (saveResult.kind !== 'ok') {
      addToast('Failed to save recipe update.', 'destructive');
      return;
    }
    sidebarSummaryOpen = false;
    sidebarPending = null;
    addToast('Recipe updated!', 'success');
  }

  function handleSidebarDiscardChanges(): void {
    sidebarSummaryOpen = false;
    sidebarPending = null;
  }

  // ─── Refresh (issue #890) ───────────────────────────────────────────────────
  // Sends REFRESH_PROMPT as an ordinary user turn — creating the session first
  // when the recipe has no chat yet — and then runs the review gate over the
  // reply on your behalf, because "write it out again" has exactly one thing you
  // could want to do with the answer. Nothing is written until Apply; Discard
  // leaves the recipe exactly as it was, with the chef's reply still in the
  // transcript to read.
  //
  // It is not Optimise, which sits beside it. Optimise asks one question — is any
  // of this better on my kit — and leaves everything it does not touch alone.
  // Refresh re-writes the whole thing: the structure of the method, the timings,
  // the servings the document lost. Two different questions, two menu items.
  //
  // Unlike Optimise it carries NO equipment gate. A household that owns nothing
  // still has recipes with four operations in one step and no serving count, and
  // those are repaired by the writing, not by the kit.
  let refreshBusy = $state(false);

  async function handleRefresh(): Promise<void> {
    if (!recipe || refreshBusy || sidebarIsProposing || chat.isSending) return;
    const uid = auth.user?.uid;
    if (!uid) return;
    // Busy for BOTH round-trips, not just the chef's. One tap owes you one
    // proposal, and a second tap while the librarian is still reading would send
    // the chef a second copy of the same question.
    refreshBusy = true;
    try {
      const session = activeSession ?? (await createRecipeChat());
      if (!session) return;
      // Put the transcript somewhere visible before the reply arrives in it.
      openChat(session);

      // `chat.send` has already toasted a failure; there is no reply to review,
      // and running the librarian over the question alone would propose to
      // overwrite the dish with whatever it made of that.
      if (!(await chat.send(session, REFRESH_PROMPT))) return;

      // Reads `activeSession` again rather than the object sent into: the store
      // now holds both turns, and the reply is the half the librarian needs.
      await handleSidebarReviewChanges();
    } finally {
      refreshBusy = false;
    }
  }

  // "Save as new recipe" (issue #798) — the other thing a conversation beside a
  // dish can produce. You asked what would go with the lamb, the chef wrote out a
  // salad, and this keeps the salad as a recipe of its own.
  //
  // The dish on this page is NOT written to: what gets authored and saved lives in
  // `chatRecipeAuthor` and is shared with the full `/chat/:id` page, and it only
  // ever takes the create path. No `basedOnRecipeId` — an accompaniment is not
  // derived from what it accompanies, and variation mode would drag this recipe's
  // ingredients into it. No claim either: the conversation stays listed here.
  let sidebarIsSavingNew = $state(false);

  async function handleSaveAsNewRecipe(): Promise<void> {
    if (!activeSession || sidebarIsSavingNew) return;
    sidebarIsSavingNew = true;
    const existingTags = [...new Set($recipes.flatMap((r) => r.metadata.tags))];
    const result = await authorRecipeFromChat({
      messages: activeSession.messages,
      existingTags,
      basedOnRecipeId: null,
    });
    sidebarIsSavingNew = false;
    if (result.kind !== 'ok') {
      addToast(
        result.error.stage === 'author' ? 'Failed to generate recipe.' : 'Failed to save recipe.',
        'destructive',
      );
      return;
    }
    // The sidebar twin of the chat page's "Save as new recipe" (issue #765):
    // `basedOnRecipeId: null` makes it a CREATE path, so the librarian may
    // classify the accompaniment it just wrote as a cocktail. Copy comes from
    // `KIND_COPY`, never from a comparison on the kind.
    addToast(KIND_COPY[kindOf(result.value)].createdToast, 'success');
    push(`/recipes/${result.value.id}`);
  }

  // ─── Delete ─────────────────────────────────────────────────────────────────
  let deleteOpen = $state(false);
  let deleteBusy = $state(false);

  async function handleDelete(): Promise<void> {
    if (!recipe) return;
    const title = recipe.title;
    deleteBusy = true;
    const result = await removeRecipe(recipe.id);
    deleteBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to delete recipe.', 'destructive');
      return;
    }
    deleteOpen = false;
    addToast(`Deleted ${title}`, 'success');
    push('/recipes');
  }

  // ─── Hero image (issue #148, Tier-2) ─────────────────────────────────────────
  // The photoreal hero is generated automatically by the onRecipeWritten trigger
  // on create; the manual escape hatch is Regenerate (with an optional steer),
  // surfaced as a subtle overlay control on the image. While a (re)generation is
  // in flight the new URL simply arrives via the recipe subscription — there is no
  // in-flight flag on the doc, so `imageBusy` only guards the button between click
  // and callable return. `imageHidden` is retired (inert, kept for back-compat) so
  // hero visibility is purely "does an image URL exist".
  const heroVisible = $derived(!!recipe?.image?.url);
  let imageBusy = $state(false);
  let regenOpen = $state(false);
  // The read-only prompt window (issue #892). The recipe hero already had upload
  // and regenerate; this is the one power it was missing.
  let promptOpen = $state(false);
  // The art direction for the next generation. Seeded on every open from the brief
  // saved beside the current image, so the dialog opens filled in with no load —
  // it is already on the recipe doc the page is subscribed to. Editing this text
  // *is* the steer, which is why the old one-line "Steer (optional)" hint input is
  // gone: it steered a brief the user could not see, and now they can just write it.
  let regenBrief = $state('');

  async function runRegenerate(brief?: string): Promise<void> {
    if (!recipe || imageBusy) return;
    imageBusy = true;
    const result = await regenerateRecipeImage(recipe.id, brief);
    imageBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to start image generation.', 'destructive');
      return;
    }
    addToast('Generating a new image — it will appear shortly.', 'success');
  }

  // ─── The Equipment tab (issues #882, #1140) ─────────────────────────────────
  //
  // The kit is inferred server-side and stored as WORDS — `{ label, stepIds }` —
  // never as an id into the drawn vocabulary. The picture is found from the words
  // at render time, here, and a label nothing matches renders as words with no
  // picture. That is the designed outcome, not a degraded one: it is what lets the
  // vocabulary grow later and light up every recipe already written, and it is why
  // nothing below ever substitutes a near match or a generic glyph.
  //
  // The whole recipe's kit, in the order the flow listed it. It is the Equipment
  // tab's list (issue #1140) — the third alternative view of the body, answering
  // "have I got what this needs?" beside the ingredients you check the same way.
  // `stepIds` is unread HERE and read further down the page — `kitByStep` turns it
  // into the per-step rows on the method — so the two readings are of one stored
  // list, not two.
  const kit = $derived(recipe?.kit ?? []);

  // The Equipment trigger and panel both disappear when the kit empties, and
  // `bodyTab` is `$state` — so a kit that goes away while its own tab is selected
  // would leave the strip with nothing selected and the body blank. Rare (an
  // editor save, or a Redo kit that comes back with nothing) but not impossible,
  // and the cost of it is a page that looks broken. Falling back to Ingredients is
  // where the page starts anyway.
  $effect(() => {
    if (kit.length === 0 && bodyTab === 'equipment') bodyTab = 'ingredients';
  });

  // The Equipment tab's display order, with an accessory folded into the appliance
  // it came in the box with (issue #1140). The rule is pure and lives in `domain` —
  // the page only renders what it returns, and never decides on its own what belongs
  // to what.
  const kitGroups = $derived(groupKitByEquipment(kit, $equipment?.items ?? []));

  // The accessories of one appliance, as the tail of "with the …". `Intl.ListFormat`
  // rather than `join(', ')`: three accessories read "a, b and c", and the Oxford-less
  // en-GB conjunction is exactly what a cook would say out loud, which is the register
  // the labels themselves are written in.
  //
  // Page-local, and staying that way until a second surface needs it. Cook mode shows
  // kit per step through `kitByStep` — a flat list with no accessory folding at all —
  // so there is no second caller to share this with today.
  const accessoryList = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' });
  function accessoryPhrase(accessories: readonly { label: string }[]): string {
    return accessoryList.format(accessories.map((a) => a.label));
  }

  // Re-asks the question of the whole recipe. Nothing optimistic: the callable bumps
  // a nonce, the trigger re-infers, and the new list arrives on the subscription —
  // so the old list stays on screen throughout rather than blanking. Mirrors
  // `runRegenerate` exactly, toast for toast.
  let kitBusy = $state(false);

  async function handleRedoKit(): Promise<void> {
    if (!recipe || kitBusy) return;
    kitBusy = true;
    const result = await redoRecipeKit(recipe.id);
    kitBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to redo the kit list.', 'destructive');
      return;
    }
    addToast('Working out the kit — it will update shortly.', 'success');
  }

  // Re-seed on every open (not once): the trigger re-saves imageBrief after each
  // successful generation, so the next open shows the brief that produced the image
  // now on screen — the user's own edited text, not the original. A recipe with no
  // brief yet seeds '' and the dialog reads as it always did: an empty optional box,
  // no error, no spinner — omitting it lets the trigger author one.
  function openRegenerate(): void {
    regenBrief = recipe?.imageBrief ?? '';
    regenHint = '';
    briefError = null;
    regenOpen = true;
  }

  async function handleRegenerateConfirm(): Promise<void> {
    const brief = regenBrief.trim();
    regenOpen = false;
    await runRegenerate(brief || undefined);
  }

  // ─── Brief revision + start over (issue #522, Phase 3) ───────────────────────
  // Both actions call the describeRecipeScene callable, which PERSISTS NOTHING —
  // the new brief lands back in the box, still editable, and only becomes the
  // recipe's art direction if the user then presses Regenerate. That is the point:
  // the brief is cheap and the image is not, so you iterate the words for a
  // fraction of a cent and buy exactly one render once they are right.
  //
  // The steer is deliberately NOT `imageHint` (retired, inert): it never touches
  // the wire as a persisted field, it is a one-shot instruction to the text model
  // that dies with the round trip. What persists is its RESULT, once, via the brief.
  let regenHint = $state('');
  let briefBusy = $state(false);
  let briefError = $state<string | null>(null);

  // Shared by both actions: run it, swap the brief in on success, and on failure
  // leave the box EXACTLY as it was. A revision that failed must not cost the user
  // the brief they already had — that text may be several edits deep, and a
  // transient callable error is no reason to throw it away.
  async function runBriefAction(
    action: () => Promise<ReadResult<string, DomainError>>,
  ): Promise<void> {
    if (!recipe || briefBusy) return;
    briefBusy = true;
    briefError = null;
    const result = await action();
    briefBusy = false;
    if (result.kind !== 'ok') {
      briefError = "Couldn't rewrite the brief — your text is unchanged. Try again.";
      return;
    }
    regenBrief = result.value;
  }

  async function handleReviseBrief(): Promise<void> {
    const hint = regenHint.trim();
    const brief = regenBrief.trim();
    // Revision needs both halves. With no brief to revise, the honest action is
    // "start over" — the button label already says so, so there is nothing to do.
    if (!hint || !brief) return;
    const target = recipe;
    if (!target) return;
    await runBriefAction(() => reviseRecipeSceneBrief(target, brief, hint));
    // The steer is spent: it has been folded into the brief, and leaving it in the
    // box invites a second Revise that applies "make it summery" to an already
    // summery brief.
    if (!briefError) regenHint = '';
  }

  async function handleStartOverBrief(): Promise<void> {
    const target = recipe;
    if (!target) return;
    regenHint = '';
    await runBriefAction(() => startOverRecipeSceneBrief(target));
  }

  // ─── Upload a local photo (issue #455, Phase 2) ──────────────────────────────
  // Pick a file → crop to 3:2 (pan/zoom) in the ImageCropper primitive → Save
  // sends the cropped bytes (base64) to the setRecipeImageUpload callable, which
  // re-encodes and writes `recipe-images/{id}.webp` then stamps
  // `image = { url, source: 'upload' }`. The new URL arrives via the subscription;
  // a bumped `imageRequestedAt` nonce cache-busts the identical Storage URL so the
  // photo appears immediately. Regenerate never clobbers an uploaded photo (the
  // trigger skips `source: 'upload'`).
  let uploadOpen = $state(false);
  let uploadBusy = $state(false);
  let uploadSrc = $state<string | null>(null);
  let cropper = $state<ImageCropperHandle | undefined>(undefined);

  function openUpload(): void {
    clearUploadSrc();
    uploadBusy = false;
    uploadOpen = true;
  }

  // Object-URL lifecycle: revoke the previous blob URL before replacing/clearing
  // so a re-pick or a close doesn't leak it.
  function clearUploadSrc(): void {
    if (uploadSrc) URL.revokeObjectURL(uploadSrc);
    uploadSrc = null;
  }

  function handleUploadFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    // Reset the input so re-picking the SAME file still fires a change event.
    input.value = '';
    if (!file) return;
    routeImageBlob(file);
  }

  // Shared sink for both file and clipboard sources: revoke any prior blob URL,
  // then feed the new image into the cropper exactly as the file path does.
  function routeImageBlob(blob: Blob): void {
    clearUploadSrc();
    uploadSrc = URL.createObjectURL(blob);
  }

  // ─── Paste from clipboard (issue #455, Phase 3) ──────────────────────────────
  // Two entry points into the SAME 3:2 crop → setRecipeImageUpload pipeline: an
  // explicit Paste button (async Clipboard `read()`) and ⌘/Ctrl-V while the
  // dialog is open (the `paste` event's clipboardData). The button is gated on
  // `clipboardImageReadSupported()` because some browsers expose no `read()`;
  // the keyboard listener needs no such gate — it uses clipboardData — so it
  // stays active regardless. Neither path throws: an unsupported/denied/empty
  // clipboard just shows a hint (see clipboardImage.ts).
  const canPasteFromClipboard = clipboardImageReadSupported();
  const pasteShortcutLabel =
    typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent)
      ? '⌘V'
      : 'Ctrl+V';

  async function handlePasteButton(): Promise<void> {
    if (uploadBusy) return;
    const blob = await readClipboardImage();
    if (!blob) {
      addToast('No image found on the clipboard.', 'default');
      return;
    }
    routeImageBlob(blob);
  }

  function handleDialogPaste(e: ClipboardEvent): void {
    if (uploadBusy) return;
    const blob = imageFromClipboardData(e.clipboardData);
    if (!blob) return;
    e.preventDefault();
    routeImageBlob(blob);
  }

  // Listen for ⌘/Ctrl-V only while the dialog is open. The dialog renders in a
  // portal, so bind at the document level and gate on `uploadOpen`.
  $effect(() => {
    if (!uploadOpen) return;
    const listener = (e: ClipboardEvent): void => handleDialogPaste(e);
    document.addEventListener('paste', listener);
    return () => document.removeEventListener('paste', listener);
  });

  function handleUploadOpenChange(open: boolean): void {
    uploadOpen = open;
    if (!open) {
      clearUploadSrc();
      uploadBusy = false;
    }
  }

  async function handleUploadSave(): Promise<void> {
    if (!recipe || !cropper || uploadBusy) return;
    uploadBusy = true;
    const base64 = await cropper.getCroppedBase64();
    if (!base64) {
      uploadBusy = false;
      addToast('Could not read that image — try another.', 'destructive');
      return;
    }
    const result = await setRecipeImageUpload(recipe.id, base64, 'image/webp');
    uploadBusy = false;
    if (result.kind !== 'ok') {
      addToast('Failed to upload image.', 'destructive');
      return;
    }
    handleUploadOpenChange(false);
    addToast('Photo updated.', 'success');
  }
</script>

{#if recipe === null}
  <div class="p-4 sm:p-6">
    {#if $isLoadingRecipes}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else}
      <p class="text-sm text-muted-foreground">Recipe not found.</p>
      <Button variant="outline" class="mt-4" onclick={() => push('/recipes')}
        >Back to recipes</Button
      >
    {/if}
  </div>
{:else}
  <!-- `fill` whenever the chat pane is actually beside the recipe (issues #737, #1141):
       two panes that must scroll independently need a real height chain rather than a
       guessed one. There is deliberately NO `calc(100dvh - …)` anywhere below — every
       height here comes from `DetailPage`'s fill (ui-spec-v07 §1) resolving against
       AppShell's <main>. `chatPaneShown` is reused rather than adding a second gate: the
       same value drives the grid's responsive classes, so the classes and the prop cannot
       disagree (ui-spec-v07 §1.4). Its `false` default on SSR/no-`matchMedia` means one
       frame as an ordinary scrolling page before it fills — the same honest default the
       drawer suppression already accepts.

       With the chat switched OFF there is one pane, so `fill` no longer earns its place:
       ui-spec-v07 §1.6 is explicit that it is not a way to make a page fit one screen, and
       an ordinary long detail page wants <main>'s native momentum, real scrollbar,
       find-in-page and zoom reflow instead. -->
  <DetailPage
    title={recipe.title}
    onBack={() => goBack('/recipes')}
    backLabel="Back"
    class="p-4 sm:p-6"
    fill={chatPaneShown}
  >
    {#snippet actions()}
      <!-- Nine actions is far too many to shout at once, so they are ranked and
           the ranking is carried by BOTH weight and placement.

           Cook, Shop and Plan are what this page is for — the three things you
           came to do with a dish, and the three you want one tap away with your
           hands full — so they are the only `solid` (filled) buttons and the only
           ones that render inline. The row reads Cook · Shop · Plan · ⋮ at EVERY
           width (issue #735): the desktop row was already seven buttons and
           Duplicate would have made it eight, so the low-frequency actions get one
           consistent home instead of two divergent layouts to maintain. Labels are
           single words for the same reason: the row reads as a row rather than as
           a sentence.

           SINCE #751 the Cook slot can hold TWO cooks. A recipe with a guided plan
           can be cooked plainly or cooked guided, and that is not a second action —
           it is the SAME act, chosen at the same moment, with the plan as a lens.
           So it earns inline placement (unlike "Guided plan" in the menu below,
           which is desk work: writing and reading the plan, done before you cook).
           What it does NOT earn is a fourth labelled button: the row is already
           sized to the narrowest phone, and a fifth word would push it off the
           edge. It renders as a SEGMENTED PAIR sharing Cook's own button — one
           control, two ways to press it — which reads as "cook this, one way or the
           other" and costs 32px rather than 90. The row therefore still reads
           Cook · Shop · Plan · ⋮ at every width; only the Cook chip gained a right
           half, and only on recipes that have a plan.

           Three of the inline ones are capability-gated (issue #637) — things that
           don't apply simply aren't offered, so a takeaway shows Plan and the menu
           and nothing else. Guided rides on the same gate as Cook.

           WHICH HALF IS WHICH follows the cook's own preference (issue #776). The
           wide labelled half is their default and the icon half is the other mode,
           so standard cook mode is one tap away whichever way it is set — and the
           control's shape, its testids and its unreviewed dot are the same object
           either way. Only the destinations swap. -->
      {#if showCooking}
        <div
          class="flex items-center"
          data-testid="recipe-cook-actions"
          data-primary={guidedIsPrimary ? 'guided' : 'standard'}
        >
          <Button
            size="sm"
            class={showGuidedHalf ? 'rounded-r-none' : ''}
            onclick={() => push(primaryCookHref)}
            data-testid="recipe-cook-button"
          >
            {#snippet leading()}
              <Icon name={guidedIsPrimary ? 'ListChecks' : 'CookingPot'} size={16} />
            {/snippet}
            Cook
          </Button>
          {#if showGuidedHalf}
            <!-- The right half. Icon-only because it is the second press of a
                 control the left half has already named; its accessible name says
                 the whole thing, and the divider is what makes the two read as one
                 object rather than as two buttons that happen to touch.

                 Present with no plan too, but only for someone whose default is
                 guided — the person who most wants to be offered one. It leads to
                 the no-plan screen, which offers to write it. -->
            <Button
              size="sm"
              class="rounded-l-none border-l border-primary-foreground/30 px-2"
              onclick={() => push(secondaryCookHref)}
              ariaLabel={guidedIsPrimary
                ? 'Cook, standard'
                : guidedPlanUnread
                  ? 'Cook, guided — the plan is written by AI and not checked yet'
                  : 'Cook, guided'}
              title={guidedIsPrimary
                ? 'Cook, standard'
                : guidedPlanUnread
                  ? 'Cook, guided — written by AI, not checked yet'
                  : 'Cook, guided'}
              data-testid="recipe-cook-guided-button"
              data-unreviewed={guidedPlanUnread && !guidedIsPrimary}
            >
              {#snippet leading()}
                <!-- "Not checked yet" as an amber dot on the corner of the icon,
                     composed the way cook mode's keep-awake toggle composes its
                     Lock badge — there is no room for a word-bearing pill on a
                     32px segment, and overhanging one would push the row off a
                     narrow screen for a flag that is informational by design. The
                     amber is the app's review amber and the words are carried by
                     the accessible name and the tooltip; the full chip lives on
                     the plan editor, which is where you act on it. -->
                <span class="relative inline-flex">
                  <Icon name={guidedIsPrimary ? 'CookingPot' : 'ListChecks'} size={16} />
                  {#if guidedPlanUnread && !guidedIsPrimary}
                    <span
                      class="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-amber-400 ring-1 ring-primary"
                      aria-hidden="true"
                      data-testid="recipe-cook-guided-unreviewed-dot"
                    ></span>
                  {/if}
                </span>
              {/snippet}
            </Button>
          {/if}
        </div>
      {/if}
      {#if showIngredients}
        <Button size="sm" onclick={openAddToList} data-testid="recipe-add-to-list-button">
          {#snippet leading()}<Icon name="ShoppingCart" size={16} />{/snippet}
          Shop
        </Button>
      {/if}
      {#if showPlanning}
        <Button
          size="sm"
          onclick={() => (addToPlannerOpen = true)}
          data-testid="recipe-add-to-planner-button"
        >
          {#snippet leading()}<Icon name="CalendarPlus" size={16} />{/snippet}
          Plan
        </Button>
      {/if}
      <!-- The chat pane's own switch (issue #1141). The TENTH action, and it is allowed
           inline only because it is icon-only and renders from `split` up — never on the
           narrowest phone the row above is sized to, where it would have nothing to do
           anyway (the chat is already a dismissible drawer there). Gated on `docked`
           rather than `chatPaneShown`, because it is the one control that must still be
           there when the pane is off; the row it joins therefore still reads
           Cook · Shop · Plan · ⋮ at every width the budget was set for.

           A labelled button was rejected: a fifth word pushes the row off the edge, and
           this is flipped repeatedly, which also rules out the ⋮ menu (two presses, and
           effectively undiscoverable). The accessible name says which way it will go. -->
      {#if docked}
        <Button
          size="sm"
          variant="ghost"
          class="px-2"
          onclick={() => recipeChatPanePrefs.toggle()}
          ariaLabel={chatPaneShown ? 'Hide chef chat' : 'Show chef chat'}
          title={chatPaneShown ? 'Hide chef chat' : 'Show chef chat'}
          data-testid="recipe-chat-pane-toggle"
          data-state={chatPaneShown ? 'shown' : 'hidden'}
        >
          {#snippet leading()}
            <Icon name={chatPaneShown ? 'PanelRightClose' : 'PanelRightOpen'} size={16} />
          {/snippet}
        </Button>
      {/if}
      <!-- Overflow (⋮), at every width since #735. Cook, Shop and Plan are never in
           here — they stay inline, which is the whole point of ranking them, and
           neither is "Cook, guided", which is a way of pressing Cook.

           GROUPED, not flat (issue #784). The order below was already right, but as
           one undivided list it read as a pile: three genuinely different intents
           with nothing to tell them apart, and the list only gets longer. The
           dividers are the whole of that change — nothing renamed, nothing removed,
           nothing moved behind a second tap, relative order untouched.

             Chat · Optimise · Refresh ·     work on THIS dish, in place
             Guided plan · Cook plan ·
             Bake a batch · Formula
             ─────
             Make a variation · Duplicate    produce a SECOND recipe, leaving this
                                             one alone — the two honest answers to
                                             "I want this dish, but different"
             ─────
             Edit · Delete                   the document, not the food

           Duplicate, Edit and Delete are unconditional: every kind of entry can be
           copied, edited and deleted (deciding that from `kind` is exactly what the
           capability predicates exist to prevent), so the menu is never empty and
           the trigger never opens onto nothing, whatever the gates say above.

           That is also why only the FIRST divider is gated. Group one is empty on
           anything that is neither cookable nor authorable (a takeaway, a
           placeholder), and a divider with nothing above it is a rule across the
           top of a menu; groups two and three always render at least Duplicate and
           Edit, so the second divider is unconditional and can never lead or
           trail. The gate names EVERY condition that can put something in group one
           rather than leaning on the fact that everything authorable happens to be
           cookable today — the day cocktails become authorable (#765) that
           coincidence is what would quietly break. Since #812 that includes
           `hasFormula`, which is presence rather than a capability and so cannot be
           implied by either predicate: a cocktail with a 1:1:1 formula and nothing
           else in group one is exactly the case the third clause covers. #752
           adds `showComponents` on the same footing: also presence rather than a
           capability, so it gets its own clause rather than riding on the kinds
           that happen to be able to take components today. #823 adds
           `showMakeScalable` for the same reason once more — shape rather than
           kind, and the one clause that can be true when `hasFormula` is false. -->
      <Popover bind:open={overflowMenuOpen}>
        <PopoverTrigger>
          {#snippet children()}
            <button
              type="button"
              class="inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="More actions"
              data-testid="recipe-actions-overflow"
            >
              <Icon name="EllipsisVertical" size={20} />
            </button>
          {/snippet}
        </PopoverTrigger>
        <PopoverContent align="end" class="min-w-44 p-1">
          {#if showCooking}
            <PopoverMenuItem
              icon="ChefHat"
              onclick={() => {
                overflowMenuOpen = false;
                void handleAskAmend();
              }}
              disabled={amendBusy}
              data-testid="recipe-ask-amend-menu-item"
            >
              Chat
            </PopoverMenuItem>
          {/if}
          {#if showCooking && hasEquipment}
            <PopoverMenuItem
              icon="Blender"
              onclick={() => {
                overflowMenuOpen = false;
                void handleOptimiseForKitchen();
              }}
              disabled={optimiseBusy || chat.isSending}
              data-testid="recipe-optimise-kitchen-menu-item"
            >
              Optimise
            </PopoverMenuItem>
          {/if}
          {#if canAuthor}
            <!-- Refresh (issue #890). Beside Optimise because both put a canned
                 turn to the chef about THIS dish, and they are the two halves of a
                 pair: Optimise asks whether any of it is better on the household's
                 kit, Refresh asks for the whole thing to be written out again.
                 Gated on `isAuthorable` rather than `isCookable` — the question is
                 whether the librarian can write this kind, which is why an outing
                 and a placeholder never offer it. No equipment gate, unlike
                 Optimise: the repairs this makes do not depend on owning any. -->
            <PopoverMenuItem
              icon="RefreshCw"
              onclick={() => {
                overflowMenuOpen = false;
                void handleRefresh();
              }}
              disabled={refreshBusy || chat.isSending}
              data-testid="recipe-refresh-menu-item"
            >
              Refresh
            </PopoverMenuItem>
          {/if}
          {#if showCooking}
            <!-- "Redo kit" (issue #882). In group one with Optimise and Refresh
                 because it is the third of the same kind: re-run a model over THIS
                 dish in place. Gated on `isCookable` rather than `isAuthorable` —
                 the question is whether there is a method to read, not whether the
                 librarian can write one — which is the same predicate the server's
                 kit branch asks before it spends anything.

                 It lives here rather than beside the list because the list has no
                 controls on it at all: the rows are read, and a recipe whose kit
                 came back empty shows no Equipment tab (#1140), so an action
                 attached to that tab would be unreachable in exactly the case you
                 most want it. -->
            <PopoverMenuItem
              icon="CookingPot"
              onclick={() => {
                overflowMenuOpen = false;
                void handleRedoKit();
              }}
              disabled={kitBusy}
              data-testid="recipe-redo-kit-menu-item"
            >
              Redo kit
            </PopoverMenuItem>
          {/if}
          {#if showCooking}
            <!-- The plan EDITOR (issue #751). In the overflow, not inline: writing
                 or reading the plan is preparation you do BEFORE you cook, at a
                 desk, and the inline actions are the hands-full ones. Distinct from
                 the "Cook, guided" half of the Cook button above, which is cooking.
                 Unconditional within the gate — this is also how you get a first
                 plan, so it cannot depend on one existing. Gated on the same
                 predicate as Cook: a plan explains a method, so an entry with no
                 method has nothing to explain. -->
            <PopoverMenuItem
              icon="ListChecks"
              onclick={() => {
                overflowMenuOpen = false;
                push(`/recipes/${recipe.id}/guided`);
              }}
              data-testid="recipe-guided-plan-menu-item"
            >
              Guided plan
            </PopoverMenuItem>
          {/if}
          {#if showComponents}
            <!-- The cook plan (issue #752, phase 4). Beside "Guided plan" and for
                 exactly the same reason: it is what you open BEFORE you cook, to
                 decide when each dish goes on — the inline row is the hands-full
                 verbs. Gated on the DOCUMENT having components, like the "Made
                 from" card below: a dish with nothing hanging off it has no
                 running order to schedule, and there is no meal `kind` to ask. -->
            <PopoverMenuItem
              icon="Clock"
              onclick={() => {
                overflowMenuOpen = false;
                push(`/recipes/${recipe.id}/cook-plan`);
              }}
              data-testid="recipe-cook-plan-menu-item"
            >
              Cook plan
            </PopoverMenuItem>
          {/if}
          {#if hasFormula}
            <!-- Bread scaling (issue #812, phase 1 of epic #778). BOTH entries sit
                 in group one, immediately after "Guided plan", and both are gated on
                 the FORMULA DOCUMENT EXISTING — never on `kind`.

                 WHY HERE, AND NOT INLINE. The inline row is Cook · Shop · Plan · ⋮
                 and those three slots are the primary verbs — what you came to do
                 with a dish, with your hands full. Neither of these is that.
                 "Guided plan" is the exact precedent: desk work you do BEFORE you
                 cook, at a bench, with the recipe open. Starting a run is the same
                 act one document further along — you are deciding what to weigh out
                 and when to mix, not cooking — and the formula screen is the once-a-
                 month version of it. Group one is right for both because both work
                 on THIS dish rather than producing a second recipe (group two) or
                 editing the document itself (group three).

                 WHY "Bake a batch" LEADS. It is the weekly action; the formula is
                 the monthly one, and it is the thing you open when the batch is
                 wrong. Frequency orders them, exactly as it does Chat before
                 Refresh above.

                 A recipe with NO formula offers neither — there is no batch to
                 start and nothing to open — and until #823 that left the screen
                 with no entry point at all for a recipe that had never had one.
                 What #812 actually objected to was an "add a formula" item on all
                 ~46 recipes, putting baker's percentages in front of every
                 weeknight curry to serve the three loaves; the item below answers
                 that by gating on the basis guess instead of offering it
                 unconditionally. The typed URL stays as the escape hatch for a loaf
                 the guess misses — it stopped being the ONLY way in, not a way
                 in. -->
            <PopoverMenuItem
              icon="Hourglass"
              onclick={() => {
                overflowMenuOpen = false;
                bakeBatchOpen = true;
              }}
              data-testid="recipe-bake-batch-menu-item"
            >
              Bake a batch
            </PopoverMenuItem>
            <PopoverMenuItem
              icon="Percent"
              onclick={() => {
                overflowMenuOpen = false;
                push(`/recipes/${recipe.id}/formula`);
              }}
              data-testid="recipe-formula-menu-item"
            >
              Formula
            </PopoverMenuItem>
          {/if}
          {#if showMakeScalable}
            <!-- The FIRST formula (issue #823). The mutually-exclusive twin of the
                 pair above, in the same slot and carrying the same icon: this is
                 the item you tap once in a recipe's life, and from the moment the
                 formula is saved those two take its place and this one is gone.
                 Nothing else on the page changes — it leads to the screen #806
                 already shipped, which has always handled the no-formula-yet case.

                 Gated on the domain's basis guess, never on `kind` — the
                 `couldHaveFormula` derivation above says why, and what an empty
                 guess costs. Group one for the same reason as the pair it replaces:
                 it works on THIS dish, and mapping a formula is desk work rather
                 than one of the hands-full verbs the inline row is for. "Guided
                 plan" is again the precedent, and this is the once-in-a-recipe's-
                 life version of it. -->
            <PopoverMenuItem
              icon="Percent"
              onclick={() => {
                overflowMenuOpen = false;
                push(`/recipes/${recipe.id}/formula`);
              }}
              data-testid="recipe-make-scalable-menu-item"
            >
              Make it scalable
            </PopoverMenuItem>
          {/if}
          {#if showCooking || canAuthor || hasFormula || showMakeScalable || showComponents}
            <Divider class="my-1" />
          {/if}
          {#if canAuthor}
            <!-- Beside Duplicate because they answer the same impulse — "I want this
                 dish, but different" — and are the two honest answers to it: a literal
                 copy you hand-edit, or a conversation that works the changes out with
                 you. Above it, because talking it through is the one you reach for
                 more often now it exists. -->
            <PopoverMenuItem
              icon="Sparkles"
              onclick={() => {
                overflowMenuOpen = false;
                void handleMakeVariation();
              }}
              disabled={variationBusy}
              data-testid="recipe-make-variation-menu-item"
            >
              Make a variation
            </PopoverMenuItem>
          {/if}
          <PopoverMenuItem
            icon="Copy"
            onclick={() => {
              overflowMenuOpen = false;
              handleDuplicate();
            }}
            data-testid="recipe-duplicate-menu-item"
          >
            Duplicate
          </PopoverMenuItem>
          <Divider class="my-1" />
          <PopoverMenuItem
            icon="Pencil"
            onclick={() => {
              overflowMenuOpen = false;
              push(`/recipes/${recipe.id}/edit`);
            }}
            data-testid="recipe-edit-menu-item"
          >
            Edit
          </PopoverMenuItem>
          <PopoverMenuItem
            variant="destructive"
            icon="Trash2"
            onclick={() => {
              overflowMenuOpen = false;
              deleteOpen = true;
            }}
            data-testid="recipe-delete-menu-item"
          >
            Delete
          </PopoverMenuItem>
        </PopoverContent>
      </Popover>
    {/snippet}

    <!-- Two columns from the fold up (issue #696, Phase 4). At `split` the halves are
         EQUAL, because that is the only thing keeping the gutter over the crease — the
         device reports one viewport segment, so nothing can be aligned to the fold
         directly. `gap-10` is the settled gutter, the same number #663 landed on for the
         planner. Above `lg` there is no crease and the recipe deserves the room, so the
         page keeps the 2fr/1fr it has always had. The nav seam stays at `lg`: the fold
         keeps its bottom bar AND gets two columns.

         The two crease-shaped classes are spelled as NARROWED `split:max-lg:` rather
         than left for the `lg:` pair below to override, and that is not a style
         preference (#1143 hit the same thing in the planner). Tailwind emits the
         `split:` utilities AFTER the `lg:` ones and both are single-class selectors, so
         at a size matching both media queries `split:` wins on source order — written
         unnarrowed, `lg:grid-cols-[2fr_1fr]` and `lg:gap-6` were silently dead and every
         wide screen got equal halves with a 40px gutter. `max-lg` is not a new
         breakpoint, it is the standard `lg` seam read from the other side, so below
         `lg` this compiles to exactly what it compiled to before — which is why this
         spec's 755px cases cannot see the change and a wide case had to be added.

         With the chat switched off (issue #1141) there is one column and the responsive
         classes go with it — the same `chatPaneShown` that drives `fill`, because
         ui-spec-v07 §1.4 requires one gate for both and the pane's on/off state is only
         knowable in JS, so this cannot be expressed as a `split:` variant. `max-w-4xl`
         (896px) is the cap: it is what the recipe already gets from `2fr` of a `2fr_1fr`
         grid on a 1440px monitor, so the collapsed page reads at the width it reads at
         today rather than stretching a method step across the whole screen. `mx-auto`
         centres what is left. -->
    <div
      class={chatPaneShown
        ? 'grid gap-4 split:min-h-0 split:flex-1 split:max-lg:grid-cols-2 split:max-lg:gap-10 lg:grid-cols-[2fr_1fr] lg:gap-6'
        : 'mx-auto grid w-full max-w-4xl gap-4'}
      data-testid="recipe-view"
    >
      <!-- Left column: main recipe content. `min-w-0` because a grid item's automatic
           minimum size is its CONTENT's minimum, and one line of `truncate` text is
           `white-space: nowrap` — a chat titled "<a long recipe name> chat" in the list
           below would size this column to the untruncated title and take the whole page
           wider than the phone with it. -->
      <!-- With the chat beside it this column owns its own scrolling, so reading down the
           method does not move the conversation (#737). With the chat off there is no
           second pane to hold still and no `fill` above to resolve a height against, so
           the classes come off with it — the page scrolls as an ordinary detail page. -->
      <div
        class={chatPaneShown
          ? 'flex min-w-0 flex-col gap-4 split:min-h-0 split:overflow-y-auto'
          : 'flex min-w-0 flex-col gap-4'}
      >
        <!-- Unreviewed AI import (issue #616). Informational, never a gate: the
             recipe below is fully usable. Amber matches the canon review idiom. -->
        {#if recipe.needs_approval}
          <div
            class="flex flex-wrap items-center gap-3 rounded border border-amber-300 bg-amber-50 px-3 py-2"
            data-testid="recipe-unreviewed-banner"
          >
            <p class="flex-1 text-sm text-amber-900">
              Imported automatically — nobody has checked this recipe yet.
            </p>
            <Button
              size="sm"
              variant="outline"
              onclick={handleMarkReviewed}
              loading={markingReviewed}
              disabled={markingReviewed}
              data-testid="recipe-mark-reviewed-button"
            >
              Mark reviewed
            </Button>
          </div>
        {/if}
        <!-- Hero image (Tier-2, issue #148): photoreal "arty" photo generated
             from the title + description by the onRecipeWritten trigger. -->
        {#if heroVisible}
          <div class="flex flex-col gap-2" data-testid="recipe-hero">
            <div class="group relative overflow-hidden rounded-lg border bg-muted">
              <img
                src={recipeHeroUrl(recipe)}
                alt={recipe.title}
                loading="lazy"
                class="aspect-[3/2] w-full object-cover"
                data-testid="recipe-hero-image"
              />
              <!-- Regenerate + Upload as subtle overlay controls: hover-revealed
                   on desktop, faint-always-visible on touch (no hover). -->
              <div class="absolute right-2 top-2 flex gap-2">
                <Button
                  size="icon"
                  variant="outline"
                  onclick={openUpload}
                  disabled={imageBusy}
                  ariaLabel="Upload a photo"
                  title="Upload a photo"
                  class="bg-background/80 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-60"
                  data-testid="recipe-image-upload"
                >
                  {#snippet leading()}<Icon name="Upload" size={16} />{/snippet}
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  onclick={() => (promptOpen = true)}
                  ariaLabel="See the prompt behind this picture"
                  title="See the prompt behind this picture"
                  class="bg-background/80 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-60"
                  data-testid="recipe-image-prompt"
                >
                  {#snippet leading()}<Icon name="Copy" size={16} />{/snippet}
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  onclick={openRegenerate}
                  loading={imageBusy}
                  disabled={imageBusy}
                  ariaLabel="Regenerate image"
                  title="Regenerate image"
                  class="bg-background/80 opacity-0 shadow-sm backdrop-blur-sm transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-60"
                  data-testid="recipe-image-regenerate"
                >
                  {#snippet leading()}<Icon name="RefreshCw" size={16} />{/snippet}
                </Button>
              </div>
            </div>
          </div>
        {:else}
          <div class="flex flex-wrap gap-2" data-testid="recipe-hero-controls">
            <Button
              size="sm"
              variant="outline"
              onclick={openRegenerate}
              loading={imageBusy}
              disabled={imageBusy}
              data-testid="recipe-image-generate"
            >
              {#snippet leading()}<Icon name="ImagePlus" size={14} />{/snippet}
              Generate image
            </Button>
            <Button
              size="sm"
              variant="outline"
              onclick={openUpload}
              disabled={imageBusy}
              data-testid="recipe-image-upload-empty"
            >
              {#snippet leading()}<Icon name="Upload" size={14} />{/snippet}
              Upload a photo
            </Button>
            <!-- The prompt is readable BEFORE anything is drawn (issue #892): with
                 no hero yet this is the prompt that would draw one. -->
            <Button
              size="sm"
              variant="outline"
              onclick={() => (promptOpen = true)}
              data-testid="recipe-image-prompt-empty"
            >
              {#snippet leading()}<Icon name="Copy" size={14} />{/snippet}
              See the prompt
            </Button>
          </div>
        {/if}

        <!-- Description, facts, tags and the phase strip.
             `phaseTotals.hasPhases` joins the card's gate rather than sitting
             outside it: a recipe whose only stated fact is its timing still has
             something to say here (issue #1122). Read through `recipePhaseTotals`
             rather than `phases.length` — the single funnel docs/recipe-module.md
             names (issue #1122 review, should-fix 6). -->
        {#if recipe.description || facts.length > 0 || recipe.metadata.tags.length > 0 || sourceUrl || phaseTotals.hasPhases}
          <Card>
            <CardContent class="flex flex-col gap-3 p-4">
              {#if recipe.description}
                <p class="text-sm text-muted-foreground">{recipe.description}</p>
              {/if}
              <!-- Two rows, two kinds of thing (issue #878). Facts are measured from the
                   dish and carry a glyph; tags are words somebody typed and carry none.
                   Separate rows rather than one wrapped row so the difference survives a
                   narrow screen, where a single row would interleave them again. -->
              {#if facts.length > 0}
                <div class="flex flex-wrap items-center gap-2">
                  {#each facts as fact (fact.key)}
                    <Chip
                      variant="fact"
                      tone={fact.tone ?? 'neutral'}
                      icon={fact.icon}
                      data-testid={fact.testId}
                    >
                      {fact.label}
                    </Chip>
                  {/each}
                </div>
              {/if}
              <!-- No leading `#`. The hash was doing the job the outline now does —
                   saying "this is a tag, not a fact" — back when a tag and a fact
                   were the same grey pill and the punctuation was the only thing
                   telling them apart. With the two kinds visibly different it is
                   just a character in front of every word, and "summer" reads
                   better than "#summer" on a page about dinner. -->
              {#if recipe.metadata.tags.length > 0}
                <div class="flex flex-wrap items-center gap-2">
                  {#each recipe.metadata.tags as tag (tag)}
                    <Chip variant="tag">{tag}</Chip>
                  {/each}
                </div>
              {/if}
              <!-- The planning timeline (issue #1122), and as of #1213 the only
                   timing graphic on this page — the #878 ribbon it used to sit above
                   is gone, along with the Prep/Cook/Total chips.
                   Everything drawn and every figure shown is derived inside the
                   component from this list — nothing is passed in pre-summed. -->
              {#if phaseTotals.hasPhases}
                <RecipePhaseTimeline
                  {phases}
                  timingSummary={recipe.metadata.timingSummary ?? null}
                />
              {/if}
              {#if sourceUrl}
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
              {/if}
            </CardContent>
          </Card>
        {/if}

        <!-- Made from (issue #752). A meal's components lead, above its own
             ingredients: what a Sunday roast IS — chicken, potatoes, gravy — is
             the headline fact about it, and the ingredient list below belongs to
             the roast itself, not to the three dishes. Nothing is aggregated.
             The card is gated on the DOCUMENT having components, in the same
             idiom as Ingredients above: when the concept applies the card is
             there, and the inner guard covers the case where every component has
             since been deleted. Each card is a link to that dish, one level deep;
             a component's own components are neither shown nor read. -->
        {#if showComponents}
          <Card>
            <CardHeader class="px-4 pt-4 pb-0">
              <div class="flex items-center justify-between gap-2">
                <CardTitle class="text-sm">Made from</CardTitle>
                <!-- The same four ways in the recipe list's New menu offers, in
                     the same order and the same idiom — a dish for a meal is
                     made exactly like any other dish. Each entry only says where
                     to start; `startComponent` is what pins the meal to the URL
                     so the far end knows where to come back to. -->
                <Popover bind:open={componentMenuOpen}>
                  <PopoverTrigger>
                    {#snippet children()}
                      <button
                        type="button"
                        class="inline-flex h-8 items-center gap-1 rounded-md border border-input bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                        data-testid="meal-component-new-btn"
                        aria-label="Add a dish to this meal"
                      >
                        <Icon name="Plus" size={14} />
                        New
                        <Icon name="ChevronDown" size={12} class="opacity-80" />
                      </button>
                    {/snippet}
                  </PopoverTrigger>
                  <PopoverContent align="end" class="min-w-48 p-1">
                    <PopoverMenuItem
                      icon="Link"
                      onclick={() => {
                        componentMenuOpen = false;
                        showComponentUrlImport = true;
                      }}
                      data-testid="meal-component-new-import"
                    >
                      Import URL
                    </PopoverMenuItem>
                    <PopoverMenuItem
                      icon="Camera"
                      onclick={() => {
                        componentMenuOpen = false;
                        showComponentPhotoImport = true;
                      }}
                      data-testid="meal-component-new-import-photo"
                    >
                      Import from photo
                    </PopoverMenuItem>
                    <PopoverMenuItem
                      icon="Sparkles"
                      onclick={() => startComponent('/chat')}
                      data-testid="meal-component-new-chat"
                    >
                      Chat with AI
                    </PopoverMenuItem>
                    <PopoverMenuItem
                      icon="Pencil"
                      onclick={() => startComponent('/recipes/new')}
                      data-testid="meal-component-new-manual"
                    >
                      Manual
                    </PopoverMenuItem>
                  </PopoverContent>
                </Popover>
              </div>
            </CardHeader>
            <CardContent class="px-4 pb-4 pt-3">
              {#if components.length === 0}
                <p class="text-sm text-muted-foreground">
                  The dishes this was built from are no longer in the library.
                </p>
              {:else}
                <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="recipe-components">
                  {#each components as component (component.id)}
                    <li>
                      <button
                        type="button"
                        class="group flex w-full items-center gap-3 overflow-hidden rounded-lg border border-border bg-card p-2 text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                              <!-- The kind's own placeholder icon, not a fixed
                                   pot: a cocktail component wears a martini glass
                                   here exactly as it does on the list and in the
                                   week's shop sheet. Which picture a kind wears is
                                   COPY, which is what `KIND_COPY` is for. -->
                              <Icon name={KIND_COPY[kindOf(component)].thumbIcon} size={20} />
                            </span>
                          {/if}
                        </span>
                        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span class="truncate text-sm font-medium">{component.title}</span>
                          {#if componentTimeLabel(component) !== null}
                            <span
                              class="inline-flex items-center gap-1 text-xs text-muted-foreground"
                              data-testid="recipe-component-cook-time"
                            >
                              <Icon name="Clock" size={12} />
                              {componentTimeLabel(component)}
                            </span>
                          {/if}
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            </CardContent>
          </Card>
        {/if}

        <!-- Where the recipe scrolls to when the drawer opens (issue #696): the strip
             left above the chat should hold what the chef is talking about, not the
             hero photograph. It sits immediately above the tab strip rather than above
             the whole body, which is what it meant before there were tabs — a "Made
             from" card between the two would eat the strip the drawer leaves and push
             the ingredients back off the screen. Deliberately OUTSIDE the tab gate, so
             a kind with no body still has somewhere to scroll to. -->
        <div bind:this={bodyAnchorEl} class="scroll-mt-4"></div>

        <!-- The body of the recipe: alternatives, one at a time (issue #878, third
             one added by #1140). They are alternatives on a phone — there is one
             screen and one thing you are doing — and the count on each tab tells you
             the size of the side you are not looking at without opening it.

             The whole STRIP goes when the concept doesn't apply (issue #637), not
             just its contents: a panel headed "Ingredients" saying "No
             ingredients." is worse than no panel, because it reads as an
             unfinished recipe rather than a takeaway. The inner "No ingredients."
             guard stays for the half-written-recipe case it was written for.
             Equipment carries the same reasoning one step further: its trigger and
             panel are gated on the kit existing at all, so a recipe nobody has
             asked the kit question about shows two tabs, not three with an empty
             one.

             Every panel stays mounted while hidden (ui-spec-v10 §8.28.3), which is
             what lets the drawer scroll to either and what keeps every
             `recipe-view-step` countable from a spec. -->
        {#if showBodyTabs}
          <Tabs bind:value={bodyTab}>
            <!-- Equipment, ingredients, method — the order you actually do them in:
                 get the kit out, weigh the things, cook. The strip is not the
                 landing order, though: `bodyTab` opens on Ingredients, because
                 what you check first on a recipe you have not committed to is
                 whether you have the ingredients. Panel order below follows this
                 one, which is what keeps arrow-key focus and reading order
                 agreeing with what is on screen. -->
            <TabsList ariaLabel="Recipe">
              {#if kit.length > 0}
                <TabsTrigger value="equipment" count={kitGroups.length}>Equipment</TabsTrigger>
              {/if}
              <TabsTrigger value="ingredients" count={ingredientCount}>Ingredients</TabsTrigger>
              <TabsTrigger value="method" count={recipe.steps.length}>Method</TabsTrigger>
            </TabsList>

            <!-- Equipment (issue #1140). Was a "You'll need" card of `PictogramPill`
                 chips above the strip; it is a third alternative view of the same
                 region now, which is what ui-spec-v10 §8.28 is for. Read the same
                 way the ingredients beside it are read: one thing per line, the
                 picture in a fixed left gutter, a hairline between rows, so the
                 names start at one left edge and the column is something you run
                 your eye down rather than a heap of chips.

                 THE GUTTER IS RESERVED, THE TILE IS NOT DRAWN ON A MISS. The
                 ingredients list draws `CanonIcon` for every row, matched or not,
                 because its bare tile is what holds the text column straight. Kit
                 cannot borrow that: #882's contract is that a label the drawn
                 vocabulary does not know renders its WORDS with no picture — never
                 the bare placeholder, which reads as a broken image, and never
                 another tool's drawing. A fixed-width empty gutter buys the straight
                 column without the tile, so the two rules do not have to be traded
                 off against each other.

                 The picture comes from `$kitIcons` — equipment vocabulary first,
                 then kitchen tools; that file's header explains at length why the
                 order is load-bearing (#954) — so turning the icon kill-switch off
                 costs the pictures and nothing else.

                 AN ACCESSORY IS NOT A ROW. It is said on the appliance's own row,
                 as a second line under the name: "Cosori 5L Rice Cooker / with the
                 steam basket and rice spoon". `groupKitByEquipment` still decides
                 what belongs to what — a pure query, so the page never guesses, and
                 it never nests an accessory whose appliance this recipe did not ask
                 for — but what it returns is now rendered as ONE line per group.

                 It used to be its own `<li>`, indented `pl-12` and muted, drawing
                 through the same `$kitIcons` lookup as the head row. That lookup is
                 what killed the design: since #1182 a prefixed accessory resolves to
                 its OWNING item, so "hand blender attachment" drew the Ninja's
                 picture at 40px directly beneath the Ninja's picture at 40px, with a
                 full-width hairline between them. The loudest signal on the row said
                 "another one of these" while the indent whispered "part of that" —
                 and the indent lost. Folding it into the appliance removes the
                 second tile, the second hairline and the ambiguity together: a thing
                 that came in the box is not a thing you go and fetch.

                 It is also what the accessibility tree wanted. The indented row
                 needed an `aria-label` — "Rice Spoon, part of Cosori 5L Rice Cooker"
                 — precisely because `pl-12` and `text-muted-foreground` are pixels,
                 not structure, and a screen reader walking a flat `<ul>` was handed
                 siblings. The relationship is now ordinary visible text inside the
                 appliance's own `<li>`, so it is announced with the appliance
                 without a parallel accessible name to keep in step with what is on
                 screen. `RecipeViewPage.kit.test.ts` reads it as text.

                 The tab's count follows the LINES, `kitGroups.length`, exactly as
                 Ingredients counts the lines you will read rather than the groups
                 they sit in. It was `kit.length` while every entry was its own row
                 and the two were the same number; they no longer are. -->
            {#if kit.length > 0}
              <TabsContent value="equipment">
                <Card>
                  <CardContent class="p-4">
                    <ul class="flex flex-col" data-testid="recipe-kit-list">
                      {#each kitGroups as group (group.entry.label)}
                        <li
                          class="flex items-center gap-2 border-b border-border py-1.5 text-sm last:border-b-0"
                          data-testid="recipe-kit-row"
                        >
                          <div class="flex h-10 w-10 shrink-0 items-center justify-center">
                            {#if $kitIcons.kitIconFor(group.entry.label)}
                              <CanonIcon
                                thumbnail={$kitIcons.kitIconFor(group.entry.label)}
                                version={$kitIcons.kitIconVersionFor(group.entry.label)}
                                name={group.entry.label}
                                size={40}
                              />
                            {/if}
                          </div>
                          <span class="min-w-0 flex-1"
                            >{group.entry.label}{#if group.accessories.length > 0}<span
                                class="block text-xs text-muted-foreground"
                                data-testid="recipe-kit-accessories"
                                >with the {accessoryPhrase(group.accessories)}</span
                              >{/if}</span
                          >
                        </li>
                      {/each}
                    </ul>
                  </CardContent>
                </Card>
              </TabsContent>
            {/if}

            <TabsContent value="ingredients">
              <Card>
                <!-- The tab names the panel, so the card no longer repeats the word.
                     The header survives only to carry Canonicalise, which is why it
                     is gated on the button rather than always rendered. -->
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
                  {#if recipe.ingredients.length === 0}
                    <p class="text-sm text-muted-foreground">No ingredients.</p>
                  {/if}
                  {#each recipe.ingredients as group (group.id)}
                    <div class="flex flex-col gap-1.5 [&+&]:mt-4" data-testid="recipe-view-group">
                      {#if group.name}
                        <!-- Sage, not muted grey (issue #878). A component heading —
                             "For the punchy vinaigrette" — divides the list into the
                             sub-recipes you actually make one at a time, and in grey
                             it read as a caption on the rows above it. The palette's
                             secondary is the app's "this is a part of something"
                             colour and it is already what a matched tile settles to,
                             so the heading and the pictograms below it agree. -->
                        <p
                          class="text-xs font-semibold uppercase tracking-wider text-secondary"
                          data-testid="recipe-view-group-name"
                        >
                          {group.name}
                        </p>
                      {/if}
                      <!-- `gap-0` and a hairline instead: the rows used to float
                           1.5 units apart with nothing between them, which reads
                           as nineteen separate things rather than one list. A rule
                           per row does the separating, so the gap can close and the
                           column becomes something you run your eye down. Drawn on
                           the bottom edge and dropped on the last child, so a group
                           never ends on a line pointing at the group below it. -->
                      <ul class="flex flex-col">
                        {#each group.items as ingredient (ingredient.id)}
                          {@const marker = rowMarker(ingredient)}
                          <!-- Three columns (issue #878): the pictogram, the thing,
                           the amount. The tile is the shopping list's since #571 and
                           cook mode's since #532 — one ingredient wears the same
                           picture wherever the app names it — and it is rendered for
                           every row, matched or not, because a bare tile is what
                           holds the text column straight instead of ragging in and
                           out. `matched` lets a matched-but-iconless line settle to
                           sage rather than sitting in unmatched grey while its icon
                           generates.

                           The line is a button (tap → match inspector) and the marker
                           is its SIBLING, not a child: buttons cannot nest, and the
                           two do different jobs — one explains the match, the other
                           acts on what is wrong with it. At most one marker: a line
                           is unmatched, without an amount, or mis-bought — never
                           more than one at a time. The marker
                           now sits on the CORNER OF THE TILE rather than at the end
                           of the line, because what it describes is the match, and
                           the match is what the tile is a picture of. -->
                          <li
                            class="flex items-center gap-2 border-b border-border py-1.5 text-sm last:border-b-0"
                            data-testid="recipe-view-ingredient"
                          >
                            <div class="relative shrink-0">
                              <CanonIcon
                                thumbnail={thumbnailFor(ingredient.canonId)}
                                name={ingredientLabel(ingredient)}
                                version={iconVersionFor(ingredient.canonId)}
                                matched={marker === null &&
                                  hasLiveCanonMatch(ingredient, liveCanonIds)}
                                size={40}
                              />
                              {#if marker === 'unmatched'}
                                <button
                                  type="button"
                                  class="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-xs leading-none text-destructive-foreground ring-2 ring-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                  title="Not matched — tap to match"
                                  aria-label="Not matched — tap to match"
                                  onclick={() => handleRematch(group, ingredient)}
                                  disabled={matchingIds[ingredient.id] ?? false}
                                  data-testid="match-state-unmatched"
                                  >{(matchingIds[ingredient.id] ?? false) ? '…' : '✗'}</button
                                >
                              {:else if marker === 'no-amount'}
                                <!-- Terracotta, like the ⚠ — this line looks finished
                                 too. The glyph and the action are the ✗'s, because
                                 the remedy is the ✗'s: matchIngredient re-parses the
                                 line before it matches it, which is precisely the
                                 repair that populated these rows by hand (issue
                                 #949). Nothing to explain first, so nothing opens. -->
                                <button
                                  type="button"
                                  class="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-tertiary-variant text-xs leading-none text-tertiary-foreground ring-2 ring-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                                  title="No amount — tap to read the line again"
                                  aria-label="No amount — tap to read the line again"
                                  onclick={() => handleRematch(group, ingredient)}
                                  disabled={matchingIds[ingredient.id] ?? false}
                                  data-testid="match-state-no-amount"
                                  >{(matchingIds[ingredient.id] ?? false) ? '…' : '?'}</button
                                >
                              {:else if marker === 'mismatched'}
                                <!-- Terracotta, the palette's warning accent (design.md),
                                 and never the ✗'s red: the two say different things and
                                 want different actions. This one opens the sheet the
                                 row already opens, because the sheet explains BOTH
                                 causes and offers the re-match — no new copy. -->
                                <button
                                  type="button"
                                  class="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-tertiary-variant text-xs leading-none text-tertiary-foreground ring-2 ring-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  title="Matched, but buys the wrong thing — tap to see why"
                                  aria-label="Matched, but buys the wrong thing — tap to see why"
                                  onclick={() => inspectMatch(ingredient)}
                                  data-testid="match-state-mismatched">⚠</button
                                >
                              {/if}
                            </div>
                            <button
                              type="button"
                              class="flex min-w-0 flex-1 items-center gap-3 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              title="See what this ingredient matched"
                              onclick={() => inspectMatch(ingredient)}
                              data-testid="recipe-view-ingredient-inspect"
                            >
                              <!-- The thing first, the amount last. Amounts led this
                                   column until #878 and the order was backwards for
                                   how the list is actually used: you scan for THE
                                   INGREDIENT — do I have chorizo — and only then read
                                   what it says beside it. Names on the left edge means
                                   nineteen of them start at the same x; amounts pinned
                                   right means they still line up as a column, which is
                                   what makes "how much flour, how much water" one
                                   question rather than nineteen.
                                   `min-w-0` so a long name wraps inside its cell rather
                                   than shoving the amount off the row. -->
                              <span class="min-w-0 flex-1">
                                <IngredientText {ingredient} part="name" />
                              </span>
                              <!-- The metric amount, and the measure the source
                                   actually printed sitting UNDER it: "1 ½ cups" is a
                                   second way of saying 300g, so it belongs beneath the
                                   number it restates rather than trailing the end of a
                                   sentence about lentils, where it read as a third
                                   fact about the ingredient.
                                   An UNPARSED line has no separable amount, so both are
                                   empty and the whole raw text sits in the name cell —
                                   which is what keeps a part-parsed list from ragging. -->
                              <span class="shrink-0 text-right tabular-nums leading-tight">
                                <IngredientText {ingredient} part="quantity" /><IngredientText
                                  {ingredient}
                                  part="display"
                                />
                              </span>
                            </button>
                          </li>
                        {/each}
                      </ul>
                    </div>
                  {/each}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="method">
              <Card>
                <CardContent class="p-4">
                  {#if recipe.steps.length === 0}
                    <p class="text-sm text-muted-foreground">No steps.</p>
                  {/if}
                  <!-- The method as a rail (issue #878): a filled disc per step, joined
                       by a connector down to the next one, so the sequence is a shape
                       you can take in before you read a word of it.

                       The rail is drawn PER GAP — one segment from each disc to the
                       one below — rather than as a full-height rule behind the
                       column. That is what settles the "does a two-step recipe want a
                       rail?" question without a threshold to remember: two steps get
                       exactly one short connector, which is the smallest mark that
                       says "then this", and a one-step recipe gets no rail at all
                       because there is nothing to join. A count rule would make the
                       same page draw its steps two different ways depending on how
                       many there are, which is a rule the reader has to learn in
                       exchange for nothing. -->
                  <ol class="flex flex-col">
                    {#each recipe.steps as step, idx (step.id)}
                      {@const handsOff = isHandsOff(step)}
                      {@const firstUse = firstUseByStep.get(step.id) ?? []}
                      {@const stepKit = kitByStep.get(step.id) ?? []}
                      <li
                        class="relative flex gap-3 pb-5 text-sm last:pb-0"
                        data-testid="recipe-view-step"
                      >
                        {#if idx < recipe.steps.length - 1}
                          <span
                            class="absolute bottom-0 left-3 top-7 w-px -translate-x-1/2 bg-border"
                            aria-hidden="true"
                          ></span>
                        {/if}
                        <!-- Hollow for a step you can walk away from. Shape is never
                             the only carrier — the "Hands-off" pill below says it in
                             words, which is what a screen reader and a colour-blind
                             cook actually get. -->
                        <span
                          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold {handsOff
                            ? 'border-2 border-primary bg-card text-primary'
                            : 'bg-primary text-primary-foreground'}"
                          aria-hidden="true">{idx + 1}</span
                        >
                        <div class="flex min-w-0 flex-1 flex-col gap-2">
                          <span>{step.text}</span>

                          <!-- What this step is the first to call for, from the
                               `firstUsedInStepId` the recipe already carries. Cook
                               mode has shown this per step since #532; the reading
                               list never did, and the reading list is where you
                               decide whether tonight is the night.

                               The tile is decorative here — the NAME beside it is the
                               accessible content, so a wall of pictograms reads as a
                               list of ingredients rather than as nothing at all. -->
                          {#if firstUse.length > 0}
                            <ul
                              class="flex flex-wrap items-center gap-1.5"
                              aria-label="First used in this step"
                              data-testid="recipe-view-step-firstuse"
                            >
                              {#each firstUse as ing (ing.id)}
                                <li class="flex items-center" title={ingredientLabel(ing)}>
                                  <span class="flex" aria-hidden="true">
                                    <CanonIcon
                                      thumbnail={thumbnailFor(ing.canonId)}
                                      name={ingredientLabel(ing)}
                                      version={iconVersionFor(ing.canonId)}
                                      matched={hasLiveCanonMatch(ing, liveCanonIds)}
                                      size={32}
                                    />
                                  </span>
                                  <span class="sr-only">{ingredientLabel(ing)}</span>
                                </li>
                              {/each}
                            </ul>
                          {/if}

                          <!-- And what to GET OUT for it (issue #882). Beside the
                               first-use row, in the same idiom, because they answer
                               two different questions about the same step: what it
                               is the first to call for, and what it needs in your
                               hand. Two rows that looked alike but said the same
                               thing would be the bug; two rows that look alike and
                               say different things is the point — hence its own
                               `aria-label`, which is the only thing separating them
                               for a screen reader.

                               Listed at the step the tool COMES OUT and not again
                               until it has been put down (the contiguous-run rule in
                               `kitByStep`), so a long braise does not repeat the same
                               casserole under every step.

                               The tile is decorative; the NAME beside it is the
                               accessible content. A label the drawn vocabulary does
                               not know renders its words with no picture — never
                               `CanonIcon`'s bare placeholder tile, which reads as a
                               broken image, and never another tool's drawing. -->
                          {#if stepKit.length > 0}
                            <ul
                              class="flex flex-wrap items-center gap-1.5"
                              aria-label="Kit this step calls for"
                              data-testid="recipe-view-step-kit"
                            >
                              {#each stepKit as entry (entry.label)}
                                <li
                                  class="flex items-center gap-1"
                                  title={entry.label}
                                  data-testid="recipe-view-step-kit-item"
                                >
                                  {#if $kitIcons.kitIconFor(entry.label)}
                                    <span class="flex" aria-hidden="true">
                                      <CanonIcon
                                        thumbnail={$kitIcons.kitIconFor(entry.label)}
                                        version={$kitIcons.kitIconVersionFor(entry.label)}
                                        name={entry.label}
                                        size={32}
                                      />
                                    </span>
                                    <span class="sr-only">{entry.label}</span>
                                  {:else}
                                    <!-- No picture, so the words stop being the
                                         SR-only label and become the row. -->
                                    <span class="text-xs text-muted-foreground">{entry.label}</span>
                                  {/if}
                                </li>
                              {/each}
                            </ul>
                          {/if}

                          {#if handsOff || step.timer}
                            <div class="flex flex-wrap items-center gap-1.5">
                              {#if handsOff}
                                <!-- Sage: the quiet end of the palette, for the one step
                                     marker telling you to walk away rather than to do
                                     something, paired against the terracotta timer chip
                                     beside it, which is the opposite instruction. (The
                                     #878 ribbon keyed its waits to this hue; it went with
                                     issue #1213, and the phase timeline that replaced it
                                     draws its hands-off time on the teal tint.) -->
                                <span
                                  class="inline-flex items-center rounded-full bg-secondary-container px-2 py-0.5 text-xs font-medium text-secondary-container-foreground"
                                  data-testid="recipe-view-step-handsoff">Hands-off</span
                                >
                              {/if}
                              {#if step.timer}
                                <!-- Terracotta, the palette's accent for a thing that
                                     wants attention at a moment (design.md), and
                                     `formatMinutes` rather than the raw number — this
                                     is the markup that genuinely said "720 min". -->
                                <span
                                  class="inline-flex items-center gap-1 rounded-full bg-tertiary-variant/10 px-2 py-0.5 text-xs font-medium text-tertiary-variant"
                                  data-testid="recipe-view-step-timer"
                                >
                                  <Icon name="Timer" size={12} />
                                  {formatMinutes(step.timer.durationMinutes)}{step.timer.description
                                    ? ` — ${step.timer.description}`
                                    : ''}
                                </span>
                              {/if}
                            </div>
                          {/if}

                          <!-- Terracotta, NOT amber. Amber on this page means "a human
                               has not looked at this yet" — the unreviewed-import
                               banner and the guided-plan dot — and a step note is not
                               that: it is a caution about the cooking, written
                               deliberately, and wearing the review colour made it read
                               as an unfinished recipe. -->
                          {#if step.note}
                            <div
                              class="flex items-start gap-2 rounded border border-tertiary-variant/30 bg-tertiary-variant/10 px-3 py-2 text-xs text-tertiary-variant"
                              data-testid="recipe-step-note-content"
                            >
                              <Icon name="TriangleAlert" size={13} class="mt-0.5 shrink-0" />
                              <span class="whitespace-pre-wrap">{step.note}</span>
                            </div>
                          {/if}
                        </div>
                      </li>
                    {/each}
                  </ol>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        {/if}

        <!-- Notes. BELOW the tab strip, not inside a panel (issue #878): a note is
             about the dish, not about its ingredients or its method, so it stays
             visible whichever tab is showing. -->
        {#if recipe.notes}
          <Card>
            <CardHeader class="px-4 pt-4 pb-0">
              <CardTitle class="text-sm">Notes</CardTitle>
            </CardHeader>
            <CardContent class="px-4 pb-4 pt-3">
              <!-- `breaks` is what makes this a no-op for every note written before
                   notes were Markdown: it keeps each typed line break a line break,
                   exactly as the old whitespace-pre-wrap paragraph did. -->
              <Markdown text={recipe.notes} breaks class="text-sm text-muted-foreground" />
            </CardContent>
          </Card>
        {/if}

        <!-- Every chat about this dish (issue #696). With no chat column — below the
             seam, or above it with the pane switched off (#1141) — the list lives at the
             foot of the recipe; otherwise it moves into that column, above the
             conversation it selects. Rendered in one place or the other, never both and
             never neither — one `recipe-chat-list` on the page. That is also what keeps
             past conversations reachable with the pane off, and why picking one from here
             turns the pane back on rather than being a dead press. -->
        {#if !chatPaneShown}
          {@render chatListCard()}
        {/if}
      </div>

      <!-- Right column: the chat, docked from `split` up. Below that it is `hidden` and
           Phase 3's drawer is the whole story — the reveal hack this column used to need
           is gone with it.

           Switching the pane off drops the `split:flex` that reveals it, leaving the
           `hidden` it already carries below the seam — a CLASS, deliberately, not an
           `{#if}`. Issue #1141 requires that restoring the pane land on the same
           conversation scrolled where you left it, and `ChatThread` auto-scrolls to the
           newest message when it mounts: unmounting the column would therefore lose the
           transcript's scroll position AND anything half-typed in the composer. Keeping
           it mounted-but-hidden is also what this page already does below the seam (see
           `sidebarChatActions` / `drawerChatActions`, which carry distinct testids
           precisely because both surfaces can be mounted at once).

           `display: none` is a real hide, not a paint-over: the column leaves the
           accessibility tree, takes no grid track, and nothing inside it stays focusable.
           The preference alone gates it rather than `chatPaneShown`, because the `split:`
           variant is already the other half of that conjunction. -->
      <div
        class={recipeChatPanePrefs.on
          ? 'hidden min-w-0 flex-col split:flex split:min-h-0'
          : 'hidden'}
        data-testid="recipe-chat-sidebar"
      >
        <!-- The card fills this column and the transcript inside it does the scrolling.
             It used to be `sticky` with a guessed `max-h-[calc(100dvh - 5.5rem)]`, which
             was the whole of #737: the number was wrong, so the composer sat below the
             scrollport; and being sticky it only settled after the recipe had been
             scrolled past the header, which a short recipe never can. Both are gone —
             the height comes from the fill chain now, and nothing here measures chrome. -->
        <Card class="flex flex-col overflow-hidden split:min-h-0 split:flex-1">
          <CardHeader class="shrink-0 border-b px-4 py-3">
            <div class="flex items-center justify-between gap-2">
              <CardTitle class="truncate text-sm">Chef Chat</CardTitle>
              <div class="flex shrink-0 items-center gap-1">
                {@render sidebarChatActions()}
                {#if activeSession}
                  <Button
                    size="sm"
                    variant="ghost"
                    onclick={() => push(`/chat/${activeSession!.id}`)}
                    aria-label="Open full chat"
                  >
                    <Icon name="ExternalLink" size={14} />
                  </Button>
                {/if}
              </div>
            </div>
            {#if !activeSession}
              <CardDescription class="text-xs">
                Chat about this recipe while you cook.
              </CardDescription>
            {/if}
          </CardHeader>

          {#if activeSession === null}
            <!-- No session yet: the conversations this recipe already has, then the
                 prompt to start another. The list is still rendered here because there
                 is no transcript to put it above yet — without it a recipe whose chats
                 are all closed would list none of them. -->
            <CardContent class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              {#if chatPaneShown}
                <div class="shrink-0">{@render chatListCard()}</div>
              {/if}
              <div class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
                <p class="text-sm text-muted-foreground">
                  Ask your chef to refine this recipe, scale it, or answer cooking questions.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  class="w-full"
                  onclick={createRecipeChat}
                  loading={amendBusy}
                  disabled={amendBusy}
                >
                  {#snippet leading()}<Icon name="ChefHat" size={16} />{/snippet}
                  Start a chat
                </Button>
              </div>
            </CardContent>
          {:else}
            <!-- The list rides INSIDE the transcript's scroll box (`aboveTranscript`), so
                 it scrolls off as the conversation grows and a long reply gets the whole
                 column. Scroll the pane back to the top to switch conversations. Guarded
                 on `chatPaneShown` because whenever this column is not on screen the list
                 lives at the foot of the recipe instead — one `recipe-chat-list` on the
                 page, never two. -->
            <ChatThread
              session={activeSession}
              thread={chat}
              layout="panel"
              emptyText="Ask me anything about this recipe."
              starters={recipeStarters}
              aboveTranscript={chatPaneShown ? dockedChatList : undefined}
            />
          {/if}
        </Card>
      </div>
    </div>
  </DetailPage>
{/if}

<!-- Add to shopping list review sheet -->
{#if recipe && $defaultListId}
  <RecipeAddToListSheet {recipe} listId={$defaultListId} bind:open={addToListOpen} />
{/if}

<!-- What one ingredient matched. Mounted unconditionally: it needs no recipe of
     its own, only whichever ingredient was last tapped. -->
<IngredientMatchSheet
  ingredient={inspecting}
  bind:open={inspectorOpen}
  rematching={inspecting ? (matchingIds[inspecting.id] ?? false) : false}
  onRematch={rematchFromSheet}
/>

<!-- Day picker for "Add to planner" -->
{#if recipe}
  <RecipeAddToPlannerSheet {recipe} bind:open={addToPlannerOpen} />
{/if}

<!-- The two import dialogs, for the meal's "New" menu (issue #752, Phase 3).
     The very same components the recipe list mounts — neither navigates, so the
     landing is ours to choose, and ours carries the meal. Mounted only on a meal,
     alongside the menu that is their only way in here. -->
{#if showComponents}
  <RecipeImportUrlDialog
    bind:open={showComponentUrlImport}
    onImported={(imported) => openComponentEditor(imported, 'url')}
  />
  <RecipeImportPhotoDialog
    bind:open={showComponentPhotoImport}
    onImported={(imported) => openComponentEditor(imported, 'photo')}
  />
{/if}

<!-- The scale sheet (issue #812). Mounted only where there is a formula to scale,
     which is the same condition its menu entry is gated on — the sheet takes the
     formula as a plain prop rather than reading the store itself, so it can never
     render against a `null` one. -->
{#if recipe && breadEnabled && $formula}
  <RecipeBakeBatchSheet {recipe} formula={$formula} bind:open={bakeBatchOpen} />
{/if}

<!-- The docked column's copy of the list, with the gap to the first message baked in
     here rather than in `ChatThread` — the hook is deliberately unstyled so the host
     owns its own spacing. -->
{#snippet dockedChatList()}
  <div class="mb-4">{@render chatListCard()}</div>
{/snippet}

{#snippet chatListCard()}
  <RecipeChatList
    chats={recipeChats}
    activeId={activeSession?.id ?? null}
    onSelect={openChat}
    onNew={handleNewChat}
    creating={amendBusy}
  />
{/snippet}

<!-- "Review changes", wherever the conversation is being read — the docked column or
     the drawer. One handler for both, so an edit proposed from a phone and an edit
     proposed from a laptop are the same act.

     Both actions live in the panel's HEADER now (issue #878), not in a bar above the
     composer. A full-width button under the transcript is height the conversation never
     gets back, and there were two of them; up here they cost the row the title already
     occupies. That is also why they are icon-only: the narrowest column this card
     renders in is about 300px, which a labelled pair does not fit — and the header was
     already an icon-only row ("Open full chat"), so they read as part of it. `ariaLabel`
     carries the whole name, so nothing is lost to a screen reader. -->
{#snippet reviewChangesAction(testid: string)}
  {#if activeSession?.messages.some((m) => m.role === 'assistant')}
    <Button
      size="sm"
      variant="ghost"
      onclick={handleSidebarReviewChanges}
      loading={sidebarIsProposing}
      disabled={sidebarIsProposing || chat.isSending}
      ariaLabel="Review changes"
      data-testid={testid}
    >
      {#snippet leading()}<Icon name="RefreshCw" size={14} />{/snippet}
    </Button>
  {/if}
{/snippet}

<!-- Its counterpart (issue #798). Same gate — an empty conversation has nothing to
     author either — and deliberately the same shape, because the pair is the whole
     point: one folds what was said into THIS dish, the other makes it a different
     one. It moves WITH its twin for that reason: relocating one and leaving the
     other would keep the bar and split a pair the design treats as one thing. -->
{#snippet saveAsNewRecipeAction(testid: string)}
  {#if activeSession?.messages.some((m) => m.role === 'assistant')}
    <Button
      size="sm"
      variant="ghost"
      onclick={handleSaveAsNewRecipe}
      loading={sidebarIsSavingNew}
      disabled={sidebarIsSavingNew || chat.isSending}
      ariaLabel="Save as new recipe"
      data-testid={testid}
    >
      {#snippet leading()}<Icon name="BookOpen" size={14} />{/snippet}
    </Button>
  {/if}
{/snippet}

<!-- The two surfaces are separate DOM nodes and both can be mounted at once (the column
     is merely `hidden` below `lg`), so they carry distinct testids — one ambiguous
     selector is a worse trap than two names for one button. -->
{#snippet sidebarChatActions()}
  {@render reviewChangesAction('sidebar-apply-changes-btn')}
  {@render saveAsNewRecipeAction('sidebar-save-new-recipe-btn')}
{/snippet}

{#snippet drawerChatActions()}
  {@render reviewChangesAction('drawer-apply-changes-btn')}
  {@render saveAsNewRecipeAction('drawer-save-new-recipe-btn')}
{/snippet}

<!-- The chef over the live recipe (issue #696). Only below the seam: above it the same
     conversation is docked in its own column, and two of it would be one too many. -->
{#if recipe && activeSession && drawerOpen && !docked}
  <RecipeChatDrawer
    session={activeSession}
    thread={chat}
    onClose={() => (drawerOpen = false)}
    onOpenFull={() => push(`/chat/${activeSession!.id}`)}
    headerActions={drawerChatActions}
    starters={recipeStarters}
  />
{/if}

<!-- Review-and-approve gate for the pending AI edit (Phase 2) -->
<RecipeChangeSummary
  diff={sidebarPending?.diff ?? null}
  bind:open={sidebarSummaryOpen}
  applying={sidebarIsApplying}
  onApply={handleSidebarApplyChanges}
  onDiscard={handleSidebarDiscardChanges}
/>

<!-- Regenerate image dialog: the editable scene brief (issue #148) -->
<Dialog bind:open={regenOpen}>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="recipe-image-regenerate-dialog">
      <DialogHeader>
        <DialogTitle>Regenerate image</DialogTitle>
        <DialogDescription>
          This is the art direction behind the current photo — edit it and generate. Leave it empty
          to have a fresh one written for you.
        </DialogDescription>
      </DialogHeader>
      <!--
        maxLength mirrors the 2000-char cap on RegenerateRecipeImageInputSchema.brief
        so the limit is felt at the keyboard rather than as an opaque failure after
        Generate. autoresize + rows=6 so a one-paragraph brief is visible whole
        without scrolling, which is the point — you cannot edit what you cannot read.
      -->
      <Textarea
        label="Scene brief"
        placeholder="e.g. Served in a deep bowl on a sunlit table, steam rising, shot from above."
        rows={6}
        autoresize
        maxLength={2000}
        value={regenBrief}
        onValueChange={(v) => (regenBrief = v)}
        disabled={briefBusy}
        data-testid="recipe-image-regenerate-brief"
      />

      <!--
        Ask for a revision (issue #522, Phase 3). Type a steer, press Revise, and the
        text model rewrites the brief above with that steer folded THROUGH it — light,
        props, surface and palette moving together — and hands it back here, still
        editable, before any image is paid for. maxLength mirrors the 200-char cap on
        DescribeRecipeSceneInputSchema.hint. Enter submits: this is a one-line steer
        you will press repeatedly, and reaching for the mouse each time is friction the
        iteration loop can't afford.
      -->
      <div class="flex flex-col gap-2">
        <div class="flex items-end gap-2">
          <TextField
            class="flex-1"
            label="Ask for a revision"
            placeholder="e.g. make it summery"
            maxlength={200}
            value={regenHint}
            onValueChange={(v) => (regenHint = v)}
            disabled={briefBusy}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleReviseBrief();
              }
            }}
            data-testid="recipe-image-regenerate-hint"
          />
          <Button
            variant="outline"
            onclick={handleReviseBrief}
            loading={briefBusy}
            disabled={briefBusy || !regenHint.trim() || !regenBrief.trim()}
            data-testid="recipe-image-regenerate-revise"
          >
            Revise
          </Button>
        </div>
        <div class="flex items-center justify-between gap-2">
          <!--
            Start over is ALWAYS available: the brief is sticky, so a recipe you have
            since rewritten would otherwise keep art direction for the dish it used to
            be forever. This re-reads the current recipe and discards the accumulated
            edits — hence the explicit warning in the copy.
          -->
          <button
            type="button"
            class="text-xs text-primary hover:underline disabled:opacity-50"
            onclick={handleStartOverBrief}
            disabled={briefBusy}
            data-testid="recipe-image-regenerate-start-over"
          >
            Start over from the recipe
          </button>
          {#if briefBusy}
            <span class="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner size={12} />
              Rewriting the brief…
            </span>
          {/if}
        </div>
        {#if briefError}
          <p class="text-xs text-destructive" data-testid="recipe-image-regenerate-brief-error">
            {briefError}
          </p>
        {/if}
      </div>

      <DialogFooter>
        <Button variant="outline" onclick={() => (regenOpen = false)} disabled={imageBusy}>
          Cancel
        </Button>
        <!--
          Also disabled while a brief revision is in flight: generating right then
          would pay for an image directed by the brief the user is mid-way through
          replacing — the exact wasted render this feature exists to prevent.
        -->
        <Button
          onclick={handleRegenerateConfirm}
          loading={imageBusy}
          disabled={imageBusy || briefBusy}
          data-testid="recipe-image-regenerate-confirm"
        >
          Regenerate
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

<!-- Upload photo dialog: pick a local image → crop to 3:2 → Save (issue #455) -->
<Dialog bind:open={uploadOpen} onOpenChange={handleUploadOpenChange}>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="recipe-image-upload-dialog">
      <DialogHeader>
        <DialogTitle>Upload a photo</DialogTitle>
        <DialogDescription>
          Choose a photo from your device — or paste one you've copied — and position it in the 3:2
          frame — drag to pan, scroll or use the slider to zoom.
        </DialogDescription>
      </DialogHeader>

      {#if uploadSrc}
        <ImageCropper bind:this={cropper} src={uploadSrc} />
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="text-xs text-primary hover:underline disabled:opacity-50"
            onclick={clearUploadSrc}
            disabled={uploadBusy}
            data-testid="recipe-image-upload-choose-another"
          >
            Choose a different photo
          </button>
          {#if canPasteFromClipboard}
            <button
              type="button"
              class="text-xs text-primary hover:underline disabled:opacity-50"
              onclick={handlePasteButton}
              disabled={uploadBusy}
              data-testid="recipe-image-paste"
            >
              Paste from clipboard
            </button>
          {/if}
        </div>
      {:else}
        <label
          class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-input px-4 py-10 text-sm text-muted-foreground hover:bg-muted/50"
        >
          <Icon name="ImagePlus" size={24} />
          <span>Tap to choose a photo</span>
          <input
            type="file"
            accept="image/*"
            class="sr-only"
            onchange={handleUploadFileChange}
            data-testid="recipe-image-upload-input"
          />
        </label>
        {#if canPasteFromClipboard}
          <Button
            variant="outline"
            onclick={handlePasteButton}
            disabled={uploadBusy}
            data-testid="recipe-image-paste-empty"
          >
            {#snippet leading()}<Icon name="Clipboard" size={16} />{/snippet}
            Paste from clipboard
          </Button>
          <p class="text-center text-xs text-muted-foreground">
            or press {pasteShortcutLabel} to paste a copied image
          </p>
        {:else}
          <p
            class="text-center text-xs text-muted-foreground"
            data-testid="recipe-image-paste-hint"
          >
            Pasting isn't supported in this browser — choose a photo above instead.
          </p>
        {/if}
      {/if}

      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => handleUploadOpenChange(false)}
          disabled={uploadBusy}
        >
          Cancel
        </Button>
        <Button
          onclick={handleUploadSave}
          loading={uploadBusy}
          disabled={uploadBusy || !uploadSrc}
          data-testid="recipe-image-upload-save"
        >
          Save
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

<!-- Delete confirm dialog -->
<Dialog
  bind:open={deleteOpen}
  onOpenChange={(v) => {
    if (!v) deleteBusy = false;
  }}
>
  <DialogContent>
    <div class="flex flex-col gap-4" data-testid="recipe-delete-dialog">
      <DialogHeader>
        <DialogTitle>Delete "{recipe?.title ?? ''}"?</DialogTitle>
        <DialogDescription>This action cannot be undone.</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onclick={() => (deleteOpen = false)} disabled={deleteBusy}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          onclick={handleDelete}
          loading={deleteBusy}
          disabled={deleteBusy}
          data-testid="recipe-delete-confirm"
        >
          Delete
        </Button>
      </DialogFooter>
    </div>
  </DialogContent>
</Dialog>

{#if recipe}
  <ImagePromptDialog
    bind:open={promptOpen}
    family="recipe"
    id={recipe.id}
    subject={recipe.title}
    data-testid="recipe-prompt-dialog"
  />
{/if}
