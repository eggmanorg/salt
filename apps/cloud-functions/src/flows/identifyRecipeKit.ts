import {
  IdentifyRecipeKitInputSchema,
  IdentifyRecipeKitAIOutputSchema,
  IdentifyRecipeKitOutputSchema,
  type IdentifyRecipeKitInput,
  type IdentifyRecipeKitAIEntry,
  type RecipeKitEntryDoc,
  type RecipeKitEquipmentLinkDoc,
} from '@salt/domain/schemas';
import { AI_TRIGGER_FLOW_TIMEOUT, withAiTimeout } from '../adapters/withAiTimeout.js';
import { equipmentSectionForKit, renderEquipmentManifestForKit } from './equipmentContext.js';
import { ai } from '../genkit.js';
import { flowModel } from '../ai/fakeModel.js';

// identifyRecipeKit (issue #882) — "what do I need to get out?", answered from the
// WHOLE stored recipe.
//
// A separate best-effort pass over what was SAVED, on the describeRecipeScene
// model, and that is a scope rule rather than a convenience. The librarian and the
// two extractors are temperature-0 TRANSCRIBERS (docs/ai-kitchen-assistant.md
// § Scope boundaries): handing them "and also work out what kit this needs" would
// license them to reason about a recipe they are meant to copy down. Kit is
// inference — a recipe that says "mash the potatoes" needs a masher it never names
// — so it runs afterwards, over the finished document, and cannot touch it.
//
// Labels are FREE TEXT and there is no enum over the drawn vocabulary anywhere in
// this file. See IdentifyRecipeKitInputSchema's header for why that is the whole
// point: a constrained list turns a potato masher into a fork.
//
// It is also handed the household's equipment manifest (issue #954), which is what
// lets a label say "Magimix Cook Expert" rather than "food processor" — the
// manifest holds four things that answer to "food processor", so the generic word
// answers nothing. The licence that comes with it is deliberately narrow and lives
// in EQUIPMENT_KIT_FRAMING (equipmentContext.ts): name which one, never introduce
// one.

const IDENTIFY_KIT_SYSTEM = `You are an experienced cook reading a recipe before starting, working out what to \
get out of the cupboards. You are given the recipe's title, description, ingredients and numbered method steps, \
each step with an id. Return the KIT the cook needs.

## What counts as kit
Things you take out and put on the worktop: pans, pots, trays, tins, bowls, boards, knives, colanders, sieves, \
whisks, graters, mashers, rolling pins, tongs, ladles, measuring jugs, thermometers, skewers, piping bags.

Do NOT return:
- ingredients, or anything you eat
- the oven, hob, grill or microwave — they are the kitchen, not something you get out
- consumables: foil, cling film, baking paper, kitchen roll, string
- an appliance for a job the method does by hand. A stand mixer, food processor, air fryer, blender or \
pressure cooker belongs in the answer only when the method genuinely cannot be done without it — never as a \
convenience you are offering.

## How to name it
Name it the way a cook would say it out loud, and be specific enough that the right one comes out of the \
cupboard: "large frying pan", not "pan". "box grater", not "grater". "small saucepan", "baking tray", \
"large mixing bowl", "chopping board", "sharp knife", "wooden spoon", "fine sieve". Singular, no quantities, \
and no explanation — just the thing.

CAPITALS: write the label as ordinary English prose, exactly the way an ingredient line is written. An \
everyday piece of kit is lower case — "hand blender attachment", not "Hand Blender Attachment"; "steam \
basket", not "Steam Basket". Capitals belong to a genuine proper name and nothing else: a maker and model \
keep theirs, the same way one ingredient line holds "Dijon mustard" and "fine sea salt" together.

NEVER generalise a named appliance back to a generic one. If a step says "Magimix Cook Expert", the kit says \
"Magimix Cook Expert" — not "food processor". Same for a named accessory, attachment, mode or setting. A \
name the recipe already carries is a name the cook needs; flattening it is throwing away the answer.

## Work it out, do not copy it out
Most of the kit is never named in the method. "Mash the potatoes" needs a potato masher. "Drain the pasta" \
needs a colander. "Whisk the eggs until pale" needs a whisk and a bowl. Read what the cook is DOING and name \
what they are doing it with. Equally, do not invent kit for work the recipe does not do.

## Which steps
For each piece of kit, list the ids of the steps that actually use it — every one of them, not just the first. \
A frying pan used at the start and returned to later belongs to both steps. Use ONLY step ids from the list you \
are given; never invent one, and never use a step number in place of an id.

## Which of their things
Every entry has a \`ref\` field. It is null unless you are given a list of this household's own kit with \
handles in brackets, in which case you copy the handle of the thing the entry names. It is a separate \
question from the words: \`label\` stays what a cook would say out loud either way.

Return one entry per distinct piece of kit — no duplicates. A short, honest list beats a long one: if a dish \
needs a pan and a spoon, return a pan and a spoon.`;

