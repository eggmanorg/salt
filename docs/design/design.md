---
name: Culinary Modernist
colors:
  surface: '#f8fafa'
  surface-dim: '#d8dada'
  surface-bright: '#f8fafa'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f2f4f4'
  surface-container: '#eceeee'
  surface-container-high: '#e6e8e9'
  surface-container-highest: '#e1e3e3'
  on-surface: '#191c1d'
  on-surface-variant: '#42484a'
  inverse-surface: '#2e3131'
  inverse-on-surface: '#eff1f1'
  outline: '#73787a'
  outline-variant: '#c2c7ca'
  surface-tint: '#4d6169'
  primary: '#35606e'
  on-primary: '#ffffff'
  primary-container: '#1a2e35'
  on-primary-container: '#81969e'
  inverse-primary: '#b4cad3'
  secondary: '#4f6443'
  on-secondary: '#ffffff'
  secondary-container: '#cfe7bd'
  on-secondary-container: '#536947'
  tertiary: '#340500'
  on-tertiary: '#ffffff'
  tertiary-container: '#580f00'
  on-tertiary-container: '#e76e50'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  # The amber family (issue #993). Four roles, not four families — two meanings
  # (`review` is written-but-unchecked, `warning` is a non-blocking problem)
  # crossed with two contrast floors (a graphical object clears 3, small text
  # clears 4.5). Grounds and borders are alpha modifiers of these same four, so
  # the family has four values and not sixteen. See the `--color-review` block
  # in salt.css for the measured ratios and the alpha ladder.
  review: '#ad8200'
  review-text: '#7a5c00'
  warning: '#e05200'
  warning-text: '#993800'
  primary-fixed: '#d0e6ef'
  primary-fixed-dim: '#b4cad3'
  on-primary-fixed: '#091e25'
  on-primary-fixed-variant: '#364a51'
  secondary-fixed: '#d2eac0'
  secondary-fixed-dim: '#b6cea5'
  on-secondary-fixed: '#0e2006'
  on-secondary-fixed-variant: '#384c2d'
  tertiary-fixed: '#ffdad2'
  tertiary-fixed-dim: '#ffb4a2'
  on-tertiary-fixed: '#3c0700'
  on-tertiary-fixed-variant: '#83260e'
  background: '#f8fafa'
  on-background: '#191c1d'
  surface-variant: '#e1e3e3'
  placeholder: '#677174'
typography:
  display:
    fontFamily: Epilogue
    fontSize: 48px
    fontWeight: '700'
    lineHeight: '1.1'
    letterSpacing: -0.02em
  h1:
    fontFamily: Epilogue
    fontSize: 32px
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: -0.01em
  h2:
    fontFamily: Epilogue
    fontSize: 24px
    fontWeight: '600'
    lineHeight: '1.3'
  body-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: '1.5'
  label-caps:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '600'
    lineHeight: '1.0'
    letterSpacing: 0.05em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  unit: 4px
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 48px
  container-margin: 24px
  gutter: 16px
layout:
  # The BottomNav's row height, and the reservation every fixed thing above it
  # makes to clear it. In `rem`, unlike every value above: this one is CONSUMED
  # (the spacing scale is a drift-checkable home and nothing reads it), and the
  # nav has always been `h-14` — 3.5rem — so it grows with the reader's browser
  # font size. A px value here would quietly freeze it (issue #930).
  bottom-nav-height: 3.5rem
controls:
  checkbox:
    sm: 14px
    md: 16px
    lg: 18px
  switch:
    sm-h: 16px
    sm-w: 28px
    md-h: 20px
    md-w: 36px
    lg-h: 24px
    lg-w: 44px
    thumb-sm: 12px
    thumb-md: 16px
    thumb-lg: 20px
---

## Brand & Style

This design system embodies the "Modern British" aesthetic: a harmonious blend of heritage-inspired color depth and contemporary functional minimalism. It avoids the clutter of traditional "country" kitchens in favor of a crisp, architectural approach. The UI is designed to feel like a high-end kitchen appliance—precise, reliable, and effortlessly sophisticated.

The style leans heavily into **Minimalism** with an **Editorial** edge. It utilizes generous whitespace to ensure legibility in a busy kitchen environment and prioritizes high-contrast typography to guide the user through complex culinary tasks. The emotional response should be one of calm confidence, providing the user with a "sous-chef" experience that is both helpful and aesthetically elevated.

