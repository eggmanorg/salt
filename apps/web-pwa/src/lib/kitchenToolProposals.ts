import { callProposeKitchenTools } from '@salt/firebase-sync';
import type { KitchenToolDoc, KitchenToolProposal } from '@salt/domain/schemas';

// Salt's proposed answer for each word the drawn vocabulary cannot name (issue
// #1458, Phase 2).
//
// ITS OWN MODULE, NOT `kitchenToolService.ts`, and that is the point rather than
// tidiness. That file's commands block states that every vocabulary write is a
// plain client write with no callable in front of it, and says why the page was
// built that way. This is the one call the page makes that IS a callable — it
// reads, it writes nothing, and it is here because an AI key cannot live in a
// browser. Keeping it out of that file keeps that sentence true.
//
// BEST-EFFORT, AND SILENT WHEN IT FAILS (Rule 10). There is no toast and no
// retry: every gap row is painted with `suggestKitchenToolParent`'s head-noun
// suggestion before this is asked, and stays fully actionable whether or not an
// answer ever arrives. A model that is down costs the page a sentence.

/** Salt's answer per word, keyed by the word exactly as it was asked about. */
export type KitchenToolProposals = ReadonlyMap<string, KitchenToolProposal>;

/**
 * Ask for an answer to the whole queue at once, and hand back what came.
 *
 * ONE CALL FOR EVERY ROW. The judgement worth paying for is GROUPING — that
 * "large mixing bowl" and "Large Bowls" are the bowl we already draw — and a
 * model shown one word at a time cannot make it. It is also what keeps opening
 * this page to a single model call.
 *
 * An empty map is the honest answer to every failure mode there is: the call was
 * refused, the model was unavailable, or it had nothing to say. The caller cannot
 * tell them apart and has no different move for any of them.
 *
 * NO EMPTY-QUEUE GUARD HERE. The page does not ask when there is nothing to ask
 * about — it must not, because latching "asked" on an empty queue would mean
 * never asking once the queue arrives — so a guard here would be a second copy of
 * a decision that has to live there anyway, and one no test could reach. The flow
 * short-circuits an empty list server-side for the caller that gets it wrong.
 */
export async function proposeKitchenTools(
  labels: readonly string[],
  tools: readonly KitchenToolDoc[],
): Promise<KitchenToolProposals> {
  const result = await callProposeKitchenTools({ labels: [...labels], tools: [...tools] });
  if (result.kind !== 'ok') return new Map();
  return new Map(result.value.proposals.map((proposal) => [proposal.label, proposal]));
}