/**
 * Trim the model's answer down to something safe to write on a recipe.
 *
 * Pure, and separated from the flow so it can be tested without a model. Three
 * things it fixes, all of which a model does eventually:
 *   - a step id that is not a step on THIS recipe (a hallucinated or stale id) is
 *     dropped. An entry may legitimately end up with no steps at all — a mixing
 *     bowl the method never mentions is still real kit — so an emptied `stepIds`
 *     does not drop the entry.
 *   - an entry with a blank (or whitespace-only) label is dropped entirely: a
 *     picture-less, word-less chip is nothing at all.
 *   - two entries naming the same thing are collapsed into one, case- and
 *     whitespace-insensitively, keeping the FIRST label's spelling and merging
 *     both step lists. The model asked for "Large frying pan" and "large frying
 *     pan" means one pan, and the strip must not show it twice.
 *   - a `ref` that is not a handle from THIS call's kitchen list is dropped, and
 *     the entry and its words are kept (issue #1465). Same posture as the step
 *     ids above: an invented or stale handle costs the line its link, never its
 *     existence. This is the trust boundary doing its job — a returned link is
 *     untrusted, exactly as a returned step id is.
 *
 * @param handles The handle→ids map `renderEquipmentManifestForKit` built for
 *   this same call. Empty (no manifest) means no `ref` can survive, which is the
 *   correct reading: nothing was offered, so nothing can have been named.
 */
export function sanitiseRecipeKit(
  kit: readonly IdentifyRecipeKitAIEntry[],
  stepIds: readonly string[],
  handles: ReadonlyMap<string, { itemId: string; accessoryId: string | null }> = new Map(),
): RecipeKitEntryDoc[] {
  const realSteps = new Set(stepIds);
  const linkFor = (ref: string | null): RecipeKitEquipmentLinkDoc | null => {
    if (!ref) return null;
    // The prompt SHOWS the handle in brackets — `[k3.2] Steam Basket` — but the
    // map is keyed on the bare handle `renderEquipmentManifestForKit` minted, so a
    // model that (plausibly, reading "copy its handle EXACTLY") answers back
    // `ref: "[k3.2]"` must still resolve, or the link is dropped silently. Harmless
    // for the bracket-free answer, which is the common case.
    const trimmed = ref.trim();
    const key =
      trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1).trim() : trimmed;
    const ids = handles.get(key);
    return ids ? { itemId: ids.itemId, accessoryId: ids.accessoryId } : null;
  };
  // Insertion-ordered, so the kit stays in the order the model listed it —
  // which, asked to read a method top to bottom, is roughly the order it is
  // needed in.
  const byKey = new Map<string, RecipeKitEntryDoc>();
  for (const entry of kit) {
    const label = entry.label.trim();
    if (!label) continue;
    const key = label.toLowerCase().replace(/\s+/g, ' ');
    const steps = entry.stepIds.filter((id) => realSteps.has(id));
    const equipment = linkFor(entry.ref);
    const existing = byKey.get(key);
    if (existing) {
      // Merge rather than replace: the two mentions may each know a different
      // half of where the thing is used — and, since #1465, one of them may be
      // the only one that said which of your things it is. The FIRST surviving
      // link wins, matching the first label's spelling winning above.
      const merged = new Set([...existing.stepIds, ...steps]);
      byKey.set(key, {
        label: existing.label,
        stepIds: [...merged],
        equipment: existing.equipment ?? equipment,
      });
    } else {
      byKey.set(key, { label, stepIds: [...new Set(steps)], equipment });
    }
  }
  return [...byKey.values()];
}

