import type { DomainError, ReadResult } from '@salt/shared-types';
import type { FreezerItem } from '../entities/FreezerItem.js';

// The freezer's stock (issue #1684): each item written whole at its number, and
// removed by it. Reading is a live subscription in the adapter.
export interface FreezerStorePort {
  saveItem(item: FreezerItem): Promise<ReadResult<void, DomainError>>;
  deleteItem(number: number): Promise<ReadResult<void, DomainError>>;
}
