// spec: ui-spec-v04.md §12.7 v0.4
import type { DocTone } from './DocBlocks.types';

/**
 * Tone → design token, as Tailwind classes over the `--color-*` roles in
 * `salt.css`. The one place a document block's colour is decided.
 *
 * `tint` is a pale ground with a legible foreground — a chip, a callout. The
 * sage, teal and terracotta tints are `salt.css`'s three keying tints (built to
 * tell peers apart, which is what a gentle / steady / fierce chip row is);
 * `warning` uses that family's own ladder (`/10` ground, `-text` ink), and
 * `muted` is the neutral surface. `ink` is the same hue as text on the card.
 */
export const DOC_TONE_TINT: Record<DocTone, string> = {
  primary: 'bg-primary-tint text-primary-tint-foreground',
  sage: 'bg-secondary-tint text-secondary-tint-foreground',
  terracotta: 'bg-tertiary-tint text-tertiary-tint-foreground',
  warning: 'bg-warning/10 text-warning-text',
  muted: 'bg-muted text-muted-foreground',
};

export const DOC_TONE_INK: Record<DocTone, string> = {
  primary: 'text-primary',
  sage: 'text-secondary',
  terracotta: 'text-tertiary-variant',
  warning: 'text-warning-text',
  muted: 'text-foreground',
};

/**
 * Solid marks in a drawing — a bar, a dot, a legend swatch — with a legible
 * ink for a number drawn on one. The tone's full-strength token.
 */
export const DOC_TONE_SOLID: Record<DocTone, string> = {
  primary: 'bg-primary text-primary-foreground',
  sage: 'bg-secondary text-secondary-foreground',
  terracotta: 'bg-tertiary-variant text-tertiary-foreground',
  warning: 'bg-warning text-primary-foreground',
  muted: 'bg-placeholder text-primary-foreground',
};

/** A band shaded behind a drawing's marks: the tint, faded so marks read over it. */
export const DOC_TONE_BAND: Record<DocTone, string> = {
  primary: 'bg-primary-tint/60',
  sage: 'bg-secondary-tint/60',
  terracotta: 'bg-tertiary-tint/60',
  warning: 'bg-warning/10',
  muted: 'bg-muted',
};

/** A pie slice: the solid token as an SVG fill. */
export const DOC_TONE_FILL: Record<DocTone, string> = {
  primary: 'fill-primary',
  sage: 'fill-secondary',
  terracotta: 'fill-tertiary-variant',
  warning: 'fill-warning',
  muted: 'fill-placeholder',
};

/** A reference line: the solid token as a border colour. */
export const DOC_TONE_RULE: Record<DocTone, string> = {
  primary: 'border-primary',
  sage: 'border-secondary',
  terracotta: 'border-tertiary-variant',
  warning: 'border-warning',
  muted: 'border-placeholder',
};
