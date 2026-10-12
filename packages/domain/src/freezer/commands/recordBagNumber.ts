import type { FreezerConfig } from '../entities/FreezerConfig.js';

/**
 * Move the config's mark up to a bag number an add has just used — suggested or
 * typed. Returns the SAME config — so the caller writes nothing — when `number`
 * is not above `highestNumber`, so this never lowers the mark.
 */
export function recordBagNumber(config: FreezerConfig, number: number, now: string): FreezerConfig {
  if (number <= config.highestNumber) return config;
  return { ...config, updatedAt: now, highestNumber: number };
}
