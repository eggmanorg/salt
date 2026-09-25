import {
  DescribeRecipeSceneInputSchema,
  DescribeRecipeSceneOutputSchema,
  type DescribeRecipeSceneInput,
} from '@salt/domain/schemas';
import { AI_TEXT_FLOW_TIMEOUT, withAiTimeout } from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { flowModel } from '../ai/fakeModel.js';
import { PLACEHOLDER_TAG_VOCABULARY } from './placeholderVocabulary.js';

// describeRecipeScene — the cheap text step in front of the expensive image step.
//
// The hero prompt used to see only the title, description and tags, so it had to
// guess what the finished dish looked like ("First read the dish itself…"). This
// flow reads the WHOLE recipe — every ingredient, every step — and writes a short
// art-direction brief describing what the plated dish ACTUALLY looks like. The
// blistered top, the torn basil scattered at the end, the sauce that only exists
// in step 6: those live in the method, and this is the only thing that reads them.
// The brief then directs the image model in place of that guess-it-yourself clause.
//
// TWO HOSTS, AND THE SPLIT BETWEEN THEM IS THE DECISION (issue #1432, epic #1417).
// The onRecipeWritten trigger runs this flow with no human present and PERSISTS the
// result, in the same Firestore update as the image it directed. The
// describeRecipeScene callable runs it for someone sitting in front of the
// regenerate dialog and persists NOTHING — the paragraph goes back to the box, and
// only the user's Regenerate writes it to `recipes/{id}.imageBrief`. Losing the
// callable's result to a locked phone is therefore correct rather than an unfixed
// #1416: the app HANDED IT OVER TO BE REVIEWED instead of SAVING IT FOR YOU, and on
// the path where nobody could review it, it already saves it. The full argument, its
// boundary and the tests that pin each half are at the callable (`src/index.ts`,
// `describeRecipeScene`); the decision is in docs/recipe-module.md → "The scene
// brief's two lives". Do not add a write here.
//
// SCOPE — the dish-specific half ONLY. This flow describes THIS dish: appearance,
// plating, vessel, garnish, colour, texture, and the mood/season/cuisine it reads
// as. It must NOT author house style or prohibitions ("photoreal", "soft window
// light", "no text, no people"). Those are the ANCHORS — locked in code in
// generateRecipeImage.ts and appended AFTER the brief on every prompt precisely so
// that cross-recipe consistency cannot drift. A brief that re-authored them would
// be a per-recipe vote on the house style, which is exactly what the anchors exist
// to prevent (and, once a brief is human-editable, a way to talk the image model
// out of "no people").
//
// The scope rule itself is hoisted into ONE constant because every system prompt
// here — recipe, special, cocktail and placeholder, authoring and revising — must
// say it identically. It
// is the sentence that keeps the brief on the dish-specific half; a per-kind
// paraphrase of it is a per-kind loophole in the house style.
const SCENE_SCOPE_RULE = `Do NOT write about photographic style, lighting, lens, framing, camera angle, or what must not appear in the shot — those are fixed elsewhere and anything you say about them is discarded.`;

const DESCRIBE_SCENE_SYSTEM = `You are a food photographer's art director. You are given one recipe — its title, \
description, tags, ingredients and method. Write a short art-direction brief for a photograph of the FINISHED dish.

Read the whole recipe, especially the METHOD and the INGREDIENTS: they carry what the dish actually looks like once \
it is cooked and plated. Cues like "grill until the top is blistered and golden" or "scatter with torn basil" decide \
the finished appearance, and they usually appear nowhere in the title or description. Describe the dish as it looks \
at the moment it is served.

Cover only what is specific to THIS dish:
- what the finished dish looks like — colour, texture, browning, sauce, steam, how it sits
- how it is plated and in what vessel, and any garnish or finishing touch the method calls for
- the mood, season and cuisine the dish reads as, and why the dish itself implies that

${SCENE_SCOPE_RULE} Do not restate the recipe, do not list \
quantities, and do not give instructions for cooking it.

Write ONE paragraph of plain prose, at most about 80 words. A brief, not an essay. Return only the brief.`;

