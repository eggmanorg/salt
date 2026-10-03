import { failure, success } from '@salt/shared-types';
import { ErrorCode } from '@salt/shared-types';
import type { DomainError, ReadResult, ShoppingBehavior, CanonItemUnit } from '@salt/shared-types';
import type { CanonItem } from '../entities/CanonItem.js';
import type { Aisle } from '../entities/Aisle.js';
import type { MatchCandidate, MatchStage } from '../entities/MatchCandidate.js';
import type { FinalDecision } from '../entities/MatchLogEntry.js';
import type { CanonLocalStorePort } from '../ports/CanonLocalStorePort.js';
import type { AisleLocalStorePort } from '../ports/AisleLocalStorePort.js';
import type { EmbeddingPort } from '../ports/EmbeddingPort.js';
import type { CanonArbitrationPort } from '../ports/CanonArbitrationPort.js';
import type { IdGenerator } from '../ports/IdGenerator.js';
import type { MatchLoggingPort } from '../ports/MatchLoggingPort.js';
import { MATCH_THRESHOLDS } from '../queries/matchThresholds.js';
import { MatchLogBuilder } from './buildMatchLog.js';
import { normaliseName } from '../queries/normaliseName.js';
import { tokenMatch } from '../queries/tokenMatch.js';
import { stringSimilarity } from '../queries/stringSimilarity.js';
import { findClosestMatch } from '../queries/findClosestMatch.js';
import { embedMatch } from '../queries/embedMatch.js';
import { createCanonItem } from './createCanonItem.js';
import { appendCanonSynonym } from './appendCanonSynonym.js';
import type { DerivedNamePredicate } from './appendCanonSynonym.js';

/**
 * Review-queue markers written to `CanonItem.reasoning` when a new item is
 * created but arbitration could not supply a canonical name. The raw input is
 * kept verbatim and `needs_approval` (default true) surfaces it for a human to
 * fix. Two distinct strings so the queue can tell a failed AI call apart from
 * the AI running but not matching.
 */
export const ARBITRATION_FAILED_REASONING =
  'AI arbitration call failed; raw input kept — needs review';
export const ARBITRATION_NO_MATCH_REASONING =
  'AI arbitration returned no match; raw input kept — needs review';

export interface MatchOrCreateInput {
  readonly rawName: string;
  readonly selectedAisleId?: string | null | undefined;
  /** Skip match stages and force a new item. Pipeline still runs aisle arbitration. */
  readonly forceCreate?: boolean;
  readonly rawText?: string;
}

export type MatchOrCreateResult = {
  readonly decision: 'created' | 'matched' | 'ai_arbitrated';
  readonly item: CanonItem;
};

export interface MatchOrCreatePorts {
  readonly store: CanonLocalStorePort;
  readonly aisleStore: AisleLocalStorePort;
  readonly embedding: EmbeddingPort;
  readonly arbitration: CanonArbitrationPort;
  readonly ids: IdGenerator;
  readonly logging: MatchLoggingPort | null;
  /**
   * Optional, and absent means "no opinion" — see `AppendCanonSynonymOptions`.
   * Supplied by callers that hold the product-form list, so a derivation never
   * gets recorded as a synonym of the thing it is derived from.
   */
  readonly isDerivedName?: DerivedNamePredicate;
}

/**
 * Single-item entry point — a batch of one.
 */
export async function matchOrCreate(
  input: MatchOrCreateInput,
  ports: MatchOrCreatePorts,
): Promise<ReadResult<MatchOrCreateResult, DomainError>> {
  return (await matchOrCreateBatch([input], ports))[0]!;
}

/**
 * Three-phase batch pipeline:
 *
 *   Phase 1 — Classify: run stages 1-5 (deterministic + embedding) for every
 *             input in parallel. No AI calls. Each input is classified as a
 *             direct match, a no-AI create, or "needs arbitration".
 *
 *   Phase 2 — Arbitrate: fire all needed AI calls in parallel. For a recipe
 *             with 35 new ingredients this collapses from ~35 × 3 s = 105 s
 *             sequential to ~3 s total.
 *
 *   Phase 3 — Apply: apply classification + AI result for each input in order,
 *             folding new items back into the in-memory snapshot so that later
 *             inputs in the same batch can match a just-created item.
 *
 * Trade-off: two inputs that both lack candidates are classified against the
 * snapshot that existed before either was created, so they cannot prevent each
 * other from creating near-duplicate canon items. The needs_approval queue
 * catches any such duplicates for human review.
 */
