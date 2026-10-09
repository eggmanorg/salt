// spec: ui-spec-v04.md §12.7
/**
 * `Markdown`'s `blocks` prop — the hook a library surface draws its `salt-*`
 * fenced blocks through (issue #1663).
 *
 * The pins that matter beyond "it renders":
 *
 *  - WITHOUT `blocks`, a salt fence is an ordinary code block. That is what the
 *    chat and recipe notes get, and it is the whole of "only library surfaces".
 *  - WITH `sanitizedHtml`, the hook runs AFTER the sanitiser: the `language-*`
 *    class a fence carries survives sanitising, and a `<salt-block>` typed as
 *    raw HTML never reaches the renderer — the only block drawn is one made from
 *    a fence's text.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Markdown from '../src/primitives/Markdown/Markdown.svelte';
import { rehypeSaltBlocks, SALT_BLOCK_TAG } from '../src/primitives/Markdown/saltBlocks';
import SaltBlockProbe from './fixtures/SaltBlockProbe.svelte';

afterEach(() => cleanup());

const FENCE = '# Page\n\n```salt-callout\ntone: warning\nbody: hot\n```\n\nAfter.';

describe('Markdown blocks — off (the default)', () => {
  it('renders a salt fence as an ordinary code block', () => {
    const { container } = render(Markdown, { props: { text: FENCE, sanitizedHtml: true } });
    const code = container.querySelector('pre > code');
    expect(code).toHaveClass('language-salt-callout');
    expect(code?.textContent).toContain('tone: warning');
    expect(container.querySelector('[data-testid="salt-block"]')).toBeNull();
  });
});

describe.each([
  ['without sanitizedHtml', false],
  ['with sanitizedHtml', true],
])('Markdown blocks — on, %s', (_name, sanitizedHtml) => {
  it('hands the fence to the block renderer as kind and source, in place', () => {
    const { container } = render(Markdown, {
      props: { text: FENCE, sanitizedHtml, blocks: SaltBlockProbe },
    });
    const blocks = container.querySelectorAll('[data-testid="salt-block"]');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveAttribute('data-kind', 'callout');
    // The text between the fences, without the final newline.
    expect(blocks[0]!.textContent).toBe('tone: warning\nbody: hot');
    expect(container.querySelector('pre')).toBeNull();
    // In document order, between the Markdown around it.
    const order = [...container.querySelector('.salt-md')!.children].map((el) => el.tagName);
    expect(order).toEqual(['H1', 'DIV', 'P']);
  });

  it('leaves other code fences alone', () => {
    const { container } = render(Markdown, {
      props: { text: '```ts\nconst a = 1;\n```', sanitizedHtml, blocks: SaltBlockProbe },
    });
    expect(container.querySelector('pre > code')?.textContent).toContain('const a = 1;');
    expect(container.querySelector('[data-testid="salt-block"]')).toBeNull();
  });

  it('leaves a fence with no language alone', () => {
    const { container } = render(Markdown, {
      props: { text: '```\nplain text\n```', sanitizedHtml, blocks: SaltBlockProbe },
    });
    expect(container.querySelector('pre > code')?.textContent).toContain('plain text');
    expect(container.querySelector('[data-testid="salt-block"]')).toBeNull();
  });

  it('draws every block, each with its own kind', () => {
    const { container } = render(Markdown, {
      props: {
        text: '```salt-stats\na\n```\n\n```salt-cards\nb\n```',
        sanitizedHtml,
        blocks: SaltBlockProbe,
      },
    });
    const kinds = [...container.querySelectorAll('[data-testid="salt-block"]')].map((el) =>
      el.getAttribute('data-kind'),
    );
    expect(kinds).toEqual(['stats', 'cards']);
  });
});

describe('Markdown blocks — no raw-HTML route', () => {
  it('does not draw a <salt-block> typed as raw HTML', () => {
    const { container } = render(Markdown, {
      props: {
        text: '<salt-block kind="callout" source="body: injected"></salt-block>\n\nText.',
        sanitizedHtml: true,
        blocks: SaltBlockProbe,
      },
    });
    expect(container.querySelector('[data-testid="salt-block"]')).toBeNull();
    expect(container.querySelector('salt-block')).toBeNull();
  });

  it('does not draw one when raw HTML is inert either', () => {
    const { container } = render(Markdown, {
      props: {
        text: '<salt-block kind="callout" source="body: injected"></salt-block>',
        blocks: SaltBlockProbe,
      },
    });
    expect(container.querySelector('[data-testid="salt-block"]')).toBeNull();
  });
});

describe('rehypeSaltBlocks — the tree walk itself', () => {
  const run = (tree: unknown) => {
    rehypeSaltBlocks()(tree);
    return tree as { children: { tagName?: string; properties?: Record<string, unknown> }[] };
  };
  const saltCode = (children: unknown[]) => ({
    type: 'element',
    tagName: 'pre',
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-salt-stats'] },
        children,
      },
    ],
  });

  it('leaves a pre that does not hold a code element alone', () => {
    const pre = { type: 'element', tagName: 'pre', children: [{ type: 'text', value: 'x' }] };
    expect(run({ type: 'root', children: [pre] }).children[0]).toBe(pre);
  });

  it('reads a text node without a value, or an element without children, as empty', () => {
    const tree = run({
      type: 'root',
      children: [saltCode([{ type: 'text' }, { type: 'element', tagName: 'span' }])],
    });
    expect(tree.children[0]?.tagName).toBe(SALT_BLOCK_TAG);
    expect(tree.children[0]?.properties).toEqual({ kind: 'stats', source: '' });
  });
});
