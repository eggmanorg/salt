import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { classifySpecIssue, SPEC_VARIANTS } from '../lib/specIssueShape.mjs';

// Two properties, and the first is the one that rots.
//
// `specIssueShape.mjs` holds a COPY of the issue templates in
// `.claude/commands/`. Nothing makes an agent editing a template edit the copy,
// and the failure is silent in the worse direction: rename a phase field in the
// template and every issue posted afterwards is correct and unlabelled, or —
// worse — drop a field from the checker and issues missing it keep the label
// that says /salt-run can consume them. So the first block below parses the
// templates out of the command files and asserts the tables still match them.
// This is the pin CLAUDE.md rule 12 asks for, in the same shape as
// dependabotReviewChecks.test.mjs: one file's copy, checked against its source.
//
// The second block is the classifier's own behavior — that it tells the three
// variants apart, and that each way a body can be unrunnable is actually seen.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

/** The template lives between the first `---` fence after the "Issue body — use
 *  exactly this structure" marker and the next one. Everything before that
 *  marker is prose ABOUT the issue and shares the same heading levels. */
function template(relative) {
  const text = read(relative);
  const start = text.indexOf('**Issue body');
  expect(start, `no "Issue body" marker in ${relative}`).toBeGreaterThan(-1);
  const fenced = text.slice(start).split(/^---$/m);
  expect(fenced.length, `no --- fenced template in ${relative}`).toBeGreaterThan(2);
  return fenced[1];
}

