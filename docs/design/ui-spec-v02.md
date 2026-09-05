# Salt 2.0 — UI Primitives Specification (v0.2.19)

**Status:** Authoritative
**Audience:** AI code generators + human contributors
**Rule:** If anything is missing → STOP → extend spec → regenerate. No invention.

Every generated file MUST begin with a provenance header (see §3.8). If you cannot cite a section for a decision, you are inventing — stop and amend the spec first.

---

# 0. Roadmap Split

## v0.2 Core (implemented now)

- Button
- TextField
- Textarea
- Checkbox
- Switch
- Dialog
- Popover
- Tooltip
- Card
- Heading
- Text
- Icon
- Stack
- Inline
- Grid
- Divider
- Spinner
- Progress

## v0.3 Advanced (NOT implemented in v0.2)

- RadioGroup
- Select
- Slider
- Sheet
- Toast

Generators must not implement v0.3 primitives until the v0.3 spec exists.

---

# 1. Foundations

## 1.1 Technology Stack

| Concern       | Technology                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Framework     | Svelte 5 `^5.55.0` (runes: `$state`, `$derived`, `$effect`, `$props`, `$bindable`)                                       |
| Styling       | Tailwind CSS + shadcn token scheme                                                                                       |
| Animations    | tw-animate-css (imported by `src/salt.css` — see §3.3)                                                                   |
| Headless      | bits-ui ≥ 1.0.0; melt-ui ≥ 1.0.0-svelte5 (fallback only)                                                                 |
| Variants      | class-variance-authority (CVA)                                                                                           |
| Class merging | tailwind-merge + clsx via `cn()`                                                                                         |
| Icons         | @lucide/svelte, via the curated registry in `src/primitives/Icon/iconRegistry.ts` (typed as `keyof typeof iconRegistry`) |
| Testing       | Vitest + @testing-library/svelte + user-event + axe-core                                                                 |
| TS            | strict: true                                                                                                             |

---

## 1.2 Boundaries

`@salt/ui-components` is a leaf package (external-only — no `@salt/*` imports).

Allowed imports:

- bits-ui, melt-ui, @lucide/svelte
- Svelte internals
- Tailwind utilities

Forbidden:

- All Salt app/domain packages (`@salt/domain`, `@salt/firebase-sync`, `@salt/observability`, `@salt/web-pwa`, `@salt/cloud-functions`)
- Firebase SDKs
- Node built-ins
- Browser APIs except inside Svelte actions or `$effect` blocks

Consumers may NOT import bits-ui / melt-ui / @lucide/svelte directly. All access is through `@salt/ui-components` entry points.

---

## 1.3 Package Surface

Entry points (exact):

| Import path                      | Contents                                                             |
| -------------------------------- | -------------------------------------------------------------------- |
| `@salt/ui-components`            | Stable primitive components + re-exports of tokens + `cn` + `useId`  |
| `@salt/ui-components/tokens`     | TS token constants (generated from `src/salt.css`)                   |
| `@salt/ui-components/styles.css` | The design-system stylesheet — tokens, base layer, component classes |

> **Headless factories:** `create<Primitive>State()` factories + context keys live in the per-primitive `src/headless/<Primitive>.headless.svelte.ts` files, imported directly by each primitive. The old aggregating `@salt/ui-components/headless` barrel (and the `@salt/ui-components/test` placeholder) were removed as dead surface in #491 — nothing consumed either subpath.

**Barrel shape (`src/index.ts`):**

```ts
// Primitives
export { default as Button } from './primitives/Button/Button.svelte';
export { default as TextField } from './primitives/TextField/TextField.svelte';
// ... one line per primitive, alphabetical

// Compound parts
export { default as DialogTrigger } from './primitives/Dialog/DialogTrigger.svelte';
// ... explicit re-exports for every sub-part

// Helpers (re-exported from ./lib)
export { cn } from './lib/cn';
export { useId } from './lib/useId';

// Token re-exports
export * as tokens from './tokens';

// Types
export type { ButtonProps } from './primitives/Button/Button.types';
// ... one per primitive
```

**Tokens barrel (`src/tokens.ts`):** namespaced re-exports of the token groups (`colors`, `radius`, `motion`, `elevation`, `zIndex`, `typography`) — no default export. Content is generated from `src/salt.css` (§3.3) — never hand-edited.

There is no `src/headless.ts` and no `src/test.ts`: both were removed as dead surface in #491, per the note above.

No deep imports. No side-effect imports in any barrel.

---

## 1.4 Event Naming Rule

**Native DOM events:** lowercase, matching the underlying element's attribute name. Examples: `onclick`, `oninput`, `onfocus`, `onblur`, `onkeydown`. Types are the native event types (`MouseEvent`, `KeyboardEvent`, etc.). These are passed through via `$props()` spread or explicit forwarding — never wrapped.

**Custom callbacks:** camelCase starting with `on<Verb>`. Examples: `onValueChange`, `onCheckedChange`, `onOpenChange`. Signature is `(value: T) => void` — single positional argument of the new state, never an event object. These are invoked directly (no `createEventDispatcher`).

**Bindable state + callback:** a primitive that bindings a state variable MUST also expose the matching `on<Verb>Change` callback. Both fire on every change. The pattern is documented in §3.6.

---

## 1.5 Spec Versioning & Amendment Rule

The spec is versioned `vMAJOR.MINOR.PATCH` (currently v0.2.19).

- **PATCH** (v0.2.1 → v0.2.2): clarifications, typo fixes, tightened class matrices. No breaking change to generated code.
- **MINOR** (v0.2.x → v0.3.0): new primitives, new props, new tokens.
- **MAJOR** (v0.x → v1.0): breaking changes to existing primitives.

**Why the v0.2.x line keeps absorbing amendments.** `v0.3.0` is not available as a version number: `ui-spec-v03.md` is a separate, already-published document (the v0.3 Advanced roadmap in §0), so bumping this file to v0.3.0 would name two different documents the same thing. Amendments to the v0.2 Core primitives therefore land on the v0.2.x PATCH line even where the table above would read them as MINOR. A behavioural amendment on this line is still a contract change — re-stamp the affected files' provenance headers (§3.8).

When you amend this spec:

1. Bump the version in the header.
2. Add a line to §9 Changelog with date, version, and summary.
3. If the amendment changes a primitive contract, update that primitive's `Provenance` line so existing generated files can be diffed against the new contract.

---

# 2. Design Principles

## 2.1 Architecture

Every non-trivial primitive has two layers, in two different folders:

### Headless layer

- Location: `src/headless/<Primitive>.headless.svelte.ts` (centralized — NOT co-located with the styled component).
- Contains: state, ARIA wiring, keyboard handling, focus management, context keys.
- No styling, no Tailwind, no class names.
- Exposes: `create<Primitive>State(options)` factory + a `<PRIMITIVE>_CONTEXT` symbol.

### Styled layer

- Location: `src/primitives/<Primitive>/<Primitive>.svelte` (co-located with parts, variants, types).
- Contains: Tailwind classes, CVA variants, token references, snippet composition.
- Imports headless layer via relative path.
- No behavior duplication — styled layer is presentation only.

**Trivial primitives** (pure layout/visual, no state or a11y logic) may skip the headless layer. The v0.2 primitives that skip headless are: Card, Heading, Text, Icon, Stack, Inline, Grid, Divider, Spinner.

---

## 2.2 Accessibility

All interactive primitives must:

- Follow WAI-ARIA APG 1.2.
- Support full keyboard interaction (see §5.2).
- Provide programmatic labels (`aria-label`, `aria-labelledby`, or `<label for>`).
- Pass axe-core with zero serious/critical violations.
- Provide a deterministic focus ring (see §4.2).
- Support reduced motion (`motion-reduce:` variants) and forced-colors mode.

---

## 2.3 Styling Rules

