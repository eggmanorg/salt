// The exit codes, spawned for real. `spec-shape.yml` keys three branches off
// them (`:84-103`) and three command files tell a human to run this by hand, so
// "exit 1 with the category error" is a contract of the CLI and not only of the
// library function underneath it.
//
// Spawned rather than imported for the reason backfillRecipeKitCli.test.mjs
// gives: the module does its argument handling and `process.exit` as top-level
// side effects, and an import cannot observe either. It caught a real bug during
// #1378 that no unit test would have — the `--title-file` argv filter dropped
// the positional body path when the flag was ABSENT, so every existing
// invocation silently fell through to reading stdin and hung.
//
// WHAT THIS PINS AND WHAT IT DOES NOT (CLAUDE.md rule 12): it pins the three
// exit codes and that the epic verdict says why. It does not pin the workflow
// wiring — that `spec-shape.yml` actually passes `--title-file`, and that the
// title it passes is the issue's, is checked by nothing here and only by a real
// GitHub run.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SPEC_VARIANTS } from '../lib/specIssueShape.mjs';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-spec-shape.mjs',
);
const dir = mkdtempSync(path.join(tmpdir(), 'spec-shape-'));

/** A minimal valid body, built from the checker's own tables so it cannot drift. */
function bodyFor(variant) {
  const sections = variant.headings
    .filter((heading) => heading !== 'Phases')
    .map((heading) => `## ${heading}\nreal content\n`);
  const phase =
    '### Phase 1: Name\n' +
    variant.phaseFields.map((field) => `**${field}:** real content`).join('\n') +
    '\n';
  return [...sections.slice(0, -1), `## Phases\n\n${phase}`, sections.at(-1)].join('\n');
}

function file(name, contents) {
  const full = path.join(dir, name);
  writeFileSync(full, contents);
  return full;
}

function run(args) {
  try {
    return { status: 0, stdout: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? '' };
  }
}

const specBody = file('spec.md', bodyFor(SPEC_VARIANTS[0]));

describe('check-spec-shape.mjs CLI', () => {
  it('exits 1 and names the category error for an epic-titled spec body', () => {
    const result = run([specBody, '--title-file', file('epic.txt', 'epic: a programme\n')]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('epic — MUST NOT be runnable');
    expect(result.stdout).toContain('An epic is a container');
  });

  it('exits 1 for a SCOPED epic title, which the band predicate would miss', () => {
    const result = run([specBody, '--title-file', file('scoped.txt', 'epic(test): safe suite\n')]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('epic — MUST NOT be runnable');
  });

  it('exits 0 for the identical body under an ordinary title', () => {
    const result = run([specBody, '--title-file', file('work.txt', 'feat: ordinary work\n')]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Label `specced` applies.');
  });

  // The regression the argv bug produced: with no `--title-file`, the positional
  // body path must still be read. Before the fix this hung on stdin forever.
  it('reads the positional body with no --title-file, exactly as before', () => {
    const result = run([specBody]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('feature spec (/salt-spec) — runnable.');
  });

  it('exits 2 for an epic whose body is not a spec — the ordinary, correct epic', () => {
    const result = run([
      file('container.md', '## Goal\n\nA container.\n'),
      '--title-file',
      file('epic2.txt', 'epic: a programme\n'),
    ]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('not a spec issue');
  });

  it('still exits 1 with the ordinary problem list for a broken non-epic spec', () => {
    const broken = file(
      'broken.md',
      bodyFor(SPEC_VARIANTS[0]).replace('**Scope:** real content\n', ''),
    );
    const result = run([broken, '--title-file', file('work2.txt', 'feat: ordinary work\n')]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('NOT runnable');
    expect(result.stdout).toContain('missing **Scope:**');
  });
});
