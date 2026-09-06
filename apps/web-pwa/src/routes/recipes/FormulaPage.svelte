<script lang="ts">
  import { untrack } from 'svelte';
  import {
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Checkbox,
    DetailPage,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Icon,
    RadioGroup,
    RadioGroupItem,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    Spinner,
    TextField,
  } from '@salt/ui-components';
  import { goBack } from '../../lib/nav.js';
  import FeatureGuard from '../../components/FeatureGuard.svelte';
  import { recipes, isLoadingRecipes } from '../../lib/recipeService.js';
  import { canonItems } from '../../lib/canonService.js';
  import {
    formula as storedFormula,
    initFormulaSync,
    saveFormula,
    extractProcessStages,
  } from '../../lib/formulaService.js';
  import {
    deriveFormula,
    doughAmountGrams,
    flattenIngredients,
    gramsFromParsed,
    guessBasisIngredientIds,
    roundGrams,
    takesIngredients,
    targetYield,
    totalDurationMinutes,
    withStageAdded,
    withStageMoved,
    withStageRemoved,
    withStageUpdated,
  } from '@salt/domain';
  import type { Ingredient } from '@salt/domain';
  import type {
    Formula,
    FormulaComponent,
    ProcessStage,
    ProcessStageKind,
  } from '@salt/domain/schemas';
  import { equipment } from '../../lib/equipmentService.js';
  import { kindOf } from './recipeKind.js';
  import {
    EMPTY_DOUGH_ANSWER,
    LOAF_TIN_CHIP_GRAMS,
    doughAmountFrom,
    seedDoughAnswer,
    suggestedTrayGrams,
    type DoughAnswerFields,
    type DoughAnswerMode,
    type TrayBy,
  } from './doughAnswer.js';
  import { formatMinutes } from '../../lib/durationDisplay.js';
  import { formatDoughAmount, formatGrams } from '../../lib/quantityDisplay.js';
  import { addToast } from '../../lib/toastStore.js';

  // The formula screen (issue #806, phase 1 of epic #778) — `/recipes/:id/formula`.
  //
  // An ordinary AppShell route, deliberately NOT full-viewport: this is desk work
  // done once a month, not a hands-full mode. It is reachable BY URL ONLY — the
  // recipe page gains nothing in this phase, so opening a loaf is indistinguishable
  // from opening any other dish.
  //
  // What it is FOR: turning a recipe's grams into baker's percentages against a
  // declared basis, with a human confirming the two things the machine cannot know
  // — which ingredients ARE the basis, and what a count-based line weighs.
  //
  // THE RECIPE IS NEVER TOUCHED. Nothing here writes `recipes`, and no quantity is
  // ever shown at any yield other than as-written: the only two figures on screen
  // beyond the recipe's own are the dough total (the recipe's own arithmetic) and
  // the declared shape (what the user just said). Scaled quantities belong to the
  // batch, phase 02.
  //
  // ─── Stages (phase 2) ────────────────────────────────────────────────────────
  //
  // The second half of the screen reviews the recipe's PROCESS: the ordered stages
  // the dough goes through, extracted by AI and then corrected by hand. Three rules
  // hold it together:
  //
  //   • EXTRACTION DOES NOT SAVE. It fills the review surface and marks the page
  //     dirty; Save is still the one write path, so the stages are seen before they
  //     are stored.
  //   • RE-RUNNING REPLACES, and says so first. Whole-document LWW — there is no
  //     merge, and a re-run over hand corrections would silently discard them.
  //   • ADDING A STAGE BY HAND IS FIRST-CLASS. The spike swallowed one of four
  //     20-minute rests buried in a single sentence; a screen that can only accept
  //     or reject what the model found would leave that recipe permanently wrong.
  //
  // Still no clock anywhere. A stage says how long it takes; when it starts belongs
  // to a batch, which is phase 02 and a different document.

  let { params }: { params?: { id?: string } } = $props();

  const recipeId = $derived(params?.id ?? '');
  const recipe = $derived($recipes.find((r) => r.id === recipeId) ?? null);
  const ingredients = $derived(recipe ? flattenIngredients(recipe) : []);

  // Canon supplies the tidy name a flour guess reads best from ("strong white
  // flour", not "500g strong white bread flour, plus extra for dusting"). Domain
  // never sees the store: the ids are resolved HERE and the already-resolved text
  // is what crosses the boundary.
  const canonNameById = $derived(new Map($canonItems.map((c) => [c.id, c.name])));

  // Subscribe to this recipe's formula for as long as the page is open. Re-runs
  // when the id changes; the service resets its store on every init so a formula
  // from a previous recipe can never be shown against this one.
  $effect(() => {
    if (!recipeId) return;
    return initFormulaSync(recipeId);
  });

  // ─── The working model ────────────────────────────────────────────────────────
  //
  // A GRAM LIST, deliberately — not a percentage list. `deriveFormula` is the only
  // maths on this page, and one code path covers all four interactions: the initial
  // derive, a basis toggle, a hand-typed weight and an exclusion. There is no
  // second "rebase the percentages" function anywhere, because there is nothing for
  // one to do.
  //
  // `gramsText` is the RAW STRING being typed, for the same reason GuidedPlanPage
  // keeps a check-in's minutes as a string: re-rendering the box from a parsed
  // number means clearing it to type a new figure snaps it back to the old one.
  interface Row {
    ingredientId: string;
    rawText: string;
    // What the recipe itself says this weighs, or null for a count-based line
    // ("2 eggs") and for anything with no amount at all ("a pinch"). The anchor
    // every displayed gram figure is pinned to — see `anchorBasisGrams`.
    recipeGrams: number | null;
    // The recipe gave a range and one end of it was taken (`quantityToNumber`,
    // issue #917). Disclosed on screen, because this screen is the only moment
    // anyone can object: once the range is a percentage it is gone for good.
    isRange: boolean;
    gramsText: string;
    included: boolean;
    inBasis: boolean;
  }

  // A stage as the review surface holds it: the real stage, plus the three numeric
  // fields kept as the RAW STRING being typed. Same reason as `gramsText` above —
  // re-rendering a box from a parsed number means clearing it to type a new figure
  // snaps it back to the old one. `withStage*` are generic over exactly this, so
  // the draft reorders and deletes through the domain producers without the domain
  // knowing what a half-typed temperature is.
  interface StageRow extends ProcessStage {
    // The low end, or the whole of a fixed temperature. Same two-box shape as the
    // duration below, because a stage temperature is now a range-or-fixed too
    // (issue #1281) and one control answering both questions is the defect.
    celsiusText: string;
    maxCelsiusText: string;
    // The chosen place, held as the raw picker value ('' = nowhere in particular)
    // rather than read back out of `environment`. A place picked before a
    // temperature is typed would otherwise vanish, because an environment with no
    // temperature is not a shape this schema has.
    placeId: string;
    // The low end, or the whole of a fixed duration.
    minutesText: string;
    // Empty means fixed. Filled and different means a range, kept AS A RANGE.
    maxMinutesText: string;
  }

  // The places this household has described, for the per-stage picker. Ordinary
  // equipment is not offered: a knife block is not somewhere a prove happens.
  const places = $derived(($equipment?.items ?? []).filter((i) => i.environment !== null));
  const placeNames = $derived(new Map(places.map((p) => [p.id, p.name])));
  // The picker's "nowhere in particular" option. A Select cannot hold null, and
  // the kitchen counter is deliberately not an equipment entry, so the two
  // readings — nothing chosen, and deliberately the counter — are one value.
  const NO_PLACE = '';

  let rows = $state<Row[]>([]);
  let stageRows = $state<StageRow[]>([]);
  // "What are you filling?" — the same three answers the bake sheet asks, held as
  // raw strings for the same reason `gramsText` is. THE STAKES DIFFER, which is why
  // this is not that form rendered twice: answering here EDITS THE RECIPE, and the
  // re-anchoring disclosure below the card is what says so. Nothing about the
  // vessel is stored — a formula is written for a quantity of dough, and the tin is
  // a fact about tonight (`doughAnswer.ts`, `BatchSchema.vessel`).
  let answerMode = $state<DoughAnswerMode>('tin');
  let answer = $state<DoughAnswerFields>({ ...EMPTY_DOUGH_ANSWER });
  // Whether the working model holds changes the stored document does not. Guards
  // the re-seed below: an incoming snapshot never overwrites work in progress.
  let dirty = $state(false);
  let saving = $state(false);

  // A trimmed, finite, strictly-positive number, or nothing. Named for what it
  // IS rather than for one of the boxes that wants it: this page has three such
  // boxes (an ingredient's grams, a stage's minutes, a stage's max minutes) and
  // used to declare the same four lines twice, once as `parseGrams` and once as
  // `parseMinutes` ten lines apart. `parseGrams(row.minutesText)` would have read
  // as a mistake at the call site, which is why this is a rename rather than one
  // parser delegating to the other (issue #1055).
  //
  // Deliberately more lenient than `cookTimerDuration.ts`'s `parseMinutes`, which
  // demands `/^\d+$/` and `>= 1` because the −/+ chips write into that field. A
  // process stage's duration is `z.number().positive()` — non-integers are
  // schema-legal — so adopting the strict parser here would start rejecting valid
  // input. The two are pinned side by side in `FormulaPageStages.test.ts`, and
  // `sharedHelperGuard.test.ts` asserts this file declares exactly one of these.
  function parsePositiveNumber(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function gramsOf(row: Row): number | null {
    return parsePositiveNumber(row.gramsText);
  }

  // Temperatures, unlike weights, may be zero or below — a freezer is a legitimate
  // environment, so this cannot reuse `parsePositiveNumber`.
  function parseCelsius(text: string): number | null {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  }

  // ─── Stage rows ↔ stages ──────────────────────────────────────────────────────

  function stageRowFrom(stage: ProcessStage): StageRow {
    const duration = stage.duration;
    return {
      ...stage,
      celsiusText:
        stage.environment === null
          ? ''
          : String(
              stage.environment.temperature.kind === 'fixed'
                ? stage.environment.temperature.celsius
                : stage.environment.temperature.minCelsius,
            ),
      maxCelsiusText:
        stage.environment !== null && stage.environment.temperature.kind === 'range'
          ? String(stage.environment.temperature.maxCelsius)
          : '',
      placeId: stage.environment?.equipmentId ?? '',
      minutesText:
        duration === null
          ? ''
          : String(duration.kind === 'fixed' ? duration.minutes : duration.minMinutes),
      maxMinutesText:
        duration !== null && duration.kind === 'range' ? String(duration.maxMinutes) : '',
    };
  }

  /**
   * The draft row back to a stage. The three text fields collapse the same way in
   * both directions: an empty temperature is no environment at all (a mix has none),
   * an empty duration is no duration (an observational stage — "until doubled"), and
   * a second minutes box that is filled and different is a RANGE, kept as one.
   *
   * `relativeHumidityPercent` is carried through untouched rather than edited. There
   * is nothing in bread that sets it and no box for it on this screen; a curing
   * chamber (phase 04) is what earns the field an input.
   */
  function stageFrom(row: StageRow): ProcessStage {
    const celsius = parseCelsius(row.celsiusText);
    const maxCelsius = parseCelsius(row.maxCelsiusText);
    const humidity = row.environment?.relativeHumidityPercent;
    const minutes = parsePositiveNumber(row.minutesText);
    const maxMinutes = parsePositiveNumber(row.maxMinutesText);
    return {
      id: row.id,
      label: row.label.trim(),
      kind: row.kind,
      environment:
        celsius === null
          ? null
          : {
              temperature:
                maxCelsius === null || maxCelsius === celsius
                  ? { kind: 'fixed', celsius }
                  : { kind: 'range', minCelsius: celsius, maxCelsius },
              ...(humidity === undefined ? {} : { relativeHumidityPercent: humidity }),
              // A place named on a stage whose temperature has since been cleared
              // goes with it: an environment is the whole answer to "where", and
              // half of one is not worth storing.
              equipmentId: row.placeId === '' ? null : row.placeId,
            },
      duration:
        minutes === null
          ? null
          : maxMinutes === null || maxMinutes === minutes
            ? { kind: 'fixed', minutes }
            : { kind: 'range', minMinutes: minutes, maxMinutes },
      until: (row.until ?? '').trim() === '' ? null : (row.until ?? '').trim(),
      stepId: row.stepId,
      // Carried, never derived. The flag is the recipe's own opinion — from the
      // method's words via extraction, or from this screen's checkbox — and it
      // gates nothing here or anywhere downstream.
      optional: row.optional,
    };
  }

  // ─── Seeding ──────────────────────────────────────────────────────────────────

  /**
   * The scale that puts a STORED formula back into the recipe's own grams.
   *
   * The document holds percentages and no gram figure at all (by design — grams and
   * percent stored side by side would drift). To repopulate the boxes we need one
   * component whose weight we independently know, and the recipe supplies exactly
   * that for every line it gave an amount for. From one such pairing the whole basis
   * weight follows, and every other component — including a hand-typed "2 eggs →
   * 100 g", which the recipe knows nothing about — comes back with it.
   *
   * A basis member is preferred simply because it is the least likely to have been
   * hand-entered. Null when no component has both a recipe weight and a percentage:
   * a formula built entirely by hand, where the honest fallback is the recipe's own
   * figures and a blank box for the rest.
   */
  function anchorBasisGrams(
    components: readonly FormulaComponent[],
    recipeGramsById: ReadonlyMap<string, number | null>,
  ): number | null {
    const basisFirst = [...components].sort((a, b) => Number(b.inBasis) - Number(a.inBasis));
    for (const component of basisFirst) {
      const grams = recipeGramsById.get(component.ingredientId);
      if (grams != null && component.percent > 0) return grams / (component.percent / 100);
    }
    return null;
  }

  function seed(stored: Formula | null, ings: readonly Ingredient[]): void {
    const guessed = new Set(
      guessBasisIngredientIds(
        ings.map((ing) => ({
          ingredientId: ing.id,
          canonName: (ing.canonId ? canonNameById.get(ing.canonId) : null) ?? null,
          rawText: ing.rawText,
        })),
      ),
    );
    const recipeGramsById = new Map(ings.map((ing) => [ing.id, gramsFromParsed(ing.parsed)]));
    const storedById = new Map((stored?.components ?? []).map((c) => [c.ingredientId, c]));
    const anchor = stored ? anchorBasisGrams(stored.components, recipeGramsById) : null;

    rows = ings.map((ing) => {
      const recipeGrams = recipeGramsById.get(ing.id) ?? null;
      const component = storedById.get(ing.id);
      const recovered =
        component && anchor !== null ? roundGrams(anchor * (component.percent / 100)) : null;
      const grams = stored ? (recovered ?? recipeGrams) : recipeGrams;
      return {
        ingredientId: ing.id,
        rawText: ing.rawText,
        recipeGrams,
        isRange: ing.parsed?.quantity?.type === 'range',
        gramsText: grams === null ? '' : String(grams),
        // First visit: an ingredient is in if the recipe weighed it. Revisit: it is
        // in if the stored formula named it, which is what preserves both a
        // hand-typed weight and a deliberate exclusion across a reload.
        included: stored ? component !== undefined && grams !== null : grams !== null,
        inBasis: stored ? (component?.inBasis ?? false) : guessed.has(ing.id),
      };
    });

    // Recovering the declaration. There is nothing to match against any more — the
    // document holds `{ count, unitDoughGrams }` and nothing else — so the numbers
    // come straight back into the boxes. Which of the three answers they land in
    // is `seedDoughAnswer`'s call, and it is a presentation choice only: all three
    // save the identical document.
    const seeded = seedDoughAnswer(
      stored?.referenceYield.kind === 'target' ? stored.referenceYield.shape : null,
    );
    answerMode = seeded.mode;
    answer = seeded.fields;

    // A formula with no process is a formula with no stages — an empty review
    // surface, not a placeholder one. Nothing here derives or guesses stages; the
    // only two ways to get them are the extraction action and adding one by hand.
    stageRows = (stored?.process ?? []).map(stageRowFrom);
    dirty = false;
  }

  // What the rows were last taken from. Identity, not a version stamp: the formula
  // document carries no timestamps (deliberately — there is nothing to order), so
  // "have I already seeded from this?" is answered by object identity on the three
  // inputs a seed reads. The early return is what stops the effect looping, since
  // `seed` writes state the effect reads.
  let lastSeeded: {
    recipeId: string;
    stored: Formula | null;
    ings: readonly Ingredient[];
    canon: ReadonlyMap<string, string>;
  } | null = null;

  $effect(() => {
    const stored = $storedFormula;
    const ings = ingredients;
    const canon = canonNameById;
    const id = recipeId;
    if (stored === undefined || !id) return; // still loading — nothing to seed from
    untrack(() => {
      const previous = lastSeeded;
      if (
        previous !== null &&
        previous.recipeId === id &&
        previous.stored === stored &&
        previous.ings === ings &&
        previous.canon === canon
      ) {
        return;
      }
      const next = { recipeId: id, stored, ings, canon };
      // Unsaved work on THIS recipe wins over an incoming snapshot — the same
      // answer every other surface gives under LWW. A different recipe always
      // re-seeds: those edits belong somewhere else.
      if (dirty && previous?.recipeId === id) {
        lastSeeded = next;
        return;
      }
      seed(stored, ings);
      lastSeeded = next;
    });
  });

  // ─── Interactions ─────────────────────────────────────────────────────────────

  function touch(): void {
    dirty = true;
  }

  function patchRow(ingredientId: string, patch: Partial<Row>): void {
    rows = rows.map((r) => (r.ingredientId === ingredientId ? { ...r, ...patch } : r));
    touch();
  }

  // Typing a weight puts a row IN; clearing the box takes it out. One rule, no
  // hidden flag: the checkbox is an explicit override that holds until the weight
  // changes again. This is what makes "2 eggs" work — the prompt is the empty box,
  // and leaving it empty is how you leave the eggs out.
  function setGrams(ingredientId: string, text: string): void {
    patchRow(ingredientId, { gramsText: text, included: parsePositiveNumber(text) !== null });
  }

  function setIncluded(ingredientId: string, included: boolean): void {
    patchRow(ingredientId, { included });
  }

  function setInBasis(ingredientId: string, inBasis: boolean): void {
    patchRow(ingredientId, { inBasis });
  }

  // ─── Stage interactions ───────────────────────────────────────────────────────
  //
  // Every one goes through a pure producer in `@salt/domain`'s process module, so
  // the ordering rules (a move at either end is a no-op, an unknown id changes
  // nothing) are stated once and tested there rather than re-derived here.

  function patchStage(id: string, patch: Partial<Omit<StageRow, 'id'>>): void {
    stageRows = withStageUpdated(stageRows, id, patch);
    touch();
  }

  /**
   * A stage added by hand. This is a first-class action, not a fallback: the spike
   * swallowed one of four 20-minute rests buried inside a single sentence, and a
   * screen that could only accept or reject what the model found would leave that
   * recipe permanently wrong.
   *
   * A minted id, a null `stepId` (it corresponds to no step), and inserted in order
   * — at the end, which is where "and then this happens" belongs; the up button
   * moves it.
   */
  function addStage(): void {
    stageRows = withStageAdded(stageRows, {
      id: crypto.randomUUID(),
      label: '',
      kind: 'wait',
      environment: null,
      duration: null,
      until: null,
      stepId: null,
      optional: false,
      celsiusText: '',
      maxCelsiusText: '',
      placeId: '',
      minutesText: '',
      maxMinutesText: '',
    });
    touch();
  }

  /**
   * Choosing a place, and PREFILLING the temperature from it when there is none.
   *
   * Not arithmetic and not a model: it copies the range the equipment entry
   * already states. It fires only into empty boxes, so a recipe's own figure is
   * never overwritten — the recipe outranks the kit, always.
   */
  function choosePlace(id: string, value: string): void {
    const place = places.find((p) => p.id === value);
    const row = stageRows.find((r) => r.id === id);
    const env = place?.environment;
    const prefill =
      env && row && row.celsiusText.trim() === '' && row.maxCelsiusText.trim() === ''
        ? { celsiusText: String(env.minCelsius), maxCelsiusText: String(env.maxCelsius) }
        : {};
    patchStage(id, { placeId: value, ...prefill });
  }

  function removeStage(id: string): void {
    stageRows = withStageRemoved(stageRows, id);
    touch();
  }

  function moveStage(id: string, direction: 'up' | 'down'): void {
    stageRows = withStageMoved(stageRows, id, direction);
    touch();
  }

  // ─── Extraction ───────────────────────────────────────────────────────────────

  let extracting = $state(false);
  let replaceOpen = $state(false);

  /**
   * Ask for the stages. With none on screen this runs straight away; with stages
   * already there it asks first, because a re-run REPLACES them outright (whole-
   * document LWW, no merge) and every hand correction goes with them.
   */
  function handleExtract(): void {
    if (extracting) return;
    if (stageRows.length > 0) {
      replaceOpen = true;
      return;
    }
    void runExtract();
  }

  async function runExtract(): Promise<void> {
    replaceOpen = false;
    extracting = true;
    const result = await extractProcessStages(recipeId);
    extracting = false;
    if (result.kind !== 'ok') {
      addToast("Couldn't read the stages. Try again.", 'destructive');
      return;
    }
    stageRows = result.value.map(stageRowFrom);
    // Dirty, never saved: the user sees the stages before they are stored, and Save
    // stays the one write path.
    dirty = true;
    if (result.value.length === 0) {
      // Not a failure. A method with nothing to wait for has no process worth
      // recording, and saying so is better than inventing a proof to fill the card.
      addToast('Nothing to wait for in this one — no stages.');
      return;
    }
    addToast('Stages found. Check them over, then save.', 'success');
  }

  // ─── The one piece of maths ───────────────────────────────────────────────────

  const componentInputs = $derived(
    rows.flatMap((row) => {
      const grams = gramsOf(row);
      return row.included && grams !== null
        ? [{ ingredientId: row.ingredientId, grams, inBasis: row.inBasis }]
        : [];
    }),
  );

  // Half-typed is not a lenient declaration with a gap filled in — it is no
  // declaration yet, and the same `shape === null` that has always disabled Save
  // covers it without a second rule.
  const shape = $derived(doughAmountFrom(answerMode, answer));
  // A PROPOSAL for the grams box, never a locked figure — the coefficient must not
  // become load-bearing on the scaling (`doughAmount.ts`).
  const suggestedGrams = $derived(suggestedTrayGrams(answer));

  // Recalculated on EVERY change — a basis toggle, a typed gram, an exclusion. That
  // is the point of holding grams rather than percentages: there is one function,
  // and it is the one that wrote the document in the first place.
  const derivation = $derived(
    deriveFormula({
      recipeId,
      components: componentInputs,
      ...(shape ? { referenceYield: targetYield(shape) } : {}),
    }),
  );

  const percentById = $derived(
    derivation.ok
      ? new Map(derivation.formula.components.map((c) => [c.ingredientId, c.percent]))
      : new Map<string, number>(),
  );

  // Stored at four decimals (`roundPercent`), shown at one: yeast reads 1.4% and
  // flour reads 100%, not 100.0%.
  function formatPercent(percent: number | undefined): string {
    if (percent === undefined) return '—';
    const text = percent.toFixed(1);
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}%`;
  }

  // ─── The two disclosures ──────────────────────────────────────────────────────
  //
  // Both are places information is lost or asserted, and both are stated plainly
  // because this screen is the only moment anyone can object.

  // The recipe's OWN arithmetic — everything included, added up as written. Not a
  // scaled quantity and not a projection: it is the sum of the numbers already on
  // the page.
  const asWrittenDoughGrams = $derived(
    componentInputs.reduce((sum, component) => sum + component.grams, 0),
  );
  const declaredDoughGrams = $derived(shape ? doughAmountGrams(shape) : null);
  // A declaration re-anchors the formula. 500 g of flour at a 176.4% grand total is
  // 882 g of dough, so calling it one 900 g tin loaf moves everything by ~2% — small
  // and entirely reasonable, but it should be visible rather than silent.
  const declarationDriftPercent = $derived(
    declaredDoughGrams !== null && asWrittenDoughGrams > 0
      ? ((declaredDoughGrams - asWrittenDoughGrams) / asWrittenDoughGrams) * 100
      : null,
  );

  const rangeRows = $derived(rows.filter((row) => row.isRange && row.included));

  // ─── The stages, as they would be saved ───────────────────────────────────────

  const stages = $derived(stageRows.map(stageFrom));

  // A RANGE, never a collapsed midpoint — the domain helper refuses to flatten one
  // and so does the copy. Stages with no duration contribute nothing, which is the
  // honest answer for "until doubled": the total is at least this, and how much more
  // is precisely what nobody knows.
  const totalDuration = $derived(totalDurationMinutes(stages));
  const untimedStageCount = $derived(stages.filter((stage) => stage.duration === null).length);

  const totalDurationText = $derived(
    totalDuration.minMinutes === totalDuration.maxMinutes
      ? formatMinutes(totalDuration.minMinutes)
      : `${formatMinutes(totalDuration.minMinutes)} – ${formatMinutes(totalDuration.maxMinutes)}`,
  );

  // ─── Save ─────────────────────────────────────────────────────────────────────

  // A declaration is REQUIRED. Without one the formula has no reference yield worth
  // the name, and phase 02 would have nothing to solve a batch against.
  const canSave = $derived(shape !== null && derivation.ok && !saving);

  const blockedReason = $derived.by(() => {
    if (shape === null) return 'Say what this makes before saving.';
    if (!derivation.ok) {
      switch (derivation.reason.kind) {
        case 'emptyFormula':
          return 'Nothing is in the formula yet — give at least one ingredient a weight.';
        case 'noBasis':
          return 'Nothing is in the basis. Tick the flours (or whatever the 100% is).';
        default:
          return 'This formula does not add up yet.';
      }
    }
    return null;
  });

  async function handleSave(): Promise<void> {
    if (!canSave || !derivation.ok) return;
    saving = true;
    // `process` is OMITTED, not written empty, when there are no stages: a formula
    // with no process carries no empty scaffolding, and `setDoc` writes the whole
    // document, so an absent key is how a process is cleared as well as how one
    // never existed.
    const result = await saveFormula(
      stages.length > 0 ? { ...derivation.formula, process: stages } : derivation.formula,
    );
    saving = false;
    if (result.kind !== 'ok') {
      addToast("Couldn't save the formula.", 'destructive');
      return;
    }
    // The store now holds what was written, so let the incoming snapshot re-seed:
    // it exercises the same recovery path a reload takes, in front of the user.
    dirty = false;
    addToast('Formula saved.', 'success');
  }

  const loading = $derived($isLoadingRecipes || $storedFormula === undefined);
</script>

<!-- Bread is still being built (issue #831): everyone outside the test group is
     redirected home and sees nothing at all — no denial copy, because a message
     would announce a feature they are not meant to know exists yet. Cosmetic only;
     the boundary is not here (see lib/featureGate.ts). -->
<FeatureGuard feature="bread">
  {#if loading}
    <div class="flex justify-center p-8"><Spinner /></div>
  {:else if !recipe}
    <div class="p-6">
      <EmptyState title="Recipe not found" description="It may have been deleted." />
    </div>
  {:else if !takesIngredients(kindOf(recipe))}
    <!-- Capability-gated, never kind-gated (CLAUDE.md): a formula is composition, so
       an entry with no ingredients has no composition to express. Reachable only by
       typing the URL — nothing in the app offers this route. -->
    <div class="p-6">
      <EmptyState
        title="Nothing to weigh here"
        description="A formula is a recipe's ingredients as percentages, and this entry doesn't have any."
      />
    </div>
  {:else}
    <DetailPage
      title="Formula"
      subtitle={recipe.title}
      onBack={() => goBack(`/recipes/${recipe.id}`)}
      backLabel="Back"
      class="p-4 sm:p-6"
    >
      {#snippet actions()}
        <Button
          size="sm"
          onclick={handleSave}
          loading={saving}
          disabled={!canSave}
          data-testid="formula-save-button"
        >
          {#snippet leading()}<Icon name="Check" size={16} />{/snippet}
          Save
        </Button>
      {/snippet}

      <div class="flex flex-col gap-4" data-testid="formula-editor">
        {#if ingredients.length === 0}
          <EmptyState
            title="No ingredients yet"
            description="Add the ingredients to the recipe and they'll show up here to weigh."
          />
        {:else}
          <!-- ─── The basis and the percentages ──────────────────────────────── -->
          <Card>
            <CardHeader>
              <CardTitle>Ingredients</CardTitle>
            </CardHeader>
            <CardContent class="flex flex-col gap-3">
              <p class="text-sm text-muted-foreground">
                The basis is the 100%. For bread that's the flours: everything else is a percentage
                of them.
              </p>
              {#each rows as row (row.ingredientId)}
                <div
                  role="group"
                  aria-label={row.rawText}
                  class="flex flex-col gap-2 rounded border p-3"
                  class:opacity-60={!row.included}
                  data-testid="formula-row"
                >
                  <div class="flex items-start justify-between gap-3">
                    <span class="flex-1 text-sm">{row.rawText}</span>
                    <span
                      class="text-sm font-medium tabular-nums"
                      class:text-muted-foreground={!row.inBasis}
                      data-testid="formula-row-percent"
                    >
                      {formatPercent(percentById.get(row.ingredientId))}
                    </span>
                  </div>
                  <div class="flex flex-wrap items-center gap-4">
                    <TextField
                      label="Weight (g)"
                      inputmode="decimal"
                      class="w-32"
                      placeholder={row.recipeGrams === null ? 'e.g. 100' : ''}
                      value={row.gramsText}
                      onValueChange={(v) => setGrams(row.ingredientId, v)}
                      data-testid="formula-row-grams"
                    />
                    <Checkbox
                      label="In the basis"
                      checked={row.inBasis}
                      disabled={!row.included}
                      onCheckedChange={(v) => setInBasis(row.ingredientId, v === true)}
                      data-testid="formula-row-basis"
                    />
                    <Checkbox
                      label="Include"
                      checked={row.included}
                      disabled={gramsOf(row) === null}
                      onCheckedChange={(v) => setIncluded(row.ingredientId, v === true)}
                      data-testid="formula-row-include"
                    />
                  </div>
                  {#if row.recipeGrams === null}
                    <!-- Count-based ("2 eggs") or no amount at all ("a pinch"). Domain
                       will not guess what an egg weighs — that would be a second
                       scaling mechanism hidden behind a constant — so the weight is
                       asked for here, or the line is left out of the formula. -->
                    <p class="text-xs text-muted-foreground" data-testid="formula-row-needs-grams">
                      The recipe doesn't weigh this one. Give it a weight in grams, or leave it out.
                    </p>
                  {/if}
                </div>
              {/each}
            </CardContent>
          </Card>

          {#if rangeRows.length > 0}
            <!-- DISCLOSURE ONE. A range becomes a point value the moment it becomes a
               percentage, and a batch will later print a confident figure the recipe
               never gave. This is the only moment anyone can object. -->
            <div
              class="flex flex-col gap-1 rounded border border-warning/40 bg-warning/10 px-3 py-3"
              data-testid="formula-range-disclosure"
            >
              <p class="text-sm text-warning-text">
                {rangeRows.length === 1
                  ? 'One ingredient is'
                  : `${rangeRows.length} ingredients are`}
                given as a range. The top of the range is what the formula keeps — the range itself is
                gone once this is saved.
              </p>
              {#each rangeRows as row (row.ingredientId)}
                {@const grams = gramsOf(row)}
                <p class="text-sm text-warning-text">
                  <span class="font-medium">{row.rawText}</span>
                  — taken at {grams === null
                    ? 'the top of its range'
                    : formatGrams(roundGrams(grams))}
                </p>
              {/each}
            </div>
          {/if}

          <!-- ─── What it makes ──────────────────────────────────────────────── -->
          <Card>
            <CardHeader>
              <CardTitle>What this makes</CardTitle>
            </CardHeader>
            <CardContent class="flex flex-col gap-3">
              <!-- The same three answers the bake sheet asks, with different
                   stakes: this one EDITS THE RECIPE, and the re-anchoring
                   disclosure below is what marks it as such. No vessel is stored
                   here — a recipe is written for a quantity of dough; the tin is a
                   fact about tonight, and it is recorded on the batch instead
                   (`doughAnswer.ts`, issue #1274). -->
              <RadioGroup
                label="What are you filling?"
                value={answerMode}
                onValueChange={(v) => {
                  answerMode = v as DoughAnswerMode;
                  touch();
                }}
              >
                <RadioGroupItem value="tin" label="A loaf tin" />
                <RadioGroupItem value="tray" label="A tray or dish" />
                <RadioGroupItem value="pieces" label="A number of pieces" />
                <RadioGroupItem value="weight" label="A weight of dough" />
              </RadioGroup>

              {#if answerMode === 'tin'}
                <div class="flex flex-col gap-2" data-testid="formula-tin">
                  <div class="flex flex-wrap gap-2">
                    {#each LOAF_TIN_CHIP_GRAMS as grams (grams)}
                      <Button
                        size="sm"
                        variant={answer.tinGramsText === String(grams) ? 'solid' : 'outline'}
                        onclick={() => {
                          answer = { ...answer, tinGramsText: String(grams) };
                          touch();
                        }}
                        data-testid="formula-tin-chip"
                        data-tin-grams={grams}
                      >
                        {formatGrams(grams)}
                      </Button>
                    {/each}
                  </div>
                  <div class="flex flex-wrap items-end gap-3">
                    <TextField
                      label="Tin size (g)"
                      inputmode="numeric"
                      class="w-32"
                      value={answer.tinGramsText}
                      onValueChange={(v) => {
                        answer = { ...answer, tinGramsText: v };
                        touch();
                      }}
                      data-testid="formula-grams-each"
                    />
                    <TextField
                      label="How many tins"
                      inputmode="numeric"
                      class="w-28"
                      value={answer.tinCountText}
                      onValueChange={(v) => {
                        answer = { ...answer, tinCountText: v };
                        touch();
                      }}
                      data-testid="formula-count"
                    />
                  </div>
                </div>
              {:else if answerMode === 'tray'}
                <!-- THE ONE GUESSED NUMBER IN THE FEATURE, and everything here is
                     arranged around that: the suggestion lands in an ordinary editable
                     box, the copy says plainly that it is a starting point, and the
                     coefficient itself is never shown as a fact. A named tin does not
                     come through here — see `doughAmount.ts`. -->
                <div class="flex flex-col gap-2" data-testid="formula-tray">
                  <RadioGroup
                    label="How are you describing it?"
                    value={answer.trayBy}
                    onValueChange={(v) => {
                      answer = { ...answer, trayBy: v as TrayBy };
                      touch();
                    }}
                  >
                    <RadioGroupItem value="size" label="Length × width" />
                    <RadioGroupItem value="volume" label="A volume" />
                  </RadioGroup>

                  {#if answer.trayBy === 'size'}
                    <div class="flex flex-wrap items-end gap-3">
                      <TextField
                        label="Length (cm)"
                        inputmode="decimal"
                        class="w-28"
                        value={answer.trayLengthText}
                        onValueChange={(v) => {
                          answer = { ...answer, trayLengthText: v };
                          touch();
                        }}
                        data-testid="formula-tray-length"
                      />
                      <TextField
                        label="Width (cm)"
                        inputmode="decimal"
                        class="w-28"
                        value={answer.trayWidthText}
                        onValueChange={(v) => {
                          answer = { ...answer, trayWidthText: v };
                          touch();
                        }}
                        data-testid="formula-tray-width"
                      />
                      <TextField
                        label="Dough depth (cm)"
                        inputmode="decimal"
                        class="w-32"
                        value={answer.trayDepthText}
                        onValueChange={(v) => {
                          answer = { ...answer, trayDepthText: v };
                          touch();
                        }}
                        data-testid="formula-tray-depth"
                      />
                    </div>
                    <p class="text-xs text-muted-foreground">
                      How deep the dough sits, not how tall the tray is — a tray is never filled to
                      its walls.
                    </p>
                  {:else}
                    <div class="flex flex-wrap items-end gap-3">
                      <TextField
                        label="Volume"
                        inputmode="decimal"
                        class="w-28"
                        value={answer.trayVolumeText}
                        onValueChange={(v) => {
                          answer = { ...answer, trayVolumeText: v };
                          touch();
                        }}
                        data-testid="formula-tray-volume"
                      />
                      <RadioGroup
                        label="In"
                        value={answer.trayVolumeUnit}
                        onValueChange={(v) => {
                          answer = { ...answer, trayVolumeUnit: v as 'ml' | 'l' };
                          touch();
                        }}
                      >
                        <RadioGroupItem value="ml" label="ml" />
                        <RadioGroupItem value="l" label="litres" />
                      </RadioGroup>
                    </div>
                  {/if}

                  <div class="flex flex-wrap items-end gap-3">
                    <TextField
                      label="Dough (g)"
                      inputmode="numeric"
                      class="w-32"
                      value={answer.trayGramsText}
                      onValueChange={(v) => {
                        answer = { ...answer, trayGramsText: v };
                        touch();
                      }}
                      data-testid="formula-tray-grams"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={suggestedGrams === null}
                      onclick={() => {
                        if (suggestedGrams === null) return;
                        answer = { ...answer, trayGramsText: String(suggestedGrams) };
                        touch();
                      }}
                      data-testid="formula-tray-suggest"
                    >
                      Suggest a weight
                    </Button>
                  </div>
                  <p class="text-xs text-muted-foreground" data-testid="formula-tray-note">
                    A starting point, not a measurement — how much dough a tray takes depends on the
                    style and how much rise you want. Type over it.
                  </p>
                </div>
              {:else if answerMode === 'pieces'}
                <div class="flex flex-wrap items-end gap-3" data-testid="formula-pieces">
                  <TextField
                    label="How many"
                    inputmode="numeric"
                    class="w-28"
                    value={answer.pieceCountText}
                    onValueChange={(v) => {
                      answer = { ...answer, pieceCountText: v };
                      touch();
                    }}
                    data-testid="formula-piece-count"
                  />
                  <TextField
                    label="Dough each (g)"
                    inputmode="numeric"
                    class="w-32"
                    value={answer.pieceGramsText}
                    onValueChange={(v) => {
                      answer = { ...answer, pieceGramsText: v };
                      touch();
                    }}
                    data-testid="formula-piece-grams"
                  />
                </div>
              {:else}
                <div class="flex flex-wrap items-end gap-3" data-testid="formula-weight">
                  <TextField
                    label="Dough (g)"
                    inputmode="numeric"
                    class="w-32"
                    value={answer.totalGramsText}
                    onValueChange={(v) => {
                      answer = { ...answer, totalGramsText: v };
                      touch();
                    }}
                    data-testid="formula-total-dough"
                  />
                </div>
              {/if}

              <!-- DISCLOSURE TWO. The recipe's own dough total sits next to the one
                 just declared, so re-anchoring the formula is visible rather than
                 silent. Neither number is a scaled quantity: the first is the sum of
                 the weights on this page and the second is what the user just said.
                 -->
              <div class="text-sm" data-testid="formula-dough-total">
                <p>
                  As written, this weighs
                  <span class="font-medium">{formatGrams(roundGrams(asWrittenDoughGrams))}</span> of dough.
                </p>
                {#if declaredDoughGrams !== null && shape !== null}
                  <p>
                    You've declared
                    <span class="font-medium">{formatDoughAmount(shape)}</span>.
                  </p>
                  {#if declarationDriftPercent !== null && Math.abs(declarationDriftPercent) >= 0.5}
                    <p class="text-muted-foreground" data-testid="formula-declaration-drift">
                      That re-anchors the formula by {declarationDriftPercent > 0
                        ? '+'
                        : ''}{declarationDriftPercent.toFixed(1)}%. The percentages don't change;
                      what a batch weighs out does.
                    </p>
                  {/if}
                {/if}
              </div>
            </CardContent>
          </Card>

          <!-- ─── The stages ─────────────────────────────────────────────────── -->
          <Card>
            <CardHeader>
              <CardTitle>Stages</CardTitle>
            </CardHeader>
            <CardContent>
              <div class="flex flex-col gap-3" data-testid="formula-stages">
                <p class="text-sm text-muted-foreground">
                  What the dough goes through, in order. A <span class="font-medium">wait</span> is
                  unattended — the dough or the oven changes on its own and you can leave the room.
                  An
                  <span class="font-medium">active</span> stage is one you're there for, and that includes
                  the bake itself.
                </p>

                {#if stageRows.length === 0}
                  <p class="text-sm text-muted-foreground" data-testid="formula-stages-empty">
                    No stages yet. Read them off the method, or add one yourself.
                  </p>
                {:else}
                  {#each stageRows as stage, index (stage.id)}
                    <div
                      role="group"
                      aria-label={stage.label || 'New stage'}
                      class="flex flex-col gap-2 rounded border p-3"
                      data-testid="formula-stage-row"
                    >
                      <div class="flex flex-wrap items-end gap-3">
                        <TextField
                          label="Stage"
                          class="min-w-40 flex-1"
                          value={stage.label}
                          onValueChange={(v) => patchStage(stage.id, { label: v })}
                          data-testid="formula-stage-label"
                        />
                        <Select
                          value={stage.kind}
                          onValueChange={(v) =>
                            patchStage(stage.id, { kind: v as ProcessStageKind })}
                        >
                          <SelectTrigger
                            class="w-32"
                            aria-label={`Is ${stage.label || 'this stage'} active or a wait?`}
                            data-testid="formula-stage-kind"
                          >
                            {stage.kind === 'wait' ? 'Wait' : 'Active'}
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="wait">Wait</SelectItem>
                            <SelectItem value="active">Active</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div class="flex flex-wrap items-end gap-3">
                        <!-- Two boxes for the same reason the duration has two: a
                         prove that is really "somewhere between 22 and 26" must not
                         be stored as a single invented 24. -->
                        <TextField
                          label="Temperature (°C)"
                          inputmode="decimal"
                          class="w-32"
                          placeholder="—"
                          value={stage.celsiusText}
                          onValueChange={(v) => patchStage(stage.id, { celsiusText: v })}
                          data-testid="formula-stage-celsius"
                        />
                        <TextField
                          label="…up to"
                          inputmode="decimal"
                          class="w-28"
                          placeholder="optional"
                          value={stage.maxCelsiusText}
                          onValueChange={(v) => patchStage(stage.id, { maxCelsiusText: v })}
                          data-testid="formula-stage-max-celsius"
                        />
                        {#if places.length > 0}
                          <div class="flex flex-col gap-1">
                            <span class="text-xs text-muted-foreground">Place</span>
                            <Select
                              value={stage.placeId}
                              onValueChange={(v) => choosePlace(stage.id, v)}
                            >
                              <SelectTrigger
                                class="w-44"
                                aria-label={`Where does ${stage.label || 'this stage'} happen?`}
                                data-testid="formula-stage-place"
                              >
                                {placeNames.get(stage.placeId) ?? 'Kitchen temperature'}
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NO_PLACE}>Kitchen temperature</SelectItem>
                                {#each places as place (place.id)}
                                  <SelectItem value={place.id}>{place.name}</SelectItem>
                                {/each}
                              </SelectContent>
                            </Select>
                          </div>
                        {/if}
                        <!-- Two boxes, not one: a range typed as a range stays a range.
                         Leaving the second empty is what makes a duration fixed. -->
                        <TextField
                          label="Minutes"
                          inputmode="numeric"
                          class="w-28"
                          placeholder="—"
                          value={stage.minutesText}
                          onValueChange={(v) => patchStage(stage.id, { minutesText: v })}
                          data-testid="formula-stage-minutes"
                        />
                        <TextField
                          label="…up to"
                          inputmode="numeric"
                          class="w-28"
                          placeholder="optional"
                          value={stage.maxMinutesText}
                          onValueChange={(v) => patchStage(stage.id, { maxMinutesText: v })}
                          data-testid="formula-stage-max-minutes"
                        />
                        <TextField
                          label="Until"
                          class="min-w-40 flex-1"
                          placeholder="e.g. until doubled"
                          value={stage.until ?? ''}
                          onValueChange={(v) => patchStage(stage.id, { until: v })}
                          data-testid="formula-stage-until"
                        />
                      </div>

                      <div class="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Move ${stage.label || 'this stage'} earlier`}
                          disabled={index === 0}
                          onclick={() => moveStage(stage.id, 'up')}
                          data-testid="formula-stage-up"
                        >
                          {#snippet leading()}<Icon name="ChevronUp" size={16} />{/snippet}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Move ${stage.label || 'this stage'} later`}
                          disabled={index === stageRows.length - 1}
                          onclick={() => moveStage(stage.id, 'down')}
                          data-testid="formula-stage-down"
                        >
                          {#snippet leading()}<Icon name="ChevronDown" size={16} />{/snippet}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove ${stage.label || 'this stage'}`}
                          onclick={() => removeStage(stage.id)}
                          data-testid="formula-stage-remove"
                        >
                          {#snippet leading()}<Icon name="Trash2" size={16} />{/snippet}
                        </Button>
                        <!-- The recipe's own opinion, correctable here before it is
                         saved. It gates nothing: every stage on a run can be
                         skipped whether this is ticked or not. -->
                        <Checkbox
                          class="ml-auto"
                          label="Optional"
                          checked={stage.optional}
                          onCheckedChange={(v) => patchStage(stage.id, { optional: v === true })}
                          data-testid="formula-stage-optional"
                        />
                      </div>
                    </div>
                  {/each}

                  <p class="text-sm" data-testid="formula-stages-total">
                    Timed stages come to <span class="font-medium">{totalDurationText}</span>.
                    {#if untimedStageCount > 0}
                      {untimedStageCount === 1
                        ? 'One stage has no time on it'
                        : `${untimedStageCount} stages have no time on them`}, so the real answer is
                      longer.
                    {/if}
                  </p>
                {/if}

                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onclick={handleExtract}
                    loading={extracting}
                    disabled={extracting}
                    data-testid="formula-stages-extract"
                  >
                    {#snippet leading()}<Icon name="Sparkles" size={16} />{/snippet}
                    {stageRows.length === 0 ? 'Read them off the method' : 'Read them again'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onclick={addStage}
                    disabled={extracting}
                    data-testid="formula-stages-add"
                  >
                    {#snippet leading()}<Icon name="Plus" size={16} />{/snippet}
                    Add a stage
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {#if blockedReason}
            <p class="text-sm text-muted-foreground" data-testid="formula-blocked-reason">
              {blockedReason}
            </p>
          {/if}
        {/if}
      </div>
    </DetailPage>

    <!-- Re-running extraction REPLACES the stages: whole-document LWW, no merge, and
       half of a new reading mixed into hand-corrected stages is a process neither
       the model nor the human wrote. The confirmation exists because the damage is
       invisible until it is done — the button looks the same whether there are
       corrections behind it or not. -->
    <Dialog bind:open={replaceOpen}>
      <DialogContent>
        <div class="flex flex-col gap-4" data-testid="formula-stages-replace-dialog">
          <DialogHeader>
            <DialogTitle>Read the stages again?</DialogTitle>
            <DialogDescription>
              This replaces the {stageRows.length} stage{stageRows.length === 1 ? '' : 's'} below with
              a fresh reading of the method. Anything you've corrected by hand — a temperature, a rest
              you added yourself — goes with them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onclick={() => (replaceOpen = false)} disabled={extracting}>
              Cancel
            </Button>
            <Button
              onclick={runExtract}
              loading={extracting}
              disabled={extracting}
              data-testid="formula-stages-replace-confirm"
            >
              Replace them
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  {/if}
</FeatureGuard>
