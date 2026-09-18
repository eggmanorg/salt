/**
 * Where `.catch()` is allowed to live under `packages/domain/src/schemas/`
 * (issue #1114).
 *
 * `.catch()` is strictly stronger than `.default()`: it swallows an absent
 * field, a null, a wrong type and an unknown enum member alike, so the field it
 * guards cannot be rejected for any reason. On a schema that parses a stored
 * Firestore document that is not a convenience, it is the skip-and-log contract
 * switched off — #1114's whole subject. `ShoppingListItemSchema.matchState`
 * carried one, and the browser and `onShoppingListItemWrite` disagreed about
 * what state a document was in for as long as it did.
 *
 * ── Why this is an ALLOWLIST and not "returns nothing" ─────────────────────
 *
 * #1114's Definition of Done states the check as `grep -rn '\.catch(' …`
 * returning NOTHING, on the strength of that grep having returned exactly one
 * line when the issue was written. It no longer does:
 * `AuthoredRecipePhasesSchema` in `recipe.ts` grew a deliberate `.catch([])`
 * afterwards (#1122 review, blocking 3), it guards an AI OUTPUT rather than a
 * stored document, and `recipe.ts` was on #1114's must-not-touch list. The same
 * reasoning grew three more on the retired prep/cook/total time fields (#1233
 * review, blocking 1); issue #1211 then deleted those fields and the list fell
 * back to one — the fall the equality half below exists to make visible rather
 * than silent — before #1244 added `AuthoredRecipeKindSchema`. It stands at TWO,
 * and that count went stale for a release exactly because the sentence stating
 * it was not the thing being edited. Shipping the unqualified absolute anyway —
 * in a comment, a DoD tick or a test name — is precisely the defect class
 * CLAUDE.md Rule 12 exists for, so the claim is made with its real boundary
 * instead: the known instances, named here with their reasons, and any other one
 * reds. #1404 then added a THIRD, `AuthoredCureCategorySchema`, for the same
 * AI-output reason — which is exactly the movement the paragraph above predicts,
 * and the reason no number is asserted anywhere but in `ALLOWED` itself.
 *
 * ── Why entries name a SYMBOL, not a file (#1251) ──────────────────────────
 *
 * They used to name a file, and an exemption then blanketed everything in it.
 * `recipe.ts` is one file with nineteen exported schemas: `.catch([])` on
 * `AuthoredRecipePhasesSchema` is sanctioned above, and `RecipeMetadataSchema`,
 * `RecipeImageSchema`, `RecipeKitEntrySchema` and `RecipeSchema` — the stored
 * `recipes` document, holding real production data — sat under the same tick. A
 * `.catch()` added to any of them was #1114 happening again on the app's largest
 * collection, with this guard green. That was verified rather than argued:
 * `.catch(null)` on `RecipeSchema.notes` passed the file-keyed guard and reds
 * this one.
 *
 * A key is `file#Symbol`, or `file#Symbol.field` where the call sits on an object
 * property — nested properties join with dots, so `RecipeSchema.metadata.servings`
 * is one key. Field granularity is not decoration: #1114's own instance was
 * `ShoppingListItemSchema.matchState`, a property rather than a top-level const,
 * and `shoppingListItem.ts`'s comment at that field is the worked example of why.
 *
 * ── Why EQUALITY, not `<=` ─────────────────────────────────────────────────
 *
 * Both directions matter, the same argument `coverage.areas.mjs` and
 * `unit-test-spec.areas.mjs` make. Going UP is the rot this exists to stop: a
 * `.catch()` copied onto another Firestore document schema is #1114 happening
 * again on a different collection. Going DOWN without editing the list means
 * the guard has stopped guarding — if `recipe.ts`'s instance were removed or
 * merely reworded out of detection, an allowlist that only permits would sit
 * green over a matcher that matches nothing.
 *
 * ── Honest limits ──────────────────────────────────────────────────────────
 *
 * What symbol attribution does and does not see, stated rather than assumed:
 *
 * - It reads source, one file at a time, with no type information — never the
 *   schemas themselves, which `scripts/`'s own contract forbids importing.
 *   `scripts/lib/schemaCatchSites.mjs` parses each file with TypeScript's parser
 *   and carries the full list; the two that matter here are that a `.catch()`
 *   reached through a variable or applied by a helper is invisible, and that a
 *   file may DISCUSS `.catch()` freely because a comment cannot produce a call
 *   expression. Both `shoppingListItem.ts` and `recipe.ts` do discuss it.
 * - A symbol key names a DECLARATION, not a document. `RecipeSchema` is exempt or
 *   it is not; the guard has no way to know that `AuthoredRecipePhasesSchema`
 *   parses an AI output and `RecipeSchema` parses a stored document. That
 *   judgement lives in the reason strings below, and it is a human's.
 * - The name is the key, so RENAMING an exempt schema reds — correctly, since
 *   the reason was written for the old name. Rename the entry with it.
 * - It cannot see a `.catch()` composed onto an exempt symbol from elsewhere:
 *   `SomethingElse = AuthoredRecipePhasesSchema.catch([])` in another file is a
 *   new key in THAT file and reds, which is the safe direction; the same line
 *   inside a helper this scanner cannot follow is not seen at all.
 *
 * The scan is `packages/domain/src/schemas/`'s whole tree (`readdirSync` with
 * `recursive: true`) and nothing outside it, so it says nothing about the
 * app-local schemas CLAUDE.md's #932 narrowing permits.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findCatchSites } from '../lib/schemaCatchSites.mjs';
import { stripComments } from '../lib/unitTestSpec.mjs';

/**
 * The sanctioned instances: `file#Symbol` (or `file#Symbol.field`) → why it is
 * there. One entry exempts one declaration and nothing else in its file.
 */
