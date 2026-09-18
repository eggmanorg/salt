import {
  subscribeChatSessions,
  saveChatSession,
  deleteChatSession,
  streamChefChat,
  callGenerateChatTitle,
} from '@salt/firebase-sync';
import { createObservabilityErrorReportingAdapter, trackUsageEvent } from '@salt/observability';
import { parseChatCommand, isChatReadOnly } from '@salt/domain';
import { reportIfFailed, reportSubscriptionError, reportWriteError } from './errorReporting.js';
import { rememberNote } from './kitchenMemoryService.js';
import { currentMember } from './membersService.js';
import type { ChatSessionDoc } from '@salt/domain/schemas';
import type { DomainError, ReadResult } from '@salt/shared-types';
import { success, failure, ErrorCode } from '@salt/shared-types';
import { writable, get } from 'svelte/store';
import type { Readable } from 'svelte/store';

// Chat service (issue #206, Phase 3). Optimistic store over the per-user
// firebase-sync adapter. Follows the recipeService.ts pattern exactly.
//
// TWO WRITERS OF A CHAT DOCUMENT, DELIBERATELY, and the split is by who is
// waiting (issue #1430):
//
//  - A TURN is written by the `chefChat` flow, server-side. `sendMessage` below
//    sends the session id, appends both turns to the STORE for the reader to
//    watch, and writes nothing. The call runs for most of a minute on a
//    tool-using turn, so the browser cannot be relied on to be there when it
//    returns — a locked phone lost the reply AND the user's own sentence while
//    the browser owned the write.
//  - EVERYTHING ELSE is written here, through `persistSession`: creating a
//    session, claiming its recipe, reopening it, the generated title, and the
//    `/remember` chip line. Each is instant and the person is on the page.
//
// The document is whole-document LWW, so two writers is no more hazardous than
// one — but the two run on two CLOCKS, and `applySnapshot`'s ordering guard below
// compares their stamps. See `awaitingServerWrite`.

const _sessions = writable<readonly ChatSessionDoc[]>([]);
export const sessions: Readable<readonly ChatSessionDoc[]> = _sessions;

// Synchronous snapshot of the chat-sessions store for e2e (test-infra Phase 5).
// Mirrors getRecipesSnapshot/getMealPlanWeekSnapshot. Lets specs assert the
// owner-scoped session set the realtime subscription actually delivered — the
// crux of the owner-scoping check (Chat is the one owner-scoped exception to the
// family-shared rule), since two users' stores must never cross-contaminate.
export function getChatSessionsSnapshot(): readonly ChatSessionDoc[] {
  return get(_sessions);
}

const _isLoadingSessions = writable(true);
export const isLoadingSessions: Readable<boolean> = _isLoadingSessions;

let _errorReporter: ReturnType<typeof createObservabilityErrorReportingAdapter> | null = null;
function getErrorReporter() {
  if (!_errorReporter) _errorReporter = createObservabilityErrorReportingAdapter();
  return _errorReporter;
}

// Optimistic snapshot guard — same pattern as recipeService.ts.
const latestLocalEdit = new Map<string, string>();

// Sessions whose current turn the FLOW is writing (issue #1430), and a way to
// wait for that write to arrive.
//
// THE HAZARD IT ANSWERS IS TWO CLOCKS, not staleness. `latestLocalEdit` exists to
// suppress a snapshot older than a write WE made, and it holds a stamp from THIS
// browser's clock (`createChatSession`, the title, a reopen). The flow's write is
// stamped from the SERVER's. A browser running fast by more than the gap between
// those two writes would make the ordering guard reject the real turn — the one
// thing in the store that only exists in Firestore — and it would look exactly
// like the bug this issue fixes. So for the one snapshot the flow is about to
// send, the ordering guard does not apply.
//
// It is not a licence for any snapshot to jump the guard: the entry is set for a
// named session at the send and cleared by the first snapshot accepted for it.
// The boundary, since that first snapshot is not PROVABLY the flow's: another
// device writing that session between the send and the flow's write would take
// the bypass instead. That costs nothing — it is a real document from the server,
// the flow's write lands moments later and supersedes it, and no turn is lost,
// because the store's optimistic copy is no longer the only copy of anything.
//
// `arrived` is what `sendMessage` awaits before applying a generated title, so
// the title is composed onto the flow's document rather than racing it. It never
// resolves if the flow's write failed — deliberately: the title is then dropped,
// the chat keeps its seed name, and that is the cosmetic loss #1430 names and
// leaves open, not a lost turn.
interface ServerWriteWait {
  readonly landed: Promise<void>;
  readonly arrived: () => void;
}
const awaitingServerWrite = new Map<string, ServerWriteWait>();

function expectServerWrite(id: string): ServerWriteWait {
  let arrived = () => {};
  const landed = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const wait = { landed, arrived };
  awaitingServerWrite.set(id, wait);
  return wait;
}

