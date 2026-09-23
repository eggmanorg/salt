import type { ChatSessionDoc } from '@salt/domain/schemas';

import { sendMessage } from '../../lib/chatService.js';
import { addToast } from '../../lib/toastStore.js';

/**
 * The live state of one chef conversation — the partial reply as it streams in and
 * whether a turn is in flight — plus the single send path through `sendMessage`.
 *
 * This is deliberately NOT held inside `ChatThread.svelte`. A host sometimes has to
 * start a turn on a session the component cannot yet be showing: "Optimise for my
 * kitchen" creates the session and sends into the object `createChatSession` handed
 * back, before the sessions store has repopulated and therefore before the thread is
 * on screen. Holding the two live values out here means that turn streams into the
 * same state the component will render the moment it mounts, with one send path
 * rather than a host-side copy of it.
 *
 * The composer's own text stays in the component: it is per-surface, and a canned
 * prompt sent by a host must never appear in the user's input box.
 */
export function createChatThread() {
  let streamingText = $state('');
  let isSending = $state(false);

  // What this thread last sent on each conversation, and where the chef's reply
  // to it will sit in the transcript (issue #1494) — what marks a recorded save
  // request as THIS page's to act on. The flow mints its own message ids, so
  // the reply cannot be matched by id; it appends exactly two turns (the user's
  // text verbatim, then the reply) to the transcript it reads, so the reply
  // lands at the pre-send count plus one, straight after that text. The same
  // arithmetic `sendMessage`'s `expectedMessageCount` relies on, with the
  // same boundary: a turn another device appends in between shifts the reply,
  // so the request then reads as not asked here and is dropped, never fired —
  // UNLESS this entry is still sitting here when that happens. It is kept on
  // a failed send and replaced only by this page's own next send on that
  // session, so it can also match a later turn sent from elsewhere with the
  // same text at the same position, for as long as this page stays mounted
  // (see the boundary on `askedHere` below).
  //
  // Plain, not `$state`: nothing renders it, and it lives exactly as long as this
  // thread — one page instance. A page mounted after the send never has it.
  const lastSent = new Map<string, { readonly text: string; readonly replyAt: number }>();

  return {
    /** The assistant reply as it arrives, '' when nothing is in flight. */
    get streamingText(): string {
      return streamingText;
    },
    get isSending(): boolean {
      return isSending;
    },
    /**
     * Append `text` as a user turn on `session` and stream the reply. Takes the
     * session explicitly rather than reading a store, so a turn sent immediately
     * after creating one uses the object that was just handed back.
     *
     * Returns whether the turn landed; failures toast here and the caller decides
     * what to restore.
     */
    async send(session: ChatSessionDoc, text: string): Promise<boolean> {
      if (isSending) return false;
      // Before the call, not after it: the flow writes the turn before it
      // returns, so the reply's snapshot can arrive while this is still awaiting.
      // Kept on a failed send too — a stream that dies mid-reply (a locked
      // phone) does not stop the flow writing the turn, and that reply is still
      // an answer to this page.
      lastSent.set(session.id, { text, replyAt: session.messages.length + 1 });
      isSending = true;
      streamingText = '';

      const result = await sendMessage(session, text, (chunk) => {
        streamingText += chunk;
      });

      isSending = false;
      streamingText = '';

      if (result.kind !== 'ok') {
        addToast('Failed to send message.', 'destructive');
        return false;
      }
      return true;
    },
    /**
     * Whether `session`'s recorded save request (`pendingSaveIntent`) names the
     * chef's reply to the latest message sent through THIS thread on it (issue
     * #1494). A request armed while no page was open, before this one mounted,
     * or on a turn sent from anywhere else answers false, whatever order the
     * snapshots carrying it arrive in.
     *
     * THE BOUNDARY (CLAUDE.md Rule 12): it matches position and text, not
     * identity or time. `lastSent` is kept on a failed send and replaced only
     * by this page's own next send on that session, so the same person
     * sending the identical words into the same conversation from a second
     * device lands a turn this cannot tell from its own for as long as this
     * page stays mounted — not only if it happens "at the same moment".
     */
    askedHere(session: ChatSessionDoc): boolean {
      const sent = lastSent.get(session.id);
      if (sent === undefined || session.pendingSaveIntent === null) return false;
      const asked = session.messages[sent.replyAt - 1];
      const reply = session.messages[sent.replyAt];
      return (
        asked?.role === 'user' &&
        asked.text === sent.text &&
        reply?.id === session.pendingSaveIntent
      );
    },
  };
}

export type ChatThreadState = ReturnType<typeof createChatThread>;
