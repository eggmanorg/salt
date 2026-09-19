import { z } from 'genkit';
import { googleAI } from '@genkit-ai/google-genai';
import { setActiveSpanName } from '@salt/observability/server';
import { ai } from '../genkit.js';
import { withAiTimeout } from '../adapters/withAiTimeout.js';
import { resolveModel } from '../ai/resolveModel.js';
import { parseDataUrl } from './dataUrl.js';
import {
  PLACEHOLDER_MOOD_MEANINGS,
  PLACEHOLDER_TAG_MEANINGS,
  isPlaceholderTag,
} from './placeholderVocabulary.js';

// Tier-2 recipe hero-image generation (issue #148). The counterpart to the
// Tier-1 canon pictogram (generateCanonIcon.ts): where that paints a flat cartoon
// icon, this paints a PHOTOREALISTIC "arty" photograph of the finished dish from
// the recipe's title + description, in a consistent warm cookbook style.
//
// Two-tier system (docs/canon-icons.md): Tier 1 and Tier 2 never share size or
// context, so the styles deliberately do NOT match — this is prompt-only, no
// reference seed. Photoreal food photography is far more forgiving of prompt
// drift than the tiny pictograms were, so a set of house-style ANCHORS holds the
// look together across recipes while the prompt lets each dish drive its own
// scene (season, setting, surface, props, angle, palette, light). A committed
// style seed can be added later (mirroring loadCanonIconSeed) if cross-recipe
// consistency ever needs tightening.

// Image generation is far slower than text (~5–8s, occasionally more). Give it a
// generous deadline; the trigger's function timeout is raised to match.
const IMAGE_GEN_TIMEOUT_MS = 60_000;

// House-style string (STYLE) — the warm, "arty" modern-British-cookbook look.
// This literal WAS one fused string. It is now split in two, because the two
// halves have opposite lifetimes: one is the house style that must never vary,
// the other is a guess we now have something better than.
//
// Both halves are load-bearing. Do NOT paraphrase either casually — reword them
// deliberately and review the output, exactly as with the canon-icon STYLE.
//
// ─── The ANCHORS ────────────────────────────────────────────────────────────
// The house-style constants (photoreal, appetising, single finished-dish hero
// shot with the FOOD filling the frame as the star, soft natural window light,
// shallow focus, rustic ceramic / worn crockery, warm home-cookbook feel) that
// must hold across every recipe, plus the prohibitions (no text, no watermark, no
// hands, no people).
//
// These are LOCKED IN CODE and appended LAST on every prompt — brief or no brief.
// That ordering is the whole point: a scene brief is free prose that describes one
// dish, and once briefs are editable, "anchors last" is what stops a brief from
// talking the model out of "no people" or voting a different look per recipe.
// Nothing may be appended after them.
export const RECIPE_IMAGE_STYLE_ANCHORS =
  'But the FOOD is always the star of the shot: fill the frame with the dish, composing tight and close so the food is unmistakably the subject and takes up most of the image. The setting, surface, props and background are only supporting context glimpsed around and behind the food — never the main event; avoid wide or pulled-back shots where the tabletop, props or surroundings occupy more of the frame than the food itself. Vary the props, surface and angle to suit each dish; do NOT default to the same spoon, cloth, tabletop or camera position on every photo. Within that freedom, hold a recognisable house style: a photorealistic food photograph with the warm, unfussy, appetising feel of a modern British home-cookbook, shot with real affection. Always keep these anchors — the dish generously plated and filling most of the frame as the clear subject; soft natural window light; a shallow depth of field with the food in crisp focus and the surroundings falling softly out of focus; the food lovingly plated on rustic ceramic or worn crockery. Absolutely no text, no captions, no watermark, no logos, no branding, no hands, no people. A single, mouth-watering hero shot of one finished dish, framed large and close so the food fills the frame and makes you want to eat it.';

// ─── The "read the dish" FALLBACK ───────────────────────────────────────────
// This half asks the image model to infer the dish's character — and from it the
// season, setting, surface, props, palette and light — from the title alone. It
// was always a guess made by a model that had never seen the ingredients or the
// method.
//
// It is now the FALLBACK: used only when no scene brief is available (the brief
// step failed, or an old recipe predates it). When a brief IS available it is
// replaced by the brief, which was written by a model that read the whole recipe
// and therefore knows what the dish actually looks like.
//
// The dish-driven variation this clause describes is still MEANT to vary photo to
// photo — that variation is the point, not drift. The brief supersedes the guess,
// not the intent.
export const RECIPE_IMAGE_DISH_READING_FALLBACK =
  'First read the dish itself — is it fresh and light or hearty and slow-cooked, what cuisine is it, and which season does it naturally belong to — then let that reading drive the season, setting, surface, props, colour palette and quality of light of the scene: a fresh salad calls for high summer — bright, sunny, airy, cool clear light, a breezy outdoor or sun-lit table; a cottage pie or a slow-cooked stew calls for autumn or winter — cosy and warm, low golden or soft overcast light, deeper earthy tones, a hearty indoor table. Make this seasonal and situational shift clearly legible at a glance — a deliberate, confident step, never a faint tint — so each dish feels like it lives in its own moment.';

