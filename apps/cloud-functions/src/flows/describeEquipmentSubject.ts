import {
  DescribeEquipmentSubjectInputSchema,
  DescribeEquipmentSubjectOutputSchema,
} from '@salt/domain/schemas';
import { setActiveSpanName } from '@salt/observability/server';
import { ai } from '../genkit.js';
import { AI_TEXT_FLOW_TIMEOUT, withAiTimeout } from '../adapters/withAiTimeout.js';
import { flowModel } from '../ai/fakeModel.js';

// describeEquipmentSubject — the cheap TEXT step in front of the expensive image
// step (issue #877). The equipment counterpart of describeRecipeScene, and it
// exists for the same reason: an image model has to be told what it is looking at.
//
// The house style is deliberately low-detail ("simple minimal friendly shapes,
// low detail"). Handed the bare string "Kenwood Chef KVC3100S Mary Berry Special
// Edition", an image model draws a generic cartoon stand mixer — it has no
// reliable idea what a KVC3100S looks like, and the style leaves it no room to
// bluff with detail. A TEXT model does know, and turning the make and model into
// words — cream body, chrome bowl, tilt head, one round dial on the right of the
// base — is the whole of what makes the drawing specific rather than decorative.
//
// The two steps are also separated by a user gate in the running app: this flow
// runs automatically on a manifest write, the image flow runs only when someone
// presses Draw. That is why the brief must read as plain, correctable English
// prose — it is shown to the user, and correcting it is how a wrong picture
// gets fixed at the cause instead of being re-rolled.
//
// Since #885 it is ALSO a callable, run from the item page's Revise and Start
// over buttons. Three shapes, one flow: `currentBrief` + `hint` REVISES the
// sentence per the correction; neither authors from scratch, which is what the
// manifest trigger sends and what "Start over" deliberately sends too. Since
// #947, a `photo` authors from scratch as well — "Start over, but with a
// picture" — because nobody in the make-and-model chain has ever SEEN the item
// and a photo fixes that at the cause. Its schemas therefore live in
// `@salt/domain/schemas` (a callable input is a trust boundary), mirroring
// describeRecipeScene.
//
// ─── THIS FLOW WRITES NOTHING, and the claim has to be stated carefully ─────
// Neither the flow nor the callable over it persists anything, so a revision the
// user never accepts is lost to a sleeping phone — deliberately (issue #1433,
// epic #1417). The photo is never written anywhere either. Say the persistence
// claim in the form that is actually TRUE, because the unqualified version
// contradicts a transaction five files away. Scoped correctly, to the CALLABLE
// rather than to this flow: `drawEquipmentIcon` is the only writer of
// `subjectBrief` that takes its brief from a client request — the describe
// callable's output, once the browser sends it. The FIELD has other writers,
// several of which call THIS FLOW ITSELF in AUTHORING mode and write the
// sentence they get back directly, never through `drawEquipmentIcon`. (Some of
// their briefs ARE read by a human — the `--apply` backfill's are, side by side
// with their drawings, per that script's own header — so "unseen by anybody" is
// not what separates the writers; taking the brief from a client request is.)
// That is exactly why drawEquipmentIcon.ts:110-131 needs a transaction: a
// rename landing mid-draw means the trigger has already re-authored
// `subjectBrief` under the new name. An agent who reads "the only writer" as
// literal truth reads that transaction as ceremony and tidies it away.
//
// WHO those other writers are is deliberately not listed here. One list, in
// docs/canon-icons.md → "Who writes `subjectBrief`", held honest by
// `pnpm briefwriters:check`; this comment named exactly two of them and went
// stale the moment a third landed (#1519).
//
// Why the revision stays transient rather than auto-saving — the five facts, each
// with its void condition and its pin or its honest absence — is at the callable
// (index.ts, `describeEquipmentSubject`); the decision is in docs/canon-icons.md →
// "The description's two lives". This flow's own half is pinned by
// tests/flows/describeEquipmentSubject.test.ts → "PERSISTS NOTHING".
//
// ─── SCOPE — the subject half ONLY ──────────────────────────────────────────
// This flow describes what the THING IS. It must not author house style or
// prohibitions ("flat vector", "thick dark outline", "no drop shadows"). Those
// are the ANCHORS — locked in equipmentIconPrompt.ts and appended AFTER the
// brief on every prompt, precisely so a per-item brief cannot vote on the house
// style. Once a brief is human-editable that stops being a tidiness rule and
// becomes the thing standing between "correct the description" and "talk the
// image model out of the house style". Same rule, same reason, as
// describeRecipeScene.ts's SCENE_SCOPE_RULE.
//
// It must also not name the brand. The brief is fed to the image model verbatim,
// and no Salt pictogram carries lettering (see EQUIPMENT_STYLE_ANCHORS): a brief
// that says "the Kenwood logo on the front" is a request for the one thing the
// anchors then have to fight. Likeness comes from silhouette, colour and control
// layout, so those are what the brief is asked for.

