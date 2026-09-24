/**
 * The characterization suite for `scripts/lib/subjectBriefWriters.mjs` and the
 * CLI over it (issue #1519).
 *
 * The guard cannot characterise itself: it runs over a tree that holds exactly
 * four sanctioned writers and a table that lists exactly those four, so a
 * matcher quietly narrowed to nothing would sit green there — the doc would be
 * over-declaring against an empty scan, which is why the CLI has a liveness arm
 * and why this suite feeds the shapes in directly.
 *
 * The last two blocks are the ones that matter: the CLI is spawned for real
 * against the real repository (green), and then against a repository whose doc
 * has had a writer removed (red). That is the red-then-green demonstration the
 * issue's Definition of Done asks for, run every time rather than once by hand.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCAN_ROOTS,
  TABLE_END,
  TABLE_START,
  diffWriters,
  findSubjectBriefWrites,
  parseDeclaredWriters,
} from '../lib/subjectBriefWriters.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOC = path.join(REPO_ROOT, 'docs/canon-icons.md');

describe('findSubjectBriefWrites', () => {
  /** [name, source line the scan MUST report] */
  const CATCHES = [
    ['a plain object-literal field', '        subjectBrief: brief,'],
    [
      'an inline transaction update',
      '        tx.update(ref, { ...stamp, subjectBrief: input.brief, sourceName: n });',
    ],
    ['a merge set', 'await ref.set({ subjectBrief: brief }, { merge: true });'],
    ['spacing before the colon', '  subjectBrief : brief,'],
    [
      'an assignment on a line whose string literal contains //',
      "    .set({ source: 'https://salt.eggyman.net/x', subjectBrief: brief }, { merge: true });",
    ],
    // #1550: an unquoted regex literal is a token, not a comment opener.
    [
      'an assignment after a regex literal containing //',
      "ref.set({ slug: name.replace(/\\/\\//g, '-'), subjectBrief: brief });",
    ],
    [
      'an assignment after a regex character class containing //',
      "ref.set({ slug: name.replace(/[//]/g, '-'), subjectBrief: brief });",
    ],
    [
      'an assignment after a regex literal containing /*',
      "ref.set({ slug: name.replace(/a\\/*b/g, '-'), subjectBrief: brief });",
    ],
    [
      'the in-tree regex from storageDownloadUrl.ts, with a writer appended',
      "const host = emulatorHost.replace(/^https?:\\/\\//, ''); ref.set({ subjectBrief: host });",
    ],
    ['a division on the same line', 'ref.set({ half: a / b, subjectBrief: brief });'],
  ];

  for (const [name, source] of CATCHES) {
    it(`catches ${name}`, () => {
      expect(findSubjectBriefWrites(source)).toHaveLength(1);
    });
  }

  /**
   * Near-misses. Every one mentions `subjectBrief` — that is the anti-vacuity
   * floor, since a "near-miss" without the field name proves nothing about a
   * scan that matches the field name.
   */
  const MISSES = [
    ['a read', '  const words = icon.data.subjectBrief;'],
    [
      'an argument position',
      '  prompt: buildEquipmentIconPrompt(icon.data.briefSourceName, icon.data.subjectBrief),',
    ],
    ['a line comment', '// the manifest trigger writes subjectBrief: itself, from the name'],
    [
      'an asterisk-prefixed block-comment body',
      ['/**', ' * one `ref.set({ subjectBrief: x })` would do it', ' */'].join('\n'),
    ],
    [
      'a non-asterisk-prefixed block-comment continuation line',
      ['/*', '  ref.set({ subjectBrief: brief })', '*/'].join('\n'),
    ],
    ['a trailing line comment on real code', '  const x = 1; // subjectBrief: brief'],
    ['a longer identifier', '  notSubjectBriefish: brief,'],
    // #1550: a quote inside a regex must not open a string that outlives the line.
    [
      'a line comment after a regex literal containing a quote',
      ["const re = /don't/;", '// subjectBrief: brief'].join('\n'),
    ],
    [
      'a block comment inside a template-literal interpolation',
      'const s = `${a /* subjectBrief: brief */}`;',
    ],
  ];

  for (const [name, source] of MISSES) {
    it(`does not fire on ${name}`, () => {
      expect(findSubjectBriefWrites(source)).toEqual([]);
    });
  }

  it('does not let a regex literal containing /* swallow the lines after it (#1550)', () => {
    const src = ['const re = /a\\/*b/;', 'x({ subjectBrief: b });', 'y({ subjectBrief: c });'].join(
      '\n',
    );
    expect(findSubjectBriefWrites(src).map((w) => w.line)).toEqual([2, 3]);
  });

  it('reports 1-based line numbers, one entry per assignment', () => {
    const src = ['const a = 1;', 'x({ subjectBrief: b });', '', 'y({ subjectBrief: c });'].join(
      '\n',
    );
    expect(findSubjectBriefWrites(src).map((w) => w.line)).toEqual([2, 4]);
  });
});