// REVISION MODE (issue #522, Phase 3) — "make it summery" applied to a brief that
// already exists, rather than a fresh authoring pass.
//
// The failure this prompt exists to prevent is the cheap one: bolting the steer on
// as a final sentence and leaving the rest of the paragraph contradicting it — a
// brief that says "autumnal, dark wood, low amber light" and then "make it summery"
// directs an incoherent image, which is exactly the render the user pays for and
// throws away. So the instruction is to fold the steer THROUGH the brief: light,
// props, surface and palette all move together, and everything the steer does not
// touch stays as it was (a revision is not a re-roll — the user chose to keep the
// parts they did not ask about).
//
// The recipe goes in here too, not just the paragraph. Revising prose about a dish
// without seeing the dish drifts away from the food — the same failure the whole
// feature fixes. The steer re-directs the SHOT; it must never rewrite what is on
// the plate into something the recipe does not cook.
//
// SCOPE is identical to authoring: the dish-specific half ONLY. The anchors stay
// locked in generateRecipeImage.ts and appended after the brief. This matters more
// here than in authoring — a steer is user text, so "make it summery, and photoreal
// with no people" must not become a per-recipe vote on the house style.
const REVISE_SCENE_SYSTEM = `You are a food photographer's art director. You are given one recipe, an existing \
art-direction brief for a photograph of the finished dish, and a requested change from the person who will use it. \
Rewrite the brief so it incorporates the requested change.

Fold the change THROUGH the whole brief. If the change is "make it summery", then the light, the surface, the props, \
the palette and the mood all move together to become summery — do NOT keep an autumnal brief and staple "make it \
summery" on the end. The result must read as one coherent brief that was always written that way, never as an edit \
with a contradiction left in it.

Keep everything the requested change does not touch. Anything the brief already says that still holds should survive \
the rewrite — this is a revision, not a fresh start.

Stay true to the recipe. The change re-directs how the dish is SHOT and styled; it must not turn the dish into food \
this recipe does not make. The finished dish's own colour, texture and garnish are set by the method and ingredients.

Cover only what is specific to THIS dish: its appearance, plating, vessel, garnish, and the mood/season/cuisine it \
reads as. Do NOT write about photographic style, lighting equipment, lens, framing, camera angle, or what must not \
appear in the shot — those are fixed elsewhere and anything you say about them is discarded, even if the requested \
change asks for it.

Write ONE paragraph of plain prose, at most about 80 words. Return only the revised brief.`;

