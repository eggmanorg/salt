/**
 * Source guard: nothing re-declares a rule that crosses the client/server seam
 * (issue #1054).
 *
 * Five rules were spelled out twice — once in `apps/web-pwa/src`, once in
 * `apps/cloud-functions/src` — under comments asking a human to keep the two
 * halves in agreement: the shop-day headline, tag normalisation, the
 * icon-regeneration field set, the `"hidden"` icon sentinel and the PostHog
 * bread flag key. One of them had already drifted into a defect a user could
 * hit. None of the copies failed a test, because both spellings are
 * correct-looking and neither throws.
 *
 * The two apps CANNOT import each other (CLAUDE.md Rule 6), so neither the
 * compiler nor either app's own suite can see a pair. That is what makes this
 * seam different from the one `sharedHelperGuard.test.ts` polices inside
 * `web-pwa`, and why one guard walks BOTH trees rather than two guards each
 * walking half: a rule re-declared in `web-pwa` is only a defect relative to
 * what `cloud-functions` does, and vice versa.
 *
 * Reading files is not importing them, so Rule 6 is untouched.
 *
 * ── How it avoids going vacuously green (docs/unit-test-spec.md §E) ──────────
 *
 *  - The guarded names and VALUES are read out of the packages that own them,
 *    through their public barrels, not restated here (UT-E1). Rename
 *    `normaliseTags`, change the sentinel, or change the flag key, and the guard
 *    moves with it — or fails loudly if the export disappears entirely.
 *  - The two shop-day phrases are obtained by CALLING the shared rule, so they
 *    cannot be a stale copy of what it renders.
 *  - The scan surface is the whole of both `src` trees, walked (UT-E1). A new
 *    page or a new callable is covered on the day it is written.
 *  - Every matcher is exercised against a synthetic copy it must catch AND a
 *    near-miss it must not, so a regex broken by a later edit fails here rather
 *    than passing everything (UT-E2).
 *  - It asserts on identifiers, imports and value shapes — never on the wording
 *    of a comment and never on a line number (UT-E3). This issue rewrote most of
 *    the comments involved.
 *
 * ── The honest boundary ──────────────────────────────────────────────────────
 *
 * Two things here are STATED rather than derived, and both are real limits:
 *
 *  1. WHICH five rules are shared is a design decision, not something readable
 *     off the tree — the same reason `sharedHelperGuard.test.ts` hand-keeps its
 *     OWNERS list. What is derived is everything about each one.
 *  2. The tag-normalisation shape (`.replace(/\s+/g, '-')`) is written out,
 *     because a function's transpiled body is not a stable thing to pattern-match
 *     against. It is pinned by the self-tests below instead.
 *
 * ── What the guard deliberately does NOT police ──────────────────────────────
 *
 * `apps/web-pwa/public/push-sw.js`. It is a classic worker script
 * `importScripts`'d into the Workbox-generated service worker: no module system,
 * no bundler and no import path to `@salt/domain`, so its copy of the shop-day
 * phrase is genuinely forced and cannot be removed. It falls outside the walk
 * because the walk covers `src` only — that exclusion is load-bearing, not
 * incidental. The copy is held instead by a parity assertion in
 * `apps/web-pwa/tests/pushSw.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import * as domain from '@salt/domain';
import * as observability from '@salt/observability/server';

const testsDir = dirname(fileURLToPath(import.meta.url));

/** The two trees, and the name each is reported under. */
const ROOTS: readonly { readonly app: string; readonly dir: string }[] = [
  { app: 'cloud-functions', dir: join(testsDir, '../src') },
  { app: 'web-pwa', dir: join(testsDir, '../../web-pwa/src') },
];

/** Every source file under a tree, found by walking — never by a hand-kept list. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!entry.isFile()) return [];
    return entry.name.endsWith('.ts') || entry.name.endsWith('.svelte') ? [full] : [];
  });
}

// The three comment forms a `.ts` or `.svelte` file can carry, each as its opener
// and what closes it. A line comment closes at the newline, which is kept.
const COMMENTS: readonly (readonly [open: string, close: string])[] = [
  ['<!--', '-->'],
  ['/*', '*/'],
  ['//', '\n'],
];