// ─── The SPECIAL anchors + fallback (issues #637, #671) ──────────────────────
// A special — "Chef's Specials" on screen — is a MEAL THAT NEEDS NO RECIPE CARD:
// it fills a planner slot but has no ingredients and no method, either because
// nobody cooked (a takeaway, a pub meal) or because the cook knows it by heart
// (a Sunday roast, a fry-up). Painting one with the recipe anchors gets a home-plated dish on rustic
// ceramic — a picture of a meal that never happened. These siblings paint the food
// as it REALLY TURNS UP.
//
// What "really turns up" means is NOT one picture, and #671 is what it cost to
// assume it was. There are at least five (the fifth added by #1322), and only the
// first is a takeaway:
// food someone else made and handed over; a meal eaten out on the restaurant's
// own plate; something good bought ready to eat from a baker, butcher or deli;
// something assembled at home with no cooking at all — a sandwich, cheese and
// crackers, beans on toast; and a dish the household cooks so often it was never
// written down, which IS cooked, at home, on their own plates. This block used to enumerate takeaway vessels ("the
// open foil tray, the lidded carton, the pizza box…") and assert the takeaway
// premise outright ("the whole point is food someone else made and handed over",
// "do NOT plate it up onto home crockery"). Both were false for three of the four,
// and the crockery prohibition was actively wrong for the sandwich — you make one
// ON a plate.
//
// It read as a bug rather than a bias because of WHERE it sat. This text is
// appended LAST, after the brief, the description, the tags and the hint, so the
// enumeration outranked everything a user could type and every special came back in
// a foil tray no matter what it was. That is the identical failure #652 diagnosed
// in the placeholder anchors, and it takes the identical fix: a VESSEL is a subject
// decision, and by this file's contract subjects belong to the per-doc brief while
// the anchors hold style and prohibitions. So the anchors now REFERENCE how the
// direction above says the food is served rather than naming it. The "vary the
// vessel; do NOT default to the same box, cloth, tabletop" sentence went with it —
// it fed those same nouns back in a negation, which conditions an image model far
// more weakly than the noun does.
//
// The one prohibition that survives is the one true of all of them: no recipe was
// FOLLOWED here, so the food must not be styled as a chef's plated composition.
//
// #1322 narrowed it once more. "Nobody cooked a recipe here" was flatly false for
// the three entries that are a Sunday roast, a fry-up and a cheese sandwich —
// somebody cooked those, they simply never wrote it down. Because this text is
// appended LAST it outranked the per-doc brief, so a brief correctly describing a
// plated roast would be overruled by an anchor insisting nothing was cooked. The
// prohibition now says what it always meant: no RESTAURANT plating, no chef's
// garnish, no arranged still life — home cooking on the household's own plates is
// exactly right where the brief calls for it.
//
// Same contract as the recipe pair otherwise: LOCKED IN CODE, appended LAST on
// every prompt, carrying the same prohibitions. "No logos" earns its keep twice
// over here — packaging, whether a takeaway's or a supermarket's, is where a model
// most wants to invent a brand.
//
// The kind switch lives in `anchorsFor`/`fallbackFor`/`openerFor` below, with
// 'recipe' as the default arm, so an absent or unrecognised kind is byte-for-byte
// today's prompt.
export const SPECIAL_IMAGE_STYLE_ANCHORS =
  "But the FOOD is always the star of the shot: fill the frame with it, composing tight and close so the food is unmistakably the subject and takes up most of the image. The table, the room and the background are only supporting context glimpsed around and behind the food — never the main event; avoid wide or pulled-back shots where the surroundings occupy more of the frame than the food itself. NO RECIPE WAS FOLLOWED HERE: show the food exactly as it really turns up, served however the direction above says it is served, and never dressed up into something it is not. Do NOT stage it as a restaurant would — no careful plating, no chef's garnish, no arranged still life. If it came in packaging, leave it in its packaging; if it arrived on the restaurant's own plate, leave it on that plate; if it was thrown together at home, let it look thrown together; and if the direction above says this is a dish the household cooks by heart, then it WAS cooked here — show it hot on their own plates or in the dish it came out of the oven in, generous and unfussy, still never styled as a restaurant's plate. Let the vessel, the surface and the angle follow the direction above rather than a habit. Within that, hold a recognisable house style: a photorealistic photograph with the warm, unfussy, appetising feel of a good evening, shot with real affection. Always keep these anchors — the food generous and filling most of the frame as the clear subject; soft natural light; a shallow depth of field with the food in crisp focus and the surroundings falling softly out of focus; everything real and a little lived-in, never pristine studio product photography. Absolutely no text, no captions, no watermark, no logos, no branding, no hands, no people. A single, mouth-watering hero shot of one spread of food, framed large and close so it fills the frame and makes you want to eat it.";