describe('parseDeclaredWriters', () => {
  const table = (rows) =>
    [
      '# doc',
      `${TABLE_START} -->`,
      '| Writer | Site | Where the sentence comes from |',
      '| --- | --- | --- |',
      ...rows,
      `${TABLE_END} -->`,
    ].join('\n');

  it('takes the path column, not the writer name', () => {
    const md = table(['| `drawEquipmentIcon` | `apps/cloud-functions/src/x.ts` | client text |']);
    expect(parseDeclaredWriters(md)).toEqual({ paths: ['apps/cloud-functions/src/x.ts'] });
  });

  it('keeps duplicates, so two writers in one file are two rows', () => {
    const md = table([
      '| `one` | `apps/cloud-functions/src/x.ts` | a |',
      '| `two` | `apps/cloud-functions/src/x.ts` | b |',
    ]);
    expect(parseDeclaredWriters(md).paths).toHaveLength(2);
  });

  it('reads an .mjs operator script', () => {
    const md = table(['| `backfill` | `apps/cloud-functions/scripts/gen.mjs` | the name |']);
    expect(parseDeclaredWriters(md).paths).toEqual(['apps/cloud-functions/scripts/gen.mjs']);
  });

  it('ignores markdown outside the fences', () => {
    const md = ['| `stray` | `apps/cloud-functions/src/outside.ts` | x |', table([])].join('\n');
    expect(parseDeclaredWriters(md).error).toMatch(/no writer rows/);
  });

  it('errors rather than passing when the fences are gone', () => {
    expect(parseDeclaredWriters('# doc\n\nno table here').error).toMatch(/fences are missing/);
  });
});

describe('diffWriters', () => {
  it('agrees when the multisets match, order-independently', () => {
    expect(diffWriters(['b', 'a'], ['a', 'b'])).toEqual({ missing: [], extra: [] });
  });

  it('reports a code writer the table has not got', () => {
    expect(diffWriters(['a', 'b'], ['a'])).toEqual({ missing: [], extra: ['b'] });
  });

  it('reports a table row the code has not got', () => {
    expect(diffWriters(['a'], ['a', 'b'])).toEqual({ missing: ['b'], extra: [] });
  });

  it('counts a second writer inside an already-listed file', () => {
    expect(diffWriters(['a', 'a'], ['a'])).toEqual({ missing: [], extra: ['a'] });
  });
});

