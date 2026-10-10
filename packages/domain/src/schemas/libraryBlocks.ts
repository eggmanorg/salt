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
//
// ─── DRAWINGS ARE DRAWN FROM FIGURES ────────────────────────────────────────
//
// `chart`, `range` and `timeline` are data-drawn: the block holds figures and
// the renderer draws them to scale, so changing a figure redraws the drawing.
// A figure is still kept as the text typed — `1,062` shows as `1,062` — beside
// the number it means (`LibraryFigure`), which is what the drawing is scaled by.

export const LIBRARY_TONES = ['primary', 'sage', 'terracotta', 'warning', 'muted'] as const;
export const LibraryToneSchema = z.enum(LIBRARY_TONES);
export type LibraryTone = z.infer<typeof LibraryToneSchema>;

/** The block kinds that exist. A `salt-` fence naming anything else is a broken block. */
export const LIBRARY_BLOCK_KINDS = [
  'cards',
  'callout',
  'stats',
  'chart',
  'range',
  'timeline',
] as const;
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

// ─── Drawings (Phase 2) ─────────────────────────────────────────────────────

/** A figure as typed, and the number it means. */
export interface LibraryFigure {
  readonly text: string;
  readonly value: number;
}

// A plain number with an optional minus sign, decimal part, and comma thousands
// separators in their proper places: `130`, `-18`, `6.3`, `1,062`. Anything
// else — a unit, a range, a word — is not a figure, and says so.
const FIGURE_TEXT = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

/** The figure `text` means, or `null` when it is not a plain number. Timeline items read through it too. */
function readFigure(text: string): LibraryFigure | null {
  return FIGURE_TEXT.test(text) ? { text, value: Number(text.replace(/,/g, '')) } : null;
}

const figure = z
  .string()
  .trim()
  .transform((t, ctx): LibraryFigure => {
    const read = readFigure(t);
    if (read === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a plain number, like 130, 6.3 or 1,062',
      });
      return z.NEVER;
    }
    return read;
  });

const UNIT = 12;

// ── salt-chart ──

export const LIBRARY_CHART_TYPES = ['bar', 'column', 'pie'] as const;
/** How many items each chart type draws legibly on a phone. */
export const LIBRARY_CHART_ITEM_CAP = { bar: 12, column: 8, pie: 5 } as const;

const ChartItemSchema = z
  .object({
    label: text(40),
    value: figure,
    /** Unset: the drawing picks — one tone for bars, a different one per slice. */
    tone: LibraryToneSchema.optional(),
  })
  .strict();

export const LibraryChartBlockSchema = z
  .object({
    /** `bar` runs left to right, `column` bottom to top, `pie` is shares of a whole. */
    type: z.enum(LIBRARY_CHART_TYPES).default('bar'),
    /** Written after every value: `ml`, `°`, `%`. */
    unit: text(UNIT).optional(),
    items: z.array(ChartItemSchema).min(2).max(LIBRARY_CHART_ITEM_CAP.bar),
    caption: text(LINE).optional(),
  })
  .strict()
  .superRefine((chart, ctx) => {
    const cap = LIBRARY_CHART_ITEM_CAP[chart.type];
    if (chart.items.length > cap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: `a ${chart.type} chart draws at most ${cap} items`,
      });
    }
    // Bars and slices are drawn from zero, so a value below it has nowhere to go.
    chart.items.forEach((item, i) => {
      if (item.value.value < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', i, 'value'],
          message: 'a chart is drawn from zero, so a value cannot be below it',
        });
      }
    });
    if (chart.type === 'pie' && chart.items.every((item) => item.value.value === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'a pie needs at least one value above zero',
      });
    }
  });

// ── salt-range ──

/**
 * A value (`at`) or a range (`from`–`to`). Read as `{ from, to? }`: `to` absent
 * is a single value. Shared by `range` stages and `timeline` items' elapsed form.
 */
