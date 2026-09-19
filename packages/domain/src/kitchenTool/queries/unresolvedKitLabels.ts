import { normaliseName } from '../../canon/index.js';
import { resolveEquipmentItem, resolveKitEntryEquipment } from '../../equipment/index.js';
import type { EquipmentItem } from '../../equipment/index.js';
import { kitchenToolForKitLabel } from './kitchenToolForKitLabel.js';
import type { KitchenToolDoc } from '../../schemas/kitchenTool.js';
import type { RecipeKitEquipmentLinkDoc } from '../../schemas/recipe.js';

// Which words has our own content already used that the drawn vocabulary cannot
// name? (Issue #882, Phase 4.)
//
// The vocabulary is curated, so the only honest way to grow it is to look at what
// people actually wrote. A recipe's `kit[].label` and a guided plan's two
// container fields are free text a human or the librarian typed; anything in them
// that resolves to nothing is a picture Salt could be drawing and is not. This
// query is that list, ranked by how often the miss came up, so the person
// curating spends their first write on the name that appears twelve times rather
// than the one that appears once.
//
// PURE, and takes plain arrays rather than stores or documents-by-id, because the
// admin page is not the only conceivable caller and none of them should have to
// hand this function a Firestore. It reads nothing and writes nothing — which is
// the feature's whole promise: adding a tool lights up every recipe and plan that
// already said the word, with no reprocessing and no write to either.
//
// IT RESOLVES WITH `resolveKitchenTool`, the same function the strip, the mise
// card and the step callout all draw through. Not a second, queue-flavoured
// notion of "unmatched": if the queue disagreed with the renderer by so much as a
// plural, it would either hide a real gap or offer a row that nothing on screen
// is missing.
//
// AND WITH `resolveEquipmentItem` FIRST, for exactly that reason (issue #954).
// Since the kit flow gained the manifest, a label can be an appliance this
// household owns — "Magimix Cook Expert" — and those already have pictograms, in
// `equipmentIcons`. A queue that did not exclude them would invite someone to draw
// a `kitchenTools` cartoon of a Magimix that Salt already holds a drawing of, and
// the row would never clear: adding the tool would not change what the strip
// renders, because the strip resolves equipment first too.

/** The shape this query reads off a recipe — a full `Recipe` satisfies it. */
export interface KitLabelSource {
  readonly kit: readonly {
    readonly label: string;
    /** The recorded link, when the flow knew which of your things it meant (#1465). */
    readonly equipment?: RecipeKitEquipmentLinkDoc | null;
  }[];
}

/** The shape this query reads off a guided plan — a full `GuidedPlanDoc` satisfies it. */
export interface ContainerSource {
  readonly prep: readonly { readonly container: string | null }[];
  readonly stepNotes: readonly { readonly container: string | null }[];
}

/** One queue row: a name nothing draws, and how many times our content said it. */
export interface UnresolvedKitLabel {
  /** The spelling to show and to pre-fill the add form with. */
  readonly label: string;
  /** How many mentions across every source folded into this row. */
  readonly count: number;
}

// Whitespace is a spelling difference, never a distinction: "large bowl " and
// "large  bowl" are the same words typed carelessly.
function tidy(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

export function unresolvedKitLabels(
  recipes: readonly KitLabelSource[],
  plans: readonly ContainerSource[],
  tools: readonly KitchenToolDoc[],
  equipment: readonly EquipmentItem[],
): UnresolvedKitLabel[] {
  const mentions: string[] = [];
  for (const recipe of recipes) {
    for (const entry of recipe.kit) {
      // A LINKED entry is not a gap in the vocabulary (issue #1465). It names one
      // of the household's own things and draws through `equipmentIcons`, exactly
      // as a resolved equipment label does below — offering it here would invite
      // someone to mint a `kitchenTools` cartoon that no surface would ever show.
      // A link that no longer resolves falls through and is counted, which is
      // right: the row IS words with no picture again.
      if (resolveKitEntryEquipment(entry, equipment)) continue;
      mentions.push(entry.label);
    }
  }
  for (const plan of plans) {
    // Both free-text container fields, on equal terms. A prep job's container and
    // a step note's container are the same kind of word — the vessel a cook is
    // told to reach for — and a name that appears as both is one gap, not two.
    // `null` is the schema's honest "this job puts nothing anywhere", and a blank
    // string is the same thing typed; neither is evidence of a missing picture.
    for (const entry of plan.prep) if (entry.container) mentions.push(entry.container);
    for (const note of plan.stepNotes) if (note.container) mentions.push(note.container);
  }

  // Grouped by `normaliseName`, which is the SAME fold the resolver applies. That
  // is not a convenience: two names with one normalised form always resolve
  // identically, so this key groups exactly the mentions that one vocabulary write
  // would fix together, and can never merge two names a single addition would
  // leave split. Folding case, punctuation and plurals with it is therefore
  // correct rather than merely tidy — "Large Bowls" and "large bowl" are one row
  // because they are one gap.
  const groups = new Map<string, { spellings: Map<string, number>; count: number }>();
  for (const raw of mentions) {
    const name = tidy(raw);
    if (!name) continue;
    const key = normaliseName(name);
    // A name that normalises away entirely ("500g", "2") names no tool and never
    // could — it is a quantity that wandered into a container field.
    if (!key) continue;
    // Equipment first, and in the same order the renderer tries them — a branded
    // name contains generic tokens ("…Slow Cook Pot"), so asking the tool
    // vocabulary first would answer for a label the strip never shows a tool for.
    //
    // AND THROUGH THE SAME TOOL LOOKUP THE RENDERER USES (issues #1460, #1465).
    // `kitchenToolForKitLabel`, not the bare `resolveKitchenTool`: a label that
    // exactly names one of the manifest's accessories is refused an unrelated
    // object's drawing, and a queue asking the plain resolver would drop that row
    // as "already drawn" while the page showed nothing. The queue and the renderer
    // answer with one function, for the reason the header states above — if the
    // two disagreed by so much as a plural, the queue would hide a real gap.
    if (resolveEquipmentItem(name, equipment)) continue;
    if (kitchenToolForKitLabel(name, tools, equipment)) continue;
    let group = groups.get(key);
    if (!group) {
      group = { spellings: new Map(), count: 0 };
      groups.set(key, group);
    }
    group.count += 1;
    group.spellings.set(name, (group.spellings.get(name) ?? 0) + 1);
  }

  const rows: UnresolvedKitLabel[] = [];
  for (const group of groups.values()) {
    // The spelling most people used, so the row reads the way the content does.
    // Ties go alphabetically — arbitrary, but the same arbitrary answer on every
    // render, which is what stops the list rewording itself under the cursor.
    let label = '';
    let best = -1;
    for (const [spelling, n] of group.spellings) {
      if (n > best || (n === best && spelling.localeCompare(label) < 0)) {
        label = spelling;
        best = n;
      }
    }
    rows.push({ label, count: group.count });
  }

  // Loudest gap first; alphabetical within a count, for the same no-jitter reason.
  return rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