function forgetServerWrite(id: string): void {
  const wait = awaitingServerWrite.get(id);
  if (wait === undefined) return;
  awaitingServerWrite.delete(id);
  wait.arrived();
}

function applySnapshot(incoming: ChatSessionDoc[]): void {
  const currentById = new Map(get(_sessions).map((s) => [s.id, s]));
  const result: ChatSessionDoc[] = [];
  const seen = new Set<string>();
  for (const s of incoming) {
    seen.add(s.id);
    const local = latestLocalEdit.get(s.id);
    const awaited = awaitingServerWrite.has(s.id);
    if (awaited) forgetServerWrite(s.id);
    if (!awaited && local !== undefined && s.updatedAt < local) {
      const ours = currentById.get(s.id);
      if (ours) result.push(ours);
      continue;
    }
    if (s.updatedAt) latestLocalEdit.set(s.id, s.updatedAt);
    result.push(s);
  }
  for (const [id, s] of currentById) {
    if (!seen.has(id) && latestLocalEdit.has(id)) result.push(s);
  }
  _sessions.set(result);
}

export function initChatSync(ownerUid: string): () => void {
  _isLoadingSessions.set(true);
  const errors = getErrorReporter();
  const unsub = subscribeChatSessions(
    ownerUid,
    (incoming) => {
      applySnapshot(incoming);
      _isLoadingSessions.set(false);
    },
    (err, rawError) => {
      reportSubscriptionError(errors, err, rawError);
      _isLoadingSessions.set(false);
    },
  );
  return unsub;
}

function now(): string {
  return new Date().toISOString();
}

// One user turn, ready to append. Shared by both send paths below so a `/remember`
// is stored as an ORDINARY `role: 'user'` message carrying its raw text — no third
// role on MessageSchema, and nothing for the CF's 'assistant' → 'model' remap to
// trip over. The transcript re-parses that text to know it should draw a chip.
function userTurn(text: string): ChatSessionDoc['messages'][number] {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    text,
    createdAt: now(),
  };
}

/**
 * `/remember …` — save the note and record the line, WITHOUT calling the chef
 * (issue #816, phase 1).
 *
 * Everything this does not do is the point. No AI call, so no cost and no wait; no
 * `chat.message_sent`, because that event measures how much the household asks the
 * chef and a note is not a question; and no title generation, because that is an AI
 * call too and a conversation whose first line was a note has not been started yet
 * in any sense the title would describe.
 *
 * A failed note write appends nothing: the failure is returned so the composer's
 * existing toast reports it and the typed line is handed back, rather than leaving a
 * turn in the transcript claiming something was remembered that was not.
 */
async function rememberFromChat(
  session: ChatSessionDoc,
  rawText: string,
  note: string,
): Promise<ReadResult<ChatSessionDoc, DomainError>> {
  const saved = await rememberNote(note);
  if (saved.kind !== 'ok') return saved;

  const withNote: ChatSessionDoc = {
    ...session,
    messages: [...session.messages, userTurn(rawText)],
  };
  const persisted = await persistSession(withNote);
  if (persisted.kind !== 'ok') return persisted;
  return success(withNote);
}

// The seed title, shown until the chef has read the first exchange and retitled
// it. "Cauliflower Steaks chat" beats "Recipe chat" for the same reason the list
// on the recipe page exists at all: several conversations about one dish are only
// tellable apart by what they say.
// A variation chat is seeded from its base dish too (issue #763), but as
// "<dish> variation" rather than "<dish> chat" — the two are told apart in the
// list by what they are for, not just by the dish they mention. Like the recipe
// seed, it lasts only until the chef retitles the conversation.
function seedTitle(
  recipeId: string | null,
  recipeTitle: string | undefined,
  basedOnRecipeId: string | null,
): string {
  if (recipeId) return recipeTitle?.trim() ? `${recipeTitle.trim()} chat` : 'Recipe chat';
  if (basedOnRecipeId) {
    return recipeTitle?.trim() ? `${recipeTitle.trim()} variation` : 'Recipe variation';
  }
  return 'New chat';
}

function newSession(
  ownerUid: string,
  recipeId: string | null,
  recipeTitle: string | undefined,
  basedOnRecipeId: string | null,
): ChatSessionDoc {
  const ts = now();
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    ownerUid,
    recipeId,
    basedOnRecipeId,
    title: seedTitle(recipeId, recipeTitle, basedOnRecipeId),
    messages: [],
    createdAt: ts,
    updatedAt: ts,
    reopenedAt: null,
    expiresAt: ts, // saveChatSession will overwrite with the real expiry
  };
}