// ─── CHEF'S SPECIALS (issues #637, #671, #1322) ──────────────────────────────
// A special — "Chef's Specials" on screen — is an entry that needs no card. The
// recipe prompt above is built on a premise it cannot satisfy — "read the whole
// recipe, especially the METHOD and the INGREDIENTS" — because it has neither. All
// the model gets is a title and a hand-written description, and asked the recipe
// question it invents a plated, cooked-from-scratch dish out of nothing.
//
// So the question changes. Not "what does this look like once it is cooked and
// plated" but "what does this look like when it really turns up".
//
// The answer to THAT is several different pictures, which is what #671 fixed. This
// prompt used to say "a takeaway, a picnic, a chippy tea, a street-food stop or a
// meal out" and then hand over a vessel list beginning "the foil tray" — five
// wordings of one idea, and a first concrete noun that every brief then reached
// for. Food bought ready to eat from a baker or a butcher, and food thrown
// together at home with no cooking, are equally chef's specials and neither has
// packaging that arrives. So the model's FIRST job is now to decide which one it
// is holding; everything else is downstream of that.
//
// #1322 added the FIFTH flavour, and it is the one this prompt used to actively
// forbid: a dish the household cooks often enough not to write down. Three of the
// eight live entries are that — a Sunday roast, an all-day breakfast, a cheese
// sandwich — and the old wording ("Nobody cooked a recipe here… do not turn it
// into a dish cooked from scratch and carefully plated") was simply wrong about
// them. Their pictures look right today only because the model ignored it. The
// prohibition survives, narrowed to what it was always for: the model must not
// invent a plated restaurant dish for food that arrives in a bag.
//
// The vessel list is gone with it. This prompt is per-doc and CAN legitimately name
// a vessel — that is exactly what a brief is for — but it must name the one THIS
// special has, read off the title and description, rather than the one at the head
// of a fixed list.
//
// SCOPE is identical to the recipe prompts and inherits the same rule verbatim:
// the subject half ONLY. The anchors stay locked in generateRecipeImage.ts and are
// appended after the brief. This matters MORE here than for recipes: with no
// method for the model to read, editing the brief by hand is the stated primary way
// a user gets a special's hero right, so the brief is user text far more often.
const DESCRIBE_SPECIAL_SCENE_SYSTEM = `You are a food photographer's art director. You are given one CHEF'S SPECIAL \
— a meal that needs no recipe card, with its title, description and tags. Write a short art-direction brief for a \
photograph of that food.

There is no method and no ingredient list here. Your FIRST job is to read the title and description and decide which \
kind of chef's special this is, because everything else follows from it:
- food someone else made and handed over — a takeaway, a chippy tea, street food, a picnic
- a meal eaten OUT — the dish as the restaurant's own kitchen sent it, at their table
- something good bought ready to eat — a pie from the butcher, bread and cheese from the baker, a deli counter, a \
good thing out of a packet
- something assembled at home with no real cooking — a sandwich, cheese and crackers, beans on toast
- a dish the household cooks so often it was never written down — a Sunday roast, a fry-up, a weeknight standby. \
This one IS cooked, at home, and it is served the way that household serves it: on their own plates, at their own \
table, generous rather than dainty.

Do NOT assume a takeaway, and do not give this food packaging it does not have: a meal out arrives on the \
restaurant's plate, a baker's or butcher's haul is unwrapped onto a board, a sandwich is made on a plate at home, \
and a dish the household cooks by heart never arrives in a container at all. Read which kind of chef's special it \
is and what cuisine it is, and let that decide everything else.

Cover only what is specific to THIS one:
- what the food itself looks like — colour, texture, char, glaze, sauce, steam, how it is piled, laid out or stacked
- how it is served and what it is served in or on, and whether it is opened out, unwrapped, spread or simply set down
- where it is eaten and what it is set down on, and the mood, occasion and cuisine it reads as

${SCENE_SCOPE_RULE} This is a brief for a photograph, not a recipe: do not invent a method or an ingredient \
list. Unless you decided this is a dish the household cooks by heart, do not turn it into a dish cooked from scratch and carefully plated — and even then it is a home \
kitchen's cooking on the household's own plates, never a restaurant's plating.

Write ONE paragraph of plain prose, at most about 80 words. A brief, not an essay. Return only the brief.`;

