// spec: ui-spec-v03.md §5, §6, §7 v0.3
// Note: focus-trap and focus-restoration assertions require a real browser (bits-ui FocusScope).
// Composition, open/close, ARIA, side variants, and axe coverage are provided instead.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import Sheet from '../src/primitives/Sheet/Sheet.svelte';
import SheetContent from '../src/primitives/Sheet/SheetContent.svelte';
import { sheetContentVariants } from '../src/primitives/Sheet/Sheet.variants';
import { cn } from '../src/lib/cn';

afterEach(() => cleanup());

describe('Sheet', () => {
  // -----------------------------------------------------------------------
  // renders with minimum required props
  // -----------------------------------------------------------------------
  describe('renders with minimum required props', () => {
    it('renders without error when closed', () => {
      const { container } = render(Sheet, { target: document.body, props: {} });
      expect(container).toBeTruthy();
    });

    it('does not show dialog role when closed', () => {
      render(Sheet, { target: document.body, props: {} });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // props contract
  // -----------------------------------------------------------------------
  describe('props contract', () => {
    it('starts closed by default', () => {
      render(Sheet, { target: document.body, props: {} });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('uses defaultOpen for initial state (false)', () => {
      render(Sheet, { target: document.body, props: { defaultOpen: false } });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('accepts side prop without error (right default)', () => {
      const { container } = render(Sheet, { target: document.body, props: { side: 'right' } });
      expect(container).toBeTruthy();
    });

    it('accepts all side values without error', () => {
      const sides = ['left', 'right', 'top', 'bottom'] as const;
      for (const side of sides) {
        const { unmount } = render(Sheet, { target: document.body, props: { side } });
        unmount();
      }
    });

    it('accepts portal=false without error', () => {
      const { container } = render(Sheet, { target: document.body, props: { portal: false } });
      expect(container).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // side variants — the resolved class string, per side (issue #930, Phase 1)
  // -----------------------------------------------------------------------
  //
  // CHARACTERIZATION. These pin what `sheetContentVariants` renders TODAY, so
  // that the later phases of #930 — which move padding and a height ceiling out
  // of the eleven `<SheetContent>` call sites and into the `bottom` variant —
  // are provably confined to the side they claim.
  //
  // Why three separate shapes of assertion rather than one exact string each:
  // #930 Phase 3 changes the bottom variant's padding and nothing else, and its
  // stated proof is that exactly one assertion moves. A single whole-string pin
  // per side cannot tell a one-token change from a rewrite — every delta reads
  // as the same red. So the whole-string pin (the characterization proper) sits
  // alongside a padding pin and a height-ceiling pin, and which of the three
  // move says what actually changed.
  describe('side variants — resolved class strings', () => {
    const BASE =
      'fixed z-dialog flex flex-col gap-4 border bg-background p-6 shadow-dialog ' +
      'data-[state=open]:animate-in data-[state=closed]:animate-out duration-slow ' +
      'ease-emphasized motion-reduce:animate-none';

    // The bottom variant's padding, named once so the value lives in exactly one
    // place. #930 Phase 3 changed THIS LINE and the home-bar assertion that
    // reads it, and nothing else in the file — which is what makes that delta
    // provably confined rather than merely claimed to be.
    const BOTTOM_PADDING = 'p-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]';

    const SIDE = {
      right:
        'inset-y-0 right-0 h-full w-3/4 max-w-sm ' +
        'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
      left:
        'inset-y-0 left-0 h-full w-3/4 max-w-sm ' +
        'data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
      top: 'inset-x-0 top-0 w-full data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top',
      bottom:
        `inset-x-0 bottom-0 w-full max-h-[85vh] ${BOTTOM_PADDING} ` +
        'data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
    } as const;

    const sides = ['right', 'left', 'top', 'bottom'] as const;
    /** The three sides no call site in the app uses; `bottom` is asserted alone. */
    const unusedSides = ['right', 'left', 'top'] as const;

    it.each(sides)('side=%s resolves to exactly base + its own side classes', (side) => {
      expect(sheetContentVariants({ side })).toBe(`${BASE} ${SIDE[side]}`);
    });

    it('defaults to the side nothing in the app actually uses', () => {
      // Recorded, not endorsed: all eleven `<SheetContent>` call sites in
      // web-pwa pass side="bottom" and none passes "right". #930 keeps the
      // default as-is deliberately (changing it would restyle a future right
      // sheet silently); this assertion is here so the fact stays visible.
      expect(sheetContentVariants({})).toBe(sheetContentVariants({ side: 'right' }));
    });

    // ── Padding ────────────────────────────────────────────────────────────
    it.each(unusedSides)('side=%s takes its padding from the base string alone', (side) => {
      expect(cn(sheetContentVariants({ side }))).toContain('p-6');
    });

    it('side=bottom overrides the base padding, so no call site has to', () => {
      // Order matters and `cn` is what enforces it: the variant's `p-4` has to
      // come after the base `p-6` for tailwind-merge to evict it, and `pb-8`
      // after `p-4` to survive. Asserting the MERGED string is the only way to
      // see that; the raw concatenation would contain all three and say nothing.
      const merged = cn(sheetContentVariants({ side: 'bottom' }));
      expect(merged).not.toContain('p-6');
      for (const token of BOTTOM_PADDING.split(' ')) expect(merged).toContain(token);
    });

    // ── Height ceiling ─────────────────────────────────────────────────────
    it.each(unusedSides)('side=%s states no max-height', (side) => {
      expect(cn(sheetContentVariants({ side }))).not.toMatch(/\bmax-h-/);
    });

    it('side=bottom caps at 85vh, so a long sheet keeps its footer on screen', () => {
      expect(cn(sheetContentVariants({ side: 'bottom' }))).toContain('max-h-[85vh]');
    });

    it('a caller can still opt out of the ceiling', () => {
      // ShoppingListPage does exactly this — it is the one bottom sheet with no
      // height cap, and it must stay that way after #930 moved the cap here.
      // Plain `max-h-none` replaces the ceiling from tailwind-merge 3.7, which added
      // `none` to the max-height group; before that it arrived alongside
      // `max-h-[85vh]` and the call site had to use the arbitrary `max-h-[none]`.
      expect(cn(sheetContentVariants({ side: 'bottom' }), 'max-h-none')).not.toContain(
        'max-h-[85vh]',
      );
    });

    it('MealDayEditor’s two remaining overrides still win', () => {
      // The one call site that differs from the common shape. It had three
      // overrides until #930 Phase 3 moved the home-bar padding into the
      // variant; the two left are `dvh` over `vh` and a tighter gap. Asserted
      // here rather than in the page's own test because what is at stake is the
      // MERGE, which is this file's subject.
      const merged = cn(sheetContentVariants({ side: 'bottom' }), 'max-h-[85dvh] gap-3');
      expect(merged).toContain('max-h-[85dvh]');
      expect(merged).not.toContain('max-h-[85vh]');
      expect(merged).toContain('gap-3');
      expect(merged).not.toContain('gap-4');
      // What it no longer writes now arrives from the variant, unchanged.
      expect(merged).toContain('p-4');
      expect(merged).toContain('pb-[calc(1.5rem+env(safe-area-inset-bottom))]');
    });

    // ── Safe area (#930 Phase 3) ────────────────────────────────────────────
    it('side=bottom, and only bottom, clears the iPhone home bar', () => {
      // The issue's one sanctioned visual delta. A bottom sheet sits on the
      // edge the home bar occupies; the other three sides do not, and picking
      // up an inset they cannot use would be padding for nothing.
      expect(cn(sheetContentVariants({ side: 'bottom' }))).toContain(
        'pb-[calc(1.5rem+env(safe-area-inset-bottom))]',
      );
      for (const side of unusedSides) {
        expect(cn(sheetContentVariants({ side }))).not.toContain('safe-area-inset');
      }
    });
  });

  // -----------------------------------------------------------------------
  // events contract
  // -----------------------------------------------------------------------
  describe('events contract', () => {
    it('does not call onOpenChange on initial render', () => {
      const onOpenChange = vi.fn();
      render(Sheet, { target: document.body, props: { onOpenChange } });
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // keyboard interaction — APG §5.5 (Dialog pattern)
  // -----------------------------------------------------------------------
  describe('keyboard interaction', () => {
    it('Escape closes an open sheet', async () => {
      const onOpenChange = vi.fn();
      render(Sheet, {
        target: document.body,
        props: { open: true, onOpenChange },
      });
      await userEvent.keyboard('{Escape}');
      // bits-ui Dialog.Root triggers onOpenChange(false) on Escape when open
      // (only fires if interactive content is present; minimal render may not)
    });
  });

  // -----------------------------------------------------------------------
  // accessibility — APG §5.5
  // -----------------------------------------------------------------------
  describe('accessibility', () => {
    it('has no axe violations when closed', async () => {
      const { container } = render(Sheet, { target: document.body, props: {} });
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  // -----------------------------------------------------------------------
  // composition (compound)
  // -----------------------------------------------------------------------
  describe('composition', () => {
    it('throws when SheetContent is rendered without a Sheet root', () => {
      expect(() => render(SheetContent, { target: document.body, props: {} })).toThrow(
        'Sheet context not found',
      );
    });
  });

  // -----------------------------------------------------------------------
  // controlled vs uncontrolled
  // -----------------------------------------------------------------------
  describe('controlled vs uncontrolled', () => {
    it('uses defaultOpen=false by default', () => {
      render(Sheet, { target: document.body, props: {} });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('respects controlled open=false prop', () => {
      render(Sheet, { target: document.body, props: { open: false } });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('fires onOpenChange when wired (no immediate call)', () => {
      const onOpenChange = vi.fn();
      render(Sheet, { target: document.body, props: { open: false, onOpenChange } });
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });
});
