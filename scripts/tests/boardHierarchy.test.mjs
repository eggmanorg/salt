import { describe, expect, it } from 'vitest';

import { closedAboveOpenWorkMessage, openDescendants } from '../lib/boardHierarchy.mjs';

/** `{ 1: ['CLOSED', [2, 3]] }` → the `number → { state, children }` map. */
const tree = (spec) =>
  new Map(
    Object.entries(spec).map(([n, [state, children = []]]) => [Number(n), { state, children }]),
  );

const closed = (number) => ({ number, title: 'a closed issue', state: 'CLOSED' });

describe('openDescendants', () => {
  it('finds an open direct child', () => {
    expect(openDescendants(1, tree({ 1: ['CLOSED', [2]], 2: ['OPEN'] }))).toEqual([2]);
  });

  // #1458 exactly: its own child #1495 was closed, and #1529 under THAT was
  // open. Direct-children-only logic reads this family as finished, which is
  // how it vanished from the view.
  it('finds an open grandchild under a closed child, which is the case that hid #1458', () => {
    const t = tree({ 1458: ['CLOSED', [1495]], 1495: ['CLOSED', [1529]], 1529: ['OPEN'] });
    expect(openDescendants(1458, t)).toEqual([1529]);
  });

  it('follows a deep chain and collects every open node on the way down', () => {
    const t = tree({
      1: ['CLOSED', [2]],
      2: ['CLOSED', [3]],
      3: ['OPEN', [4]],
      4: ['CLOSED', [5]],
      5: ['OPEN'],
    });
    expect(openDescendants(1, t)).toEqual([3, 5]);
  });

  it('never counts the root itself, however open it is', () => {
    expect(openDescendants(1, tree({ 1: ['OPEN', [2]], 2: ['CLOSED'] }))).toEqual([]);
  });

  it('answers empty for a leaf, and for a number the fetch never returned', () => {
    expect(openDescendants(1, tree({ 1: ['CLOSED'] }))).toEqual([]);
    expect(openDescendants(99, tree({ 1: ['CLOSED', [2]], 2: ['OPEN'] }))).toEqual([]);
  });

  // The stated failure direction: a partial fetch reads as a clean tree, so the
  // rule misses findings rather than inventing them.
  it('treats a child missing from the map as a leaf of unknown state, not an open one', () => {
    expect(openDescendants(1, tree({ 1: ['CLOSED', [2, 3]], 3: ['OPEN'] }))).toEqual([3]);
  });

  // Belt-and-braces. A GitHub sub-issue link is a strict tree, so this should be
  // unreachable — the test exists so a malformed map fails `check` instead of
  // hanging it.
  it('terminates on a cycle rather than spinning', () => {
    const t = tree({ 1: ['CLOSED', [2]], 2: ['CLOSED', [3]], 3: ['OPEN', [1, 2]] });
    expect(openDescendants(1, t)).toEqual([3]);
  });
});

describe('closedAboveOpenWorkMessage', () => {
  it('fails a closed issue with an open child, and names it', () => {
    const message = closedAboveOpenWorkMessage(
      closed(1319),
      tree({ 1319: ['CLOSED', [1496]], 1496: ['OPEN'] }),
    );
    expect(message).toMatch(/#1319 is closed with #1496 still open beneath it/);
    expect(message).toMatch(/gh issue reopen 1319/);
  });

  it('names several descendants readably', () => {
    const t = tree({
      1486: ['CLOSED', [1488, 1493, 1494]],
      1488: ['OPEN'],
      1493: ['OPEN'],
      1494: ['OPEN'],
    });
    expect(closedAboveOpenWorkMessage(closed(1486), t)).toMatch(
      /closed with #1488, #1493 and #1494 still open beneath it/,
    );
  });

  // The cap is a stated boundary, not an accident: a message long enough to
  // bury the other failures in the run is its own kind of unreadable.
  it('counts the tail once a family has more open work than a message can name', () => {
    const children = Array.from({ length: 11 }, (_, i) => 200 + i);
    const t = tree({
      100: ['CLOSED', children],
      ...Object.fromEntries(children.map((n) => [n, ['OPEN']])),
    });
    const message = closedAboveOpenWorkMessage(closed(100), t);
    expect(message).toMatch(/#200, #201, #202, #203, #204, #205, #206, #207 and 3 more/);
  });

  it('passes a closed issue with nothing open under it', () => {
    const t = tree({ 1: ['CLOSED', [2]], 2: ['CLOSED', [3]], 3: ['CLOSED'] });
    expect(closedAboveOpenWorkMessage(closed(1), t)).toBeNull();
  });

  it('passes a closed leaf, which is most of the board', () => {
    expect(closedAboveOpenWorkMessage(closed(1), tree({ 1: ['CLOSED'] }))).toBeNull();
  });

  // An OPEN parent over open work is the ordinary running state of every epic
  // and every ledger. The rule is about closing, never about holding children.
  it('says nothing about an open issue, however much is open under it', () => {
    const t = tree({ 778: ['OPEN', [1423]], 1423: ['OPEN'] });
    expect(closedAboveOpenWorkMessage({ number: 778, title: 'epic', state: 'OPEN' }, t)).toBeNull();
  });

  // Each closed ancestor is separately hiding the family and each separately
  // has to be reopened, so both report. #1458 → #1495 → #1529 was exactly this.
  it('reports every closed ancestor above the same open issue, not just the nearest', () => {
    const t = tree({ 1458: ['CLOSED', [1495]], 1495: ['CLOSED', [1529]], 1529: ['OPEN'] });
    expect(closedAboveOpenWorkMessage(closed(1458), t)).toMatch(/#1458 is closed with #1529/);
    expect(closedAboveOpenWorkMessage(closed(1495), t)).toMatch(/#1495 is closed with #1529/);
  });

  it('survives an item with no state, rather than calling it a violation', () => {
    expect(
      closedAboveOpenWorkMessage({ number: 1 }, tree({ 1: ['CLOSED', [2]], 2: ['OPEN'] })),
    ).toBeNull();
  });
});
