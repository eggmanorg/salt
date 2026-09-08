// spec: ui-spec-v02.md §6 v0.2.3
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import Textarea from '../src/primitives/Textarea/Textarea.svelte';

afterEach(() => cleanup());

describe('Textarea', () => {
  describe('renders with minimum required props', () => {
    it('renders a labeled textarea', () => {
      render(Textarea, { props: { label: 'Notes' } });
      expect(screen.getByLabelText('Notes')).toBeInTheDocument();
    });

    it('renders the textarea element', () => {
      render(Textarea, { props: { label: 'Notes' } });
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });
  });

  describe('props contract', () => {
    it('applies size class to frame', () => {
      const { container } = render(Textarea, { props: { label: 'x', size: 'lg' } });
      expect(container.querySelector('.text-base')).toBeInTheDocument();
    });

    // `salt-input--error`, matching TextField: since #1305 that one class
    // carries both the destructive border and the retinted focus ring, so the
    // two frames cannot drift on what "errored" looks like.
    it('applies the error frame treatment when error is set', () => {
      const { container } = render(Textarea, {
        props: { label: 'x', error: 'Required' },
      });
      expect(container.querySelector('.salt-input--error')).toBeInTheDocument();
    });

    it('applies disabled opacity when disabled', () => {
      const { container } = render(Textarea, { props: { label: 'x', disabled: true } });
      expect(container.querySelector('.opacity-50')).toBeInTheDocument();
    });

    it('sets rows attribute', () => {
      render(Textarea, { props: { label: 'x', rows: 5 } });
      expect(screen.getByRole('textbox')).toHaveAttribute('rows', '5');
    });

    it('sets maxlength attribute', () => {
      render(Textarea, { props: { label: 'x', maxLength: 200 } });
      expect(screen.getByRole('textbox')).toHaveAttribute('maxlength', '200');
    });

    it('renders error element with role="alert"', () => {
      render(Textarea, { props: { label: 'x', error: 'Too short' } });
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('focus ring is on frame, not on raw textarea', () => {
      const { container } = render(Textarea, { props: { label: 'x' } });
      const frame = container.querySelector('.salt-focus-ring-within');
      expect(frame).toBeInTheDocument();
      expect(frame?.tagName).not.toBe('TEXTAREA');
    });

    it('no type prop (textarea does not accept type)', () => {
      render(Textarea, { props: { label: 'x' } });
      const textarea = screen.getByRole('textbox');
      expect(textarea.tagName).toBe('TEXTAREA');
    });
  });

  describe('events contract', () => {
    it('calls onValueChange on input', async () => {
      const onValueChange = vi.fn();
      render(Textarea, { props: { label: 'x', onValueChange } });
      await userEvent.type(screen.getByLabelText('x'), 'hello');
      expect(onValueChange).toHaveBeenCalledWith('hello');
    });

    it('calls autoresize handler on input without throwing', async () => {
      // jsdom does not compute scrollHeight, but autoresize must not throw
      render(Textarea, { props: { label: 'x', autoresize: true } });
      await expect(userEvent.type(screen.getByLabelText('x'), 'content')).resolves.not.toThrow();
    });
  });

  describe('keyboard interaction', () => {
    it('receives focus via Tab', async () => {
      render(Textarea, { props: { label: 'x' } });
      await userEvent.tab();
      expect(screen.getByLabelText('x')).toHaveFocus();
    });
  });

  describe('accessibility', () => {
    it('has no axe violations', async () => {
      const { container } = render(Textarea, { props: { label: 'Comments' } });
      expect(await axe(container)).toHaveNoViolations();
    });

    it('sets aria-required when required', () => {
      render(Textarea, { props: { label: 'x', required: true } });
      expect(screen.getByLabelText('x')).toHaveAttribute('aria-required', 'true');
    });

    it('sets native required when required', () => {
      render(Textarea, { props: { label: 'x', required: true } });
      expect(screen.getByLabelText('x')).toBeRequired();
    });

    it('sets aria-invalid when error is present', () => {
      render(Textarea, { props: { label: 'x', error: 'Too short' } });
      expect(screen.getByLabelText('x')).toHaveAttribute('aria-invalid', 'true');
    });

    it('error id is prepended to aria-describedby', () => {
      render(Textarea, {
        props: { label: 'x', error: 'Err', description: 'Desc' },
      });
      const textarea = screen.getByLabelText('x');
      const ids = (textarea.getAttribute('aria-describedby') ?? '').split(' ');
      const errorEl = screen.getByRole('alert');
      const descEl = screen.getByText('Desc');
      expect(ids[0]).toBe(errorEl.id);
      expect(ids[1]).toBe(descEl.id);
    });
  });

  describe('controlled vs uncontrolled', () => {
    it('uses defaultValue when uncontrolled', () => {
      render(Textarea, { props: { label: 'x', defaultValue: 'initial' } });
      expect(screen.getByLabelText('x')).toHaveValue('initial');
    });

    it('reflects provided value', () => {
      render(Textarea, { props: { label: 'x', value: 'controlled' } });
      expect(screen.getByLabelText('x')).toHaveValue('controlled');
    });

    it('fires onValueChange on input', async () => {
      const onValueChange = vi.fn();
      render(Textarea, { props: { label: 'x', onValueChange } });
      await userEvent.type(screen.getByLabelText('x'), 'a');
      expect(onValueChange).toHaveBeenCalledWith('a');
    });
  });

  // SPEC §8.3 "Element handle": optional, and inert when unbound.
  describe('element handle', () => {
    it('renders and autoresizes normally when element is not bound', () => {
      render(Textarea, { props: { label: 'x', autoresize: true, defaultValue: 'a\nb\nc' } });
      const textarea = screen.getByLabelText('x');
      expect(textarea).toHaveValue('a\nb\nc');
      expect(textarea.style.height).not.toBe('');
    });

    it('a direct setRangeText edit reaches onValueChange once an input event is dispatched', async () => {
      const onValueChange = vi.fn();
      render(Textarea, { props: { label: 'x', value: 'hello', onValueChange } });
      const textarea = screen.getByLabelText('x') as HTMLTextAreaElement;

      // The documented consumer contract: mutate the node, then dispatch, since
      // setRangeText fires no input event of its own.
      textarea.setRangeText('**hello**', 0, 5, 'end');
      expect(onValueChange).not.toHaveBeenCalled();

      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      expect(onValueChange).toHaveBeenCalledWith('**hello**');
    });
  });
});
