/**
 * Finds Tailwind DEFAULT-PALETTE colour values in `apps/web-pwa/src` (issue #993).
 *
 * The judgement half of the guard; `scripts/check-raw-palette.mjs` is the walk
 * and the report. Split so the matcher can be characterised directly, the way
 * `schemaCatchSites.mjs` is — a scan that only ever runs over the real tree can
 * be green because the tree is clean OR because the matcher stopped matching,
 * and those are not the same thing.
 *
 * ── What this exists for ──────────────────────────────────────────────────
 *
 * 130 raw amber occurrences accumulated across 27 files, spelling out a colour
 * vocabulary no token named. Nothing in the toolchain could see them: eslint
 * carries no Tailwind rules, `tokens.theme.test.ts` reads `salt.css` and never
 * app source, and dependency-cruiser is an import-graph tool. A class string is
 * invisible to all three, which is exactly why the count only ever went up.
 *
 * ── What it does NOT claim ────────────────────────────────────────────────
 *
 * This is a TEXT scan, so it sees a palette utility wherever it is written —
 * markup, a `.ts` class-string map, or a comment. It does not resolve anything:
 *
 *   • it matches the NUMBERED palette only (`bg-amber-500`, `text-sky-600`).
 *     `black` / `white` and their alpha forms (`from-black/85`, `text-white/70`)
 *     are deliberately out of scope — a photo scrim's ink is theme-invariant by
 *     necessity, and tokenising it would flip it with the theme when the
 *     photograph underneath does not.
 *   • it cannot see a colour arrived at some other way — an inline
 *     `style="color:…"`, an arbitrary value (`bg-[#f59e0b]`), or a hex in a CSS
 *     file. None has appeared here; if one does it is outside what this sees,
 *     and saying so is better than implying a completeness the scan lacks.
 *   • it scans `apps/web-pwa/src` only. `@salt/ui-components` still holds two
 *     raw-amber sites, deliberately out of #993's scope.
 */

/** Tailwind v4's numbered default palette. `black`/`white` are not on it. */
export const PALETTE = [
  'slate',
  'gray',
  'grey',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
];

/**
 * Every Tailwind utility prefix that takes a colour. Written out rather than
 * matched as `\w+-` so `border-b-2`, `duration-1000` and `gap-4` cannot match.
 */
const COLOUR_UTILITIES = [
  'text',
  'bg',
  'border',
  'border-[xytrbl]',
  'ring',
  'ring-offset',
  'outline',
  'divide',
  'from',
  'via',
  'to',
  'fill',
  'stroke',
  'shadow',
  'accent',
  'caret',
  'decoration',
  'placeholder',
];

/**
 * A step on the scale: 50, 100…900, 950. Ordered longest-first and closed with
 * a digit lookahead, or `500` matches the `50` arm and reports `bg-amber-50`
 * for a `bg-amber-500` that is really there — a wrong finding, and one an
 * allowlist would then be written against.
 */
const STEP = '(?:[1-9]00|950|50)(?![0-9])';

/**
 * A palette utility, with any variant prefix (`dark:`, `hover:`, `sm:`) and any
 * opacity suffix (`/20`). The capture is the utility WITHOUT its variants, so
 * `dark:hover:bg-amber-950/40` and `bg-amber-950/40` are the same finding — an
 * allowlist entry names a colour decision, not the states it is painted in.
 */
const RAW_PALETTE = new RegExp(
  `(?:^|[\\s"'\`{(\\[])(?:[a-z-]+:)*((?:${COLOUR_UTILITIES.join('|')})-(?:${PALETTE.join('|')})-${STEP}(?:\\/\\d+)?)`,
  'g',
);

/**
 * The other spelling, and the one no class-name regex sees:
 * `var(--color-amber-600)` fed into a CSS custom property. `MinePage`'s dial
 * ring was written this way, and a class-only scan reported it clean.
 */
const RAW_PALETTE_VAR = new RegExp(`(var\\(--color-(?:${PALETTE.join('|')})-${STEP}\\))`, 'g');

/**
 * Every raw-palette occurrence in one file's text.
 *
 * @param {string} text
 * @returns {{ line: number, token: string }[]} 1-based line numbers.
 */
export function findRawPalette(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    for (const re of [RAW_PALETTE, RAW_PALETTE_VAR]) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) found.push({ line: i + 1, token: m[1] });
    }
  });
  return found;
}

/**
 * The group-C exceptions: places where the hue IS the datum, or is deliberately
 * outside the theme so it cannot be mistaken for product chrome.
 *
 * Keyed by path, and each entry lists the exact tokens it sanctions. File
 * granularity alone would blanket the file — a new `bg-red-500` added beside the
 * banners would inherit the tick — and the whole finding is a thing accumulating
 * one line at a time under nobody's eye.
 *
 * The check asserts EQUALITY, not containment: an entry that no longer matches
 * anything reds too. A stale allowlist reads as coverage and provides none, and
 * that failure is silent in every direction except this one.
 */
export const ALLOWLIST = {
  'apps/web-pwa/src/lib/environment.ts': {
    reason:
      'Non-production TopBar banners. Deliberately OUTSIDE the theme so a dev or ' +
      'staging build cannot be mistaken for production — see the header comment at :11-13. ' +
      'A token here would flip with the theme, which is the opposite of what the banner is for.',
    tokens: [
      'bg-sky-600',
      'border-sky-700',
      'bg-violet-600',
      'border-violet-700',
      'bg-amber-500',
      'text-amber-950',
      'border-amber-600',
    ],
  },
  'apps/web-pwa/src/routes/mealplan/temperatureBandClass.ts': {
    reason:
      'The evening-window temperature ramp. The hue IS the datum — cool blues to ' +
      'warm reds is the reading, not decoration — so no semantic role can express it. ' +
      'One module since #993; it was written out twice, byte-identical.',
    tokens: [
      'text-sky-600',
      'text-sky-500',
      'text-cyan-600',
      'text-emerald-600',
      'text-orange-500',
      'text-red-600',
    ],
  },
};
