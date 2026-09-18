// The curated kitchen-tool vocabulary — the table `seed-kitchen-tools.mjs` draws
// and writes, and the table `tests/kitchenToolVocabulary.test.ts` proves covers
// what our recipes actually ask for.
//
// WHY IT IS ITS OWN MODULE (issue #956). The table is the deliverable as much as
// the seeding code is, and the only honest way to know it is right is to run the
// real `resolveKitchenTool` over the labels production really uses. A test cannot
// import it out of the seeder: that module reaches for firebase-admin, Genkit and
// a Gemini key at import time and runs a whole generation pass on load. Pure data
// with no imports can be read by both.
//
// ── THE ONE RULE THAT MATTERS ─────────────────────────────────────────────
// A GENERIC TOOL COVERS EVERY MODIFIER OF ITSELF FOR FREE; A SPECIFIC ONE
// COVERS NOTHING BUT ITSELF. `resolveKitchenTool` is token-aligned containment
// with longest-normalised-phrase-wins, so `Mixing bowl` answers to "large mixing
// bowl", "medium mixing bowl" and "mixing bowls" with no extra entry, while a
// tool called `Large mixing bowl` answers to exactly one of them and leaves the
// other two — and plain "mixing bowl" — undrawn.
//
// Three consequences, and every edit to this table has to hold all three:
//
//   1. NAME THE OBJECT, NOT THE INSTANCE. "Frying pan", never "Large frying
//      pan". The recipe still reads the cook's own words; only the picture is
//      shared.
//   2. A MATCHER IS ONLY FOR A PHRASE CONTAINMENT MISSES. "large mixing bowl"
//      needs no entry on `Mixing bowl`, because the label is already inside it;
//      "skillet" does, because it shares no word with "frying pan". Adding the
//      covered ones back is dead weight that also risks out-lengthening a sibling.
//      ENFORCED by `tests/kitchenToolVocabulary.test.ts`, along with rule 1 and
//      the id rule below — this rule was stated here and broken 35 times in this
//      same table until #956 trimmed them, which is what a rule checked by
//      nothing becomes.
//   3. LENGTH IS THE TIE-BREAK, SO A LONGER PHRASE OVERRIDES A SHORTER ONE.
//      That is what lets `Small bowl` (10) beat `Mixing bowl`'s "bowl" (4), and
//      `Rice paddle`'s "rice spoon" (10) beat `Wooden spoon`'s "spoon" (5).
//      Deliberate every time, never accidental.
//
// Phrases are folded with canon's `normaliseName` before comparison, so casing,
// hyphens, plurals, punctuation and quantity tokens need no entries of their own
// — and an accented spelling covers its unaccented twin ("sauté pan" answers to
// "saute pan"), which is why only one of the pair is listed.
//
// ── WHAT IS AND IS NOT FOLDED ─────────────────────────────────────────────
// Head-noun clustering is a good hint and a bad rule. `rice cooker`, `pressure
// cooker`, `slow cooker` and the sous-vide circulator share a head noun and are
// four different appliances; folding them would confidently draw a slow cooker
// for a rice cooker. Same for `electric hand mixer` vs `stand mixer`, and `cake
// tin` vs `loaf tin`. They each get their own row. What does fold is a vessel
// wearing an adjective — every bowl, every jar, every storage tub.
//
// Ids are kebab-case of the label (the rule `kitchenToolSlug` applies), which is
// what makes `kit-icons/{id}.webp` predictable and lets the weekly orphan sweep
// join a drawing to a document.