// The two binding scope rules, hoisted into constants because EVERY system prompt
// here — authoring and revising — must say them identically. A paraphrase in the
// revision prompt would be a loophole in exactly the place it matters most: a
// steer is user text, so "make it black, flat vector with a drop shadow and the
// logo on the front" must not become a per-item vote on the house style.
const SUBJECT_TEXT_RULE = `Never mention the brand name, the model number, a logo, a badge, a wordmark, or any \
lettering, writing or numbers on the item. The illustration carries no text of any kind, so anything you say about \
text is discarded — describe shape, colour, finish and controls instead.`;

const SUBJECT_SCOPE_RULE = `Do NOT write about illustration style, line weight, colour palette, outlines, shading, \
framing, background, or what must not appear in the picture — those are fixed elsewhere and anything you say about \
them is discarded.`;

const DESCRIBE_EQUIPMENT_SYSTEM = `You are an illustrator's art director. You are given the name of one piece of \
kitchen equipment — usually a make and model, sometimes a plain generic name. Write a short visual brief describing \
what that specific item LOOKS LIKE, for an illustrator who has never seen it.

Use what you know about the actual make and model. The point of this brief is that the drawing is recognisably THIS \
device rather than a generic one of its type, and the only way that happens is if you say what makes it distinctive.

Cover, in this order and only as far as the item warrants:
- the form factor and overall silhouette, and the rough proportions (squat and wide, tall and narrow, and so on)
- the body colour and finish — cream enamel, brushed stainless, matte black plastic, clear glass
- the control layout as it reads at a glance: how many dials, knobs, levers or buttons and roughly where they sit
- the one or two features that identify it — a tilt-back head, a domed lid, a spouted jug, a chrome bowl

If the name is generic and brandless, or you genuinely do not know the model, describe the typical form of that kind \
of equipment. Say so plainly in ordinary description; do NOT invent a brand, a model, or a distinctive feature you \
are not confident about. A sensible generic description is a good outcome, not a failure.

${SUBJECT_TEXT_RULE}

${SUBJECT_SCOPE_RULE}

Write two to four sentences of plain prose, up to about 120 words, beginning with the kind of thing it is ("a \
tilt-head stand mixer with…"). Use the length to cover the points above properly, not to pad — and never to invent \
detail you are not confident about; a shorter brief is the right answer when the item is plain or you know little \
about it. A brief, not a spec sheet. Return only the brief.`;