// The special counterpart to RECIPE_IMAGE_DISH_READING_FALLBACK: used only when no
// scene brief is available. It asks the same question the recipe fallback asks —
// read the thing, then let that reading drive the scene — but the reading it asks
// for is about the OCCASION, because that is what decides how the food shows up.
//
// Unlike the anchors above it may name concrete things, and should: it runs only
// when there is no brief, so it is the one place on that path with anything
// specific in it. What #671 changed here is the SPREAD of what it names — it used
// to offer takeaway, picnic, chippy, street food and restaurant, which are five
// wordings of two of the cases, so the shop-bought haul and the sandwich had no
// picture to reach for at all. #1322 added the fifth, the dish cooked by heart.
export const SPECIAL_SCENE_FALLBACK =
  "First read what kind of chef's special this is — food someone else made and handed over (a takeaway, a chippy tea, street food, a picnic); a meal eaten out, plated by the restaurant's own kitchen; something good bought ready to eat (a pie from the butcher, bread and cheese from the baker, a deli counter, a good thing out of a packet); something assembled at home with no real cooking (a sandwich, cheese and crackers, beans on toast); or a dish the household cooks so often it was never written down (a Sunday roast, a fry-up, a weeknight standby) — and what cuisine it is, then let that reading drive how the food is served, the setting, the surface, the props, the colour palette and the quality of light: a curry delivered home calls for a cosy indoor evening — warm lamplight, a kitchen table, cartons opened out; a picnic calls for bright outdoor daylight — a rug on the grass, a spread of wrapped and tubbed things; a meal out calls for the restaurant itself — low warm light, a laid table, the dish as the kitchen sent it; a baker's or butcher's haul calls for a board and a bread knife on a worktop in honest daylight; a sandwich made standing up calls for a plate, a kitchen counter and no ceremony at all; a dish cooked by heart calls for the household's own kitchen — hot from the oven, carved or spooned onto their own plates, generous and unfussy. Make this shift clearly legible at a glance — a deliberate, confident step, never a faint tint — so each one feels like it lives in its own moment.";

// ─── The COCKTAIL anchors + fallback (issue #637) ───────────────────────────
// A cocktail IS a recipe — it has ingredients and a method, and it keeps the full
// editor and the full recipe page. What it does NOT have is a plate. Painted with
// the recipe anchors it comes out as food "generously plated on rustic ceramic",
// which is a picture of a drink that was served as dinner. These siblings move the
// subject from the plate to the GLASS and the surface from the table to the bar.
//
// Same contract as the other two pairs: LOCKED IN CODE, appended LAST on every
// prompt, carrying the same prohibitions. All four families share the same core
// prohibition list (including "no branding" — issue #995); this one alone adds
// bottle labels: a bar back is the one setting where the model most wants to
// invent a spirits brand, and a legible label on a bottle behind the glass is a
// logo by another name.
export const COCKTAIL_IMAGE_STYLE_ANCHORS =
  'But the DRINK is always the star of the shot: fill the frame with the glass, composing tight and close so the drink is unmistakably the subject and takes up most of the image. The bar top, the bottles and the room behind are only supporting context glimpsed around and behind the glass — never the main event; avoid wide or pulled-back shots where the bar, the props or the surroundings occupy more of the frame than the drink itself. Serve it in the CORRECT GLASSWARE for the drink, and show the details that say it was just made: the garnish placed as the method calls for it, the ice — a clear block, cubed, cracked or crushed, or no ice at all when it is served straight up — the condensation beading on the outside of the glass, the citrus oils sitting on the surface, the colour reading true through the glass. Stand it on a bar top — polished wood, zinc, marble or worn timber — with the working clutter of a bar (a jigger, a bar spoon, a strainer, a spent citrus half, a folded towel) only ever glimpsed at the edges. Do NOT plate it as food, and do NOT stage it on home dining crockery. Vary the glass, the surface and the angle to suit each drink; do NOT default to the same coupe, bar top or camera position every time. Within that freedom, hold a recognisable house style: a photorealistic photograph with the warm, unfussy, inviting feel of a good bar at the start of the evening, shot with real affection. Always keep these anchors — the glass filled to the right level and filling most of the frame as the clear subject; soft, low, warm light; a shallow depth of field with the glass in crisp focus and the bar falling softly out of focus; the drink freshly made and never a dusty, flat or half-drunk glass. Absolutely no text, no captions, no watermark, no logos, no branding, no bottle labels, no hands, no people. A single, tempting hero shot of one finished drink, framed large and close so the glass fills the frame and makes you want to pour one.';

