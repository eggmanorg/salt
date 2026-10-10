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
// parse or is nested where it cannot be checked, or a number token from the
// draft that is missing from the layout (a figure moved to another item, a lost
// sign or a changed unit all still pass — `missingFigures`). The handler then
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
 * several times a healthy `fast`-tier rewrite of a page-sized body. No retry:
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
- No raw HTML, no SVG, no images, no colour words used as styling.

## Tables
A table is right when rows are alike and meant to be compared across (a list of jars with capacity and how many \
are owned). Use a GitHub-flavoured Markdown table. Right-align columns of figures with \`---:\` in the separator \
row. Keep cells short; move long explanation out of the table.

## Blocks
A block is a fenced code block whose info string is \`salt-<kind>\`, holding YAML. Indent with two spaces. Put \
any value containing a colon, a #, or starting with a quote or bracket in double quotes. There are exactly three \
kinds; never invent another.

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
