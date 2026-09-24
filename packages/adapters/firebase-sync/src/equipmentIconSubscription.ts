import type { DomainError, ReadResult } from '@salt/shared-types';
import { ErrorCode } from '@salt/shared-types';
import {
  EquipmentIconSchema,
  EQUIPMENT_ICONS_COLLECTION,
  type EquipmentIconDoc,
  type AuthorEntryIconBriefInput,
  type DrawEquipmentIconInput,
  type DescribeEquipmentSubjectInput,
  type DescribeEquipmentSubjectOutput,
} from '@salt/domain/schemas';
import { callFunction } from './callFunction.js';
import { subscribeCollection } from './subscribeCollection.js';

// Equipment pictograms (issue #877) — the read side of the server-owned
// `equipmentIcons` collection, plus the Draw/Hide callable that writes it.
//
// The collection is client-write-denied in firestore.rules, so there is no
// upsert/delete here to match `canonSubscription`'s: the brief trigger creates
// and reconciles the documents, and every client mutation goes through a
// callable. This file holds three of those callable wrappers — `drawEquipmentIcon`
// below, `callAuthorEntryIconBrief` below that, and `setIconUpload` lives next
// door in iconUploadCallables.ts.
//
// Two of them reach `subjectBrief` and one does not, and that is the distinction
// worth carrying here rather than a count: `callDescribeEquipmentSubject` persists
// NOTHING — its sentence comes back to the caller and only a later Draw commits it
// (#1433) — while `callAuthorEntryIconBrief` writes the field on the server the
// moment it is asked. The full writer list, including the two server-side ones no
// browser can reach, is docs/canon-icons.md → "Who writes `subjectBrief`", held
// honest by `pnpm briefwriters:check`. Do not restate it here: this header did,
// and claimed nothing in this file wrote a description while
// `callAuthorEntryIconBrief` sat below it in this same file (#1519). Why an
// unaccepted revision is deliberately transient:
// `apps/cloud-functions/src/index.ts` → `describeEquipmentSubject`.

/**
 * Subscribe to every equipment icon document.
 *
 * SKIP-AND-LOG on a per-document validation failure, following
 * `subscribeCanonItems` and the list-read convention: one corrupt document must
 * not fail the whole read. Note this deliberately does NOT inherit
 * `equipmentManifestSubscription`'s posture, where a single bad item fails the
 * entire manifest — that is defensible for one document that IS the collection,
 * and wrong for a collection of independent ones. A missing icon renders as the
 * pale placeholder tile, which is a state the UI already has to handle.
 *
 * Stream-level errors still surface via `onError`.
 */
export function subscribeEquipmentIcons(
  onIcons: (icons: Map<string, EquipmentIconDoc>) => void,
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeCollection(
    {
      path: [EQUIPMENT_ICONS_COLLECTION],
      schema: EquipmentIconSchema,
      label: 'EquipmentIconSchema',
      // Keyed by the DOCUMENT id — the equipment item it belongs to, or since
      // #1465 Phase 2 the accessory id of one of that item's entries. The icon
      // document carries neither as a field, which is why the key comes from the
      // id: one map, and a caller looks up whichever id it is holding.
      project: (icon, id): [string, EquipmentIconDoc] => [id, icon],
    },
    (entries) => onIcons(new Map(entries)),
    onError,
  );
}

/**
 * Draw or hide an equipment pictogram (issue #877).
 *
 * Both actions go through this one authenticated callable because the collection
 * is client-write-denied. A DRAW carries the brief actually being drawn from —
 * the stored description, or the user's edit of it — which is the whole point of
 * the review gate: correcting the words is how you fix the picture.
 *
 * Never throws (Rule 10): every failure crosses the boundary as
 * `Failure<DomainError>`.
 */