- **Tailwind utilities by default; a `.salt-*` component class in `salt.css` when the styling is shared or multi-state.** A primitive earns a component class in [`salt.css`](../../packages/ui-components/src/salt.css) on one of two grounds, and otherwise styles itself with utilities inline:
  - **A visual identity shared across primitives.** `.salt-control` serves Checkbox, Switch and RadioGroup; `.salt-input` serves TextField, Textarea and Combobox; `.salt-trigger` serves Select. One class, one place a fix lands.
  - **Multi-state styling that utilities express badly.** `.salt-button`, `.salt-chip`, `.salt-dial`, `.salt-tabs` and `.salt-collapsible` each carry hover / active / pressed / disabled / loading combinations whose utility form would be an unreadable string.

  Surfaces and layout that share their styling with **nothing** — Card, Dialog, Sheet, Popover, Tooltip, Text, Stack, Inline, Grid — stay utility-only. That is the rule, not an oversight, and no conversion is owed: giving each of them a single-use CSS class would deduplicate nothing and risk a pixel change for it.

  **A single element may use both.** `DialogClose.svelte` composes the shared `salt-focus-ring` class with inline utilities; that is the intended shape, not a lapse.

  _(This replaces the pre-v4 line "Tailwind utilities only — no raw CSS files except the preset", false since the Tailwind v4 migration made `salt.css` the design-system entry — see §3.3. It retires finding `B5-016` of the #894 review: what that finding read as an inconsistency is this rule, so writing the rule down is the whole of the fix and **no primitive is converted**.)_

- CVA for multi-axis variants.
- Dark mode via `.dark` class on `<html>` (see §4.5).
- `class` prop merged last via `cn()`.
- No inline `style` attributes except for numeric transforms (`transform: scaleX(...)` on Progress, `transform: translate3d(...)` on Switch thumb, etc.).
- **Base radius for surfaces.** Cards, list rows, and field frames use the base `rounded` (4px) radius (`--salt-radius`, §4.1). Larger surfaces that read as "floating panels" (Dialog, Popover, Sheet) keep `rounded-lg` (10px). Do not introduce a fourth radius for these surfaces without amending this rule.

---

## 2.4 Naming Conventions

| Item                 | Convention                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Component file       | PascalCase `.svelte`                                                                                                           |
| Compound part file   | PascalCase, `<Parent><Part>.svelte` (e.g., `DialogTrigger.svelte`)                                                             |
| Headless file        | `<Primitive>.headless.svelte.ts`                                                                                               |
| Variants file        | `<Primitive>.variants.ts`                                                                                                      |
| Types file           | `<Primitive>.types.ts`                                                                                                         |
| Props                | camelCase                                                                                                                      |
| Boolean props        | affirmative (`disabled`, `loading`, never `notDisabled`)                                                                       |
| Bindable props       | typed with `$bindable()` (e.g., `value`, `open`, `checked`)                                                                    |
| Events               | see §1.4                                                                                                                       |
| Snippets             | camelCase (`leading`, `trailing`, `default`)                                                                                   |
| CSS vars             | `--salt-*`                                                                                                                     |
| Custom classes       | `salt-*`                                                                                                                       |
| Context symbols      | UPPER_SNAKE with `_CONTEXT` suffix                                                                                             |
| `aria-*` translation | camelCase prop (e.g., `ariaLabel`) → kebab attr (`aria-label`) in rendered DOM. Translation is the component's responsibility. |

---

## 2.5 Composition Rules

- Compound primitives use explicit sub-components (`DialogTrigger`, `DialogContent`). No string-based `type` props.
- No DOM traversal upward (`parentNode` walks). Communication is via context keys set by the root.
- Context keys are defined in the per-primitive `src/headless/<Primitive>.headless.svelte.ts` file and imported directly by that primitive.
- Portals allowed only for: Dialog, Popover, Tooltip, Select, Combobox. The first three use bits-ui's own `.Portal` part (§3.7); the anchored listboxes of Select and Combobox move their own floating-ui-positioned wrapper, because bits-ui owns no part for them.
- `portal: HTMLElement | string | false`. String values are treated as CSS selectors.
  - Dialog, Popover, Tooltip and Sheet default to `"body"`.
  - **Select and Combobox default to _unset_, which means "the enclosing `DialogContent`/`SheetContent` if there is one, `<body>` otherwise".** A dropdown opened inside a modal must not portal to `<body>`: the modal puts `pointer-events: none` there, so the listbox renders and is inert (#674, #640). The enclosing element is published on the `PortalContainer` context key by `DialogContent`/`SheetContent` and read optionally by the two listboxes — not found by walking the DOM. Passing an explicit target still wins, for a host that knows better.
  - **The two anchored listboxes share one portal-mount helper and one floating-ui positioning helper**, both in `src/headless/` and both called rather than copied, so the #674/#640 fix and the anchored-position middleware each have exactly one implementation and a correction to either cannot reach one listbox and miss the other. What stays per-primitive is everything the two do differently: outside-click, focus, blur, and the two keyboard handlers (ui-spec-v03 §3.6, ui-spec-v04 §4.2).
- Controlled/uncontrolled pattern (canonical wiring in §3.6):
  - `value` — bindable, always reflects the current state.
  - `defaultValue` — initial uncontrolled value; read once, never again.
  - Never pass both for the same state.
  - Every bindable has a matching `on<Verb>Change` callback that fires on every update.

---

## 2.6 Determinism

- No `Math.random()`, no `Date.now()` in render paths.
- No timers outside of `$effect` cleanup (e.g. tooltip delay is fine; a spinner tick is not).
- No `fetch`, no `localStorage`, no `sessionStorage`, no `IndexedDB`.
- `useId()` is a module-scope counter — deterministic within a single client-side render tree, **not SSR-safe**. v0.2 targets client-only rendering; if SSR is introduced, §3.5 must be amended to use a request-scoped id source before any SSR rollout.
- Identical props → identical DOM. Property order must be stable.

---

# 3. Component Architecture

## 3.1 Folder Structure

```
src/
  index.ts                       ← primitive + helper + type barrel
  tokens.ts                      ← token barrel (generated)
  salt.css                       ← design-system entry — see §3.3
  lib/
    cn.ts                        ← see §3.5
    useId.ts                     ← see §3.5
    context.ts                   ← see §3.5
    variants.ts                  ← CVA helpers, VariantProps
    layoutVariants.ts            ← the gap/align/justify maps Stack, Inline and Grid share (§8.13)
  tokens/
    colors.ts
    radius.ts
    motion.ts
    elevation.ts
    z-index.ts
  headless/
    Button.headless.svelte.ts
    Field.headless.svelte.ts        ← TextField, Textarea, Checkbox, Switch
    Dialog.headless.svelte.ts
    Popover.headless.svelte.ts
    Tooltip.headless.svelte.ts
    Progress.headless.svelte.ts
  primitives/
    <Primitive>/
      <Primitive>.svelte
      <Primitive><Part>.svelte        ← one per compound part, unless shared (below)
      <Primitive>.variants.ts         ← CVA definitions
      <Primitive>.types.ts            ← exported prop types
tests/
  <Primitive>.test.ts
```

**A headless module may serve several primitives.** The field-state module is one
file — id generation, `hasError`/`hasDescription` and the `aria-describedby`
composition are identical for TextField, Textarea, Checkbox and Switch, so they are
written once and the `useId` prefix is a parameter. (This generalises the older
"Textarea reuses TextField.headless" note, which recorded the same practice for one
pair.) A primitive keeps its **own** headless module the moment its state is its own
— Select, Combobox, Dialog, Popover and the rest.

**A compound part shared by two primitives lives once.** Where two primitives'
parts are the same component under two names, the file lives in the primitive that
owns the base behaviour and reaches the second name through `src/index.ts`:

```ts
export { default as SheetTitle } from './primitives/Dialog/DialogTitle.svelte';
```

No wrapper component, no neutral third directory, and the second name stays a
first-class export with its own prop type. The file cites both specs in its
provenance header (§3.8). Sheet's Close, Title, Description and Header are the
worked case — a Sheet _is_ a bits-ui Dialog with a side, and those four parts never
differed (ui-spec-v03 §5.2). A part that differs at all, however slightly, stays two
files: `SheetFooter` and `SheetTrigger` do, and must.

---

## 3.2 Export Rules

- `.svelte` files default-export (compiler behavior).
- **A component directory carries no barrel of its own.** `src/index.ts` names the leaf
  file for every export it publishes:
  ```ts
  export { default as Button } from './primitives/Button/Button.svelte';
  export type { ButtonProps } from './primitives/Button/Button.types';
  ```
  Anything a component wants to publish reaches the package surface by being added
  there; anything it does not is imported from its own file by its siblings. See §9
  (v0.2.15) for why the per-component `index.ts` was removed.
- `.ts` files have no default exports.
- No side-effect imports in any barrel (`src/index.ts`, `src/tokens.ts`).

---

## 3.3 Tailwind + Token Ownership

**`src/salt.css` is the design-system entry and the single source of truth for the runtime tokens.** It is the Tailwind v4 CSS-first file that replaced the v3 JS preset (`tailwind-preset.ts`), the per-app `tailwind.config.ts` and the `@config` directive in the v4 migration (#323). Which shapes inside it the tooling parses is recorded in its own header comment, beside the code, and is not restated here.

The palette above it is [design.md](design.md): its YAML frontmatter is the source of truth for the colour roles, and `scripts/check-theme.ts` (`pnpm --filter @salt/ui-components theme:check`) fails with a diff when the two disagree. **A token change starts in `design.md`, not in CSS.**

`src/tokens/*.ts` and `src/tokens.ts` are generated from `salt.css` by `scripts/generate-tokens.ts` and checked in. Regeneration is idempotent. Do not hand-edit files under `src/tokens/`.

Apps consume the design system by importing the stylesheet. There is no preset to register and no per-app Tailwind config:

```css
@import '@salt/ui-components/styles.css';
```

`salt.css` imports `tw-animate-css`, so `animate-in` / `animate-out` / `data-[state=open]:*` utilities are available to every consumer without per-app configuration.

---

## 3.4 bits-ui / melt-ui Versions

- bits-ui ≥ 1.0.0 (Svelte 5 support).
- melt-ui ≥ 1.0.0-svelte5.
- melt-ui only when bits-ui lacks the primitive.
- Version pins live in `package.json` — not in the design-system stylesheet.

---

## 3.5 Helpers

### `src/lib/cn.ts`

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

### `src/lib/useId.ts`

```ts
let counter = 0;
export function useId(prefix = 'salt'): string {
  // SSR-stable: counter resets per render via Svelte's module scope.
  // Do not rely on randomness.
  return `${prefix}-${++counter}`;
}
```

IDs generated at component construction, stored in `$state`, stable for the component's lifetime.

### `src/lib/context.ts`

```ts
import { getContext, setContext } from 'svelte';

export function createContext<T>(name: string) {
  const key = Symbol(name);
  return {
    set: (value: T) => setContext(key, value),
    get: (): T => {
      const value = getContext<T>(key);
      if (value === undefined) {
        throw new Error(`${name} context not found. Wrap in the matching root component.`);
      }
      return value;
    },
    // Absent is an answer, not an error — for a context one primitive reads to
    // notice it happens to be rendered inside another (§2.5).
    getOptional: (): T | undefined => {
      try {
        return getContext<T>(key);
      } catch {
        return undefined;
      }
    },
    key,
  };
}
```

Context objects are exported from each headless file as a named constant (e.g., `DIALOG_CONTEXT = createContext<DialogState>('Dialog')`). One key is not owned by a primitive: `PORTAL_CONTAINER_CONTEXT` in `src/headless/PortalContainer.headless.svelte.ts`, published by `DialogContent`/`SheetContent` and read with `getOptional` by `SelectContent`/`ComboboxContent` (§2.5).

### `src/lib/variants.ts`

```ts
export { cva, type VariantProps } from 'class-variance-authority';
```

Re-export only. No wrapper; CVA is used directly in each `<Primitive>.variants.ts`.

---

## 3.6 Canonical Patterns — Button Worked Example

This is the copy-source for every other primitive. Deviation requires a spec amendment.

### `src/headless/Button.headless.svelte.ts`

```ts
// spec: SPEC.md §8.1 v0.2.1
export type ButtonState = {
  readonly loading: boolean;
  readonly disabled: boolean;
  readonly interactive: boolean; // !disabled && !loading
};

export function createButtonState(opts: {
  disabled: () => boolean;
  loading: () => boolean;
}): ButtonState {
  return {
    get loading() {
      return opts.loading();
    },
    get disabled() {
      return opts.disabled();
    },
    get interactive() {
      return !opts.disabled() && !opts.loading();
    },
  };
}
```

### `src/primitives/Button/Button.variants.ts`

```ts
// spec: SPEC.md §8.1 v0.2.3
import { cva, type VariantProps } from '../../lib/variants';

export const buttonVariants = cva('salt-button', {
  variants: {
    variant: {
      solid: 'salt-button--solid',
      outline: 'salt-button--outline',
      ghost: 'salt-button--ghost',
      link: 'salt-button--link',
      destructive: 'salt-button--destructive',
    },
    size: {
      sm: 'salt-button--sm',
      md: 'salt-button--md',
      lg: 'salt-button--lg',
      icon: 'salt-button--icon',
    },
    fullWidth: { true: 'salt-button--full', false: '' },
  },
  defaultVariants: { variant: 'solid', size: 'md', fullWidth: false },
});

export type ButtonVariants = VariantProps<typeof buttonVariants>;
```

### `src/primitives/Button/Button.types.ts`

```ts
// spec: SPEC.md §8.1 v0.2.1
import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';
import type { ButtonVariants } from './Button.variants';

export type ButtonProps = {
  variant?: ButtonVariants['variant'];
  size?: ButtonVariants['size'];
  fullWidth?: boolean;
  loading?: boolean;
  ariaLabel?: string;
  class?: string;
  leading?: Snippet;
  trailing?: Snippet;
  children?: Snippet;
  onclick?: HTMLButtonAttributes['onclick'];
} & Omit<HTMLButtonAttributes, 'class' | 'onclick'>;
```

### `src/primitives/Button/Button.svelte`

```svelte
<!-- spec: SPEC.md §8.1 v0.2.1 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import { createButtonState } from '../../headless/Button.headless.svelte';
  import { buttonVariants } from './Button.variants';
  import Spinner from '../Spinner/Spinner.svelte';
  import type { ButtonProps } from './Button.types';

  let {
    variant = 'solid',
    size = 'md',
    type = 'button',
    disabled = false,
    loading = false,
    fullWidth = false,
    ariaLabel,
    class: className,
    leading,
    trailing,
    children,
    onclick,
    ...rest
  }: ButtonProps = $props();

  const state = createButtonState({
    disabled: () => disabled,
    loading: () => loading,
  });

  function handleClick(e: MouseEvent) {
    if (!state.interactive) {
      e.preventDefault();
      return;
    }
    onclick?.(e);
  }
</script>

<button
  {type}
  class={cn(buttonVariants({ variant, size, fullWidth }), className)}
  disabled={state.disabled}
  data-disabled={state.disabled ? '' : undefined}
  data-loading={state.loading ? '' : undefined}
  aria-disabled={state.disabled || state.loading ? 'true' : undefined}
  aria-busy={state.loading ? 'true' : undefined}
  aria-label={ariaLabel}
  onclick={handleClick}
  {...rest}
>
  {#if state.loading}
    <Spinner size={16} />
  {:else if leading}
    {@render leading()}
  {/if}

  {@render children?.()}

  {#if !state.loading && trailing}
    {@render trailing()}
  {/if}
</button>
```

### The Button's two lines on `src/index.ts`

The directory has no barrel of its own (§3.2). A component becomes public by being
named on the package barrel, leaf file by leaf file, in the two groups §1.3 prints:

```ts
// Primitives
export { default as Button } from './primitives/Button/Button.svelte';

// Types
export type { ButtonProps } from './primitives/Button/Button.types';
```

`buttonVariants` is deliberately **not** among them: the CVA factory is the
component's own business, imported from `./Button.variants` by the files that need
it. Adding a line to `src/index.ts` is the whole act of publishing something, so the
package surface is exactly what that one file says it is.

### Canonical controlled/uncontrolled wiring (reference for all bindable primitives)

```svelte
<script lang="ts">
  let {
    value = $bindable(),
    defaultValue = '',
    onValueChange,
  }: { value?: string; defaultValue?: string; onValueChange?: (v: string) => void } = $props();

  // If `value` is undefined (uncontrolled), seed from defaultValue once.
  if (value === undefined) value = defaultValue;

  function update(next: string) {
    value = next; // bindable write — triggers consumer binding
    onValueChange?.(next); // callback fires on every change
  }
</script>
```

### Canonical snippet render pattern

```svelte
{#if leading}{@render leading()}{/if}
{@render children?.()}
{#if trailing}{@render trailing()}{/if}
```

Never use `<slot>`. Never call `{@render}` conditionally without an `{#if}` guard on optional snippets.

---

## 3.7 bits-ui Mapping Table

Which v0.2 primitives wrap which bits-ui primitive. **No other mapping is permitted.**

| Salt primitive               | bits-ui primitive | Notes                                                                                                  |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ |
| Button                       | —                 | Native `<button>`. No bits-ui.                                                                         |
| TextField                    | —                 | Native `<input>`. No bits-ui.                                                                          |
| Textarea                     | —                 | Native `<textarea>`. No bits-ui.                                                                       |
| Checkbox                     | `Checkbox`        | Wrap `Checkbox.Root` + `Checkbox.Indicator`.                                                           |
| Switch                       | `Switch`          | Wrap `Switch.Root` + `Switch.Thumb`.                                                                   |
| Dialog                       | `Dialog`          | Wrap `Dialog.Root`, `.Trigger`, `.Portal`, `.Overlay`, `.Content`, `.Title`, `.Description`, `.Close`. |
| Popover                      | `Popover`         | Wrap `Popover.Root`, `.Trigger`, `.Portal`, `.Content`.                                                |
| Tooltip                      | `Tooltip`         | Wrap `Tooltip.Provider`, `.Root`, `.Trigger`, `.Portal`, `.Content`.                                   |
| Card                         | —                 | Pure styled `<div>`s.                                                                                  |
| Heading, Text, Icon          | —                 | Pure styled elements.                                                                                  |
| Stack, Inline, Grid, Divider | —                 | Pure styled `<div>`s.                                                                                  |
| Spinner                      | —                 | Inline SVG.                                                                                            |
| Progress                     | `Progress`        | Wrap `Progress.Root` + `Progress.Indicator`.                                                           |

Portal implementation uses bits-ui's built-in `.Portal` part for Dialog, Popover, Tooltip. Do not implement a custom portal. `Select` and `Combobox` are the stated exception in §2.5 — they are hand-rolled on floating-ui, bits-ui owns no part for them, and their content components move their own wrapper.

---

## 3.8 Provenance Header Convention

**Every file under `src/` MUST begin with a provenance header on the first non-blank line:**

- `.svelte` files: `<!-- spec: <doc>.md §X.Y vM.m.p -->`
- `.ts` / `.svelte.ts` files: `// spec: <doc>.md §X.Y vM.m.p`

Where `<doc>.md` is **the file name of a real document in `docs/design/` (or `docs/`)**, `§X.Y` is
**a section that exists in that document** and is the
most specific spec section the file implements, and `vM.m.p` is the spec version that
was current when the file was generated or last amended. A file implementing two
specs cites both, separated by `; ` — `ui-spec-v04.md §9 v0.4; ui-spec-v05.md §1 v0.5 (fill)`
— with an optional parenthesised note saying which part each citation covers.

Files without a provenance header fail CI. Files whose header version is older than
the current spec and whose referenced section has changed must be regenerated or
manually reconciled and re-stamped.

**Amended v0.2.14 (issue #919), and the amendment is the point of the section.**
Two clauses above used to say something narrower, and the checker faithfully
implemented both:

- **The scan surface was three named directories** — `headless`, `primitives`, `lib`
  — written when those were all there was. `layout/` and `templates/` arrived later
  and were never added, so **29 files were exempt from a CI gate nobody knew they
  were outside**, and 13 of them had simply never been stamped. The surface is now
  _all of `src/`_, stated as a rule about the tree rather than a list beside it, so
  a directory added tomorrow is covered the day it appears. `src/__boundary_tests__/`
  is the one exclusion: those files are deliberate lint violations, not generated
  components, and they exist to be rejected.
- **The document was literally named `SPEC.md`.** There has never been a `SPEC.md`
  in this repo — this document was split into `ui-spec-v02.md` … `ui-spec-v11.md`
  long ago and §3.8 was not re-read — so 170 of 223 source files carried a header
  citing a file that does not exist, and the regex, which only ever checked the
  _shape_ `[\w.-]+\.md`, passed every one of them. The header now names a real
  document and the checker resolves it against `docs/design/`, then `docs/`, which is what makes
  the citation worth reading: a header that cannot be followed to a section is
  decoration.

**Amended again v0.2.17 (issue #976) — the `§` is resolved too, and that is the
whole amendment.** Resolving the document and stopping there was the same defect
one level down: eleven citations named a section that does not exist in the file
they name, and the checker reported green over all of them. Four were not stale
cross-references. `EmptyState` cited §8.25 and `ErrorState` §8.26 — this
document's §8 stops at **8.15 Progress**, and 8.25/8.26 are v0.9's
`CollapsibleSection` and `DisclosureTrigger`. `FormPage` cited §9.2 and
`DetailPage` §9.3 — this document's §9 is the **Changelog**. All four shipped,
and ~34 files were built on them, with a header standing in for a specification
that was never written; §3.8 is where that was supposed to be caught.

- **The valid sections are PARSED from the cited document's headings**, never
  listed beside the checker. A list maintained by hand is precisely the defect
  §3.8 was amended for at v0.2.14 — it goes stale the first time someone adds a
  section and does not know the list exists. Add a heading, and a citation to it
  resolves the same day.
- **Both numbering styles resolve**, because both are in use: the leading dotted
  number of a heading (`## 8.23.8 The static chips` → `§8.23.8`, `# 9. Changelog`
  → `§9`), which is how every `ui-spec-*.md` is cited; and the heading's own
  text for the unnumbered docs (`## Typography` in `design.md` → `§Typography`),
  including with a trailing parenthetical dropped, so `## Surfaces (web-pwa)`
  still answers to `§Surfaces`.
- **Repointing a header at a section that describes something else is worse than
  leaving it broken.** It makes the guard green over a component that still has
  no specification, and removes the only signal that one is missing. If the
  section does not exist, write it: v0.13 is the four sections this amendment
  demanded.

---

# 4. Styling System

## 4.1 Tokens

Salt adopts the shadcn token scheme, emitted as CSS variables on `:root` and `.dark` by the Tailwind preset.

### Semantic colors

- `background`, `foreground`
- `primary`, `primary-foreground`
- `secondary`, `secondary-foreground`
- `secondary-container`, `on-secondary-container`
- `tertiary`, `tertiary-foreground`
- `muted`, `muted-foreground`
- `accent`, `accent-foreground`
- `destructive`, `destructive-foreground`
- `destructive-container`, `on-destructive-container`
- `card`, `card-foreground`
- `popover`, `popover-foreground`
- `border`, `input`, `ring`
- `placeholder` — example text, and nothing else

**`placeholder` is a role, not a shade of `muted-foreground`.** Its job is to be legible _and_ unmistakably not a value, and those pull in opposite directions: it must clear **4.5:1 against the background** (never bought back by fading — ui-spec-v04 §17.5) while sitting far enough off `foreground` that a filled field and an empty one are told apart without clicking in. `muted-foreground` satisfies only the first (8.88:1 on the background, but **1.79:1** off value text — no separation at all), which is why this is its own token rather than a reuse.

Light `#677174` (`hsl(195 6% 43%)`) — 4.79:1 / 3.38:1. Dark `#99a1a3` (`hsl(195 5% 62%)`) — 4.92:1 / 2.32:1. Dark trades value-text separation for an AA pass it did not previously have; every AA-passing dark value does, because `--salt-background` is not dark enough for a three-way split. In dark mode the italic below carries the differentiation alone.

**Colour is never the only channel.** Placeholder text is also `font-style: italic` (WCAG 1.4.1). Both halves are declared in **one `::placeholder` rule in `salt.css`'s `@layer base`** — not per-primitive classes. A base rule reaches hand-rolled `<input>`s in the apps and inputs not yet written, and cannot drift; the per-primitive arrangement it replaced had already drifted to twelve declarations across three mechanisms, two of which styled nothing. `SelectTrigger` is the sole exception and is specified in ui-spec-v03 §3.4: it renders placeholder text into a `<span>`, which no pseudo-element rule can reach. A Tailwind `placeholder:*` utility on an input still beats `@layer base` — do not add one.

### Radius

- `rounded` → `--salt-radius` (4px) — **base/default radius**; see the card-and-row rule in §2.3
- `rounded-sm` → `--salt-radius-sm` (2px)
- `rounded-md` → `--salt-radius-md` (6px)
- `rounded-lg` → `--salt-radius-lg` (10px)
- `rounded-xl` → `--salt-radius-xl` (14px)
- `rounded-full` → `9999px`

### Motion

- `duration-fast` (120ms)
- `duration-base` (180ms)
- `duration-slow` (260ms)
- `ease-standard` (`cubic-bezier(0.2, 0, 0, 1)`)
- `ease-emphasized` (`cubic-bezier(0.3, 0, 0, 1)`)
- `ease-decel` (`cubic-bezier(0, 0, 0, 1)`)

**Choreography tokens.** The three durations above are single-beat; a multi-beat sequence gets its own named token rather than an arbitrary literal. Names are single words on purpose — `generate-tokens` emits `--duration-<word>` as `duration<Word>`, so a hyphenated name would produce an invalid identifier.

- `duration-celebrate` (320ms) — the spring-pop of the check disc (check-off celebration)
- `duration-linger` (440ms) — the beat a tinted checked row holds before it leaves
- `duration-collapse` (320ms) — the checked row's collapse-out. `linger + collapse` is the total hold, kept in step with `CHECK_OFF_HOLD_MS` in `apps/web-pwa/src/lib/checkOffHold.svelte.ts`
- `duration-shimmer` (700ms) — the one-shot sweep across a `CanonIcon` tile (match reveal, ui-spec-v04 §14.5). The JS reveal window that holds `shimmer` true — `REVEAL_SHIMMER_MS` (760ms) in `apps/web-pwa/src/lib/matchReveal.svelte.ts` — must **outlast** this so the one-shot finishes, and not by much (see ui-spec-v04 §14.5.3)
- `duration-reveal` (400ms) — the tile's grey↔sage colour crossfade (match reveal, ui-spec-v04 §14.5)
- `ease-spring` (`cubic-bezier(0.34, 1.56, 0.64, 1)`) — overshoots past 1 and settles back; the only non-monotonic ease here, used for the check disc

Only `duration-fast`/`base`/`slow`/`reveal` are exposed as Tailwind `duration-*` utilities (v4's `duration-<n>` is number-only, so each named one is a static `@utility`); the rest are consumed as `var(--duration-*)` from `salt.css` animations.

### Elevation

- `shadow-sm`, `shadow-md`, `shadow-lg`
- `shadow-popover` (same as shadow-md)
- `shadow-dialog` (same as shadow-lg)

### Z-index

Named utilities (registered in `salt.css`, mirrored in `tokens/z-index.ts`):

- `z-popover` → 40
- `z-dialog` → 50
- `z-tooltip` → 70

**Where these live.** The `@utility z-*` blocks in `salt.css` are the source;
`generate-tokens` extracts them into `src/tokens/z-index.ts` and
`tests/tokens.theme.test.ts` asserts the three values, so CSS and TS cannot
drift. `docs/design/design.md` deliberately carries **no** z-index key: it is the
theme export (colour, typography, radius, spacing, controls) — values a designer
picks and that vary by theme — whereas layering is structural and has no light /
dark or brand variant. `check-theme.ts` therefore has nothing to check here, and
adding a key would only create a fourth copy of numbers already generated from
CSS (see #661).

**The ladder.** Named tokens cover the floating layers, but the app also stacks
things the tokens never named, and a new overlay must pick its rung **by this
table** rather than by choosing a number bigger than whatever it collided with:

| Rung                                 | Value            | What sits here                                                                                                                                                                                                                                                                               |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page & chrome                        | `z-10`           | In-page sticky headers, absolutely-positioned badges, `TopBar` (sticky) and `BottomNav` (fixed). One rung on purpose: a page-local sticky is scoped to its own scroll container and never needs to outrank the chrome. If it does, it belongs on a rung above — not on a bigger number here. |
| Bar above the nav                    | `z-20`           | A fixed bar that sits **clear of** the `BottomNav` rather than over it, offset by the nav's height — the chat composer (`bottom-14`, `lg:bottom-0`). Above page content, below anything that covers the nav.                                                                                 |
| Chrome-replacing bar                 | `z-30`           | A contextual bar that deliberately **covers** the `BottomNav` for the duration of a mode — `ListPage`'s bulk-action bar (ui-spec-v04 §9). Above the nav, below any floating layer.                                                                                                           |
| Popover                              | `z-popover` (40) | Popover, and any anchored floating surface that is not a dialog.                                                                                                                                                                                                                             |
| Dialog / Sheet / full-viewport route | `z-dialog` (50)  | Dialog and Sheet overlays and panels, and a full-viewport route (v0.5 §2).                                                                                                                                                                                                                   |
| Tooltip                              | `z-tooltip` (70) | Above dialogs on purpose: a tooltip inside a dialog must not be clipped by it.                                                                                                                                                                                                               |
| Toast                                | `z-[100]`        | Deliberately top of the ladder. A toast reports something that has already happened and must stay legible over every other layer, including a full-viewport mode.                                                                                                                            |

Two rules follow from the table and are the point of writing it down:

- **A new overlay joins an existing rung or amends this table.** "One more than the thing I collided with" is how a ladder stops being one.
- **Raw `z-<n>` is permitted only below the named tokens** (the first three rungs), where the value is structural rather than a floating layer. At `z-popover` and above, use the token.

**A dropdown opened inside a dialog needs no rung of its own (#674).** It looks
like it does: body-portalled, `SelectContent`/`ComboboxContent` share the root
stacking context with `Dialog`/`Sheet`, so their listbox has to clear the panel
at `z-dialog` (50) and `z-popover` (40) would put it underneath. The resolution
is not a fourth floating rung but a smaller stacking context — those two portal
into the enclosing `DialogContent`/`SheetContent` (§2.5), which is `fixed` at
`z-dialog` and therefore a stacking context of its own. Inside it the listbox is
simply the anchored floating surface the `Popover` rung already describes, and
`z-popover` is correct. This is the general answer: when a new overlay seems to
need a rung above the layer that opened it, put it _inside_ that layer instead.

---

## 4.2 Focus Ring

Utility class: `salt-focus-ring` (registered by preset plugin).

Expands to:

```
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background
```

Applied to every interactive primitive's visible focus target. Never use `focus:` without `-visible`.

---

## 4.3 Disabled + Loading

### Disabled (terminal state — no interaction)

- Attribute: `data-disabled=""`
- ARIA: `aria-disabled="true"`
- Native `disabled` attribute on form controls
- Classes: `opacity-50 pointer-events-none`

### Loading (transient state — disables interaction without terminal semantics)

- Attribute: `data-loading=""`
- ARIA: `aria-busy="true"` + `aria-disabled="true"`
- Click handlers call `preventDefault()` when loading
- Form controls set `disabled={true}` while loading

Both states can coexist visually but `data-disabled` takes precedence for opacity.

---

## 4.4 Shared Size Scale

Sized primitives use one of these scales. Deviation requires a spec amendment.

### Field Size Scale (TextField, Textarea frame, Button)

| size | height | x-padding | text        |
| ---- | ------ | --------- | ----------- |
| `sm` | `h-8`  | `px-3`    | `text-sm`   |
| `md` | `h-9`  | `px-4`    | `text-sm`   |
| `lg` | `h-10` | `px-6`    | `text-base` |

### Control Size Scale (Checkbox, Switch)

| size | Checkbox box  | Switch track | Switch thumb |
| ---- | ------------- | ------------ | ------------ |
| `sm` | `h-3.5 w-3.5` | `h-4 w-7`    | `h-3 w-3`    |
| `md` | `h-4 w-4`     | `h-5 w-9`    | `h-4 w-4`    |
| `lg` | `h-5 w-5`     | `h-6 w-11`   | `h-5 w-5`    |

### Dialog Size Scale

The scale is a **ceiling from `sm` up only**. Width itself is stated in the content
base class (`w-full`), and below the `sm` breakpoint every size collapses to the
base clamp of `max-w-[calc(100%-2rem)]` — one `rem` of gutter each side once the
panel is centred. A phone shows the same dialog at every size.

| size   | max-width (≥ `sm`)           | max-width (< `sm`)        |
| ------ | ---------------------------- | ------------------------- |
| `sm`   | `sm:max-w-sm`                | `max-w-[calc(100%-2rem)]` |
| `md`   | `sm:max-w-md`                | `max-w-[calc(100%-2rem)]` |
| `lg`   | `sm:max-w-2xl`               | `max-w-[calc(100%-2rem)]` |
| `xl`   | `sm:max-w-4xl`               | `max-w-[calc(100%-2rem)]` |
| `full` | `sm:max-w-[calc(100%-2rem)]` | `max-w-[calc(100%-2rem)]` |

**Why the size classes carry an `sm:` modifier.** The base clamp and the size
ceiling are the same tailwind-merge key. Unprefixed, the size class wins and the
mobile clamp is dropped. The modifier makes them distinct keys so both survive.

**Why width is stated rather than left to `max-width`.** `DialogContent` is
`position: fixed` with `left: 50%` and no `right`. With `width: auto` the panel is
shrink-to-fit against `100vw - left` — half the viewport. A `max-w-*` is only a
ceiling the panel was already under, so it cannot correct this. Omitting `w-full`
rendered the photo-import dialog at 221px on a 393px phone — a little over half the
screen, the rest of it being the min-content floor. Do not remove it.

### Text Size Scale (Text primitive)

| size | class             |
| ---- | ----------------- |
| `sm` | `text-label-caps` |
| `md` | `text-body-md`    |
| `lg` | `text-body-lg`    |

### Icon / Spinner sizes

Numeric `number` prop, mapping directly to SVG `width`/`height` in pixels. Default 16. This is intentionally different from the string scale above — icons and spinners are content-sized, not layout-sized.

---

## 4.5 Dark Mode

- Tailwind config uses `darkMode: 'class'`.
- Apps toggle by adding/removing the `dark` class on `<html>`. Salt does not provide a toggle component in v0.2.
- All tokens have `:root` (light) and `.dark` values declared by the preset plugin.
- Primitives never reference dark-mode variants directly — they use semantic tokens that re-resolve under `.dark`.

---

## 4.6 Press Pulse

Utility class: `salt-press-pulse` (a `@utility` in `salt.css`, like `salt-focus-ring` at §4.2).

Expands to:

```css
@media (prefers-reduced-motion: no-preference) {
  &:active {
    transform: scale(0.94);
    transition-duration: 0s;
  }
}
```

**Purpose.** It carries the §8.1 Button press feel — `scale(0.94)`, instant press-in, eased release — to pressables that are **not** the `Button` primitive. `.salt-button` writes the same treatment out longhand rather than pulling this utility in, because it already owns its own `transition-*` block; the two are deliberately duplicated so neither can retime the other. Any change to the press scale must be made in both places.

**What the utility supplies.** Depth only, and only for the duration of the press: the scale, and the `0s` press-in that puts the element down on the frame the finger lands.

**What the call site must supply.** The release. This utility declares nothing in the released state, so the call site owns:

- its own `transition-property` list, which **must include `transform`** — without it there is nothing for the scale to ride on;
- its own per-property durations (the press is `--duration-base`; colour keeps the `--duration-fast` hover beat), written as `transition-[…]` + `[transition-duration:…]` because CSS gives no way to retime one member of a list this utility did not author;
- `ease-standard`, and `motion-reduce:transition-none` if it wants the whole transition gone under reduced motion.

**Specificity, not source order.** The pressed rule is scoped to `:active` so it lands at `(0,2,0)` against a call site's `(0,1,0)`. Tailwind emits this utility _before_ the call sites' timing classes, so an unscoped declaration here would silently lose.

**Reduced motion.** The rule is gated on `no-preference` rather than reset afterwards by a `reduce` block — a rule that never applies is the sturdier "does not move" (same reasoning as `.salt-button`, §8.1). The utility needs no `reduce` reset of its own.

**Consumers** (`apps/web-pwa`): the shopping check-off circle (`shopping/CheckOffButton.svelte`) and the "Need it?" verify/dismiss pair (`shopping/ShoppingListPage.svelte`). This is a public, consumer-facing utility — a non-Button pressable that wants the house press feel uses it rather than re-deriving a scale.

**Forbidden.** Do not add a shade, a colour, or any released-state declaration to this utility. A pressed treatment that should survive reduced motion (colour is not movement) belongs at the call site, outside the gate.

---

# 5. Accessibility System

## 5.1 Universal Requirements

- Tab-reachable unless using roving tabindex.
- Correct ARIA role on the interactive element.
- ARIA state attributes reflect component state (`aria-checked`, `aria-expanded`, etc.).
- Label association: visible `<label>`, `aria-label`, or `aria-labelledby`.
- Error exposure: `aria-invalid="true"` + `aria-describedby` referencing the error element's id.
- Works at 200% zoom, forced-colors mode, and `prefers-reduced-motion: reduce`.

---

## 5.2 Keyboard Map

- Activation: `Space`, `Enter`
- List navigation: `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight` + `Home`/`End`
- Dismiss: `Escape`
- Slider (v0.3): arrows, `PageUp`/`PageDown`, `Home`/`End`
- Radio (v0.3): arrows cycle, `Space` selects

---

## 5.3 Focus Management

- Dialog: trap focus inside content, restore to trigger on close.
- Popover: optional focus trap (`trapFocus` prop).
- Tooltip: never takes focus; never steals focus.

---

# 6. Testing System

## 6.1 Required Test Suites

Each primitive must include these `describe` blocks (exact names):

1. `"renders with minimum required props"`
2. `"props contract"`
3. `"events contract"`
4. `"keyboard interaction"`
5. `"accessibility"`
6. `"composition"` — compound primitives only
7. `"controlled vs uncontrolled"` — stateful primitives only

No snapshot tests. No implementation-detail assertions.

---

## 6.2 Test File Template

Every `tests/<Primitive>.test.ts` follows this shape. This is the copy-source.

```ts
// spec: SPEC.md §6 v0.2.1
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import Button from '../src/primitives/Button/Button.svelte';

describe('Button', () => {
  describe('renders with minimum required props', () => {
    it('renders a button with children', () => {
      render(Button, { props: { children: 'Click me' } });
      expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
    });
  });

  describe('props contract', () => {
    it('applies variant classes', () => {
      render(Button, { props: { variant: 'destructive', children: 'Delete' } });
      expect(screen.getByRole('button')).toHaveClass('bg-destructive');
    });
    it('merges class prop last', () => {
      render(Button, { props: { class: 'custom-class', children: 'x' } });
      expect(screen.getByRole('button')).toHaveClass('custom-class');
    });
    it('sets data-disabled when disabled', () => {
      render(Button, { props: { disabled: true, children: 'x' } });
      expect(screen.getByRole('button')).toHaveAttribute('data-disabled', '');
    });
  });

  describe('events contract', () => {
    it('calls onclick when interactive', async () => {
      const onclick = vi.fn();
      render(Button, { props: { onclick, children: 'x' } });
      await userEvent.click(screen.getByRole('button'));
      expect(onclick).toHaveBeenCalledOnce();
    });
    it('suppresses click when loading', async () => {
      const onclick = vi.fn();
      render(Button, { props: { onclick, loading: true, children: 'x' } });
      await userEvent.click(screen.getByRole('button'));
      expect(onclick).not.toHaveBeenCalled();
    });
  });

  describe('keyboard interaction', () => {
    it('activates on Enter', async () => {
      const onclick = vi.fn();
      render(Button, { props: { onclick, children: 'x' } });
      screen.getByRole('button').focus();
      await userEvent.keyboard('{Enter}');
      expect(onclick).toHaveBeenCalled();
    });
  });

  describe('accessibility', () => {
    it('has no axe violations', async () => {
      const { container } = render(Button, { props: { children: 'x' } });
      expect(await axe(container)).toHaveNoViolations();
    });
    it('requires ariaLabel for icon-only', () => {
      render(Button, { props: { size: 'icon', ariaLabel: 'Settings', children: undefined } });
      expect(screen.getByRole('button')).toHaveAccessibleName('Settings');
    });
  });
});
```

Stateful primitives add a `"controlled vs uncontrolled"` block:

```ts
describe('controlled vs uncontrolled', () => {
  it('uses defaultValue when uncontrolled', () => {
    /* ... */
  });
  it('ignores defaultValue when value is provided', () => {
    /* ... */
  });
  it('fires onValueChange and updates binding on change', async () => {
    /* ... */
  });
});
```

Compound primitives add a `"composition"` block that asserts parts render only inside their root and that context is wired.

---

# 7. Primitive Inventory (v0.2 Core)

See §0.

---

# 8. Primitive Definitions (v0.2 Core)

Each primitive section below is the authoritative contract. The canonical implementation pattern is Button (§3.6) — use it as the template for all others.

---

## 8.1 Button

### Purpose

Trigger an action.

### Props

| Name        | Type                                                         | Default    | Notes                               |
| ----------- | ------------------------------------------------------------ | ---------- | ----------------------------------- |
| `variant`   | `'solid' \| 'outline' \| 'ghost' \| 'link' \| 'destructive'` | `'solid'`  | CVA axis                            |
| `size`      | `'sm' \| 'md' \| 'lg' \| 'icon'`                             | `'md'`     | Field Size Scale + `icon`           |
| `type`      | `'button' \| 'submit' \| 'reset'`                            | `'button'` | native                              |
| `disabled`  | `boolean`                                                    | `false`    | native                              |
| `loading`   | `boolean`                                                    | `false`    | shows spinner                       |
| `fullWidth` | `boolean`                                                    | `false`    | `w-full`                            |
| `ariaLabel` | `string \| undefined`                                        | —          | **required when `size === 'icon'`** |
| `class`     | `string \| undefined`                                        | —          | merged last                         |

### Snippets

- `leading`
- `trailing`
- `default` (label / `children`)

### Events

- `onclick: (e: MouseEvent) => void` — native, suppressed while `disabled` or `loading`.

### Accessibility

- Native `<button>`.
- `loading`: `aria-busy="true"`, `aria-disabled="true"`, click suppressed.
- `disabled`: `aria-disabled="true"`, native `disabled`.
- Icon-only (`size === 'icon'`) requires `ariaLabel`.

### Behavior

- Loading replaces the **leading** snippet with a Spinner.
- Label (`children`) remains visible during loading.
- Trailing snippet is hidden during loading.

#### Press feedback

Every Button answers a press. This is a **system default, not a per-call-site choice** — a button that does not move under the finger reads as broken, and the whole point is that it is the same everywhere. The approved values:

| Facet          | Value                                                                |
| -------------- | -------------------------------------------------------------------- |
| Treatment      | scale + shade                                                        |
| Depth          | `scale(0.94)`                                                        |
| Shade          | one step deeper than hover, per variant — see **Pressed fill** below |
| Press-in       | 0ms — instant, no easing                                             |
| Release        | `--duration-base` (180ms), `--ease-standard`                         |
| Minimum hold   | `--duration-fast` (120ms), enforced in JS (`PRESS_FLOOR_MS`), always |
| Excluded       | `disabled` **and** `loading`                                         |
| Reduced motion | shade only — nothing moves; the floor still runs                     |
| Haptics        | none                                                                 |

**The two halves.** CSS `:active` alone is not enough: a real tap can start and end inside 30ms, and a treatment that lives and dies with `:active` flashes for exactly that long — which reads as nothing happening. So the press is held by JS for a minimum beat and CSS renders it:

- `press()` on pointerdown (primary button only — secondary/middle open menus, they do not activate a button) and on Space/Enter keydown. Key auto-repeat cannot restart the floor.
- `release()` on pointerup, pointercancel, pointerleave, keyup, and blur — so a press that ends off the button, or is stolen by a scroll, still lets go. The release waits out the floor if the press has not been held that long yet; past the floor it is immediate, so a long hold stays pressed for the whole hold.
- While pressed the button carries `data-pressed=""`. `salt.css` keys the treatment off `:active` **or** `[data-pressed]` — the browser's own press and the floor's extension of it, one treatment.
- Losing interactivity mid-press (a click that flips the button to `loading`) drops the press: `disabled` also removes pointer-events, so the matching release would never arrive.

**Exclusions.** `[data-loading]` needs its own exclusion in the selector — per §4.3 a loading button carries `data-loading` but **not** `data-disabled`, so excluding only disabled would still press a loading button.

**Pressed fill.** Each variant deepens one step past its own hover fill. Percentages are `color-mix(in oklab, …)` against `black`; they are **not uniform**, because an 80% mix scales oklab lightness by 0.8 and so takes a proportionally bigger absolute step on a fill that is already light. They are chosen to keep the _perceptual_ step (ΔL from that variant's hover fill) comparable, not to keep the number the same. Light-theme values, computed not eyeballed:

| Variant       | Pressed fill                                                 | Resolved  | Text                             | Contrast    | ΔL from hover |
| ------------- | ------------------------------------------------------------ | --------- | -------------------------------- | ----------- | ------------- |
| `solid`       | `color-mix(in oklab, var(--color-primary) 80%, black)`       | `#254550` | `--color-primary-foreground`     | **10.26:1** | 0.148         |
| `destructive` | `color-mix(in oklab, var(--color-destructive) 80%, black)`   | `#8a1111` | `--color-destructive-foreground` | **9.66:1**  | 0.132         |
| `outline`     | `color-mix(in oklab, var(--color-secondary) 80%, black)`     | `#394930` | `--color-secondary-foreground`   | **9.69:1**  | 0.096         |
| `ghost`       | `color-mix(in oklab, var(--color-muted) 90%, black)`         | `#cdcfcf` | `--color-foreground`             | **10.85:1** | 0.095         |
| `link`        | `color-mix(in oklab, var(--color-primary) 12%, transparent)` | `#e2e8ea` | `--color-primary`                | **5.56:1**  | 0.059         |

All five clear WCAG AA for body text (4.5:1); the four filled variants clear AAA (7:1). The build emits three tiers per rule — Lightning CSS down-levels each `oklab` mix to an `in srgb` one behind `@supports (color: color-mix(in lab, red, red))`, and `outline`/`ghost` add a plain fill ahead of both. All three tiers were checked: the srgb path lands 8.61:1 – 11.66:1, the plain path 6.4:1 / 14.58:1. No tier drops below AA. Notes on the ones that are not simply "80%":

- **`ghost` is 90%, not 80%.** `--color-muted` (`#eceeee`) is near-white, so a flat 80% would be a ΔL of 0.190 — roughly twice solid's step, and it reads as a grey slab rather than a press. 90% puts it at 0.095, matching `outline`.
- **`link` mixes toward `transparent`, not `black`.** It has no hover fill to deepen, so its press introduces one from nothing; a 12% tint of the link's own colour keeps it a text button instead of promoting it to a ghost. Fainter than the other four by design, but still ~1.6× the step `ghost`'s own rest→hover fill makes.
- **`outline` and `ghost` also restate the foreground** their hover sets. A pressed button is not reliably hovered — touch has no hover at all, and the floor holds `data-pressed` past pointerup — so leaning on the hover rule to have recoloured the text would leave `outline` at dark-on-dark (~1.4:1). Those two, alone of the five, therefore also carry a plain fallback `background-color` ahead of the mix: an engine without `color-mix()` drops the mix but keeps the `color`, and white text on `outline`'s unhovered near-white rest fill is invisible. The fallback is the variant's own hover fill — no press deepening, but a readable pairing.

Worth knowing when reading those numbers: on a light page the existing `/90` hovers **lighten**. `bg-primary/90` composites toward the near-white background, so solid's hover fill (`#496f7c`) is measurably _lighter_ than its rest fill (`#35606e`). "One step deeper than hover" is therefore also comfortably deeper than rest — the press cannot be confused with the hover state in either direction.

Specificity: the pressed rules are `(0,5,0)` (`:not()` carries its argument's specificity) against each variant's `(0,2,0)` `:hover`. A pressed button under the cursor is both; pressed wins.

**Reduced motion.** The transform rule is gated on `@media (prefers-reduced-motion: no-preference)` rather than reset by a following `reduce` block. `:not()` carries the specificity of its argument, so the obvious `.salt-button:active { transform: none }` reset loses to the press selector and the button moves anyway; a rule that never applies is the only reliable "does not move". The **pressed-fill rules sit outside that gate** — colour is not movement, and a reduced-motion user who gets no acknowledgement at all is worse served than one who gets a shade. The `reduce` block drops `.salt-button`'s transition entirely, so under the preference the shade lands instantly rather than over 120ms.

The JS floor **runs regardless of the preference**. It is a timer, not an animation, and what it holds on is `data-pressed` — which under `reduce` still renders the shade. (An earlier revision skipped it under the preference, correctly, back when the press was scale-only and a held-but-invisible press was a pointless delay. With a shade in play, skipping it means a quick tap flashes colour for the true pointer-down time — often under a frame — which is the exact "reads as nothing happened" the floor exists to prevent.) Suppressing the _movement_ is CSS's job alone; `Button.headless.svelte.ts` does not read `prefers-reduced-motion`.

**No haptics.** `navigator.vibrate` is deliberately not called. Press feedback is visual only.

Consumer-supplied `onpointerdown` / `onpointerup` / `onpointercancel` / `onpointerleave` / `onkeydown` / `onkeyup` / `onblur` props still fire — Button takes them as props and forwards them rather than letting the spread replace its own listeners.

> §3.6's canonical Button listing predates the press wiring and does not show it; it remains the copy-source for structure, not for the press.

### Styling

Visual styles are defined as `.salt-button--*` CSS component classes in `packages/ui-components/src/salt.css`. `Button.variants.ts` maps CVA axes to these class names (see §3.6).

**Box-model contract:** All button variants carry `border` so that mixed-variant rows (e.g. a `solid` next to an `outline`) share the same computed height. Non-outline variants use `border-transparent` to keep the border invisible while holding the box space; `outline` overrides with `border-secondary`.

| Variant       | Classes                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `solid`       | `border border-transparent bg-primary text-primary-foreground hover:bg-primary/90`                        |
| `outline`     | `border border-secondary text-secondary bg-background hover:bg-secondary hover:text-secondary-foreground` |
| `ghost`       | `border border-transparent bg-transparent hover:bg-muted hover:text-foreground`                           |
| `link`        | `border border-transparent bg-transparent underline-offset-4 hover:underline text-primary`                |
| `destructive` | `border border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90`            |

Those classes carry rest + hover only. The **pressed** fill for each variant is a separate rule keyed off `:active` / `[data-pressed]`, written as longhand `color-mix()` rather than `@apply` — an alpha modifier like `/90` can only fade toward the page, which on a light theme lightens. Values and contrast ratios are in **Press feedback → Pressed fill** above; sizes (`sm`/`md`/`lg`/`icon`) carry no colour and so do not vary the press.

The base `.salt-button` class (applied to every variant) carries layout, typography, and motion tokens; see `salt.css` for the authoritative list. Its transition is written longhand rather than as `transition-[…] duration-*` utilities because the timing is **per property**: colour, background-color and border-color keep the 120ms hover beat (`--duration-fast`), while `transform` — the press — releases over `--duration-base`. The press-in half of that asymmetry is a `transition-duration: 0s` on the pressed rule itself.

### Forbidden

- Do not wrap bits-ui's `Button` — there isn't one; use native `<button>`.
- Do not emit `onClick` (PascalCase) — it's `onclick`.

---

## 8.2 TextField

### Purpose

Single-line text input with label + description + error.

### Props

| Name           | Type                                                            | Default                            |
| -------------- | --------------------------------------------------------------- | ---------------------------------- |
| `value`        | `string` (bindable)                                             | —                                  |
| `defaultValue` | `string`                                                        | `''`                               |
| `label`        | `string \| undefined`                                           | —                                  |
| `description`  | `string \| undefined`                                           | —                                  |
| `error`        | `string \| undefined`                                           | —                                  |
| `type`         | `'text' \| 'email' \| 'password' \| 'url' \| 'tel' \| 'search'` | `'text'`                           |
| `placeholder`  | `string \| undefined`                                           | —                                  |
| `size`         | `'sm' \| 'md' \| 'lg'`                                          | `'md'` (Field Size Scale)          |
| `disabled`     | `boolean`                                                       | `false`                            |
| `readonly`     | `boolean`                                                       | `false`                            |
| `required`     | `boolean`                                                       | `false`                            |
| `autocomplete` | `string \| undefined`                                           | —                                  |
| `name`         | `string \| undefined`                                           | —                                  |
| `id`           | `string`                                                        | generated via `useId('textfield')` |
| `class`        | `string \| undefined`                                           | —                                  |
| `frameClass`   | `string \| undefined`                                           | —                                  |

`class` lands on the outer stack (label + frame + description + error);
`frameClass` lands on the frame itself, merged last via `cn()`. It exists so a
_surface_ can reach the element that paints the field — the value chip
(v0.9 §8.27.5) is the only sanctioned use. It is not a general styling hatch:
anything that changes how a frame looks elsewhere earns a variant on
`textFieldFrameVariants`.

### Snippets

- `leading`
- `trailing`

### Events

- `onValueChange: (value: string) => void`
- `onfocus`, `onblur` (native pass-through)

### Accessibility

- When `label` is provided, `<label for={id}>` renders the visible label.
- When `label` is omitted, the caller **must** supply `aria-label` or `aria-labelledby` on the TextField (the rendered `<input>` will have no programmatic label otherwise).
- Description rendered in a `<span id={descId}>`; referenced via `aria-describedby`.
- Error rendered in a `<span id={errorId}>` with `role="alert"`; id **prepended** to `aria-describedby` when present.
- Error presence sets `aria-invalid="true"`.
- `required` sets `aria-required="true"` and the native `required` attribute.

### Styling (CVA)

Frame wraps `<input>` + leading/trailing snippets.

```
frame base: 'salt-focus-ring-within flex items-center gap-2 rounded-md border border-input bg-background'
frame size: sm='h-8 px-3 text-sm' | md='h-9 px-4 text-sm' | lg='h-10 px-6 text-base'
frame error: 'border-destructive focus-within:ring-destructive'
frame disabled: 'opacity-50 pointer-events-none'
input: 'flex-1 bg-transparent outline-none'
label: 'text-sm font-medium text-foreground'
description: 'text-sm text-muted-foreground'
error text: 'text-sm text-destructive'
```

Focus ring is applied to the **frame** via `focus-within:`, not to the raw `<input>`.

Placeholder styling is **not** declared here — see §4.1. The `::placeholder` base rule owns it, and a `placeholder:*` utility on this element would override it.

### Error-message rendering

Error element renders **below** the input frame, always has `role="alert"`, is announced on change (live region). Rendered when `error` is a non-empty string — empty string or `undefined` means no error.

### Forbidden

- No custom `type` values beyond the listed set (use v0.3 Select/Slider for number selection, etc.).
- Do not attach focus ring to the `<input>` directly.

---

## 8.3 Textarea

Same contract as TextField except:

- No `type` prop.
- Adds:
  - `rows: number = 3`
  - `autoresize: boolean = false`
  - `maxLength?: number`
  - `element?: HTMLTextAreaElement | undefined` (bindable) — see [Element handle](#element-handle)
- Frame height is `auto` instead of the Field Size Scale height — size still controls padding/text.

### Element handle

`bind:element` exposes the underlying `<textarea>` DOM node.

**Why it exists.** Some interactions are properties of the DOM node itself and
cannot be expressed through `value`/`onValueChange`: reading `selectionStart` /
`selectionEnd`, and writing through `setRangeText`. A formatting toolbar over a
textarea needs exactly those. Exposing the one node is smaller and more honest
than growing a bespoke prop per such need.

**Contract:**

- Optional and **inert when unbound**. The component holds this same reference
  internally for autoresize, so a consumer that does not bind it is unaffected.
- Text remains owned by `value` / `onValueChange`. A consumer that mutates the
  node directly must dispatch an `input` event (`new Event('input', { bubbles:
true })`) so the component's own handler updates `value` and notifies the
  caller — `setRangeText` does not fire one by itself.
- Do not use it to bypass the primitive for styling, focus management, or
  reading the value; those have props.

### Size styling

```
frame base: same as TextField, but h-auto min-h-[calc(theme(spacing.9))]
frame size: sm='px-3 text-sm min-h-[theme(spacing.8)]' | md='px-4 text-sm min-h-[theme(spacing.9)]' | lg='px-6 text-base min-h-[theme(spacing.10)]'
textarea: 'flex-1 bg-transparent outline-none resize-none py-2'
```

Placeholder styling is **not** declared here — see §4.1. The `::placeholder` base rule owns it, and a `placeholder:*` utility on this element would override it.

### Autoresize

- Grows with content via `$effect` that adjusts `textarea.style.height`.
- Never shrinks below `rows * line-height`.
- `maxLength` enforces character cap via native attribute.

---

## 8.4 Checkbox

### Props

| Name             | Type                                    | Default                     |
| ---------------- | --------------------------------------- | --------------------------- |
| `checked`        | `boolean \| 'indeterminate'` (bindable) | `false`                     |
| `defaultChecked` | `boolean \| 'indeterminate'`            | `false`                     |
| `label`          | `string \| undefined`                   | —                           |
| `labelledBy`     | `string \| undefined`                   | —                           |
| `description`    | `string \| undefined`                   | —                           |
| `error`          | `string \| undefined`                   | —                           |
| `disabled`       | `boolean`                               | `false`                     |
| `required`       | `boolean`                               | `false`                     |
| `name`           | `string \| undefined`                   | —                           |
| `value`          | `string`                                | `'on'`                      |
| `size`           | `'sm' \| 'md' \| 'lg'`                  | `'md'` (Control Size Scale) |
| `class`          | `string \| undefined`                   | —                           |

### Snippets

- `default` (overrides `label`)
- `description`

### Events

- `onCheckedChange: (checked: boolean | 'indeterminate') => void`

### Accessibility

- Uses bits-ui `Checkbox.Root` + `Checkbox.Indicator`.
- `role="checkbox"`, `aria-checked` reflects state (`'mixed'` for indeterminate).
- `Space` toggles between unchecked ↔ checked; never cycles through indeterminate.
- Indeterminate state settable only via props.

### Styling

```
root base: 'salt-focus-ring peer shrink-0 rounded border border-input bg-background data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground'
root size: sm='h-3.5 w-3.5' | md='h-4 w-4' | lg='h-5 w-5'
indicator: 'flex items-center justify-center text-current'
label: 'text-sm font-medium text-foreground peer-data-[disabled]:opacity-50'
```

### Forbidden

- Do not render a native `<input type="checkbox">` — use bits-ui `Checkbox.Root`.

---

## 8.5 Switch

### Props

| Name             | Type                   | Default                     |
| ---------------- | ---------------------- | --------------------------- |
| `checked`        | `boolean` (bindable)   | `false`                     |
| `defaultChecked` | `boolean`              | `false`                     |
| `disabled`       | `boolean`              | `false`                     |
| `required`       | `boolean`              | `false`                     |
| `name`           | `string \| undefined`  | —                           |
| `value`          | `string`               | `'on'`                      |
| `label`          | `string`               | **required**                |
| `description`    | `string \| undefined`  | —                           |
| `error`          | `string \| undefined`  | —                           |
| `size`           | `'sm' \| 'md' \| 'lg'` | `'md'` (Control Size Scale) |
| `class`          | `string \| undefined`  | —                           |

### Events

- `onCheckedChange: (checked: boolean) => void`

### Accessibility

- Uses bits-ui `Switch.Root` + `Switch.Thumb`.
- `role="switch"`, `aria-checked`.
- `Space` / `Enter` toggle.

### Styling

```
root base: 'salt-focus-ring inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors motion-reduce:transition-none data-[state=checked]:bg-primary data-[state=unchecked]:bg-input'
root size: sm='h-4 w-7' | md='h-5 w-9' | lg='h-6 w-11'
thumb base: 'pointer-events-none block rounded-full bg-background shadow-sm transition-transform motion-reduce:transition-none data-[state=unchecked]:translate-x-0'
thumb size: sm='h-3 w-3 data-[state=checked]:translate-x-3' | md='h-4 w-4 data-[state=checked]:translate-x-4' | lg='h-5 w-5 data-[state=checked]:translate-x-5'
```

---

## 8.6 Dialog

### Parts

- `Dialog.svelte` (Root)
- `DialogTrigger.svelte`
- `DialogContent.svelte`
- `DialogHeader.svelte`
- `DialogTitle.svelte`
- `DialogDescription.svelte`
- `DialogFooter.svelte`
- `DialogClose.svelte`

### Root Props

| Name          | Type                             | Default  |
| ------------- | -------------------------------- | -------- |
| `open`        | `boolean` (bindable)             | `false`  |
| `defaultOpen` | `boolean`                        | `false`  |
| `portal`      | `HTMLElement \| string \| false` | `"body"` |
| `class`       | `string \| undefined`            | —        |

### Content Props

| Name    | Type                                     | Default                    |
| ------- | ---------------------------------------- | -------------------------- |
| `size`  | `'sm' \| 'md' \| 'lg' \| 'xl' \| 'full'` | `'md'` (Dialog Size Scale) |
| `class` | `string \| undefined`                    | —                          |

### Events (Root)

- `onOpenChange: (open: boolean) => void`

### Accessibility

- Focus trap inside `DialogContent`.
- Focus restored to trigger on close.
- `role="dialog"`, `aria-modal="true"`.
- `DialogTitle` required — wired via `aria-labelledby`.
- `DialogDescription` optional — wired via `aria-describedby`.

### Styling

```
overlay: 'fixed inset-0 z-dialog bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:animate-none'
content base: 'fixed left-1/2 top-1/2 z-dialog grid w-full max-w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-lg border bg-background p-6 shadow-dialog'
content size: see §4.4 Dialog Size Scale
header: 'flex flex-col gap-1.5'
title: 'text-lg font-semibold text-foreground'
description: 'text-sm text-muted-foreground'
footer: 'flex justify-end gap-2'
close: styled as ghost Button, size='icon'
```

### Overflow

The panel is capped at `calc(100dvh-2rem)` and scrolls its own content. A dialog is
free to be taller than the viewport; it is never allowed to put its footer out of
reach. `dvh` rather than `vh` because mobile browser chrome makes `vh` overstate the
visible height. `overscroll-contain` stops a scroll that reaches the end of the
panel from chaining to the page behind the overlay.

Consequence for content: a `DialogContent` child must not itself be a viewport-height
box, and anything positioned outside the panel's padding box will be clipped by the
scroll container.

### Forbidden

- Do not implement a custom portal — use `Dialog.Portal` from bits-ui.
- Do not render `DialogContent` outside a `Dialog` root.
- Do not drop `w-full` from the content base, and do not "simplify" the size scale
  by removing the `sm:` modifiers — see §4.4 for what each is holding up.

---

## 8.7 Popover

### Parts

- `Popover.svelte` (Root)
- `PopoverTrigger.svelte`
- `PopoverContent.svelte`

### Props (Root)

| Name          | Type                             | Default  |
| ------------- | -------------------------------- | -------- |
| `open`        | `boolean` (bindable)             | `false`  |
| `defaultOpen` | `boolean`                        | `false`  |
| `portal`      | `HTMLElement \| string \| false` | `"body"` |
| `trapFocus`   | `boolean`                        | `false`  |
| `class`       | `string \| undefined`            | —        |

### Props (Content)

| Name         | Type                                     | Default    |
| ------------ | ---------------------------------------- | ---------- |
| `side`       | `'top' \| 'right' \| 'bottom' \| 'left'` | `'bottom'` |
| `align`      | `'start' \| 'center' \| 'end'`           | `'center'` |
| `sideOffset` | `number`                                 | `4`        |
| `class`      | `string \| undefined`                    | —          |

### Events (Root)

- `onOpenChange: (open: boolean) => void`

### Styling

```
content: 'z-popover w-72 rounded-md border bg-popover text-popover-foreground p-4 shadow-popover data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:animate-none'
```

---

## 8.8 Tooltip

### Parts

- `TooltipProvider.svelte`
- `Tooltip.svelte` (Root)
- `TooltipTrigger.svelte`
- `TooltipContent.svelte`

`TooltipTrigger` forwards `class` and native attributes (`aria-*`, `data-*`, …) to the underlying bits-ui trigger `<button>`, so callers can style the hover/focus/tap target; children-only usage stays backward-compatible.

### Props (Root)

| Name                         | Type                 | Default |
| ---------------------------- | -------------------- | ------- |
| `open`                       | `boolean` (bindable) | —       |
| `defaultOpen`                | `boolean`            | `false` |
| `delayDuration`              | `number`             | `700`   |
| `disableHoverableContent`    | `boolean`            | `false` |
| `disableCloseOnTriggerClick` | `boolean`            | `false` |
| `ignoreNonKeyboardFocus`     | `boolean`            | `false` |

Per §1.4, the bindable `open` also exposes the matching `onOpenChange` callback. `disableCloseOnTriggerClick` and `ignoreNonKeyboardFocus` are pass-through to bits-ui `Tooltip.Root` and exist to make a tooltip readable on touch (see Behavior).

### Props (Content)

| Name         | Type                                     | Default |
| ------------ | ---------------------------------------- | ------- |
| `side`       | `'top' \| 'right' \| 'bottom' \| 'left'` | `'top'` |
| `sideOffset` | `number`                                 | `4`     |
| `class`      | `string \| undefined`                    | —       |

### Behavior

- Never takes focus.
- Open on hover + keyboard focus of the trigger.
- Close on `Escape`, pointer leave, or blur.

**Touch (tap-to-toggle).** Touch devices have no hover, and a single tap both focuses **and** clicks the trigger, so the default hover/focus model is unusable on touch. To make a tooltip readable on touch, drive `open` yourself (controlled) and toggle it on tap, combining:

- `disableCloseOnTriggerClick` — the tap's click does not immediately re-close the tooltip it just opened.
- `ignoreNonKeyboardFocus` — the incidental focus a tap incurs does not open the tooltip (only real keyboard focus does), so the tap's focus-open cannot race the click toggle.

Both are optional, default `false`, and pass straight through to bits-ui `Tooltip.Root`. Mouse hover and keyboard `Tab` focus still open the tooltip normally; a missing/absent pair leaves the classic hover-only behaviour unchanged.

### Styling

```
content: 'z-tooltip rounded-md bg-foreground text-background px-2 py-1 text-xs shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out motion-reduce:animate-none'
```

### Forbidden

- Do not make tooltip content interactive.
- Do not use tooltip for critical information (it's not reliably discoverable on touch).

---

## 8.9 Card

### Parts

- `Card.svelte`
- `CardHeader.svelte`
- `CardTitle.svelte`
- `CardDescription.svelte`
- `CardContent.svelte`
- `CardFooter.svelte`

### Props (all parts)

| Name    | Type                  | Default |
| ------- | --------------------- | ------- |
| `class` | `string \| undefined` | —       |

### Styling

```
card: 'rounded border bg-card text-card-foreground shadow-sm'
header: 'flex flex-col gap-1.5 p-6'
title: 'text-lg font-semibold leading-none tracking-tight'
description: 'text-sm text-muted-foreground'
content: 'p-6 pt-0'
footer: 'flex items-center p-6 pt-0'
```

Pure styled `<div>`s — no state, no headless layer.

---

## 8.10 Heading

### Props

| Name    | Type                         | Default |
| ------- | ---------------------------- | ------- |
| `level` | `1 \| 2 \| 3 \| 4 \| 5 \| 6` | `2`     |
| `class` | `string \| undefined`        | —       |

Renders `<h{level}>`. Snippet: `default` (children).

### Styling

```
base: 'font-display font-semibold tracking-tight text-foreground'
level: 1='text-display' | 2='text-h1' | 3='text-h2' | 4='text-body-lg' | 5='text-body-md' | 6='text-label-caps'
```

---

## 8.11 Text

### Props

| Name    | Type                     | Default                  |
| ------- | ------------------------ | ------------------------ |
| `as`    | `'p' \| 'span' \| 'div'` | `'p'`                    |
| `size`  | `'sm' \| 'md' \| 'lg'`   | `'md'` (Text Size Scale) |
| `muted` | `boolean`                | `false`                  |
| `class` | `string \| undefined`    | —                        |

### Styling

```
base: 'leading-normal'
size: see §4.4 Text Size Scale
muted: true='text-muted-foreground' | false='text-foreground'
```

Note: `as` is constrained to a union — **not** an arbitrary string — to keep the component statically analyzable.

---

## 8.12 Icon

### Props

| Name        | Type                                     | Default      |
| ----------- | ---------------------------------------- | ------------ |
| `name`      | `IconName` — `keyof typeof iconRegistry` | — (required) |
| `size`      | `number`                                 | `16`         |
| `ariaLabel` | `string \| undefined`                    | —            |
| `class`     | `string \| undefined`                    | —            |

### Icon registry

`name` is keyed off a **curated registry**, not the whole Lucide library. `src/primitives/Icon/iconRegistry.ts` imports each icon it offers from that icon's own `@lucide/svelte/icons/<kebab-name>` subpath and re-exports them as one record; `Icon.svelte` indexes that record. The `icons` namespace barrel must not be imported: it is a namespace object, so nothing tree-shakes and all 1,764 icon modules ship (633 kB / 109 kB gzipped in Salt's boot payload, for ~70 icons drawn — issue #813).

The registry is hand-maintained and its surface is deliberately closed:

- Adding an icon is one import plus one record entry, both alphabetical.
- `IconName` narrows to the registry's keys, so an unregistered name is a `pnpm check` / `pnpm typecheck` failure naming the missing key. **That compile error is the maintenance mechanism** — there is no generator and no CI staleness check, because no icon name crosses Firestore, a URL, or any other serialization boundary: every one is a static TS literal the compiler already proves.
- `iconNames` (the keys, derived via `Object.keys`) is exported from the package surface so a gallery consumer renders the real set instead of keeping a second list to drift.

A **direct named import** (`import Check from '@lucide/svelte/icons/check'`, or `import { Check } from '@lucide/svelte'`) is unaffected by this and stays the right call inside a primitive that always draws the same icon — it already tree-shakes. The registry exists only for `Icon`'s string-keyed indirection.

### Accessibility

- Without `ariaLabel`: `aria-hidden="true"` (decorative).
- With `ariaLabel`: `role="img"` + `aria-label={ariaLabel}`.

### Styling

```
base: 'shrink-0'
```

SVG `width` / `height` attributes set to `size`; `class` can override via `w-*`/`h-*`.

---

## 8.13 Layout Primitives — Stack / Inline / Grid / Divider

### Stack

| Prop      | Type                                            | Default     |
| --------- | ----------------------------------------------- | ----------- |
| `gap`     | `'0' \| '1' \| '2' \| '3' \| '4' \| '6' \| '8'` | `'4'`       |
| `align`   | `'start' \| 'center' \| 'end' \| 'stretch'`     | `'stretch'` |
| `justify` | `'start' \| 'center' \| 'end' \| 'between'`     | `'start'`   |
| `class`   | `string \| undefined`                           | —           |

Renders `<div class="flex flex-col gap-{gap} items-{align} justify-{justify}">`. `gap` values map to Tailwind's spacing scale.

### Inline

Same props as Stack. Renders `<div class="flex flex-row ...">`.

### Grid

| Prop    | Type                          | Default |
| ------- | ----------------------------- | ------- |
| `cols`  | `1 \| 2 \| 3 \| 4 \| 6 \| 12` | `2`     |
| `gap`   | (same as Stack)               | `'4'`   |
| `class` | `string \| undefined`         | —       |

Renders `<div class="grid grid-cols-{cols} gap-{gap}">`.

### One source for the shared maps

`gap` is the same seven-entry map in all three, and `align`/`justify` are the same
four-entry maps in Stack and Inline. They are declared **once**, in a module the
three variant files import; each primitive keeps its own `cva` call, its own base
class (`flex flex-col` / `flex flex-row` / `grid`), its own `defaultVariants`, its
own exported name and its own exported `VariantProps` type. Only the maps are
shared — the thing that was three copies of the same table. `Grid`'s `cols` map and
`Divider` are unaffected.

### Divider

| Prop          | Type                         | Default        |
| ------------- | ---------------------------- | -------------- |
| `orientation` | `'horizontal' \| 'vertical'` | `'horizontal'` |
| `class`       | `string \| undefined`        | —              |

Renders a `<div role="separator">`. Styling:

```
horizontal: 'h-px w-full bg-border'
vertical:   'w-px h-full bg-border'
```

---

## 8.14 Spinner

### Props

| Name        | Type                  | Default     |
| ----------- | --------------------- | ----------- |
| `size`      | `number`              | `16`        |
| `ariaLabel` | `string`              | `'Loading'` |
| `class`     | `string \| undefined` | —           |

### Accessibility

- `role="status"`, `aria-label={ariaLabel}`.
- SVG itself `aria-hidden="true"`.

### Styling

Inline SVG with `animate-spin motion-reduce:animate-none`. Stroke uses `currentColor`.

---

## 8.15 Progress

### Props

| Name           | Type                             | Default     |
| -------------- | -------------------------------- | ----------- |
| `value`        | `number \| undefined` (bindable) | `undefined` |
| `defaultValue` | `number \| undefined`            | `undefined` |
| `max`          | `number`                         | `100`       |
| `announce`     | `'polite' \| 'off'`              | `'polite'`  |
| `ariaLabel`    | `string \| undefined`            | —           |
| `class`        | `string \| undefined`            | —           |

### Behavior

- `value === undefined` → **indeterminate** mode: indicator animates; `aria-valuenow` omitted.
- `value` is a finite number → **determinate** mode: indicator width = `(value / max) * 100%`.
- `value < 0` or `value > max` → clamp to range.

### Accessibility

- Uses bits-ui `Progress.Root` + `Progress.Indicator`.
- `role="progressbar"`.
- `aria-valuemin="0"`, `aria-valuemax={max}`, `aria-valuenow={value}` (determinate only).
- `aria-label={ariaLabel}` or `aria-labelledby` required if not visually labeled.
- `aria-live={announce}` when announce is `'polite'`.

### Styling

```
root: 'relative h-2 w-full overflow-hidden rounded-full bg-muted'
indicator determinate: 'h-full bg-primary transition-transform motion-reduce:transition-none'
indicator indeterminate: 'h-full w-1/3 bg-primary animate-[salt-progress-indeterminate_1s_ease_infinite] motion-reduce:animate-none'
```

Numeric transform (allowed by §2.3): determinate indicator uses `style="transform: translateX(-{100 - percent}%)"`.

### Forbidden

- Do not fire `onValueChange` — Progress value is driven by the consumer, not the primitive.

---

# 9. Changelog

| Date       | Version | Summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-30 | v0.2.19 | §3.1 Folder Structure: named `lib/layoutVariants.ts` in the tree — the module v0.2.18's §8.13 amendment called for without siting, now that it exists. It holds the gap, align and justify maps `stackVariants`, `inlineVariants` and `gridVariants` read; each primitive keeps its own `cva` call, base class, `defaultVariants` and exported type. Recorded rather than left implicit because §3.1's `lib/` block enumerates the real files, and a tree that omits one is the drift #978 is open against. No primitive contract changed; no provenance header re-stamped. Issue #929 Phase 4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-08-30 | v0.2.18 | §2.3 Styling Rules, §2.5 Composition Rules, §3.1 Folder Structure, §8.13 Layout Primitives: the spec catches up with four things the package already does or is about to. **§2.3** replaces the pre-v4 line "Tailwind utilities only — no raw CSS files except the preset" with the rule actually followed — a `.salt-*` class when a visual identity is shared across primitives (`.salt-control`, `.salt-input`, `.salt-trigger`) or is multi-state enough that utilities express it badly (`.salt-button`, `.salt-chip`, `.salt-dial`, `.salt-tabs`, `.salt-collapsible`); utilities inline for surfaces and layout that share styling with nothing (Card, Dialog, Sheet, Popover, Tooltip, Text, Stack, Inline, Grid); both on one element is allowed (`salt-focus-ring` + utilities). This **retires finding `B5-016`** of the #894 review as REFUTED — the reported inconsistency is the rule, and **no primitive is converted**. **§3.1** sanctions two things the tree needs: a headless module serving several primitives (one field-state module for TextField, Textarea, Checkbox and Switch, generalising the old "Textarea reuses TextField.headless" note, with the `useId` prefix as a parameter), and a compound part shared by two primitives living once, in the primitive owning the base behaviour, published under both names from `src/index.ts` — no wrapper and no neutral third directory. **§2.5** records that Select and Combobox share one portal-mount helper and one floating-ui positioning helper, so the #674/#640 fix has one implementation; their keyboard handlers stay two. **§8.13** records one source for Stack/Inline/Grid's gap, align and justify maps, base classes and `cva` calls staying per-primitive. No primitive contract changed, so no provenance header is re-stamped by this amendment. Issue #929 Phase 1.                                                                             |
| 2026-08-28 | v0.2.17 | §3.8 Provenance Header Convention: the cited **`§` is resolved**, not just the document. Resolving the filename and stopping there left eleven citations naming a section that does not exist in the file they name, all reported green — and four of them (`EmptyState` §8.25, `ErrorState` §8.26, `FormPage` §9.2, `DetailPage` §9.3, none of which exist in this document) were placeholders for a specification nobody had written, under ~34 consuming files. The valid sections are parsed from the cited document's own headings — never a hand-maintained list, which is the v0.2.14 defect — and both numbering styles resolve, the dotted number and, for the unnumbered docs, the heading text. The four missing specs are written as **v0.13** rather than repointed, and those files are re-stamped; `src/index.ts`'s `ui-spec-v03.md §1.3` is corrected to this document's §1.3 Package Surface. Issue #976.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-08-24 | v0.2.16 | §3.3 Tailwind + Token Ownership, plus §1.1 Animations, §1.3 Package Surface, §3.1 Folder Structure, §3.2 Export Rules and §3.4: the spec stops describing a **Tailwind v3 preset that has not existed since #323**. §3.3 named `src/tailwind-preset.ts` as the single source of truth for tokens, printed its shape, and told apps to register it as a `presets: [salt]` entry — but the CSS-first `src/salt.css` replaced all of it, `@salt/ui-components/tailwind-preset` is not in `package.json`'s `exports` map, and the animation utilities come from `tw-animate-css` imported by the stylesheet rather than `tailwindcss-animate` registered by a preset. §3.3 now points at `salt.css` for the parse contract (its header comment carries it, so this file does not repeat it) and at `design.md`'s frontmatter as the palette of record that `check-theme.ts` diffs against. The **#491 dead names go with it, everywhere they are named**: `headless.ts` and `test.ts` were removed as dead surface in #491 and §1.3 already said so in prose, yet the same section still printed a `src/headless.ts` barrel and a `src/test.ts` barrel below the note, §3.1's tree still listed both files and §3.2's side-effect bullet still cited `src/headless.ts` as an example barrel. All four are struck, and §1.3 states outright that neither file exists. §1.3's tokens-barrel line is corrected in the same pass: `src/tokens.ts` has **no default export** and never carried a preset object — it is six `export * as` lines generated from `salt.css`. Documentation only — no primitive contract changed, so nothing to re-stamp. Issue #921.                                                                                                                                                                                                                                                                                         |
| 2026-08-24 | v0.2.15 | §3.1 Folder Structure, §3.2 Export Rules, §3.6 Canonical Patterns: the **per-component `index.ts` local barrel is struck**. §3.1 put one in every `primitives/<Primitive>/` directory and §3.6 made Button's the last step of the worked example — but the same document ends §1.3 with **"No deep imports."**, and `package.json`'s `exports` map publishes only `.`, `./tokens` and `./styles.css`, so nothing outside the package could reach a local barrel even if it wanted to. The spec was prescribing a surface its own rules made unreachable. Re-measured on this branch over all 1,565 first-party `.ts` / `.js` / `.svelte` files: **0 import sites anywhere resolve to one**, and all **155** `from` specifiers on `src/index.ts` name a leaf file directly — not one of the 209 public names routed through a barrel. So the 40 files re-exported 223 names by a path no code took. 31 of those names (30 `*Variants` CVA factories, plus `Textarea`, which the package barrel republished as `TextArea` until #1062 renamed the export to match) are not on the public surface at all; each is still exported by its own `.variants.ts` / `.svelte` file, which is where its siblings already import it from. **#491 is the precedent, and §1.3 records it**: the aggregating `headless` barrel and the `test` placeholder were removed as dead surface because nothing consumed either subpath. §3.2's local-barrel bullet is replaced by the positive rule it leaves behind — a component becomes public by being named on `src/index.ts`, leaf file by leaf file, so the package surface is exactly what that one file says it is — and §3.6's `src/primitives/Button/index.ts` block becomes the two lines Button actually occupies there. The public surface does not move by a single name: `src/index.ts` is byte-identical and all 209 exports remain. No primitive contract changed; nothing is re-stamped. Issue #923. |
| 2026-08-24 | v0.2.14 | §3.8 Provenance Header Convention: the scan surface becomes **all of `src/`** (minus `src/__boundary_tests__/`) instead of the three directories `headless`, `primitives`, `lib` that existed when it was written — `layout/` and `templates/` had been outside the CI gate since they were created, and 13 layout files had never been stamped at all. And the header now names **a real document in `docs/design/`**, checked by resolving it, instead of the literal `SPEC.md`: no such file has ever existed in this repo (this document was split into `ui-spec-v02.md` … `ui-spec-v11.md`), yet 170 of 223 source files cited it and the shape-only regex passed every one. The multi-citation form already in use (`a.md §1 v0.1; b.md §2 v0.2 (note)`) is written down rather than left to the two files that had guessed it. All 170 headers are re-pointed at the document their version already identified — a `v0.4` header was always an ui-spec-v04.md header — and the 13 unstamped layout files are stamped against ui-spec-v04 §13/§16, which is where they are specified (§0 of that document says so). No primitive contract changed; nothing is re-stamped for behaviour. Issue #919.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-08-16 | v0.2.13 | §4.1 Tokens: the semantic colour list gains **`destructive-container`, `on-destructive-container`** — the destructive counterpart to the sage `secondary-container` pair already listed above it, and the surface a _removed_ change is tinted with in the recipe review gate where an addition gets the sage one. The values are not new: they are `design.md`'s long-standing `error-container` / `on-error-container` (light `#ffdad6` / `#93000a`), which PR #832 plumbed through to `salt.css` and `tokens/colors.ts` for the first time. This row records that plumbing in the spec — the code shipped without it because #832's governing issue forbade amending the UI spec in that diff. Naming follows `secondary-container` exactly, including its asymmetry: the CSS variable is `--salt-on-destructive-container` while the Tailwind utility is `destructive-container-foreground`. No primitive contract changed, so nothing is re-stamped. Issue #833.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-08-15 | v0.2.12 | §4.1 Tokens: new semantic colour role **`placeholder`** (light `#677174`, dark `#99a1a3`) plus the rule that example text is styled by **one `::placeholder` rule in `salt.css`'s `@layer base`**, in colour **and** `font-style: italic`, never per-primitive. The old arrangement was `placeholder:text-muted-foreground` copied across twelve sites in three mechanisms, two of which styled nothing and fell back to the browser default — and `muted-foreground` sits **1.79:1** from value text, so an empty field looked filled and a long form could only be reviewed by clicking into every field. The new role holds 4.79:1 on the background (AA with margin, so the difference is never bought by fading — ui-spec-v04 §17.5) at 3.38:1 off value text; italic is the second, non-colour channel WCAG 1.4.1 requires and ships as a real `@fontsource-variable/inter` italic face, latin subset only (51.8 kB). §8.2 and §8.3 accordingly drop `placeholder:text-muted-foreground` from their class matrices and gain a pointer to §4.1. A base rule reaches hand-rolled inputs and inputs not yet written, which is why the drift cannot recur — but a `placeholder:*` utility still beats `@layer base`, so adding one reopens it. `SelectTrigger` is the one thing no such rule can reach (its placeholder is a `<span>`) and is specified in ui-spec-v03 §3.4. Contract change — `TextField.svelte`, `Textarea.svelte` re-stamped. Issue #821 Phase 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-08-14 | v0.2.11 | §8.12 Icon + §1.1 Icons row: `name` is keyed off a **curated registry** (`src/primitives/Icon/iconRegistry.ts`) instead of `keyof typeof import('@lucide/svelte').icons`. The `icons` barrel is a namespace object, so nothing tree-shook and all 1,764 icon modules shipped — **632.75 kB (108.75 kB gzipped), the single largest item in the PWA's boot payload**, to draw the ~70 icons Salt actually uses. The registry imports each icon from its own `@lucide/svelte/icons/<kebab-name>` subpath, so only registered icons ship. New §8.12 "Icon registry" records that it is hand-maintained, that the narrowed `IconName` union turns an unregistered name into a `pnpm check` failure (the whole maintenance mechanism — no generator, no CI staleness check, because no icon name crosses a serialization boundary), and that direct named imports inside single-icon primitives are unaffected and stay correct. `iconNames` joins the package surface (§1.3) so Storybook's gallery renders the real set rather than a second hand-list. Contract change — `Icon.svelte`, `Icon.types.ts` re-stamped; `ListPage.types.ts`'s `BulkActionIcon` re-pointed. Issue #813 Phase 1. **v0.2.10 is absent from this table on purpose:** #691 bumped the header to it without adding a row, so the number is already spent — pre-existing doc drift, not amended here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-08-02 | v0.2.9  | §8.6 Dialog + §4.4 Dialog Size Scale: the content base gains `w-full`, a mobile `max-w-[calc(100%-2rem)]` clamp, and `max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain`; the size scale becomes an `sm:`-and-up ceiling. The base stated no width at all, so a `position: fixed` panel with `left: 50%` and no `right` was shrink-to-fit against `100vw - left` — **every dialog was capped at roughly half the viewport width** (the photo-import dialog of #676 measured 221px on a 393px phone), with `max-w-*` powerless to correct it — a ceiling the panel was already under. The `sm:` modifiers keep the mobile clamp alive through tailwind-merge. Height is capped so a panel taller than the viewport scrolls rather than putting its footer out of reach. Behavioural amendment — `Dialog.variants.ts` re-stamped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-07-28 | v0.2.8  | §4.6 **Press Pulse**: specs the `salt-press-pulse` CSS utility as a public, consumer-facing extension point alongside `salt-focus-ring` (§4.2) — what it supplies (depth only: `scale(0.94)` + the `0s` press-in), what the call site retains (its own `transition-property` list including `transform`, its own per-property durations, `ease-standard`, `motion-reduce:transition-none`), why the pressed rule is `:active`-scoped (specificity, not source order), and the `no-preference` gate. Records that `.salt-button` writes the same treatment longhand rather than pulling the utility in — the duplication is deliberate (the Button owns its own `transition-*`) and any change to the press scale must land in both places. Shipped unrecorded in #583 alongside the v0.2.7 Button press system; no code change. Resolves doc/code drift issue #588.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-07-24 | v0.2.7  | §8.1 Button: recorded the system-wide **press feedback** contract — `scale(0.94)`, instant press-in / 180ms (`--duration-base`, `--ease-standard`) release, a 120ms (`--duration-fast`) JS minimum-hold floor so a too-quick click is still visible, `disabled` **and** `loading` excluded, reduced motion = shade only (no movement), no haptics. Adds the `data-pressed` attribute and the pointer/keyboard wiring behind it. **Both halves are now implemented:** the scale, and the per-variant **pressed fill** — each variant one perceptual step deeper than its own hover, as longhand `color-mix(in oklab, …)` (solid/destructive/outline 80% toward black, ghost 90% because `--color-muted` is near-white, link a 12% tint since it has no hover fill to deepen). Values, resolved hexes, and computed light-theme contrast ratios (5.56:1 – 10.85:1, all AA) recorded in §8.1. The fill rules sit **outside** the `prefers-reduced-motion: no-preference` gate that holds the transform, so a shade survives the preference; correspondingly the JS floor (`PRESS_FLOOR_MS`) **no longer skips under reduced motion** — it holds `data-pressed`, which now renders something, so skipping it would let a sub-frame tap flash colour invisibly. `Button.headless.svelte.ts` no longer reads `prefers-reduced-motion` at all. Ratifies the press-in that shipped unrecorded in #573 (retuned from `scale(0.97)`, symmetric 120ms) and fixes the loading-button exclusion it missed. §1.5 gains the rationale for amending on the v0.2.x line (v0.3.0 collides with `ui-spec-v03.md`); §8.1 Styling's two stale `tailwind-preset.ts` references corrected to `salt.css`. Issue #579; approved mock: _Button press (system-wide mock)_ in `Salt.dc.html`, Claude Design project "Salt — Culinary Modernist" (mock not in-repo).                                                                                                          |
| 2026-07-01 | v0.2.6  | §8.8 Tooltip: added touch-readability props `disableCloseOnTriggerClick` and `ignoreNonKeyboardFocus` (both pass-through to bits-ui `Tooltip.Root`) and documented the touch tap-to-toggle pattern; noted `TooltipTrigger` now forwards `class` + native attributes to the trigger `<button>`. Ratifies shipped code from #382/#386, now on bits-ui 2.x (bump #380). Resolves doc/code drift issue #393.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-06-08 | v0.2.5  | Icon library migrated `lucide-svelte` → `@lucide/svelte` (commit `4822a19`). §1.1 design-system table, §1.2 allowed-imports + consumer restriction, and §8.12 Icon `name` prop updated. Icon `name` surface is now `keyof typeof import('@lucide/svelte').icons` (the named `icons` namespace export, not `import *`); `NavItem.icon` is typed as the `LucideIcon` component from `@lucide/svelte`. Ratifies the migration in issue #167.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-05-30 | v0.2.4  | §8.2 TextField: `label` relaxed from required to `string \| undefined`. Callers omitting `label` must supply `aria-label` or `aria-labelledby`. Ratifies code change from PR #71.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-04-22 | v0.2.3  | §1.2 tightened to truly leaf (external-only) to match root CLAUDE.md and eslint.config.js. Removed `@salt/shared-types` from allowed imports list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-04-22 | v0.2.2  | Locked four implementation decisions: Svelte pin `^5.55.0` (§1.1), Icon surface `keyof typeof import('lucide-svelte')` (§1.1 + §8.12 unchanged), `tailwindcss-animate` registered by preset (§1.1 + §3.3), `useId` kept as module-scope counter explicitly **not SSR-safe** (§2.6). No breaking change to generated code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-04-21 | v0.2.1  | Finished Progress spec. Centralized headless layer under `src/headless/`. Added §1.4 event naming rule, §1.5 spec versioning, §3.5 helper signatures, §3.6 canonical Button example + controlled/uncontrolled + snippet patterns, §3.7 bits-ui mapping table, §3.8 provenance header convention, §4.4 shared size scale, §4.5 dark-mode contract, §6.2 test template. Added CVA class matrices to all primitives. Added per-primitive "Forbidden" lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| earlier    | v0.2    | Initial draft.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