// The special counterpart to REVISE_SCENE_SYSTEM. Same failure it exists to prevent
// (a steer stapled on the end, contradicting the paragraph it was added to), same
// "keep what the change does not touch" rule — but anchored to the special rather
// than to a recipe the model could otherwise drift into inventing.
//
// The "keep what the change does not touch" rule is load-bearing and correct, and
// it is also what made #671 impossible to steer out of by hand: an existing brief
// that said "foil tray" counted as something the change did not touch, so it
// survived every revision. Hence the explicit carve-out below — a change of
// occasion moves the packaging with it, because the packaging is a CONSEQUENCE of
// the occasion rather than an independent fact about the food.
const REVISE_SPECIAL_SCENE_SYSTEM = `You are a food photographer's art director. You are given one CHEF'S SPECIAL \
— a meal that needs no recipe card: a takeaway, a meal out, something good bought ready to eat, something thrown \
together at home, or a dish the household cooks so often it was never written down — an existing art-direction \
brief for a photograph of that food, and a requested change from the person who will use it. Rewrite the brief so \
it incorporates the requested change.

Fold the change THROUGH the whole brief. If the change is "make it a picnic", then the vessel, the setting, the \
surface, the light and the mood all move together — do NOT keep an indoor-takeaway brief and staple "make it a \
picnic" on the end. The result must read as one coherent brief that was always written that way, never as an edit \
with a contradiction left in it.

Keep everything the requested change does not touch. Anything the brief already says that still holds should survive \
the rewrite — this is a revision, not a fresh start. But how the food is packaged, served and set down is NEVER \
independent of the occasion: if the change moves this to a restaurant, a shop-bought spread, a sandwich at home or a \
roast out of the household's own oven, the packaging in the old brief goes with it. Do not leave a takeaway \
container in a brief that is no longer a takeaway.

Stay true to the chef's special. The change re-directs how the food is SHOT and styled; it must not turn it into \
food this special does not serve. Unless this is a dish the household cooks by heart, it must never turn it into a \
dish cooked from scratch here and carefully plated — and where it IS one, it is cooked at home and served on the \
household's own plates, never plated as a restaurant would.

Cover only what is specific to THIS special: the food's appearance, how it is served and what it is served in or on, \
where it is eaten, and the mood, occasion and cuisine it reads as. ${SCENE_SCOPE_RULE} That holds even if the \
requested change asks for it.

Write ONE paragraph of plain prose, at most about 80 words. Return only the revised brief.`;

// ─── COCKTAILS (issue #637) ──────────────────────────────────────────────────
// A cocktail sits on the opposite side of the special from a recipe. A special had
// to lose the "read the method" premise because it has no method; a cocktail keeps
// it in full — 50ml gin, 25ml Campari, stir over ice, strain, orange twist is an
// ingredient list and a method, and it is where every visual fact about the drink
// lives. What has to change is the SUBJECT the model is asked to describe: the
// recipe prompt asks what the dish looks like "once it is cooked and plated", and
// there is no plating up a Negroni. Asked the recipe question, the model reaches
// for crockery and a garnish it can serve with a fork.
//
// So this prompt asks the same reading question against the glass: the spirits set
// the colour, the technique (stirred vs shaken vs built) sets the clarity and the
// texture, and the serve (straight up vs on the rocks, the ice, the garnish) IMPLIES
// the glassware. All four are things only the method knows.
//
// SCOPE is identical to the other prompts and inherits the same rule verbatim.
const DESCRIBE_COCKTAIL_SCENE_SYSTEM = `You are a drinks photographer's art director. You are given one COCKTAIL — its \
title, description, tags, ingredients and method. Write a short art-direction brief for a photograph of the FINISHED \
drink in its glass.

Read the whole recipe, especially the METHOD and the INGREDIENTS: they carry everything the drink actually looks like \
once it is made. The spirits, liqueurs, juices and bitters set the colour and the clarity — water-clear, blush pink, \
deep amber, cloudy, layered. The technique sets the texture: stirred is silky and crystal clear, shaken is livelier \
and often carries a fine pale foam, a build over ice is bright and beaded. And the serve the method calls for — \
straight up or over ice, the ice cubed or cracked or crushed, the twist or the wedge or the sprig placed at the end — \
is what implies the glass it belongs in. None of this is in the title.

Cover only what is specific to THIS drink:
- what is in the glass — colour, clarity, foam or crema, layers, bubbles, the ice and how it sits
- the glassware the serve implies, and the garnish and finishing touch the method calls for
- the bar surface it stands on, and the hour, mood and character the drink reads as, and why the drink implies that

${SCENE_SCOPE_RULE} Do not restate the recipe, do not list \
quantities or measures, and do not give instructions for making it.

Write ONE paragraph of plain prose, at most about 80 words. A brief, not an essay. Return only the brief.`;