export const TOOLS = [
  // ─── The original #882 vocabulary ────────────────────────────────────────
  // Grounded in staging's guided plans plus an obvious core, and judged as a set
  // on a contact sheet. Kept in its reviewed order so a re-run reads the same
  // way. Twelve of these are still speculative — nothing in production asks for a
  // rolling pin or a tin opener yet — and they stay: each is one drawing on a
  // sheet the operator already judges whole, and the first recipe that says
  // "rolling pin" then gets a picture instead of a queue row.
  { id: 'mixing-bowl', label: 'Mixing bowl', matchers: ['bowl', 'pudding basin'] },
  { id: 'small-bowl', label: 'Small bowl', matchers: ['ramekin', 'prep bowl', 'little bowl'] },
  { id: 'jug', label: 'Jug', matchers: ['pitcher', 'beaker'] },
  { id: 'plate', label: 'Plate', matchers: ['dish', 'platter'] },
  { id: 'baking-tray', label: 'Baking tray', matchers: ['tray', 'baking sheet', 'sheet pan'] },
  { id: 'roasting-tin', label: 'Roasting tin', matchers: ['roasting dish', 'roasting pan'] },
  { id: 'loaf-tin', label: 'Loaf tin', matchers: ['bread tin', 'loaf pan'] },
  { id: 'cake-tin', label: 'Cake tin', matchers: ['cake pan', 'springform tin', 'sandwich tin'] },
  {
    id: 'ovenproof-dish',
    label: 'Ovenproof dish',
    matchers: ['baking dish', 'casserole dish', 'gratin dish', 'oven dish', 'pie dish'],
  },
  { id: 'colander', label: 'Colander', matchers: ['strainer'] },
  { id: 'sieve', label: 'Sieve', matchers: ['sifter', 'mesh strainer', 'chinois'] },
  { id: 'frying-pan', label: 'Frying pan', matchers: ['skillet', 'non-stick pan', 'sauté pan'] },
  { id: 'saucepan', label: 'Saucepan', matchers: ['pan'] },
  { id: 'stockpot', label: 'Stockpot', matchers: ['pot'] },
  {
    id: 'casserole-pot',
    label: 'Casserole pot',
    matchers: ['dutch oven', 'casserole', 'heavy-based pot', 'cast iron pot'],
  },
  { id: 'griddle-pan', label: 'Griddle pan', matchers: ['grill pan'] },
  { id: 'wok', label: 'Wok', matchers: ['stir-fry pan'] },
  { id: 'chopping-board', label: 'Chopping board', matchers: ['board'] },
  { id: 'chefs-knife', label: "Chef's knife", matchers: ['knife'] },
  { id: 'paring-knife', label: 'Paring knife', matchers: ['small knife'] },
  { id: 'bread-knife', label: 'Bread knife', matchers: ['serrated knife'] },
  { id: 'wooden-spoon', label: 'Wooden spoon', matchers: ['spoon'] },
  { id: 'spatula', label: 'Spatula', matchers: ['fish slice', 'turner'] },
  // "egg whisk" is NOT dead weight, and it is the one matcher in this table that
  // rule 2 would otherwise strike out (issue #1465). Containment already reaches
  // it through the bare label — but `kitchenToolForKitLabel` refuses a
  // single-word match for a label that exactly names a manifest accessory, and
  // "Egg Whisk" is one of the Magimix's. Without this phrase the household's own
  // egg whisk loses its picture; with it, the vocabulary SAYS an egg whisk is an
  // ordinary whisk, which is a curation decision and exactly the act #1465's
  // "choose an existing picture" puts one tap away. Exempted by name in
  // `kitchenToolVocabulary.test.ts`.
  { id: 'whisk', label: 'Whisk', matchers: ['egg whisk'] },
  { id: 'tongs', label: 'Tongs', matchers: [] },
  { id: 'ladle', label: 'Ladle', matchers: [] },
  { id: 'slotted-spoon', label: 'Slotted spoon', matchers: [] },
  { id: 'box-grater', label: 'Box grater', matchers: ['grater'] },
  { id: 'microplane', label: 'Microplane', matchers: ['fine grater', 'zester'] },
  { id: 'peeler', label: 'Peeler', matchers: [] },
  { id: 'potato-masher', label: 'Potato masher', matchers: ['masher'] },
  { id: 'rolling-pin', label: 'Rolling pin', matchers: [] },
  { id: 'pastry-brush', label: 'Pastry brush', matchers: ['basting brush'] },
  { id: 'tin-opener', label: 'Tin opener', matchers: ['can opener'] },
  { id: 'garlic-crusher', label: 'Garlic crusher', matchers: ['garlic press'] },
  { id: 'kitchen-scales', label: 'Kitchen scales', matchers: ['scales'] },
  { id: 'wire-rack', label: 'Wire rack', matchers: ['rack'] },
  { id: 'mortar-and-pestle', label: 'Mortar and pestle', matchers: ['mortar'] },
  { id: 'kitchen-scissors', label: 'Kitchen scissors', matchers: ['scissors', 'shears'] },
  { id: 'thermometer', label: 'Thermometer', matchers: [] },

  // ─── Grown from production's real kit labels (issue #956) ─────────────────
  // Every row below is behind at least one of the 38 labels production's recipes
  // ask for that the original forty could not name. Nothing speculative was added
  // here; the speculative allowance is spent above.

  // Appliances. Four cookers and two mixers that a head noun would have merged.
  { id: 'rice-cooker', label: 'Rice cooker', matchers: [] },
  { id: 'pressure-cooker', label: 'Pressure cooker', matchers: ['instant pot'] },
  { id: 'slow-cooker', label: 'Slow cooker', matchers: ['crock pot'] },
  // "sous-vide precision cooker", "sous vide immersion circulator" and plain
  // "immersion circulator" are one appliance under three names. The bare "sous
  // vide" matcher is the backstop; the two longer phrases win over it and land on
  // the same row either way.
  {
    id: 'sous-vide-circulator',
    label: 'Sous vide circulator',
    matchers: ['immersion circulator', 'precision cooker', 'sous vide'],
  },
  { id: 'food-processor', label: 'Food processor', matchers: [] },
  // Bare "blender" is NOT a matcher here, on purpose, and for the same reason the
  // cooker and mixer rows above carry no bare "cooker"/"mixer": a stick blender
  // and a jug/countertop blender are different objects, and production has never
  // asked for the second one. Folding the generic noun onto this row would draw a
  // stick-blender pictogram for a jug blender the moment one is entered -- the
  // exact rule-1 failure this table exists to prevent. "immersion blender" and
  // "hand blender" stay because both name the stick blender specifically; a
  // recipe that just says "blender" goes undrawn until a real countertop blender
  // shows up in production and earns its own row.
  { id: 'stick-blender', label: 'Stick blender', matchers: ['immersion blender', 'hand blender'] },
  { id: 'hand-mixer', label: 'Hand mixer', matchers: ['electric whisk'] },
  { id: 'stand-mixer', label: 'Stand mixer', matchers: ['food mixer', 'kitchenaid'] },
  { id: 'meat-grinder', label: 'Meat grinder', matchers: ['mincer'] },
  { id: 'vacuum-sealer', label: 'Vacuum sealer', matchers: [] },
  { id: 'waffle-iron', label: 'Waffle iron', matchers: ['waffle maker'] },
  { id: 'salad-spinner', label: 'Salad spinner', matchers: [] },
  { id: 'mandoline', label: 'Mandoline', matchers: ['mandolin'] },
  { id: 'food-mill', label: 'Food mill', matchers: ['mouli', 'passata mill'] },

  // Vessels and small kit. These are the folds that pay: one row absorbs every
  // adjective production has put in front of the noun.
  { id: 'jar', label: 'Jar', matchers: ['kilner'] },
  {
    id: 'storage-container',
    label: 'Storage container',
    matchers: ['container', 'tub', 'lidded box'],
  },
  { id: 'mug', label: 'Mug', matchers: [] },
  { id: 'baking-stone', label: 'Baking stone', matchers: ['pizza stone', 'baking steel'] },
  { id: 'trivet', label: 'Trivet', matchers: ['pot stand', 'heat mat'] },
  { id: 'tea-towel', label: 'Tea towel', matchers: ['kitchen towel', 'dish towel'] },
  { id: 'meat-press', label: 'Meat press', matchers: ['burger press', 'bacon press'] },
  { id: 'fork', label: 'Fork', matchers: [] },
  // A shamoji, not a serving spoon — which is why "rice spoon" is listed rather
  // than left to `Wooden spoon`'s "spoon". The longer phrase wins, deliberately.
  { id: 'rice-paddle', label: 'Rice paddle', matchers: ['rice spoon', 'shamoji'] },
  { id: 'measuring-spoons', label: 'Measuring spoons', matchers: ['teaspoon', 'tablespoon'] },
];
