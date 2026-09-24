// One board item, found by issue number — and the shape every board read returns.
//
// WHY A SECOND LOOKUP EXISTS. `board.mjs` finds an issue's item by scanning
// `ProjectV2.items` and matching the number. That connection LAGS: an item
// added by `addProjectV2ItemById` was measured (2026-09-23, #1561) absent from
// the enumeration for 30+ minutes, with `items.totalCount` unmoved, while the
// same item was already resolvable through `repository.issue(n).projectItems`.
// A number the scan misses is therefore asked about once more, from the issue's
// side, before anything calls it "not on the board" — which is what failed the
// `PR raised → In review` job on a PR whose issue had been triaged minutes
// earlier.
//
// ITS BOUNDARY. The fallback only covers the issue-side index being fresher than
// the project-side one, which is what was observed; if both lag, the miss is
// still reported as a miss. It is consulted per number on a miss only, so a
// whole-board read (`check`, `release`) still sees only what the scan returns.
//
// The GraphQL call itself is injected (`lookup`), so this module stays pure and
// is tested offline like every other `board*` helper.

/**
 * The selection for one `ProjectV2Item` node. Shared by the bulk scan and the
 * targeted lookup so the two cannot disagree about which fields an item carries.
 */
export const ITEM_SELECTION = `id createdAt
  content{ ... on Issue { number title state stateReason closedAt
    labels(first:20){ nodes{ name } } } }
  queue:fieldValueByName(name:"Queue"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
  class:fieldValueByName(name:"Class"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
  size:fieldValueByName(name:"Size"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
  status:fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }
  blockedBy:fieldValueByName(name:"Blocked by"){ ... on ProjectV2ItemFieldTextValue { text } }`;

/** A raw item node → the item shape the board commands use; `null` for a draft. */
export function parseItem(n) {
  if (!n?.content?.number) return null; // draft item — not an issue
  return {
    id: n.id,
    number: n.content.number,
    title: n.content.title,
    state: n.content.state,
    // `COMPLETED` | `NOT_PLANNED` | null. The check needs it to tell a
    // won't-fix close from one that shipped — see `closedItemVerdict`.
    stateReason: n.content.stateReason ?? null,
    // WHEN THE BOARD ITEM APPEARED, against when the issue closed. An item
    // created AFTER its issue closed was never in the pipeline at all —
    // GitHub's "Auto-add sub-issues to project" workflow put it there when
    // something linked it to a parent. See `closedItemVerdict`.
    createdAt: n.createdAt ?? null,
    closedAt: n.content.closedAt ?? null,
    // Read for exactly one rule: an epic must not be runnable. `first:20`
    // is the cap, so an issue carrying more than twenty labels could hide
    // `specced` from the check below — no issue in this repo is close, and
    // the failure direction is a missed finding rather than a false one.
    labels: (n.content.labels?.nodes ?? []).map((l) => l.name),
    queue: n.queue?.name ?? null,
    // `class` and `size` are read by `show` alone — no check rule consults
    // either, and `size` deliberately has nothing grading it (#1521 adds
    // the place a human can compare it to what shipped, not a gate).
    class: n.class?.name ?? null,
    size: n.size?.name ?? null,
    status: n.status?.name ?? null,
    blockedBy: n.blockedBy?.text ?? '',
  };
}

/**
 * From an issue's `projectItems` nodes (each selected with `project{ id }` plus
 * `ITEM_SELECTION`), the one on this project, parsed — or `null`.
 */
export function itemOnProject(nodes, projectId) {
  const node = (nodes ?? []).find((n) => n?.project?.id === projectId);
  return node ? parseItem(node) : null;
}

/**
 * The item for `number`: from the scan when it has it, else from `lookup(number)`
 * (the targeted issue-side query, returning an item or `null`). `null` only when
 * both miss.
 */
export function findItem(items, number, lookup) {
  return items.find((i) => i.number === number) ?? lookup(number) ?? null;
}
