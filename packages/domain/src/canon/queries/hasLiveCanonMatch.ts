/**
 * Has matching RESOLVED for this item — i.e. is it pointing at a canon and done
 * waiting? True for `matched` and for `needs_approval`, false for `pending` and
 * `failed`.
 *
 * `needs_approval` is used-but-flagged: the match resolves live and the item
 * behaves exactly like a matched one; the flag is a review queue, never a gate on
 * use. Anything asking "is this still waiting?" — grouping it into an aisle,
 * showing a spinner, playing the match reveal — must use THIS, not a bare
 * `=== 'matched'`. Re-deriving it as `=== 'matched'` is what made the shopping
 * list's match reveal silently never fire for a needs_approval item: it left the
 * "Other" bucket (which asks via `hasLiveCanonMatch`) while every presentation
 * gate still read it as unmatched.
 */
export function isResolvedMatchState(matchState: string): boolean {
  return matchState === 'matched' || matchState === 'needs_approval';
}

/**
 * `canonIds` needs only membership, so a `ReadonlySet<string>` of live ids and a
 * `ReadonlyMap<string, CanonItem>` keyed by them both serve.
 */
export function hasLiveCanonMatch(
  ref: { matchState: string; canonId: string | null },
  canonIds: Pick<ReadonlySet<string>, 'has'>,
): boolean {
  return isResolvedMatchState(ref.matchState) && ref.canonId !== null && canonIds.has(ref.canonId);
}
