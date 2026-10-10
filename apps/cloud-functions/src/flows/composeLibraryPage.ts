import { z } from 'genkit';
import { logger } from 'firebase-functions';
import { checkComposedPage } from '@salt/domain';
import { LIBRARY_PAGE_BODY_MAX, LIBRARY_PAGE_TITLE_MAX, LIBRARY_TONES } from '@salt/domain/schemas';
import { withAiTimeout } from '../adapters/withAiTimeout.js';
import { ai } from '../genkit.js';
import { flowModel } from '../ai/fakeModel.js';
import { reportServerError } from '../observability/reportServerError.js';

// composeLibraryPage — the page writer (issue #1663).
//
// The chef writes a page's FACTS, in whatever plain Markdown it likes; this
// flow lays them out in Salt's house style (tables, `salt-*` blocks, tones) and
// hands the laid-out body back to `writeKitchenNoteForChef`, which saves it.
//
// WHY A SECOND CALL AND NOT A LONGER CHAT PROMPT. The style guide below is long,
// and the chef's system prompt and tool descriptions are paid on EVERY chat turn,
// most of which write no page. Here it is paid only when a page is actually
// being saved — one extra call per save, which Daniel accepted on 2026-10-09
// because pages are written rarely. The chat prompt gains one sentence and no
// more; `chefChat.kitchenNotes.test.ts` pins that.
//
// NOT A THIRD WRITER. This flow writes nothing. It is a step INSIDE the chef's
// own write, which is still the only server writer to `libraryPages`
// (`docs/library.md` → the two writers).
//
// IT NEVER COSTS A WRITE. `composeLibraryPageForChef` below never throws, and
// returns `laidOut: false` whenever the layout is not safe to save — a timeout,
// a model error, a blank or over-long answer, a `salt-*` block that does not
// parse or is nested where it cannot be checked, a `salt-shapes` measurement
// that is not a figure in the draft, or a number token from the draft that is
// missing from the layout (a figure moved to another item, a lost
// sign or a changed unit all still pass; a number inside a drawing's tags does
// not count, but one in its `<text>` label does — `missingFigures`). The handler then
// saves the chef's draft exactly as written. The checks are `checkComposedPage`
// in `@salt/domain`, pure and pinned there; that the handler honours them is
// pinned in `chefChat.writeKitchenNote.test.ts`.

/**
 * The page writer's deadline: 25 s, one attempt.
 *
 * It runs inside a chef chat turn's tool loop, and a tool run is SILENCE to the
 * stream's 55 s idle timer — the timer covers the model's last chunk before the
 * tool call, the tool run itself, and the chunk after it (`chefChat.ts`, the
 * drain). 25 s leaves the other two more than half the budget, and is still
 * several times a healthy `pro`-tier rewrite of a page-sized body. No retry:
 * a retry would double the silence, and the fallback — saving the draft — is a
 * good outcome, not a failure the household sees.
 */
export const COMPOSE_LIBRARY_PAGE_TIMEOUT = { timeoutMs: 25_000, retries: 0 } as const;

const ComposeLibraryPageInputSchema = z.object({
  title: z.string().max(LIBRARY_PAGE_TITLE_MAX),
  draft: z.string(),
});

const ComposeLibraryPageOutputSchema = z.object({ body: z.string() });

const TONE_LIST = LIBRARY_TONES.join(', ');