// The cocktail counterpart to RECIPE_IMAGE_DISH_READING_FALLBACK: used only when no
// scene brief is available. It asks the same question the other two fallbacks ask —
// read the thing, then let that reading drive the scene — but what it asks the model
// to read is the SERVE, because the glass, the ice and the light all follow from it.
export const COCKTAIL_SCENE_FALLBACK =
  'First read the drink itself — what it is built on and how it is served: a stirred, spirit-forward classic served straight up in a coupe; a bittersweet aperitivo over a big clear cube in a rocks glass; a shaken sour with a fine pale foam on top; a tall, bright highball over crushed ice; something creamy and rich — then let that reading drive the glassware, the ice, the garnish, the colour, the bar surface and the quality of light: a Negroni or an old fashioned calls for a late, low-lit evening — dark wood, deep amber and jewel reds, unhurried; a spritz or a highball calls for bright, cool, early-evening air — pale golds and greens, condensation, a fresher and breezier bar. Make this shift clearly legible at a glance — a deliberate, confident step, never a faint tint — so each drink feels like it lives in its own moment.';

// ─── The PLACEHOLDER anchors + fallback (issue #652) ────────────────────────
// A placeholder is not an entry for a meal — it is the picture a night gets when
// the whole plan was a sentence typed into the dinner box. Ten of them exist, and
// each is attached to many different evenings, so the one thing they must never
// do is claim a dish: a photograph of a lasagne on a night someone typed "roast
// chicken dinner" is worse than the thin line of text it replaced.
//
// This anchor set is therefore the load-bearing piece of the feature's art
// direction, and the illegibility rule belongs HERE rather than in a brief for
// exactly the reason the anchors exist at all: locked in code and appended LAST,
// it survives every Regenerate and every hand-written revision, so no steer typed
// into the revise box can drift a placeholder into "a roast chicken".
//
// It deliberately does NOT inherit the "fill the frame with the subject" clause
// its three siblings share. That clause exists to stop a wide shot burying a real
// dish; here there is no real dish, and forcing food to dominate the frame is
// precisely what would push the model back toward painting an identifiable one.
//
// It also, now, names no SUBJECT. It used to enumerate four legitimate leads (a
// glass of wine mid-pour, a cloche, steam off a bowl, a dish shot soft) and then
// ask for variety in the next breath. That was self-defeating twice over. This
// block is byte-identical on all ten pictures, and those four leads were the only
// concrete nouns in a prompt that is otherwise all prohibitions — so they were
// the whole positive brief, repeated ten times, and every picture came back with
// the same wine glass and the same linen. The "do NOT default to the same glass,
// cloth, tabletop" sentence that was meant to fix it fed those same nouns back in
// a negation, which conditions an image model far more weakly than the noun does.
//
// A lead is a SUBJECT decision, and by this file's own contract subjects belong
// to the brief (which is per-doc and can differ ten ways) while anchors hold
// style and prohibitions (which must not). So the anchors now REFERENCE the lead
// the direction above supplies rather than supplying one. Everything
// feature-critical is untouched: the illegibility rule still leads, still says it
// outranks everything, and still arrives last where no edited brief can reach it.
export const PLACEHOLDER_IMAGE_STYLE_ANCHORS =
  'But NOTHING in this photograph may be identifiable as a particular dish. The picture says "a good dinner is planned"; it must never say what dinner is. Any food in shot is generic or lost — to focus, to steam, to a lid, to a low angle, to the edge of the frame — and never a recognisable, nameable meal. That rule is absolute and outranks everything else here. The subject need not be food at all: compose around whatever the direction above leads with, holding that lead in crisp focus and letting everything else — including anything plated — sit soft and unresolved behind it. Do NOT compose this as a hero shot of food. But it must always read WARM and APPETISING — the picture of an evening someone is about to enjoy, with something good just out of focus. Never a bleak, bare or purely decorative frame: no empty table, no bare worktop, no styled still life with nothing about to be eaten. Within that, hold a recognisable house style: a photorealistic photograph with the warm, unfussy, appetising feel of a good evening at home, shot with real affection. Always keep these anchors — soft natural light; a shallow depth of field with the lead in crisp focus and everything behind it falling softly out of focus; real, lived-in props rather than studio-perfect ones. Absolutely no text, no captions, no watermark, no logos, no branding, no hands, no people. A single, inviting photograph of a meal about to happen, in which nothing can be named.';