// The cocktail counterpart to REVISE_SCENE_SYSTEM. Same failure it exists to
// prevent (a steer stapled on the end, contradicting the paragraph it was added
// to), same "keep what the change does not touch" rule — but anchored to the drink,
// so a steer re-directs the SHOT and never quietly re-pours what is in the glass.
const REVISE_COCKTAIL_SCENE_SYSTEM = `You are a drinks photographer's art director. You are given one COCKTAIL, an \
existing art-direction brief for a photograph of the finished drink, and a requested change from the person who will \
use it. Rewrite the brief so it incorporates the requested change.

Fold the change THROUGH the whole brief. If the change is "make it a summer afternoon", then the light, the bar \
surface, the props, the palette and the mood all move together — do NOT keep a late-night brief and staple "make it a \
summer afternoon" on the end. The result must read as one coherent brief that was always written that way, never as \
an edit with a contradiction left in it.

Keep everything the requested change does not touch. Anything the brief already says that still holds should survive \
the rewrite — this is a revision, not a fresh start.

Stay true to the recipe. The change re-directs how the drink is SHOT and styled; it must not turn it into a drink \
this recipe does not make. What is in the glass — its colour, clarity, ice, foam and garnish — and the glassware the \
serve implies are set by the method and the ingredients, not by the requested change.

Cover only what is specific to THIS drink: what is in the glass, the glassware, the garnish, the bar surface, and the \
hour and mood it reads as. ${SCENE_SCOPE_RULE} That holds even if the requested change asks for it.

Write ONE paragraph of plain prose, at most about 80 words. Return only the revised brief.`;

// ─── PLACEHOLDERS (issue #652) ───────────────────────────────────────────────
// A placeholder goes further than a special did. A special lost the method and
// the ingredients but kept a subject — a curry, a chippy tea, something the model
// can picture. A placeholder has no subject at all: it is the picture a night
// gets when the plan was a sentence, and it is attached to many different
// evenings, so naming a dish is the one thing it must never do.
//
// So the reading question, which all three other prompts ask of the thing, has
// nothing to ask it of. What is left to read is the TAGS — a mandatory mood plus
// any weather conditions — and the brief's job is to turn those into a scene:
// what light the picture is in, what it is set on, what sits unresolved behind.
//
// It does NOT choose the lead. It used to: this prompt offered a menu of four
// (a glass mid-pour, a cloche, steam off a bowl, a dish shot soft), and with no
// method and no ingredients to read, that menu was the most concrete thing in
// front of the model. The menu is gone; the DESCRIPTION names the lead and this
// prompt builds a scene around it. That is also why `tags` is on the input schema
// at all — this prompt claimed to read a mood it was never given, leaving the
// title and description as the only signal that ever reached it.
//
// What the tags MEAN is not written here. It lives in placeholderVocabulary.ts,
// shared verbatim with the image prompt, because these two were written
// separately and had already drifted apart: this one still called `bright` "cool
// daylight, pale crockery, a sunlit table" after the generator had stopped
// saying so, and defined none of the five conditions while being handed them.
//
// The illegibility rule is NOT trusted to this prompt. It lives in the locked
// anchors in generateRecipeImage.ts, appended after every brief, precisely
// because a brief is editable and this rule is the feature. Saying it here too is
// belt and braces on the authoring pass — the braces are the anchors.
//
// SCOPE is identical to the other prompts and inherits the same rule verbatim.
const DESCRIBE_PLACEHOLDER_SCENE_SYSTEM = `You are a food photographer's art director. You are given one PLACEHOLDER — a \
stock photograph that stands in for dinner on an evening someone planned in a sentence. Write a short art-direction \
brief for it.

There is no dish here, and there must not be one. This picture says "a good dinner is planned" and never says what \
dinner is. Do not invent a meal, do not name one, and do not describe a plate of anything recognisable: any food in \
the frame stays generic, or is lost to steam, to focus, to a lid, to the edge of the shot.

What you read instead is the TAGS. ${PLACEHOLDER_TAG_VOCABULARY} Let them decide the scene.

Cover only what is specific to THIS placeholder:
- what LEADS the picture — the description says what this one leads with, so take it as given and build the scene \
around it rather than substituting a lead of your own; it need not be food. Only when the description names no lead \
should you choose one, and then it must suit the mood and must not be a plate of dinner
- what sits behind and around the lead, unresolved — the table, the surface, the props, the light in the room
- the mood, the hour and the season it reads as, and why the tags imply that

${SCENE_SCOPE_RULE} It must read warm and appetising — an evening someone is about to enjoy — and never a bleak, empty \
table or a styled still life with nothing about to be eaten.

Write ONE paragraph of plain prose, at most about 80 words. A brief, not an essay. Return only the brief.`;

