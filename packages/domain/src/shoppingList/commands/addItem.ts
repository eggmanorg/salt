import { ErrorCode, failure, success } from '@salt/shared-types';
import type { DomainError, ReadResult } from '@salt/shared-types';
import type { MatchState, ShoppingListItem } from '../entities/ShoppingListItem.js';
import type { SourceRef } from '../entities/SourceRef.js';
import type { IdGenerator } from '../ports/IdGenerator.js';
import type { FormDemand } from '../../productForm/index.js';

export interface AddItemInput {
  readonly rawText: string;
  readonly notes?: string;
  readonly source: SourceRef;
  readonly now: string;
  /** Pre-set canonId when adding an already-matched item (e.g. from a recipe). */
  readonly canonId?: string | null;
  /** Pre-set matchState; defaults to 'pending'. */
  readonly matchState?: MatchState;
  readonly amount?: number;
  readonly unit?: string;
  /**
   * Per-form demand for a product-form parent row (issue #501) — one entry per
   * form of this parent the source recipe demanded, each with its own unrounded
   * parent-count. Omitted for every non-product-form add.
   */
  readonly formDemand?: readonly FormDemand[];
  /**
   * The recipe's own wording for the ingredient line(s) behind a product-form row
   * (issue #528) — carried through so the list can show what the parent-count is
   * for. Display only; nothing branches on it. Omitted for every non-form add.
   */
  readonly originalText?: readonly string[];
  /**
   * The recipe's original non-metric measure for this line, verbatim ("6 cloves").
   * Display only. Omitted for manual adds and for any add at scaled servings,
   * where the frozen string would contradict the scaled amount.
   */
  readonly measureNote?: string;
  /**
   * The grams a counted recipe row stands for, scaled (issue #1643). Display only.
   * Omitted for metric rows, product-form rows and manual adds.
   */
  readonly weightGrams?: number;
  /** Flag this item for verification on the list (recipe-add "check" rows). Defaults false. */
  readonly needsCheck?: boolean;
}

export function addItem(
  items: readonly ShoppingListItem[],
  input: AddItemInput,
  ids: IdGenerator,
): ReadResult<ShoppingListItem[], DomainError> {
  const rawText = input.rawText.trim();
  if (!rawText) {
    return failure({ kind: 'ValidationError', code: ErrorCode.INVALID_ITEM_RAW_TEXT });
  }
  const base = {
    id: ids.newItemId(),
    rawText,
    notes: input.notes?.trim() ?? '',
    sources: [input.source],
    canonId: input.canonId ?? null,
    matchState: input.matchState ?? ('pending' as const),
    checked: false,
    needsCheck: input.needsCheck ?? false,
    schemaVersion: 1 as const,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const newItem: ShoppingListItem = {
    ...base,
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    ...(input.formDemand !== undefined ? { formDemand: [...input.formDemand] } : {}),
    ...(input.originalText !== undefined ? { originalText: [...input.originalText] } : {}),
    ...(input.measureNote !== undefined ? { measureNote: input.measureNote } : {}),
    ...(input.weightGrams !== undefined ? { weightGrams: input.weightGrams } : {}),
  };
  return success([...items, newItem]);
}