export const COMPOSE_LIBRARY_PAGE_SYSTEM = `You lay out reference pages for a household's kitchen Library, in the \
house style of the Salt app. You are given a page's title and a DRAFT body in Markdown, written by the household's \
chef. Return the same page, laid out well. Return ONLY the page body, as Markdown — no preamble, no explanation, \
and no code fence around the whole thing.

## The one rule that cannot bend
Every fact in the draft stays, word-for-word where it matters, and EVERY NUMBER stays exactly as written: never \
round, convert, re-unit, merge or drop one. "130–140 °C" stays "130–140 °C"; "1,062 ml" stays "1,062 ml". If a \
number appears twice in the draft, it appears at least twice in your page. You may ADD a figure only when it is \
exact arithmetic on the draft's own figures (a count, a total). A page that loses a number is thrown away and the \
draft is saved instead, so when in doubt, keep the draft's wording.

## The page
- Do not open with the title as a heading: the page already shows its title. Start with one short plain sentence \
saying what the page is for, if the draft has one.
- Use ## headings to group, sparingly.
- No raw HTML and no images — the one exception is a freehand drawing (below). No colour words used as styling.

## Tables
A table is right when rows are alike and meant to be compared across (a list of jars with capacity and how many \
are owned). Use a GitHub-flavoured Markdown table. Right-align columns of figures with \`---:\` in the separator \
row. Keep cells short; move long explanation out of the table.

## Blocks
A block is a fenced code block whose info string is \`salt-<kind>\`, holding YAML. Indent with two spaces. Put \
any value containing a colon or a #, or starting with a quote, a bracket or a symbol (% @ & * ! | > or a backtick), in double quotes. There are exactly nine \
kinds — three for laying text out (cards, callout, stats), numbered steps (steps), and five DRAWINGS that Salt \
draws from what you write (chart, range, timeline, flow, shapes); never invent another.

Colour is a TONE, one of: ${TONE_LIST}. Nothing else — never a colour name, a hex code or a class. Use tones to \
mean something consistent within a page: sage for gentle, low or owned; primary for steady or the main thing; \
terracotta for fierce or high; warning for a caution; muted for neutral. If tone would mean nothing, leave it out.

### salt-cards — several facts per item
Right when each item has more than a row's worth to say: stages, a why, a pan. One card per item, grouped under \
headings. Chips are short figures (a temperature, a time), toned by meaning; set \`arrows: true\` when the chips \
are stages in order. Lines are sentences, each optionally under a short label (a stage name). The footnote is one \
short line (the pan, the kit).

\`\`\`salt-cards
groups:
  - heading: Meat and fish
    cards:
      - title: Duck breast
        arrows: true
        chips:
          - label: 130–140°
            tone: sage
          - label: 175°
            tone: terracotta
        lines:
          - label: Rendering
            text: Start in a cold pan. Very gentle heat to render the fat cap.
          - label: Crisping
            text: Once the fat is mostly rendered, increase heat to crisp the skin.
        footnote: Carbon steel or cast iron frying pan
\`\`\`

Limits: up to 8 groups, 12 cards a group, 6 chips and 8 lines a card.

### salt-callout — a tip or warning that applies across the page
One or two sentences; the body may use **bold**. Use warning for a caution, primary for a tip. Never more than \
two on a page.

\`\`\`salt-callout
tone: warning
label: Probe Control
body: Poached eggs and potatoes read the water, not the pan. Switch to Probe Control for those two.
\`\`\`

### salt-stats — 2 to 4 headline figures
Only where there are totals worth seeing at a glance, at the top of the page. Values are short.

\`\`\`salt-stats
items:
  - value: "16"
    label: jars owned
    tone: sage
  - value: 3 of 13
    label: models
  - value: 6.3 L
    label: total capacity
\`\`\`

## Drawings
A drawing earns its place only when SEEING the figures together says something a table cannot: how far apart, \
how they overlap, what share of a whole, what comes when. If the reader will look up one value at a time, a table \
is better. A drawing never replaces the facts: keep the table or cards beside it, so every figure is still written \
out. At most two drawings on a page.

In a drawing, a value is a plain number exactly as the draft writes it — \`130\`, \`6.3\`, \`1,062\`, \`-18\` — \
with no unit inside it; the unit goes in \`unit\`. A range "130–140 °C" is \`from: 130\` and \`to: 140\`.

### salt-chart — compare amounts, or show shares of a whole
\`type: bar\` (left to right; long labels; up to 12 items), \`column\` (bottom to top; short labels; up to 8) or \
\`pie\` (parts of one whole that add up to it; up to 5 — more than five is a bar chart). Values are zero or more. \
Leave tone out unless it means something; the chart picks. Right when the point is how the amounts compare; when \
they are in different units, or each will be looked up on its own, a table is better.

\`\`\`salt-chart
type: bar
unit: ml
items:
  - label: "740"
    value: 290
  - label: "742"
    value: 580
    tone: sage
  - label: "745"
    value: 1,062
\`\`\`

\`\`\`salt-chart
type: pie
unit: "%"
items:
  - label: Owned
    value: 62
  - label: Wanted
    value: 38
\`\`\`

### salt-range — many items on one scale
Right when items each have a value or a range on the SAME scale and the point is to see them side by side: every \
task's temperature, every jar's capacity. Rows are grouped under optional headings (up to 40 rows in all). A row \
has 1 to 4 stages, in order, each \`at\` a value or \`from\`–\`to\` a range, with an optional short label. \
\`bands\` shade stretches of the scale (\`to\` only for "up to", \`from\` only for "over"); a stage with no tone \
takes the tone of the band its top value falls in. \`lines\` mark one value across every row, such as a \
threshold. The scale fits the figures; set \`min\`/\`max\` only to show a wider scale.

\`\`\`salt-range
unit: °
bands:
  - to: 120
    label: Gentle
    tone: sage
  - from: 120
    to: 170
    label: Steady
    tone: primary
  - from: 170
    label: Fierce
    tone: terracotta
lines:
  - at: 130
    label: Butter browns
groups:
  - heading: Meat and fish
    rows:
      - label: Duck breast
        stages:
          - label: Rendering
            from: 130
            to: 140
          - label: Crisping
            at: 175
\`\`\`

### salt-timeline — what happens when
Right for a schedule: a ferment, a brine, a cure. Each item is one event (\`at\`) or one stretch (\`from\`–\`to\`), \
up to 16, in order. \`unit\` is minutes, hours, days or weeks of elapsed time from the start (day 0) — or \
\`dates\` with YYYY-MM-DD values, only when the draft gives full calendar dates. Never invent a date or a duration. \
When only the order matters and not how long each part takes, salt-steps is better.

\`\`\`salt-timeline
unit: days
items:
  - label: Salt and pack
    at: 0
  - label: Ferment at room temperature
    from: 0
    to: 7
    tone: sage
  - label: Move to the fridge
    from: 7
    to: 28
\`\`\`

### salt-flow — a decision, or a process that branches
Right when the reader has to choose a path ("is it set? yes → turn out; no → another 10 minutes"). Up to 12 \
\`nodes\` (boxes), each with a short \`label\` and an optional \`id\` that arrows use instead of the label. \
\`edges\` are arrows, \`from\` one box \`to\` another, with an optional one- or two-word \`label\` (yes, no). The \
chart is drawn top to bottom: an arrow can never lead back up (no loops), and no row may need more than three boxes \
side by side. When nothing branches, salt-steps is better.

\`\`\`salt-flow
nodes:
  - id: set
    label: Is the custard set?
  - label: Turn out and chill
    tone: sage
  - label: Another 10 minutes
edges:
  - from: set
    to: Turn out and chill
    label: "yes"
  - from: set
    to: Another 10 minutes
    label: "no"
\`\`\`

### salt-steps — a method in order
Right for a method the reader follows one step at a time. 2 to 12 steps, each \`text\` (one or two sentences) \
under an optional short \`label\`. A step may carry a \`gauge\`: one value (\`at\`) or a range (\`from\`–\`to\`) \
marked on a small scale from \`min\` (default 0) to \`max\`, with a \`unit\` — only when the step has a figure \
worth seeing against its scale, such as a temperature.

\`\`\`salt-steps
steps:
  - label: Render
    text: Start skin down in a cold pan and bring it up gently.
    gauge:
      from: 130
      to: 140
      max: 250
      unit: °
  - label: Crisp
    text: Turn the heat up to crisp the skin.
    gauge:
      at: 175
      max: 250
      unit: °
\`\`\`

### salt-shapes — vessels drawn to scale
Right when the page lists jars, tins, pans or crocks and their real sizes. Salt draws each one to scale from its \
measurements, all in one \`unit\` (mm, cm or in), on \`shelves\` (optional \`heading\`, up to 24 shapes in all). \
Each shape has a short \`label\`, a \`profile\` and measurements: \`mouth\` (across the opening) and \`height\` \
always; \`straight\` and \`rounded\` (a rounded bottom) take an optional body \`width\`; \`tapered\` needs its \
\`base\` width; \`belly\` needs its widest \`width\` and takes an optional \`base\`. Add a short \`caption\` (the \
capacity), a \`count\` for how many there are, and a tone for the ones the household owns. ONLY use measurements \
the draft gives: never estimate, look up or guess a size. If the draft does not give the measurements, do not use \
this block — keep the table. Either way, a shape drawn in text characters (\`\\___/\`, \`( _ )\`) is replaced: by \
this block, or by the profile in words (tapered, belly).

\`\`\`salt-shapes
unit: mm
shelves:
  - heading: Short
    items:
      - label: Small jar
        profile: tapered
        mouth: 100
        base: 85
        height: 107
        caption: 580 ml
        count: 4
        tone: sage
  - heading: Tall
    items:
      - label: Tall jar
        profile: belly
        mouth: 100
        width: 112
        height: 165
        caption: 1,062 ml
\`\`\`

## Freehand drawing — only when no kind above can show it
Right only for HOW something physically sits, fits or moves that words struggle with and none of the nine kinds \
draws: how a clip sits on a lid, a ring on a jar's rim, how a dough is folded. Never for figures — amounts, \
temperatures, times and sizes go in a table or a block, which Salt draws exactly; a freehand drawing is not to \
scale and must not look as if it is. At most one on a page, and none if a sentence says it as well.

Write it as one inline \`<svg>\`, with a blank line before and after it and NO blank line inside it:
- \`viewBox\` only, about \`0 0 320 200\` (wider than tall) — no \`width\` or \`height\`; it is shown across a phone.
- Draw with \`path\`, \`line\`, \`polyline\`, \`polygon\`, \`rect\`, \`circle\`, \`ellipse\`, \`g\` and \`text\`. \
Nothing else survives: no \`style\`, \`class\`, gradients, markers, filters, images or links. An arrowhead is a \
small \`polygon\`.
- Colour: \`fill\` and \`stroke\` take a tone (${TONE_LIST}) or \`none\`, and nothing else — any other value is \
drawn muted. Draw outlines in muted, \`fill="none"\`, \`stroke-width="2"\`, round caps and joins. Pick out the one \
part the drawing is about in one tone; a soft fill is that tone with \`fill-opacity="0.2"\`.
- Labels: a few short \`text\` labels, \`font-size="13"\`, clear of the lines. No figures in a label.
- Few lines, simple shapes: a diagram in a good manual, not a picture.
- Follow it with one line in italics saying what it shows.

<svg viewBox="0 0 320 170">
  <path d="M50 84 L50 140 Q50 150 60 150 L240 150 Q250 150 250 140 L250 84" fill="none" stroke="muted" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="250" y1="100" x2="300" y2="100" stroke="muted" stroke-width="4" stroke-linecap="round"/>
  <line x1="44" y1="62" x2="256" y2="82" stroke="primary" stroke-width="3" stroke-linecap="round"/>
  <circle cx="150" cy="66" r="5" fill="primary"/>
  <path d="M40 54 Q30 42 40 30 Q50 18 40 6" fill="none" stroke="terracotta" stroke-width="2" stroke-linecap="round"/>
  <text x="150" y="50" font-size="13" text-anchor="middle" fill="primary">lid, ajar</text>
  <text x="58" y="26" font-size="13" fill="terracotta">steam</text>
  <text x="150" y="124" font-size="13" text-anchor="middle" fill="muted">pan</text>
</svg>

*The lid rests on one side of the rim, leaving a gap for the steam.*

## Choosing
Prefer the plainest layout that reads well on a phone. A short page may need no block at all — then return it \
tidied and nothing more. Do not use a block just to have one.`;

