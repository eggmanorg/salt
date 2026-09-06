// spec: ui-spec-v02.md §3.3 v0.2.3
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as colors from '../src/tokens/colors';
import * as radius from '../src/tokens/radius';
import * as motion from '../src/tokens/motion';
import * as elevation from '../src/tokens/elevation';
import * as zIndex from '../src/tokens/z-index';
import * as tokens from '../src/tokens';
import * as typography from '../src/tokens/typography';

const __dirname = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(__dirname, '../src/salt.css'), 'utf8');

describe('salt.css design-system entry', () => {
  describe('imports & structure', () => {
    it('imports tailwindcss and tw-animate-css', () => {
      expect(css).toMatch(/@import\s+['"]tailwindcss['"]/);
      expect(css).toMatch(/@import\s+['"]tw-animate-css['"]/);
    });

    it('declares the dark custom-variant', () => {
      expect(css).toMatch(/@custom-variant\s+dark\s+\(&:where\(\.dark, \.dark \*\)\)/);
    });

    it('declares an @source so v4 scans the ui-components source', () => {
      expect(css).toMatch(/@source\s+"\.\/\*\*\/\*\.\{ts,svelte\}"/);
    });
  });

  describe('@theme tokens', () => {
    it('defines semantic --color-* tokens with no <alpha-value>', () => {
      expect(css).toMatch(/--color-background:\s*hsl\(var\(--salt-background\)\)/);
      expect(css).toMatch(/--color-primary:\s*hsl\(var\(--salt-primary\)\)/);
      expect(css).toMatch(/--color-primary-foreground:\s*hsl\(var\(--salt-primary-foreground\)\)/);
      expect(css).toMatch(/--color-icon-tile:\s*hsl\(var\(--salt-icon-tile\)\)/);
      // The tinted surface a removed thing sits on, symmetric with the sage
      // secondary-container an added one gets (#825).
      expect(css).toMatch(
        /--color-destructive-container:\s*hsl\(var\(--salt-destructive-container\)\)/,
      );
      expect(css).toMatch(
        /--color-destructive-container-foreground:\s*hsl\(var\(--salt-on-destructive-container\)\)/,
      );
      // The three tints (#878): one pale ground per hue for a set of peers that
      // need telling apart — the recipe page's fact chips and its cook-shape
      // ribbon. Sage deliberately ALIASES the secondary-container pair rather
      // than plumbing design.md's near-identical `secondary-fixed`, so the
      // assertion below is what stops someone "tidying" that into a fourth
      // primitive one hex away from an existing one.
      expect(css).toMatch(/--color-primary-tint:\s*hsl\(var\(--salt-primary-fixed\)\)/);
      expect(css).toMatch(
        /--color-primary-tint-foreground:\s*hsl\(var\(--salt-on-primary-fixed-variant\)\)/,
      );
      expect(css).toMatch(/--color-secondary-tint:\s*hsl\(var\(--salt-secondary-container\)\)/);
      expect(css).toMatch(
        /--color-secondary-tint-foreground:\s*hsl\(var\(--salt-on-secondary-container\)\)/,
      );
      expect(css).toMatch(/--color-tertiary-tint:\s*hsl\(var\(--salt-tertiary-fixed\)\)/);
      expect(css).toMatch(
        /--color-tertiary-tint-foreground:\s*hsl\(var\(--salt-on-tertiary-fixed-variant\)\)/,
      );
      // v4 derives opacity via color-mix, so no color token carries the v3
      // `/ <alpha-value>` placeholder (a bare mention in a comment is fine).
      expect(css).not.toMatch(/hsl\(var\(--salt-[a-z-]+\)\s*\/\s*<alpha-value>\)/);
    });

    it('defines the radius scale incl. the DEFAULT (--radius) and full tokens', () => {
      expect(css).toMatch(/--radius-sm:\s*var\(--salt-radius-sm\)/);
      expect(css).toMatch(/--radius:\s*var\(--salt-radius-default\)/);
      expect(css).toMatch(/--radius-lg:\s*var\(--salt-radius-lg\)/);
      expect(css).toMatch(/--radius-full:\s*9999px/);
    });

    it('defines font-size tokens with line-height / letter-spacing modifiers', () => {
      expect(css).toMatch(/--text-display:\s*48px/);
      expect(css).toMatch(/--text-display--line-height:\s*1\.1/);
      expect(css).toMatch(/--text-display--letter-spacing:\s*-0\.02em/);
      expect(css).toMatch(/--text-label-caps:\s*12px/);
    });

    it('defines motion + elevation tokens', () => {
      expect(css).toMatch(/--duration-fast:\s*120ms/);
      expect(css).toMatch(/--ease-standard:\s*cubic-bezier\(0\.2, 0, 0, 1\)/);
      expect(css).toMatch(/--shadow-ambient:\s*0 2px 12px 0 hsl\(var\(--salt-primary\) \/ 0\.05\)/);
    });

    it('pins the default-palette colours consolidated from the apps', () => {
      expect(css).toMatch(/--color-amber-500:\s*#f59e0b/);
      expect(css).toMatch(/--color-red-600:\s*#dc2626/);
      expect(css).toMatch(/--color-orange-500:\s*#f97316/);
    });
  });

  describe('--salt-* primitives', () => {
    it('defines --salt-background in :root and overrides it in .dark', () => {
      const rootBg = css.match(/:root\s*\{[\s\S]*?--salt-background:\s*([^;]+);/)?.[1];
      const darkBg = css.match(/\.dark\s*\{[\s\S]*?--salt-background:\s*([^;]+);/)?.[1];
      expect(rootBg).toBeDefined();
      expect(darkBg).toBeDefined();
      expect(rootBg).not.toBe(darkBg);
    });

    it('keeps /* #rrggbb */ provenance comments on salt colour tokens', () => {
      expect(css).toMatch(/--salt-primary:\s*[^;]+;\s*\/\*\s*#35606e/);
      expect(css).toMatch(/--salt-background:\s*[^;]+;\s*\/\*\s*#f8fafa/);
    });

    it('pins the destructive container pair to design.md error-container (#825)', () => {
      // The provenance comments are what check-theme.ts diffs against design.md,
      // so the hexes are the assertion — nothing new was decided here, the
      // long-standing error-container values were plumbed through.
      expect(css).toMatch(/--salt-destructive-container:\s*6 100% 92%;\s*\/\*\s*#ffdad6/);
      expect(css).toMatch(/--salt-on-destructive-container:\s*356 100% 29%;\s*\/\*\s*#93000a/);
    });

    it('pins the two new tint primitives to design.md `*-fixed` (#878)', () => {
      // Same reasoning as the destructive pair above: the provenance comments
      // are what check-theme.ts diffs against design.md, so the hexes are the
      // assertion. Nothing was newly decided — these are design.md's
      // long-standing primary-fixed / on-primary-fixed-variant / tertiary-fixed.
      expect(css).toMatch(/--salt-primary-fixed:\s*197 49% 88%;\s*\/\*\s*#d0e6ef/);
      expect(css).toMatch(/--salt-on-primary-fixed-variant:\s*196 20% 26%;\s*\/\*\s*#364a51/);
      expect(css).toMatch(/--salt-tertiary-fixed:\s*11 100% 91%;\s*\/\*\s*#ffdad2/);
    });

    it('mirrors the tint primitives into the .dark block (#878)', () => {
      // The `*-fixed` roles do not flip with the theme, so these are the light
      // values verbatim — but they must still be PRESENT, for the same
      // internal-consistency reason the destructive pair is.
      const dark = css.match(/\.dark\s*\{[\s\S]*?\n\}/)?.[0];
      expect(dark).toBeDefined();
      expect(dark).toMatch(/--salt-primary-fixed:\s*197 49% 88%/);
      expect(dark).toMatch(/--salt-on-primary-fixed-variant:\s*196 20% 26%/);
      expect(dark).toMatch(/--salt-tertiary-fixed:\s*11 100% 91%/);
    });

    it('mirrors the destructive container pair into the .dark block (#825)', () => {
      // Every --salt-* primitive is declared in both blocks; a pair present in
      // only one leaves the file internally inconsistent even though nothing in
      // web-pwa applies .dark today.
      const dark = css.match(/\.dark\s*\{[\s\S]*?\n\}/)?.[0];
      expect(dark).toBeDefined();
      expect(dark).toMatch(/--salt-destructive-container:\s*6 100% 92%/);
      expect(dark).toMatch(/--salt-on-destructive-container:\s*356 100% 29%/);
    });

    it('pins the amber family to four roles and no more (#993)', () => {
      // The provenance comments are what check-theme.ts diffs against
      // design.md, so the hexes are the assertion. The COUNT is the other half:
      // the whole point of #993 is that sixteen raw amber steps collapse to
      // four, with grounds and borders derived as alpha modifiers. A fifth
      // --salt-review-*/--salt-warning-* primitive is the regression this
      // catches, and it goes red the moment one is added.
      expect(css).toMatch(/--salt-review:\s*45 100% 34%;\s*\/\*\s*#ad8200/);
      expect(css).toMatch(/--salt-review-text:\s*45 100% 24%;\s*\/\*\s*#7a5c00/);
      expect(css).toMatch(/--salt-warning:\s*22 100% 44%;\s*\/\*\s*#e05200/);
      expect(css).toMatch(/--salt-warning-text:\s*22 100% 30%;\s*\/\*\s*#993800/);
      const root = css.match(/:root\s*\{[\s\S]*?\n\}/)?.[0];
      expect(root).toBeDefined();
      expect(root!.match(/--salt-(?:review|warning)[a-z-]*:/g)).toHaveLength(4);
    });

    it('mirrors the amber family into the .dark block (#993)', () => {
      // Same internal-consistency rule as the pairs above. These values are
      // computed against the dark background, not observed: nothing in web-pwa
      // applies .dark, so they render nowhere today.
      const dark = css.match(/\.dark\s*\{[\s\S]*?\n\}/)?.[0];
      expect(dark).toBeDefined();
      expect(dark).toMatch(/--salt-review:\s*45 100% 60%/);
      expect(dark).toMatch(/--salt-review-text:\s*45 100% 72%/);
      expect(dark).toMatch(/--salt-warning:\s*24 100% 65%/);
      expect(dark).toMatch(/--salt-warning-text:\s*24 100% 75%/);
      expect(dark!.match(/--salt-(?:review|warning)[a-z-]*:/g)).toHaveLength(4);
    });

    it('pins --salt-placeholder to the measured AA value in both themes (#821)', () => {
      // Both halves are load-bearing and neither is guessable from the other:
      // light #677174 is 4.79:1 on the background and 3.38:1 off value text;
      // dark #99a1a3 is the value that fixes a pre-existing 4.35:1 AA failure.
      expect(css).toMatch(/--salt-placeholder:\s*195 6% 43%/);
      expect(css).toMatch(/--salt-placeholder:\s*195 5% 62%/);
    });

    it('styles placeholder text in exactly one place, by colour AND italic (#821)', () => {
      // The whole point of the change: one base rule, not a class per input, so
      // it reaches hand-rolled inputs and cannot drift back apart. Italic is
      // required independently — WCAG 1.4.1 forbids colour as the only channel
      // (ui-spec-v04 §17.5), which is also why the colour must not go faint.
      const rule = css.match(/::placeholder\s*\{([\s\S]*?)\}/)?.[1];
      expect(rule).toBeDefined();
      expect(rule).toMatch(/color:\s*hsl\(var\(--salt-placeholder\)\)/);
      expect(rule).toMatch(/font-style:\s*italic/);
      // No Tailwind `placeholder:*` utility anywhere in the preset — one would
      // beat the base rule and reopen the drift this rule exists to close.
      expect(css).not.toMatch(/placeholder:text-/);
    });

    it('ships a real Inter italic face, latin subset only (#821)', () => {
      // Synthesized oblique is too crude at this prominence, and latin-ext would
      // add 91.9 kB to set English hint copy. The url must stay RELATIVE: Vite
      // does not resolve bare specifiers inside url() and would ship a 404.
      const face = css
        .match(/@font-face\s*\{[^}]*\}/g)
        ?.find((b) => b.includes('inter-latin-wght-italic.woff2'));
      expect(face).toBeDefined();
      expect(face).toMatch(/font-family:\s*'Inter'/);
      expect(face).toMatch(/font-style:\s*italic/);
      expect(face).toMatch(
        /url\('\.\.\/node_modules\/@fontsource-variable\/inter\/files\/inter-latin-wght-italic\.woff2'\)/,
      );
      expect(css).not.toMatch(/inter-latin-ext-wght-italic/);
    });

    it('defines the radius + control-size primitives', () => {
      expect(css).toMatch(/--salt-radius-sm:\s*0\.25rem/);
      expect(css).toMatch(/--salt-radius-default:\s*0\.5rem/);
      expect(css).toMatch(/--salt-control-checkbox-md:\s*16px/);
      expect(css).toMatch(/--salt-control-switch-md-w:\s*36px/);
    });

    it('homes the spacing scale as --salt-space-* primitives (not @theme --spacing-*)', () => {
      // Collision-free home for the design.md spacing scale: plain :root custom
      // properties, so they never hijack max-w-* the way @theme --spacing-* would.
      expect(css).toMatch(/--salt-space-xs:\s*4px/);
      expect(css).toMatch(/--salt-space-md:\s*16px/);
      expect(css).toMatch(/--salt-space-xl:\s*48px/);
      expect(css).toMatch(/--salt-space-gutter:\s*16px/);
      // Guard the collision that Phase 3 fixed: no @theme --spacing-* key may exist.
      expect(css).not.toMatch(/^\s*--spacing-(?:xs|sm|md|lg|xl):/m);
    });

    it('pins the bottom-nav height at 3.5rem, in rem', () => {
      // Issue #930. Unlike the spacing scale above, this one is READ — by the
      // nav's own row and by the three things that reserve space for it.
      expect(css).toMatch(/--salt-layout-bottom-nav-height:\s*3\.5rem/);
    });

    it('states the nav height in rem, so it still tracks the browser font size', () => {
      // The nav was `h-14` — 3.5rem — before it was a token, so it has always
      // grown with the reader's browser font setting. `56px` would be the same
      // number and a different behaviour, which is a sizing change wearing a
      // naming change's clothes. This is the assertion that says so.
      const declared = css.match(/--salt-layout-bottom-nav-height:\s*([^;]+);/)?.[1]?.trim();
      expect(declared).toMatch(/rem$/);
      expect(declared).not.toMatch(/px$/);
    });
  });

  describe('component classes & custom utilities', () => {
    it('defines the button / input / trigger / control component classes', () => {
      expect(css).toContain('.salt-button {');
      expect(css).toContain('.salt-button--solid {');
      expect(css).toContain('.salt-input {');
      expect(css).toContain('.salt-trigger {');
      expect(css).toContain('.salt-control--checkbox {');
    });

    it('checkbox size classes use the control CSS vars', () => {
      expect(css).toMatch(
        /\.salt-control--checkbox-sm\s*\{[\s\S]*?width:\s*var\(--salt-control-checkbox-sm\)/,
      );
    });

    it('defines the typography component classes', () => {
      expect(css).toContain('.text-display {');
      expect(css).toContain('.text-h1 {');
      expect(css).toContain('.text-label-caps {');
    });

    it('defines the focus-ring and z-index custom utilities', () => {
      expect(css).toMatch(/@utility\s+salt-focus-ring\s*\{/);
      expect(css).toMatch(/@utility\s+salt-focus-ring-within\s*\{/);
      expect(css).toMatch(/@utility\s+z-popover\s*\{\s*z-index:\s*40/);
      expect(css).toMatch(/@utility\s+z-dialog\s*\{\s*z-index:\s*50/);
      expect(css).toMatch(/@utility\s+z-tooltip\s*\{\s*z-index:\s*70/);
    });

    it('defines the progress @keyframes', () => {
      expect(css).toMatch(/@keyframes\s+salt-progress-indeterminate/);
      expect(css).toMatch(/translateX\(-100%\)/);
      expect(css).toMatch(/translateX\(300%\)/);
    });
  });
});

describe('token constants', () => {
  describe('colors', () => {
    it('background is a CSS var reference string', () => {
      expect(colors.background).toBe('hsl(var(--salt-background))');
    });
    it('foreground is a CSS var reference string', () => {
      expect(colors.foreground).toBe('hsl(var(--salt-foreground))');
    });
    it('primary is a CSS var reference string', () => {
      expect(colors.primary).toBe('hsl(var(--salt-primary))');
    });
    it('primaryForeground is a CSS var reference string', () => {
      expect(colors.primaryForeground).toBe('hsl(var(--salt-primary-foreground))');
    });
    it('exports all 37 semantic color constants', () => {
      const keys = Object.keys(colors);
      expect(keys.length).toBe(37);
    });
    it('exposes the destructive container pair a removed row sits on (#825)', () => {
      // Symmetric with secondaryContainer, which is what an ADDED row gets. A
      // removal drawn only as struck-through text reads weaker than an addition
      // on a phone, which is the wrong asymmetry for the more destructive change.
      expect(colors.destructiveContainer).toBe('hsl(var(--salt-destructive-container))');
      expect(colors.destructiveContainerForeground).toBe(
        'hsl(var(--salt-on-destructive-container))',
      );
    });
    it('exposes the placeholder role that keeps example text off value text (#821)', () => {
      // A role of its own rather than a reuse of muted-foreground: the point is
      // separation FROM value text (3.38:1, up from 1.79:1) while still clearing
      // AA against the background, which no existing token did.
      expect(colors.placeholder).toBe('hsl(var(--salt-placeholder))');
    });
    it('exposes the burnt-terracotta variant used to mark next week (#639)', () => {
      // A hue shift at the same weight, not a lighter tint — the planner already
      // spends "quieter" on days that are behind you.
      expect(colors.tertiaryVariant).toBe('hsl(var(--salt-on-tertiary-fixed-variant))');
    });

    it('exposes the three tints and their foregrounds (#878)', () => {
      expect(colors.primaryTint).toBe('hsl(var(--salt-primary-fixed))');
      expect(colors.primaryTintForeground).toBe('hsl(var(--salt-on-primary-fixed-variant))');
      expect(colors.secondaryTint).toBe('hsl(var(--salt-secondary-container))');
      expect(colors.secondaryTintForeground).toBe('hsl(var(--salt-on-secondary-container))');
      expect(colors.tertiaryTint).toBe('hsl(var(--salt-tertiary-fixed))');
      expect(colors.tertiaryTintForeground).toBe('hsl(var(--salt-on-tertiary-fixed-variant))');
    });

    it('exposes the four amber roles, and no container/foreground pair (#993)', () => {
      // Deliberately NOT a `*-container` / `*-foreground` family: grounds are
      // alpha modifiers of these same four (bg-review/10, /20, border/40), so
      // adding a container primitive would put a fifth amber back in the
      // system, which is the thing #993 removed.
      expect(colors.review).toBe('hsl(var(--salt-review))');
      expect(colors.reviewText).toBe('hsl(var(--salt-review-text))');
      expect(colors.warning).toBe('hsl(var(--salt-warning))');
      expect(colors.warningText).toBe('hsl(var(--salt-warning-text))');
      expect(Object.keys(colors).filter((k) => /^(review|warning)/.test(k))).toHaveLength(4);
    });
  });

  describe('radius', () => {
    it('sm is the CSS var reference', () => {
      expect(radius.sm).toBe('var(--salt-radius-sm)');
    });
    it('full is the literal value', () => {
      expect(radius.full).toBe('9999px');
    });
  });

  describe('motion', () => {
    it('durationFast is 120ms', () => {
      expect(motion.durationFast).toBe('120ms');
    });
    it('easeStandard matches spec', () => {
      expect(motion.easeStandard).toBe('cubic-bezier(0.2, 0, 0, 1)');
    });
  });

  describe('elevation', () => {
    it('popover aliases to md', () => {
      expect(elevation.popover).toBe(elevation.md);
    });
    it('dialog aliases to lg', () => {
      expect(elevation.dialog).toBe(elevation.lg);
    });
  });

  describe('zIndex', () => {
    it('popover is 40', () => {
      expect(zIndex.popover).toBe(40);
    });
    it('dialog is 50', () => {
      expect(zIndex.dialog).toBe(50);
    });
    it('tooltip is 70', () => {
      expect(zIndex.tooltip).toBe(70);
    });
  });

  describe('tokens barrel', () => {
    it('exports colors namespace', () => {
      expect(tokens.colors).toBeDefined();
      expect(tokens.colors.background).toBe('hsl(var(--salt-background))');
    });
    it('exports radius namespace', () => {
      expect(tokens.radius).toBeDefined();
      expect(tokens.radius.sm).toBe('var(--salt-radius-sm)');
    });
    it('exports motion namespace', () => {
      expect(tokens.motion).toBeDefined();
      expect(tokens.motion.durationFast).toBe('120ms');
    });
    it('exports elevation namespace', () => {
      expect(tokens.elevation).toBeDefined();
    });
    it('exports zIndex namespace', () => {
      expect(tokens.zIndex).toBeDefined();
      expect(tokens.zIndex.popover).toBe(40);
    });
    it('exports typography namespace', () => {
      expect(tokens.typography).toBeDefined();
      expect(tokens.typography.fontFamilyDisplay).toContain('Epilogue');
    });
  });
});

describe('typography tokens', () => {
  it('fontFamilyDisplay includes Epilogue', () => {
    expect(typography.fontFamilyDisplay).toContain('Epilogue');
  });
  it('fontFamilyBody includes Inter', () => {
    expect(typography.fontFamilyBody).toContain('Inter');
  });
  it('fontSizeDisplay is 48px', () => {
    expect(typography.fontSizeDisplay).toBe('48px');
  });
  it('fontSizeH1 is 32px', () => {
    expect(typography.fontSizeH1).toBe('32px');
  });
  it('fontSizeH2 is 24px', () => {
    expect(typography.fontSizeH2).toBe('24px');
  });
  it('fontSizeBodyLg is 18px', () => {
    expect(typography.fontSizeBodyLg).toBe('18px');
  });
  it('fontSizeBodyMd is 16px', () => {
    expect(typography.fontSizeBodyMd).toBe('16px');
  });
  it('fontSizeLabelCaps is 12px', () => {
    expect(typography.fontSizeLabelCaps).toBe('12px');
  });
  it('letterSpacingDisplay is -0.02em', () => {
    expect(typography.letterSpacingDisplay).toBe('-0.02em');
  });
  it('letterSpacingLabelCaps is 0.05em', () => {
    expect(typography.letterSpacingLabelCaps).toBe('0.05em');
  });
  it('fontWeightDisplay is 700', () => {
    expect(typography.fontWeightDisplay).toBe('700');
  });
  it('fontWeightHeading is 600', () => {
    expect(typography.fontWeightHeading).toBe('600');
  });
  it('exports 21 typography constants', () => {
    expect(Object.keys(typography).length).toBe(21);
  });
});
