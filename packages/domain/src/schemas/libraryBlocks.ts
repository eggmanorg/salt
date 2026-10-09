import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Library blocks (issue #1663) — the laid-out parts of a library page.
//
// A block is a fenced code block in a page's markdown `body` whose info string
// is `salt-<kind>`, and whose content is YAML in the shape the schema for that
// kind describes:
//
//     ```salt-callout
//     tone: warning
//     label: Probe Control
//     body: Poached eggs and potatoes read the water, not the pan.
//     ```
//
// They live INSIDE `body`, so `LibraryPageSchema` is unchanged and every body
// written before blocks existed is already a valid body: it simply has none.
// Shared because both ends name it — the page writer in `apps/cloud-functions`
// validates what it composed against these schemas before saving, and the
// library surfaces in `apps/web-pwa` parse with them to render.
//
// ─── COLOUR IS A TONE, NEVER A VALUE ────────────────────────────────────────
//
// Every field that colours anything is a `LibraryTone`, and the renderer maps a
// tone to a design token. There is no field anywhere in these schemas that takes
// a colour, a class or a style, so a block cannot carry an arbitrary colour by
// construction — not by prompt instruction. `libraryBlocks.test.ts` pins it by
// walking every schema for a string field named like one.
//
// ─── YAML IS READ WITH THE FAILSAFE SCHEMA ──────────────────────────────────
//
// Every scalar comes back as the string the author typed. `value: 6.30` stays
// "6.30" instead of becoming the number 6.3, and `label: no` stays "no" instead
// of becoming `false` — what you type into a block on your phone is what the
// page shows. The one boolean field (`arrows`) reads the words `true`/`false`.

export const LIBRARY_TONES = ['primary', 'sage', 'terracotta', 'warning', 'muted'] as const;
export const LibraryToneSchema = z.enum(LIBRARY_TONES);
export type LibraryTone = z.infer<typeof LibraryToneSchema>;

/** The block kinds that exist. A `salt-` fence naming anything else is a broken block. */
export const LIBRARY_BLOCK_KINDS = ['cards', 'callout', 'stats'] as const;
export type LibraryBlockKind = (typeof LIBRARY_BLOCK_KINDS)[number];

/** The info-string prefix that marks a fenced code block as a library block. */
export const LIBRARY_BLOCK_FENCE_PREFIX = 'salt-';

// Caps. A block is a part of a page a phone has to draw; these keep one block
// from being a page on its own, and keep a broken model output from being huge.
const SHORT = 80;
const LINE = 300;
const PROSE = 1_000;

const text = (max: number) => z.string().trim().min(1).max(max);
const yamlBoolean = z.enum(['true', 'false']).transform((v) => v === 'true');

const ChipSchema = z
  .object({
    label: text(SHORT),
    tone: LibraryToneSchema.default('muted'),
  })
  .strict();

// A line is either a plain sentence or a sentence under a small label — the
// "1 · Rendering" stage name in the mock-up. A bare string is accepted so the
// common case is one line of YAML when typed by hand.
const CardLineSchema = z.union([
  text(LINE).transform((t) => ({ label: undefined as string | undefined, text: t })),
  z.object({ label: text(SHORT).optional(), text: text(LINE) }).strict(),
]);

const CardSchema = z
  .object({
    title: text(SHORT),
    chips: z.array(ChipSchema).max(6).default([]),
    /** Join the chips with arrows: they are stages in order, not a set. */
    arrows: yamlBoolean.default('false'),
    lines: z.array(CardLineSchema).max(8).default([]),
    footnote: text(LINE).optional(),
  })
  .strict();

const CardGroupSchema = z
  .object({
    heading: text(SHORT).optional(),
    cards: z.array(CardSchema).min(1).max(12),
  })
  .strict();

export const LibraryCardsBlockSchema = z
  .object({ groups: z.array(CardGroupSchema).min(1).max(8) })
  .strict();

export const LibraryCalloutBlockSchema = z
  .object({
    tone: LibraryToneSchema.default('primary'),
    label: text(SHORT).optional(),
    /** Markdown, rendered inline at note scale. */
    body: text(PROSE),
  })
  .strict();

const StatSchema = z
  .object({
    value: text(24),
    label: text(SHORT),
    tone: LibraryToneSchema.default('muted'),
  })
  .strict();

export const LibraryStatsBlockSchema = z
  .object({ items: z.array(StatSchema).min(2).max(4) })
  .strict();

export type LibraryCardsBlock = z.infer<typeof LibraryCardsBlockSchema>;
export type LibraryCalloutBlock = z.infer<typeof LibraryCalloutBlockSchema>;
export type LibraryStatsBlock = z.infer<typeof LibraryStatsBlockSchema>;

export type LibraryBlock =
  | { readonly kind: 'cards'; readonly data: LibraryCardsBlock }
  | { readonly kind: 'callout'; readonly data: LibraryCalloutBlock }
  | { readonly kind: 'stats'; readonly data: LibraryStatsBlock };

export type LibraryBlockParse =
  | { readonly ok: true; readonly block: LibraryBlock }
  | { readonly ok: false; readonly problem: string };

const SCHEMAS = {
  cards: LibraryCardsBlockSchema,
  callout: LibraryCalloutBlockSchema,
  stats: LibraryStatsBlockSchema,
} as const satisfies Record<LibraryBlockKind, z.ZodTypeAny>;

function isKind(kind: string): kind is LibraryBlockKind {
  return (LIBRARY_BLOCK_KINDS as readonly string[]).includes(kind);
}

function describeIssue(issue: z.ZodIssue): string {
  const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${where}${issue.message}`;
}

/**
 * Parse one block's source — the text between its fences — as `kind`.
 *
 * Never throws: bad YAML, an unknown kind and a shape the schema refuses all
 * come back as `{ ok: false, problem }`, a sentence short enough to show under
 * the raw text on the page. `kind` is the part of the info string after
 * `salt-`.
 */
export function parseLibraryBlock(kind: string, source: string): LibraryBlockParse {
  if (!isKind(kind)) return { ok: false, problem: `there is no "${kind}" drawing` };

  let raw: unknown;
  try {
    raw = parseYaml(source, { schema: 'failsafe' });
  } catch (err) {
    const first = err instanceof Error ? (err.message.split('\n')[0] ?? '') : '';
    return { ok: false, problem: `its lines could not be read (${first})` };
  }

  const parsed = SCHEMAS[kind].safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, problem: first ? describeIssue(first) : 'its shape is wrong' };
  }
  // The cast is the narrowing `SCHEMAS[kind]` loses: TypeScript cannot carry the
  // correlation between `kind` and the schema it indexed through a union key.
  return { ok: true, block: { kind, data: parsed.data } as LibraryBlock };
}
