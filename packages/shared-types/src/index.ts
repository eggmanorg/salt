// ──────────────────────────────────────────────────────────────────────────
// Result types — the cross-boundary error contract from
// docs/salt-architecture.md §7. Domain commands and adapter functions
// return one of these; they never throw for operational failures.
// ──────────────────────────────────────────────────────────────────────────

export interface Success<T> {
  readonly kind: 'ok';
  readonly value: T;
}

export interface Failure<E> {
  readonly kind: 'err';
  readonly error: E;
}

// Conflict is reserved for adapter-level revision mismatches on
// recipe/canon writes (see §7.4). Domain commands never return Conflict.
export interface Conflict<T> {
  readonly kind: 'conflict';
  readonly local: T;
  readonly remote: T;
}

// ReadResult — for queries and reads (never produces Conflict).
export type ReadResult<T, E> = Success<T> | Failure<E>;

// WriteResult — for sync-time writes that may detect a revision mismatch.
export type WriteResult<T, E> = Success<T> | Failure<E> | Conflict<T>;

// Result — alias for the general (write-shaped) form. Domain commands that
// can never produce a Conflict should declare ReadResult to make the
// no-conflict guarantee part of the type.
export type Result<T, E> = WriteResult<T, E>;

export function success<T>(value: T): Success<T> {
  return { kind: 'ok', value };
}

export function failure<E>(error: E): Failure<E> {
  return { kind: 'err', error };
}

export function conflict<T>(local: T, remote: T): Conflict<T> {
  return { kind: 'conflict', local, remote };
}

// ──────────────────────────────────────────────────────────────────────────
// DomainError — the closed set of error categories from §7.2.
// Adapters normalise Firebase/IndexedDB/network errors into these.
// Domain commands return ValidationError on rule violations.
// ──────────────────────────────────────────────────────────────────────────

export type DomainError =
  | { readonly kind: 'AuthError'; readonly reason: 'unauthenticated' | 'forbidden' | 'expired' }
  | {
      readonly kind: 'NotFound';
      readonly resource:
        | 'recipe'
        | 'canon'
        | 'shopping-list'
        | 'shoppingList'
        | 'shoppingListItem'
        | 'workspace'
        | 'aisle'
        | 'equipment'
        | 'kitchenTool'
        // A product-form record (issue #892). Added when the image-prompt
        // callable gained a not-found arm and a form was the one family with no
        // honest resource name to report itself as.
        | 'productForm';
      readonly id: string;
    }
  | {
      readonly kind: 'NetworkError';
      readonly reason: 'offline' | 'unreachable' | 'transient';
    }
  | {
      readonly kind: 'StorageError';
      readonly reason: 'unavailable' | 'quota-exceeded' | 'corruption';
    }
  | {
      readonly kind: 'SyncError';
      readonly reason: 'push-failed' | 'pull-failed' | 'invalid-revision' | 'manifest-mismatch';
    }
  | { readonly kind: 'ConflictError' }
  | { readonly kind: 'ValidationError'; readonly code: ErrorCode; readonly message?: string };

// ──────────────────────────────────────────────────────────────────────────
// Shared enums and validation codes
// ──────────────────────────────────────────────────────────────────────────
//
// NO DOCUMENT-SHAPED TYPE BELONGS HERE (issue #932). `CanonItemDTO`, `AisleDTO`
// and `AisleListDTO` used to, drifted two schema versions behind their schemas
// (`schemaVersion: 3` against `CanonItemSchema`'s `z.literal(5)`), were imported
// by nothing, and were the first thing a grep for `CanonItem` found. Rule 9
// forbids this package importing `@salt/domain`, so a document type here can
// never be derived from its schema and can only drift. Document shapes live in
// `@salt/domain/schemas`. The two enums below stay because they are shared
// vocabulary with real importers, not document shapes.
//
// SINGLE SOURCE FOR THE VOCABULARY (issue #1145). Each list used to be typed
// out as a union here, and again — as an inline `z.enum([...])` array literal —
// at every one of the eleven schema sites in `packages/domain/src/schemas/`
// that validate it. The `as const` tuple below is now the one place either
// list is written; `ShoppingBehavior`/`CanonItemUnit` are derived from it here,
// and the domain schemas derive their `z.enum` from it too (Phase 4). Rule 9 is
// why the tuple lives here rather than in domain: both types have ~40 real
// importers across `domain`, `web-pwa` services and `.svelte` admin pages, and
// this package cannot import `@salt/domain` to read it back out of a schema.
export const SHOPPING_BEHAVIORS = ['stocked', 'check', 'needed'] as const;
export type ShoppingBehavior = (typeof SHOPPING_BEHAVIORS)[number];

