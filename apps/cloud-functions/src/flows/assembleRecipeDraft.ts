import type {
  LibrarianOutput,
  RecipeDoc,
  RecipeSourceDoc,
  IngredientGroupDoc,
  IngredientDoc,
  MatchOrCreateCanonOutput,
} from '@salt/domain/schemas';
import { RecipeSchema } from '@salt/domain/schemas';
import { normaliseTags, reconcileRecipePhases } from '@salt/domain';
import type { AuthorableRecipeKind } from '@salt/domain';
import { logger } from 'firebase-functions';
import { canonicaliseRecipeIngredientsFlow } from './canonicaliseRecipeIngredients.js';
import { parseRecipeIngredientsFlow } from './parseRecipeIngredients.js';
import { reportServerError } from '../observability/reportServerError.js';

// The one place a RecipeDoc is assembled from raw AI output. Both authoring
// paths (the librarian chat in authorRecipe, the URL import in
// extractRecipeFromUrl) produce the same structure — step IDs, parsed ingredient
// data, canon matches, resolved first-use ordinals — and used to carry a copy of
// it each, which is how the two drifted apart in the first place.
//
// It lives in apps/cloud-functions, NOT packages/domain, because it awaits
// parseRecipeIngredientsFlow and canonicaliseRecipeIngredientsFlow: the domain
// layer is pure and does no I/O (CLAUDE.md hard rule 1).
//
// `raw` is typed as LibrarianOutput because that is the common structural shape
// of the two AI outputs — ExtractRecipeAIOutput is assignable to it (it adds
// `isRecipe` and narrows the numeric fields to non-negative ints, neither of
// which this module reads or relies on).

export interface AssembleRecipeDraftOptions {
  /** Provenance stamped on the assembled doc — `{ type: 'manual' }` for the
   *  librarian, `{ type: 'url', url }` for an import. */
  source: RecipeSourceDoc;
  /** Edit mode: the recipe being amended. Its unchanged ingredients are carried
   *  over verbatim (see baseByRawText below) and its `kind` / `producesCanonId`
   *  are preserved, so an amend can never silently re-type or unlink the entry it
   *  is editing. null / omitted = author a fresh draft. */
  baseRecipe?: RecipeDoc | null;
  /** Variation mode (issue #763 + #765): the kind of the entry this variation
   *  STARTS FROM. A variation deliberately assembles with `baseRecipe: null` — it
   *  is a new dish, not a second copy — but its kind is not in question: a
   *  variation on a Negroni is a cocktail, and that is a deterministic answer
   *  sitting right there rather than something to infer from a transcript about
   *  gin. Ignored in edit mode, where the base recipe's own kind wins outright.
   *
   *  Typed as `AuthorableRecipeKind`, so a caller cannot hand this a `special` or
   *  a `placeholder` and mint an entry carrying a method it is not allowed to
   *  have. Callers narrow with `isAuthorable`. */
  kindHint?: AuthorableRecipeKind | null;
  /** Stamp `needs_approval: true` — raw AI output nobody has read yet (issue
   *  #616). Omitted/false leaves the field OFF the document entirely; absent
   *  means reviewed, and an explicit `false` is not the same thing. */
  needsApproval?: boolean;
}

type ParsedIngredient = Awaited<
  ReturnType<typeof parseRecipeIngredientsFlow>
>[number]['items'][number]['parsed'];

type CanonResult = MatchOrCreateCanonOutput;