// The placeholder counterpart to REVISE_SCENE_SYSTEM. Same failure it exists to
// prevent (a steer stapled on the end, contradicting the paragraph it was added
// to), same "keep what the change does not touch" rule — but with one extra
// guard the other three do not need: the steer here is the primary way these ten
// pictures get good, so "make it a roast dinner" is a plausible thing to type,
// and it is the one change this brief must not fold in.
const REVISE_PLACEHOLDER_SCENE_SYSTEM = `You are a food photographer's art director. You are given one PLACEHOLDER — a \
stock photograph that stands in for dinner on an evening planned in a sentence — an existing art-direction brief for \
it, and a requested change from the person who will use it. Rewrite the brief so it incorporates the requested change.

Fold the change THROUGH the whole brief. If the change is "make it a winter evening", then the light, the surface, \
the props, the palette and the lead all move together — do NOT keep a bright summer brief and staple "make it a \
winter evening" on the end. The result must read as one coherent brief that was always written that way, never as an \
edit with a contradiction left in it.

Keep everything the requested change does not touch. Anything the brief already says that still holds should survive \
the rewrite — this is a revision, not a fresh start.

There is still no dish, whatever the change asks for. If the requested change names a meal, take from it only the \
mood, the season, the colour and the light, and never the dish itself: any food in the frame stays generic or lost to \
steam, focus, a lid or the edge of the shot. This picture must never become one anyone could name.

The tags still say which evening this is, and a rewrite stays true to them. ${PLACEHOLDER_TAG_VOCABULARY}

Cover only what is specific to THIS placeholder: what leads the picture, what sits unresolved behind it, and the \
mood, hour and season it reads as. ${SCENE_SCOPE_RULE} That holds even if the requested change asks for it.

Write ONE paragraph of plain prose, at most about 80 words. Return only the revised brief.`;

