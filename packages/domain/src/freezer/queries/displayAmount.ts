/**
 * The packs to show. A stored amount can go below zero — two devices taking the
 * last pack at once both apply their decrement — and there is no such thing as
 * minus one pack, so it shows as none.
 */
export function displayAmount(amount: number): number {
  return Math.max(amount, 0);
}
