// spec: ui-spec-v13.md §8.32.6 v0.13.2
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { createRawSnippet } from 'svelte';
import ErrorState from '../src/primitives/ErrorState/ErrorState.svelte';

afterEach(() => cleanup());

function snippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe('ErrorState (ui-spec-v13 §8.32)', () => {
  describe('renders with no props at all', () => {
    // ListPage's default error rendering is a bare `<ErrorState />` (v0.4 §9),
    // so "no arguments" is the call that has to read correctly.
    it('renders the default title and no button', () => {
      render(ErrorState);
      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Something went wrong');
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('is an assertive alert region (§8.32.2)', () => {
      const { container } = render(ErrorState);
      expect(container.querySelector('[role="alert"]')).toBeInTheDocument();
    });

    it('labels the warning icon rather than hiding it (§8.32.2)', () => {
      render(ErrorState);
      expect(screen.getByLabelText('Error')).toBeInTheDocument();
    });
  });

  describe('retry (§8.32.3)', () => {
    it('onRetry renders a button labelled retryLabel, and clicking calls it', async () => {
      const onRetry = vi.fn();
      render(ErrorState, { props: { onRetry, retryLabel: 'Reload' } });
      await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(onRetry).toHaveBeenCalledOnce();
    });

    it('defaults the retry label to "Try again"', () => {
      render(ErrorState, { props: { onRetry: vi.fn() } });
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('actions replaces the retry button entirely, and onRetry is inert', () => {
      render(ErrorState, { props: { onRetry: vi.fn(), actions: snippet('Go back') } });
      expect(screen.getByText('Go back')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });
  });

  describe('props contract', () => {
    it('renders an overridden title and a description', () => {
      render(ErrorState, { props: { title: 'Could not load recipes', description: 'Offline.' } });
      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('Could not load recipes');
      expect(screen.getByText('Offline.')).toBeInTheDocument();
    });

    it('merges the class prop', () => {
      const { container } = render(ErrorState, { props: { class: 'extra-class' } });
      expect(container.firstElementChild).toHaveClass('extra-class');
    });
  });

  // §8.32.5. The passthrough exists so a migrating call site can keep the
  // `data-testid` its page's tests select on — `cook-mode-orphan` is the case
  // that asked for it.
  describe('attribute passthrough (§8.32.5)', () => {
    it('forwards a data-testid onto the panel', () => {
      const { container } = render(ErrorState, {
        props: { title: 'This recipe was deleted', 'data-testid': 'cook-mode-orphan' },
      });
      const panel = container.querySelector('[role="alert"]')!;
      expect(panel.getAttribute('data-testid')).toBe('cook-mode-orphan');
    });

    it('keeps role="alert" even when a caller passes one', () => {
      // `role` is Omit'ted from the passthrough type, so this cast is the only
      // way to attempt it — and it must still lose to the applied `alert`.
      const { container } = render(ErrorState, {
        props: { title: 'This recipe was deleted', role: 'status' } as never,
      });
      const panel = container.querySelector('[role]')!;
      expect(panel.getAttribute('role')).toBe('alert');
      expect(container.querySelector('[role="status"]')).toBeNull();
    });
  });

  describe('accessibility', () => {
    it('has no axe violations with no props', async () => {
      const { container } = render(ErrorState);
      expect(await axe(container)).toHaveNoViolations();
    });

    it('has no axe violations with a retry', async () => {
      const { container } = render(ErrorState, { props: { onRetry: vi.fn() } });
      expect(await axe(container)).toHaveNoViolations();
    });

    it('has no axe violations with actions', async () => {
      const { container } = render(ErrorState, { props: { actions: snippet('Go back') } });
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
