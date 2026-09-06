// Is this issue body one `/salt-run` can actually execute?
//
// `/salt-spec`, `/salt-defect` and `/salt-refactor` each end by posting an issue in a
// fixed shape, and `/salt-run` consumes that shape BY EXACT HEADING — it looks for
// `## Phases`, splits on `### Phase N:`, and reads five or six bolded fields out
// of each block. Nothing on either side checks the coupling: the commands ask
// the agent that wrote the issue to proof-read its own work (their final step),
// which is the weakest possible check and does not survive the issue being
// edited afterwards.
//
// So the `specced` label asserts something real — "this body is in a shape /salt-run
// can consume" — and per CLAUDE.md rule 12 an assertion nothing can falsify is
// decoration. This file is what makes it true rather than merely applied:
// `spec-shape.yml` runs it on every issue opened or edited and applies or
// REMOVES the label on the result, so the label tracks the body instead of
// recording that a command once ran.
//
// THE LIMIT, stated because it cannot be closed: this checks SHAPE, never
// TRUTH. It can see that **Context pointers** is present and not still the
// template's placeholder; it cannot see whether the `file:line` in it points at
// anything, which is the failure the commands' own verification step is for and
// the one that actually costs `/salt-run` a re-sweep. A `specced` issue is one /salt-run
// will not trip over structurally — not one whose contents are any good.
//
// The variant tables below are copies of the templates in `.claude/commands/`,
// and a copy goes stale in silence. `scripts/tests/specIssueShape.test.mjs`
// parses those templates and asserts every heading and field here still matches
// them, so editing a template without editing this file fails CI.

/** One entry per spec command. `signature` is the level-2 heading unique to that
 *  variant — no two templates share one, which is what makes classification a
 *  lookup rather than a guess. `headings` is the full required set (signature
 *  included); `phaseFields` are the bolded labels every `### Phase N` block must
 *  carry. */
export const SPEC_VARIANTS = [
  {
    id: 'feature',
    command: '/salt-spec',
    template: '.claude/commands/salt-spec.md',
    signature: 'Intended Experience',
    headings: [
      'Intended Experience',
      'Architecture Notes',
      'Open Questions / Decisions',
      'Phases',
      'Definition of Done',
    ],
    phaseFields: [
      'Scope',
      'User-testable outcome(s)',
      'Technical deliverables',
      'Context pointers',
      'Must not touch',
    ],
  },
  {
    id: 'defect',
    command: '/salt-defect',
    template: '.claude/commands/salt-defect.md',
    signature: 'Observed vs Expected',
    headings: [
      'Observed vs Expected',
      'Reproduction',
      'Root Cause',
      'Blast Radius',
      'Architecture Notes & Constraints',
      'Open Questions / Decisions',
      'Phases',
      'Definition of Done',
    ],
    phaseFields: [
      'Scope',
      'Verifiable outcome(s)',
      'Technical deliverables',
      'Context pointers',
      'Must not touch',
    ],
  },
  {
    id: 'refactor',
    command: '/salt-refactor',
    template: '.claude/commands/salt-refactor.md',
    signature: 'Behavior Contract',
    headings: [
      'Current State & Motivation',
      'Behavior Contract',
      'Verification Strategy',
      'Architecture Notes',
      'Open Questions / Decisions',
      'Phases',
      'Definition of Done',
    ],
    phaseFields: [
      'Scope',
      'Behavior-preserving check',
      'Technical deliverables',
      'Context pointers',
      'Must not touch',
      'Safe to stop here?',
    ],
  },
];

/** The label the workflow applies. One label, not three: WHICH command produced
 *  an issue is the board's `Class` field, and docs/issue-board.md is explicit
 *  that nothing is kept in both places. This says only "runnable", which the
 *  board has no field for. */
export const SPEC_LABEL = 'specced';

/** Fenced code blocks are stripped before anything is matched. A ```md fence
 *  quoting the template — which these issues sometimes do when they discuss
 *  their own shape — would otherwise donate headings the body does not have. */
