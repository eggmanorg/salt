import type { Meta, StoryObj } from '@storybook/svelte-vite';
// Rule 7: primitives are consumed ONLY through @salt/ui-components.
import { Markdown } from '@salt/ui-components';

// Standard CSF3 (.stories.ts) — see Button.stories.ts. `text` is a plain string
// prop, so no wrapper/snippet is needed. Assembled line-by-line (single-quoted
// entries) so fenced-code backticks need no escaping.
const RICH = [
  '# Weeknight dinner',
  '',
  'A **quick** and _easy_ recipe, with a [link to the source](https://example.com).',
  '',
  '## Ingredients',
  '',
  '- 200g pasta',
  '- 2 cloves garlic',
  '- Olive oil',
  '',
  '## Steps',
  '',
  '1. Boil the pasta until al dente.',
  '2. Gently sauté the garlic.',
  '',
  'Season with `salt` to taste, or call `cook()` inline.',
  '',
  '```js',
  'const dinner = cook({ pasta: true, garlic: 2 });',
  '```',
  '',
  '> Tip: reserve a cup of pasta water before draining.',
  '',
  '| Ingredient | Quantity |',
  '| ---------- | -------- |',
  '| Pasta      | 200g     |',
  '| Garlic     | 2 cloves |',
].join('\n');

const meta = {
  title: 'Primitives/Markdown',
  component: Markdown,
  args: {
    text: RICH,
  },
  argTypes: {
    text: { control: 'text' },
    sanitizedHtml: { control: 'boolean' },
    scale: { control: 'inline-radio', options: ['note', 'doc'] },
    class: { control: 'text' },
  },
} satisfies Meta<typeof Markdown>;

export default meta;
type Story = StoryObj<typeof meta>;

// Live playground: edit the markdown source in the Controls panel.
export const Playground: Story = {};

// Rich content: headings, list, ordered list, inline + fenced code, blockquote,
// table, and a link.
export const RichContent: Story = { args: { text: RICH } };

// Document proportions — what a library page body renders at, against the note
// scale `RichContent` shows directly above it. Same fixture on purpose: the two
// stories side by side are the Chromatic baseline for the `scale` prop, and
// `RICH` already carries headings, both list kinds and a table, which is every
// rule the doc scale overrides.
export const DocumentScale: Story = { args: { text: RICH, scale: 'doc' } };

// A short, single-paragraph fragment.
export const Simple: Story = {
  args: { text: 'Just a **short** paragraph with a bit of `code` and _emphasis_.' },
};

// A jar profile with its dimensions labelled — the drawing the library was given
// this capability for (#1376). `sanitizedHtml` is what makes the inline SVG an
// element instead of visible markup source; turn it off in the Controls panel
// and the same input reverts to the escaped text every other caller gets.
const DIAGRAM = [
  'A 1-litre Kilner, measured cold.',
  '',
  '<svg viewBox="0 0 120 90" width="240">',
  '  <rect x="30" y="20" width="60" height="60" rx="6" fill="none" stroke="currentColor" stroke-width="2" />',
  '  <line x1="30" y1="35" x2="90" y2="35" stroke="currentColor" stroke-width="1" stroke-dasharray="4 3" />',
  '  <text x="60" y="14" text-anchor="middle" font-size="9">95 mm</text>',
  '  <text x="60" y="55" text-anchor="middle" font-size="9">fill line</text>',
  '</svg>',
  '',
  'Headroom above the fill line is **two fingers**.',
].join('\n');

export const SanitizedDiagram: Story = {
  args: { text: DIAGRAM, sanitizedHtml: true },
};
