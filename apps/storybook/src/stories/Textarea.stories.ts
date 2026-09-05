import type { Meta, StoryObj } from '@storybook/svelte-vite';
// Rule 7: primitives are consumed ONLY through @salt/ui-components.
import { Textarea } from '@salt/ui-components';

// Standard CSF3 (.stories.ts) — see Button.stories.ts for why Svelte CSF is not
// used under Vite 8. Textarea mirrors TextField: a plain form primitive with no
// compound children, so it is driven directly (no wrapper). A label is always
// supplied so the rendered <textarea> has an accessible name.
const meta = {
  title: 'Primitives/Textarea',
  component: Textarea,
  args: {
    label: 'Notes',
    placeholder: 'Add a note for the family…',
    size: 'md',
    rows: 3,
    autoresize: false,
    required: false,
    disabled: false,
    readonly: false,
  },
  argTypes: {
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    label: { control: 'text' },
    placeholder: { control: 'text' },
    description: { control: 'text' },
    error: { control: 'text' },
    value: { control: 'text' },
    rows: { control: { type: 'number', min: 1, max: 20 } },
    maxLength: { control: { type: 'number', min: 0 } },
    autoresize: { control: 'boolean' },
    required: { control: 'boolean' },
    disabled: { control: 'boolean' },
    readonly: { control: 'boolean' },
  },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

// Live playground: the Controls panel drives real Textarea props.
export const Playground: Story = {};

// Empty vs filled, snapshotted as a named pair (#821) — see TextField.stories.ts.
// The multi-line case is the one that motivated the change: a guided-plan prep
// step is a Textarea, and its example text used to be indistinguishable from a
// real instruction someone had written.
export const Placeholder: Story = {
  args: { label: 'Notes', value: '' },
};

export const Filled: Story = {
  args: { label: 'Notes', value: 'Dice the carrots, onion and celery into 5mm pieces.' },
};

// Grows to fit its content instead of scrolling.
export const Autoresize: Story = {
  args: {
    autoresize: true,
    value:
      'Autoresize grows the field to fit its content.\nAdd another line and the box expands\ninstead of showing a scrollbar.',
  },
};

// Error state: aria-invalid + role="alert" message.
export const WithError: Story = {
  args: {
    label: 'Instructions',
    value: '',
    error: 'Instructions are required',
    required: true,
  },
};

// Description helper text below the field.
export const WithDescription: Story = {
  args: {
    description: 'Visible to everyone in the household.',
  },
};

// Disabled.
export const Disabled: Story = { args: { disabled: true, value: 'Cannot edit this' } };

// Size scale.
export const Small: Story = { args: { size: 'sm', label: 'Small' } };
export const Large: Story = { args: { size: 'lg', label: 'Large' } };
