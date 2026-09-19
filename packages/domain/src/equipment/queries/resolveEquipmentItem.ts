import { normaliseName } from '../../canon/index.js';
import type { EquipmentItem } from '../entities/EquipmentItem.js';

// Pure table lookup: which piece of equipment this household OWNS does this free
// text name? (Issue #954.)
//
// The twin of `kitchenTool/queries/resolveKitchenTool.ts`, and it exists for the
// half of the question that one cannot answer. `kitchenTools` is a curated
// vocabulary of generic objects — a whisk, a box grater, a mandoline — and a
// generic word is precisely what the "You'll need" strip must stop saying: this
// household owns two mandolines and four things that answer to "food processor",
// so "mandoline" does not tell anyone which one to get out. Since #954 the kit
// flow is handed the manifest and writes the item's own name, verbatim; this is
// the display-time join that turns that name back into the item's pictogram.
//
// NOTHING IS STORED. As with `resolveKitchenTool`, no id is written onto a recipe
// — the recipe keeps the words and the item is found from them every render, so
// renaming an item in the manifest fixes every recipe at once and costs nothing.
//
// THE MATCHING RULE, and why it is not `resolveKitchenTool`'s. That one matches on
// token-aligned containment, which is right for a closed vocabulary of common
// nouns and wrong for product names: "Magimix Cocotte Slow Cook Pot" contains the
// token "pot", so containment in either direction would let the bare word "pot"
// select it — a generic label borrowing a specific item's picture, which is the
// exact failure the strip is being fixed for. So a label names an item only when
// BOTH hold:
//
//   1. it carries the item's LEADING word — the maker's name, almost always, and
//      the one word in a product name that is never generic. This is what "pot",
//      "mandoline" and "large frying pan" all fail on.
//   2. every word it carries is a word that item's name also carries. This is what
//      lets "OXO Mandoline" find "OXO Good Grips Chef's Mandoline" without
//      inventing a fuzzy score, and what stops "Kenwood MultiPro Go" landing on
//      the Kenwood Chef.
//
// AMBIGUITY IS A MISS, NEVER A GUESS. A label satisfying both against more than
// one item ("Kenwood", with two Kenwoods in the manifest) returns null and falls
// through to the tool vocabulary and then to bare words — the #882 graceful-miss
// contract. Borrowing one of two pictures at random is worse than showing none.
// This applies on EVERY path, exact match included: `normaliseName` strips model
// numbers, so "OXO Good Grips 2.0" and "OXO Good Grips 3.0" fold to the same
// string, and a naive `.find` would silently hand the label to whichever one
// happened to come first. Two items tying on the same normalised name say
// nothing, exactly as two items tying on the subset rule below do.
//
// ACCESSORIES RESOLVE TO THEIR OWNING ITEM. The manifest stores an accessory
// under its item ("Cocotte Slow Cook Pot" is one of the Magimix Cook Expert's),
// and the kit flow is licensed to name one — so a label can be the item's
// leading word plus an accessory's name ("Magimix Cocotte Slow Cook Pot",
// "FoodSaver Fresh Container") rather than the item's own name. Neither
// accessory has an icon of its own — `equipmentIcons` is keyed by item id, not
// accessory id — so the owning item IS the right identity to resolve to; there
// is no separate "accessory" result to invent. The same two-part rule governs
// it: the label must still carry the OWNING item's leading word (never a bare
// accessory name floating free of its maker — that is what keeps "container"
// failing against FoodSaver's owned "Fresh Container", the same way "pot" fails
// against the Cocotte), and every word the item's own name does not already
// explain must belong to that one accessory.
//
// Both sides fold through canon's `normaliseName`, the same normaliser
// `resolveKitchenTool` uses, so case, punctuation, hyphens and plurals cannot
// split a match. Note what it also strips: bare and digit-prefixed numeric tokens,
// so "Benriner BN-95W" folds to "benriner bn" and a model number can never be the
// distinctive word a match rests on.
export function resolveEquipmentItem(
  label: string,
  items: readonly EquipmentItem[],
): EquipmentItem | null {
  const target = normaliseName(label);
  if (!target) return null;
  const labelTokens = new Set(target.split(' '));

  // Exact first, and it wins outright: when one item is called exactly this, no
  // longer name that merely contains the same words can be a better answer.
  // ("Magimix Cook Expert" must not be beaten by "Magimix Cook Expert XL".) But
  // "outright" only holds when exactly one item claims it — a tie here is the
  // same ambiguity the subset rule below refuses to guess through.
  const exactMatches = items.filter((item) => normaliseName(item.name) === target);
  if (exactMatches.length > 1) return null; // two items answer to this exactly — say nothing
  if (exactMatches.length === 1) return exactMatches[0]!;

  let match: EquipmentItem | null = null;
  for (const item of items) {
    const tokens = normaliseName(item.name).split(' ').filter(Boolean);
    const head = tokens[0];
    if (!head || !labelTokens.has(head)) continue;
    const own = new Set(tokens);
    let subset = ownNameExplains(labelTokens, own);
    if (!subset) {
      // The item's own name does not cover every word — maybe the rest is one
      // of ITS owned accessories, named alongside the item's leading word.
      const extra = [...labelTokens].filter((word) => !own.has(word));
      subset = (item.accessories ?? []).some((accessory) => {
        const accTokens = new Set(normaliseName(accessory.name).split(' ').filter(Boolean));
        return extra.length > 0 && extra.every((word) => accTokens.has(word));
      });
    }
    if (!subset) continue;
    if (match) return null; // two owned items answer to this — say nothing
    match = item;
  }
  return match;
}

// PART 2 OF THE RULE. Does the item's own name carry every word the label carries?
// Takes tokens rather than strings because the caller above already has both sides
// folded and must not fold them twice per item.
//
// It was factored out of the loop by issue #1196 because `namesItemItself` — the
// "does this label name the machine rather than one of its parts?" test
// `groupKitByEquipment` asked before it grouped on the link alone — needed the
// identical membership rule and had a copy of it. That second caller went with
// #1465's word passes, so this is private again and there is nothing left to
// drift from.
function ownNameExplains(labelTokens: Iterable<string>, own: ReadonlySet<string>): boolean {
  for (const word of labelTokens) {
    if (!own.has(word)) return false;
  }
  return true;
}
