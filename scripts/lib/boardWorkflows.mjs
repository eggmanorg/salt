/**
 * The board's pipeline does not start in code. Its first rung — a new issue
 * landing at `Triage` — is one of GitHub's own built-in project workflows, set
 * in the project's UI and settable nowhere else. `docs/issue-board.md` says so
 * in its `Status` table, and `.github/workflows/board-status.yml` says so in its
 * header.
 *
 * Both were wrong for weeks and nothing noticed: the workflow was switched off,
 * new issues arrived with no `Status` at all, and four of them sat unset for
 * their whole life while two documents asserted otherwise. That is a CLAUDE.md
 * rule 12 defect living in the docs — a stated mechanism guaranteed by nothing —
 * and this function is what stops it being a claim.
 *
 * WHAT IS PINNED IS ONLY WHAT A DOC CLAIMS, which is the boundary. The project
 * carries seven built-in workflows and most are deliberately off; asserting the
 * whole set would make this fail the next time somebody enables something for a
 * good reason. Two are load-bearing and documented:
 *
 * - `Item added to project` — the `Triage` rung in the pipeline table.
 * - `Auto-add sub-issues to project` — how a parent link puts an issue on the
 *   board, which is what makes a campaign's filings reachable from its epic
 *   (#1346) and what `closedItemVerdict`'s auto-added branch exists to absorb.
 *
 * A workflow MISSING from the list fails too, rather than passing by absence:
 * GitHub renaming one is indistinguishable here from it being switched off, and
 * both mean the documented mechanism is not running.
 *
 * `nodes` is `{ name, enabled }[]` from
 * `organization(...){ projectV2(...){ workflows(first:20){ nodes{ name enabled } } } }`.
 */
const REQUIRED = [
  [
    'Item added to project',
    'new issues land with no Status at all, and the pipeline table in docs/issue-board.md is wrong',
  ],
  [
    'Auto-add sub-issues to project',
    'attaching an issue to a parent stops putting it on the board, and a campaign’s filings stop being reachable from its epic',
  ],
];

export function disabledWorkflowFailures(nodes) {
  const byName = new Map((nodes ?? []).map((w) => [w?.name, w?.enabled]));
  return REQUIRED.filter(([name]) => byName.get(name) !== true).map(
    ([name, cost]) =>
      `the project's built-in "${name}" workflow is ${byName.has(name) ? 'disabled' : 'missing'} — ${cost}. It is a UI setting: project → ⋯ → Workflows → "${name}" → enable`,
  );
}
