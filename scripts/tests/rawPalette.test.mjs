/**
 * The characterization suite for `scripts/lib/rawPalette.mjs` (issue #993).
 *
 * The guard itself cannot characterise its own matcher: it runs over a tree that
 * holds exactly nine sanctioned occurrences, so a matcher quietly narrowed to
 * nothing — or widened until it fired on `border-b-2` — would sit green there
 * either way. So the shapes are fed in directly, the way `schemaCatchSites` and
 * `unitTestSpec` do it. `CATCHES` are sources the scanner MUST find a token in;
 * `MISSES` are the near-misses it must not fire on at all.
 *
 * Every entry in `MISSES` contains a Tailwind utility that LOOKS colour-shaped.
 * That is the anti-vacuity floor: a "near-miss" with no hyphenated utility in it
 * proves nothing about a scan that matches hyphenated utilities.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWLIST, PALETTE, findOffLadderAlpha, findRawPalette } from '../lib/rawPalette.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** [name, source, the token the scan must report] */
const CATCHES = [
  ['a bare utility', `<div class="bg-amber-50 p-3">`, 'bg-amber-50'],
  ['a dark: variant', `<p class="dark:text-amber-300">`, 'text-amber-300'],
  ['a stacked variant', `class="dark:hover:bg-amber-950/40"`, 'bg-amber-950/40'],
  ['an opacity modifier', `<div class="bg-red-500/20">`, 'bg-red-500/20'],
  [
    'a class string in a .ts file',
    `const ARM = { a: 'border-amber-500 bg-card' };`,
    'border-amber-500',
  ],
  ['a template literal', '`font-medium ${x} text-sky-600`', 'text-sky-600'],
  ['the 950 step', `<div class="text-amber-950">`, 'text-amber-950'],
  ['a gradient stop', `class="from-black/85 via-violet-600 to-transparent"`, 'via-violet-600'],
  ['a ring colour', `class="ring-1 ring-emerald-600"`, 'ring-emerald-600'],
  // The one no class-name regex sees. `MinePage`'s dial ring was written this
  // way and a class-only scan called the file clean.
  ['a CSS custom-property reference', `soon: 'var(--color-amber-600)',`, 'var(--color-amber-600)'],
  // Variant forms that are not `[a-z-]+:` — the prefix group used to be that
  // narrow, so all of these returned no finding at all (#1268 review).
  ['a data-attribute variant', `class="data-[state=open]:bg-amber-500"`, 'bg-amber-500'],
  ['an aria variant', `class="aria-[current=page]:text-amber-600"`, 'text-amber-600'],
  ['a group/named-instance variant', `class="group-hover/card:bg-amber-200"`, 'bg-amber-200'],
  ['a container-query variant', `class="@md:bg-amber-300"`, 'bg-amber-300'],
  ['the universal-selector variant', `class="*:bg-amber-600"`, 'bg-amber-600'],
  ['an important marker', `class="!bg-amber-400"`, 'bg-amber-400'],
  ['a logical border-side utility', `class="border-s-amber-500"`, 'border-s-amber-500'],
];

/** Sources the scan must stay silent on. Each holds a hyphenated utility. */
const MISSES = [
  ['a semantic token', `<div class="bg-primary text-primary-foreground border-border">`],
  ['the #993 amber roles', `class="border-warning/40 bg-warning/10 text-warning-text"`],
  ['a review role with an alpha ground', `class="bg-review/20 text-review-text"`],
  // black/white are theme-invariant by necessity — a photo scrim's ink does not
  // flip with the theme because the photograph does not.
  ['a photo scrim', `class="bg-gradient-to-t from-black/85 via-black/55 to-black/20"`],
  ['scrim ink', `{@render mealLine('text-base', 'text-white/90', 'text-white/70')}`],
  // Non-colour utilities that share a prefix with a colour one.
  ['a border width', `<div class="border-b-2 border-t">`],
  ['a duration', `<div class="duration-1000 delay-200">`],
  ['a z-index and a grid span', `<div class="z-10 col-span-2 to-do-500">`],
  ['an arbitrary colour value', `<div class="bg-[#f59e0b]">`],
  // A step that is not on the scale. Tailwind would not generate it either.
  ['an off-scale step', `<div class="bg-amber-350 text-sky-1000">`],
];