function spanOf(
  s: {
    at?: LibraryFigure | undefined;
    from?: LibraryFigure | undefined;
    to?: LibraryFigure | undefined;
  },
  ctx: z.RefinementCtx,
): { from: LibraryFigure; to?: LibraryFigure } {
  if (s.at && !s.from && !s.to) return { from: s.at };
  if (!s.at && s.from && s.to) {
    if (s.to.value < s.from.value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`to` is below `from`' });
    }
    return { from: s.from, to: s.to };
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'needs either `at`, or both `from` and `to`',
  });
  return z.NEVER;
}

const RangeStageSchema = z
  .object({
    /** The stage's name — said to a screen reader, and on hover. */
    label: text(SHORT).optional(),
    at: figure.optional(),
    from: figure.optional(),
    to: figure.optional(),
    /** Unset: the tone of the band the stage's top value sits in. */
    tone: LibraryToneSchema.optional(),
  })
  .strict()
  .transform((s, ctx) => ({ label: s.label, tone: s.tone, ...spanOf(s, ctx) }));

const RangeRowSchema = z
  .object({
    label: text(40),
    stages: z.array(RangeStageSchema).min(1).max(4),
  })
  .strict();

/** The most rows one range drawing holds, across all its groups. */
export const LIBRARY_RANGE_ROW_CAP = 40;

const RangeGroupSchema = z
  .object({
    heading: text(SHORT).optional(),
    rows: z.array(RangeRowSchema).min(1).max(LIBRARY_RANGE_ROW_CAP),
  })
  .strict();

/** A shaded stretch of the axis — gentle, steady, fierce. Open-ended on a missing edge. */
const RangeBandSchema = z
  .object({
    from: figure.optional(),
    to: figure.optional(),
    label: text(SHORT),
    tone: LibraryToneSchema,
  })
  .strict()
  .superRefine((b, ctx) => {
    if (!b.from && !b.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a band needs `from`, `to` or both' });
    } else if (b.from && b.to && b.to.value <= b.from.value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a band’s `to` must be above `from`' });
    }
  });

/** A marked value across every row — the 130 °C butter line. */
const RangeLineSchema = z
  .object({
    at: figure,
    label: text(SHORT),
    tone: LibraryToneSchema.default('warning'),
  })
  .strict();