// REVISION MODE (issue #885) — "it's matte black, not cream" applied to a
// description that already exists, rather than a fresh authoring pass.
//
// The failure this prompt exists to prevent is the cheap one: bolting the
// correction on as a trailing clause and leaving the rest of the sentence
// contradicting it — "a cream enamel stand mixer with a chrome bowl, but matte
// black" describes nothing an illustrator can draw. So the instruction is to fold
// the correction THROUGH the sentence, and to leave everything it does not touch
// exactly as it was: the user chose to keep the parts they did not mention.
//
// The NAME goes in here too, not just the sentence. Revising prose about an
// appliance without knowing which appliance drifts away from the actual device —
// the same failure the brief step exists to fix.
//
// SCOPE is identical to authoring, via the same two constants: this describes
// what the thing IS. The anchors stay locked in equipmentIconPrompt.ts and are
// appended after the brief, and the last clause below says so even when the
// correction itself asks otherwise.
const REVISE_EQUIPMENT_SYSTEM = `You are an illustrator's art director. You are given the name of one piece of \
kitchen equipment, an existing visual brief describing what it looks like, and a correction from the person who owns \
it. Rewrite the brief so it incorporates the correction.

Fold the correction THROUGH the whole brief. If the correction is "it's matte black, not cream", then the body \
colour and the finish move together — do NOT keep a cream body in the sentence and staple "but black" on the end. \
The result must read as one coherent brief that was always written that way.

Keep everything the correction does not touch. Anything the brief already says that still holds should survive the \
rewrite — this is a revision, not a fresh start.

The person correcting it is looking at the actual item, so prefer what they say over what you know about the model. \
If they add a feature you did not mention — a water tank down one side, a second dial — work it into the silhouette \
and the control layout rather than appending it.

${SUBJECT_TEXT_RULE}

${SUBJECT_SCOPE_RULE} That holds even if the correction asks for it.

Write two to four sentences of plain prose, up to about 120 words, beginning with the kind of thing it is ("a \
tilt-head stand mixer with…"). A brief, not a spec sheet. Return only the revised brief.`;

// PHOTO MODE (issue #947) — "you have seen the thing, this lets you show it".
// A third system prompt, not a branch of the other two: authoring works from a
// make and model the text model may only half-know, and this works from a
// photograph of the actual item, so the instruction is "describe what you see"
// rather than "describe what you know". "Start over, but with a picture" — see
// the flow's mode selection below — so this is never combined with a revision.
//
// SCOPE is identical to the other two prompts, via the same two constants: this
// describes what the thing IS, never house style or the anchors.
//
// The brand ban is the harder problem here than anywhere else in this file. A
// photograph puts the wordmark right in frame — "describe what you see" collides
// head-on with SUBJECT_TEXT_RULE unless the prompt says explicitly that the badge
// is visible and must not be transcribed, which is what the extra paragraph below
// does. It also closes the one gap the two text prompts never had to: a display
// panel's actual contents are equally off-limits, not just a printed logo.
//
// Length is the SAME in all three prompts — two to four sentences, up to about
// 120 words. It briefly was not: #947 gave photo mode the longer budget alone,
// on the reasoning that the text prompts describe from half-known model
// knowledge where extra length only invents detail. In practice the one-sentence
// text brief was the thing losing likeness — four bullet points of silhouette,
// colour, controls and identifying features do not fit in one sentence whether
// the source is a photograph or model knowledge, and the invention risk is held
// by the "do NOT invent detail" clauses in each prompt, not by the word count.
// If they diverge again, it should be because the pictures got worse, not tidier.
const PHOTO_EQUIPMENT_SYSTEM = `You are an illustrator's art director. You are given the name of one piece of \
kitchen equipment and a photograph of the actual item. Write a short visual brief describing what THIS SPECIFIC item \
looks like, for an illustrator who will never see the photo — only your words.

Describe what the photograph actually shows, not what the name or model typically looks like. Cover, in this order \
and only as far as the photo makes clear:
- the form factor and overall silhouette, and the rough proportions (squat and wide, tall and narrow, and so on)
- the body colour and finish — cream enamel, brushed stainless, matte black plastic, clear glass
- the control layout as it reads at a glance: how many dials, knobs, levers or buttons and roughly where they sit
- the one or two features that identify it — a tilt-back head, a domed lid, a spouted jug, a chrome bowl

The photo will very likely show a brand badge, a wordmark or a display panel somewhere on the item. You may SEE it; \
you must not describe, name, transcribe or allude to what it says in any way — no naming the brand, no "a logo on \
the front", no reporting what a screen or a dial's markings read. If the badge or panel is itself a distinctive \
shape, you may describe THAT shape (a chrome oval plate, a rectangular window) without ever saying what is printed \
or displayed on it.

If the photo is too dark, blurry, cropped or distant to make something out confidently, describe the typical form of \
that kind of equipment instead and do NOT invent detail you cannot actually see.

${SUBJECT_TEXT_RULE}

${SUBJECT_SCOPE_RULE}

Write two to four sentences of plain prose, up to about 120 words, beginning with the kind of thing it is ("a \
tilt-head stand mixer with…"). You have a photo in front of you — use the extra length to actually spell out what it \
shows, not to pad. Return only the brief.`;