// The placeholder counterpart to RECIPE_IMAGE_DISH_READING_FALLBACK: used only
// when no scene brief is available. Its three siblings all ask the model to read
// the THING — the dish, the occasion, the serve — and let that drive the scene.
// This one cannot: there is no thing. What it reads is the MOOD, plus whatever
// conditions the picture is tagged with.
//
// It names no leads, for exactly the reason the anchors above name none. This
// string is byte-identical on every placeholder and branches only two ways, so
// the four leads it used to offer ("a glass being poured", "a dish being carried
// to a table by a window", "steam rising off a bowl", "a cloche about to be
// lifted") were an invariant menu in a prompt with nothing else concrete in it —
// the same failure, one constant along. It now drives mood, light, surface and
// palette and leaves the subject to be chosen per picture.
//
// The mood sentences interpolate PLACEHOLDER_MOOD_MEANINGS rather than restating
// it: on the no-brief path this string and the tag gloss both fire, and two
// hand-maintained descriptions of `comfort` in one prompt is how they end up
// disagreeing.
export const PLACEHOLDER_SCENE_FALLBACK = `First read the MOOD this picture is for — its tags say either "bright" or "comfort", and that is nearly all there is to read, because there is no dish here and there must not be one. Bright calls for ${PLACEHOLDER_MOOD_MEANINGS.bright}. Comfort calls for ${PLACEHOLDER_MOOD_MEANINGS.comfort}. Let the mood drive the setting, the surface, the props, the colour palette and the quality of light, and let it choose what the picture leads with — anything that belongs to the evening about to be eaten, chosen fresh for this picture rather than reached for out of habit. Make the shift clearly legible at a glance — a deliberate, confident step, never a faint tint — but let it stop at the mood: whatever food is in shot stays generic and unresolved, never a dish anyone could name.`;

// ─── The CURE anchors + fallback (issue #1404) ───────────────────────────────
// A cure is cured meat — a coppa hanging in a chamber, a side of bacon, a board
// of sliced saucisson. Painting one with the recipe anchors gets a plated dinner
// on rustic ceramic, which is a picture of something else entirely: the thing a
// cure IS is the whole muscle or the sausage, and the way you meet it is a slice.
//
// Same contract as the other three pairs: LOCKED IN CODE, appended LAST on every
// prompt, carrying the same prohibitions.
//
// It KEEPS the "fill the frame with the subject" clause its recipe, special and
// cocktail siblings share and only `placeholder` drops — here there is a real,
// specific subject and it is the one thing worth looking at.
//
// What it deliberately does NOT do is name a stage. A cure is three different
// pictures — hanging and whole, cut open at the face, or fanned out in slices —
// and which one is right depends entirely on the dish: a bacon is not hung to
// slice, a mortadella is never a bloomed whole muscle in a chamber. Naming one
// here would put it on all of them, appended last where the per-doc brief could
// not overrule it. That is the identical failure #671 diagnosed in the special
// anchors and #652 in the placeholder ones, and it takes the identical fix: the
// STAGE is a subject decision and belongs to the brief, while the anchors hold
// style and prohibitions. So these reference what the direction above leads with.
//
// ─── AND THE BRIEF IS NOT YET TOLD IT IS A CURE (#1442) ───────────────────────
//
// THE PARAGRAPH ABOVE DESCRIBES THE INTENDED DIVISION OF LABOUR; IT IS NOT A
// GUARANTEE THIS FLOW CURRENTLY GIVES, and the difference is stated here rather
// than left as an unqualified absolute (CLAUDE.md rule 12).
// `describeRecipeScene` has no `cure` arm — a cure falls through its `default`
// case to the ordinary recipe prompt, which asks for "how it is plated and in
// what vessel". So on the common path, where a recipe HAS a stored scene brief,
// the "direction above" these anchors defer the stage to was written by a prompt
// that believed it was looking at a plated dinner, while the anchors below go on
// to say "do NOT plate it as a dinner". The two pull against each other, and the
// anchors win only because they are appended last.
//
// WHERE THE CLAIM IS TRUE TODAY is the no-brief path: `CURE_SCENE_FALLBACK` just
// below IS cure-aware and reads the kind of cure before choosing a stage. That
// fallback is the only cure-shaped direction this flow has.
//
// LEFT AS IS DELIBERATELY. #1404 pre-authorised leaving `describeRecipeScene`
// alone, and whether it grows a fifth arm is a spec call rather than a tidy-up:
// it changes what every cure's stored brief says. Until that call is made, this
// comment states the boundary instead of asserting the guarantee.
//
// The one prohibition of its own is restaurant plating: a charcuterie board
// styled by a stylist is a picture of a restaurant, and what is being recorded
// here is something somebody made and is keeping.
export const CURE_IMAGE_STYLE_ANCHORS =
  "But the CURED MEAT is always the star of the shot: fill the frame with it, composing tight and close so the meat is unmistakably the subject and takes up most of the image. The chamber, the board, the bench and the room behind are only supporting context glimpsed around and behind it — never the main event; avoid wide or pulled-back shots where the surroundings occupy more of the frame than the meat itself. Show it at the STAGE the direction above describes and at no other, whether that is whole and hanging, cut open at the face, or sliced and laid out. Let the texture do the work: the dry rind or bloom on the outside, the grain and the marbling of the cut face, the fat reading white or creamy rather than grey, the colour deep and even rather than lurid. This is something somebody made and is keeping, so the setting is a working one — a rack, a hook, a bench, a wooden board, a butcher's paper, a knife — real and a little lived-in. Do NOT stage it as a restaurant would: no careful plating, no chef's garnish, no styled charcuterie board arranged for a magazine, and do NOT plate it as a dinner on home crockery. Vary the stage, the surface and the angle to suit each cure; do NOT default to the same hook, board or camera position every time. Within that, hold a recognisable house style: a photorealistic photograph with the warm, unfussy, appetising feel of a good larder, shot with real affection. Always keep these anchors — the meat filling most of the frame as the clear subject; soft, low, warm light; a shallow depth of field with the meat in crisp focus and the setting falling softly out of focus. Absolutely no text, no captions, no watermark, no logos, no branding, no hands, no people. A single, appetising hero shot of one cure, framed large and close so it fills the frame and makes you want a slice.";