// `basedOnRecipeId` is the dish a variation chat STARTS FROM, and is deliberately
// independent of `recipeId`, the dish it belongs to: a variation belongs to
// nothing until "Save as recipe" claims the recipe it produced. That also means
// it keeps the ordinary 14-day expiry until then, which is the right fate for a
// variation nobody saved.
export async function createChatSession(
  ownerUid: string,
  recipeId: string | null = null,
  recipeTitle?: string,
  basedOnRecipeId: string | null = null,
): Promise<ReadResult<ChatSessionDoc, DomainError>> {
  const session = newSession(ownerUid, recipeId, recipeTitle, basedOnRecipeId);
  const stamped = { ...session, updatedAt: now() };
  latestLocalEdit.set(stamped.id, stamped.updatedAt);
  _sessions.set([...get(_sessions), stamped]);
  const result = await saveChatSession(stamped);
  if (result.kind === 'err') {
    reportWriteError(getErrorReporter(), result.error);
    return result;
  }
  trackUsageEvent('chat.started', {
    chat_context: recipeId ? 'recipe' : basedOnRecipeId ? 'variation' : 'blank',
  });
  return success(stamped);
}

export async function persistSession(
  session: ChatSessionDoc,
): Promise<ReadResult<void, DomainError>> {
  const stamped = { ...session, updatedAt: now() };
  latestLocalEdit.set(stamped.id, stamped.updatedAt);
  const others = get(_sessions).filter((s) => s.id !== stamped.id);
  _sessions.set([...others, stamped]);
  return reportIfFailed(getErrorReporter(), await saveChatSession(stamped));
}

// Attach a general chat to the recipe it produced (issue #696). Called once
// "Save as recipe" has written the recipe, so the conversation a dish was born
// from is listed on that dish however long ago it happened.
//
// FIRST CLAIM WINS: `recipeId` is a scalar and a session that already belongs to
// a recipe keeps it. Saving a SECOND recipe from one conversation therefore
// leaves the second recipe with no origin chat — judged vanishingly rare against
// the cost of an array field and two ways to say the same thing.
export async function claimRecipe(
  sessionId: string,
  recipeId: string,
): Promise<ReadResult<void, DomainError>> {
  const session = get(_sessions).find((s) => s.id === sessionId);
  if (!session || session.recipeId !== null) return success(undefined);
  return persistSession({ ...session, recipeId });
}

// "Make read-write" (issue #1270): restart the two-day clock from now. An
// ordinary `persistSession` — same LWW contract as any other chat write, and
// the reason `sendMessage` never sets this field itself (see Q5 in the issue):
// continuing to chat within the window must not itself push the clock further
// out, only this explicit, cost-warned action does.
export async function reopenChatSession(
  session: ChatSessionDoc,
): Promise<ReadResult<void, DomainError>> {
  return persistSession({ ...session, reopenedAt: now() });
}

export async function removeSession(id: string): Promise<ReadResult<void, DomainError>> {
  latestLocalEdit.set(id, now());
  _sessions.set(get(_sessions).filter((s) => s.id !== id));
  return reportIfFailed(getErrorReporter(), await deleteChatSession(id));
}

