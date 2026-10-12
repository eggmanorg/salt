const DAY_MS = 24 * 60 * 60 * 1000;

export interface ItemAge {
  /** Whole days since it went in. */
  readonly days: number;
  /** Whole weeks since it went in. */
  readonly weeks: number;
}

/**
 * How long an item has been in, from its `addedAt` to the caller's `now` (both
 * ISO timestamps). Pure: there is no clock in the domain, so the caller supplies
 * `now`. An `addedAt` ahead of `now` — another device's clock running fast — is
 * zero, not a negative age.
 */
export function itemAge(addedAt: string, now: string): ItemAge {
  const elapsed = Date.parse(now) - Date.parse(addedAt);
  const days = Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / DAY_MS)) : 0;
  return { days, weeks: Math.floor(days / 7) };
}
