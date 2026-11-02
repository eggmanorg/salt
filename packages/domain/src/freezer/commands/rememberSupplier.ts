import { success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';
import { rememberIn } from './supplierRules.js';

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
  const suppliers = rememberIn(config.suppliers, purchasedFrom);
  return success(suppliers === null ? config : { ...config, updatedAt: now, suppliers });
}

/** The same for what an item's packs are in, on the remembered containers. */
export function rememberContainer(
  config: FreezerConfig,
  container: string | null,
  now: string,
): ReadResult<FreezerConfig, DomainError> {
  const containers = rememberIn(config.containers, container);
  return success(containers === null ? config : { ...config, updatedAt: now, containers });
}
