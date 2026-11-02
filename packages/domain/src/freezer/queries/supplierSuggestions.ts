import type { FreezerConfig } from '../entities/FreezerConfig.js';
import { matchingIn, spellingIn } from '../commands/supplierRules.js';

/**
 * The remembered places whose name contains what has been typed, compared
 * case-insensitively, in alphabetical order; everything when nothing is typed.
 */
export function supplierSuggestions(
  config: Pick<FreezerConfig, 'suppliers'>,
  typed: string,
): string[] {
  return matchingIn(config.suppliers, typed);
}

/** The same over the remembered containers. */
export function containerSuggestions(
  config: Pick<FreezerConfig, 'containers'>,
  typed: string,
): string[] {
  return matchingIn(config.containers, typed);
}

/**
 * How a typed place is saved: the remembered spelling when the list has it
 * ("swaledale" → "Swaledale"), otherwise the place as typed, trimmed; `null`
 * when blank.
 */
export function supplierSpelling(config: FreezerConfig, typed: string | null): string | null {
  return spellingIn(config.suppliers, typed);
}

/** The same for a typed container ("deli POT" → "Deli pot"). */
export function containerSpelling(config: FreezerConfig, typed: string | null): string | null {
  return spellingIn(config.containers, typed);
}