export async function assembleRecipeDraft(
  raw: LibrarianOutput,
  { source, baseRecipe = null, kindHint = null, needsApproval = false }: AssembleRecipeDraftOptions,
): Promise<RecipeDoc> {
  const now = new Date().toISOString();

  // Assign stable IDs to steps first so we can resolve step ordinals → IDs.
  //
  // In edit mode a step may cite `sourceStepId` — the id of the existing step the
  // librarian rewrote it FROM (issue #1178). Honouring it is the whole feature:
  // `diffRecipe`'s id-equality pass then pairs a reworded step as ONE edit rather
  // than a deletion beside an unrelated addition, and a guided plan survives an
  // amendment that left its steps alone.
  //
  // THREE CITATIONS ARE REFUSED, all silently, and each loses the CITATION rather
  // than the step — `proposeSchedule.ts:285-299`'s precedent, for its reason: a
  // step with a fresh id is still a perfectly good step, so failing the amend
  // because the model hallucinated an id would turn a cosmetic improvement into a
  // broken feature.
  //
  //  1. An id that is not a step of `baseRecipe`. It names nothing.
  //  2. An id an earlier step in this output already claimed. First wins, in
  //     output order. This one is a CORRECTNESS rule, not tidiness: two steps
  //     sharing an id inside one recipe would corrupt the `firstUsedInStepId`
  //     resolution below (an ingredient chip landing on whichever step the lookup
  //     reached first) and cook mode's paging.
  //  3. Any citation at all when `baseRecipe` is null. Create mode has no base;
  //     variation mode deliberately passes null so the new dish does not inherit
  //     the original's identity (issue #763), so a citation there would be
  //     honoured against a recipe that is not being edited.
  //
  // A refused citation therefore yields a fresh UUID and falls back to exactly
  // what happened before this existed: `diffRecipe`'s Passes 3 and 4 guess, as
  // they always did. That fallback is permanent (issue #1178, Decision 5) — the id
  // is model-supplied and therefore fallible, and this raises the ceiling without
  // removing the floor.
  const baseStepIds = new Set((baseRecipe?.steps ?? []).map((step) => step.id));
  const claimedStepIds = new Set<string>();
  let citedCount = 0;
  const steps = raw.steps.map((s) => {
    const cited = s.sourceStepId ?? null;
    if (cited !== null && baseRecipe) citedCount += 1;
    const reused =
      cited !== null && baseStepIds.has(cited) && !claimedStepIds.has(cited) ? cited : null;
    if (reused !== null) claimedStepIds.add(reused);
    return {
      id: reused ?? crypto.randomUUID(),
      text: s.text,
      timer:
        s.timerMinutes !== null
          ? { durationMinutes: s.timerMinutes, description: s.timerLabel }
          : null,
      note: s.note,
    };
  });

  // How well the librarian cited, as counts and never a word of the recipe (the
  // same rule the parse-failure report keeps — free-form user content stays out of
  // anything we emit). This is the measurement #1178 Phase 3 reports against, and
  // the standing signal for whether the model has stopped citing after a model
  // upgrade. Silent outside edit mode, where there is nothing a citation could name.
  if (baseRecipe) {
    logger.info('assembleRecipeDraft: librarian step citations', {
      steps: raw.steps.length,
      baseSteps: baseRecipe.steps.length,
      cited: citedCount,
      reused: claimedStepIds.size,
    });
  }

  // Edit mode: index the base recipe's ingredients by rawText. The librarian is
  // told to keep unchanged ingredients' rawText verbatim, so a byte-identical
  // rawText means "untouched" — we reuse its existing canon match, parsed data,
  // and id, and skip it entirely from the parse + canon (embedding) flows below.
  // Only genuinely new or edited ingredients get re-parsed and re-embedded, so a
  // one-line "add cheese" edit costs one canon match instead of N.
  const baseByRawText = new Map<string, IngredientDoc>();
  if (baseRecipe) {
    for (const group of baseRecipe.ingredients) {
      for (const ing of group.items) baseByRawText.set(ing.rawText, ing);
    }
  }

  // Flatten only the ingredients that actually need processing (new/edited).
  // With no base recipe baseByRawText is empty, so this is every distinct
  // ingredient line.
  const toProcess: string[] = [];
  const seen = new Set<string>();
  for (const group of raw.ingredientGroups) {
    for (const ing of group.ingredients) {
      if (baseByRawText.has(ing.rawText) || seen.has(ing.rawText)) continue;
      seen.add(ing.rawText);
      toProcess.push(ing.rawText);
    }
  }

  // Parse raw texts to extract clean item names (strips quantity, unit, prep phrases).
  // This mirrors what recipeService.canonicaliseIngredients does on the manual-entry path
  // and ensures the canon matching stages see "garlic" not "1 head of garlic".
  // We also retain the full structured `parsed` object (quantity/unit/displayText/etc.)
  // so the assembled RecipeDoc threads it through instead of dropping it as null.
  //
  // HOW THE JOIN BACK TO THE INPUT WORKS (issue #949). `item.rawText` on a parse
  // result is EMITTED BY THE MODEL, not threaded through from the input, so keying
  // on it alone loses a whole line to a single re-typed character — a normalised
  // `1/8`, a dropped `(ginger snaps)`, a trimmed `, melted`. Sixteen production rows
  // were stored canon-matched with no amount at all that way, silently, because the
  // canon join two blocks below is by INDEX and succeeded regardless.
  //
  // So: join by POSITION when the parser returned exactly one item per input line,
  // and fall back to the model's echoed rawText only when the counts disagree. The
  // fallback earns its place — parseRecipeIngredients groups its output and may
  // legitimately split or merge a line, and a blind positional zip would then hang
  // the wrong quantity on the wrong ingredient, which is worse than a null.
  //
  // Duplicate rawText: last occurrence wins in the fallback; `toProcess` is already
  // deduped by `seen` above, so the positional path sets each key exactly once.
  const parsedMap = new Map<string, NonNullable<ParsedIngredient>>();
  if (toProcess.length > 0) {
    try {
      const joinedRawText = toProcess.join('\n');
      const parseResult = await parseRecipeIngredientsFlow({ rawText: joinedRawText });
      const parsedItems = parseResult.flatMap((group) => group.items);
      if (parsedItems.length === toProcess.length) {
        toProcess.forEach((rawText, k) => {
          const parsed = parsedItems[k]?.parsed;
          if (parsed) parsedMap.set(rawText, parsed);
        });
      } else {
        for (const item of parsedItems) {
          if (item.parsed) parsedMap.set(item.rawText, item.parsed);
        }
      }
    } catch {
      // Parse failure stays non-fatal — every line simply goes unparsed, and is
      // reported below. Non-fatal was never the bug; silence was.
    }
  }

  // Lines the parser gave us nothing for. They keep `parsed: null` (the schema
  // allows it) and they are NOT sent to canon: without a parsed item name canon
  // would be matching "125 g gingernuts (ginger snaps)" rather than "gingernut",
  // and a row that comes back `matched` on that is exactly the row that claims
  // success while holding no data. Left out, they have no canon result, which the
  // assembly below already reads as `pending` — honest (canon was never asked),
  // visibly unresolved, and repairable one tap at a time via Match again, whose
  // single-row path re-parses the line first. `matchState` still means canon
  // matching and nothing else.
  const unparsed = toProcess.filter((rawText) => !parsedMap.has(rawText));
  const toCanon = toProcess.filter((rawText) => parsedMap.has(rawText));

  // Batch canonicalise the parsed raw texts; key results by rawText so the
  // assembly step below can look each one up directly.
  const canonByRawText = new Map<string, CanonResult>();
  if (toCanon.length > 0) {
    try {
      const canonResults = await canonicaliseRecipeIngredientsFlow({
        items: toCanon.map((rawText) => ({
          // An empty or absent `item` on an otherwise good parse still falls back
          // to the full line, as it always has.
          rawName: parsedMap.get(rawText)?.item || rawText,
          rawText,
        })),
      });
      // No `recipeId` is sent, so this is the content arm and the answer is the
      // bare array. The union type still admits the `{ results, persistence }`
      // envelope (issue #1601); unwrapping it rather than asserting it away keeps
      // this correct should the call ever name a recipe.
      const slots = Array.isArray(canonResults) ? canonResults : canonResults.results;
      toCanon.forEach((rawText, k) => {
        const r = slots[k];
        if (r) canonByRawText.set(rawText, r);
      });
    } catch {
      // Canon failure is non-fatal — ingredients land as pending.
    }
  }

  // Assemble ingredient groups with IDs, canon results, and firstUsedInStepId.
  const ingredientGroups: IngredientGroupDoc[] = raw.ingredientGroups.map((group) => ({
    id: crypto.randomUUID(),
    name: group.name,
    items: group.ingredients.map((ing) => {
      // Resolve step ordinal → step ID. Always taken from the fresh AI output so
      // reordered steps / flipped optional flags are respected even on otherwise
      // unchanged ingredients.
      const ord = ing.firstUsedInStepOrdinal;
      const firstUsedInStepId =
        ord !== null && ord >= 0 && ord < steps.length ? steps[ord]!.id : null;

      // Unchanged ingredient — carry the existing canon match, parsed data, and
      // id straight over (it was never sent to parse/canon above).
      const base = baseByRawText.get(ing.rawText);
      if (base) {
        return {
          id: base.id,
          rawText: ing.rawText,
          parsed: base.parsed,
          canonId: base.canonId,
          matchState: base.matchState,
          isOptional: ing.isOptional,
          firstUsedInStepId,
        };
      }

      const canon = canonByRawText.get(ing.rawText);
      const canonId = canon && canon.kind === 'ok' ? (canon.value.item as { id: string }).id : null;
      const matchState: 'matched' | 'pending' | 'failed' =
        canon && canon.kind === 'ok' ? 'matched' : canon ? 'failed' : 'pending';

      return {
        id: crypto.randomUUID(),
        rawText: ing.rawText,
        parsed: parsedMap.get(ing.rawText) ?? null,
        canonId,
        matchState,
        isOptional: ing.isOptional,
        firstUsedInStepId,
      };
    }),
  }));

  // Minted here rather than inline in the return below so the miss report can name
  // the document — same position in the id sequence as before, still after every
  // step / group / ingredient id.
  const recipeId = crypto.randomUUID();

  // A line the parser returned nothing for is UNEXPECTED, and until now reached
  // nobody: canon matched around it and the row went to Firestore looking healthy
  // (issue #949). Report it so the join's real miss rate is finally measurable —
  // counts and the document id only. The ingredient text itself is free-form user
  // content and never goes near a report (CLAUDE.md §Observability).
  //
  // Best-effort and non-throwing (Rule 10). No flush here: every caller of this
  // assembler is a callable that already drains in a finally (makeTracedCallable)
  // or under onCallGenkit's own flush.
  if (unparsed.length > 0) {
    reportServerError(
      new Error(
        `assembleRecipeDraft: ${unparsed.length} of ${toProcess.length} ingredient lines had no parse result ` +
          `(recipeId=${baseRecipe?.id ?? recipeId}, source=${source.type})`,
      ),
    );
  }

  // The phase strip and its one-line summary (issue #1122), merged as ONE fact
  // rather than two independently-defaulted fields (issue #1122 review, blocking
  // 2). `reconcileRecipePhases` is the shared implementation, and its callers are
  // exactly three — this flow, `onRecipeWritten`'s re-estimate branch, and the
  // client's `mergeAmendedRecipe` (`apps/web-pwa/src/lib/recipeAmend.ts`). For a
  // write coming through one of those three, a fresh strip cannot land paired
  // with a stale summary or the reverse. That list IS the boundary of the claim:
  // it is a property of routing through this function, not of the collection, so
  // a fourth writer of `metadata.phases` that pairs the fields itself is outside
  // it and gets no such guarantee.
  //
  // Stated once without that boundary (issue #1203), the sentence was simply
  // false: `mergeAmendedRecipe` re-split the pair downstream of this flow, and
  // its output — not this draft — is what a chat amend actually stores. Pinned by
  // the two pairing tests in `tests/flows/assembleRecipeDraft.test.ts`, the
  // re-estimate pair in `tests/triggers/onRecipeWritten.phases.test.ts`, and the
  // amend-merge pairing tests in `apps/web-pwa/tests/recipeAmend.test.ts`.
  const phaseStrip = reconcileRecipePhases(raw, baseRecipe?.metadata ?? null);

  // WHAT KIND OF ENTRY this is, in strict precedence (issue #765).
  //
  // 1. `baseRecipe.kind` — FIRST and UNCONDITIONAL. `kind` is immutable, so an
  //    edit-mode amend must never re-type the entry it is editing, whatever the
  //    model said and whichever of the four kinds it is. Edit mode wins over
  //    inference, always; that is why this operand is not guarded by anything.
  // 2. `kindHint` — variation mode, where the base is deliberately not passed
  //    as `baseRecipe` but its kind is still a known fact rather than a guess.
  // 3. `raw.kind` — what the model classified. Before #765 this line read
  //    `?? 'recipe'`, which is why no AI path could produce anything but a
  //    dinner: it was the single choke point all three creation paths funnel
  //    through. The schema (`AuthoredRecipeKindSchema`) is what guarantees this
  //    operand is one of the authorable kinds and floors it at `'recipe'` when
  //    the model omits it or invents one — there is no unbounded value here to
  //    guard against.
  //
  // Pulled out to a local so `cureCategory` below can be correlated against the
  // SAME resolved kind, rather than recomputing (and risking disagreeing with)
  // it (#1425 review, blocking 2).
  const kind = baseRecipe?.kind ?? kindHint ?? raw.kind;

  const draft: RecipeDoc = {
    id: recipeId,
    schemaVersion: 1,
    kind,
    // WHICH KIND OF CURE (issue #1404), gated on the resolved `kind` above
    // (#1425 review, blocking 2): a category is stored ONLY where `kind` is
    // `'cure'`. Without this gate, an amend of a non-cure the model misreads as
    // cured meat, or a `.catch('recipe')` degradation that still answered the
    // category question, would store `{ kind: 'recipe', cureCategory: … }` — a
    // value `RecipeIdentityCard` cannot show or correct (its editor renders off
    // `KIND_COPY[kind].categoryCopy`, which only `cure` declares), that
    // `startBatch` would freeze onto a run regardless of what it baked, and
    // that would grow a phantom filter chip on `/batches` for a household that
    // has never cured anything.
    //
    // WITHIN a cure, the base wins over the model when it is already set — the
    // same shape `kind` uses above, and for the same reason: the sanctioned
    // correction route is the recipe page's tap (#1404 — "there is no
    // confirmation and no gate"), never chat, so an amend about something else
    // entirely must not silently re-classify a category someone already
    // corrected there. `raw.cureCategory` lands only when the base has none
    // yet — a fresh import, a fresh chat-authored cure, or an existing cure
    // nobody has categorised.
    //
    // This line used to read `raw.cureCategory ?? baseRecipe?.cureCategory ??
    // null` — the two operands the other way round — on the stated rationale
    // that "an amend silent on the subject leaves a category already set
    // alone". That was never true in practice: `CURE_CATEGORY_RULES` tells the
    // model to answer on every turn and never refuse, and
    // `formatRecipeForPrompt` never shows it the stored category, so
    // `raw.cureCategory` is non-null on every cure turn and the intended
    // "floor" never fired — the identical shape of gap #1203 documents (and
    // leaves open) for the phase strip below, because closing THAT one needs
    // prompt work outside this function's reach. This field had no such
    // excuse: an unconditional base-wins floor was already sitting one field
    // up, so the fix is to use the same shape, not to describe the gap again.
    cureCategory: kind === 'cure' ? (baseRecipe?.cureCategory ?? raw.cureCategory ?? null) : null,
    title: raw.title,
    description: raw.description,
    ingredients: ingredientGroups,
    steps,
    metadata: {
      servings: raw.servings,
      // The phase strip and its summary (issue #1122) — one merged fact, computed
      // above by `reconcileRecipePhases`. See that function for the edit-mode
      // carry-through argument (a cook's hand-edit must survive an amend that
      // returned no phases) and why the summary is never split from the strip.
      phases: phaseStrip.phases,
      timingSummary: phaseStrip.timingSummary,
      tags: normaliseTags(raw.tags),
    },
    source,
    notes: raw.notes,
    // Preserve the existing "makes" link on an edit-mode amend; null otherwise.
    // Neither the librarian nor the extractor touches it, so carry the base value
    // straight through.
    producesCanonId: baseRecipe?.producesCanonId ?? null,
    // Same carry-through, for the same reason (issue #752): neither the librarian
    // nor the extractor knows what a meal is, so an edit-mode amend or a refresh
    // must hand the base recipe's components straight back. Without this line
    // `mergeAmendedRecipe`'s spread would erase them on every amend.
    componentRecipeIds: baseRecipe?.componentRecipeIds ?? [],
    // Kit (issue #882) is deliberately NOT carried through from `baseRecipe`, which
    // makes it the odd one out among the carry-throughs around it. Every step here
    // gets a FRESH `crypto.randomUUID()` (see the top of this function), so the base
    // recipe's `kit[].stepIds` point at ids this draft no longer contains — carrying
    // them would hand the page a set of dangling references. Going out empty, with
    // no `kitInferredAt` alongside it, is what routes the amended recipe back through
    // the onRecipeWritten kit branch, which re-reads the method it now actually has.
    kit: [],
    // Third carry-through of the same shape, and the sharpest of the three
    // (issue #845). An edit-mode amend rebuilds the WHOLE document from
    // `baseRecipe` and `mergeAmendedRecipe` spreads that draft over the existing
    // recipe, so omitting these two lines would silently erase the recipe's
    // creator every time someone amended it by chat. Neither the librarian nor
    // the extractor knows who anyone is, so on a create both go out BLANK from
    // here and are stamped, if at all, by whoever writes the document:
    //   * `authorRecipe` in create mode stamps them itself, from the name on its
    //     wire input, because since issue #1431 it also WRITES the document;
    //   * the two import flows leave them blank on purpose — an import is
    //     attributed by the first in-place edit made to it;
    //   * an edit-mode draft is carried through here and stamped in the browser
    //     by whoever applies the amendment.
    // The rule every one of them applies is `stampAttribution` in `@salt/domain`.
    createdBy: baseRecipe?.createdBy ?? '',
    lastEditedBy: baseRecipe?.lastEditedBy ?? '',
    // Spread, not `needs_approval: needsApproval` — the field is optional and
    // absent means reviewed, so the un-flagged path must omit it entirely rather
    // than write an explicit false.
    ...(needsApproval ? { needs_approval: true } : {}),
    image: null,
    createdAt: now,
    updatedAt: now,
  };

  // OBSERVE-ONLY (issue #932, Phase 5). Does the draft this function assembles
  // actually satisfy RecipeSchema? Nobody knew: the three recipe flows declare
  // `outputSchema: z.custom<RecipeDoc>()`, which validates nothing, and the draft
  // reaches the `recipes` collection through an `httpsCallable<…, RecipeDoc>`
  // type argument — a cast — and a full-document `setDoc`. So there is no
  // RecipeSchema parse anywhere between the model and production.
  //
  // This is the measurement, and it is DELIBERATELY NOT ACTED ON: the result is
  // never read, the draft is returned unchanged either way, and no import that
  // succeeds today can fail because of this. Turning the flows' output schemas
  // real is Phase 6, and it ships only if this reports nothing over real traffic
  // — otherwise it would convert a silently-malformed recipe into a visible
  // import failure for real users.
  //
  // Issue PATHS only, never values: CLAUDE.md's error-reporting conventions
  // require free-form user content to be scrubbed, and a recipe draft is almost
  // entirely user- and model-authored text.
  //
  // This is the single assembly point all three authoring paths funnel through
  // (authorRecipe, extractRecipeFromUrl, extractRecipeFromPhoto), so one call
  // covers all of them.
  const observed = RecipeSchema.safeParse(draft);
  if (!observed.success) {
    const issuePaths = observed.error.issues.map((i) => i.path.join('.'));
    logger.warn('assembleRecipeDraft: draft does not satisfy RecipeSchema', {
      issuePaths,
      issueCount: observed.error.issues.length,
    });
    reportServerError(
      new Error(`assembleRecipeDraft: RecipeSchema mismatch at ${issuePaths.join(', ')}`),
    );
  }

  return draft;
}
