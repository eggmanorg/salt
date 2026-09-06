// The pure half of scripts/migrate-stage-temperature.mjs (issue #1281): lifting a
// stage's bare `{ celsius: n }` environment to the discriminated
// `{ temperature: { kind: 'fixed', celsius: n } }` the narrowed schema requires.
//
// Separated from the runner so the transform is unit-testable without a project,
// a token or a network — the same split scripts/lib/ already uses for the
// backfills. Everything here operates on the RAW Firestore REST value tree and
// mutates it in place, for the reason fix-recipe-range-timers.mjs states at
// length: a decode/re-encode round trip would have to guess `integerValue` vs
// `doubleValue` for every number and would rewrite fields nobody asked it to.
//
// SAFE TO RE-RUN. A stage already carrying `temperature` is left untouched, so a
// second pass reports nothing to do and writes nothing.

/**
 * Lifts one stage's `environment` map in place.
 *
 * Returns 'migrated', 'already' (it has a `temperature` already), 'none' (no
 * environment at all — a mix), or 'unreadable' (an environment with neither, which
 * is left exactly as it is and reported rather than guessed at).
 */
export function migrateStageNode(stageNode) {
  const fields = stageNode?.mapValue?.fields;
  if (!fields) return 'none';
  const env = fields.environment?.mapValue?.fields;
  // A null environment arrives as `{ nullValue: 'NULL_VALUE' }` — no mapValue.
  if (!env) return 'none';
  if (env.temperature !== undefined) return 'already';
  const celsius = env.celsius;
  if (celsius === undefined) return 'unreadable';

  env.temperature = {
    mapValue: {
      fields: {
        kind: { stringValue: 'fixed' },
        // The stored number node is MOVED, not copied through a JS number, so an
        // `integerValue` stays an `integerValue` and a `doubleValue` a double.
        celsius,
      },
    },
  };
  delete env.celsius;
  // `equipmentId` has a schema default and needs no write; setting it explicitly
  // is what makes a migrated document identical to a freshly written one, which
  // is worth more than the two bytes it costs.
  if (env.equipmentId === undefined) env.equipmentId = { nullValue: 'NULL_VALUE' };
  return 'migrated';
}

/**
 * Lifts every stage in one raw `arrayValue` node, in place.
 * Returns the per-stage outcomes, in order.
 */
export function migrateStagesNode(stagesNode) {
  const stages = stagesNode?.arrayValue?.values ?? [];
  return stages.map((stage) => migrateStageNode(stage));
}

/** True when a set of outcomes means the document needs writing back. */
export function needsWrite(outcomes) {
  return outcomes.includes('migrated');
}
