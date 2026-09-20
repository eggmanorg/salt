import type { Meta, StoryObj } from '@storybook/svelte-vite';
// Rule 7: primitives are consumed ONLY through @salt/ui-components.
import { Progress } from '@salt/ui-components';

// Standard CSF3 (.stories.ts) — see Button.stories.ts.
//
// Determinate vs indeterminate is decided by whether `value` (or
// `defaultValue`) is set: pass a number for a filled bar, omit it entirely for
// the indeterminate (looping) bar. `value` is intentionally left out of the
// meta args so the Indeterminate story — which sets no value — stays truly
// indeterminate.
const meta = {
  title: 'Primitives/Progress',
  component: Progress,
  args: {
    max: 100,
    announce: 'polite',
    ariaLabel: 'Loading',
  },
  argTypes: {
    value: { control: { type: 'number', min: 0, max: 100, step: 1 } },
    defaultValue: { control: { type: 'number', min: 0, max: 100, step: 1 } },
    max: { control: { type: 'number', min: 1, step: 1 } },
    announce: { control: 'select', options: ['polite', 'off'] },
    presentational: { control: 'boolean' },
    ariaLabel: { control: 'text' },
    class: { control: 'text' },
  },
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

// Live playground: set `value` for a determinate bar, clear it for indeterminate.
export const Playground: Story = { args: { value: 50 } };

// Determinate.
export const Empty: Story = { args: { value: 0 } };
export const Half: Story = { args: { value: 50 } };
export const Full: Story = { args: { value: 100 } };

// Indeterminate: no `value`/`defaultValue` supplied.
export const Indeterminate: Story = {};

// Presentational (ui-spec-v16 §1): the identical bar rendered as spans and
// hidden from the accessibility tree, for a bar whose figure the surrounding
// content already states in words — or one that has to sit inside a <button>,
// which may hold phrasing content only. Visually indistinguishable from `Half`
// by design; inspect the DOM to see the difference.
export const Presentational: Story = { args: { value: 50, presentational: true } };