export async function callDrawEquipmentIcon(
  input: DrawEquipmentIconInput,
): Promise<ReadResult<void, DomainError>> {
  return callFunction<DrawEquipmentIconInput, { ok: true }, void>({
    name: 'drawEquipmentIcon',
    input,
    // The function is allowed 300 s (`callables/drawEquipmentIcon.ts:61`) and
    // the callable client's own default is 70, so without this the browser
    // abandoned every draw that took longer than 70 s while the function ran on
    // and WROTE the icon — the user saw a failure for work that succeeded, and a
    // second press paid for a second picture. The worst of the ten (#928,
    // B2-010): 230 s early on a callable whose whole job takes minutes.
    timeoutMs: 300_000,
    project: () => undefined,
    // `failed-precondition` is the kill switch being off, or no description
    // written yet — both are expected states with a friendly message, not
    // defects, so they must not be reported (see the error-reporting policy).
    // An override rather than a private mapper: everything else, the
    // offline-first ordering included, stays the shared contract.
    overrides: {
      'failed-precondition': {
        kind: 'ValidationError',
        code: ErrorCode.EQUIPMENT_ICON_NOT_DRAWABLE,
      },
    },
  });
}

/**
 * Write one ENTRY's description, so it can be drawn (issue #1465, Phase 2).
 *
 * The item path never needs this — the manifest trigger authors an item's brief
 * automatically — but an entry's is authored only on request, so this is what
 * puts the `equipmentIcons/{accessoryId}` document there before Draw can refuse
 * for want of one. It takes the PAIR rather than the accessory id because the
 * words a brief is authored from depend on both: an appliance's part is
 * qualified by its appliance, a family member stands alone.
 *
 * Unlike `callDescribeEquipmentSubject` it persists, and returns nothing: the
 * description arrives through the `equipmentIcons` subscription, which is what
 * makes the words on screen the words on the document.
 *
 * Never throws (Rule 10): every failure crosses the boundary as
 * `Failure<DomainError>`. `not-found` and `failed-precondition` are expected
 * states with a friendly message — the entry was deleted from another device, or
 * the manifest could not be read — so both cross as `ValidationError` and are
 * deliberately not reported.
 */
export async function callAuthorEntryIconBrief(
  input: AuthorEntryIconBriefInput,
): Promise<ReadResult<void, DomainError>> {
  return callFunction<AuthorEntryIconBriefInput, { ok: true }, void>({
    name: 'authorEntryIconBrief',
    input,
    // The function declares 90 s, sized around the flow's own 55 s
    // `withAiTimeout`, exactly as `describeEquipmentSubject` does. 70 — the
    // callable client's default — would have given up first.
    timeoutMs: 90_000,
    project: () => undefined,
    overrides: {
      'not-found': {
        kind: 'ValidationError',
        code: ErrorCode.EQUIPMENT_BRIEF_NOT_WRITABLE,
      },
      'failed-precondition': {
        kind: 'ValidationError',
        code: ErrorCode.EQUIPMENT_BRIEF_NOT_WRITABLE,
      },
    },
  });
}

/**
 * Write (or rewrite) an equipment item's description — the words a pictogram is
 * drawn from (issue #885).
 *
 * Two shapes, one callable: pass `currentBrief` + `hint` to REVISE the existing
 * sentence per a correction, or the name alone to author a fresh one ("Start
 * over"). It PERSISTS NOTHING — the brief comes back to the caller and only ever
 * reaches Firestore when the user presses Draw, which is what makes iterating on
 * the words cheap and the picture the only thing that costs.
 *
 * Returns the brief itself: the wrapper object exists only for Genkit's
 * structured output and no caller wants it.
 *
 * Never throws (Rule 10): every failure crosses the boundary as
 * `Failure<DomainError>`. `invalid-argument` is the callable refusing a payload
 * the schema would not take (an over-long correction, an item with no name) — an
 * expected state with a friendly message rather than a defect, so it crosses as a
 * `ValidationError` and is deliberately not reported.
 */
export async function callDescribeEquipmentSubject(
  input: DescribeEquipmentSubjectInput,
): Promise<ReadResult<string, DomainError>> {
  return callFunction<DescribeEquipmentSubjectInput, DescribeEquipmentSubjectOutput, string>({
    name: 'describeEquipmentSubject',
    input,
    // The function declares 90 s (`cloud-functions/src/index.ts:357`), sized
    // around the flow's own 55 s `withAiTimeout`. 70 would have given up first.
    timeoutMs: 90_000,
    // The brief itself: the wrapper object exists only for Genkit's structured
    // output and no caller wants it.
    project: (out) => out.brief,
    overrides: {
      'invalid-argument': {
        kind: 'ValidationError',
        code: ErrorCode.EQUIPMENT_BRIEF_NOT_WRITABLE,
      },
    },
  });
}
