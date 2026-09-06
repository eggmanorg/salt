// Shared kitchen-equipment prompt fragment for every flow that needs to know what
// the household actually owns. The chef (chefChat) reasons about which kit to
// reach for, and the librarian (authorRecipe) must preserve the appliance
// specifics the chef and user agreed on, so the manifest READ and its RENDERING
// live here once — a single source of truth that cannot drift between the two
// prompts. (Before this, only chefChat read the manifest and authorRecipe
// flattened "in the Pizzaiolo at 400 °C" back to "bake in the oven".)
//
// SCOPE: reading + rendering the manifest, plus the three framings that wrap it.
// The framings are deliberately NOT interchangeable and must not be merged:
//   - EQUIPMENT_CHEF_FRAMING gives the chef licence to CHOOSE kit (proportionately).
//   - EQUIPMENT_LIBRARIAN_FRAMING gives the librarian licence to PRESERVE ONLY.
//     authorRecipe is a temperature-0 transcriber; handing it the manifest must
//     never license it to pick an appliance the conversation did not establish.
//   - EQUIPMENT_KIT_FRAMING gives identifyRecipeKit licence to NAME WHICH ONE.
//     It may not add an appliance to a method that does its work by hand, but when
//     the method already reaches for one it must say which — that is the whole
//     question the "You'll need" strip exists to answer (issue #954).
//
// All three sit in this one file deliberately. One authoring policy written as prose
// in three prompt files is the drift #934 is about, and #954 WAS that drift: the
// librarian was told never to generalise a named appliance while the kit flow, one
// pass later, was told "no brand names".
//
// STORED CAPABILITIES: THE NUMBERS, NEVER THE CONTRAPTION (issue #1281).
//
// This file used to say that equipment capabilities are deliberately NOT stored,
// because a pro model already knows these named products and stored capabilities
// would duplicate that knowledge and go stale. That reasoning holds for
// commercial kit and fails for a household's own: the fermentation chamber is a
// polystyrene box with a seedling heat mat, and the curing chamber a wine fridge
// with a heat mat and a reptile fogger. No model can look those up, and a
// chamber's CURRENT SETPOINT is a fact about this household this month that no
// product knowledge could ever supply.
//
// The line drawn instead is narrow, and the old rule still governs everything on
// the far side of it: the temperature range, the humidity capability, the
// control mode and the standing setpoint are STORED FIELDS
// (`EquipmentItemSchema.environment`); WHAT THE THING IS BUILT FROM stays prose
// in `rules`, which is where the chef already reads it. A full capability
// catalogue is exactly the drift this decision is one step away from, and is
// still refused.
//
// Beyond `environment`, no schema change backs this file: `AccessorySchema.owned`
// and `EquipmentItemSchema.rules` already existed.

