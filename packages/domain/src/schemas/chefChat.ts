import { z } from 'zod';
import { MessageSchema } from './chatSession.js';

// Input schema for the chefChat streaming flow (issue #206, Phase 2).
// The flow is stateless: it receives the recent message history + the new turn.
// recipeId is set for recipe-attached sessions; the flow reads the recipe
// server-side and injects it as context when non-null.
export const ChefChatInputSchema = z.object({
  messages: z.array(MessageSchema),
  newMessage: z.string(),
  recipeId: z.string().nullable(),
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