// ─── MEALS (issues #838, #1452) ──────────────────────────────────────────────
// A meal is a recipe that points at other recipes, and until now the art director
// never heard about them: a Sunday roast that is nothing but chicken + potatoes +
// gravy handed the model a TITLE and nothing else, and got back whatever a model
// guesses a roast looks like. The dishes are the picture.
//
// TWO rules, not one shared clause, because `takesComponents` is true for two
// kinds that mean opposite things by it. A recipe's components are dishes SERVED
// ALONGSIDE it — they are dished up together, normally onto one plate and in the
// exceptional case out across the table. A cocktail's component is a part it is
// MADE FROM (the house syrup, an infusion); it is already in the glass, and a
// second glass beside it would be exactly wrong. One clause covering both would
// have to be vague enough to direct neither.
//
// ONE PLATE IS THE DEFAULT, AND THAT IS AN INVERSION OF #838 (issue #1452). #838
// directed every meal at the WHOLE TABLE — each dish in its own bowl, laid out
// side by side as a spread — and two things were wrong with it. Nearly every meal
// in this library is a main with sides and is eaten off one plate, so the table
// was the rule where it should have been the exception, leaving the Revise box as
// the only way out. And the locked anchors in generateRecipeImage.ts end every
// prompt with "A single, mouth-watering hero shot of one finished dish": a
// table-spread brief was contradicted by its own house style, on a prompt where
// the anchors are deliberately the last word. Directing the plate removes the
// contradiction FOR THE COMMON CASE — the default, one-plate path — instead of
// carving a meal-shaped hole in the anchors, which a per-meal judgement cannot
// live in since it is a constant byte-identical across every recipe (the split
// #652, #671 and #1404 each established). It does not remove the contradiction on
// the exception path below: when the art director chooses the table, the anchors
// still close the prompt with "one finished dish" and win by position, since
// buildRecipePrompt appends them last. #1452 named that the open, deferred
// question this rule does not answer, not a defect this PR closes.
//
// The table stays REACHABLE in the brief rather than gone from it: the rule below
// names it as the exception the art director may choose from the dishes
// themselves, decided by #1452's general test — the dinner is plainly not a single
// serving — with one example that says it is one. It used to follow that test with
// a colon and four shared-eating scenarios, which read as the definition and left
// every other shape (a separate course above all) to the one-plate default (#1567).
// That is a claim about a string and nothing else can pin it short of an AI call,
// so it is pinned by a string assertion — see tests/flows/describeRecipeScene.test.ts,
// "leaves the table reachable". The assertion is scoped the same way: it pins that
// the brief names the exception, not that a photograph ends up showing the table.
//
// A SEPARATE COURSE gets its own plate (#1567). A starter or a pudding attached to
// a meal is neither shared eating nor part of the main's plate, and the general
// test alone may not reach it — a roast with a pudding is still one plated serving
// for the roast — so the rule names it outright. MEAL_CHEF_FRAMING in
// componentContext.ts already treats a pudding on a meal as a real shape; this is
// the art director agreeing with the chef. Nothing in code detects a course (no
// field marks a dish as one); the model reads it off the listed dishes.
//
// The one-plate direction describes COMPOSITION — what leads, what sits under,
// beside or over it — and names no food. It used to say "the meat resting on the
// mash", the only concrete picture in a clause sent for every meal, which is the
// #671 failure recorded under CHEF'S SPECIALS above: a first concrete noun becomes
// every brief's noun. The test pins the absence of those words, not of every food
// word; the paragraph is short enough to read.
//
// Both are APPENDED ONLY when dishes are actually listed, so a recipe that is not
// a meal gets byte-for-byte the system prompt it got before. Specials and
// placeholders never receive either (`takesComponents` is false for both), which
// is structural here rather than a promise: their arms below simply ignore it.
const MEAL_SCENE_RULE = `This recipe is a MEAL. The dishes listed above are separate recipes served together as \
one dinner, and they are the subject: describe it AS IT IS EATEN — dished up on ONE PLATE, those dishes composed \
onto it together. Let the dish that carries the meal lead, and set each of the others where it naturally belongs — \
under it, beside it or spooned over it — each still recognisably itself.

A separate course is not part of that plate. A starter or a pudding is eaten before or after the main, not with it: \
show it on its own plate or bowl beside the main, never composed onto it.

Set the dishes out separately across the table ONLY where this dinner plainly is not a single serving — food shared \
from the middle rather than dished up per person, for example. That is an exception you may choose when the dishes \
themselves call for it, never the default.

Any ingredients and method given above belong to the DINNER as a whole — a sauce made at the end, the timing that \
runs the dishes together — and never to any one dish. Read them that way, and read each dish's own description for \
what that dish actually looks like.`;

const COCKTAIL_COMPONENT_SCENE_RULE = `The recipes listed above are parts this drink is MADE FROM — a house syrup, \
an infusion, a cordial made separately and then poured in. They are already IN the glass, so let them inform its \
colour, clarity and texture. Do NOT put them in the photograph as separate bottles, jars or a second glass: the \
subject is still the one finished drink.`;

