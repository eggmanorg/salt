import {
  ProposeKitchenToolsInputSchema,
  ProposeKitchenToolsAIOutputSchema,
  ProposeKitchenToolsOutputSchema,
  type ProposeKitchenToolsInput,
  type KitchenToolProposal,
  type KitchenToolProposalAI,
  type KitchenToolDoc,
} from '@salt/domain/schemas';
import { resolveKitchenTool } from '@salt/domain';
import { AI_TEXT_FLOW_TIMEOUT, withAiTimeout } from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { flowModel } from '../ai/fakeModel.js';

// proposeKitchenTools (issue #1458, Phase 2) — a proposed answer for every word
// the drawn vocabulary cannot name.
//
// The rows are #1489 Phase 3's. Each already carries `suggestKitchenToolParent`'s
// head-noun guess, which costs nothing and is on the row from first paint; this
// flow answers the harder question the head noun cannot — is this the tool we
// already draw, a thing of its own, or not kit at all — and the page replaces the
// guess in place when the answer arrives.
//
// ADVISORY, EXACTLY AS THE HEAD-NOUN GUESS IS. Nothing here writes, and nothing
// downstream of it writes without a press. That is the whole of #956's defence
// against a vocabulary that fills with near-duplicates: a robot minting one
// document and one Gemini image per SPELLING is the defect that issue measured,
// performed faster.

const PROPOSE_TOOLS_SYSTEM = `You are curating a small, closed vocabulary of simple kitchen-tool drawings.

Each drawing is one everyday object — a mixing bowl, a frying pan, a potato masher. A recipe or a meal plan \
stores the WORDS a cook typed, and the drawing is looked up from those words every time a row is shown. So a \
word the vocabulary cannot name shows no picture.

You are given the vocabulary — each tool's id, its name, and the other names it already answers to — and a \
list of words our own recipes and plans have used that the vocabulary cannot name. Answer every word, once.

For each word choose exactly one:

- "alias" — it is another name for a tool the vocabulary ALREADY has. Give that tool's id in \`toolId\`. \
This is the answer you should reach for first and by far the commonest right one: "masher" is the potato \
masher, "large mixing bowl" is the mixing bowl, "skillet" is the frying pan. Adding a name costs nothing and \
draws nothing new.
- "new" — it is a real, distinct object the vocabulary genuinely does not hold, and a cook would know it \
apart from everything in the list. Put what it should be CALLED in \`suggestedLabel\`: ordinary English prose, \
singular, sentence case, the plainest name a cook would use — "Tagine", not "tagine dish for cooking". Choose \
this sparingly. A modifier on something already drawn ("large", "small", "heatproof", "non-stick") is an \
alias, not a new tool.
- "not-kit" — it is not a piece of kit at all. A size ("20cm"), a quantity, an ingredient, a technique, an \
oven, a hob, a grill, a microwave, or a consumable like foil, cling film or baking paper. It is fine and \
common for a word to be none of our business.

Rules:
- Use only ids from the vocabulary you were given. Never invent one.
- Answer every word you were given, and no word you were not.
- If two of the given words name the same object, both may be aliases of the same tool.
- No explanation and no prose — just the three fields per word.`;

/** One vocabulary line for the prompt: id, name, and everything else it answers to. */
function renderVocabulary(tools: readonly KitchenToolDoc[]): string {
  return tools
    .map((tool) => {
      const also = tool.matchers.length > 0 ? ` — also called: ${tool.matchers.join(', ')}` : '';
      return `- [${tool.id}] ${tool.label}${also}`;
    })
    .join('\n');
}

