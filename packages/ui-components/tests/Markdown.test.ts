// spec: ui-spec-v04.md §12
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import Markdown from '../src/primitives/Markdown/Markdown.svelte';

afterEach(() => cleanup());

describe('Markdown', () => {
  describe('renders with minimum required props', () => {
    it('renders plain text', () => {
      const { container } = render(Markdown, { props: { text: 'Just a note.' } });
      expect(container.textContent).toContain('Just a note.');
    });

    it('renders Markdown syntax as elements, not literal characters', () => {
      const { container } = render(Markdown, {
        props: { text: '**bold** and *italic*\n\n- one\n- two' },
      });
      expect(container.querySelector('strong')?.textContent).toBe('bold');
      expect(container.querySelector('em')?.textContent).toBe('italic');
      expect(container.querySelectorAll('li')).toHaveLength(2);
      expect(container.textContent).not.toContain('**');
    });
  });

  describe('props contract', () => {
    it('merges the class prop onto the salt-md wrapper', () => {
      const { container } = render(Markdown, {
        props: { text: 'x', class: 'text-sm text-muted-foreground' },
      });
      const wrapper = container.querySelector('.salt-md');
      expect(wrapper).toHaveClass('text-sm', 'text-muted-foreground');
    });
  });

  // §12.3.2. What these can and cannot prove: jsdom does not compute Svelte's
  // scoped styles across a component boundary, so no assertion here sees a
  // font-size. What they DO pin is the contract the CSS hangs off — the doc
  // scale is reached by one token on the one wrapper div, the default is the
  // note scale, and `class` still merges alongside. If the token stops being
  // applied, every doc-scale rule in `<style>` silently stops matching, and
  // these are what go red.
  describe('scale', () => {
    it('leaves the wrapper at the note scale by default', () => {
      const { container } = render(Markdown, { props: { text: '# Heading' } });
      const wrapper = container.querySelector('.salt-md');
      expect(wrapper).not.toBeNull();
      expect(wrapper).not.toHaveClass('salt-md-doc');
    });

    it('leaves the wrapper at the note scale when asked for it explicitly', () => {
      const { container } = render(Markdown, { props: { text: '# Heading', scale: 'note' } });
      expect(container.querySelector('.salt-md')).not.toHaveClass('salt-md-doc');
    });

    it('puts the doc token on the salt-md wrapper itself, not a second element', () => {
      const { container } = render(Markdown, { props: { text: '# Heading', scale: 'doc' } });
      // Both classes on ONE div is what makes the doc rules win on specificity
      // rather than on source order — a descendant wrapper would not.
      expect(container.querySelectorAll('.salt-md-doc')).toHaveLength(1);
      expect(container.querySelector('.salt-md')).toHaveClass('salt-md-doc');
    });

    it('merges the class prop alongside the doc token', () => {
      const { container } = render(Markdown, {
        props: { text: 'x', scale: 'doc', class: 'min-h-24 cursor-text' },
      });
      const wrapper = container.querySelector('.salt-md');
      expect(wrapper).toHaveClass('salt-md', 'salt-md-doc', 'min-h-24', 'cursor-text');
    });

    it('renders the same markup at either scale', () => {
      // The prop is presentation only: it must not reach the parser. Same
      // source in, same elements out.
      const src = '# Title\n\nBody text.\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |';
      const note = render(Markdown, { props: { text: src } }).container;
      const doc = render(Markdown, { props: { text: src, scale: 'doc' } }).container;
      const shape = (el: HTMLElement): string =>
        [...el.querySelectorAll('.salt-md *')].map((n) => n.tagName).join(',');
      expect(shape(doc)).toBe(shape(note));
      expect(shape(note)).not.toBe('');
    });
  });

  // The whole point of `breaks` is that turning a plain-text field into a
  // Markdown-rendered one is a no-op for text already saved as line-per-thought
  // prose. These assert both halves of §12.3.1: lines stay lines, blank lines
  // stay paragraphs.
  describe('breaks', () => {
    it('folds a single newline into one paragraph when off (default)', () => {
      const { container } = render(Markdown, { props: { text: 'first line\nsecond line' } });
      expect(container.querySelectorAll('br')).toHaveLength(0);
      expect(container.querySelectorAll('p')).toHaveLength(1);
    });

    it('renders a single newline as a hard break when on', () => {
      const { container } = render(Markdown, {
        props: { text: 'first line\nsecond line', breaks: true },
      });
      expect(container.querySelectorAll('br')).toHaveLength(1);
      expect(container.querySelectorAll('p')).toHaveLength(1);
      expect(container.textContent).toContain('first line');
      expect(container.textContent).toContain('second line');
    });

    it('keeps a blank line as a paragraph break, not a hard break, when on', () => {
      const { container } = render(Markdown, {
        props: { text: 'first para\n\nsecond para', breaks: true },
      });
      expect(container.querySelectorAll('p')).toHaveLength(2);
      expect(container.querySelectorAll('br')).toHaveLength(0);
    });

    it('normalises CRLF so the hard break lands after the text', () => {
      const { container } = render(Markdown, {
        props: { text: 'first line\r\nsecond line', breaks: true },
      });
      expect(container.querySelectorAll('br')).toHaveLength(1);
      expect(container.textContent).toContain('second line');
    });

    it('leaves Markdown structure intact when on', () => {
      const { container } = render(Markdown, {
        props: { text: 'Watch out:\n- **salt** early\n- rest 10 min', breaks: true },
      });
      expect(container.querySelectorAll('li')).toHaveLength(2);
      expect(container.querySelector('strong')?.textContent).toBe('salt');
    });

    it('does not add stray characters to text with no newlines', () => {
      const { container } = render(Markdown, {
        props: { text: 'single line note', breaks: true },
      });
      expect(container.textContent?.trim()).toBe('single line note');
      expect(container.querySelectorAll('br')).toHaveLength(0);
    });
  });
});