const stripFences = (body) => body.replace(/^ {0,3}(```|~~~).*$[\s\S]*?^ {0,3}\1\s*$/gm, '');

/** Level-2 headings, in order. Exactly two hashes: `### Phase 1:` must not read
 *  as a section, and a `#` title must not either. */
const sectionHeadings = (body) =>
  [...body.matchAll(/^ {0,3}## +(.+?)#*\s*$/gm)].map((match) => match[1].trim());

/** `**Field:**` — and `**Field**:`, which is the same thing to a reader and a
 *  different string to a regex. Both forms are accepted; the value is whatever
 *  follows up to the next bolded field or block boundary. */
const fieldValue = (block, field) => {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(
    new RegExp(
      `^ {0,3}\\*\\*${escaped}(?::\\*\\*|\\*\\*:)([\\s\\S]*?)(?=^ {0,3}\\*\\*|(?![\\s\\S]))`,
      'm',
    ),
  );
  return match ? match[1].trim() : null;
};

/** A field left as the template's own prompt — `[What gets built — precise, not
 *  vague]` — is absent in every way that matters to the agent reading it. A
 *  markdown link is not caught by this: `[text](url)` does not end in `]`. */
const isPlaceholder = (value) => value.startsWith('[') && value.endsWith(']');

/** Split the `## Phases` section into `### Phase N: Name` blocks, each running
 *  to the next heading of any level. */
const phaseBlocks = (body) => {
  const phases = body.match(/^ {0,3}## +Phases\s*$([\s\S]*?)(?=^ {0,3}## +|(?![\s\S]))/m);
  if (!phases) return [];
  return [
    ...phases[1].matchAll(
      /^ {0,3}### +Phase +(\d+)\s*:?(.*)$([\s\S]*?)(?=^ {0,3}#{2,3} +|(?![\s\S]))/gm,
    ),
  ].map((match) => ({ number: Number(match[1]), name: match[2].trim(), block: match[3] }));
};

/**
 * Classify an issue body against the three spec templates.
 *
 * @param {string} body Raw issue body. Take it from the webhook payload, not
 *   from the GitHub MCP `issue_read` — that strips raw angle brackets, and a
 *   body it has been through is not the body on the issue.
 * @returns {{variant: string|null, ok: boolean, problems: string[]}} `variant`
 *   is null when no signature heading matched, which is the ordinary case for a
 *   hand-written issue and not a problem: `ok` false with no problems means "not
 *   a spec", `ok` false with problems means "a spec that /salt-run would trip over".
 */
export function classifySpecIssue(body) {
  const text = stripFences(body ?? '');
  const headings = sectionHeadings(text);

  const variant = SPEC_VARIANTS.find((candidate) => headings.includes(candidate.signature));
  if (!variant) return { variant: null, ok: false, problems: [] };

  const problems = [];

  for (const heading of variant.headings) {
    if (!headings.includes(heading)) problems.push(`missing section: ## ${heading}`);
  }

  const phases = phaseBlocks(text);
  if (phases.length === 0) {
    problems.push('no `### Phase N:` blocks under ## Phases');
  }

  phases.forEach((phase, index) => {
    // Numbering is not decoration: /salt-run works the phases in order and reports
    // progress by number, so a duplicated or skipped one silently re-runs or
    // drops work.
    if (phase.number !== index + 1) {
      problems.push(
        `Phase ${phase.number} is in position ${index + 1} — phases must be numbered 1..N in order`,
      );
    }
    for (const field of variant.phaseFields) {
      const value = fieldValue(phase.block, field);
      if (value === null) problems.push(`Phase ${phase.number}: missing **${field}:**`);
      else if (value === '') problems.push(`Phase ${phase.number}: **${field}:** is empty`);
      else if (isPlaceholder(value))
        problems.push(`Phase ${phase.number}: **${field}:** is still the template placeholder`);
    }
  });

  return { variant: variant.id, ok: problems.length === 0, problems };
}