// The cure counterpart to RECIPE_IMAGE_DISH_READING_FALLBACK: used only when no
// scene brief is available. It asks the same question its three siblings ask —
// read the thing, then let that reading drive the scene — and what it asks the
// model to read is the KIND OF CURE, because the stage, the surface and the light
// all follow from it. A whole muscle drying in a chamber and a cooked mortadella
// on a slicer are not the same photograph.
//
// It may name concrete things, and should: it runs only when there is no brief,
// so it is the one place on that path with anything specific in it.
export const CURE_SCENE_FALLBACK =
  'First read what kind of cure this is and how it is met: a whole muscle dried for months and eaten raw — a coppa, a bresaola, a prosciutto — calls for a cool, dim curing room, a hook or a rack, a dusty white bloom on the rind, and either the whole piece hanging or a deep-red cut face against it; a cured piece that is then cooked or smoked — a bacon, a gammon, a pastrami — calls for a kitchen or a smokehouse rather than a chamber, a board and a knife, a burnished or peppered crust, warmer and brighter light; a fermented, dried sausage — a saucisson, a chorizo, a fuet — calls for a string of them hung together or a few coins cut on a board, the mosaic of lean and fat legible in the slice; a semi-dry or snack sausage calls for something plainer and more everyday, on paper or a bench; a cooked, emulsified one — a mortadella, a bologna — calls for the smooth pale face of a big round, sliced thin and draped rather than stacked. Make this shift clearly legible at a glance — a deliberate, confident step, never a faint tint — so each cure feels like it lives in its own room.';

// The kinds this flow knows how to paint. Declared LOCALLY as genkit-`z` literals
// rather than imported from `RecipeKindSchema`: genkit re-exports its own bundled
// zod instance, and a schema built from plain `zod` is not interchangeable with it.
// The drift between the two lists is closed by a test that pins this array against
// `RecipeKindSchema.options`, not by an import.
export const GENERATE_RECIPE_IMAGE_KINDS = [
  'recipe',
  'special',
  'cocktail',
  'placeholder',
  'cure',
] as const;

type ImageKind = (typeof GENERATE_RECIPE_IMAGE_KINDS)[number];

// The three kind switches. Each has 'recipe' as its DEFAULT arm, so an absent kind
// (an older caller, a doc written before #637) and any kind this flow has no art
// direction for render exactly today's prompt rather than nothing.
function anchorsFor(kind: ImageKind | undefined): string {
  switch (kind) {
    case 'special':
      return SPECIAL_IMAGE_STYLE_ANCHORS;
    case 'cocktail':
      return COCKTAIL_IMAGE_STYLE_ANCHORS;
    case 'placeholder':
      return PLACEHOLDER_IMAGE_STYLE_ANCHORS;
    case 'cure':
      return CURE_IMAGE_STYLE_ANCHORS;
    default:
      return RECIPE_IMAGE_STYLE_ANCHORS;
  }
}

function fallbackFor(kind: ImageKind | undefined): string {
  switch (kind) {
    case 'special':
      return SPECIAL_SCENE_FALLBACK;
    case 'cocktail':
      return COCKTAIL_SCENE_FALLBACK;
    case 'placeholder':
      return PLACEHOLDER_SCENE_FALLBACK;
    case 'cure':
      return CURE_SCENE_FALLBACK;
    default:
      return RECIPE_IMAGE_DISH_READING_FALLBACK;
  }
}

