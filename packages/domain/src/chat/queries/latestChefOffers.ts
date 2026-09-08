import { CHEF_OFFER_KINDS } from '../../schemas/chatSession.js';
import type { ChatSessionDoc, ChefOffer } from '../../schemas/chatSession.js';

/**
 * The one place a stored word becomes a kind this build understands.
 *
 * `MessageSchema.offered` holds plain strings on purpose — the comment there
 * says why — so a kind added after a client shipped costs that client a button
 * rather than the whole conversation. Here is where that cost is paid: a word
 * this build does not know gates nothing.
 */
function isChefOffer(offer: string): offer is ChefOffer {
  return (CHEF_OFFER_KINDS as readonly string[]).includes(offer);
}

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
 * **What the chef declared, not yet what the user is offered.** The two
 * predicates below are the whole table, and both halves of it live there: a
 * declaration, AND whether this conversation has a dish for that declaration to
 * act on. Callers ask those, never this — a call site that re-spells the second
 * half in its own markup is a second place the table can be got wrong, which is
 * the defect this file exists to prevent (PR #1303 review).
 *
 * **Fail closed.** A reply the chef declared nothing on returns `[]`, which is
 * also what every conversation written before #1299 shipped returns
 * (`MessageSchema.offered` defaults to `[]` on read). Empty means no buttons,
 * never "show them anyway": a button offered after a plain answer is the defect
 * #1299 exists to fix, and a button missing after a real suggestion is
 * recoverable by asking again. A word this build does not know is the same
 * answer — see `isChefOffer` above.
 */
export function latestChefOffers(session: ChatSessionDoc | null | undefined): readonly ChefOffer[] {
  if (!session) return [];
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (message?.role === 'assistant') return message.offered.filter(isChefOffer);
  }
  return [];
}

/**
 * True when the chef's newest reply suggested changing the dish it is attached to.
 *
 * ATTACHMENT IS PART OF THE GATE, not a clause for a page to add. A general chat
 * has no dish to change, so "less sweet" there is a suggestion with nothing to
 * apply it to and the button would have nothing to open. The chef can and does
 * declare `dish-change` on a general conversation — the declaration is about the
 * REPLY, and it is answered here rather than dropped, because a caller that
 * forgot the clause would offer a review of a recipe that does not exist.
 */
export function offersDishChange(session: ChatSessionDoc | null | undefined): boolean {
  if (!session?.recipeId) return false;
  return latestChefOffers(session).includes('dish-change');
}

/**
 * True when the chef's newest reply described a dish worth keeping in its own right.
 *
 * Unattached on purpose, and that is the asymmetry with `offersDishChange`
 * above: a dish worth keeping is worth keeping wherever it was described, so
 * this holds on a general chat exactly as it does on a recipe's. Which BUTTON
 * follows — "Save as recipe" or "Save as new recipe" — is wording, and wording
 * belongs to the surface.
 */
export function offersNewDish(session: ChatSessionDoc | null | undefined): boolean {
  return latestChefOffers(session).includes('new-dish');
}