/**
 * Strip comments so a MENTION of a rule in prose never counts as a copy of it.
 *
 * That matters especially here: every one of the five moves left a comment behind
 * naming the rule it now delegates to, and several quote the old spelling to
 * explain what changed. Left in, those would be read as the drift they document.
 *
 * Scanned once, left to right, taking whichever opener appears FIRST — the same
 * approach `sharedHelperGuard.test.ts` takes, and for the same reason: a
 * replace-pass per form has to pick an order, and whichever it picks the other
 * form's opener can sit inside it.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const found = COMMENTS.find(([open]) => src.startsWith(open, i));
    if (found === undefined) {
      out += src[i];
      i += 1;
      continue;
    }
    const [open, close] = found;
    const end = src.indexOf(close, i + open.length);
    i = end === -1 ? src.length : end + close.length;
    out += close === '\n' ? '\n' : ' ';
  }
  return out;
}

interface Scanned {
  readonly app: string;
  /** `<app>/<path under src>` — what a failure names. */
  readonly path: string;
  readonly code: string;
}

const files: Scanned[] = ROOTS.flatMap(({ app, dir }) =>
  walk(dir).map((full) => ({
    app,
    path: `${app}/${relative(dir, full).split(sep).join('/')}`,
    code: stripComments(readFileSync(full, 'utf8')),
  })),
);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ─── Half one: the rule copied by NAME ────────────────────────────────────────

/**
 * The five shared rules and where each now lives.
 *
 * `owner` is the package barrel a file must import the name from. `exists` is
 * read off that barrel's real namespace below, so a rename or a deletion in the
 * owning package fails this suite instead of leaving it guarding a ghost.
 */
const GUARDED: readonly { readonly name: string; readonly owner: string; readonly rule: string }[] =
  [
    { name: 'shopDayHeadline', owner: '@salt/domain', rule: 'the shop-day headline' },
    { name: 'normaliseTags', owner: '@salt/domain', rule: 'tag normalisation' },
    {
      name: 'iconRegenerationFields',
      owner: '@salt/domain',
      rule: 'the icon-regeneration write shape',
    },
    { name: 'CANON_ICON_HIDDEN', owner: '@salt/domain', rule: 'the hidden-icon sentinel' },
    {
      name: 'BREAD_FLAG_KEY',
      owner: '@salt/observability',
      rule: 'the PostHog bread flag key',
    },
    {
      name: 'LIBRARY_FLAG_KEY',
      owner: '@salt/observability',
      rule: 'the PostHog library flag key',
    },
  ];

const barrels: Record<string, Record<string, unknown>> = {
  '@salt/domain': domain as unknown as Record<string, unknown>,
  '@salt/observability': observability as unknown as Record<string, unknown>,
};

/** A local binding of that name — the drift this guard exists to catch. */
function redeclares(code: string, name: string): boolean {
  return new RegExp(String.raw`\b(?:const|let|var|function|class|enum)\s+${name}\b`).test(code);
}

const references = (code: string, name: string): boolean =>
  new RegExp(String.raw`\b${name}\b`).test(code);

// ─── Half two: the rule copied by VALUE ───────────────────────────────────────

interface Shape {
  readonly rule: string;
  /** What a reader should write instead. */
  readonly instead: string;
  /** Why this shape is drift and not merely similar-looking. */
  readonly because: string;
  /**
   * Every pattern must match for a file to offend. More than one is how a shape
   * that is innocuous alone (`thumbnail: null`) becomes a copy of a rule when it
   * appears beside another part of the same rule.
   */
  readonly patterns: readonly RegExp[];
  /** Files allowed to carry it, and why. `<app>/<path>`. */
  readonly allowed?: readonly string[];
}

// Derived, never restated: the two relative phrasings come from CALLING the
// shared rule, and the two sentinel values are the exported consts themselves.
const HEADLINE_TODAY = domain.shopDayHeadline({ days: 0, date: '2026-01-01' });
const HEADLINE_TOMORROW = domain.shopDayHeadline({ days: 1, date: '2026-01-01' });