function openerFor(
  kind: ImageKind | undefined,
  title: string,
  description?: string | null,
): string {
  const lead = (() => {
    switch (kind) {
      // Deliberately says nothing about HOW this one turns up (issue #671). The
      // opener names the subject; which kind of chef's special it is — handed
      // over, eaten out, bought ready, thrown together here, or cooked by heart
      // (#1322) — is read per doc from the title and description by the brief.
      case 'special':
        return `A beautiful, appetising photograph of "${title}" — a chef's special: a meal that needs no recipe card, shown exactly as it really turns up.`;
      case 'cocktail':
        return `A beautiful, tempting photograph of the cocktail "${title}" — the finished drink in its glass, on the bar.`;
      // The one opener that does NOT make the title the subject. A placeholder's
      // title is a note to the person browsing the library ("Placeholder —
      // autumn evening"), not a dish, so it is handed over explicitly as a cue
      // about mood and season and explicitly disclaimed as something to paint.
      case 'placeholder':
        return `A beautiful, appetising photograph of a good dinner about to be eaten, with no particular dish in it. This one is titled "${title}" — read the title only as a note on the mood and the time of year, never as a dish to paint.`;
      // A cure is not a dish on a plate and is not eaten as one, so the opener
      // says what it is and leaves the STAGE — hanging whole, cut open, sliced —
      // to the brief, which has read the method and knows which one this is.
      case 'cure':
        return `A beautiful, appetising photograph of the cured meat "${title}" — the finished cure, shown as the direction below describes it.`;
      default:
        return `A beautiful, appetising photograph of the finished dish "${title}".`;
    }
  })();
  // Every kind joins its description the same way. A placeholder's was briefly
  // labelled as binding direction ("…which you must follow: …") on the theory
  // that one sentence was being outvoted by ~300 words of locked anchors. The
  // production documents say otherwise: their briefs track their descriptions
  // closely, so the label bought nothing — and it made a WRONG description
  // harder to correct, which is the live failure here rather than a theoretical
  // one (a placeholder described as "cool clear midday light" already produced a
  // brief about lunch, against an opener that says dinner).
  const desc = description?.trim();
  return desc ? `${lead} ${desc}` : lead;
}

// What a placeholder's tags MEAN, in pictures.
//
// Tags are nearly the whole per-doc variable these ten photographs have, and
// until now the image model only ever saw the bare word: "This recipe is tagged:
// comfort." Everything that says what comfort LOOKS like — lamplight, soft heavy
// textures, drawn in close — lived in PLACEHOLDER_SCENE_FALLBACK, which by
// construction is used only when there is no brief. On the normal path (brief
// present) it was never sent at all, so ten pictures differed by one adjective.
//
// Glossing them puts that language on the path that actually runs, and does it
// PER DOC: only the tags a picture carries are expanded, so `bright` and
// `comfort` never arrive together contradicting each other — which is exactly why
// this could not simply be moved into the anchors.
//
// The words themselves live in placeholderVocabulary.ts, shared with the art
// director's prompt in describeRecipeScene.ts. They were written separately once
// and had already drifted: that prompt still described `bright` as "cool
// daylight, a sunlit table" after this file stopped saying anything of the kind.
//
// The tags clause, per kind. The default arm is byte-for-byte the clause every
// kind has had since issue #148 — only `placeholder` diverges, because only a
// placeholder has no dish for "the dish's mood, season and cuisine" to refer to
// (a sentence asserting a dish exists, in the one kind where one must not) and
// no other signal for the tags to compete with.
function tagsClauseFor(kind: ImageKind | undefined, tags: string[]): string {
  if (kind !== 'placeholder') {
    return ` This recipe is tagged: ${tags.join(', ')}. Use these tags only as hints for reading the dish's mood, season and cuisine when you stage the scene — do NOT draw, write, label or otherwise show any of these words in the image.`;
  }
  // Free-form tags that are not moods or conditions stay listed but unglossed —
  // they are still a cue, we just have no picture to hand for them.
  const glosses = tags.filter(isPlaceholderTag).map((t) => PLACEHOLDER_TAG_MEANINGS[t]);
  const glossed = glosses.length > 0 ? ` They mean: ${glosses.join('; ')}.` : '';
  return ` This picture is tagged: ${tags.join(', ')}.${glossed} Read the tags as the EVENING this picture is for, and let them drive the light, the colour, the surface, the textures and the season. They are cues for staging only: do NOT draw, write, label or otherwise show any of these words in the image, and never let them name a dish.`;
}

