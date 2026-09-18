import { z } from 'zod';
import { MessageSchema } from './chatSession.js';

// Input schema for the chefChat streaming flow (issue #206, Phase 2).
// The flow receives the recent message history + the new turn. recipeId is set
// for recipe-attached sessions; the flow reads the recipe server-side and
// injects it as context when non-null.
//
// It is no longer STATELESS: given a `sessionId` it writes the completed turn
// itself (issue #1430). See that field below.
export const ChefChatInputSchema = z.object({
  messages: z.array(MessageSchema),
  newMessage: z.string(),
  recipeId: z.string().nullable(),
  // The conversation this turn belongs to (issue #1430). With it, the flow reads
  // `chatSessions/{sessionId}`, appends the user turn and its own reply and
  // writes the document — so a completed turn survives a phone that locked or a
  // tab that closed while the reply was streaming. The browser used to be the
  // only writer, after the stream had fully drained, and a page that did not
  // survive the `await` lost the user's own sentence along with the reply.
  //
  // OPTIONAL, and that is load-bearing for the same reason `speaker` below is: a
  // browser left on an older bundle after a deploy sends no `sessionId` and must
  // get a working turn rather than a rejected call. Absent, the flow writes
  // nothing and returns exactly as it did before — which is also a correct
  // arrangement, because that older bundle still persists the turn itself.
  //
  // NOT AN AUTHORISATION TOKEN. It names a document; it does not assert a right
  // to write one. The flow reads the document and compares its `ownerUid` against
  // the VERIFIED caller before writing, because an Admin SDK write bypasses
  // `firestore.rules` entirely (see `writeChefChatTurn` in the flow).
  sessionId: z.string().optional(),
  // Variation chats (issue #763): the dish this conversation started from, which
  // the chat is NOT attached to. Read server-side like `recipeId`, but injected
  // under a different heading — "the starting point for a NEW dish" rather than
  // "the recipe the user is asking about" — so the chef proposes rather than
  // amends. Optional so every existing caller is unchanged.
  basedOnRecipeId: z.string().nullable().optional(),
  // Who is typing, as a display NAME (issue #816, phase 2). The household's notes
  // are attributed to whoever wrote them, and the chef only ever raises a note
  // belonging to SOMEONE ELSE — which it cannot do without knowing who it is
  // talking to. A name, never a uid: uids appear nowhere in the family-shared data
  // model, and the note authors this is compared against are names too.
  //
  // OPTIONAL, and that is load-bearing: a browser left on an older bundle after a
  // deploy sends no `speaker`, and must get an unattributed notes section rather
  // than a rejected call. The section drops its "you are talking to …" line and
  // the chef simply keeps quiet about every note instead — never a placeholder
  // name, which would tell the chef it is talking to somebody called "Someone".
  speaker: z.string().optional(),
});

export type ChefChatInput = z.infer<typeof ChefChatInputSchema>;

// The chef's reply. The flow streams it in fragments and resolves to the whole
// text, so the stream and the output share this one schema.
export const ChefChatOutputSchema = z.string();