export const CANON_ITEM_UNITS = ['g', 'ml', 'count'] as const;
export type CanonItemUnit = (typeof CANON_ITEM_UNITS)[number];

export const ErrorCode = {
  INVALID_CANON_NAME: 'INVALID_CANON_NAME',
  INVALID_PRODUCT_FORM: 'INVALID_PRODUCT_FORM',
  INVALID_AISLE_NAME: 'INVALID_AISLE_NAME',
  DUPLICATE_AISLE_NAME: 'DUPLICATE_AISLE_NAME',
  INVALID_EQUIPMENT_NAME: 'INVALID_EQUIPMENT_NAME',
  INVALID_ACCESSORY_NAME: 'INVALID_ACCESSORY_NAME',
  INVALID_RULE: 'INVALID_RULE',
  // A place's stated temperature or humidity range is back to front (#1281).
  INVALID_EQUIPMENT_ENVIRONMENT: 'INVALID_EQUIPMENT_ENVIRONMENT',
  EQUIPMENT_ACCESSORY_NOT_FOUND: 'EQUIPMENT_ACCESSORY_NOT_FOUND',
  INVALID_LIST_NAME: 'INVALID_LIST_NAME',
  INVALID_ITEM_RAW_TEXT: 'INVALID_ITEM_RAW_TEXT',
  LIST_IS_DEFAULT: 'LIST_IS_DEFAULT',
  // Refusing to write a meal-plan week we have never read: the write is a
  // full-document replace under LWW, so it would blow away the week's other
  // days (issue #639).
  WEEK_NOT_LOADED: 'WEEK_NOT_LOADED',
  // A run that could not be frozen (issue #812): the recipe has no stages to run,
  // the formula will not resolve into weights, or the time asked for is not a
  // time. Ordinary flow — somebody typed the percentages — so it crosses as a
  // ValidationError and is deliberately not reported.
  BATCH_NOT_STARTABLE: 'BATCH_NOT_STARTABLE',
  // A Draw that the server declined before spending anything (issue #877): icon
  // generation is switched off for the environment, or no description has been
  // written for this item yet. Both are expected states with a friendly message —
  // not defects — so they cross as a ValidationError and are deliberately not
  // reported.
  EQUIPMENT_ICON_NOT_DRAWABLE: 'EQUIPMENT_ICON_NOT_DRAWABLE',
  // A Revise / Start over the server refused on the payload itself (issue #885):
  // an over-long correction, or an item with no name to describe. Bad input, not
  // a defect — the page says so and leaves the description exactly as it was — so
  // it crosses as a ValidationError and is deliberately not reported.
  EQUIPMENT_BRIEF_NOT_WRITABLE: 'EQUIPMENT_BRIEF_NOT_WRITABLE',
  // A kitchen tool with nothing to call it (issue #882): a blank label, or one
  // made entirely of punctuation, which slugs to no id and so has nowhere to keep
  // its drawing. Somebody left a field empty — expected, so it crosses as a
  // ValidationError and is not reported. An id that COLLIDES with a tool already
  // in the vocabulary is a different answer and gets `ConflictError`, because the
  // caller's next move is different: reword it, or go and edit the one that
  // already exists.
  INVALID_KITCHEN_TOOL: 'INVALID_KITCHEN_TOOL',
  // A pictogram upload the server refused on the payload itself (issue #892): an
  // image past the base64 cap, or one the cropper produced nothing usable from.
  // Bad input, not a defect — the dialog says so and the old picture stays put —
  // so it crosses as a ValidationError and is deliberately not reported.
  ICON_UPLOAD_REJECTED: 'ICON_UPLOAD_REJECTED',
  // A message sent into a chat that has gone quiet (issue #1270): the composer
  // is the primary gate and is gone by the time this could fire, so this is
  // defence-in-depth, not the everyday path. Expected once "Make read-write"
  // exists to answer it, so it crosses as a ValidationError and is not reported.
  CHAT_READ_ONLY: 'CHAT_READ_ONLY',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
