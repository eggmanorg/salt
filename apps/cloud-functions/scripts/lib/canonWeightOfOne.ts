// The decision half of ../fill-canon-weight-of-one.ts (issue #1643, Phase 4),
// lifted out because the script reaches Firestore and Gemini at import time and
// so cannot be imported by a test (docs/one-shot-scripts.md §2).
//
// WHAT THE FIELD IS. `CanonItem.gramsPerItem` is the weight of ONE of a counted
// item ("one red onion ≈ 150 g"). The shopping list uses it to fold a
// by-weight contribution into a counted row (`ceil(Σ grams ÷ weight of one)`)
// and to state the row's bracketed weight. Arbitration has set it on every
// counted item it creates since Phase 3; the counted items that existed before
// have none, and so their rows keep a separate grams subtotal. This fills them.
//
// TWO DECISIONS LIVE HERE, and they are the two the operator has to trust:
//
//   1. WHICH ITEMS ARE ASKED ABOUT (`weightOfOneTargets`) — `unit: 'count'` and
//      no weight of one yet. An item that already has one, from arbitration or
//      from admin's "Weight of one (g)" field, is never asked: a person or a
//      later arbitration decided it, and this pass has nothing newer to offer.
//   2. WHAT IS WRITTEN (`planWeightOfOneWrites`) — the REVIEWED proposals, joined
//      against canon as it is AT WRITE TIME. The model is asked once, in the dry
//      run, and the file it produced is what `--apply` writes; the model is not
//      asked a second time, so what lands is exactly what was read. Between the
//      two runs an item can be deleted, stop being counted, or gain a weight in
//      admin, and each of those wins over the proposal.

import type { CanonItem } from '@salt/domain';

/** The two fields of a canon item the model is shown. */
export interface WeightOfOneTarget {
  readonly id: string;
  readonly name: string;
}

/** One reviewed answer, as the dry run writes it to the plan file. */
export interface WeightOfOneProposal {
  readonly id: string;
  readonly name: string;
  /** Null when the model gave no usable weight — such an item is reported, never written. */
  readonly gramsPerItem: number | null;
}

export type WeightOfOneSkip = 'gone' | 'not-counted' | 'already-set' | 'no-proposal';

export interface WeightOfOnePlan {
  readonly write: readonly {
    readonly id: string;
    readonly name: string;
    readonly gramsPerItem: number;
  }[];
  readonly skip: readonly {
    readonly id: string;
    readonly name: string;
    readonly reason: WeightOfOneSkip;
  }[];
}

// The plan file is hand-editable JSON, so a value arriving here is whatever the
// operator typed: `"150"` passes `> 0` in JS and would land in Firestore as a
// string. Only a finite positive NUMBER is a weight.
function isWeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function hasWeightOfOne(item: Pick<CanonItem, 'gramsPerItem'>): boolean {
  // Mirrors the reader's rule (Phase 3 handoff): a missing or non-positive
  // weight of one means "no conversion", so a non-positive stored value is no
  // weight at all and the item is still a target.
  return isWeight(item.gramsPerItem);
}

/** The counted canon items with no weight of one, sorted by name for a readable report. */
export function weightOfOneTargets(
  items: readonly Pick<CanonItem, 'id' | 'name' | 'unit' | 'gramsPerItem'>[],
): WeightOfOneTarget[] {
  return items
    .filter((item) => item.unit === 'count' && !hasWeightOfOne(item))
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Join the model's answers onto the targets, by id. A target the model left out,
 * or answered with something that is not a positive finite number, gets a null
 * proposal — so the reviewed file names every target, answered or not.
 */
export function proposalsFor(
  targets: readonly WeightOfOneTarget[],
  answers: readonly { readonly id: string; readonly gramsPerItem: number | null }[],
): WeightOfOneProposal[] {
  const byId = new Map(answers.map((a) => [a.id, a.gramsPerItem]));
  return targets.map(({ id, name }) => {
    const grams = byId.get(id) ?? null;
    return {
      id,
      name,
      gramsPerItem: isWeight(grams) ? grams : null,
    };
  });
}

/** What `--apply` writes: each reviewed proposal that still applies to canon as it is now. */
export function planWeightOfOneWrites(
  current: readonly Pick<CanonItem, 'id' | 'unit' | 'gramsPerItem'>[],
  proposals: readonly WeightOfOneProposal[],
): WeightOfOnePlan {
  const byId = new Map(current.map((item) => [item.id, item]));
  const write: WeightOfOnePlan['write'][number][] = [];
  const skip: WeightOfOnePlan['skip'][number][] = [];
  for (const { id, name, gramsPerItem } of proposals) {
    const item = byId.get(id);
    if (item === undefined) skip.push({ id, name, reason: 'gone' });
    else if (item.unit !== 'count') skip.push({ id, name, reason: 'not-counted' });
    else if (hasWeightOfOne(item)) skip.push({ id, name, reason: 'already-set' });
    else if (!isWeight(gramsPerItem)) skip.push({ id, name, reason: 'no-proposal' });
    else write.push({ id, name, gramsPerItem });
  }
  return { write, skip };
}
