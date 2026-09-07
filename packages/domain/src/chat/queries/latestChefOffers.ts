import type { ChatSessionDoc, ChefOffer } from '../../schemas/chatSession.js';

/**
 * What the chef's NEWEST reply said it offered (issue #1299).
 *
 * The one place the row's gates are decided, for the same reason
 * `isChatReadOnly` next door is: three surfaces ask this question and a fourth
 * will, and a predicate spelled out at each call site is four chances to spell
 * it differently.
 *
 * **Newest reply only, and that is the whole rule.** Acting on a chat reads the
 * entire conversation, so what an older reply once offered is not an offer that
 * is still on the table — the buttons belong to the message the user is looking
 * at. A conversation with no assistant turn yet has offered nothing.
 *
 * **Fail closed.** A reply the chef declared nothing on returns `[]`, which is
 * also what every conversation written before #1299 shipped returns
 * (`MessageSchema.offered` defaults to `[]` on read). Empty means no buttons,
 * never "show them anyway": a button offered after a plain answer is the defect
 * #1299 exists to fix, and a button missing after a real suggestion is
 * recoverable by asking again.
 */
export function latestChefOffers(session: ChatSessionDoc | null | undefined): readonly ChefOffer[] {
  if (!session) return [];
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (message?.role === 'assistant') return message.offered;
  }
  return [];
}

/** True when the chef's newest reply suggested changing the dish it is attached to. */
export function offersDishChange(session: ChatSessionDoc | null | undefined): boolean {
  return latestChefOffers(session).includes('dish-change');
}

/** True when the chef's newest reply described a dish worth keeping in its own right. */
export function offersNewDish(session: ChatSessionDoc | null | undefined): boolean {
  return latestChefOffers(session).includes('new-dish');
}
