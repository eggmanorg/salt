/**
 * Source guard: which surfaces draw `salt-*` blocks (issue #1663).
 *
 * `Markdown`'s `blocks` prop is what turns a ` ```salt-cards ` fence into cards.
 * The claim is that ONLY the three library surfaces pass it — the page body, the
 * history preview and the paste-in preview — so a block the chef quotes in chat,
 * or one typed into a recipe note, stays an ordinary code block. That is a
 * decision about where a page's layout appears, and it is pinned here rather
 * than stated in prose.
 *
 * Bounded the same way `sanitizedHtmlCallers.test.ts` is: it sees a `blocks`
 * attribute on a `<Markdown>` element in a `.svelte` template under `src`, and
 * nothing that reaches the same result another way.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { parse } from 'svelte/compiler';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(full);
    return entry.isFile() && entry.name.endsWith('.svelte') ? [full] : [];
  });
}

function passesBlocks(source: string): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const record = node as Record<string, unknown>;
    if (record.type === 'Component' && record.name === 'Markdown') {
      const attributes = (record.attributes ?? []) as { type?: string; name?: string }[];
      if (attributes.some((a) => a.type === 'Attribute' && a.name === 'blocks')) {
        found = true;
        return;
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key !== 'parent') visit(value);
    }
  };
  visit(parse(source, { modern: true }).fragment);
  return found;
}

describe('Markdown blocks callers', () => {
  it('only the three library surfaces draw salt-* blocks', () => {
    const files = walkFiles(srcDir);
    // The walk is live: it found the app, not an empty directory.
    expect(files.length).toBeGreaterThan(50);
    const callers = files
      .filter((file) => passesBlocks(readFileSync(file, 'utf8')))
      .map((file) => relative(srcDir, file).split(sep).join('/'))
      .sort();
    expect(callers).toEqual([
      'routes/library/LibraryHistorySheet.svelte',
      'routes/library/LibraryImportSheet.svelte',
      'routes/library/LibraryPageDocument.svelte',
    ]);
  });
});
