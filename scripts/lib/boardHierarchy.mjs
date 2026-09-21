// NOTHING CLOSES WHILE WORK UNDER IT IS STILL OPEN — the invariant the
// `Hierarchies` view rests on, extracted so every branch is testable without
// the live org project.
//
// WHY IT MATTERS AT ALL, since "a closed parent over open work" sounds
// cosmetic. GitHub's `Sub-issues progress` field counts DIRECT children only.
// Close a parent while a GRANDCHILD is open and the parent reads 100%, so
// `no:parent-issue sub-issues-progress:<100 sub-issues.is:open` — the
// `Hierarchies` filter — drops that family from the view entirely, with the
// work still open. It is the one failure that removes work from the only view
// that claims to show all of it. On 2026-09-21 two of nine live families were
// invisible that way (#1372 and #1458) until Daniel read the progress column
// and found them by hand, which is precisely the unguarded invariant CLAUDE.md
// rule 12 names.
//
// The rule is NOT the same claim as `closedItemVerdict`'s, and neither absorbs
// the other: that one asks whether a closed issue reached a shipping `Status`,
// this one asks whether it should be closed at all. An issue can satisfy either
// and fail the other.

/** How many open descendants a message names before it starts counting them. */
const NAMED = 8;

/**
 * Every open issue beneath `root`, at any depth, ascending.
 *
 * `tree` is `number → { state, children }` — `state` being GitHub's `OPEN` /
 * `CLOSED`, `children` the issue's direct sub-issues. `root` itself is never
 * included, whatever its own state.
 *
 * WHAT A MISSING NODE MEANS, stated rather than implied (CLAUDE.md rule 12). A
 * number absent from `tree` is walked as a leaf of unknown state and
 * contributes nothing. So a fetch that silently returned less than the whole
 * tree reads here as a CLEAN tree, and the rule's failure direction is a missed
 * finding rather than a false one — the safe way round for a check that blocks,
 * but it does mean a green `check` is evidence about what was fetched, never
 * proof about what exists.
 *
 * The `seen` set is belt-and-braces, not a case anyone has hit: a GitHub
 * sub-issue link is a strict tree, one parent and no cycles. It is here so that
 * a malformed fixture or a future second source of `tree` cannot hang `check`
 * instead of failing it.
 */
export function openDescendants(root, tree) {
  const out = new Set();
  const seen = new Set([root]);
  const queue = [...(tree?.get(root)?.children ?? [])];
  while (queue.length) {
    const n = queue.shift();
    if (seen.has(n)) continue;
    seen.add(n);
    const node = tree.get(n);
    if (node?.state === 'OPEN') out.add(n);
    queue.push(...(node?.children ?? []));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * What `check` should say about one CLOSED board item, or `null` where it is
 * fine. The failure NAMES the open descendants, because the fix is "reopen this
 * one" and a message that only asserts a violation turns that into a hunt
 * through a tree the reader cannot see.
 *
 * Every closed ancestor above the same open issue reports separately, and that
 * is correct rather than noisy: each one is individually hiding the family, and
 * each one individually has to be reopened.
 *
 * THE BOUNDARY, twice over. This is only ever asked about items on the BOARD
 * (`check` walks `loadItems`), so a closed issue that was never added to the
 * board is invisible to the rule however much open work hangs off it — the
 * `Hierarchies` view cannot show it either, so the two blind spots are the same
 * one. And a message names at most the first `NAMED` descendants before it
 * falls back to counting: long enough to act on, short enough not to bury the
 * other failures in a run.
 */
export function closedAboveOpenWorkMessage(item, tree) {
  if (item?.state !== 'CLOSED') return null;
  const open = openDescendants(item.number, tree);
  if (open.length === 0) return null;

  const shown = open.slice(0, NAMED).map((n) => `#${n}`);
  const rest = open.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} and ${rest} more` : listOf(shown);

  return (
    `#${item.number} is closed with ${list} still open beneath it — ` +
    `a closed parent reads as 100% done, so the whole family drops out of the Hierarchies ` +
    `view while the work is live: \`gh issue reopen ${item.number}\`, or finish what is under it`
  );
}

/** `a`, `a and b`, `a, b and c` — the readable form for a short list. */
function listOf(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
