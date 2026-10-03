import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult, ShoppingBehavior, CanonItemUnit } from '@salt/shared-types';
import type { CanonItem } from '../entities/CanonItem.js';
import type { IdGenerator } from '../ports/IdGenerator.js';

export interface CreateCanonItemInput {
  readonly name: string;
  readonly synonyms?: readonly string[];
  readonly aisleId?: string | null;
  readonly needs_approval?: boolean;
  readonly shoppingBehavior?: ShoppingBehavior;
  readonly largeQuantityThreshold?: number;
  readonly unit?: CanonItemUnit;
  readonly gramsPerItem?: number;
  readonly reasoning?: string;
  // The raw entry this item was minted from (issue #193). Recorded on the
  // seeded `created` pending change, and only when it differs from the name.
  readonly rawInput?: string;
}

export function createCanonItem(
  input: CreateCanonItemInput,
  ids: IdGenerator,
): ReadResult<CanonItem, DomainError> {
  const name = input.name.trim();
  if (!name) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_CANON_NAME });
  }
  const needsApproval = input.needs_approval ?? true;
  const rawInput = input.rawInput?.trim();
  return success({
    id: ids.newCanonId(),
    schemaVersion: 5,
    name,
    synonyms: (input.synonyms ?? []).map((s) => s.trim()).filter((s) => s.length > 0),
    aisleId: input.aisleId ?? null,
    thumbnail: null,
    embedding: null,
    needs_approval: needsApproval,
    shoppingBehavior: input.shoppingBehavior ?? 'needed',
    ...(input.largeQuantityThreshold !== undefined
      ? { largeQuantityThreshold: input.largeQuantityThreshold }
      : {}),
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    ...(input.gramsPerItem !== undefined ? { gramsPerItem: input.gramsPerItem } : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    // Seed the `created` record ONLY when the item lands flagged (issue #193).
    // An item created already-approved (a deliberate hand-made entry, a
    // migration) has nothing pending, and an empty key must never be written.
    // `rawInput` is carried only when it differs from the name — a literal
    // compare, matching the synonym_added rule.
    ...(needsApproval
      ? {
          pendingChanges: [
            {
              kind: 'created' as const,
              ...(rawInput && rawInput !== name ? { rawInput } : {}),
            },
          ],
        }
      : {}),
    updatedAt: '',
  });
}