// Per-recipe generation prompt. The dish identity comes from the recipe title and
// (when present) its description. The scene direction is either the supplied
// `sceneBrief` (art direction written from the WHOLE recipe by describeRecipeScene)
// or, failing that, the "read the dish yourself" fallback — never both. The
// recipe's own `tags` are fed in as a dish-type SIGNAL the model may use to judge
// mood/season/cuisine (issue #148, Phase 2), and an optional user `hint` is
// appended verbatim as additive guidance.
//
// ORDER IS LOAD-BEARING: dish → brief|fallback → tags → hint → ANCHORS. Every
// piece of free/authored text sits BEFORE the anchors; the anchors are always the
// last word. Do not append anything after them.
// Exported for the same reason buildIconPrompt is (issue #892): the prompt view
// CALLS this, so there is exactly one assembly of these words in the repo.
export function buildRecipePrompt(
  title: string,
  description?: string | null,
  hint?: string,
  tags?: string[],
  sceneBrief?: string,
  kind?: ImageKind,
): string {
  const dish = openerFor(kind, title, description);

  // The brief replaces the fallback clause — it answers the same question the
  // fallback asks, but from the whole recipe rather than from the title.
  const trimmedBrief = sceneBrief?.trim();
  let prompt = trimmedBrief ? `${dish} ${trimmedBrief}` : `${dish} ${fallbackFor(kind)}`;

  // Recipe tags (e.g. #comfort-food, #slow-cooker, #salad, #summer) give the model
  // an explicit dish-type cue beyond the title/description: a plainly-named dish
  // tagged #comfort-food reads warmer/autumnal, one tagged #salad/#summer brighter.
  // They are cues for READING the dish's character only — never text to render, so
  // the clause explicitly forbids drawing or writing them (the style already bans
  // captions/text). Drop empty/whitespace tags; with none usable, add no clause.
  // The wording itself is kind-switched (tagsClauseFor): a placeholder's tags are
  // its ONLY per-picture variable, so they are glossed into what they look like
  // rather than passed as bare words inside a sentence about a dish it hasn't got.
  const cleanTags = tags?.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleanTags && cleanTags.length > 0) {
    prompt += tagsClauseFor(kind, cleanTags);
  }

  const trimmedHint = hint?.trim();
  if (trimmedHint) {
    prompt += ` Additional guidance for this photo: ${trimmedHint}`;
  }

  // Anchors last, always — see RECIPE_IMAGE_STYLE_ANCHORS. Nothing goes after this,
  // for any kind: the anchors being the final word is the only thing stopping a
  // user-edited brief from talking the model out of "no people, no logos", and that
  // matters MORE for a special, where editing the brief is the primary path.
  return `${prompt} ${anchorsFor(kind)}`;
}

export const GenerateRecipeImageInputSchema = z.object({
  title: z.string().min(1),
  // The recipe description steers the composition; nullable/optional because a
  // recipe may have none (RecipeSchema.description is nullable).
  description: z.string().nullable().optional(),
  // Optional additive steer (issue #148) appended to the locked prompt.
  hint: z.string().optional(),
  // Optional dish-type signal (issue #148, Phase 2): the recipe's own tags, passed
  // to the model as cues for judging mood/season/cuisine — never rendered as text.
  tags: z.array(z.string()).optional(),
  // Optional art-direction brief describing the plated dish, written from the whole
  // recipe by describeRecipeScene. When present it replaces the "read the dish
  // yourself" fallback clause; when absent (brief step failed, or an older recipe)
  // the fallback is used and the prompt is exactly what it was before briefs.
  sceneBrief: z.string().optional(),
  // What kind of entry this is (issue #637) — selects the opener, the fallback and
  // the style anchors. OPTIONAL: absent means 'recipe', which is byte-for-byte the
  // prompt this flow built before kinds existed. Declared here as genkit-`z`
  // literals rather than imported from `@salt/domain`'s `RecipeKindSchema`, because
  // genkit bundles its own zod instance; a test pins the two lists together.
  kind: z.enum(GENERATE_RECIPE_IMAGE_KINDS).optional(),
});

// Raw generated image bytes, base64-encoded (Genkit flow outputs must be
// JSON-serialisable). The caller decodes to a Buffer before hero encoding.
export const GenerateRecipeImageOutputSchema = z.object({
  imageBase64: z.string(),
  contentType: z.string(),
});

export const generateRecipeImageFlow = ai.defineFlow(
  {
    name: 'generateRecipeImage',
    inputSchema: GenerateRecipeImageInputSchema,
    outputSchema: GenerateRecipeImageOutputSchema,
  },
  async ({ title, description, hint, tags, sceneBrief, kind }) => {
    setActiveSpanName(`generateRecipeImage: ${title}`);

    const modelId = await resolveModel('generateRecipeImage');
    const imageModel = googleAI.model(modelId);
    const result = await withAiTimeout(
      'generateRecipeImage',
      () =>
        ai.generate({
          model: imageModel,
          prompt: buildRecipePrompt(title, description, hint, tags, sceneBrief, kind),
        }),
      { timeoutMs: IMAGE_GEN_TIMEOUT_MS, retries: 1 },
    );

    const media = result.media;
    if (!media?.url) {
      throw new Error('generateRecipeImage: model returned no image');
    }

    const { base64, contentType } = parseDataUrl(media.url, 'generateRecipeImage');
    return { imageBase64: base64, contentType };
  },
);