const ALLOWED = new Map([
  ['recipe.ts#AuthoredRecipePhasesSchema', 'An AI output, not a stored document (#1122).'],
  [
    'extractRecipeFromUrl.ts#AuthoredRecipeKindSchema',
    'An AI output, not a stored document (#765). The floor that makes a bad ' +
      '`kind` degrade to `recipe` rather than fail an import; the librarian path ' +
      'has no retry, so a throw costs a whole conversation.',
  ],
  [
    'extractRecipeFromUrl.ts#AuthoredCureCategorySchema',
    'An AI output, not a stored document (#1404). Same bargain as the kind ' +
      'above, one step softer: an unknown or invented category degrades to ' +
      '`null` — uncategorised, which is a normal state — rather than failing an ' +
      'import over a field the person corrects on the recipe page in one tap.',
  ],
]);

const schemaDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'domain',
  'src',
  'schemas',
);

const files = readdirSync(schemaDir, { recursive: true }).filter((f) => f.endsWith('.ts'));
const sites = files.flatMap((f) => findCatchSites(readFileSync(join(schemaDir, f), 'utf8'), f));
const withCatch = [...new Set(sites.map((site) => site.file))];

/** How many call sites share each key — a key an `ALLOWED` `Map` cannot split. */
const keyCounts = sites.reduce((counts, site) => {
  counts.set(site.key, (counts.get(site.key) ?? 0) + 1);
  return counts;
}, new Map());

/** What a red run should tell a reader to do, per side of the mismatch. */
const verdict = () => {
  const lines = [
    ...sites
      .filter((site) => !ALLOWED.has(site.key))
      .map(
        (site) =>
          `  UNSANCTIONED  ${site.file}:${site.line} — ${site.symbol}` +
          `${site.field === null ? '' : `, field \`${site.field}\``}` +
          ` carries a .catch(). Remove it, or add "${site.key}" to ALLOWED with ` +
          'the reason this is not a stored Firestore document.',
      ),
    ...[...ALLOWED.keys()]
      .filter((key) => !sites.some((site) => site.key === key))
      .map(
        (key) =>
          `  GONE          ${key} is in ALLOWED but no call site matches it. ` +
          'Delete the entry (or rename it, if the symbol was renamed) — until you ' +
          'do, that line exempts nothing and hides that the guard stopped guarding it.',
      ),
    ...[...keyCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(
        ([key, count]) =>
          `  DUPLICATE     ${key} names ${count} .catch() call sites, not one. ` +
          'ALLOWED is a Map, so one entry can never exempt more than one of them — ' +
          'give each site a distinguishing field so its key is unique.',
      ),
  ];
  return lines.length === 0 ? '' : `\n.catch() allowlist mismatch:\n${lines.join('\n')}\n`;
};

describe('.catch() under packages/domain/src/schemas', () => {
  it('reads a real, non-empty set of schema files', () => {
    // Anti-vacuity: a guard over zero files passes for the wrong reason.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('shoppingListItem.ts');
    expect(files).toContain('recipe.ts');
  });

  it('finds exactly the sanctioned instances, and no others', () => {
    // Equality both ways — see the header. `verdict()` is empty on a pass and
    // carries the whole diagnosis on a fail, so a reader of a red run is told
    // which side moved and whether to fix the code or edit ALLOWED.
    //
    // Both sides SORTED: `sites` follows `readdirSync` order, which is
    // alphabetical on APFS and hash order on ext4 — so an order-sensitive compare
    // would pass on a Mac and fail in CI the moment this list held more than one
    // entry, which it has since #765.
    expect(sites.map((site) => site.key).sort(), verdict()).toEqual([...ALLOWED.keys()].sort());
  });

  it('has none on either shopping schema — the narrowing #1114 shipped', () => {
    expect(withCatch).not.toContain('shoppingListItem.ts');
    expect(withCatch).not.toContain('shoppingList.ts');
  });

  it('reds on every file the old text scan reds, or more — never fewer', () => {
    // Pins #1251's own Behavior Contract ("the guard must red on everything it
    // reds on today, plus strictly more") directly against the real tree,
    // rather than trusting the fixture suite alone. The retired guard was
    // `stripComments(...).includes('.catch(')` per file; any file it would have
    // flagged must still show up in `withCatch` — narrowing may only replace a
    // file-shaped exemption with a symbol-shaped one, never drop a file the
    // coarse scan caught.
    const oldScanFlagged = files.filter((f) =>
      stripComments(readFileSync(join(schemaDir, f), 'utf8')).includes('.catch('),
    );
    for (const f of oldScanFlagged) {
      expect(withCatch).toContain(f);
    }
  });
});
