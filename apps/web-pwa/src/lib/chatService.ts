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
import { isFeatureEnabled } from './featureGate.js';
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
// like the bug this issue fixes. So for the snapshot that actually carries the
// flow's write, the ordering guard does not apply.
//
// NARROWED TO A SNAPSHOT THAT ACTUALLY CARRIES THE NEW TURN (found in review of
// this PR). `subscribeChatSessions` re-delivers the owner's WHOLE session set on
// every change to ANY of them, so the first snapshot naming this session id is
// NOT provably the flow's write — it is just as often an unrelated write to the
// SAME session landing while the turn is in flight, most commonly the title
// callable's own echo a few hundred ms later, carrying the PRE-TURN document.
// Trusting that snapshot unconditionally used to replace the store's only copy
// of the user's just-typed turn with a document that had never seen it — #1430's
// own symptom, reintroduced client-side. `expectedMessageCount` tells the two
// apart: the flow appends exactly two messages to whatever it reads, so a
// snapshot IS the flow's write once, and only once, its `messages.length`
// reaches the pre-turn count plus two. Anything short of that while a write is
// still expected is some OTHER write to this session, and the optimistic copy
// is kept — see `applySnapshot`.
//
// It is not a licence for any MATCHING snapshot to jump the guard: the entry is
// set for a named session at the send and cleared by the first snapshot that
// actually meets `expectedMessageCount`. The residual boundary, since that
// snapshot is still not PROVABLY the flow's rather than a coincidence: another
// device appending exactly two messages to this session between the send and
// the flow's write would take the bypass instead. That costs nothing — it is a
// real document from the server, the flow's write lands moments later and
// supersedes it, and no turn is lost, because the store's optimistic copy is no
// longer the only copy of anything.
//
// `arrived` is what `sendMessage` awaits before applying a generated title, so
// the title is composed onto the flow's document rather than racing it. It never
// resolves if the flow's write failed — deliberately: the title is then dropped,
// the chat keeps its seed name, and that is the cosmetic loss #1430 names and
// leaves open, not a lost turn.
interface ServerWriteWait {
  readonly landed: Promise<void>;
  readonly arrived: () => void;
  readonly expectedMessageCount: number;
}
const awaitingServerWrite = new Map<string, ServerWriteWait>();

