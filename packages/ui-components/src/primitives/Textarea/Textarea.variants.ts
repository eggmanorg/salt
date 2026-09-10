// spec: ui-spec-v02.md §8.3 v0.2.3
import { cva, type VariantProps } from '../../lib/variants';

export const textareaFrameVariants = cva(
  'salt-focus-ring-within flex items-start gap-2 rounded-md border border-input bg-background h-auto',
  {
    variants: {
      size: {
        sm: 'px-3 text-sm min-h-8',
        md: 'px-4 text-sm min-h-9',
        lg: 'px-6 text-base min-h-10',
      },
      error: {
        // `salt-input--error` rather than the border + a ring utility spelled
        // out here: it is the one place that decides what an errored frame
        // looks like, and it retints the focus ring through
        // `--salt-focus-color` — which the `focus-within:ring-destructive`
        // this replaced never managed to paint at all (#1305).
        true: 'salt-input--error',
        false: '',
      },
      disabled: {
        true: 'opacity-50 pointer-events-none',
        false: '',
      },
    },
    defaultVariants: { size: 'md', error: false, disabled: false },
  },
);

export type TextareaFrameVariants = VariantProps<typeof textareaFrameVariants>;
