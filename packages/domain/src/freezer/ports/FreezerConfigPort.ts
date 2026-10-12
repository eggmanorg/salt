import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerConfig } from '../entities/FreezerConfig.js';

export interface FreezerConfigPort {
  load(): Promise<ReadResult<FreezerConfig | null, DomainError>>;
  save(config: FreezerConfig): Promise<ReadResult<void, DomainError>>;
}
