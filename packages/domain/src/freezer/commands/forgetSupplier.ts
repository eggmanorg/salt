import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';
import { supplierKey } from './supplierRules.js';

export interface ForgetSupplierInput {
  readonly supplier: string;
  readonly now: string;
}

/**
 * Take a place off the remembered list — a typo, usually. No item changes: an
 * item keeps its `purchasedFrom`, and typing the place again remembers it again.
 * Returns the SAME config when the list does not have it, so nothing is written.
 */
export function forgetSupplier(
  config: FreezerConfig,
  input: ForgetSupplierInput,
): ReadResult<FreezerConfig, DomainError> {
  const key = supplierKey(input.supplier);
  const suppliers = config.suppliers.filter((s) => supplierKey(s) !== key);
  if (suppliers.length === config.suppliers.length) return success(config);
  return success({ ...config, updatedAt: input.now, suppliers });
}