const FORBIDDEN: readonly Shape[] = [
  {
    rule: 'the shop-day headline',
    instead: 'shopDayHeadline({ days, date, slot }) from @salt/domain',
    because:
      'the shopping list and the daily push reminder are different apps rendering one sentence; the only forced copy is push-sw.js, which is outside src and held by a parity test',
    patterns: [new RegExp(`${escapeRe(HEADLINE_TODAY)}|${escapeRe(HEADLINE_TOMORROW)}`)],
  },
  {
    rule: 'tag normalisation',
    instead: 'normaliseTags(tags) from @salt/domain',
    because:
      'the editor kebab-cased whitespace without splitting on commas while the flows did both, so `vegetarian, quick` typed into a recipe became the single tag `vegetarian,-quick`',
    // Written out rather than derived: a transpiled function body is not a stable
    // thing to match against. Pinned by the self-tests below instead.
    patterns: [/\.replace\(\s*\/\\s\+\/g\s*,\s*['"]-['"]\s*\)/],
  },
  {
    rule: 'the icon-regeneration write shape',
    instead: 'iconRegenerationFields(Date.now(), hint) from @salt/domain',
    because:
      'clearing the thumbnail beside a fresh nonce IS the regeneration request; a second hand-built copy is a second place to get the nonce — or the hint delete — wrong',
    // Either half alone is ordinary. Together they are the rule.
    patterns: [/thumbnail:\s*null/, /\biconRequestedAt\b/],
  },
  {
    rule: 'the hidden-icon sentinel',
    instead: 'CANON_ICON_HIDDEN from @salt/domain',
    because:
      'four icon families across both apps read this one string; respell it on one side and icons stop hiding there while they keep working everywhere else',
    patterns: [
      new RegExp(
        String.raw`\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=\n]*)?=\s*['"]${escapeRe(domain.CANON_ICON_HIDDEN)}['"]`,
      ),
    ],
  },
  {
    rule: 'the PostHog bread flag key',
    instead: 'BREAD_FLAG_KEY from @salt/observability (or /server)',
    because:
      'the browser half and the server half of the gate must ask PostHog about the same flag; a missed rename reads as "off" and looks exactly like a working gate',
    patterns: [
      new RegExp(
        String.raw`\b(?:isServerFeatureEnabled|isObservabilityFeatureEnabled)\s*\(\s*['"]`,
      ),
    ],
  },
];

const carries = (code: string, shape: Shape): boolean => shape.patterns.every((p) => p.test(code));

// ─────────────────────────────────────────────────────────────────────────────

describe('seam rules are declared once, across both apps', () => {
  it('can still see both source trees', () => {
    // Not an inventory — an anchor. A walk that collapsed to one app, or lost a
    // file extension, fails here instead of going quietly green.
    for (const { app } of ROOTS) {
      expect(files.filter((f) => f.app === app).length, `${app}: nothing walked`).toBeGreaterThan(
        50,
      );
    }
    const names = files.map((f) => f.path.split('/').pop());
    // One anchor per app, and a `.svelte` file, since only web-pwa has those.
    expect(names).toContain('onBatchWritten.ts');
    expect(names).toContain('requestIconRegeneration.ts');
    expect(names).toContain('featureGate.ts');
    expect(names).toContain('ShoppingListPage.svelte');
  });

  it('does not walk into web-pwa/public, where the one forced copy lives', () => {
    // `push-sw.js` cannot import anything, so its copy of the phrase is real and
    // permanent. If the walk ever reached it this guard would fail on a copy that
    // is not a defect — and `pushSw.test.ts`'s parity assertion, not this file,
    // is what holds it.
    expect(files.map((f) => f.path).filter((p) => p.includes('public/'))).toEqual([]);
    expect(files.map((f) => f.path).filter((p) => p.endsWith('.js'))).toEqual([]);
  });

  it('reads every guarded name off the barrel that owns it', () => {
    // The anti-vacuity anchor for the NAME half: if a rule is renamed or dropped
    // from its package, this fails rather than the guard silently policing a name
    // nothing declares any more.
    for (const { name, owner } of GUARDED) {
      expect(Object.keys(barrels[owner]!), `${owner} no longer exports ${name}`).toContain(name);
    }
  });

  it('derives the shop-day phrases by calling the shared rule', () => {
    // If `shopDayHeadline` ever stopped rendering these words, the shape above
    // would quietly police the wrong string.
    expect(HEADLINE_TODAY).toBe('Shopping today');
    expect(HEADLINE_TOMORROW).toBe('Shopping tomorrow');
    expect(HEADLINE_TODAY).not.toBe(HEADLINE_TOMORROW);
  });

  it('recognises a re-declaration when it sees one', () => {
    // The exact shapes this issue deleted, as strings — so a regex broken by a
    // future edit fails on these rather than on nothing at all.
    expect(redeclares("  const ICON_HIDDEN = 'hidden';", 'ICON_HIDDEN')).toBe(true);
    expect(redeclares("  const BREAD_FLAG = 'bread';", 'BREAD_FLAG')).toBe(true);
    expect(redeclares('  function normaliseTags(tags) { return []; }', 'normaliseTags')).toBe(true);

    // And what it must NOT see, or the whole walk becomes noise: a call, an
    // import, and a longer name this one is merely a prefix of.
    expect(redeclares('  const tags = normaliseTags([raw]);', 'normaliseTags')).toBe(false);
    expect(redeclares("  import { normaliseTags } from '@salt/domain';", 'normaliseTags')).toBe(false); // prettier-ignore
    expect(redeclares('  const normaliseTagsForDisplay = (t) => t;', 'normaliseTags')).toBe(false);
  });

  it('recognises an inlined rule when it sees one', () => {
    const shape = (rule: string): Shape => {
      const found = FORBIDDEN.find((s) => s.rule === rule);
      if (found === undefined) throw new Error(`no forbidden shape for ${rule}`);
      return found;
    };

    // Each of these is a real line this issue deleted from one of the two trees.
    expect(carries('  return `Shopping tomorrow ${slot.toUpperCase()}`;', shape('the shop-day headline'))).toBe(true); // prettier-ignore
    expect(carries('  if (shopDays === 0) return `Shopping today ${slot}`;', shape('the shop-day headline'))).toBe(true); // prettier-ignore
    expect(carries("  return raw.toLowerCase().trim().replace(/\\s+/g, '-');", shape('tag normalisation'))).toBe(true); // prettier-ignore
    expect(carries('  await ref.update({ thumbnail: null, iconRequestedAt: Date.now() });', shape('the icon-regeneration write shape'))).toBe(true); // prettier-ignore
    expect(carries("  const ICON_HIDDEN = 'hidden';", shape('the hidden-icon sentinel'))).toBe(
      true,
    );
    expect(carries("  await isServerFeatureEnabled('bread', uid, { email });", shape('the PostHog bread flag key'))).toBe(true); // prettier-ignore

    // And the near-misses each must NOT fire on. Every one of these is a real
    // line standing in one of the two trees today.
    expect(carries('  shopDayHeadline({ days: 1, date, slot })', shape('the shop-day headline'))).toBe(false); // prettier-ignore
    expect(carries("  title: 'Shopping list updated',", shape('the shop-day headline'))).toBe(
      false,
    );
    expect(carries("  const key = label.toLowerCase().replace(/\\s+/g, ' ');", shape('tag normalisation'))).toBe(false); // prettier-ignore
    expect(carries('  normaliseTags([raw])', shape('tag normalisation'))).toBe(false);
    // A create that clears the thumbnail and nothing else is not a regeneration.
    expect(carries('  ...(existing.exists ? {} : { thumbnail: null }),', shape('the icon-regeneration write shape'))).toBe(false); // prettier-ignore
    // And a nonce read, with no thumbnail clear, is just a cache-buster.
    expect(carries('  const bust = icon.iconRequestedAt ?? icon.updatedAt;', shape('the icon-regeneration write shape'))).toBe(false); // prettier-ignore
    expect(carries("  if (document.visibilityState === 'hidden') flush();", shape('the hidden-icon sentinel'))).toBe(false); // prettier-ignore
    expect(carries("  thumbnail: CANON_ICON_HIDDEN,", shape('the hidden-icon sentinel'))).toBe(false); // prettier-ignore
    expect(carries("  export type FeatureKey = 'bread';", shape('the PostHog bread flag key'))).toBe(false); // prettier-ignore
    expect(carries('  isObservabilityFeatureEnabled(FLAG_KEY[feature])', shape('the PostHog bread flag key'))).toBe(false); // prettier-ignore
  });

  it('has no file in either app re-declaring one of the shared names', () => {
    const offenders = files.flatMap((file) =>
      GUARDED.filter(({ name }) => redeclares(file.code, name)).map(
        ({ name, owner, rule }) => `${file.path}: ${name} (${rule}) — import it from ${owner}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('has no file in either app writing one of the rules out by hand', () => {
    const offenders = files.flatMap((file) =>
      FORBIDDEN.filter(
        (shape) => !(shape.allowed ?? []).includes(file.path) && carries(file.code, shape),
      ).map((shape) => `${file.path}: use ${shape.instead} — ${shape.because}`),
    );
    expect(offenders).toEqual([]);
  });

  it('has every file that uses one importing it from the package that owns it', () => {
    const consumers = files.filter((file) =>
      GUARDED.some(({ name }) => references(file.code, name)),
    );
    // Both apps must actually consume something, or the scan is measuring nothing
    // — and a rule used on only one side of the seam is not a seam rule.
    for (const { app } of ROOTS) {
      expect(consumers.filter((f) => f.app === app).length, `${app}: no consumer`).toBeGreaterThan(
        0,
      );
    }

    const unsourced = consumers.flatMap((file) => {
      const imported = [...file.code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*['"]/g)]
        .map((m) => m[1] ?? '')
        .join(',');
      return GUARDED.filter(
        ({ name }) => references(file.code, name) && !references(imported, name),
      ).map(({ name, owner, rule }) => `${file.path}: ${name} (${rule}) — import it from ${owner}`);
    });
    expect(unsourced).toEqual([]);
  });
});
