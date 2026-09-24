// `show` is the read half of a loop that had only a write half: every spec
// command sets `Size` and nothing has ever read one back, which is why no
// estimate has ever been corrected (docs/issue-board.md → `Size`).
//
// What is tested here is the output shape and the not-on-the-board path, the
// same way every other `board*` test covers a pure helper rather than the CLI.
// The GraphQL selection itself is not testable without a live board, so the
// last test below pins it from the source instead — that `Class` and `Size` are
// actually asked for. Without it, `showLines` would faithfully print `—` for
// both on every issue and every test here would still pass.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ITEM_SELECTION } from '../lib/boardItemLookup.mjs';
import { SHOW_FIELDS, notOnBoardMessage, showLines } from '../lib/boardShow.mjs';

const item = (fields = {}) => ({
  number: 1521,
  title: 'a defect',
  queue: 'Now',
  class: 'Chore',
  size: 'L',
  status: 'In progress',
  ...fields,
});

describe('showLines', () => {
  it('leads with the issue, then one line per field', () => {
    const lines = showLines(item());
    expect(lines[0]).toBe('#1521 a defect');
    expect(lines).toHaveLength(1 + SHOW_FIELDS.length);
    expect(lines.slice(1).join('\n')).toBe(
      ['Queue   Now', 'Class   Chore', 'Size    L', 'Status  In progress'].join('\n'),
    );
  });

  // The calibration line this exists for asks "what was this estimated at?".
  // An issue with no `Size` has to answer that, not go quiet — a dropped row
  // would read as a lookup that failed rather than a field nobody filled in.
  it('prints an em dash for a field the item does not carry', () => {
    const lines = showLines(item({ size: null, class: undefined }));
    expect(lines).toHaveLength(1 + SHOW_FIELDS.length);
    expect(lines).toContain('Size    —');
    expect(lines).toContain('Class   —');
  });

  it('prints Size, which is the field the calibration loop needs', () => {
    expect(SHOW_FIELDS).toContain('Size');
  });
});

describe('notOnBoardMessage', () => {
  it('names the issue and the subcommand that would fix it', () => {
    const message = notOnBoardMessage(1521);
    expect(message).toMatch(/#1521/);
    expect(message).toMatch(/not on the board/);
    expect(message).toMatch(/`add`/);
  });
});

describe('board.mjs actually fetches the fields show prints', () => {
  const src = readFileSync(
    path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'board.mjs'),
    'utf8',
  );

  // Before #1521 the item query selected Queue, Status and Blocked by only.
  // Adding `show` without widening it would have printed a confident `—`.
  // The selection lives in `lib/boardItemLookup.mjs` so the bulk scan and the
  // lagging-scan fallback share it; the second test pins that the scan uses it.
  it.each(['Class', 'Size'])('the item query selects %s', (field) => {
    expect(ITEM_SELECTION).toMatch(
      new RegExp(`${field.toLowerCase()}:fieldValueByName\\(name:"${field}"\\)`),
    );
  });

  it('both item reads select through ITEM_SELECTION', () => {
    expect(src.split('${ITEM_SELECTION}')).toHaveLength(3);
  });

  // #1564 fixed six lookup-by-number call sites (add, show, set, start, pr,
  // rollup) that scanned `items` alone and so missed anything the lagging
  // `ProjectV2.items` connection hadn't caught up on yet — see
  // `lib/boardItemLookup.mjs`'s header. Nothing else pinned that the fix
  // stays applied: reverting any one call site back to a scan-only
  // `.find`/`.some` on `.number ===` left every other test green. Proven by
  // temporarily reverting `cmdShow` to `loadItems(project).find((i) =>
  // i.number === number)` — this test went red — then restoring it.
  it('every lookup by issue number goes through itemFor, never a bare scan', () => {
    expect(src).not.toMatch(/\.(?:find|some)\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.number\s*===/);
  });

  it('itemFor is called once per command that looks up an item by number', () => {
    expect(src.match(/\bitemFor\(/g)).toHaveLength(6);
  });

  it('dispatches the show subcommand and lists it in the usage text', () => {
    expect(src).toMatch(/command === 'show'/);
    expect(src).toMatch(/board\.mjs show <issue>/);
  });
});
