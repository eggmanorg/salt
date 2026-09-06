import type { TemperatureBand } from '@salt/domain';

/**
 * The evening-window temperature ramp, cool blues → warm reds (issue #993).
 *
 * Group C, and the reason there is one: here the hue IS the datum. A reader
 * takes "cold" off the blue before they read the number, so no semantic role can
 * express it — `text-primary` would say "this is the app's accent", which is not
 * what a temperature is. `scripts/lib/rawPalette.mjs` allowlists exactly these
 * six tokens, in this file, with that reason.
 *
 * It lives in `routes/mealplan/` rather than `@salt/ui-components` because it is
 * keyed by a domain type: the layer map lets `ui-components` import nothing from
 * `@salt/*`, so a shared map there could not name `TemperatureBand` and would
 * have to take a string. That is the decision the issue left open, settled by
 * the constraint rather than by taste.
 *
 * Both call sites — `WeatherSummary` and `MealDayEditor`'s header — had written
 * it out byte-identically, the second admitting in a comment that it "mirrors
 * WeatherSummary". Two copies of one decision is one copy too many for the
 * allowlist above, which would otherwise need two entries for one colour call.
 */
export const BAND_CLASS: Record<TemperatureBand, string> = {
  freezing: 'text-sky-600',
  cold: 'text-sky-500',
  cool: 'text-cyan-600',
  mild: 'text-emerald-600',
  warm: 'text-orange-500',
  hot: 'text-red-600',
};
