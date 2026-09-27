// `/salt-spec`, `/salt-defect` and `/salt-refactor` used to carry their own
// copies of the same workflow text — the epic escape, the Checkpoint, the
// `gh`-absent Board route, the parent ladder, session naming, the posted-body
// check. #1611 moved that text into `.claude/shared/spec-writing.md`, which each
// command reads first and then points into by section name.
//
// What this test pins (CLAUDE.md rule 12): the shared file exists and is not a
// command; each command names it, before its first pointer into it; every
// pointer resolves to a `##` section there; every command points at every
// section; and no paragraph — nor any long line — of the shared file has been
// pasted back into a command, with or without the kind-specific fill-ins and
// whatever the wrapping. What it cannot pin: that a command's OWN text still
// agrees with the shared text in substance. A command could contradict a shared
// section in fresh words and pass; that stays a reviewer's read.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const read = (f) => readFileSync(path.join(repo, f), 'utf8');

const SHARED = '.claude/shared/spec-writing.md';
const COMMANDS = [
  '.claude/commands/salt-spec.md',
  '.claude/commands/salt-defect.md',
  '.claude/commands/salt-refactor.md',
];

/** A pointer is `` `spec-writing.md` → _Section title_ `` in a command. */
const POINTER = /`spec-writing\.md` → _([^_\n]+)_/g;
const pointersIn = (text) => [...text.matchAll(POINTER)].map((m) => m[1]);

/** The words the shared file leaves for each command to fill in. A re-copied
 *  paragraph arrives with them filled, so they match any one or two words. */
const PLACEHOLDERS = ['<Class>', '<SESSION>', '<prefix>'];

/** Shorter than this is a phrase, not a paragraph — a pointer line, a heading. */
const MIN_CHARS = 80;

const collapse = (text) => text.replace(/\s+/g, ' ').trim();
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asPattern = (unit) =>
  new RegExp(
    PLACEHOLDERS.reduce(
      (source, placeholder) => source.split(placeholder).join('\\S+(?: \\S+)?'),
      escape(unit),
    ),
  );

/** Every blank-line-separated paragraph of the shared file except headings,
 *  and — for a paragraph spanning several lines — each of its lines too, so a
 *  partial paste is seen as well as a whole one. Whitespace is collapsed, so
 *  re-wrapping a paragraph does not hide it. */
function sharedUnits(text) {
  const units = new Set();
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (/^#/.test(paragraph.trim())) continue;
    const lines = paragraph.split('\n').map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
    for (const unit of [paragraph, ...(lines.length > 1 ? lines : [])]) {
      const collapsed = collapse(unit);
      if (collapsed.length >= MIN_CHARS) units.add(collapsed);
    }
  }
  return [...units];
}

describe('the spec commands share one copy of their workflow text', () => {
  it('the shared file exists outside .claude/commands/, with no frontmatter', () => {
    expect(existsSync(path.join(repo, SHARED))).toBe(true);
    expect(SHARED.startsWith('.claude/commands/')).toBe(false);
    const text = read(SHARED);
    // Frontmatter is what a command carries. Without it, this file cannot turn
    // into a working command by being moved into `.claude/commands/`.
    expect(text.startsWith('---')).toBe(false);
    expect(text).not.toMatch(/^disable-model-invocation:/m);
  });

  const sections = [...read(SHARED).matchAll(/^## +(.+)$/gm)].map((m) => m[1].trim());

  it('the shared file has the sections the commands point at', () => {
    expect(sections.length).toBeGreaterThan(0);
  });

  describe.each(COMMANDS)('%s', (file) => {
    const text = read(file);
    const pointers = pointersIn(text);

    it('names the shared file before its first pointer into it', () => {
      const named = text.indexOf(SHARED);
      expect(named, `${file} never names ${SHARED}`).toBeGreaterThan(-1);
      expect(pointers.length, `${file} has no pointer into ${SHARED}`).toBeGreaterThan(0);
      expect(named).toBeLessThan(text.search(POINTER));
    });

    it('points only at sections that exist, and at every one of them', () => {
      for (const pointer of pointers) expect(sections).toContain(pointer);
      expect([...new Set(pointers)].sort()).toEqual([...sections].sort());
    });

    it('carries no copy of a shared paragraph', () => {
      const body = collapse(text);
      const copied = sharedUnits(read(SHARED)).filter((unit) => asPattern(unit).test(body));
      expect(copied, `${file} re-copies text that lives in ${SHARED}`).toEqual([]);
    });
  });
});