## Colors

The palette is rooted in a deep **Slate Teal** (Primary), providing a grounded, professional foundation that replaces standard blacks for a more sophisticated feel. This is paired with **Crisp White** and **Alabaster** neutrals to ensure the interface feels airy and hygienic.

To inject life into the system, we use **Sage Green** as the primary accent for success states and organic "fresh" elements, while **Warm Terracotta** serves as a secondary accent for high-energy interactions. All colors are calibrated for high legibility under varied lighting conditions common in a kitchen.

Attention is a family of its own, spanning one axis from **Saffron** (`review`, hue 45°) to **Burnt Orange** (`warning`, hue 22°). Saffron means _a machine wrote this and nobody has checked it_ — informational, never a gate. Burnt orange means _read this before you continue_ — a problem, though never a blocking one; that is `error`'s job. The hue distance between the two ends is what carries the difference at a glance, and each end has a darker step for small text because a graphical object clears 3:1 where text must clear 4.5:1. Terracotta is deliberately **not** in this family: it is a surface tint that keys peers to each other, not a severity.

## Typography

This design system utilizes a dual-font strategy to balance character with utility. **Epilogue** is used for headlines and titles; its geometric yet distinctive letterforms provide an editorial, premium quality reminiscent of modern lifestyle magazines.

**Inter** is the workhorse for all functional content. Chosen for its exceptional x-height and clarity, it ensures that ingredients, measurements, and instructions are readable at an arm's length. We employ a strict hierarchy where labels are often presented in all-caps with slight tracking to differentiate them from instructional body text.

## Layout & Spacing

The layout follows a **Fixed-Fluid Hybrid Grid**. On larger tablet interfaces (the primary kitchen device), content is contained within a maximum width to prevent line lengths from becoming unreadable. We use an 8px rhythm to ensure consistent vertical pacing.

Key layouts prioritize a "Hands-Free" reading mode:

- **Instructional Spacing:** Increased vertical padding between steps (XL spacing) to prevent accidental misreads.
- **Side-Car Panels:** A 1/3 layout model where the ingredient list remains pinned while instructions scroll.
- **Margins:** Generous 24px outer margins to prevent the UI from feeling cramped near the bezel of the device.

## Elevation & Depth

This design system avoids heavy shadows and traditional skeuomorphism in favor of **Tonal Layers** and **Low-Contrast Outlines**. Depth is communicated through subtle shifts in surface color (e.g., a slightly darker Alabaster surface sitting atop a Crisp White background).

When depth is required for interactive elements like modals or pop-overs, we use "Ambient Shadows"—extremely soft, diffused shadows with a low opacity (4-6%) and a hint of the Primary Slate Teal color to keep the shadow looking "cool" and clean rather than muddy.

## Shapes

The shape language is defined by **Level 2 (Rounded)** corners. This provides a soft, approachable feel that mimics the ergonomic curves of modern kitchenware without appearing juvenile or "bubbly."

Cards and primary containers use a 1rem (16px) radius, while smaller interactive elements like buttons and input fields use a 0.5rem (8px) radius. This nesting of radii creates a cohesive, structured look. Occasional use of fully pill-shaped elements is reserved strictly for status chips (e.g., "Prep Time," "Vegetarian").

## Components

### Buttons

Primary buttons use the Slate Teal background with White text. Secondary buttons utilize a Sage Green ghost style (outline only).

### Cards

Cards are the primary container for recipes and ingredients. They should feature a 1px solid border in a very light grey (#E1E8EB) rather than a shadow, maintaining the clean, architectural look.

### Input Fields

Inputs are minimal: a bottom-border only or a very light-filled background with no heavy borders. Focus states should be indicated by a transition to the Sage Green accent.

### Kitchen-Specific Components

- **Step-Progress Bar:** A thick, horizontal bar at the top of the viewport using Sage Green to show completion.
- **Timer Chips:** Vibrant Terracotta backgrounds with bold white Epilogue text to draw immediate attention to active countdowns.
- **Ingredient Toggles:** Large-format checkboxes that turn Sage Green when "checked," allowing users to physically tap off items as they prep.
