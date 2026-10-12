import type { FreezerConfig } from '../entities/FreezerConfig.js';
import { supplierKey } from '../commands/supplierRules.js';

/**
 * The remembered places whose name contains what has been typed, compared
 * case-insensitively, in alphabetical order; everything when nothing is typed.
 */
export function supplierSuggestions(
  config: Pick<FreezerConfig, 'suppliers'>,
  typed: string,
): string[] {
  const q = supplierKey(typed);
  return [...config.suppliers]
    .filter((s) => supplierKey(s).includes(q))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * How a typed place is saved: the remembered spelling when the list has it
 * ("swaledale" → "Swaledale"), otherwise the place as typed, trimmed; `null`
 * when blank.
 */
export function supplierSpelling(config: FreezerConfig, typed: string | null): string | null {
  const place = typed?.trim() ?? '';
  if (!place) return null;
  const key = supplierKey(place);
  return config.suppliers.find((s) => supplierKey(s) === key) ?? place;
}