// The kind switch. 'recipe' is the DEFAULT arm, so an absent kind (an older
// caller, a doc written before #637) and any kind with no prompts of its own get
// exactly today's prompts rather than nothing.
//
// `hasComponents` only ever ADDS a clause, so every existing arm is unchanged for
// every entry that is not a meal.
function systemFor(
  kind: DescribeRecipeSceneInput['kind'],
  revising: boolean,
  hasComponents: boolean,
): string {
  const withRule = (system: string, rule: string): string =>
    hasComponents ? `${system}\n\n${rule}` : system;
  switch (kind) {
    case 'special':
      return revising ? REVISE_SPECIAL_SCENE_SYSTEM : DESCRIBE_SPECIAL_SCENE_SYSTEM;
    case 'cocktail':
      return withRule(
        revising ? REVISE_COCKTAIL_SCENE_SYSTEM : DESCRIBE_COCKTAIL_SCENE_SYSTEM,
        COCKTAIL_COMPONENT_SCENE_RULE,
      );
    case 'placeholder':
      return revising ? REVISE_PLACEHOLDER_SCENE_SYSTEM : DESCRIBE_PLACEHOLDER_SCENE_SYSTEM;
    default:
      return withRule(revising ? REVISE_SCENE_SYSTEM : DESCRIBE_SCENE_SYSTEM, MEAL_SCENE_RULE);
  }
}

export const describeRecipeSceneFlow = ai.defineFlow(
  {
    name: 'describeRecipeScene',
    inputSchema: DescribeRecipeSceneInputSchema,
    outputSchema: DescribeRecipeSceneOutputSchema,
  },
  // `tags` is defaulted here as well as on the schema: the schema default only
  // applies when the input is actually parsed, and a direct in-process call to
  // the flow function (which is how the whole suite drives it) skips that.
  async ({
    title,
    description,
    tags = [],
    ingredients,
    steps,
    // Defaulted here as well as on the schema, for the same reason `tags` is: the
    // schema default only applies when the input is actually parsed, and a direct
    // in-process call to the flow function skips that.
    components = [],
    currentBrief,
    hint,
    kind,
  }) => {
    // Revision needs BOTH halves: a paragraph to revise and a steer to revise it
    // by. With either missing there is nothing to fold through anything, so we
    // author from scratch — which is also, deliberately, what "start over" sends
    // (neither), so a rewritten recipe stops inheriting art direction for the dish
    // it used to be.
    const revising = Boolean(currentBrief && hint);

    const promptParts = [
      `Title: ${title}`,
      description ? `Description: ${description}` : null,
      // Sits directly under the description because for a placeholder these two
      // ARE the input — there is no method below to outweigh them. Omitted when
      // empty so a tagless entry's prompt is unchanged.
      tags.length > 0 ? `Tags: ${tags.join(', ')}` : null,
      // Above the ingredients because for a bundle-only meal these ARE the food:
      // the meal's own ingredients and method are the coordination (a gravy, a
      // timing plan), and the dishes are what is on the table. Omitted when empty
      // so a recipe that is not a meal sends the prompt it always sent.
      components.length > 0
        ? `Dishes in this meal:\n${components.map((c) => `- ${c}`).join('\n')}`
        : null,
      ingredients.length > 0
        ? `Ingredients:\n${ingredients.map((i) => `- ${i}`).join('\n')}`
        : null,
      steps.length > 0 ? `Method:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : null,
      // The recipe stays FIRST on a revision too: the dish is the anchor, and the
      // brief and steer are the edit applied on top of it.
      revising ? `Current brief:\n${currentBrief}` : null,
      revising ? `Requested change: ${hint}` : null,
    ].filter((p): p is string => p !== null);

    const model = await flowModel('describeRecipeScene');
    const result = await withAiTimeout(
      'describeRecipeScene',
      () =>
        ai.generate({
          model,
          system: systemFor(kind, revising, components.length > 0),
          prompt: promptParts.join('\n\n'),
          output: { schema: DescribeRecipeSceneOutputSchema },
        }),
      // No retry (the shared budget's): the trigger treats a
      // failure as "no brief" and falls back, and the callable's caller is a human
      // sitting in front of the dialog who can press the button again — neither
      // gains anything from burning the timeout budget on an automatic retry.
      AI_TEXT_FLOW_TIMEOUT,
    );

    // AI output is a trust boundary — validate before it leaves the flow.
    const parsed = DescribeRecipeSceneOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`describeRecipeScene returned invalid output: ${parsed.error.message}`);
    }

    return { brief: parsed.data.brief.trim() };
  },
);
