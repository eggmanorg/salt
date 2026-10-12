import type { FreezerConfig } from '../entities/FreezerConfig.js';
import type { FreezerItem } from '../entities/FreezerItem.js';

/**
 * The number a new bag is offered: one more than the highest of the config's
 * mark (`highestNumber`, the highest number an add has used) and every number in
 * `items` — so a number goes on counting up past one that was removed, and a gap
 * is never filled. `items` is what the calling device holds; order does not
 * matter. Taking the items too is what serves a config written before the mark
 * existed (it reads as 0) and an add from another device this device's config
 * copy has not caught up with. The mark's own limit — a stale device can write
 * it back lower — is in docs/data-model.md → `freezerConfig.highestNumber`.
 */
export function nextBagNumber(items: readonly FreezerItem[], config: FreezerConfig): number {
  return items.reduce((highest, i) => Math.max(highest, i.number), config.highestNumber) + 1;
}