export const LibraryRangeBlockSchema = z
  .object({
    /** Written after every tick and value: `°`, `°C`, `%`. */
    unit: text(UNIT).optional(),
    /** The axis ends. Unset: the lowest and highest figure in the block. */
    min: figure.optional(),
    max: figure.optional(),
    bands: z.array(RangeBandSchema).max(5).default([]),
    lines: z.array(RangeLineSchema).max(3).default([]),
    groups: z.array(RangeGroupSchema).min(1).max(8),
    caption: text(LINE).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const rows = r.groups.reduce((n, g) => n + g.rows.length, 0);
    if (rows > LIBRARY_RANGE_ROW_CAP) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['groups'],
        message: `a range drawing holds at most ${LIBRARY_RANGE_ROW_CAP} rows`,
      });
    }
    if (r.min && r.max && r.max.value <= r.min.value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['max'], message: 'must be above `min`' });
      return;
    }
    // A figure past an axis end the author set would be drawn off the drawing.
    const lo = r.min?.value ?? -Infinity;
    const hi = r.max?.value ?? Infinity;
    const outside = (f: LibraryFigure | undefined) =>
      f !== undefined && (f.value < lo || f.value > hi);
    const figures = [
      ...r.groups.flatMap((g) =>
        g.rows.flatMap((row) => row.stages.flatMap((s) => [s.from, s.to])),
      ),
      ...r.bands.flatMap((b) => [b.from, b.to]),
      ...r.lines.map((l) => l.at),
    ];
    const off = figures.find(outside);
    if (off) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${off.text} is outside the axis (${r.min?.text ?? '…'} to ${r.max?.text ?? '…'})`,
      });
    }
  });

// ── salt-timeline ──

/** Elapsed time in one of these, or calendar dates (`YYYY-MM-DD`). */
export const LIBRARY_TIMELINE_UNITS = ['minutes', 'hours', 'days', 'weeks', 'dates'] as const;
export type LibraryTimelineUnit = (typeof LIBRARY_TIMELINE_UNITS)[number];

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * A calendar date as days since 1970-01-01, read in UTC so no time zone can move
 * it a day. `null` for anything that is not a real `YYYY-MM-DD` date.
 */
export function libraryDayNumber(text: string): number | null {
  const m = ISO_DATE.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  // Date.UTC rolls 2026-02-30 over to 2 March; a real date survives the trip.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return ms / MS_PER_DAY;
}

const TimelineItemSchema = z
  .object({
    label: text(SHORT),
    // Read once `unit` is known: a figure in elapsed units, a date for `dates`.
    at: text(24).optional(),
    from: text(24).optional(),
    to: text(24).optional(),
    tone: LibraryToneSchema.optional(),
  })
  .strict();

export const LibraryTimelineBlockSchema = z
  .object({
    unit: z.enum(LIBRARY_TIMELINE_UNITS).default('days'),
    items: z.array(TimelineItemSchema).min(1).max(16),
    caption: text(LINE).optional(),
  })
  .strict()
  .transform((t, ctx) => {
    const read = (text: string | undefined, path: (string | number)[]) => {
      if (text === undefined) return undefined;
      if (t.unit === 'dates') {
        const day = libraryDayNumber(text);
        if (day === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: 'must be a date, like 2026-10-12',
          });
          return undefined;
        }
        return { text, value: day };
      }
      const f = readFigure(text);
      if (f === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `must be a number of ${t.unit}`,
        });
      }
      return f ?? undefined;
    };
    const items = t.items.map((item, i) => {
      const at = read(item.at, ['items', i, 'at']);
      const from = read(item.from, ['items', i, 'from']);
      const to = read(item.to, ['items', i, 'to']);
      const itemCtx: z.RefinementCtx = {
        addIssue: (issue) => ctx.addIssue({ ...issue, path: ['items', i, ...(issue.path ?? [])] }),
        path: [...ctx.path, 'items', i],
      };
      return { label: item.label, tone: item.tone, ...spanOf({ at, from, to }, itemCtx) };
    });
    return { unit: t.unit, items, caption: t.caption };
  });

export type LibraryCardsBlock = z.infer<typeof LibraryCardsBlockSchema>;
export type LibraryCalloutBlock = z.infer<typeof LibraryCalloutBlockSchema>;
export type LibraryStatsBlock = z.infer<typeof LibraryStatsBlockSchema>;
export type LibraryChartBlock = z.infer<typeof LibraryChartBlockSchema>;
export type LibraryRangeBlock = z.infer<typeof LibraryRangeBlockSchema>;
export type LibraryTimelineBlock = z.infer<typeof LibraryTimelineBlockSchema>;

export type LibraryBlock =
  | { readonly kind: 'cards'; readonly data: LibraryCardsBlock }
  | { readonly kind: 'callout'; readonly data: LibraryCalloutBlock }
  | { readonly kind: 'stats'; readonly data: LibraryStatsBlock }
  | { readonly kind: 'chart'; readonly data: LibraryChartBlock }
  | { readonly kind: 'range'; readonly data: LibraryRangeBlock }
  | { readonly kind: 'timeline'; readonly data: LibraryTimelineBlock };

export type LibraryBlockParse =
  | { readonly ok: true; readonly block: LibraryBlock }
  | { readonly ok: false; readonly problem: string };

const SCHEMAS = {
  cards: LibraryCardsBlockSchema,
  callout: LibraryCalloutBlockSchema,
  stats: LibraryStatsBlockSchema,
  chart: LibraryChartBlockSchema,
  range: LibraryRangeBlockSchema,
  timeline: LibraryTimelineBlockSchema,
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
    // `split` never returns an empty array.
    const first = err instanceof Error ? err.message.split('\n')[0]! : '';
    return { ok: false, problem: `its lines could not be read (${first})` };
  }

  const parsed = SCHEMAS[kind].safeParse(raw);
  if (!parsed.success) {
    // Zod reports a failed parse with at least one issue.
    return { ok: false, problem: describeIssue(parsed.error.issues[0]!) };
  }
  // The cast is the narrowing `SCHEMAS[kind]` loses: TypeScript cannot carry the
  // correlation between `kind` and the schema it indexed through a union key.
  return { ok: true, block: { kind, data: parsed.data } as LibraryBlock };
}
