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
