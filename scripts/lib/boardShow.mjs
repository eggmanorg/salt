// `board.mjs show <issue>` prints one board item's fields. The formatting and
// the not-on-the-board message live here rather than in the command so they can
// be tested without a live GraphQL call, which is how every other `board*`
// helper in this directory is arranged.
//
// Why the subcommand exists at all (#1521): `/salt-campaign`'s Finish step
// records each issue's *estimated* `Size` beside the changed lines its PR
// actually delivered, which is the first thing in this repo ever to compare the
// two. The estimate is an org-project field — not in the issue body, so the
// extractor cannot see it — and until now `board.mjs` could write every field
// and read none of them back.

/** The fields `show` prints, in the order it prints them. */
export const SHOW_FIELDS = ['Queue', 'Class', 'Size', 'Status'];

/**
 * One line per field, aligned. A field the item does not carry prints as `—`
 * rather than being omitted: "this issue has no Size" is the answer the
 * calibration line needs, and a missing row would read as a failed lookup.
 */
export function showLines(item) {
  const value = {
    Queue: item.queue,
    Class: item.class,
    Size: item.size,
    Status: item.status,
  };
  const width = Math.max(...SHOW_FIELDS.map((f) => f.length));
  return [
    `#${item.number} ${item.title}`,
    ...SHOW_FIELDS.map((f) => `${f.padEnd(width)}  ${value[f] || '—'}`),
  ];
}

/**
 * What to say when the issue is not a board item. It is a `die` message, so it
 * has to name the fix: `add` is the subcommand that would put it there, and an
 * issue that was never triaged is the overwhelmingly likely cause.
 */
export const notOnBoardMessage = (number) =>
  `#${number} is not on the board — nothing to show; \`add\` puts it there`;
