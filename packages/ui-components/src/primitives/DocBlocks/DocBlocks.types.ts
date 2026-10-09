// spec: ui-spec-v04.md §12.7 v0.4
import type { Snippet } from 'svelte';

/**
 * The only colour channel a document block has (§12.7). A NAME, mapped to a
 * design token in `docTone.ts` — there is no prop anywhere on these primitives
 * that takes a colour, a class for one or a style. `@salt/domain`'s
 * `LibraryTone` is the same five words; web-pwa passes one straight into the
 * other, so the compiler is what keeps the two lists in step.
 */
export type DocTone = 'primary' | 'sage' | 'terracotta' | 'warning' | 'muted';

export interface DocChip {
  label: string;
  tone: DocTone;
}

export interface DocCardLine {
  /** A small uppercase name ahead of the sentence — a stage, a step. */
  label?: string | undefined;
  text: string;
}

export interface DocCard {
  title: string;
  chips: readonly DocChip[];
  /** Join the chips with arrows: stages in order, not a set. */
  arrows: boolean;
  lines: readonly DocCardLine[];
  footnote?: string | undefined;
}

export interface DocCardGroup {
  heading?: string | undefined;
  cards: readonly DocCard[];
}

export interface DocCardsProps {
  groups: readonly DocCardGroup[];
  class?: string;
}

export interface DocCalloutProps {
  tone: DocTone;
  label?: string | undefined;
  /** The callout's body — the caller decides how it is rendered. */
  children?: Snippet;
  class?: string;
}

export interface DocStat {
  value: string;
  label: string;
  tone: DocTone;
}

export interface DocStatsProps {
  items: readonly DocStat[];
  class?: string;
}
