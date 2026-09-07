import type { StageTemperature } from '../schemas/process.js';

/**
 * A stage temperature in words — `"240 °C"` or `"22–26 °C"` (issue #1281).
 *
 * ONE spelling, because four surfaces render this figure — the formula screen, the
 * batch detail screen, the schedule-proposal review, and the prompt the proposal
 * flow is given — and a range that reads as a range in three of them and a
 * midpoint in the fourth is exactly the drift the discriminated union exists to
 * prevent.
 *
 * PRESENTATION ONLY. It never averages, never picks an end, and no caller may
 * turn the result back into a number: a temperature is a fact on the record and an
 * input to an AI proposal, never an operand (see the epic's "what not to build").
 */
export function stageTemperatureText(temperature: StageTemperature): string {
  return temperature.kind === 'fixed'
    ? `${temperature.celsius} °C`
    : `${temperature.minCelsius}–${temperature.maxCelsius} °C`;
}