function expectServerWrite(id: string, expectedMessageCount: number): ServerWriteWait {
  // A second `sendMessage` on the same session (a quick follow-up sent before
  // the first turn's title callable has resolved) would otherwise silently
  // displace the live entry: `forgetServerWrite` only ever resolves whatever is
  // CURRENTLY in the map, so the first turn's `landed` would never settle, its
  // generated title would be dropped even though the flow's write succeeded,
  // and this promise plus its `.then` closure would leak for the page's
  // lifetime. Resolve the outgoing wait before replacing it — the only true
  // thing left to say about a wait nothing will ever settle again.
  const displaced = awaitingServerWrite.get(id);
  if (displaced) displaced.arrived();

  let arrived = () => {};
  const landed = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const wait = { landed, arrived, expectedMessageCount };
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
    const wait = awaitingServerWrite.get(s.id);
    // See the comment above `awaitingServerWrite`: a snapshot only counts as
    // "the flow's write arrived" once its message count shows the two turns are
    // actually IN it. Anything short of that while a write is still expected is
    // some other write to this session — most often the title callable's own
    // echo of the pre-turn document — and must not be allowed to jump the guard.
    const flowWriteLanded = wait !== undefined && s.messages.length >= wait.expectedMessageCount;
    if (flowWriteLanded) forgetServerWrite(s.id);
    const stillAwaitingFlowWrite = wait !== undefined && !flowWriteLanded;
    if (stillAwaitingFlowWrite) {
      // Keep the optimistic copy and carry on waiting — this snapshot is not
      // the turn, and the ordinary clock guard below would happily accept it
      // anyway (the browser never stamps `latestLocalEdit` for the turn it
      // hands to the flow; see `sendMessage`), wiping the user's typed message
      // off the screen for the rest of the reply. That is #1430's own symptom,
      // and this is the case that let it back in.
      const ours = currentById.get(s.id);
      if (ours) result.push(ours);
      continue;
    }
    if (!flowWriteLanded && local !== undefined && s.updatedAt < local) {
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
    pendingSaveIntent: null,
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

// Which recorded save requests this TAB has already taken (issue #1480), keyed
// `sessionId:messageId` so two requests in one conversation are two entries.
//
// IN MEMORY, AND THAT IS THE RIGHT SCOPE — PER TAB, not per device (CLAUDE.md
// Rule 12, narrowed in review of #1490). It is a plain module-level `Set`, so it
// lives exactly as long as this one JS module instance: two tabs on the SAME
// device are two instances, not one, same as two different devices. See the
// boundary stated on `consumeSaveIntent`.
//
// The durable half of "only once" is the clear, which every tab and every
// reload reads; this set exists for the window between taking the request and
// that clear landing on the subscription, during which the store still holds
// the old document and an effect watching it would fire again. A reload
// legitimately empties it — by then the field is either cleared (nothing to
// take) or still armed because the clear failed, and a failed clear now also
// means the save never ran (`consumeSaveIntent` answers `false` on it), so
// firing again on reload is the recovery, not a bug — EXCEPT the one failure
// mode `consumeSaveIntent` cannot see: a clear that queues while offline
// resolves `ok` immediately, runs the save, and can still be rejected later on
// reconnect. There a re-fire is a genuine duplicate, the same exposure any
// offline Firestore write has, not one particular to this feature.
const takenSaveIntents = new Set<string>();

/**
 * Take the save request the chef recorded on this conversation, if there is one
 * (issue #1480). True means the caller now owns it and should run the save.
 *
 * THE ONE SEAM EVERY SURFACE GOES THROUGH (review of #1490). The `chatSave`
 * feature flag is read IN HERE, not at the call site — a browser left on an
 * older bundle, or one where the flag disagrees, answers `false` and runs
 * nothing, request left armed for a build that can act on it. A new surface
 * that calls this function and acts only on `true` gets the flag check for
 * free; do not add a second `isFeatureEnabled('chatSave')` / `chatSaveGate`
 * check beside the call, which is how the two would drift.
 *
 * THIS FUNCTION DOES NOT KNOW WHETHER THE CALLER WAS PRESENT FOR THE REQUEST.
 * A request already sitting on the document the first time a page observes it
 * is one nobody was there to take, and MUST be cleared without being acted on —
 * that is the caller's job (see the mount-tracking in `ChatSessionPage.svelte`
 * and `RecipeViewPage.svelte`), not this function's; this one only takes and
 * clears whatever it is handed.
 *
 * THE CLEAR IS ATTEMPTED BEFORE THE SAVE RUNS, and only a clear that actually
 * lands answers `true`. A clear that fails outright (a `permission-denied`, a
 * `StorageError`) answers `false`, so the caller runs no save and the request
 * survives on the document for the next attempt — a page that goes away
 * mid-flight, or a failed clear, then costs one retry rather than a duplicate
 * recipe. NOT COVERED: a clear that queues while offline resolves `ok`
 * immediately — this answers `true` and the save runs — and can still be
 * rejected once it replays on reconnect, past the point anything here can
 * still say no. That is the one path left where a later re-fire can duplicate
 * the save; it is the ordinary hazard of an offline Firestore write, not
 * specific to this function.
 *
 * THE BOUNDARY (CLAUDE.md Rule 12): "exactly once" holds per request per TAB,
 * not globally — `takenSaveIntents` above is why. The clear is an ordinary LWW
 * write, so two tabs sitting in the same conversation when the chef records a
 * request — the same device open twice, or two different devices — can each
 * take it before the other's clear arrives, and each will save. That is two
 * recipes to delete, and it is the same exposure the floppy-disc button has had
 * all along — not a reason for a transaction, which would still not make a
 * second tab's save impossible, only slightly harder.
 */
export async function consumeSaveIntent(session: ChatSessionDoc): Promise<boolean> {
  const messageId = session.pendingSaveIntent;
  if (messageId === null) return false;
  if (!isFeatureEnabled('chatSave')) return false;
  const token = `${session.id}:${messageId}`;
  if (takenSaveIntents.has(token)) return false;
  takenSaveIntents.add(token);
  const cleared = await persistSession({ ...session, pendingSaveIntent: null });
  return cleared.kind === 'ok';
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
  // The flow appends exactly two messages (user, assistant) to whatever it
  // reads, so this is the count a snapshot needs to reach before it can be
  // trusted as the flow's own write rather than some unrelated one — see the
  // comment above `awaitingServerWrite`.
  const serverWrite = expectServerWrite(session.id, session.messages.length + 2);

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
  //
  // ONLY IF THE STORE'S COPY IS STILL THE OPTIMISTIC ONE. The flow's own write is
  // `await`ed before it returns, so `applySnapshot` can land the real document —
  // superseding `stampedUser` in the store — before this `streamChefChat` call
  // above even resolves; not a rare interleaving, just a race between two round
  // trips. Writing `finalSession` over that unconditionally would un-supersede
  // it: the store would go back to showing the browser's turn ids, and the title
  // follow-up below would then `persistSession` (a whole-document `setDoc`) the
  // browser's copy over the server's under LWW — the exact clobber this file's
  // header says the flow's write prevents. Reference equality is enough to tell
  // the two cases apart: nothing but `applySnapshot` ever replaces a session
  // object in the store, so `stampedUser` is still the live entry if and only if
  // no snapshot has landed for it since.
  const liveEntry = get(_sessions).find((s) => s.id === finalSession.id);
  if (liveEntry === stampedUser) {
    const withoutThis = get(_sessions).filter((s) => s.id !== finalSession.id);
    _sessions.set([...withoutThis, finalSession]);
  }

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
