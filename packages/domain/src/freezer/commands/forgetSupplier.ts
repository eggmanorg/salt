import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';
import { forgetIn } from './supplierRules.js';

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
  const suppliers = forgetIn(config.suppliers, input.supplier);
  return success(suppliers === null ? config : { ...config, updatedAt: input.now, suppliers });
}

export interface ForgetContainerInput {
  readonly container: string;
  readonly now: string;
}

/** The same for a remembered container: no item changes, and typing it again brings it back. */
export function forgetContainer(
  config: FreezerConfig,
  input: ForgetContainerInput,
): ReadResult<FreezerConfig, DomainError> {
  const containers = forgetIn(config.containers, input.container);
  return success(containers === null ? config : { ...config, updatedAt: input.now, containers });
}
