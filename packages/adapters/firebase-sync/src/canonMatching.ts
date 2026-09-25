import type { MatchOrCreateInput, MatchOrCreateResult } from '@salt/domain';
import type { CanonicaliseRecipeIngredientsInput, PersistenceOutcome } from '@salt/domain/schemas';
import { failure, type DomainError, type ReadResult } from '@salt/shared-types';
import { classifyCallableError } from './callableErrors.js';
import { callFunction, invokeCallable } from './callFunction.js';

// The CF returns the Result envelope from matchOrCreate verbatim; the client
// just forwards it. Transport-level failures (auth, network) become a fresh
// Failure with the equivalent DomainError.
type WireResult =
  | { readonly kind: 'ok'; readonly value: MatchOrCreateResult }
  | { readonly kind: 'err'; readonly error: DomainError };

// `invokeCallable` rather than `callFunction`, and that is the exception Rule 10
// names rather than an oversight: the CF already answers with a `Result`, and
// this returns it VERBATIM. `callFunction` would wrap it, so an `err` from the
// matcher would arrive as `{kind:'ok', value:{kind:'err', …}}` — a failure the
// caller reads as a success. Only the TRANSPORT failure is classified here.
//
// `traceparent` (issue #362) rides on the payload; the how and why are written
// once, at `withTraceparent` in callFunction.ts. The arg is optional, so
// existing callers stay backward-compatible.
export async function callMatchOrCreate(
  input: MatchOrCreateInput,
  traceparent?: string,
): Promise<ReadResult<MatchOrCreateResult, DomainError>> {
  try {
    return await invokeCallable<MatchOrCreateInput, WireResult>({
      name: 'matchOrCreateCanon',
      input,
      traceparent,
    });
  } catch (err) {
    return failure(classifyCallableError(err));
  }
}

type WireBatchResult = ReadResult<MatchOrCreateResult, DomainError>[];
type WireBatchEnvelope = { results: WireBatchResult; persistence: PersistenceOutcome };

// The batch canon matcher. Since issue #1434 the input can also carry the
// IDENTITY of what is being matched — a `recipeId` and a per-item
// `ingredientId` — and when it does, the function records `canonId`/`matchState`
// onto that recipe itself rather than returning them for the caller to write.
//
// The same `recipeId` picks the answer's shape (issue #1601): with it, the
// function answers `{ results, persistence }` so the caller can tell whether the
// recipe was updated; without it, the bare results array. The overloads carry
// that into the type, so a content-only caller (`matchIngredient`) keeps reading
// an array and cannot mistake it for the envelope. No branch here — the value is
// forwarded as the function sent it.
export async function callCanonicaliseRecipeIngredients(
  input: CanonicaliseRecipeIngredientsInput & { recipeId: string },
  traceparent?: string,
): Promise<ReadResult<WireBatchEnvelope, DomainError>>;
export async function callCanonicaliseRecipeIngredients(
  input: CanonicaliseRecipeIngredientsInput & { recipeId?: undefined },
  traceparent?: string,
): Promise<ReadResult<WireBatchResult, DomainError>>;
export async function callCanonicaliseRecipeIngredients(
  input: CanonicaliseRecipeIngredientsInput,
  traceparent?: string,
): Promise<ReadResult<WireBatchResult | WireBatchEnvelope, DomainError>> {
  return callFunction<CanonicaliseRecipeIngredientsInput, WireBatchResult | WireBatchEnvelope>({
    name: 'canonicaliseRecipeIngredients',
    input,
    traceparent,
    // The function declares 120 s (`cloud-functions/src/index.ts:256`) against
    // the client's 70 s default. A whole recipe's ingredients go through the
    // matcher here, so the long tail is the ordinary case rather than the
    // exception (#928, B2-010).
    timeoutMs: 120_000,
  });
}

// Clears a canon item's icon server-side (issue #148), re-firing the
// onCanonItemWritten trigger so the icon branch regenerates. Used for both the
// "regenerate" and "unhide" actions (both set thumbnail → null). An optional
// `hint` is a one-shot additive steer for the next generation.
export async function callRegenerateCanonIcon(
  canonId: string,
  hint?: string,
): Promise<ReadResult<void, DomainError>> {
  return callFunction<{ canonId: string; hint?: string }, { ok: true }, void>({
    name: 'regenerateCanonIcon',
    // Trimmed BEFORE the emptiness test: a hint of whitespace is no hint, and
    // must leave the field off the payload rather than send a blank steer.
    input: hint && hint.trim() ? { canonId, hint: hint.trim() } : { canonId },
    project: () => undefined,
  });
}