export async function matchOrCreateBatch(
  inputs: readonly MatchOrCreateInput[],
  ports: MatchOrCreatePorts,
): Promise<ReadResult<MatchOrCreateResult, DomainError>[]> {
  const itemsResult = await ports.store.list();
  if (itemsResult.kind !== 'ok') return inputs.map(() => itemsResult);

  const snapshot = new Map<string, CanonItem>();
  for (const item of itemsResult.value) snapshot.set(item.id, item);

  const aisles = await loadAisles(ports.aisleStore);

  const resolvePorts: MatchOrCreatePorts = {
    ...ports,
    embedding: await buildEmbeddingCache(ports.embedding, inputs),
  };

  // Phase 1: classify all inputs in parallel (stages 1-5, no AI)
  const classifications = await Promise.all(
    inputs.map((input) => classifyOne(input, [...snapshot.values()], aisles, resolvePorts)),
  );

  // Phase 2: fire all needed AI calls in parallel
  const arbOutcomes = await Promise.all(
    classifications.map((c) => {
      if (c.kind !== 'needs_ai') return null;
      const t0 = Date.now();
      return resolvePorts.arbitration
        .arbitrate({
          normalisedName: c.normalisedName,
          candidates: [...c.shortlist],
          aisles: c.aisles,
          ...(c.input.rawText !== undefined ? { rawText: c.input.rawText } : {}),
        })
        .then((result) => ({ result, durationMs: Math.max(0, Date.now() - t0) }));
    }),
  );

  // Phase 3: apply results in order, maintaining snapshot for intra-batch dedup
  const results: ReadResult<MatchOrCreateResult, DomainError>[] = [];
  for (let i = 0; i < classifications.length; i++) {
    const result = await applyClassification(
      classifications[i]!,
      arbOutcomes[i] ?? null,
      snapshot,
      resolvePorts,
    );
    if (result.kind === 'ok') snapshot.set(result.value.item.id, result.value.item);
    results.push(result);
  }
  return results;
}

// ─── Embedding cache ─────────────────────────────────────────────────────────

/**
 * Wrap an `EmbeddingPort` so `computeEmbedding(name)` is served from a cache
 * pre-filled by a single `computeEmbeddings` call over all input names.
 */
async function buildEmbeddingCache(
  base: EmbeddingPort,
  inputs: readonly MatchOrCreateInput[],
): Promise<EmbeddingPort> {
  const names = inputs
    .map((i) => normaliseName(i.rawName))
    .filter((n): n is string => n.length > 0);
  const unique = [...new Set(names)];

  const cache = new Map<string, ReadResult<readonly number[], DomainError>>();
  if (unique.length > 0 && base.computeEmbeddings) {
    const batched = await base.computeEmbeddings(unique);
    if (batched.kind === 'ok') {
      unique.forEach((name, i) => {
        const vec = batched.value[i];
        if (vec !== undefined) cache.set(name, success(vec));
      });
    } else {
      for (const name of unique) cache.set(name, batched);
    }
  }

  return {
    ...base,
    computeEmbedding: async (text) => cache.get(text) ?? base.computeEmbedding(text),
  };
}

// ─── Phase 1: Classification ─────────────────────────────────────────────────

type CommitLog = (
  decision: FinalDecision,
  finalItemId: string | null,
  finalItemName?: string | null,
) => void;

type ArbOutcome = Awaited<ReturnType<CanonArbitrationPort['arbitrate']>>;

