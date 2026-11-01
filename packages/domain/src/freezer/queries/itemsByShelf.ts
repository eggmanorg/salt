import type { Freezer, FreezerConfig } from '../entities/FreezerConfig.js';
import type { FreezerItem } from '../entities/FreezerItem.js';

export interface ShelfStock {
  /** The shelf label, or `null` for the one group of a freezer with no shelves. */
  readonly shelf: string | null;
  /** By number. */
  readonly items: readonly FreezerItem[];
}

export interface FreezerStock {
  readonly freezer: Freezer;
  /** In the freezer's shelf order. */
  readonly shelves: readonly ShelfStock[];
  /**
   * Items in this freezer with no shelf yet (`shelf: null` in a freezer that has
   * shelves), by number — always empty for a freezer with none, whose one group
   * in `shelves` holds them.
   */
  readonly unshelved: readonly FreezerItem[];
  /** How many items are in it — on its shelves and not yet on one, together. */
  readonly count: number;
}

export interface ItemsByShelf {
  /**
   * Items whose freezer or shelf the setup no longer has — removed, or a shelf
   * relabelled — by number. Computed here, in memory: removing a place never
   * rewrites or deletes the stock on it, and moving the item is what files it
   * again.
   */
  readonly notPlaced: readonly FreezerItem[];
  /** Every freezer in the setup, in setup order, empty ones included. */
  readonly freezers: readonly FreezerStock[];
}

function byNumber(a: FreezerItem, b: FreezerItem): number {
  return a.number - b.number;
}

/** File every item under its freezer and shelf, or under Not placed. */
export function itemsByShelf(items: readonly FreezerItem[], config: FreezerConfig): ItemsByShelf {
  const placed = new Set<FreezerItem>();
  const freezers = config.freezers.map((freezer): FreezerStock => {
    const labels: readonly (string | null)[] =
      freezer.shelves.length > 0 ? freezer.shelves : [null];
    const shelves = labels.map((shelf): ShelfStock => {
      const on = items.filter((i) => i.freezerId === freezer.id && i.shelf === shelf);
      for (const i of on) placed.add(i);
      return { shelf, items: [...on].sort(byNumber) };
    });
    const unshelved =
      freezer.shelves.length > 0
        ? items.filter((i) => i.freezerId === freezer.id && i.shelf === null).sort(byNumber)
        : [];
    for (const i of unshelved) placed.add(i);
    return {
      freezer,
      shelves,
      unshelved,
      count: shelves.reduce((n, s) => n + s.items.length, unshelved.length),
    };
  });
  return { notPlaced: items.filter((i) => !placed.has(i)).sort(byNumber), freezers };
}

/** Every item, the longest in first; items added at the same moment by number. */
export function oldestFirst(items: readonly FreezerItem[]): FreezerItem[] {
  return [...items].sort((a, b) =>
    a.addedAt === b.addedAt ? byNumber(a, b) : a.addedAt < b.addedAt ? -1 : 1,
  );
}