// A photo prompt is materially slower than plain text: the model reads image
// tokens before it writes a word. Mirrors extractRecipeFromPhoto's single
// multimodal generate call (60s) rather than AI_TEXT_FLOW_TIMEOUT (55s) — NOT
// that flow's whole PHOTO_IMPORT_TIMEOUT_SECONDS budget, which exists to cover
// an assemble stage making further AI calls of its own that this flow never
// makes. Comfortably inside the 90s callable budget the same as the text path.
// No retry, same reasoning as AI_TEXT_FLOW_TIMEOUT: a human who presses Describe
// can press it again.
const PHOTO_EQUIPMENT_TIMEOUT = { timeoutMs: 60_000, retries: 0 } as const;

// The multimodal prompt shape, mirroring extractRecipeFromPhoto.ts: Genkit's
// media part wants a URL, so the bare base64 + content type are re-formed into a
// `data:` URI.
type PromptPart = { text: string } | { media: { url: string; contentType: string } };

export const describeEquipmentSubjectFlow = ai.defineFlow(
  {
    name: 'describeEquipmentSubject',
    inputSchema: DescribeEquipmentSubjectInputSchema,
    outputSchema: DescribeEquipmentSubjectOutputSchema,
  },
  async ({ name, currentBrief, hint, photo }) => {
    setActiveSpanName(`describeEquipmentSubject: ${name}`);

    const trimmedHint = hint?.trim();
    const trimmedBrief = currentBrief?.trim();
    // Revision needs BOTH halves: a sentence to revise and a correction to revise
    // it by. With either missing there is nothing to fold through anything, so we
    // author from scratch — which is also, deliberately, what "Start over" sends
    // (neither), so a description edited into a corner can be thrown away for a
    // fresh reading of the item's name. A photo ALWAYS authors from scratch too
    // — "Start over, but with a picture" — so it takes revision off the table
    // even if a stray currentBrief/hint somehow rode along.
    const revising = !photo && Boolean(trimmedBrief && trimmedHint);

    const textParts = [
      // The name stays FIRST in every mode: the device is the anchor, and the
      // brief/correction/photo are the edit applied on top of it.
      `Equipment name: ${name}`,
      revising ? `Current brief:\n${trimmedBrief}` : null,
      revising ? `Requested change: ${trimmedHint}` : null,
      // Authoring keeps its original shape: a steer with no brief to revise is
      // still an additive nudge on a fresh description. Photo mode has no steer.
      !photo && !revising && trimmedHint ? `Additional guidance: ${trimmedHint}` : null,
    ].filter((p): p is string => p !== null);

    const model = await flowModel('describeEquipmentSubject');

    const system = photo
      ? PHOTO_EQUIPMENT_SYSTEM
      : revising
        ? REVISE_EQUIPMENT_SYSTEM
        : DESCRIBE_EQUIPMENT_SYSTEM;

    // Text-only prompt stays a plain string, unchanged from before this mode
    // existed. Photo mode alone needs the array-of-parts shape, for the media
    // part the model actually reads.
    const prompt: string | PromptPart[] = photo
      ? [
          { text: textParts.join('\n\n') },
          {
            media: {
              url: `data:${photo.contentType};base64,${photo.base64}`,
              contentType: photo.contentType,
            },
          },
        ]
      : textParts.join('\n\n');

    const result = await withAiTimeout(
      'describeEquipmentSubject',
      () =>
        ai.generate({
          model,
          system,
          prompt,
          output: { schema: DescribeEquipmentSubjectOutputSchema },
        }),
      // No retry (the shared budget's, or the photo budget's): the trigger
      // treats a failure as "no brief" and the item simply waits for the next
      // manifest write, and a human pressing a button can press it again —
      // neither gains from burning the budget on an automatic second attempt.
      photo ? PHOTO_EQUIPMENT_TIMEOUT : AI_TEXT_FLOW_TIMEOUT,
    );

    // AI output is a trust boundary — validate before it leaves the flow.
    const parsed = DescribeEquipmentSubjectOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      throw new Error(`describeEquipmentSubject returned invalid output: ${parsed.error.message}`);
    }

    return { brief: parsed.data.brief.trim() };
  },
);