export const identifyRecipeKitFlow = ai.defineFlow(
  {
    name: 'identifyRecipeKit',
    inputSchema: IdentifyRecipeKitInputSchema,
    outputSchema: IdentifyRecipeKitOutputSchema,
  },
  async ({ title, description, ingredients, steps, equipment }: IdentifyRecipeKitInput) => {
    const promptParts = [
      `Title: ${title}`,
      description ? `Description: ${description}` : null,
      ingredients.length > 0
        ? `Ingredients:\n${ingredients.map((i) => `- ${i}`).join('\n')}`
        : null,
      // The id travels WITH the step text rather than in a separate list, because
      // the model has to answer with ids and the cheapest way to make that reliable
      // is to never separate an id from the words it belongs to.
      steps.length > 0
        ? `Method (each step is "[id] text" — use these ids verbatim):\n${steps
            .map((s) => `[${s.id}] ${s.text}`)
            .join('\n')}`
        : null,
    ].filter((p): p is string => p !== null);

    // `fast` + temperature 0: the same posture as estimateRecipeTimes. Two cooks
    // reading the same recipe should reach for the same pans, and a kit list is
    // not a place for invention.
    const model = await flowModel('identifyRecipeKit');
    // The manifest rides on the SYSTEM prompt, beneath the naming rules, exactly as
    // it does for the chef and the librarian — it is policy about the kitchen, not
    // part of the recipe being read. '' (no manifest, or an unreadable one) leaves
    // the system prompt byte-for-byte what it was before #954.
    // The rendering and the handle map, from one pass over the same items (issue
    // #1465): the model is shown `[k3.2] Steam Basket` and answers `ref: "k3.2"`,
    // and only this map turns that back into manifest ids. It never leaves the
    // server, so a handle the model invents resolves to nothing.
    const { rendered, byHandle } = renderEquipmentManifestForKit(equipment);
    const equipmentSection = equipmentSectionForKit(rendered);
    const system = equipmentSection
      ? `${IDENTIFY_KIT_SYSTEM}\n\n${equipmentSection}`
      : IDENTIFY_KIT_SYSTEM;
    const result = await withAiTimeout(
      'identifyRecipeKit',
      () =>
        ai.generate({
          model,
          system,
          prompt: promptParts.join('\n\n'),
          output: { schema: IdentifyRecipeKitAIOutputSchema },
          config: { temperature: 0 },
        }),
      // The TRIGGER budget, not the callable one (issue #1418). This flow's only
      // host is `onRecipeWritten`, which runs for 300s and has nobody waiting on
      // it, so a deadline sized for a person watching a spinner only threw away
      // answers we had already paid for — four recipes arrived with no kit
      // because of it. No retry: one attempt now fills almost the whole quota.
      //
      // A failure still leaves `kitInferredAt` unstamped, and the guard is
      // edge-triggered on a nonce, so Redo kit remains the only retry path.
      AI_TRIGGER_FLOW_TIMEOUT,
    );

    // AI output is a trust boundary — validate before it leaves the flow.
    const parsed = IdentifyRecipeKitAIOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`identifyRecipeKit returned invalid output: ${parsed.error.message}`);
    }

    return {
      kit: sanitiseRecipeKit(
        parsed.data.kit,
        steps.map((s) => s.id),
        byHandle,
      ),
    };
  },
);