describe('findRawPalette', () => {
  it.each(CATCHES)('catches %s', (_name, source, token) => {
    expect(findRawPalette(source).map((f) => f.token)).toContain(token);
  });

  it.each(MISSES)('stays silent on %s', (_name, source) => {
    expect(findRawPalette(source)).toEqual([]);
  });

  it('every MISSES entry holds a hyphenated utility (anti-vacuity)', () => {
    for (const [name, source] of MISSES) {
      expect(source, `${name} proves nothing`).toMatch(/\b[a-z]+-[a-z0-9[]/);
    }
  });

  it('reports the 1-based line a token sits on', () => {
    expect(findRawPalette('a\nb\n<div class="bg-amber-50">')).toEqual([
      { line: 3, token: 'bg-amber-50' },
    ]);
  });

  it('reports every occurrence on one line, not just the first', () => {
    const found = findRawPalette(`class="bg-amber-500 text-amber-950 border-amber-600"`);
    expect(found.map((f) => f.token)).toEqual([
      'bg-amber-500',
      'text-amber-950',
      'border-amber-600',
    ]);
  });
});

describe('the allowlist', () => {
  it('gives every entry a reason, and names tokens rather than blanketing a file', () => {
    for (const [rel, entry] of Object.entries(ALLOWLIST)) {
      expect(entry.reason, `${rel} has no reason`).toBeTruthy();
      expect(entry.reason.length, `${rel}'s reason is too short to be one`).toBeGreaterThan(60);
      expect(entry.tokens.length, `${rel} allowlists nothing`).toBeGreaterThan(0);
    }
  });

  it('allowlists only tokens the scan would actually have caught', () => {
    // Otherwise an entry could sanction a string the guard never fires on, and
    // the stale-entry half of the check would be the only thing to notice.
    for (const [rel, { tokens }] of Object.entries(ALLOWLIST)) {
      for (const token of tokens) {
        const shape = token.startsWith('var(') ? token : `class="${token}"`;
        expect(
          findRawPalette(shape).map((f) => f.token),
          `${rel} ${token}`,
        ).toContain(token);
      }
    }
  });

  it('matches what the two allowlisted files actually ship', () => {
    // The equality the CLI asserts, pinned here too so a drift shows as a unit
    // failure rather than only as a CI step nobody reads the output of.
    for (const [rel, { tokens }] of Object.entries(ALLOWLIST)) {
      const found = findRawPalette(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      expect(new Set(found.map((f) => f.token)), rel).toEqual(new Set(tokens));
    }
  });
});

describe('the palette list', () => {
  it("covers Tailwind v4's named scales and no theme-invariant literal", () => {
    expect(PALETTE).toContain('amber');
    expect(PALETTE).toContain('grey');
    expect(PALETTE).not.toContain('black');
    expect(PALETTE).not.toContain('white');
  });
});

describe('findOffLadderAlpha', () => {
  it('flags an amber-family alpha off the sanctioned ladder', () => {
    expect(findOffLadderAlpha('<span class="bg-review/30">')).toEqual([
      { line: 1, token: 'bg-review/30' },
    ]);
  });

  it('stays silent on the sanctioned ladder — /10, /20, /40, /100', () => {
    const source = `
      <div class="bg-review/10">
      <span class="bg-review/20 text-review-text">
      <div class="border-warning/40">
      <div class="bg-warning-text/100">
    `;
    expect(findOffLadderAlpha(source)).toEqual([]);
  });

  it('stays silent on a bare (opaque) role — no alpha to be off-ladder', () => {
    expect(findOffLadderAlpha('<span class="bg-review text-white">')).toEqual([]);
  });

  it('stays silent on a non-amber role at any alpha', () => {
    expect(findOffLadderAlpha('<div class="bg-primary/30 text-destructive/25">')).toEqual([]);
  });
});
