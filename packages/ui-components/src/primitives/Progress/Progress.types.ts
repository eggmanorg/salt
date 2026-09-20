// spec: ui-spec-v16.md §1 v0.16

export type ProgressProps = {
  value?: number;
  defaultValue?: number;
  max?: number;
  announce?: 'polite' | 'off';
  ariaLabel?: string;
  /**
   * Render the bar as a picture and nothing else (ui-spec-v16 §1): spans rather
   * than divs, no `role`, no `aria-live`, no `aria-value*`, and hidden from the
   * accessibility tree. For a bar whose figure the surrounding content already
   * states in words — and for the only place phrasing content is mandatory,
   * inside a control. `announce` and `ariaLabel` are ignored in this mode;
   * geometry, colours and clamping are identical to the default.
   */
  presentational?: boolean;
  class?: string;
};
