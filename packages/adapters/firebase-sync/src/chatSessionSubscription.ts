import { getFirestore, doc, setDoc, deleteDoc, getDoc, where, Timestamp } from 'firebase/firestore';
import { getApp } from 'firebase/app';
import type { DomainError, ReadResult } from '@salt/shared-types';
import { success, failure } from '@salt/shared-types';
import { ChatSessionSchema } from '@salt/domain/schemas';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import { chatExpiresAt } from '@salt/domain';
import { classifyFirestoreError } from './firestoreErrors.js';
import { subscribeCollection } from './subscribeCollection.js';
import type { ParsedBy } from './schemaParsing.js';

// Chat session persistence (issue #206, Phase 1). One doc per session at
// chatSessions/{id}. Per-user scoped: every read/write is filtered by ownerUid.
// Messages are stored as an array in the session doc (not a subcollection).
// saveChatSession bumps expiresAt on every write, and every chat gets a finite
// one — `chatExpiresAt` in `@salt/domain` holds how long and why (it lives there
// because `chefChatFlow` is the document's other writer and cannot import this
// package, #1430), and the block below holds the wire type that lets Firestore's
// TTL machinery act on it at all (#1008).

const COLLECTION = 'chatSessions';

// ─── THE TTL FIELD IS A `Timestamp` ON THE WIRE (issue #1008) ────────────────
//
// A Firestore TTL policy only expires a document whose TTL field holds a
// `Timestamp` — a string, number or absent field is skipped in silence, which is
// how the constants above spent months as policy with no mechanism (42 of
// staging's 76 documents sat past their own recorded expiry, all still there).
// So `saveChatSession` converts the ISO string it stamps into a `Timestamp` at
// the wire, and both read paths convert it back before the schema parse.
//
// The read side accepts BOTH shapes, indefinitely. `ChatSessionSchema.expiresAt`
// stays an ISO-8601 string (domain imports no Firebase types — Hard rule 1), and
// the realtime subscription SKIPS a document that fails validation, so a read
// path that only accepted a `Timestamp` would silently empty the chat list of
// every document written before its migration ran — and a stale client can
// re-write a string long after it has. `scripts/migrate-ttl-timestamps.mjs`
// converts the existing stock in place; enabling the per-project TTL policy on
// this field is a deliberate post-merge step, never a side effect of a deploy.

function expiresAt(session: ChatSessionDoc): string {
  return chatExpiresAt(session, new Date()).toISOString();
}

/**
 * `expiresAt` as stored: a `Timestamp` on everything written since #1008, an
 * ISO-8601 string on any document not yet migrated. Both become the string the
 * domain schema expects; anything else passes through for the schema to refuse.
 */
function normalizeExpiresAt(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const stored = (data as { expiresAt?: unknown }).expiresAt;
  if (stored instanceof Timestamp) {
    return { ...data, expiresAt: stored.toDate().toISOString() };
  }
  return data;
}

// Wraps the domain schema rather than defining one: zod schemas live only in
// `@salt/domain/schemas`, and this package has no zod dependency — the wrapper
// is plain data massaging behind the structural `ParsedBy` seam, so it slots
// into `subscribeCollection` and `loadChatSession` alike.
const chatSessionWireSchema: ParsedBy<ChatSessionDoc> = {
  safeParse: (data) => ChatSessionSchema.safeParse(normalizeExpiresAt(data)),
};

export function subscribeChatSessions(
  ownerUid: string,
  onSessions: (sessions: ChatSessionDoc[]) => void,
  // rawError forwards the original Firestore error for the real stack alongside
  // the categorised DomainError. Optional + last-positional: backward-compatible.
  onError: (err: DomainError, rawError?: unknown) => void,
): () => void {
  return subscribeCollection(
    {
      path: [COLLECTION],
      // Per-user scoped: the rule allows a read when the document's ownerUid is
      // the caller's, and every document this filter returns satisfies it.
      constraints: [where('ownerUid', '==', ownerUid)],
      schema: chatSessionWireSchema,
      label: 'ChatSessionSchema',
      project: (session) => session,
    },
    onSessions,
    onError,
  );
}

export async function loadChatSession(
  id: string,
): Promise<ReadResult<ChatSessionDoc | null, DomainError>> {
  try {
    const db = getFirestore(getApp());
    const snap = await getDoc(doc(db, COLLECTION, id));
    if (!snap.exists()) return success(null);
    const result = chatSessionWireSchema.safeParse(snap.data());
    if (!result.success) return failure({ kind: 'StorageError', reason: 'corruption' });
    return success(result.data);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

export async function saveChatSession(
  session: ChatSessionDoc,
): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    const stamped: ChatSessionDoc = { ...session, expiresAt: expiresAt(session) };
    await setDoc(doc(db, COLLECTION, stamped.id), {
      ...stamped,
      // The one wire divergence from the domain shape: the TTL machinery acts
      // only on a `Timestamp` (see the block above). Same instant, new type.
      expiresAt: Timestamp.fromDate(new Date(stamped.expiresAt)),
    });
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}

export async function deleteChatSession(id: string): Promise<ReadResult<void, DomainError>> {
  try {
    const db = getFirestore(getApp());
    await deleteDoc(doc(db, COLLECTION, id));
    return success(undefined);
  } catch (err) {
    return failure(classifyFirestoreError(err));
  }
}