const headingsOf = (text) => [...text.matchAll(/^## +(.+)$/gm)].map((match) => match[1].trim());

/** Fields of the FIRST phase block only. `## Observed vs Expected` opens with
 *  `**Observed:**`, and Open Questions with `**Decision:**` — bolded labels that
 *  are not phase fields. */
const phaseFieldsOf = (text) => {
  const first = text.match(/^### +Phase +1:[\s\S]*?(?=^### +Phase +2:)/m);
  expect(first, 'no `### Phase 1:` block in template').not.toBeNull();
  return [...first[0].matchAll(/^\*\*(.+?):\*\*/gm)].map((match) => match[1].trim());
};

describe.each(SPEC_VARIANTS)('$command template', (variant) => {
  const text = template(variant.template);

  it('still declares exactly the sections the checker requires', () => {
    expect(headingsOf(text)).toEqual(variant.headings);
  });

  it('still declares exactly the phase fields the checker requires', () => {
    expect(phaseFieldsOf(text)).toEqual(variant.phaseFields);
  });

  it('carries a signature heading no other variant has', () => {
    const others = SPEC_VARIANTS.filter((other) => other.id !== variant.id);
    expect(variant.headings).toContain(variant.signature);
    for (const other of others) expect(other.headings).not.toContain(variant.signature);
  });
});

/** A minimal but valid body for a variant, built from its own tables so these
 *  cases cannot drift from the checker either. */
function bodyFor(variant, { phases = 1 } = {}) {
  const sections = variant.headings
    .filter((heading) => heading !== 'Phases')
    .map((heading) => `## ${heading}\nreal content\n`);
  const blocks = Array.from(
    { length: phases },
    (_, index) =>
      `### Phase ${index + 1}: Name\n` +
      variant.phaseFields.map((field) => `**${field}:** real content`).join('\n') +
      '\n',
  );
  return [...sections.slice(0, -1), `## Phases\n\n${blocks.join('\n')}`, sections.at(-1)].join(
    '\n',
  );
}

describe('classifySpecIssue', () => {
  it.each(SPEC_VARIANTS)('accepts a complete $id spec', (variant) => {
    expect(classifySpecIssue(bodyFor(variant))).toEqual({
      variant: variant.id,
      ok: true,
      problems: [],
    });
  });

  it.each(SPEC_VARIANTS)('accepts a multi-phase $id spec', (variant) => {
    expect(classifySpecIssue(bodyFor(variant, { phases: 3 })).ok).toBe(true);
  });

  it('reports no variant, and no problems, for an ordinary hand-written issue', () => {
    // The common case. "Not a spec" must not read as "a broken spec" — the
    // workflow says nothing at all about these, and an issue that is a note is
    // not a defect in the process.
    const result = classifySpecIssue('# Thing is slow\n\nWe should look at this some time.');
    expect(result).toEqual({ variant: null, ok: false, problems: [] });
  });

  it('ignores headings inside a fenced code block', () => {
    // An issue quoting the template while discussing it must not be classified
    // by the quote.
    const quoted =
      '```md\n' + bodyFor(SPEC_VARIANTS[0]) + '\n```\n\nJust asking a question about the format.';
    expect(classifySpecIssue(quoted).variant).toBeNull();
  });

  it('flags a missing section', () => {
    const variant = SPEC_VARIANTS[0];
    const body = bodyFor(variant).replace('## Definition of Done\nreal content\n', '');
    expect(classifySpecIssue(body).problems).toContain('missing section: ## Definition of Done');
  });

  it('flags a phase block with no fields at all', () => {
    const variant = SPEC_VARIANTS[0];
    const body = bodyFor(variant).replace(/^\*\*.+$/gm, 'just prose');
    const { ok, problems } = classifySpecIssue(body);
    expect(ok).toBe(false);
    expect(problems).toHaveLength(variant.phaseFields.length);
  });

  it.each(SPEC_VARIANTS)('flags each missing phase field for $id', (variant) => {
    for (const field of variant.phaseFields) {
      const body = bodyFor(variant).replace(`**${field}:** real content\n`, '');
      expect(classifySpecIssue(body).problems).toContain(`Phase 1: missing **${field}:**`);
    }
  });

  it('flags a field left as the template placeholder', () => {
    // The failure the commands' own verification step exists to catch: an issue
    // posted with the prompt still in it.
    const variant = SPEC_VARIANTS[0];
    const body = bodyFor(variant).replace(
      '**Context pointers:** real content',
      '**Context pointers:** [What Step 1 already learned about this phase]',
    );
    expect(classifySpecIssue(body).problems).toContain(
      'Phase 1: **Context pointers:** is still the template placeholder',
    );
  });

  it('does not mistake a markdown link for a placeholder', () => {
    const variant = SPEC_VARIANTS[0];
    const body = bodyFor(variant).replace(
      '**Context pointers:** real content',
      '**Context pointers:** [docs/data-model.md](docs/data-model.md)',
    );
    expect(classifySpecIssue(body).ok).toBe(true);
  });

  it('flags an empty field', () => {
    const variant = SPEC_VARIANTS[0];
    const body = bodyFor(variant).replace(
      '**Must not touch:** real content',
      '**Must not touch:**',
    );
    expect(classifySpecIssue(body).problems).toContain('Phase 1: **Must not touch:** is empty');
  });

  it('accepts `**Field**:` as well as `**Field:**`', () => {
    const variant = SPEC_VARIANTS[0];
    const body = bodyFor(variant).replace('**Scope:** real content', '**Scope**: real content');
    expect(classifySpecIssue(body).ok).toBe(true);
  });

  it('flags a spec with no phase blocks', () => {
    const variant = SPEC_VARIANTS[0];
    const body = bodyFor(variant).replace(/^### Phase[\s\S]*?(?=^## Definition)/m, '');
    expect(classifySpecIssue(body).problems).toContain('no `### Phase N:` blocks under ## Phases');
  });

  it('flags phases numbered out of order', () => {
    // /salt-run works them in order and reports by number; a skipped number silently
    // drops work.
    const variant = SPEC_VARIANTS[0];
    const body = bodyFor(variant, { phases: 2 }).replace('### Phase 2: Name', '### Phase 3: Name');
    expect(classifySpecIssue(body).problems).toContain(
      'Phase 3 is in position 2 — phases must be numbered 1..N in order',
    );
  });
});