// Send a user message: appends the user turn, streams the assistant reply, then
// appends the final assistant turn. onChunk is called for each streaming text
// fragment so the UI can render the partial reply live.
//
// PERSISTS NOTHING ON THIS PATH (issue #1430). Both appends are to the store
// alone, for the reader to watch; `chatSessions/{id}` is written by the flow,
// which mints the stored turns' ids and timestamps and returns only the reply
// text. The store's copies are therefore superseded, id for id, when the flow's
// write arrives on the subscription — same two turns, same text, different ids.
// Nothing here depends on those ids matching, and nothing should start to.
export async function sendMessage(
  session: ChatSessionDoc,
  text: string,
  onChunk: (chunk: string) => void,
): Promise<ReadResult<ChatSessionDoc, DomainError>> {
  // Defence-in-depth (issue #1270): the composer is the primary gate and is
  // gone once a chat has gone quiet, so this only fires if something else
  // still called through — never the everyday path.
  if (isChatReadOnly(session, new Date())) {
    return failure({ kind: 'ValidationError', code: ErrorCode.CHAT_READ_ONLY });
  }

  // The ONE chat command (issue #816), taken BEFORE anything else in this function:
  // recognising it costs a string comparison, and everything below — the usage
  // event, the stream, the title call — is either a cost or a claim that a note
  // should not incur. An empty `/remember` is not a note and falls through to the
  // chef; the composer answers that one in place before it ever gets here.
  const command = parseChatCommand(text);
  if (command !== null && command.text !== '') {
    return rememberFromChat(session, text, command.text);
  }

  const isFirstExchange = session.messages.length === 0;
  // Usage = the send gesture, not the round-trip: a message that then fails to
  // stream still counts as someone using chat. No content rides on the event.
  trackUsageEvent('chat.message_sent', {});

  const userMsg: ChatSessionDoc['messages'][number] = userTurn(text);

  const sessionWithUser: ChatSessionDoc = {
    ...session,
    messages: [...session.messages, userMsg],
  };

  // Optimistically update with user message. Snapshot the prior store state so a
  // failed send can be rolled back — the turn is only persisted on success, so a
  // left-behind optimistic turn would otherwise accumulate as a ghost on retry.
  //
  // NO `latestLocalEdit` STAMP: that map guards against a snapshot older than a
  // write we made, and this browser is no longer the one writing the turn.
  // Stamping it here would stamp a client clock against a write the SERVER is
  // about to make — precisely the comparison `awaitingServerWrite` exists to take
  // out of the path.
  const prevSessions = get(_sessions);
  const stampedUser = { ...sessionWithUser, updatedAt: now() };
  const others = prevSessions.filter((s) => s.id !== stampedUser.id);
  _sessions.set([...others, stampedUser]);
  const serverWrite = expectServerWrite(session.id);

  // Who the chef is talking to (issue #816, phase 2). The same source the note's
  // `author` is denormalised from, so the name the chef compares a note's author
  // against is the name written on the notes.
  //
  // OMITTED, never defaulted, when it does not resolve. `exactOptionalPropertyTypes`
  // means `speaker: undefined` is not the same as no `speaker`, and the difference
  // matters: sending the 'Someone' fallback would tell the chef it is talking to a
  // person by that name, and every note would then belong to "someone other than
  // the person you are talking to". Absent, the prompt drops its attribution line
  // and the chef stays quiet about all of them — the safe end of the range.
  const speaker = get(currentMember)?.name;

  const streamResult = await streamChefChat(
    {
      // The stored `/remember …` lines are NOT sent to the model. The note itself
      // is already in the system prompt, attributed to its author, so the raw
      // command line adds nothing on the wire — and left in, it invites the chef to
      // acknowledge a save it played no part in ("noted!"), which is exactly the
      // listing-notes-back behaviour this phase exists to prevent. They stay in the
      // stored transcript and keep rendering as chips; only what is sent changes.
      // The predicate mirrors ChatThread's chip test, so the two cannot disagree
      // about which lines are notes.
      messages: session.messages.filter(
        (m) => !(m.role === 'user' && parseChatCommand(m.text) !== null),
      ),
      newMessage: text,
      recipeId: session.recipeId,
      basedOnRecipeId: session.basedOnRecipeId,
      // The conversation the flow writes this turn into (issue #1430). Always
      // sent from here — the field is optional on the wire only so a browser left
      // on an older bundle after a deploy still gets a working turn.
      sessionId: session.id,
      ...(speaker ? { speaker } : {}),
    },
    onChunk,
  );

  if (streamResult.kind === 'err') {
    // No write is coming, so release the snapshot bypass with it.
    forgetServerWrite(session.id);
    _sessions.set(prevSessions);
    // Report the chefChat AI-callable failure (gate drops NetworkError/offline).
    reportWriteError(getErrorReporter(), streamResult.error);
    return streamResult;
  }

  const assistantMsg: ChatSessionDoc['messages'][number] = {
    id: crypto.randomUUID(),
    role: 'assistant',
    text: streamResult.value,
    createdAt: now(),
  };

  const finalSession: ChatSessionDoc = {
    ...stampedUser,
    messages: [...stampedUser.messages, assistantMsg],
  };

  // Store only — the flow has already written the turn (see this function's
  // header). This is what the reader watches until the subscription catches up.
  const withoutThis = get(_sessions).filter((s) => s.id !== finalSession.id);
  _sessions.set([...withoutThis, finalSession]);

  if (isFirstExchange) {
    // Generate a short title in the background — doesn't block the response.
    void callGenerateChatTitle(text, streamResult.value).then(async (titleResult) => {
      if (titleResult.kind !== 'ok' || !titleResult.value.trim()) return;
      // WAIT FOR THE FLOW'S WRITE FIRST, then compose the title onto WHAT THE
      // STORE HOLDS — never onto the captured `finalSession`, whose turn ids the
      // flow has already superseded (issue #1430). `persistSession` is a
      // whole-document `setDoc`, so writing the captured object would put the
      // browser's copy of the turn back over the server's under LWW, and doing it
      // before the flow's snapshot arrived would leave the store showing the seed
      // title over a document that has the real one until the next reload.
      //
      // `landed` never resolves if the flow's write failed, and the title is then
      // simply dropped — the cosmetic half of this failure, which #1430 names and
      // leaves for #1417 to decide about.
      await serverWrite.landed;
      const current = get(_sessions).find((s) => s.id === session.id);
      if (current) void persistSession({ ...current, title: titleResult.value.trim() });
    });
  }

  return success(finalSession);
}