/**
 * Trim the model's answer down to something a row can safely offer.
 *
 * Pure, and separated from the flow so it can be tested without a model — the
 * same split, for the same reason, as `sanitiseRecipeKit`. Everything the model
 * returns is untrusted, and five things it does eventually are fixed here:
 *
 *   - a `label` that was not in THIS call's list is dropped. The page keys its
 *     rows by the word it asked about, so an answer about a word it did not ask
 *     about has no row to land on. Matching is case- and whitespace-insensitive
 *     and the REQUESTED spelling is what comes back, because that spelling is the
 *     row's key.
 *   - a second answer for a word already answered is dropped; the first wins.
 *   - an `alias` naming an id that is not in the vocabulary that was sent is
 *     dropped entirely. The row then keeps its head-noun suggestion, which is
 *     exactly the no-proposal state — a proposal pointing at nothing is worse
 *     than none.
 *   - a `new` with a blank or whitespace-only `suggestedLabel` falls back to the
 *     word itself. That is what the row's own "Make it a tool" would have
 *     pre-filled, so nothing is lost and no answer is thrown away.
 *   - **a `new` whose words the vocabulary can ALREADY name becomes an `alias` to
 *     the tool that names them.** See below.
 *
 * ── THE ALIAS-OVER-NEW GUARD, AND ITS BOUNDARY (Rule 12) ─────────────────────
 *
 * THE CLAIM: a word containing an existing tool's whole name, token-aligned, is
 * never proposed as a new tool. It is pinned by
 * `tests/flows/proposeKitchenTools.test.ts`, verified red by removing the guard.
 * The check is `resolveKitchenTool` — the same lookup the strip, the mise card
 * and the admin page all draw through — so the guard can never disagree with the
 * renderer about what the vocabulary already names, and there is no second notion
 * of "matched" anywhere in this file. Both the word and the model's own
 * `suggestedLabel` are checked: proposing a new tool called "Mixing bowl" beside
 * the Mixing bowl is the same duplicate by a different route.
 *
 * WHAT IT DOES NOT CLAIM. The vocabulary cannot be guaranteed not to bloat, and
 * this does not guarantee it: a person may always confirm a `new` that should
 * have been an alias, and no test can stop them. Nor is the guard always RIGHT —
 * it is a preference, not a truth. `kitchenToolForKitLabel`'s accessory rule
 * (#1460) deliberately refuses to let "Thermo Bowl" borrow the bowl's drawing,
 * and for such a word this guard will still propose the alias that rule rejected.
 * That is the accepted cost of putting #956's bloat defence first: the row's menu
 * still offers "Give it its own picture" in one press, and a proposal is a
 * sentence rather than a gate.
 */
export function sanitiseKitchenToolProposals(
  proposals: readonly KitchenToolProposalAI[],
  labels: readonly string[],
  tools: readonly KitchenToolDoc[],
): KitchenToolProposal[] {
  const fold = (raw: string): string => raw.trim().replace(/\s+/g, ' ').toLowerCase();
  const requested = new Map<string, string>();
  for (const label of labels) {
    const key = fold(label);
    if (key && !requested.has(key)) requested.set(key, label);
  }
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const answered = new Map<string, KitchenToolProposal>();

  for (const proposal of proposals) {
    const label = requested.get(fold(proposal.label));
    if (label === undefined || answered.has(label)) continue;

    if (proposal.kind === 'not-kit') {
      answered.set(label, { kind: 'not-kit', label });
      continue;
    }
    if (proposal.kind === 'alias') {
      const toolId = proposal.toolId?.trim() ?? '';
      if (!byId.has(toolId)) continue;
      answered.set(label, { kind: 'alias', label, toolId });
      continue;
    }
    // `new` — but only where the vocabulary genuinely cannot already name it.
    const suggestedLabel = proposal.suggestedLabel?.trim() || label;
    const existing = resolveKitchenTool(label, tools) ?? resolveKitchenTool(suggestedLabel, tools);
    answered.set(
      label,
      existing
        ? { kind: 'alias', label, toolId: existing.id }
        : { kind: 'new', label, suggestedLabel },
    );
  }

  return [...answered.values()];
}

export const proposeKitchenToolsFlow = ai.defineFlow(
  {
    name: 'proposeKitchenTools',
    inputSchema: ProposeKitchenToolsInputSchema,
    outputSchema: ProposeKitchenToolsOutputSchema,
  },
  async ({ labels, tools }: ProposeKitchenToolsInput) => {
    // Nothing to answer for. Short-circuited before the model rather than after,
    // so an empty queue costs nothing at all — the page asks on arrival and an
    // admin opening a page with a caught-up vocabulary is the common case.
    if (labels.length === 0) return { proposals: [] };

    const prompt = [
      `The vocabulary:\n${renderVocabulary(tools)}`,
      `Words to answer for:\n${labels.map((label) => `- ${label}`).join('\n')}`,
    ].join('\n\n');

    // `fast` + temperature 0, the same posture as identifyRecipeKit: two curators
    // shown the same queue should reach the same grouping, and a vocabulary is
    // not a place for invention.
    const model = await flowModel('proposeKitchenTools');
    const result = await withAiTimeout(
      'proposeKitchenTools',
      () =>
        ai.generate({
          model,
          system: PROPOSE_TOOLS_SYSTEM,
          prompt,
          output: { schema: ProposeKitchenToolsAIOutputSchema },
          config: { temperature: 0 },
        }),
      // The house callable budget: a person is sat on the kitchen-tools page
      // watching the rows, and the page is fully usable without this answer, so
      // there is nothing to gain from waiting longer and no retry worth paying
      // for.
      AI_TEXT_FLOW_TIMEOUT,
    );

    // AI output is a trust boundary — validate before it leaves the flow.
    const parsed = ProposeKitchenToolsAIOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`proposeKitchenTools returned invalid output: ${parsed.error.message}`);
    }

    return { proposals: sanitiseKitchenToolProposals(parsed.data.proposals, labels, tools) };
  },
);
