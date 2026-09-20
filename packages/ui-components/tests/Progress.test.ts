// spec: ui-spec-v02.md §6 v0.2.3
// Note: "events contract" and "keyboard interaction" blocks are omitted — Progress is
// non-interactive (consumer-driven value) and has no keyboard surface or event callbacks.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import { axe } from 'vitest-axe';
import Progress from '../src/primitives/Progress/Progress.svelte';

afterEach(() => cleanup());

describe('Progress', () => {
  describe('renders with minimum required props', () => {
    it('renders a progressbar', () => {
      render(Progress);
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('props contract', () => {
    it('sets aria-valuenow when value is provided', () => {
      render(Progress, { props: { value: 50 } });
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    });

    it('omits aria-valuenow when value is undefined (indeterminate)', () => {
      render(Progress);
      expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    });

    it('clamps value below 0 to 0', () => {
      render(Progress, { props: { value: -10 } });
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    });

    it('clamps value above max to max', () => {
      render(Progress, { props: { value: 150, max: 100 } });
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    });

    it('sets aria-valuemax from max prop', () => {
      render(Progress, { props: { max: 200 } });
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '200');
    });

    it('sets aria-label when ariaLabel is provided', () => {
      render(Progress, { props: { ariaLabel: 'Upload progress', value: 40 } });
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', 'Upload progress');
    });

    it('sets aria-live="polite" by default', () => {
      render(Progress, { props: { value: 50 } });
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-live', 'polite');
    });

    it('omits aria-live when announce="off"', () => {
      render(Progress, { props: { value: 50, announce: 'off' } });
      expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-live');
    });

    it('merges class prop', () => {
      render(Progress, { props: { class: 'custom-class' } });
      expect(screen.getByRole('progressbar')).toHaveClass('custom-class');
    });

    it('applies determinate transform style when value is set', () => {
      render(Progress, { props: { value: 75 } });
      const indicator = screen.getByRole('progressbar').firstElementChild as HTMLElement;
      expect(indicator.style.transform).toBe('translateX(-25%)');
    });

    it('does not apply inline style in indeterminate mode', () => {
      render(Progress);
      const indicator = screen.getByRole('progressbar').firstElementChild as HTMLElement;
      expect(indicator.style.transform).toBe('');
    });
  });

  describe('controlled vs uncontrolled', () => {
    it('starts indeterminate when no value or defaultValue given', () => {
      render(Progress);
      expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    });

    it('uses defaultValue when uncontrolled', () => {
      render(Progress, { props: { defaultValue: 60 } });
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
    });

    it('uses value when controlled, ignoring defaultValue', () => {
      render(Progress, { props: { value: 30, defaultValue: 60 } });
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
    });
  });

  // ui-spec-v16 §1 — the presentational mode. Every assertion here is about what
  // the mode does NOT emit; the geometry assertions compare against the default
  // mode's own output rather than a literal, so the two modes cannot drift apart
  // without this file going red (v16 §1.6).
  describe('presentational mode (ui-spec-v16 §1)', () => {
    it('renders no progressbar role', () => {
      render(Progress, { props: { value: 50, presentational: true } });
      expect(screen.queryByRole('progressbar')).toBeNull();
    });

    it('renders no aria-live, even though announce defaults to polite', () => {
      const { container } = render(Progress, { props: { value: 50, presentational: true } });
      expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
    });

    it('renders no aria-live when announce is explicitly polite', () => {
      const { container } = render(Progress, {
        props: { value: 50, presentational: true, announce: 'polite' },
      });
      expect(container.querySelectorAll('[aria-live]')).toHaveLength(0);
    });

    it('renders no aria-valuenow and no other aria-value*', () => {
      const { container } = render(Progress, { props: { value: 50, presentational: true } });
      expect(container.querySelectorAll('[aria-valuenow]')).toHaveLength(0);
      expect(container.querySelectorAll('[aria-valuemin], [aria-valuemax]')).toHaveLength(0);
    });

    it('ignores ariaLabel rather than leaving a label on a hidden node', () => {
      const { container } = render(Progress, {
        props: { value: 50, presentational: true, ariaLabel: 'Upload progress' },
      });
      expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);
    });

    it('renders spans only — no div, so it is valid inside a button', () => {
      const { container } = render(Progress, { props: { value: 50, presentational: true } });
      expect(container.querySelectorAll('div')).toHaveLength(0);
      expect(container.querySelectorAll('span')).toHaveLength(2);
    });

    it('hides the bar from the accessibility tree', () => {
      const { container } = render(Progress, { props: { value: 50, presentational: true } });
      expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    });

    it('applies the same determinate transform as the default mode', () => {
      const { container } = render(Progress, { props: { value: 75, presentational: true } });
      const indicator = container.firstElementChild!.firstElementChild as HTMLElement;
      cleanup();
      render(Progress, { props: { value: 75 } });
      const defaultIndicator = screen.getByRole('progressbar').firstElementChild as HTMLElement;
      expect(indicator.style.transform).toBe(defaultIndicator.style.transform);
      expect(indicator.style.transform).toBe('translateX(-25%)');
    });

    it('clamps exactly as the default mode does', () => {
      const { container } = render(Progress, {
        props: { value: 150, max: 100, presentational: true },
      });
      const indicator = container.firstElementChild!.firstElementChild as HTMLElement;
      expect(indicator.style.transform).toBe('translateX(-0%)');
    });

    it('carries the same root and indicator classes as the default mode', () => {
      const { container } = render(Progress, { props: { value: 50, presentational: true } });
      const root = container.firstElementChild as HTMLElement;
      const indicator = root.firstElementChild as HTMLElement;
      cleanup();
      render(Progress, { props: { value: 50 } });
      const defaultRoot = screen.getByRole('progressbar');
      const defaultIndicator = defaultRoot.firstElementChild as HTMLElement;
      for (const cls of defaultRoot.className.split(/\s+/).filter(Boolean)) {
        expect(root).toHaveClass(cls);
      }
      for (const cls of defaultIndicator.className.split(/\s+/).filter(Boolean)) {
        expect(indicator).toHaveClass(cls);
      }
    });

    it('stays indeterminate with no value, without an inline style', () => {
      const { container } = render(Progress, { props: { presentational: true } });
      const indicator = container.firstElementChild!.firstElementChild as HTMLElement;
      expect(indicator.style.transform).toBe('');
      expect(indicator.className).toContain('animate-[salt-progress-indeterminate');
    });

    it('merges the class prop onto the root', () => {
      const { container } = render(Progress, {
        props: { value: 50, presentational: true, class: 'custom-class' },
      });
      expect(container.firstElementChild).toHaveClass('custom-class');
    });

    it('has no axe violations in determinate mode', async () => {
      const { container } = render(Progress, { props: { value: 50, presentational: true } });
      expect(await axe(container)).toHaveNoViolations();
    });

    it('has no axe violations in indeterminate mode', async () => {
      const { container } = render(Progress, { props: { presentational: true } });
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  describe('accessibility', () => {
    it('has no axe violations in indeterminate mode', async () => {
      const { container } = render(Progress, { props: { ariaLabel: 'Loading' } });
      expect(await axe(container)).toHaveNoViolations();
    });

    it('has no axe violations in determinate mode', async () => {
      const { container } = render(Progress, {
        props: { value: 50, ariaLabel: 'Upload progress' },
      });
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