type Classification =
  | { kind: 'failure'; result: ReadResult<MatchOrCreateResult, DomainError> }
  | {
      kind: 'direct_match';
      item: CanonItem;
      rawName: string;
      logBuilder: MatchLogBuilder | null;
      commitLog: CommitLog;
    }
  | {
      kind: 'create_no_ai';
      name: string;
      aisleId: string | null;
      /** True when forceCreate was set — skip the intra-batch snapshot re-check. */
      forceCreate: boolean;
      logBuilder: MatchLogBuilder | null;
      commitLog: CommitLog;
    }
  | {
      kind: 'needs_ai';
      input: MatchOrCreateInput;
      normalisedName: string;
      /** Empty shortlist → new-item AI call; non-empty → arbitration against candidates. */
      shortlist: readonly MatchCandidate[];
      reason: string;
      aisles: readonly Aisle[];
      logBuilder: MatchLogBuilder | null;
      runId: string;
      commitLog: CommitLog;
    };

/**
 * Runs stages 1-5 (deterministic + embedding) for a single input against the
 * current snapshot. No AI calls. Safe to run in parallel across all inputs.
 */
async function classifyOne(
  input: MatchOrCreateInput,
  items: readonly CanonItem[],
  aisles: readonly Aisle[],
  ports: MatchOrCreatePorts,
): Promise<Classification> {
  const { rawName, selectedAisleId, forceCreate = false } = input;
  const { ids, logging } = ports;

  const normalisedName = normaliseName(rawName);
  if (!normalisedName) {
    return {
      kind: 'failure',
      result: failure({ kind: 'ValidationError', code: ErrorCode.INVALID_CANON_NAME }),
    };
  }

  const logBuilder = logging ? new MatchLogBuilder() : null;
  const runId = ids.newCanonId();
  logBuilder?.start(rawName, normalisedName);

  const commitLog: CommitLog = (decision, finalItemId, finalItemName = null): void => {
    if (!logBuilder || !logging) return;
    const entry = logBuilder.complete(runId, decision, finalItemId, finalItemName);
    void logging.write(entry).catch(() => {});
  };

  // Recorded BEFORE the forceCreate branch, which returns from both of its arms.
  // `MatchLogBuilder.start` has just reset this to 0, so setting it below the
  // branch meant every forced creation reported `inputItemCount: 0` — an
  // artificial bucket in the canon.match funnel, where the field is documented as
  // "size of canon snapshot considered" (issue #937).
  logBuilder?.setInputItemCount(items.length);

  if (forceCreate) {
    if (aisles.length > 0 && (selectedAisleId ?? null) === null) {
      return {
        kind: 'needs_ai',
        input,
        normalisedName,
        shortlist: [],
        reason: 'aisle_suggestion',
        aisles,
        logBuilder,
        runId,
        commitLog,
      };
    }
    return {
      kind: 'create_no_ai',
      name: rawName,
      aisleId: selectedAisleId ?? null,
      forceCreate: true,
      logBuilder,
      commitLog,
    };
  }

  const stage1to4 = findClosestMatch(items, rawName, logBuilder ?? undefined);

  if (stage1to4.kind === 'match') {
    return { kind: 'direct_match', item: stage1to4.candidate.item, rawName, logBuilder, commitLog };
  }

  if (stage1to4.kind === 'ambiguous') {
    return {
      kind: 'needs_ai',
      input,
      normalisedName,
      shortlist: enrichAmbiguousSupport(stage1to4.candidates, normalisedName),
      reason: 'ambiguous_near_tie',
      aisles,
      logBuilder,
      runId,
      commitLog,
    };
  }

  // Stage 5: embedding (served from pre-built cache — fast)
  const embedCandidates = await embedMatch(
    ports.embedding,
    normalisedName,
    items,
    logBuilder ?? undefined,
  );
  const shortlist = buildShortlist(embedCandidates, items, normalisedName);

  // A lone shortlist candidate may bypass AI arbitration only when it comes from
  // token overlap (stage 2) — structural word-sharing, the legitimate fast path
  // (e.g. "olive oil" → "olive oil extra"). Edit-distance (stage 4) and
  // embedding (stage 5) candidates in the [aiThreshold, stop) band are
  // similarity coincidences, not confident matches — "olives" vs "limes"
  // normalises to "olive"/"lime" and scores exactly 0.6 Levenshtein — so they
  // escalate to AI like the rest of the shortlist instead of silently binding.
  // Genuine typos already clear stage 4's 0.85 stop (or normalise to an exact
  // stage-1 hit) inside findClosestMatch and never reach here.
  if (shortlist.length === 1 && shortlist[0]!.stage === 2) {
    return { kind: 'direct_match', item: shortlist[0]!.item, rawName, logBuilder, commitLog };
  }

  if (shortlist.length > 0) {
    return {
      kind: 'needs_ai',
      input,
      normalisedName,
      shortlist,
      reason: 'near_miss_shortlist',
      aisles,
      logBuilder,
      runId,
      commitLog,
    };
  }

  // No candidates: AI for aisle/name unless caller already supplied an aisle
  if (aisles.length > 0 && (selectedAisleId ?? null) === null) {
    return {
      kind: 'needs_ai',
      input,
      normalisedName,
      shortlist: [],
      reason: 'aisle_suggestion',
      aisles,
      logBuilder,
      runId,
      commitLog,
    };
  }

  return {
    kind: 'create_no_ai',
    name: rawName,
    aisleId: selectedAisleId ?? null,
    forceCreate: false,
    logBuilder,
    commitLog,
  };
}

