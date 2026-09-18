// What goes in at each stage (issue #1405, phase 04 of epic #778) — the one
// grouping of a list of ingredients over an ordered process.
//
// ONE FUNCTION, NOT THREE `filter`s. Three surfaces render this list — the formula
// screen's stage review, the batch detail page's stage list and the batch cook
// page's stage cards — and the interesting behaviour is not the grouping but the
// FALLBACK below, which three hand-rolled filters would each get subtly differently.
//
// GENERIC OVER THE ROW, exactly as `withStageAdded<T extends ProcessStage>` is
// generic over the stage, and for the same kind of reason: the formula screen holds
// `SolvedComponent`s and the batch pages hold frozen `BatchQuantity`s, which agree
// on `ingredientId` and `stageId` and on nothing else that matters here. The stages
// side needs only an `id`, so it is not parameterised at all.
//
// Pure and total (CLAUDE.md rule 1): no clock, no ids minted, nothing thrown, and
// the rows come back in the order they were given.

export type StageAdditions<T> = {
  /**
   * Everything that goes in at the start — `stageId: null`, AND anything whose
   * `stageId` no longer names a stage in the list given.
   */
  atStart: readonly T[];
  /**
   * What goes in at this stage, in the order the rows came in. EMPTY IS A REAL
   * ANSWER and the only one for a stage that takes nothing — which is every stage of
   * every loaf — so a caller never has to decide what a missing key means, and never
   * writes a `?? []` no test can reach. An id this grouping was not given is empty
   * too: it had nothing.
   */
  at: (stageId: string) => readonly T[];
};

const NOTHING: readonly never[] = [];

/**
 * Group rows by the process stage they are added at.
 *
 * AN UNRESOLVABLE `stageId` LANDS AT THE START, and that is the whole of why this is
 * a function rather than a comment. Deleting a stage on the formula screen does not
 * cascade into the components (`FormulaComponentSchema.stageId` states the limit), so
 * a dead id is an ordinary state rather than corruption — and the ingredient is still
 * in the formula, still scaled and still bought. Reading it as "at the start" is the
 * one answer that keeps it visible; dropping it would make a stage edit silently
 * rewrite the composition. `tests/process/stageAdditions.test.ts` is the pin.
 *
 * A row is placed exactly once: an ingredient is added at one moment, which is why
 * the assignment lives on the row rather than as a list on the stage.
 */
export function stageAdditions<T extends { ingredientId: string; stageId: string | null }>(
  stages: readonly { id: string }[],
  rows: readonly T[],
): StageAdditions<T> {
  const byStageId = new Map<string, T[]>(stages.map((stage) => [stage.id, []]));
  const atStart: T[] = [];

  for (const row of rows) {
    const bucket = row.stageId === null ? undefined : byStageId.get(row.stageId);
    if (bucket === undefined) atStart.push(row);
    else bucket.push(row);
  }

  return { atStart, at: (stageId) => byStageId.get(stageId) ?? NOTHING };
}
