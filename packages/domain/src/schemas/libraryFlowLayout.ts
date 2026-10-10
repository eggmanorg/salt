// The layered layout behind `salt-flow` (issue #1663 Phase 4) — pure, so the
// geometry a flow chart is drawn from is pinned in `libraryFlowLayout.test.ts`
// rather than read off a rendered drawing.
//
// A flow chart runs top to bottom. Each box sits in a ROW one below the lowest
// box with an arrow into it (the longest path from a box with none), so every
// arrow points down. An arrow that skips rows is carried through each row it
// crosses by a PASS slot — a vertical line where a box would be — so every
// drawn segment joins two neighbouring rows, and the renderer only ever draws
// row-to-row strips. Within a row, slots are ordered by the mean position of
// what feeds them (one downward sweep), which keeps most arrows from crossing;
// crossings are not forbidden, only made rare.
//
// What the layout refuses, as a sentence: a box named twice, an arrow to or
// from a box that does not exist, an arrow from a box to itself, two arrows
// joining the same pair, an arrow leading back up (a loop), and a row holding
// more than `widthCap` slots — boxes and passes together — which is what a
// 360px phone can hold side by side.

/** A box, keyed by the name arrows use to point at it. */
export interface LibraryFlowKeyed {
  readonly key: string;
}

/** A row slot: a box, or `null` where an arrow passes through the row. */
export interface LibraryFlowSlot<N> {
  readonly node: N | null;
}

/** A segment from slot `from` of one row to slot `to` of the next; `label` rides on an arrow's first segment. */
export interface LibraryFlowLink {
  readonly from: number;
  readonly to: number;
  readonly label?: string | undefined;
}

export interface LibraryFlowRow<N> {
  readonly slots: readonly LibraryFlowSlot<N>[];
  /** Segments from this row down to the next. Empty on the last row. */
  readonly links: readonly LibraryFlowLink[];
}

export type LibraryFlowLayout<N> =
  | { readonly ok: true; readonly rows: readonly LibraryFlowRow<N>[] }
  | { readonly ok: false; readonly problem: string };

interface Entry {
  readonly node: number | null;
  /** Mean slot position of the entries feeding this one, for ordering. */
  centre: number;
}

interface Segment {
  readonly row: number;
  readonly from: Entry;
  readonly to: Entry;
  readonly label?: string | undefined;
}

export function layoutLibraryFlow<N extends LibraryFlowKeyed>(
  nodes: readonly N[],
  edges: readonly { from: string; to: string; label?: string | undefined }[],
  widthCap: number,
): LibraryFlowLayout<N> {
  const fail = (problem: string) => ({ ok: false, problem }) as const;

  const index = new Map<string, number>();
  for (const [i, n] of nodes.entries()) {
    if (index.has(n.key)) return fail(`two boxes are called "${n.key}"`);
    index.set(n.key, i);
  }

  const out: number[][] = nodes.map(() => []);
  const indegree = nodes.map(() => 0);
  const joined = new Set<string>();
  for (const [e, edge] of edges.entries()) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined) return fail(`an arrow starts at "${edge.from}", which is not a box`);
    if (b === undefined) return fail(`an arrow ends at "${edge.to}", which is not a box`);
    if (a === b) return fail(`an arrow leads from "${edge.from}" to itself`);
    const pair = `${a}>${b}`;
    if (joined.has(pair)) return fail(`two arrows join "${edge.from}" to "${edge.to}"`);
    joined.add(pair);
    out[a]!.push(e);
    indegree[b]! += 1;
  }

  // Longest path from a box with no arrow in, in topological order (Kahn).
  const layer = nodes.map(() => 0);
  const queue = nodes.flatMap((_, i) => (indegree[i] === 0 ? [i] : []));
  let placed = 0;
  while (placed < queue.length) {
    const a = queue[placed++]!;
    for (const e of out[a]!) {
      const b = index.get(edges[e]!.to)!;
      layer[b] = Math.max(layer[b]!, layer[a]! + 1);
      if (--indegree[b]! === 0) queue.push(b);
    }
  }
  if (placed < nodes.length) {
    return fail('an arrow leads back up: a flow chart runs top to bottom, so it cannot loop');
  }

  const rows: Entry[][] = Array.from({ length: Math.max(...layer) + 1 }, () => []);
  const entryOf = nodes.map((_, i) => {
    const entry: Entry = { node: i, centre: 0 };
    rows[layer[i]!]!.push(entry);
    return entry;
  });
  const segments: Segment[] = [];
  for (const edge of edges) {
    const a = index.get(edge.from)!;
    const b = index.get(edge.to)!;
    let from = entryOf[a]!;
    for (let row = layer[a]!; row < layer[b]!; row++) {
      let to = entryOf[b]!;
      if (row + 1 < layer[b]!) {
        to = { node: null, centre: 0 };
        rows[row + 1]!.push(to);
      }
      segments.push({ row, from, to, label: row === layer[a] ? edge.label : undefined });
      from = to;
    }
  }

  // One downward sweep: order each row by where its feeders sit in the row
  // above. Every entry below the first row has at least one feeder (a box
  // there is one below the lowest box feeding it; a pass is fed by its arrow).
  for (let r = 1; r < rows.length; r++) {
    const above = rows[r - 1]!;
    for (const entry of rows[r]!) {
      const feeders = segments.filter((s) => s.to === entry).map((s) => above.indexOf(s.from));
      entry.centre = feeders.reduce((sum, p) => sum + p, 0) / feeders.length;
    }
    // Array.prototype.sort is stable, so ties keep the order written.
    rows[r]!.sort((x, y) => x.centre - y.centre);
  }

  const widest = rows.findIndex((row) => row.length > widthCap);
  if (widest !== -1) {
    return fail(
      `row ${widest + 1} needs ${rows[widest]!.length} boxes and arrows side by side; a phone fits ${widthCap}`,
    );
  }

  return {
    ok: true,
    rows: rows.map((row, r) => ({
      slots: row.map((entry) => ({ node: entry.node === null ? null : nodes[entry.node]! })),
      links: segments
        .filter((s) => s.row === r)
        .map((s) => ({
          from: row.indexOf(s.from),
          to: rows[r + 1]!.indexOf(s.to),
          ...(s.label === undefined ? {} : { label: s.label }),
        })),
    })),
  };
}