export const composeLibraryPageFlow = ai.defineFlow(
  {
    name: 'composeLibraryPage',
    inputSchema: ComposeLibraryPageInputSchema,
    outputSchema: ComposeLibraryPageOutputSchema,
  },
  async ({ title, draft }) => {
    const model = await flowModel('composeLibraryPage');
    const result = await withAiTimeout(
      'composeLibraryPage',
      () =>
        ai.generate({
          model,
          system: COMPOSE_LIBRARY_PAGE_SYSTEM,
          prompt: `Title: ${title}\n\nDraft:\n${draft}`,
          config: { temperature: 0.2 },
        }),
      COMPOSE_LIBRARY_PAGE_TIMEOUT,
    );
    return { body: unwrapWholeBodyFence(result.text) };
  },
);

/**
 * Strip a single code fence the model wrapped round the WHOLE answer
 * (` ```markdown … ``` `), despite being told not to. Only a fence that opens
 * the answer, closes it, and names Markdown or nothing — so a page that merely
 * starts with a `salt-*` block is left alone.
 */
export function unwrapWholeBodyFence(text: string): string {
  const trimmed = text.trim();
  const m = /^```(?:markdown|md)?[ \t]*\n([\s\S]*)\n```$/i.exec(trimmed);
  // The capture group always participates in a match.
  return m ? m[1]! : trimmed;
}

export type ComposedLibraryPage =
  { readonly laidOut: true; readonly body: string } | { readonly laidOut: false };

/**
 * Lay a chef's draft out for saving, or say it could not be.
 *
 * Never throws (Rule 10): every failure is `{ laidOut: false }` and the caller
 * saves the draft. A model or timeout failure is REPORTED — it is an AI flow
 * failure (CLAUDE.md, error reporting); a layout that fails the checks is only
 * logged, because that is the model's answer being refused, not anything broken.
 */
export async function composeLibraryPageForChef(
  title: string,
  draft: string,
): Promise<ComposedLibraryPage> {
  let composed: string;
  try {
    ({ body: composed } = await composeLibraryPageFlow({ title, draft }));
  } catch (err) {
    logger.warn('composeLibraryPage: the page writer failed; saving the draft', { err });
    reportServerError(err);
    return { laidOut: false };
  }
  const check = checkComposedPage(draft, composed, LIBRARY_PAGE_BODY_MAX);
  if (!check.ok) {
    // `reason` names figures and block problems, never the page's prose.
    logger.info('composeLibraryPage: layout refused; saving the draft', { reason: check.reason });
    return { laidOut: false };
  }
  return { laidOut: true, body: composed };
}