describe('the gate, spawned for real', () => {
  /**
   * The CLI locates the repository from its OWN path, not from `cwd` — so a
   * scratch run has to spawn the copy that lives inside the scratch tree.
   */
  const run = (root) =>
    spawnSync(process.execPath, [path.join(root, 'scripts/check-subject-brief-writers.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });

  it('is green on this repository as it stands', () => {
    const result = run(REPO_ROOT);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/briefwriters:check passed/);
    expect(result.stdout).toContain('4 `subjectBrief` writer(s) across 4 file(s)');
  });

  /**
   * The red half, and the reason this suite exists rather than a line in a PR
   * body saying the gate was demonstrated once. A throwaway copy of the tree
   * loses one row from the table; the gate must name the writer it can still
   * see in the code.
   */
  it('goes red when the table loses a writer the code still has', () => {
    const scratch = scratchRepo();

    const doc = readFileSync(DOC, 'utf8');
    const dropped = parseDeclaredWriters(doc).paths[0];
    const kept = doc
      .split('\n')
      .filter((line) => !(line.trim().startsWith('|') && line.includes(`\`${dropped}\``)))
      .join('\n');
    writeFileSync(path.join(scratch, 'docs/canon-icons.md'), kept, { flush: true });

    const result = run(scratch);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/In the code, not in the table/);
    expect(result.stderr).toContain(dropped);
  });

  /**
   * A scratch copy of the scan roots, the CLI, its library and the
   * (unmodified) doc — the base every mutation test here starts from, so
   * writing one rogue file in is the only difference from a green run. The
   * library parses with `typescript`, so the repo's `node_modules` is linked
   * in for the scratch copy to resolve it from under the OS temp dir.
   */
  function scratchRepo() {
    const scratch = mkdtempSync(path.join(tmpdir(), 'briefwriters-'));
    for (const root of SCAN_ROOTS) {
      cpSync(path.join(REPO_ROOT, root), path.join(scratch, root), { recursive: true });
    }
    for (const file of [
      'scripts/check-subject-brief-writers.mjs',
      'scripts/lib/subjectBriefWriters.mjs',
      'scripts/lib/stripComments.mjs',
    ]) {
      cpSync(path.join(REPO_ROOT, file), path.join(scratch, file));
    }
    mkdirSync(path.join(scratch, 'docs'), { recursive: true });
    cpSync(DOC, path.join(scratch, 'docs/canon-icons.md'));
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(scratch, 'node_modules'), 'dir');
    return scratch;
  }

  /**
   * Blocking finding 1 (#1549 review): `SKIP_DIRS` used to contain `lib`, so
   * the walk never entered `apps/cloud-functions/scripts/lib/` even though
   * it sits inside a declared scan root and holds real source. A writer
   * dropped there was invisible to the gate: absent from the scan AND from
   * the (unmodified) table, the multisets agreed and the run passed. This
   * must go red, naming the rogue file under `scripts/lib/`.
   */
  it('goes red on a writer added under apps/cloud-functions/scripts/lib/', () => {
    const scratch = scratchRepo();
    const rogue = path.join(scratch, 'apps/cloud-functions/scripts/lib/rogueWriter.ts');
    writeFileSync(rogue, "export function rogue(ref) {\n  ref.set({ subjectBrief: 'x' });\n}\n");

    const result = run(scratch);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/In the code, not in the table/);
    expect(result.stderr).toContain('apps/cloud-functions/scripts/lib/rogueWriter.ts');
  });

  /**
   * Blocking finding 2 (#1549 review): the comment strip used to be a
   * textual `//` truncation, so a line whose string literal contained `//`
   * (an ordinary URL) ahead of the `subjectBrief:` field never reached the
   * matcher. For a NEW writer that is a silent pass, not the "false negative
   * … which this check still reds on" the old header claimed — the writer is
   * absent from both multisets. This must go red, naming the rogue file.
   */
  it('goes red on a new writer whose assignment line has // inside a string literal', () => {
    const scratch = scratchRepo();
    const rogue = path.join(scratch, 'apps/cloud-functions/src/callables/rogueUrl.ts');
    writeFileSync(
      rogue,
      'export function rogue(ref) {\n' +
        "  ref.set({ source: 'https://salt.eggyman.net/x', subjectBrief: 'x' }, { merge: true });\n" +
        '}\n',
    );

    const result = run(scratch);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/In the code, not in the table/);
    expect(result.stderr).toContain('apps/cloud-functions/src/callables/rogueUrl.ts');
  });
  /**
   * #1550: the stripper had no regex-literal state, so an unquoted regex
   * containing `//` or `/*` opened a phantom comment and the `subjectBrief:`
   * after it never reached the matcher — absent from both multisets, a
   * silent pass. Each of these must go red and name the rogue file.
   */
  const REGEX_ROGUES = [
    [
      'a regex literal containing //',
      "  ref.set({ slug: name.replace(/\\/\\//g, '-'), subjectBrief: 'x' });\n",
    ],
    [
      'a regex character class containing //',
      "  ref.set({ slug: name.replace(/[//]/g, '-'), subjectBrief: 'x' });\n",
    ],
    [
      'a regex literal containing /* on the line above two writers',
      "  const re = /a\\/*b/;\n  ref.set({ subjectBrief: 'x' });\n  ref.set({ subjectBrief: 'y' });\n",
    ],
  ];

  for (const [name, body] of REGEX_ROGUES) {
    it(`goes red on a new writer behind ${name}`, () => {
      const scratch = scratchRepo();
      const rogue = path.join(scratch, 'apps/cloud-functions/src/callables/rogueRegex.ts');
      writeFileSync(rogue, `export function rogue(ref, name) {\n${body}}\n`);

      const result = run(scratch);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/In the code, not in the table/);
      expect(result.stderr).toContain('apps/cloud-functions/src/callables/rogueRegex.ts');
    });
  }

  it('finds both writers below a regex literal containing /*', () => {
    const scratch = scratchRepo();
    const rogue = path.join(scratch, 'apps/cloud-functions/src/callables/rogueRegex.ts');
    writeFileSync(rogue, `export function rogue(ref, name) {\n${REGEX_ROGUES[2][1]}}\n`);

    // One line per undeclared assignment under "In the code, not in the table".
    const result = run(scratch);
    const extra = result.stderr.match(
      /^ {4}apps\/cloud-functions\/src\/callables\/rogueRegex\.ts$/gm,
    );
    expect(extra).toHaveLength(2);
  });

  it('stays green over a comment that follows a regex literal containing a quote', () => {
    const scratch = scratchRepo();
    const quiet = path.join(scratch, 'apps/cloud-functions/src/callables/quoteRegex.ts');
    writeFileSync(
      quiet,
      "export const re = /don't/;\n// subjectBrief: brief is only mentioned here\n",
    );

    const result = run(scratch);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
