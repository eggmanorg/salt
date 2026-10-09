// The notes the household wrote for the chef (issue #816, phase 2) — the READ and
// the RENDERING of `kitchenMemories`, plus the ONE framing that wraps it. A direct
// sibling of equipmentContext.ts, and shaped the same way for the same reason: the
// read is separable from the words that introduce it, so the words can be retuned
// without touching the query.
//
// SCOPE: chefChat and nothing else. Unlike the equipment manifest there is
// deliberately NO second framing here, and no other flow may grow one. authorRecipe,
// extractRecipeFromUrl, extractRecipeFromPhoto and generateGuidedPlan are
// temperature-0 transcribers; equipmentContext already documents what handing a
// transcriber a preference does, and a note like "we hate coriander" in a librarian's
// prompt is precisely the licence that quietly rewrites an imported recipe. A note
// shapes what the chef SUGGESTS. It must never touch what a recipe SAYS.
//
// The notes are read here, server-side, rather than sent up with the turn: the
// browser's subscription is page-owned and is not running during a chat, and a
// prompt built from whatever a client happened to have loaded would vary by which
// screen the user visited first.

import type { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { KitchenMemorySchema, KITCHEN_MEMORY_COLLECTION } from '@salt/domain/schemas';
import type { KitchenMemoryDoc } from '@salt/domain/schemas';

/**
 * Renders the household's notes as plain text for a system prompt, GROUPED BY
 * AUTHOR — the grouping is the feature, not presentation. The chef must be able to
 * tell "I don't eat mushrooms" written by the person it is talking to from the same
 * sentence written by their partner, because the first is theirs to overrule
 * silently and the second is worth a passing word.
 *
 * Order is fully deterministic (oldest note first, authors in the order they first
 * wrote) so the prompt does not churn between turns over an unordered Firestore
 * read — a stable prefix is also what a model cache can reuse.
 *
 * Returns '' for no notes so the caller can omit the section entirely.
 */
export function renderKitchenMemories(memories: readonly KitchenMemoryDoc[]): string {
  if (memories.length === 0) return '';

  // `createdAt` is an ISO string, so lexicographic order is chronological order.
  // `id` breaks the tie for two notes written in the same millisecond.
  const sorted = [...memories].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

  const byAuthor = new Map<string, string[]>();
  for (const memory of sorted) {
    const existing = byAuthor.get(memory.author);
    if (existing) existing.push(memory.text);
    else byAuthor.set(memory.author, [memory.text]);
  }

  return [...byAuthor.entries()]
    .map(([author, texts]) => `${author}:\n${texts.map((t) => `- ${t}`).join('\n')}`)
    .join('\n\n');
}

/**
 * Reads and renders every kitchen memory. Degrades to '' on an empty, missing, or
 * unreadable collection — the notes are an enhancement and never a hard dependency,
 * so no turn fails because they could not be read (Rule 10).
 *
 * A note that fails validation is SKIPPED and the rest are kept: this is a list
 * read, and one malformed document must not silently cost the household every other
 * thing it told the chef.
 *
 * `flow` only labels the warn logs, matching `readEquipmentContext`.
 */
export async function readKitchenMemoryContext(
  db: ReturnType<typeof getFirestore>,
  flow: string,
): Promise<string> {
  try {
    const snap = await db.collection(KITCHEN_MEMORY_COLLECTION).get();
    const valid: KitchenMemoryDoc[] = [];
    for (const doc of snap.docs) {
      const result = KitchenMemorySchema.safeParse(doc.data());
      if (result.success) valid.push(result.data);
      else logger.warn(`${flow}: kitchenMemory ${doc.id} failed validation, skipping it`);
    }
    return renderKitchenMemories(valid);
  } catch (err) {
    logger.warn(`${flow}: failed to read kitchenMemories`, { err });
    return '';
  }
}

// ─── Chef framing (chefChat) ─────────────────────────────────────────────────
//
// Every hard word below is load-bearing, and the failure mode it guards against is
// the SAME one: a chef that treats the notes as a rulebook. That chef opens with
// what it remembers, checks you really want the thing you just asked for, swaps an
// ingredient without saying so, and refuses. All four read as nagging, and all four
// are worse than never having read the notes at all.
//
// "Standing instructions" is deliberately NOT the phrase — it is the accurate
// description of a rulebook and produces exactly that chef. "Preferences, not rules"
// with the conversation given explicit primacy is what makes a note shape an answer
// instead of policing it.
//
// The OTHER-PERSON restriction is what stops the one permitted mention from becoming
// a reminder: telling someone their own note says no mushrooms is nagging, whereas
// telling them their partner's does is information they need to cook for two.
// "ALWAYS WINS … exactly what they asked for … do not check they are sure" was read
// by the chef as a licence never to question ANY request, technique included: it
// praised a velouté idea and braised raw veg in it rather than warn. The scoping
// sentence after it confines the rule to notes-versus-request, which is all it was
// ever for; the advisor section in chefChat.ts owns technique.
const MEMORY_CHEF_FRAMING_HEAD = `## What the household has told you
Notes members of this household have written down for you, each under the name of \
whoever wrote it.`;

const MEMORY_CHEF_FRAMING_BODY = `These are preferences, not rules. A note in the first person is about its author; a note \
about the household applies to everyone.

WHAT IS SAID IN THIS CONVERSATION ALWAYS WINS. If someone asks for something a note argues \
against, they have changed their mind or have a reason. Give them exactly what they asked for. \
Do not point out the contradiction, do not check they are sure, do not quietly substitute an \
ingredient, and never present a note as a reason you cannot do something. This is about \
TASTE — a note against what they asked for. It never stops you warning that a METHOD will \
hurt the dish; that is cooking advice, and you always give it.

Raise a note only where it genuinely helps, only when it belongs to someone OTHER than the \
person you are talking to, and only once: say it in passing and offer the way round it — "this \
leans on mushrooms, which Daniel doesn't eat; they're easy to serve on the side". Then let it go.

Never list these back, never open with them, never use one to refuse.`;

/**
 * The chef's kitchen-memory section, or '' when there is nothing to show.
 *
 * `speaker` is who is typing. When it is absent — an older client after a deploy —
 * the "you are talking to …" line is DROPPED rather than emitted with an empty or
 * placeholder name. The chef then has no one to compare authors against and simply
 * says nothing about any note, which is the safe end of this feature's range.
 */
export function kitchenMemorySectionForChef(memoryContext: string, speaker?: string): string {
  if (!memoryContext) return '';
  const named = speaker?.trim();
  const head = named
    ? `${MEMORY_CHEF_FRAMING_HEAD} You are talking to ${named}.`
    : MEMORY_CHEF_FRAMING_HEAD;
  return `${head}\n\n${MEMORY_CHEF_FRAMING_BODY}\n\n${memoryContext}`;
}
