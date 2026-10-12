import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';
import { supplierKey } from './supplierRules.js';

/**
 * Add the place an item was bought from to the remembered list. Returns the
 * SAME config — so the caller writes nothing — when the place is blank or the
 * list already has it, compared trimmed and case-insensitively; the entry there
 * keeps its first spelling.
 */
export function rememberSupplier(
  config: FreezerConfig,
  purchasedFrom: string | null,
  now: string,
): ReadResult<FreezerConfig, DomainError> {
  const place = purchasedFrom?.trim() ?? '';
  const key = supplierKey(place);
  if (!place || config.suppliers.some((s) => supplierKey(s) === key)) return success(config);
  return success({ ...config, updatedAt: now, suppliers: [...config.suppliers, place] });
}
