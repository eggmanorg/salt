import type { StageTemperature } from '../schemas/process.js';
import type { EquipmentEnvironmentDoc } from '../schemas/equipmentManifest.js';

/**
 * Can this place hold what the stage is asking for? (issue #1286)
 *
 * A COMPARISON OVER TWO INTERVALS, and deliberately nothing more. It returns a
 * boolean that puts a note on the bake sheet while the place can still be changed;
 * it never changes a duration, a temperature or a decision, and no caller may turn
 * it into one. The epic bans temperature-to-duration arithmetic outright
 * (docs/formulas-schedules-batches.md, "what not to build"), and this is the one
 * piece of degree-handling that is allowed precisely because it produces a sentence
 * rather than a number.
 *
 * PURE (CLAUDE.md rule 1): no clock, no I/O, no Firebase.
 *
 * ─── CONTAINMENT, NOT OVERLAP — the claim and its boundary ───────────────────────
 *
 * A stage asking 22–26 °C is reachable only by a place that covers the WHOLE span.
 * A chamber running 24–30 °C, which could hold 24, 25 and 26 but not 22 or 23, is
 * reported as not reaching it. That is the stricter of the two readings and it is
 * the right one here for one reason: the answer is information, never a gate. Start
 * works either way, so the cost of saying "this only covers part of what the recipe
 * asked for" is a sentence, while the cost of staying quiet is a prove that sat too
 * warm. `tests/process/placeReachability.test.ts` pins both directions.
 *
 * Bounds are INCLUSIVE at both ends, and a place whose min and max were typed the
 * wrong way round is read at its widest rather than refused — the manifest carries
 * no refine that would fail a whole equipment list over one transposed pair (see
 * `equipmentManifest.ts`).
 */
export function placeReachesTemperature(
  place: Pick<EquipmentEnvironmentDoc, 'minCelsius' | 'maxCelsius'>,
  temperature: StageTemperature,
): boolean {
  const low = Math.min(place.minCelsius, place.maxCelsius);
  const high = Math.max(place.minCelsius, place.maxCelsius);
  if (temperature.kind === 'fixed') {
    return temperature.celsius >= low && temperature.celsius <= high;
  }
  const askedLow = Math.min(temperature.minCelsius, temperature.maxCelsius);
  const askedHigh = Math.max(temperature.minCelsius, temperature.maxCelsius);
  return askedLow >= low && askedHigh <= high;
}
