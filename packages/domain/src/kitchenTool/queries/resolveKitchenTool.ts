import { normaliseName } from '../../canon/index.js';
import type { KitchenToolDoc } from '../../schemas/kitchenTool.js';

// Pure table lookup: which curated kitchen tool does this free text name?
//
// The whole of issue #882 rests on this being a LOOKUP and nothing more. A recipe
// step and a guided plan's card store words a cook typed — "Magmix bowl", "meat
// plate", "large frying pan" — and the tool is found from those words every time
// the row is drawn. Nothing is written back, so the vocabulary can grow later and
// every plan already written picks up the new picture for free.
//
// DELIBERATELY NOT THE CANON MATCHING PIPELINE. No `findClosestMatch`, no
// embeddings, no AI arbitration, no `needs_approval` queue. Canon has all that
// because a miss there is expensive — an unmatched ingredient becomes an orphan
// canon item that pollutes a shared catalog and a shopping list. A miss here
// costs a missing picture and nothing else: the container's words render exactly
// as they always did. A closed, curated list of about forty tools with an exact
// lookup in front of it buys the same coverage for none of the cost or the risk.
//
// A tool is identified by EVERYTHING it is called — its `label` as well as its
// `matchers`, competing on equal terms, exactly as `resolveProductForm` does. A
// tool therefore never has to repeat its own name in `matchers`.
//
// Both sides are folded with canon's `normaliseName`, and the choice of
// normaliser is the settled fork documented at the top of
// `productForm/queries/resolveProductForm.ts`. `cookSession/normaliseContainerName`
// answers "are these two cards the same bowl?", where folding plurals would merge
// vessels a cook can tell apart; this asks "which tool is this?", where "bowls"
// and "bowl" must land on the same picture. Different questions, so they keep
// different normalisers — and neither may borrow the other's.
//
// Containment is token-aligned: a phrase must occupy whole words, so a tool
// matched on "pan" matches "large pan" and never "pandan". Longest phrase wins,
// measured on the NORMALISED phrase so the ordering is deterministic — which is
// what lets "small bowl" beat plain "bowl" and "frying pan" beat plain "pan".
export function resolveKitchenTool(
  name: string,
  tools: readonly KitchenToolDoc[],
): KitchenToolDoc | null {
  return resolveKitchenToolMatch(name, tools)?.tool ?? null;
}

/** A tool the lookup picked, and the normalised phrase it won on. */
export interface KitchenToolMatch {
  readonly tool: KitchenToolDoc;
  /**
   * The winning phrase, normalised — "mixing bowl" for "large mixing bowl", the
   * bare "bowl" for "Thermo Bowl". How much of the name the vocabulary actually
   * explained, which `resolveKitchenTool`'s answer alone cannot say.
   */
  readonly phrase: string;
  /** The name itself, normalised — the other half of "how much did it explain?". */
  readonly target: string;
}

/**
 * The lookup above, with the winning phrase kept (issue #1465).
 *
 * Not a second resolver and not a second opinion on one: `resolveKitchenTool` is
 * this function, and there is exactly one loop. It is split out because
 * `kitchenToolForKitLabel` has to weigh how MUCH of a name the vocabulary
 * explained, and a returned document cannot say. Nothing about the matching
 * changed — same phrases, same token-aligned containment, same
 * longest-normalised-phrase-wins.
 */
export function resolveKitchenToolMatch(
  name: string,
  tools: readonly KitchenToolDoc[],
): KitchenToolMatch | null {
  const target = normaliseName(name);
  if (!target) return null;
  // Pad both sides so `includes` can only land on token boundaries.
  const padded = ` ${target} `;
  let best: KitchenToolDoc | null = null;
  let bestPhrase = '';
  for (const tool of tools) {
    for (const phrase of [tool.label, ...tool.matchers]) {
      const p = normaliseName(phrase);
      if (p && p.length > bestPhrase.length && padded.includes(` ${p} `)) {
        best = tool;
        bestPhrase = p;
      }
    }
  }
  return best ? { tool: best, phrase: bestPhrase, target } : null;
}