// ─── Phase 3: Apply ───────────────────────────────────────────────────────────

/**
 * Applies a classification (plus its AI result, if any) and persists the
 * outcome. Uses the live snapshot to pick up synonym additions made by earlier
 * items in the same batch.
 */
async function applyClassification(
  c: Classification,
  arb: { result: ArbOutcome; durationMs: number } | null,
  snapshot: Map<string, CanonItem>,
  ports: MatchOrCreatePorts,
): Promise<ReadResult<MatchOrCreateResult, DomainError>> {
  const { store, ids } = ports;

  if (c.kind === 'failure') return c.result;

  if (c.kind === 'direct_match') {
    // Use the snapshot-current version of the item so that synonym additions
    // by earlier batch items are not lost via a stale overwrite.
    const currentItem = snapshot.get(c.item.id) ?? c.item;
    return resolveMatch(ports, currentItem, c.rawName, 'matched', c.commitLog);
  }

  if (c.kind === 'create_no_ai') {
    if (!c.forceCreate) {
      const hit = findSnapshotMatch(c.name, snapshot);
      if (hit) return resolveMatch(ports, hit, c.name, 'matched', c.commitLog);
    }
    // create_no_ai: the raw entry IS the name, so the omission rule drops it.
    return persistNew(store, ids, c.name, c.aisleId, c.commitLog, c.name);
  }

  // kind === 'needs_ai'
  const { input, normalisedName: _norm, shortlist, aisles, logBuilder, commitLog } = c;
  const { rawName, selectedAisleId } = input;

  // Re-check snapshot before applying the AI result: an earlier item in this
  // batch may have created or updated an item that is now a deterministic match.
  const snapshotHit = findSnapshotMatch(rawName, snapshot);
  if (snapshotHit) return resolveMatch(ports, snapshotHit, rawName, 'matched', commitLog);

  const durationMs = arb?.durationMs ?? 0;
  const arbResult =
    arb?.result ??
    failure({ kind: 'ValidationError', code: ErrorCode.INVALID_CANON_NAME } as DomainError);

  logArbitration(logBuilder, c.reason, shortlist.length, aisles.length, arbResult, durationMs);

  if (shortlist.length > 0) {
    if (arbResult.kind === 'ok') {
      const decision = arbResult.value;
      if (decision.kind === 'match') {
        const candidate = shortlist.find((s) => s.item.id === decision.itemId);
        if (candidate) {
          const currentItem = snapshot.get(candidate.item.id) ?? candidate.item;
          return resolveMatch(
            ports,
            currentItem,
            rawName,
            'ai_arbitrated',
            commitLog,
            decision.reasoning,
          );
        }
        // AI returned an unknown id — fall through to fallback
      } else if (decision.kind === 'new') {
        // The SAME failsafe the empty-shortlist path applies below, and for the
        // same reason: the AI is asked to name the thing, and the clean name it
        // returns is often one the catalog already holds under a rawName that
        // failed every deterministic stage. Guarding only the empty-shortlist
        // path left this one open, and a corpus re-match walked straight through
        // it: "small red onion or a couple of shallots" and "warm water" each had
        // near-miss candidates, so arbitration ran with a non-empty shortlist,
        // answered "new", and minted a second "Red Onion" and a second "Water"
        // beside the originals. Having candidates makes a duplicate MORE likely,
        // not less — the near-misses are what prove the concept is already known.
        const canonNameHit = findSnapshotMatch(decision.canonName, snapshot);
        if (canonNameHit) {
          return resolveMatch(ports, canonNameHit, rawName, 'ai_arbitrated', commitLog);
        }
        return persistNew(
          store,
          ids,
          decision.canonName,
          selectedAisleId ?? decision.aisleId ?? null,
          commitLog,
          rawName,
          extrasFromNew(decision),
        );
      }
      // decision.kind === 'no-match': fall through to highest-confidence fallback
    }
    // AI errored, returned unknown id, or said no-match. Fall back to the best
    // candidate — but never to a pure edit-distance (stage-4) neighbour. Those
    // are spelling coincidences ("olives" vs "limes" — 0.6 Levenshtein) that
    // bind only on a POSITIVE AI match, never via this degraded path. Token
    // overlap (stage 2) and embedding (stage 5) candidates stay valid fallbacks;
    // a stage-4-only shortlist creates a new item instead of mis-binding.
    //
    // Reads `supportedStages`, not `stage`: the question here is whether edit
    // distance is the ONLY support, and `stage` records merely which signal
    // scored HIGHEST. Testing `stage !== 4` skipped candidates that token overlap
    // or embedding also backed whenever their Levenshtein score came out higher
    // ("chick pea flour" vs "Chick Pea Flakes" — token 0.667, Levenshtein 0.800),
    // minting a new item where the pipeline promised to bind an existing one.
    // The lone-candidate fast bind above deliberately still reads `stage`: it
    // asks the other question, and widening it is what #248 removed.
    const fallback = shortlist.find((c) => c.supportedStages.some((s) => s !== 4));
    if (fallback) {
      const currentItem = snapshot.get(fallback.item.id) ?? fallback.item;
      return resolveMatch(ports, currentItem, rawName, 'ai_arbitrated', commitLog);
    }
    return persistNew(store, ids, rawName, selectedAisleId ?? null, commitLog, rawName);
  }

  // Empty shortlist: new-item creation with AI name/aisle suggestion
  let finalAisleId: string | null = selectedAisleId ?? null;
  let newExtras: ArbitrationExtras | undefined;
  let createName = rawName;

  if (arbResult.kind === 'ok' && arbResult.value.kind === 'new') {
    finalAisleId = arbResult.value.aisleId ?? null;
    newExtras = extrasFromNew(arbResult.value);
    createName = arbResult.value.canonName;
  } else {
    newExtras = { reasoning: arbitrationFailureReasoning(arbResult) };
  }

  // Failsafe: the AI may return a clean canonical name (e.g. "Garlic") that
  // already exists in the snapshot even though the raw name (e.g. "1 head of
  // garlic") failed all deterministic stages. Check before creating a duplicate.
  const canonNameHit = findSnapshotMatch(createName, snapshot);
  if (canonNameHit) {
    return resolveMatch(ports, canonNameHit, rawName, 'ai_arbitrated', commitLog);
  }

  return persistNew(store, ids, createName, finalAisleId, commitLog, rawName, newExtras);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ArbitrationExtras {
  readonly shoppingBehavior?: ShoppingBehavior;
  readonly largeQuantityThreshold?: number;
  readonly unit?: CanonItemUnit;
  readonly gramsPerItem?: number;
  readonly reasoning?: string;
}

type ArbitrationNew = Extract<
  Awaited<ReturnType<CanonArbitrationPort['arbitrate']>>,
  { kind: 'ok' }
>['value'] & { kind: 'new' };

function extrasFromNew(arb: ArbitrationNew): ArbitrationExtras {
  return {
    shoppingBehavior: arb.shoppingBehavior,
    ...(arb.largeQuantityThreshold !== undefined
      ? { largeQuantityThreshold: arb.largeQuantityThreshold }
      : {}),
    ...(arb.unit !== undefined ? { unit: arb.unit } : {}),
    ...(arb.gramsPerItem !== undefined ? { gramsPerItem: arb.gramsPerItem } : {}),
    ...(arb.reasoning !== undefined ? { reasoning: arb.reasoning } : {}),
  };
}

function arbitrationFailureReasoning(
  arbResult: Awaited<ReturnType<CanonArbitrationPort['arbitrate']>>,
): string {
  return arbResult.kind === 'err' ? ARBITRATION_FAILED_REASONING : ARBITRATION_NO_MATCH_REASONING;
}

async function loadAisles(aisleStore: AisleLocalStorePort) {
  const aislesResult = await aisleStore.load();
  return aislesResult.kind === 'ok' ? (aislesResult.value ?? []) : [];
}

function logArbitration(
  logBuilder: MatchLogBuilder | null,
  reason: string,
  candidatesIn: number,
  aislesIn: number,
  arbResult: Awaited<ReturnType<CanonArbitrationPort['arbitrate']>>,
  durationMs: number,
): void {
  if (!logBuilder) return;
  const outcome = arbResult.kind === 'ok' ? arbResult.value.kind : 'error';
  logBuilder.setArbitration({
    reason,
    candidatesIn,
    aislesIn,
    prompt: arbResult.kind === 'ok' ? (arbResult.value.prompt ?? '') : '',
    rawResponse: arbResult.kind === 'ok' ? (arbResult.value.rawResponse ?? '') : '',
    outcome,
    durationMs,
  });
}

/**
 * Run stages 1-4 (deterministic, no AI) against the current in-memory snapshot.
 * Used in phase 3 to catch items created by earlier applications in the same batch.
 */
function findSnapshotMatch(rawName: string, snapshot: Map<string, CanonItem>): CanonItem | null {
  if (snapshot.size === 0) return null;
  const result = findClosestMatch([...snapshot.values()], rawName, undefined);
  return result.kind === 'match'
    ? (snapshot.get(result.candidate.item.id) ?? result.candidate.item)
    : null;
}

function buildShortlist(
  embedCandidates: readonly MatchCandidate[],
  items: readonly CanonItem[],
  normalisedName: string,
): MatchCandidate[] {
  const map = new Map<string, MatchCandidate>();
  for (const c of embedCandidates) map.set(c.item.id, c);
  for (const item of items) {
    const normItem = normaliseName(item.name);
    // Both scored signals, folded through one accumulator. `confidence` and
    // `stage` keep their existing meanings — the best score, and which signal gave
    // it, strictly-greater so a tie leaves the earlier winner in place, exactly as
    // before. `supportedStages` accumulates EVERY signal that cleared the
    // threshold, which is what the degraded fallback needs and what a single
    // `stage` field could never record (issue #937).
    for (const [stage, score] of [
      [2, tokenMatch(normalisedName, normItem)],
      [4, stringSimilarity(normalisedName, normItem)],
    ] as const) {
      if (score < MATCH_THRESHOLDS.aiThreshold) continue;
      const existing = map.get(item.id);
      if (!existing) {
        map.set(item.id, { item, confidence: score, stage, supportedStages: [stage] });
        continue;
      }
      const supportedStages = withStage(existing.supportedStages, stage);
      map.set(
        item.id,
        score > existing.confidence
          ? { item, confidence: score, stage, supportedStages }
          : { ...existing, supportedStages },
      );
    }
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence);
}

/** Adds a stage to a provenance list, keeping it deduplicated and ascending. */
function withStage(stages: readonly MatchStage[], stage: MatchStage): readonly MatchStage[] {
  return stages.includes(stage) ? stages : [...stages, stage].sort((a, b) => a - b);
}

/**
 * `findClosestMatch`'s 'ambiguous' result hands back candidates straight from
 * `runScoredStage`, which stamps every one of them `supportedStages: [stage]`
 * — the single stage that produced the near-tie, with no visibility into
 * whether a DIFFERENT signal also clears `aiThreshold` for the same
 * candidate. That is exactly what the degraded AI-failure fallback in
 * `applyClassification` needs: a stage-4 near-tie where token overlap ALSO
 * supports a candidate must not read as "edit distance is the only support"
 * and fall through to `persistNew` (issue #937 B1).
 *
 * Re-scores each candidate against stage 2 (token overlap) and stage 4
 * (string similarity) through the same accumulator `buildShortlist` uses,
 * folding any signal at or above `aiThreshold` into `supportedStages`.
 * Membership is untouched — this only enriches the field on the candidates
 * `findClosestMatch` already selected, never adds or drops one — and
 * `confidence`/`stage` are left as-is: they still record the top-scoring
 * signal from the stage that actually produced this candidate list.
 */
function enrichAmbiguousSupport(
  candidates: readonly MatchCandidate[],
  normalisedName: string,
): MatchCandidate[] {
  return candidates.map((c) => {
    const normItem = normaliseName(c.item.name);
    let supportedStages = c.supportedStages;
    for (const [stage, score] of [
      [2, tokenMatch(normalisedName, normItem)],
      [4, stringSimilarity(normalisedName, normItem)],
    ] as const) {
      if (score >= MATCH_THRESHOLDS.aiThreshold) {
        supportedStages = withStage(supportedStages, stage);
      }
    }
    return supportedStages === c.supportedStages ? c : { ...c, supportedStages };
  });
}

// Takes the whole `ports` bag rather than just `store` so the synonym guard
// reaches every one of the seven match outcomes below without being threaded
// through each of them by hand — forgetting one would silently reopen the hole.
async function resolveMatch(
  ports: MatchOrCreatePorts,
  item: CanonItem,
  rawName: string,
  decision: 'matched' | 'ai_arbitrated',
  commitLog: CommitLog,
  reasoning?: string,
): Promise<ReadResult<MatchOrCreateResult, DomainError>> {
  const { store, isDerivedName } = ports;
  const updated = appendCanonSynonym(item, rawName, {
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(isDerivedName !== undefined ? { isDerivedName } : {}),
  });
  let finalItem = item;
  if (updated !== item) {
    const saved = await store.upsert(updated);
    if (saved.kind !== 'ok') return saved;
    finalItem = updated;
  }
  commitLog(decision, finalItem.id, finalItem.name);
  return success({ item: finalItem, decision });
}

async function persistNew(
  store: CanonLocalStorePort,
  ids: IdGenerator,
  name: string,
  aisleId: string | null,
  commitLog: CommitLog,
  // The raw entry this item is being minted from (issue #193), recorded on the
  // seeded `created` pending change. On the arbitration paths that is `rawName`
  // — where the value actually is, since the AI may have renamed it; on
  // create_no_ai it is the name itself and the omission rule drops it.
  rawInput: string,
  extras?: ArbitrationExtras,
): Promise<ReadResult<MatchOrCreateResult, DomainError>> {
  const result = createCanonItem(
    {
      name,
      aisleId,
      rawInput,
      ...(extras?.shoppingBehavior !== undefined
        ? { shoppingBehavior: extras.shoppingBehavior }
        : {}),
      ...(extras?.largeQuantityThreshold !== undefined
        ? { largeQuantityThreshold: extras.largeQuantityThreshold }
        : {}),
      ...(extras?.unit !== undefined ? { unit: extras.unit } : {}),
      ...(extras?.gramsPerItem !== undefined ? { gramsPerItem: extras.gramsPerItem } : {}),
      ...(extras?.reasoning !== undefined ? { reasoning: extras.reasoning } : {}),
    },
    ids,
  );
  if (result.kind !== 'ok') return result;
  const item = result.value;
  const saved = await store.upsert(item);
  if (saved.kind !== 'ok') return saved;
  commitLog('created', item.id, item.name);
  return success({ item, decision: 'created' });
}
