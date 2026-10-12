/**
 * CLAUDE.md → _Data model conventions_ says exactly two client writes are field
 * transforms rather than whole-document writes: `recordCanonPurchases`'s counts
 * and the freezer's take-a-pack `increment` (issue #1684). Every client write
 * reaches Firestore through this package (Rule 2), so the claim is checkable
 * here: this test reads the source and goes red when a third file imports a
 * transform sentinel. Adding one is a decision — update CLAUDE.md and
 * docs/data-model.md with it, then this list.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');
const SENTINELS = ['increment', 'arrayUnion', 'arrayRemove', 'deleteField', 'serverTimestamp'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

/** The sentinels a file imports from `firebase/firestore`. */
function transformsImported(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'firebase\/firestore'/g)];
  const names = imports.flatMap((m) =>
    m[1]!.split(',').map((n) => n.trim().replace(/^type\s+/, '')),
  );
  return SENTINELS.filter((s) => names.includes(s));
}

describe('field transforms', () => {
  it('are imported by exactly the two sanctioned writers', () => {
    const users = sourceFiles(SRC)
      .filter((f) => transformsImported(f).length > 0)
      .map((f) => f.slice(SRC.length + 1))
      .sort();

    expect(users).toEqual(['canonPurchaseSync.ts', 'freezerItemSync.ts']);
  });

  it('notices a sentinel among other imports', () => {
    expect(SENTINELS.length).toBeGreaterThan(0);
    expect(transformsImported(join(SRC, 'freezerItemSync.ts'))).toEqual(['increment']);
  });
});
