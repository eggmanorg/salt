/**
 * Source guard for "one focus ring, defined once" (issue #1305,
 * ui-spec-v02 §4.2, CLAUDE.md rule 7 and rule 12).
 *
 * The focus indicator is a design-system concern. `@salt/ui-components` owns
 * it in exactly four declarations (`salt.css`: the base `:focus-visible` rule
 * plus `salt-focus-ring`, `-within` and `-inset`), and a page inherits it by
 * writing nothing at all.
 *
 * What went wrong without this test: the shipped base rule used the BORDER
 * token with no gap, which on a bordered control is invisible — the outline
 * and the border are the same grey, because `--salt-input` duplicates
 * `--salt-border`. Fifteen surfaces independently noticed and hand-wrote the
 * spec-correct teal ring instead, most of them switching the wrong default off
 * with `outline-none` first. Two focus treatments then shipped side by side for
 * months, and the app disagreed with its own Storybook canvas, because nothing
 * mechanical objected. This is that objection.
 *
 * It reads `apps/web-pwa/src` off disk rather than asserting on rendered
 * output: the failure mode is a class NAME appearing in markup, and jsdom
 * computes nothing from a Tailwind class anyway.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '../src');

/** Every `.svelte` and `.ts` under `src`, recursively — a hand-listed set of
 *  directories is the same defect one level up. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(svelte|ts)$/.test(entry) ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

/**
 * `outline-none` is legal in exactly two shapes, both of which SUPPRESS a ring
 * that something else is already drawing — never to make room for a hand-rolled
 * replacement:
 *
 *  - the raw `<input>`/`<textarea>` inside a frame, because the FRAME carries
 *    `salt-focus-ring-within` and owns the ring for the pair (ui-spec-v02 §8.2:
 *    "Do not attach focus ring to the `<input>` directly");
 *  - the full-viewport cook containers, which are programmatic focus targets
 *    (`tabindex="-1"`) taking focus as a handoff — there is nothing there for a
 *    ring to point at.
 */
const OUTLINE_NONE_ALLOWED = new Set([
  'routes/chat/ChatThread.svelte',
  'routes/recipes/RecipeEditPage.svelte',
  // The tag box (issue #1324): a bare `<input>` sharing a frame with the tag
  // chips, and that frame carries `salt-focus-ring-within`. Same shape as the
  // retired editor's, which is the entry above.
  'routes/recipes/RecipeIdentityCard.svelte',
  'routes/recipes/CookModePage.svelte',
  'routes/recipes/GuidedCookPage.svelte',
  // The THIRD full-viewport container (issue #1327) — cooking a batch. Same shape
  // as the two above it: `tabindex="-1"` on the page root, focused on mount as a
  // handoff (ui-spec-v05 §2.4), with nothing there for a ring to point at.
  'routes/batches/BatchCookPage.svelte',
]);

describe('focus ring source guard', () => {
  it('no page hand-writes a focus ring — the design system owns it', () => {
    const offenders = files
      .filter(({ text }) => /focus-(visible|within):ring-/.test(text))
      .map(({ path }) => path);

    expect(
      offenders,
      'Use the inherited ring (write nothing), or `salt-focus-ring-within` on a ' +
        'frame / `salt-focus-ring-inset` on a target that fills its container. ' +
        'See ui-spec-v02 §4.2.',
    ).toEqual([]);
  });

  it('no page suppresses the ring except where the frame or a handoff owns it', () => {
    const offenders = files
      .filter(({ text }) => /\boutline-none\b/.test(text))
      .map(({ path }) => path)
      .filter((path) => !OUTLINE_NONE_ALLOWED.has(path));

    expect(
      offenders,
      'An `outline-none` with nothing drawing a ring in its place leaves a ' +
        'control with no visible focus at all (WCAG 2.4.7).',
    ).toEqual([]);
  });

  it('no page reaches for the ring COLOUR token directly', () => {
    // `ring-ring` on a focus state is the hand-written copy this issue removed.
    // `ring-2 ring-ring` as a SELECTION treatment (EditableRow, the shopping
    // row shell) is a different thing and lives in ui-components, not here.
    const offenders = files
      .filter(({ text }) => /focus[^"'`]*\bring-ring\b/.test(text))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});
