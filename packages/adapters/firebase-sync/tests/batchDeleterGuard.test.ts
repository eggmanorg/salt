import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

/**
 * Tripwire for the one orphan shape the `batch-images/` sweep cannot reclaim
 * (issue #968, phase 2).
 *
 * Deleting a Firestore document does NOT delete its subcollection. So a
 * `deleteBatch` that removes only `batches/{batchId}` leaves every document in
 * `batches/{batchId}/observations/*` alive and unreachable — Firestore orphans
 * that nothing in this codebase sweeps. Phase 1 closed the STORAGE half of that
 * (a photo whose parent batch is gone is now swept), and it cannot close the
 * Firestore half from inside a Storage pass.
 *
 * Until phase 1 that gap was recorded the way it had always been recorded: a
 * sentence in a header comment saying nothing deletes a batch. That sentence was
 * true and guaranteed by nothing, which is the defect class CLAUDE.md rule 12
 * exists for. This test is the guarantee.
 *
 * ── What it actually checks, and what it does not ────────────────────────────
 *
 * The scan surface is DERIVED, not hand-listed — every `.ts` under
 * `firebase-sync/src` whose code (comments stripped) names the `batches` or
 * `observations` collection. A deleter added in a NEW file is caught; a
 * hand-kept list of two paths would not have been.
 *
 * Its boundary, stated rather than glossed (rule 12 again):
 *
 *  - It watches `firebase-sync` only. A batch deleted server-side — an
 *    admin-SDK `.delete()` in `apps/cloud-functions`, or a console/script
 *    deletion — is out of its reach. It guards the path a feature would
 *    plausibly take, not every path that exists.
 *  - It keys off `deleteDoc` and off exported `delete*`/`remove*` names. A
 *    deleter that used neither would pass.
 *
 * A tripwire on the likely path, then. That is more than the comment it
 * replaces, and it is not a proof.
 *
 * ── Why it lives HERE and not next to the sweep ─────────────────────────────
 *
 * The gap it guards is in `apps/cloud-functions`, and that is where this test was
 * first written — but the source it scans is this package's, and reaching it from
 * there needs either a `../../../../packages/...` path escape (forbidden by
 * `UT-E4`, docs/unit-test-spec.md, pinned at 0 for every area) or an import of
 * `@salt/firebase-sync` from `apps/cloud-functions` (forbidden by CLAUDE.md hard
 * rule 2). Neither is available, and neither should be: a guard on this package's
 * source belongs in this package's suite, where the path is `../src` and a file
 * move cannot silently make it scan nothing.
 *
 * It reads bytes with `node:fs` and never imports what it checks, following
 * `apps/cloud-functions/tests/aiTimeoutGuard.test.ts`.
 */
const SYNC_SRC = fileURLToPath(new URL('../src', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Comments out, always. Both batch modules argue about `deleteBatch` at length in
 * prose — that is the whole point of them — so a scan that kept comments would
 * fire on the very sentences this guard exists to replace.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Does this module's code touch the batch collections at all? */
const TOUCHES_BATCHES = /'(batches|observations)'/;

/** Does it delete a document, by primitive or by exported name? */
const DELETES = [
  /\bdeleteDoc\s*\(/,
  /\bexport\s+(?:async\s+)?function\s+(?:delete|remove)\w*/,
  /\bexport\s+const\s+(?:delete|remove)\w*\s*=/,
];

function deleterMatches(code: string): string[] {
  return DELETES.filter((re) => re.test(code)).map((re) => re.source);
}

const modules = walk(SYNC_SRC).map((path) => ({
  name: relative(dirname(SYNC_SRC), path),
  code: stripComments(readFileSync(path, 'utf8')),
}));

const batchModules = modules.filter((m) => TOUCHES_BATCHES.test(m.code));

describe('no batch or observation deleter has appeared without handling the orphans it leaves', () => {
  it('found the firebase-sync source, and both batch modules in it', () => {
    // Anti-vacuity. A moved or renamed package would make every assertion below
    // pass by matching nothing, which is the failure shape this guard exists to
    // remove — the same trap `storageSweepCoverage.test.ts` guards against.
    expect(modules.length).toBeGreaterThan(10);
    const names = batchModules.map((m) => m.name);
    expect(names).toContain(join('src', 'batchSync.ts'));
    expect(names).toContain(join('src', 'batchObservationSync.ts'));
  });

  it('detects a deleter when there is one to detect', () => {
    // The detector, proven against a sample rather than trusted. Without this the
    // guard below could be green because the regexes match nothing at all.
    expect(deleterMatches("const C = 'batches'; await deleteDoc(doc(db, C, id));")).not.toEqual([]);
    expect(deleterMatches('export async function deleteBatch(id) {}')).not.toEqual([]);
    expect(deleterMatches('export const removeObservation = async () => {};')).not.toEqual([]);
    // And it does not fire on the writes that are actually there today.
    expect(deleterMatches('export async function saveBatch(b) { await setDoc(r, b); }')).toEqual(
      [],
    );
  });

  it.each(batchModules.map((m) => [m.name, m.code] as const))(
    '%s does not delete a batch or an observation',
    (name, code) => {
      expect(
        deleterMatches(code),
        `${name} now deletes a batch or an observation.\n\n` +
          `Deleting \`batches/{batchId}\` does NOT delete its \`observations\` subcollection: ` +
          `those documents survive as Firestore orphans that nothing sweeps. The STORAGE side is ` +
          `already handled — sweepNestedPrefix frees a photo whose parent batch is gone (#968 ` +
          `phase 1) — but the observation documents themselves are not.\n\n` +
          `Before this lands, either cascade the subcollection in the deleter, or add a pass that ` +
          `reclaims orphaned observation documents. Then update this guard to say which was done.`,
      ).toEqual([]);
    },
  );
});