import type { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import {
  EquipmentManifestSchema,
  EQUIPMENT_MANIFEST_COLLECTION,
  EQUIPMENT_MANIFEST_DOC_ID,
} from '@salt/domain/schemas';
import type { EquipmentItemDoc } from '@salt/domain/schemas';

/**
 * Renders one item's `environment` as prompt lines, or [] when it is not a
 * place. Exported for its unit tests; the manifest renderer is the only caller.
 *
 * The control mode is spelled out rather than named, because "shared" and
 * "dedicated" are Salt's words and a model reading them cold would guess.
 */
export function renderEquipmentEnvironment(item: EquipmentItemDoc): string[] {
  const env = item.environment;
  if (!env) return [];
  const lines = [`  holds a temperature: ${env.minCelsius}–${env.maxCelsius} °C`];
  if (env.humidity) {
    const how = env.humidity.precision === 'controlled' ? 'controlled' : 'roughly held';
    lines.push(`  humidity: ${how}, ${env.humidity.minPercent}–${env.humidity.maxPercent}% RH`);
  } else {
    lines.push('  humidity: no control');
  }
  if (env.control === 'shared') {
    // `standing` is read ONLY on a shared place: the schema does not forbid one
    // on a dedicated place (see its field docs), so the guard is here.
    const standing = env.standing;
    const at = standing
      ? `${standing.celsius} °C${
          standing.relativeHumidityPercent === null
            ? ''
            : ` and ${standing.relativeHumidityPercent}% RH`
        }`
      : 'a setting nobody has recorded';
    lines.push(
      `  shared — it holds several things at once, so it is set to ${at} and a single job does not change it`,
    );
  } else {
    lines.push('  dedicated — it holds one job at a time, so it is set for that job');
  }
  return lines;
}

/**
 * Renders the equipment manifest as plain text for a system prompt.
 *
 * Owned and unowned accessories are BOTH rendered — unowned ones explicitly
 * marked unavailable — so the chef can say "that needs the XL Steamer
 * Attachment, which you don't have" instead of suggesting it blindly.
 *
 * Returns '' for an empty manifest so the caller can omit the section entirely.
 */
export function renderEquipmentManifest(items: readonly EquipmentItemDoc[]): string {
  if (items.length === 0) return '';
  return items
    .map((item) => {
      const parts = [`- ${item.name}`, ...renderEquipmentEnvironment(item)];
      const owned = item.accessories.filter((a) => a.owned);
      const unowned = item.accessories.filter((a) => !a.owned);
      if (owned.length > 0) {
        parts.push(`  accessories owned: ${owned.map((a) => a.name).join(', ')}`);
      }
      if (unowned.length > 0) {
        parts.push(
          `  accessories NOT owned (unavailable — do not use): ${unowned.map((a) => a.name).join(', ')}`,
        );
      }
      if (item.rules.length > 0) {
        parts.push(
          `  household rules (override your own product knowledge): ${item.rules.join('; ')}`,
        );
      }
      return parts.join('\n');
    })
    .join('\n');
}

/**
 * Reads and renders the shared equipment manifest. Degrades to '' on a missing,
 * corrupt, or unreadable doc — kit context is an enhancement, never a hard
 * dependency, so no flow fails because the manifest is unavailable.
 *
 * `flow` only labels the warn logs so the two callers stay distinguishable.
 */
export async function readEquipmentContext(
  db: ReturnType<typeof getFirestore>,
  flow: string,
): Promise<string> {
  try {
    const snap = await db
      .collection(EQUIPMENT_MANIFEST_COLLECTION)
      .doc(EQUIPMENT_MANIFEST_DOC_ID)
      .get();
    if (!snap.exists) return '';
    const result = EquipmentManifestSchema.safeParse(snap.data());
    if (!result.success) {
      logger.warn(`${flow}: equipmentManifest failed validation, proceeding without kit context`);
      return '';
    }
    return renderEquipmentManifest(result.data.items);
  } catch (err) {
    logger.warn(`${flow}: failed to read equipmentManifest`, { err });
    return '';
  }
}

// ─── Chef framing (chefChat) ─────────────────────────────────────────────────
//
// The chef MAY choose equipment. Sweep-then-detail is expressed as a prompt
// instruction inside the existing single call — there is no second AI round-trip
// and no two-pass pipeline.
const EQUIPMENT_CHEF_FRAMING = `## Your kitchen
This is the equipment this household actually owns. These are real, specific products — \
recognise them and use what you know about them.

Work in two beats. FIRST sweep: consider which of this kit is genuinely relevant to what is \
being cooked. THEN get specific about what you picked — the mode, the temperature, the exact \
accessory, and why it is the right choice. Say "bake it in the Pizzaiolo at 400 °C for 90 \
seconds on the pizza stone", not "bake in a hot oven".

PROPORTIONALITY IS A RULE, NOT A PREFERENCE. The right tool is the MOST VIABLE one, not the \
most powerful one. Setup, faff, and washing-up are part of the cost and you must weigh them. \
A knife wins for one onion; the 4 mm slicing disc wins for 2 kg of potatoes. Judge the scale \
of the job, the hassle of getting the kit out, and the cleanup — never capability alone. \
Reaching for the biggest appliance for a small job is a mistake, not thoroughness.

Accessories marked NOT owned are unavailable — never assume access to them. If the best method \
needs one, say so plainly ("that really wants the XL Steamer Attachment, which you don't have") \
and give the best alternative using what they do own.

Where an item lists household rules, those are the household's own plain-English instructions \
for that equipment. They OVERRIDE your general product knowledge — follow them exactly, even \
when they contradict what you know about the product.

Some of this kit HOLDS A TEMPERATURE, and those items say so with the range they reach and \
whether they do humidity. Several are home-made, so the listed figures are the truth about them \
and beat anything you assume from the name. Use them when asked where to put something. A \
"dedicated" one is free for the job at hand; a "shared" one is already holding other things at \
the setting shown, so treat that setting as fixed and say whether the job suits it rather than \
proposing a new one. Anything not listed as holding a temperature sits at kitchen temperature, \
and the kitchen counter is a perfectly good answer.

You remain completely free to suggest techniques that need no special kit at all — a pan, a \
bowl, and a knife are often the right answer. This is not a mandate to shoehorn appliances into \
every step. Stay conversational and natural; equipment detail should feel like a knowledgeable \
friend pointing at the right machine, not a spec sheet.`;

// ─── Librarian framing (authorRecipe) ────────────────────────────────────────
//
// The librarian MUST NOT choose equipment. It is a temperature-0 transcriber and
// the manifest is there ONLY so it recognises appliance names it sees in the
// transcript. Rewriting an agreed hob method for the Pizzaiolo would be a worse
// failure than the flattening this fixes.
const EQUIPMENT_LIBRARIAN_FRAMING = `## Kitchen equipment (for RECOGNITION ONLY)
The household owns the equipment below. It is listed for ONE reason: so you recognise these \
appliance, accessory, and mode names when they appear in the conversation and transcribe them \
faithfully. It is NOT a menu to choose from.

- PRESERVE the equipment specifics the conversation established — the named appliance, the mode, \
the temperature, the accessory, the timing. Keep them in the step text exactly as agreed.
- NEVER generalise a named appliance back to a generic one. If the conversation says "Pizzaiolo", \
the step says "Pizzaiolo" — not "the oven". Same for a named accessory, mode, or setting.
- NEVER introduce, substitute, or upgrade equipment the conversation did not establish. If the \
conversation says hob, the step says hob, even when something fancier is listed here. Inventing \
equipment is a worse error than omitting it.`;

// ─── Kit framing (identifyRecipeKit) ────────────────────────────────
//
// The kit flow may NAME equipment, and may not INTRODUCE it. That is a narrower
// licence than the chef's and a wider one than the librarian's, which is why it is
// a third framing rather than a reuse of either:
//   - narrower than the chef's, because the chef is choosing a method and this flow
//     is reading one that is already written. It must not decide the mash wants the
//     Kenwood.
//   - wider than the librarian's, because "food processor" in a step is not a name
//     to preserve, it is a class to resolve. Four things in this manifest answer to
//     it and the strip's only job is to say which one to get out.
const EQUIPMENT_KIT_FRAMING = `## Your kitchen
This is the equipment this household actually owns — real, specific products. Use it to say WHICH \
piece of kit the cook gets out, never to decide that they should get one out.

- NEVER generalise a named appliance back to a generic one. If a step says "Magimix Cook Expert", the \
kit entry says "Magimix Cook Expert" — not "food processor". Same for a named accessory, attachment \
or mode.
- If a step names only a CLASS of appliance ("food processor", "stand mixer", "slow cooker") and \
something here does that job, name that item instead. Where several qualify, pick the one that best \
fits THIS job — weigh the scale of the work, the faff of getting it out and the washing-up, not \
capability alone. The biggest machine is not automatically the right one.
- Copy the item's WORDS from this list verbatim — never tidy, shorten or re-word them. Capitalisation \
is the one thing you may change, and only downwards: a maker and model keep their capitals ("Anova \
Precision Oven" stays exactly as it stands), while a part or accessory named in ordinary words drops to \
lower case, because this list is a product inventory and a kit entry is a line of prose. So "Hand Blender \
Attachment" is written "hand blender attachment", and "Steam Basket" is written "steam basket".
- Accessories marked NOT owned are unavailable — never name one.
- If nothing here does the job, use the ordinary cook's words for it. A frying pan is a frying pan.

Naming which appliance is NOT a licence to introduce one. If the method does the job by hand, the \
kit is the hand tool the method uses, and nothing from this list belongs in the answer.`;

/**
 * The chef's equipment section, or '' when there is no manifest to show.
 */
export function equipmentSectionForChef(equipmentContext: string): string {
  if (!equipmentContext) return '';
  return `${EQUIPMENT_CHEF_FRAMING}\n\n${equipmentContext}`;
}

/**
 * The librarian's equipment section, or '' when there is no manifest to show.
 */
export function equipmentSectionForLibrarian(equipmentContext: string): string {
  if (!equipmentContext) return '';
  return `${EQUIPMENT_LIBRARIAN_FRAMING}\n\n${equipmentContext}`;
}

/**
 * The kit flow's equipment section, or '' when there is no manifest to show.
 *
 * '' is the important half: with no manifest the kit prompt is byte-for-byte what
 * it was before #954, so a missing or corrupt manifest degrades to today's generic
 * labels and never to a failed inference.
 */
export function equipmentSectionForKit(equipmentContext: string): string {
  if (!equipmentContext) return '';
  return `${EQUIPMENT_KIT_FRAMING}\n\n${equipmentContext}`;
}
