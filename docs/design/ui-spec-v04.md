# Salt 2.0 — UI Primitives Specification (v0.4)

**Status:** Planning  
**Scope:** `@salt/ui-components` — Combobox (incl. `ComboboxField`); ListPage Selection Mode (incl. `titleSlot`); list selection (`createListSelection` + `SelectableList` / `SelectAllCheckbox` / `RowSelectCheckbox`); EditableRow; CanonIcon (incl. `version` cache-bust prop); ImageCropper  
**Audience:** AI code-generation agents + human contributors

> Rule: If anything is missing or ambiguous → STOP → extend this spec → regenerate.  
> No invention beyond what is written here.

This document extends **v0.2** and **v0.3**.  
All global rules, architecture, naming, styling, and testing conventions from v0.2 remain in force.

---

## 0. v0.4 Scope

v0.4 introduces:

- **Combobox** — text input + popup listbox + filtering + optional custom values, with the optional `ComboboxField` joined-input frame (§3.4)
- **ListPage Selection Mode** — app-wide hide-by-default multi-select with a **contextual bottom action bar** (`bulkActions`, incl. a move/target-picker sheet) that replaces the `BottomNav`, plus deferred-delete + Undo and the `titleSlot` header override (§9)
- **List selection** — one shared `createListSelection` controller behind `SelectableList`, `SelectAllCheckbox`, and `RowSelectCheckbox`, so every list page shares the same selection logic instead of hand-rolling it (§10)
- **EditableRow** — single-row primitive with an `onToggleSelect`-gated checkbox (§11)
- **CanonIcon** — ratified as a spec'd primitive; adds `version` cache-bust prop for regenerated icons, the `matched`/`shimmer` match-reveal states, and documents the tri-state `thumbnail` contract (§14)
- **ImageCropper** — new pan/zoom crop primitive locked to a 3:2 aspect ratio for recipe hero photos; exposes an imperative `getCroppedBase64()` method (§15)

APG pattern: **Autocomplete (Listbox)**.

Beyond those primitives, this document is also where **layout** components (`AppShell`, `TopBar`, `BottomNav`, `SideNav`) are spec'd — v0.2 and v0.3 cover primitives only. See §13 (pinned interaction constraints), §16 (non-production environment banner), and §17 (BottomNav overflow / `overflowNavItems`).

---

## 1. Combobox overview

### 1.1 Purpose

A text input that:

- Filters a list of options as the user types
- Shows a scrollable popup listbox
- Allows keyboard and pointer navigation
- Can be configured to:
  - **restrict** to the list only, or
  - **allow custom** values (create new entries)

### 1.2 APG mapping

- Base pattern: **WAI‑ARIA Combobox with Listbox Popup** (Autocomplete Listbox)
- Key semantics:
  - Input: `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-autocomplete="list"`
  - Popup: `role="listbox"`
  - Items: `role="option"`
  - Active item: `aria-activedescendant` on input

---

## 2. Parts

- `Combobox.svelte` (Root)
- `ComboboxField.svelte` (optional input frame — joins input + trigger; see §3.4)
- `ComboboxInput.svelte`
- `ComboboxTrigger.svelte` (optional caret button)
- `ComboboxContent.svelte`
- `ComboboxItem.svelte`
- `ComboboxGroup.svelte`
- `ComboboxLabel.svelte`
- `ComboboxSeparator.svelte`
- `ComboboxEmpty.svelte` (shown when no results)
- `ComboboxCreate.svelte` (for “Create ‘X’” row when `allowCustom`)

---

## 3. Props and events

### 3.1 Root props (`Combobox`)

| Name           | Type                                               | Default        | Notes                                                                                                                                                                          |
| -------------- | -------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `value`        | string \| undefined (bindable)                     | undefined      | Selected value                                                                                                                                                                 |
| `defaultValue` | string \| undefined                                | undefined      | Uncontrolled initial value                                                                                                                                                     |
| `open`         | boolean (bindable)                                 | false          | Popup open state                                                                                                                                                               |
| `defaultOpen`  | boolean                                            | false          | Initial open state                                                                                                                                                             |
| `items`        | Array<{ value: string; label: string }>            | []             | Full option list                                                                                                                                                               |
| `allowCustom`  | boolean                                            | false          | Allow values not in `items`                                                                                                                                                    |
| `restrict`     | boolean                                            | false          | If true, must select from `items`                                                                                                                                              |
| `name`         | string \| undefined                                | —              | Hidden input name                                                                                                                                                              |
| `placeholder`  | string \| undefined                                | —              | Input placeholder                                                                                                                                                              |
| `openOnClick`  | boolean                                            | true           | If false, clicking/focusing the input does **not** open the popup — it opens only once the user types. Shopping-list add field sets this `false`; canon page keeps the default |
| `portal`       | HTMLElement \| string \| false                     | unset          | Portal target for content. Unset means the enclosing `DialogContent`/`SheetContent` if there is one, `<body>` otherwise (v0.2 §2.5, #674)                                      |
| `filterFn`     | (input: string, item: { value; label }) => boolean | default filter | Optional custom filter function                                                                                                                                                |
| `class`        | string \| undefined                                | —              | Root class                                                                                                                                                                     |

> `allowCustom` and `restrict` are mutually exclusive.  
> If both are true → **STOP** and throw in dev.

### 3.2 Events

- `onValueChange: (value: string) => void`
- `onOpenChange: (open: boolean) => void`
- `onCreate?: (value: string) => void` — fired when a new custom value is created (only if `allowCustom`)

### 3.3 `ComboboxInput` props — HTML attribute forwarding

`ComboboxInput` accepts its own `class` plus **any standard `<input>` attribute**, which is spread onto the underlying `<input>` element. This lets callers attach `data-testid`, `disabled`, `name`, `aria-label`, `required`, etc. without `ComboboxInput` enumerating each one.

```ts
type ComboboxInputProps = Omit<
  HTMLInputAttributes,
  // props ComboboxInput owns and the headless layer controls — callers may NOT override these:
  | 'class'
  | 'id'
  | 'role'
  | 'type'
  | 'aria-expanded'
  | 'aria-controls'
  | 'aria-autocomplete'
  | 'aria-activedescendant'
  | 'value'
  | 'placeholder'
  | 'autocomplete'
  | 'onclick'
  | 'oninput'
  | 'onkeydown'
  | 'onblur'
> & { class?: string };
```

Contract:

- Forwarded attributes are spread **before** the component's own bindings, so the owned props above always win and cannot be clobbered by a caller.
- The ARIA/role/value/handler props are owned by the headless layer (§5.1) and are therefore excluded from the forwarded set — passing them is a type error.
- `placeholder` is supplied via the `Combobox` root prop (§3.1), not on `ComboboxInput`.

### 3.4 `ComboboxField` (optional input frame)

`ComboboxField` is an optional wrapper that visually joins the `ComboboxInput` with an adjacent control (e.g. a `ComboboxTrigger` caret button) into a single bordered frame, and registers itself as the floating anchor for the popup. When no `ComboboxField` wraps it, `ComboboxInput` registers itself as the anchor instead.

| Name       | Type                  | Default | Notes                          |
| ---------- | --------------------- | ------- | ------------------------------ |
| `class`    | `string \| undefined` | —       | Merged onto the frame `<div>`  |
| `children` | `Snippet`             | —       | The input and any sibling part |

**Styling (joined-input contract):**

```
'salt-focus-ring-within flex items-stretch rounded
 [&>input]:flex-1
 [&>input:not(:last-child)]:rounded-r-none
 [&>input:not(:last-child)]:border-r-0'
```

- The `:not(:last-child)` guard means a **standalone** input (no sibling rendered after it) keeps its own right border and right-side radius — the squared-off right edge only applies when a trailing sibling (e.g. trigger) is present to butt against. This avoids a clipped right border on single-input comboboxes.
- The frame uses the base `rounded` (4px) radius per the surface-radius rule (ui-spec-v02 §2.3).

---

## 4. Behaviour

### 4.1 Filtering

- Headless layer maintains:
  - `inputValue: string`
  - `filteredItems: items[]`
- Default filter:
  - Case-insensitive
  - Trims input
  - Matches when `item.label` contains the input substring
- `filterFn` (if provided) replaces default filter.

### 4.2 Keyboard interaction

When input is focused:

- `ArrowDown`:
  - If popup closed → open and move active to first filtered item
  - If open → move active to next item
- `ArrowUp`:
  - If popup closed → open and move active to last filtered item
  - If open → move active to previous item
- `Enter`:
  - If an item is active → select it, set `value`, close popup
  - If no item active:
    - If `allowCustom` → create new value, call `onCreate`, set `value`, close popup
    - If `restrict` → do nothing
- `Escape`:
  - Close popup
  - Restore `inputValue` to current `value` (if any)
- `Home` / `End`:
  - When popup open → jump active to first/last item
- `Tab`:
  - Commit current `value`
  - If `allowCustom` and input doesn’t match any item and no selection yet → treat as custom value

### 4.3 Pointer interaction

- Clicking `ComboboxTrigger` toggles `open`.
- Clicking/focusing `ComboboxInput` opens the popup **only when `openOnClick` is true** (the default). When `openOnClick` is false, the popup stays closed until the user types; the `ComboboxTrigger` caret still toggles `open` regardless.
- Clicking an item selects it and closes popup.
- Mouse hover may update active item (optional; not required).

### 4.4 Scrolling

- When active item changes, `ComboboxContent` must ensure it is visible:
  - `itemElement.scrollIntoView({ block: 'nearest' })`

### 4.5 Restrict vs allowCustom

- `restrict = true`:
  - On blur:
    - If `inputValue` does not match any item’s label → revert to last valid `value` (or empty if none)
- `allowCustom = true`:
  - `ComboboxCreate` row appears when:
    - `inputValue` is non-empty
    - No filtered item has `label === inputValue`
  - Selecting `ComboboxCreate`:
    - Calls `onCreate(inputValue)`
    - Sets `value = inputValue`
    - Closes popup

### 4.6 Controlled/uncontrolled

- `value` + `onValueChange` → controlled
- `defaultValue` → uncontrolled
- `open` + `onOpenChange` → controlled
- `defaultOpen` → uncontrolled

### 4.7 Label sync (seeded / async values)

The input's displayed label is kept in sync with the bound `value`, so a value seeded **after** mount — or a selection that resolves only once async `items` load — shows its label instead of a blank field.

- **On init**, `inputValue` is seeded from the `items` entry whose `value` equals the current `value`.
- **Thereafter**, whenever `value` — or the `items` list — changes from **outside** the component, the displayed label re-syncs:
  - Item now matches `value` → set `inputValue` to that item's `label`.
  - `value` is `undefined` or `''` → clear `inputValue`.
  - `value` has no matching item (a custom / `allowCustom` free-text value) → leave `inputValue` as-is, so free-text survives.
- The re-sync is **suppressed while the popup is `open`**, so it can never clobber what the user is currently typing.

**Rationale:** a one-shot init runs before an edit form seeds its `value` (or before async options load), leaving the field blank. The guarded re-sync corrects every seeded/async combobox rather than any single call site. (Bug fix — #501, commit `dc6de28`; spec note tracked by #506.)

---

## 5. Accessibility (APG requirements)

### 5.1 Input (`ComboboxInput`)

- `role="combobox"`
- `aria-expanded={open}`
- `aria-controls={listboxId}` when open
- `aria-autocomplete="list"`
- `aria-activedescendant={activeItemId}` when an item is active
- `id` used as label target (via external `<label>` or `aria-labelledby`)

### 5.2 Content (`ComboboxContent`)

- `role="listbox"`
- `id={listboxId}`
- `tabindex="-1"`

### 5.3 Items (`ComboboxItem`)

- `role="option"`
- `id={itemId}`
- `aria-selected={isSelected}`

### 5.4 Empty / Create

- `ComboboxEmpty`:
  - No special role required; treated as static content
- `ComboboxCreate`:
  - `role="option"`
  - `aria-selected={false}`

---

## 6. Headless API (shape only)

File: `src/headless/Combobox.headless.svelte.ts`

```ts
type ComboboxItem = { value: string; label: string }

type ComboboxProps = {
  value?: string
  defaultValue?: string
  items: ComboboxItem[]
  allowCustom?: boolean
  restrict?: boolean
  open?: boolean
  defaultOpen?: boolean
  filterFn?: (input: string, item: ComboboxItem) => boolean
}

export function createComboboxState(props: ComboboxProps) {
  // returns state + handlers used by all parts via context
}
Exposed state (conceptual):

- `inputValue: Writable<string>`
- `open: Writable<boolean>`
- `activeIndex: Writable<number | null>`
- `filteredItems: Readable<ComboboxItem[]>`
- `selectedValue: Writable<string | undefined>`

Exposed actions/handlers:

- `setInputValue(value: string)`
- `openPopup()`
- `closePopup()`
- `togglePopup()`
- `moveActive(delta: number)`
- `selectActive()`
- `selectItemByValue(value: string)`
- `createCustom(value: string)`

---

## 7. Testing requirements

- Roles and ARIA:
  - `role="combobox"` on input
  - `role="listbox"` on content
  - `role="option"` on items
  - `aria-expanded`, `aria-controls`, `aria-activedescendant`

- Keyboard:
  - Arrow navigation
  - Enter selection
  - Escape close + revert
  - Home/End behaviour
  - Tab commit behaviour

- Filtering:
  - Default filter behaviour
  - `filterFn` override

- Modes:
  - `restrict`:
    - Invalid input reverts on blur
  - `allowCustom`:
    - “Create” row appears correctly
    - `onCreate` fired

- Scrolling:
  - Active item scrolled into view

- Controlled vs uncontrolled:
  - `value`/`defaultValue`
  - `open`/`defaultOpen`

## 8. Additional decisions (pinned)

### 8.1 Duplicate labels in `items`
Allowed.

Rationale:
- Real datasets often contain duplicate labels (e.g., people with the same name).
- APG does not forbid duplicates.
- Salt identifies items internally by **index**, not by label.

Contract:
- `label` is for display and filtering only.
- `value` must be unique within the list.
- Active item is tracked by **index**, not by value.

### 8.2 Active item identification
Active item is identified by **index**.

Rationale:
- Filtering changes the visible list; indices are stable within `filteredItems`.
- `aria-activedescendant` uses the item’s DOM `id`, which is derived from the index in the filtered list.

Contract:
- Headless stores `activeIndex: number | null`.
- Items register in filtered order.
- No value-based active tracking.

### 8.3 Long lists / virtualization
**Virtualization is explicitly out of scope for v0.4.**

Rationale:
- Virtualization breaks the `scrollIntoView` guarantee.
- It requires a fundamentally different item registration model.
- It complicates ARIA because offscreen items may not exist in the DOM.

Contract:
- All items in `filteredItems` are rendered in the DOM.
- `scrollIntoView({ block: 'nearest' })` is required and reliable.
- Virtualization may be considered in a future major version.

### 8.4 Async items / loading state
Out of scope for v0.4.

Rationale:
- Async data introduces loading, error, and empty states that complicate the headless API.
- v0.4 focuses on the core APG pattern with static `items`.

Contract:
- `items` is a synchronous array.
- If the user wants async behaviour, they must manage it externally and pass updated `items` down.
- No built-in loading spinner or async fetch behaviour.

### 8.5 `ComboboxEmpty` accessibility
`ComboboxEmpty` is **non-focusable** and **aria-hidden**.

Rationale:
- It is not an option.
- It should not be reachable by keyboard.
- Screen readers should not treat it as a selectable item.

Contract:
- `ComboboxEmpty` renders with:
  - `aria-hidden="true"`
  - `tabindex="-1"`
- It must never be assigned an `id` or used as `aria-activedescendant`.

### 8.6 `ComboboxCreate` accessibility
`ComboboxCreate` **is** an option.

Contract:
- `role="option"`
- `aria-selected="false"`
- It participates in active item movement.
- It is included in `filteredItems` as a synthetic final entry when conditions are met.

### 8.7 Matching behaviour for custom creation
Exact-match rule:

- If `allowCustom` is true:
  - `ComboboxCreate` appears **only** when:
    - `inputValue` is non-empty
    - AND no item has `label === inputValue` (case-insensitive exact match)

Rationale:
- Prevents duplicate creation of existing items.
- Matches behaviour of Radix, MUI, and Reach.

```

---

# 9. ListPage — Selection Mode

## 9.1 Overview

`ListPage` supports an app-wide **Selection Mode** built around a **contextual action mode** (Android-style): multi-select is hidden by default; the list is "clean" with only each row's primary action visible. A built-in **"Select" button** in the page header switches into selection mode, revealing the top **select-all** control (`selectionBar`) and per-row select controls. A **"Done" button** (replacing "Select" in the header) exits selection mode.

Once at least one item is selected, bulk actions appear in a **contextual bottom action bar** that the template renders and that **replaces** the app's `BottomNav` (it is painted over the nav at a higher z-index, not stacked above it). Pages declare these actions declaratively via the `bulkActions` prop — they do **not** render their own bottom bar. A `picker`-type action (e.g. "Move to…") opens a template-owned bottom `Sheet` of targets. Bulk **delete** uses **deferred-delete + an Undo snackbar** — items hide immediately and the real delete commits only when the undo window lapses; there is **no confirm dialog** and **no soft-delete/tombstones** (see §9.3.3).

Pattern precedent: Android contextual action bar; iOS Reminders/Mail multi-select.

## 9.2 Behaviour

### Default state (selection mode off)

- No per-row select checkboxes are visible.
- The `selectionBar` (top select-all) snippet is not rendered, and no contextual bottom bar is shown.
- The header shows a "Select" `outline`, `size="sm"` button (only when a `selectionBar` snippet is provided).

### Selection mode on

- The `selectionBar` snippet (typically a single select-all `Checkbox`) is rendered in the bar between toolbar and content.
- Per-row select controls become visible (consuming pages gate them on their page-local `selectionMode` — see §9.4).
- The "Select" button is replaced by a "Done" `outline`, `size="sm"` button in the header.
- **Once `selectionCount > 0`**, the contextual bottom action bar (`bulkActions`) appears, replacing the `BottomNav`; the template reserves matching bottom content padding so the last rows are not hidden behind it.

> Button variant: the Select/Done toggle uses `variant="outline"` (not `ghost`) so it reads as an affordance against the header background and lines up with the `size="sm"` convention documented on the `actions` prop.

### Exiting selection mode

- Tapping "Done" sets `selectionMode = false` inside `ListPage`, which propagates back to the consuming page via the binding.
- The `selectionBar`, per-row controls, and the contextual bottom bar are all hidden again; the `BottomNav` returns.
- Consuming pages clear their `selected` Set by reacting to `selectionMode` becoming `false` (see §9.5).

## 9.3 `ListPage` props changes

Three selection-related props:

- `selectionMode?: boolean` (bindable, default `false`). Consuming pages bind to it to observe and react to mode state. The "Select"/"Done" toggle still appears automatically whenever a `selectionBar` snippet is provided — the page never needs to manage the toggle itself.
- `selectionCount?: number` (default `0`). The number of currently-selected items. Drives contextual-bar visibility (the bar shows only when `selectionMode && selectionCount > 0`) and the default picker-sheet title. The page owns selection state; this prop is just the count.
- `bulkActions?: BulkAction[]`. The actions rendered in the contextual bottom bar (§9.3.1).

`ListPageProps` is an open interface that extends `Omit<HTMLAttributes<HTMLElement>, 'class'>`. Any attribute valid on `<section>` is accepted and spread onto the root `<section>` element (e.g. `data-*`, `aria-*`, `id`). The `class` prop is reserved and handled internally.

### 9.3.1 `BulkAction` — declarative contextual bar

Each bar entry is a `BulkAction`. The template owns the bar chrome (layout, icon-over-label buttons, destructive tint, disabled state) so every list page looks identical; pages supply only data + handlers. Icons are names from the shared `Icon` set (`BulkActionIcon = keyof typeof import('@lucide/svelte').icons`).

```ts
type BulkAction =
  | {
      kind?: 'button'; // default
      id: string; // stable key
      label: string; // "Check", "Delete"
      icon: BulkActionIcon; // "CircleCheck", "Trash2"
      variant?: 'default' | 'destructive';
      disabled?: boolean;
      testId?: string; // data-testid override (else "list-page-bulk-action")
      onSelect: () => void;
    }
  | {
      kind: 'picker'; // opens a template-owned bottom Sheet of targets
      id: string;
      label: string; // "Move"
      icon: BulkActionIcon; // "FolderInput"
      disabled?: boolean;
      testId?: string;
      sheetTitle?: string; // "Move 3 items to…" (defaults to label)
      targets: { id: string; label: string }[];
      optionTestId?: string; // data-testid for each option (else "list-page-bulk-picker-option")
      onPick: (targetId: string) => void;
    };
```

Worked call-site (shopping):

```svelte
<ListPage
  bind:selectionMode
  selectionCount={selectedCount}
  bulkActions={[
    { id: 'check', label: 'Check', icon: 'CircleCheck', onSelect: handleBulkCheck },
    { id: 'uncheck', label: 'Uncheck', icon: 'Circle', onSelect: handleBulkUncheck },
    {
      kind: 'picker',
      id: 'move',
      label: 'Move',
      icon: 'FolderInput',
      disabled: otherLists.length === 0,
      sheetTitle: `Move ${selectedCount} item${selectedCount === 1 ? '' : 's'} to…`,
      targets: otherLists.map((l) => ({ id: l.id, label: l.name })),
      onPick: handleMoveTo,
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: 'Trash2',
      variant: 'destructive',
      onSelect: handleBulkDelete,
    },
  ]}
>
  {#snippet selectionBar()}<Checkbox … />{/snippet}
  {#snippet children()}…rows…{/snippet}
</ListPage>
```

### 9.3.2 Move / target picker

A `kind: 'picker'` action renders, in the bottom bar, a button that opens a template-owned bottom `Sheet` listing `targets`. Selecting one fires `onPick(targetId)` and closes the sheet. The template owns the sheet entirely — pages do not render their own move sheet. Use a picker for "move into one of N containers" flows (shopping lists, folders); use a plain `button` action whose `onSelect` opens a bespoke `Dialog` for genuinely complex flows that the simple target list can't represent (e.g. aisle merge with per-item choices, or an aisle delete that must disclose affected items).

### 9.3.3 Deferred bulk delete + Undo snackbar

The canonical bulk-delete is **deferred-delete + Undo snackbar, with no confirm dialog and no soft-delete/tombstones** (true to Firestore-as-master): selected items hide immediately, and the real Firestore delete commits only once the Undo toast lapses. Pressing **Undo** cancels the commit, so nothing is ever deleted and no restore path is required.

`ListPage` stays toast-free — the toast is app-level (§ Toast / `toastStore`), because `@salt/ui-components` must not depend on the app's toast store. The repeated hide → commit → undo orchestration lives in the shared web-pwa helper `createDeferredDelete()` (`apps/web-pwa/src/lib/deferredDelete.svelte.ts`):

```ts
const deferredDelete = createDeferredDelete();
// hide pending-deleted rows from rendering:
const visibleItems = $derived(deferredDelete.visible($items));

function handleBulkDelete() {
  const ids = [...selected];
  selectionMode = false;
  deferredDelete.request(ids, async (delIds) => {
    const result = await removeItems(delIds);
    if (result.kind !== 'ok') addToast('Failed to delete items.', 'destructive');
  });
}
```

A `Delete` `BulkAction` (`variant: 'destructive'`) simply calls the page's `handleBulkDelete` from `onSelect`; the template renders the button but owns none of the delete semantics. Pages with consequential structural deletes that need disclosure (aisle management) keep a `Dialog`, triggered from a bar action's `onSelect` instead.

### `titleSlot` — custom header title

`titleSlot?: Snippet`. When provided, it **replaces** the default `<h1>{title}</h1>` in the page header. When omitted, the page renders the default `<h1>` from the `title` string.

Use this when a page needs an interactive element in place of a static heading — e.g. a `Combobox` for switching between shopping lists, or an editable title. The `title` string prop is still required (it remains the accessible/programmatic name and the fallback); `titleSlot` only overrides the _rendered_ heading.

```svelte
<ListPage title="Shopping list">
  {#snippet titleSlot()}
    <ListSwitcherCombobox … />
  {/snippet}
</ListPage>
```

Contract:

- `titleSlot` and `title` are not mutually exclusive — `title` must always be passed; `titleSlot` is the optional visual override.
- A `titleSlot` that renders no heading element should still provide an accessible name for the region (the page's `title` covers the section's labelling).

## 9.4 Consuming-page contract (bindable prop)

Consuming pages use `bind:selectionMode` to observe selection state in their own scripts and templates. This is the correct approach because consuming pages are _parents_ of `ListPage` — Svelte context flows downward (parent → child), so `LIST_PAGE_CONTEXT.get()` cannot be called from a consuming page's `<script>` block (it would throw outside the component tree).

**Standard pattern for a consuming page:**

```svelte
<script lang="ts">
  let selectionMode = $state(false);
  let selected = $state(new Set<string>());

  $effect(() => {
    if (!selectionMode) selected = new Set();
  });
</script>

<ListPage ... bind:selectionMode>
  {#snippet children()}
    {#if selectionMode}
      <Checkbox checked={isSelected} onCheckedChange={() => toggleSelection(item.id)} label="" />
    {/if}
  {/snippet}
</ListPage>
```

## 9.5 Clearing selection on exit

Consuming pages own their `selected` Set. When selection mode exits the bound `selectionMode` becomes `false`; a top-level `$effect` reacts and clears it:

```ts
$effect(() => {
  if (!selectionMode) selected = new Set();
});
```

## 9.6 Programmatic exit

To exit selection mode programmatically from a consuming page (e.g., after a bulk delete completes), set the bound state directly:

```ts
selectionMode = false; // propagates into ListPage via the binding; triggers the $effect above
```

## 9.7 Context — for nested components only

`ListPage` still publishes selection state via `LIST_PAGE_CONTEXT` (`@salt/ui-components`). This is intended for **components instantiated inside `ListPage`'s rendered tree** (e.g., a future shared row component that needs to know the mode without prop-drilling through the page's snippet markup).

```ts
// Only call this inside a component whose init runs inside ListPage's tree:
import { LIST_PAGE_CONTEXT } from '@salt/ui-components';
const ctx = LIST_PAGE_CONTEXT.get(); // throws if called outside ListPage's tree
```

`ListPageContext` shape:

```ts
type ListPageContext = {
  readonly selectionMode: boolean; // reactive via getter
  readonly exitSelectionMode: () => void; // sets selectionMode = false
};
```

Do **not** call `LIST_PAGE_CONTEXT.get()` in a consuming page's own `<script>` block — use `bind:selectionMode` instead (§9.4).

## 9.8 Forbidden

- Do not re-implement the "Select"/"Done" toggle in consuming pages.
- Do not render a bespoke bottom action bar or move/target `Sheet` in a consuming page — declare `bulkActions` (incl. `kind: 'picker'`) and let `ListPage` own the chrome. (Pre-`#115` pages each hand-rolled a `fixed bottom-0` bar; that is now superseded.)
- Do not gate bulk **delete** behind a confirm dialog or implement soft-delete/tombstones — use the deferred-delete + Undo pattern via `createDeferredDelete()` (§9.3.3). The only exception is a consequential structural delete that must disclose side-effects (aisle management), which may keep a `Dialog` triggered from a bar action.
- Do not call `LIST_PAGE_CONTEXT.get()` from a consuming page's `<script>` block — it is outside the context tree and will throw.

---

# 10. List selection (`createListSelection` + `SelectableList` / `SelectAllCheckbox` / `RowSelectCheckbox`)

## 10.1 Overview

Multi-selection across the app's list pages is owned by **one** shared controller, `createListSelection`, plus three thin presentational components that read from it. Before, every list page (shopping, canon, aisle, equipment) hand-rolled the same `selected` Set, the `allSelected` / `someSelected` / `count` deriveds, the `toggle` / `toggleAll` helpers, the auto-clear `$effect`, and its own select-all / per-row checkboxes. That logic now lives once, in the controller.

The pieces:

- **`createListSelection(options)`** — the selection "brain". Owns the `selected` Set and derives `allSelected` / `someSelected` / `count` from a scope (`getAllIds`). Sources selection mode from the page (`isSelectionMode`) and **auto-clears the selection when mode turns off**, replacing the per-page `$effect`.
- **`SelectableList<T>`** — renders a flat `<ul>` of rows from `items`, each produced by a caller `row` snippet, with the per-row select checkbox gated on `selection.selectionMode`. Used for simple flat lists (equipment).
- **`SelectAllCheckbox`** — the header/`selectionBar` select-all control (tri-state + "N selected" label), wired entirely from the controller.
- **`RowSelectCheckbox`** — a single per-row select checkbox wired to the controller by `id`, for pages whose row layout is bespoke (shopping's trolley rows, aisle's drag-drop `SortableList` rows) and so cannot use `SelectableList`'s flat container.

> **Why a controller, not one mega-component.** The four lists are structurally divergent — flat (equipment), grouped + sectioned (canon, shopping), collapsible (shopping), and drag-drop sortable (aisle). Forcing them all through a single list container would couple selection to grouping/sorting. Instead the _selection logic_ is unified in the controller; each page keeps its own structure and composes the shared checkboxes. Canon reuses `EditableRow`'s built-in checkbox (driven by the controller via `selected` / `onToggleSelect`).

> **Scope: selection only.** None of these own bulk actions. Bulk actions belong to `ListPage`'s contextual action bar via `bulkActions` (§9.3.1). A page composes the list/checkboxes inside `ListPage`'s `children` / `selectionBar` and declares `bulkActions` on the `ListPage`, passing `selectionCount={selection.count}`.

## 10.2 `createListSelection(options)`

**Options**

| Name              | Type             | Notes                                                                            |
| ----------------- | ---------------- | -------------------------------------------------------------------------------- |
| `getAllIds`       | `() => string[]` | All currently-selectable ids in scope; drives `all`/`some`/`count` + `toggleAll` |
| `isSelectionMode` | `() => boolean`  | Page's selection mode (bound to `ListPage`); selection clears on exit            |

**Returns `ListSelection`**

| Member           | Type                     | Notes                                                   |
| ---------------- | ------------------------ | ------------------------------------------------------- |
| `selectionMode`  | `boolean` (readonly)     | Mirror of `isSelectionMode()`                           |
| `selected`       | `Set<string>` (readonly) | Live selected ids (reactive)                            |
| `ids`            | `string[]` (readonly)    | Selected ids still in scope (`getAllIds`)               |
| `count`          | `number` (readonly)      | `ids.length`                                            |
| `allSelected`    | `boolean` (readonly)     | Every in-scope id selected                              |
| `someSelected`   | `boolean` (readonly)     | Some, but not all, in-scope ids selected                |
| `isSelected(id)` | `(id) => boolean`        | Membership test                                         |
| `toggle(id)`     | `(id) => void`           | Add/remove one id (immutable Set swap)                  |
| `toggleAll()`    | `() => void`             | Select all in-scope, or clear when all already selected |
| `add(ids)`       | `(ids) => void`          | Add a subset (e.g. "select all pending")                |
| `remove(ids)`    | `(ids) => void`          | Remove a subset (e.g. after a partial bulk action)      |
| `clear()`        | `() => void`             | Clear the whole selection                               |

## 10.3 Component props

**`SelectableList<T>`**

| Name                  | Type                                                      | Default   | Notes                                                                                                        |
| --------------------- | --------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `items`               | `T[]` where `T extends { id: string }`                    | —         | Rows to render; keyed by `item.id`                                                                           |
| `selection`           | `ListSelection`                                           | —         | Shared controller; gates + drives the checkbox                                                               |
| `row`                 | `Snippet<[T, { selected: boolean; toggle: () => void }]>` | —         | Renders each row's content                                                                                   |
| `getRowCheckboxLabel` | `((item: T) => string) \| undefined`                      | see Notes | Accessible label for each row's select checkbox; defaults to ``(item) => `Select ${item.id}` `` when omitted |
| `class`               | `string \| undefined`                                     | —         | Merged onto the `<ul>`                                                                                       |

**`SelectAllCheckbox`** — `{ selection: ListSelection }` (extra attrs forwarded to `Checkbox`).
**`RowSelectCheckbox`** — `{ selection: ListSelection; id: string }` (extra attrs — `aria-label`, `labelledBy`, `data-testid`… — forwarded to `Checkbox`).

## 10.4 Behaviour

- **`selection.selectionMode` gates the per-row checkbox.** When mode is off, `SelectableList` renders no checkbox and reads as a plain list; bespoke pages gate their `RowSelectCheckbox` behind their own `{#if selectionMode}`.
- `toggle` / `toggleAll` / `add` / `remove` mutate the selection immutably (a new `Set` is assigned so deriveds and bindings react).
- Leaving selection mode (`isSelectionMode()` → `false`) clears the selection automatically.
- Selected rows in `SelectableList` get a `ring-2 ring-ring border-ring` treatment; rows use the base `rounded` (4px) surface radius (ui-spec-v02 §2.3).

## 10.5 Accessibility

- `SelectableList`'s root is a `<ul>`; each row is an `<li>`.
- The select checkboxes carry selection state for assistive tech; the `row` snippet (or bespoke row) is responsible for the row's own accessible label/content. `SelectAllCheckbox` exposes a "Select all" / "N selected" label.

## 10.6 Testing requirements

- Per-row checkbox is **absent** when `selection.selectionMode` is `false` and **present** when `true`.
- Toggling a checkbox updates the controller's selection (add and remove); `toggleAll` selects/clears the in-scope set.
- Leaving selection mode clears the selection.
- Selected rows reflect the selected styling; the `row` snippet receives the correct `selected` flag and a working `toggle`.

---

# 11. EditableRow (primitive)

## 11.1 Overview

`EditableRow` is a single list-row primitive with an optional leading select `Checkbox` and responsive `narrow` / `wide` content snippets. It is used by pages that render editable rows (e.g. canon, aisles, equipment) and want a consistent row chrome with optional multi-select.

## 11.2 Props

| Name             | Type                        | Default     | Notes                                                                |
| ---------------- | --------------------------- | ----------- | -------------------------------------------------------------------- |
| `selected`       | `boolean`                   | `false`     | Whether the row is selected (drives ring styling + checkbox)         |
| `shaded`         | `boolean`                   | `false`     | Amber "needs attention" styling instead of the default surface       |
| `onToggleSelect` | `(() => void) \| undefined` | `undefined` | Select handler. **When `undefined`, the `Checkbox` is not rendered** |
| `narrow`         | `Snippet`                   | —           | Row content shown below the `sm` breakpoint                          |
| `wide`           | `Snippet`                   | —           | Row content shown at/above the `sm` breakpoint                       |

## 11.3 Behaviour

- **`onToggleSelect` presence gates the checkbox.** When `onToggleSelect` is `undefined` (the default), no leading `Checkbox` is rendered. When a handler is passed, the `Checkbox` appears, reflects `selected`, and calls `onToggleSelect` on change. This mirrors `SelectableList.selectionMode` (§10.3): a page passes `onToggleSelect` only while in selection mode.
- `shaded` switches the row to the amber attention palette; `selected` adds a `ring-2 ring-ring` treatment in both palettes.
- The row uses the base `rounded` (4px) surface radius (ui-spec-v02 §2.3).
- `narrow` is shown on small screens (`sm:hidden`); `wide` is shown from `sm` upward (`hidden sm:flex`).

## 11.4 Testing requirements

- `Checkbox` is **absent** when `onToggleSelect` is `undefined` and **present** when a handler is passed.
- The `Checkbox` reflects `selected` and invokes `onToggleSelect` on change.
- `shaded` and `selected` styling render as specified.
- `narrow` and `wide` snippets render at the correct breakpoints.

---

# 12. Markdown (primitive)

## 12.1 Overview

`Markdown` is a lightweight read-only Markdown renderer. It wraps [`svelte-exmarkdown`](https://www.npmjs.com/package/svelte-exmarkdown) with the GFM (GitHub Flavored Markdown) plugin and scopes all output under the `salt-md` CSS class so host pages never need to supply prose styles.

Primary use case: rendering AI-generated assistant responses in the chat UI (AI Kitchen Assistant). The primitive lives in `@salt/ui-components` so any future feature that needs rich-text display can reuse it without pulling in a second Markdown library.

## 12.2 Props

| Name            | Type                  | Default  | Notes                                                                                      |
| --------------- | --------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `text`          | `string`              | —        | Markdown source string to render                                                           |
| `breaks`        | `boolean`             | `false`  | Treat every single newline as a hard break (see §12.3.1)                                   |
| `scale`         | `'note' \| 'doc'`     | `'note'` | Type scale: note proportions, or document proportions for a page body (see §12.3.2)        |
| `sanitizedHtml` | `boolean`             | `false`  | Render raw HTML in the source as elements, through the allowlist in `svgSanitizeSchema.ts` |
| `class`         | `string \| undefined` | —        | Extra classes merged onto the `salt-md` wrapper `<div>`                                    |

## 12.3 Implementation

- **File:** `packages/ui-components/src/primitives/Markdown/Markdown.svelte`
- **Renderer:** `svelte-exmarkdown` (`<Markdown md={text} plugins={[gfmPlugin()]} />`)
- **Plugin:** `gfmPlugin()` from `svelte-exmarkdown/gfm` — adds tables, strikethrough, task lists, and autolinks.
- **Wrapper:** `<div class={cn('salt-md', scale === 'doc' && 'salt-md-doc', className)}>` — the `salt-md` scope prevents styles from leaking into or out of the component.

### 12.3.1 `breaks` — line-per-thought source text

CommonMark folds a lone newline into a space and requires a _blank_ line to
start a new paragraph. That is correct for prose, but wrong for freeform
line-per-thought text that was written into a plain textarea and previously
displayed with `whitespace-pre-wrap` — rendering it as Markdown would run every
line together the first time it were viewed.

`breaks` opts a caller into hard-break semantics: each single `\n` becomes a
CommonMark hard break, so the rendered output keeps the line structure the
author typed. It is implemented as a pure string transform that appends the
two-space hard-break marker ahead of each lone newline (CRLF normalised first),
so it adds no second Markdown dependency and does not touch the AST → Svelte
pipeline.

Blank lines are deliberately left untransformed, keeping their CommonMark
paragraph meaning — a caller gets hard breaks _and_ real paragraphs.

**Default is `false`**, so existing consumers (`ChatThread.svelte`, rendering
AI replies that are already well-formed Markdown) are unaffected. Turn it on
for user-typed freeform text; leave it off for generated Markdown.

Both the recipe view page and the recipe editor's Notes preview pass `breaks`,
so "how a recipe note's line breaks render" has exactly one implementation and
the preview cannot disagree with the saved result.

### 12.3.2 `scale` — note proportions vs document proportions

The default scale is a **note**: a chat reply or a recipe note, rendered inside
something else, with `0` paragraph margins and headings stepping from `1.125rem`
down to `1rem`. A library page body is not inside something else — it _is_ the
page — so it reads at **document** proportions: `1.5rem` headings, real
paragraph margins, and a table that scrolls inside its own box rather than
widening the page (the one sanctioned horizontal scroller on a Salt surface).

`scale="doc"` adds `salt-md-doc` to the same wrapper `<div>` that carries
`salt-md`. The rules live in the primitive's own `<style>` block, beside the
base rules they override.

**The two classes chain on one element deliberately.** `.salt-md.salt-md-doc :global(p)`
outranks `.salt-md :global(p)` on **specificity**, so the doc scale wins
whatever order the two rule sets are emitted in. Written the obvious way — as
`.salt-md-doc :global(p)` on a descendant wrapper — the two would tie and source
order would be the only tiebreak, which flips the first time a bundler reorders
two stylesheets. Preserve the chained form in any future edit.

The doc scale **overrides, it does not replace**: everything the table in §12.4
lists and §12.4.1 does not restate — inline code, `pre`, `blockquote`, `hr`,
`th`/`td` borders, the `svg` cap — still comes from the note scale.

**Default is `'note'`**, which is the scale every caller had before the prop
existed, so `ChatThread.svelte` and `RecipeNotesCard.svelte` are unaffected by
its introduction. The three library surfaces — the page body, the history
preview and the paste-in preview — all pass `scale="doc"`, on purpose: a version
previews as the page it will become rather than as a smaller cousin of it.

## 12.4 `salt-md` CSS scope

All styles are applied via `:global()` selectors scoped under `.salt-md` so they target only `svelte-exmarkdown`'s rendered HTML without polluting the rest of the app.

| Element         | Style applied                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:first-child`  | `margin-top: 0`                                                                                                                                                       |
| `:last-child`   | `margin-bottom: 0`                                                                                                                                                    |
| `p`             | `margin: 0`; successive paragraphs separated by `0.5rem` top margin                                                                                                   |
| `ul`            | `margin: 0.25rem 0; padding-left: 1.25rem; list-style: disc`                                                                                                          |
| `ol`            | `margin: 0.25rem 0; padding-left: 1.25rem; list-style: decimal`                                                                                                       |
| `li`            | `margin: 0.125rem 0`                                                                                                                                                  |
| `h1`–`h6`       | `font-weight: 600; line-height: 1.3; margin: 0.5rem 0 0.25rem`; font sizes step from `1.125rem` (h1) down to `1rem` (h3); h4–h6 inherit h3 size                       |
| `strong`        | `font-weight: 600`                                                                                                                                                    |
| `em`            | `font-style: italic`                                                                                                                                                  |
| `a`             | `text-decoration: underline`                                                                                                                                          |
| `code` (inline) | `font-family: ui-monospace, monospace; font-size: 0.875em; background: rgb(0 0 0 / 0.06); padding: 0.0625rem 0.25rem; border-radius: 0.25rem`                         |
| `pre`           | `background: rgb(0 0 0 / 0.06); padding: 0.5rem 0.75rem; border-radius: 0.5rem; overflow-x: auto; margin: 0.5rem 0`                                                   |
| `pre code`      | Resets `background` and `padding` so block-code doesn't double-apply the inline-code tint                                                                             |
| `blockquote`    | `border-left: 3px solid currentColor; opacity: 0.85; padding-left: 0.75rem; margin: 0.5rem 0`                                                                         |
| `hr`            | `border: none; border-top: 1px solid currentColor; opacity: 0.2; margin: 0.5rem 0`                                                                                    |
| `table`         | `border-collapse: collapse; margin: 0.5rem 0`                                                                                                                         |
| `th`, `td`      | `border: 1px solid currentColor; padding: 0.25rem 0.5rem`                                                                                                             |
| `svg`           | `max-width: 100%; height: auto` — a drawing only exists under `sanitizedHtml` and arrives with whatever `width` its author typed; the `viewBox` keeps the proportions |

### 12.4.1 `salt-md-doc` — the document-scale overrides

Added to the same `<div>` by `scale="doc"` (§12.3.2). Every selector is written
`.salt-md.salt-md-doc :global(…)` so it beats its counterpart above on
specificity rather than on source order. Anything not listed here keeps its
note-scale value.

| Element    | Style applied                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `p`        | `margin: 0.75rem 0` (replaces the note scale's `margin: 0` plus `p + p` top margin)                                            |
| `h1`       | `font-size: 1.5rem; margin: 1.25rem 0 0.5rem`                                                                                  |
| `h2`       | `font-size: 1.25rem; margin: 1.25rem 0 0.5rem`                                                                                 |
| `h3`       | `font-size: 1.0625rem; margin: 1rem 0 0.375rem`                                                                                |
| `ul`, `ol` | `margin: 0.75rem 0`                                                                                                            |
| `li`       | `margin: 0.25rem 0`                                                                                                            |
| `table`    | `display: block; width: max-content; max-width: 100%; overflow-x: auto` — scrolls in its own box rather than widening the page |

## 12.5 Usage example

```svelte
<script lang="ts">
  import { Markdown } from '@salt/ui-components';
</script>

<Markdown text={assistantReply} class="text-sm" />
```

## 12.6 Testing requirements

- Renders plain text without wrapping it in extra elements.
- GFM features (tables, strikethrough) are parsed and rendered (not passed through as raw text).
- The `class` prop is merged onto the wrapper `<div>` alongside `salt-md`.
- The component does **not** expose event handlers or interactive behaviour — it is display-only.
- `breaks` off (the default): a single newline does **not** produce a `<br>` — standard CommonMark folding.
- `breaks` on: a single newline produces a `<br>`; a blank line still produces a second `<p>`, not a `<br>`.
- `scale` off (the default) and `scale="note"`: the wrapper carries `salt-md` and **not** `salt-md-doc`.
- `scale="doc"`: `salt-md-doc` lands on the `salt-md` wrapper itself — one element, not a second nested one — and `class` still merges alongside both.
- `scale` is presentation only: the same source renders the same element tree at either scale.
- **Not testable in the unit environment:** jsdom does not compute Svelte's scoped styles across a component boundary, so no assertion here can prove a rendered font size or margin. Visual parity for `scale="doc"` is covered by the `DocumentScale` Storybook story's Chromatic baseline, not by vitest.

---

# 13. Pinned interaction constraints

This section records deliberate interaction decisions for existing primitives that are not otherwise captured in v0.2–v0.3. These constraints must be preserved when regenerating or refactoring these components.

## 13.1 `ToastViewport` — `pointer-events-none` container

**Constraint:** The `ToastViewport` container div must carry `pointer-events-none`. Each rendered `Toast` must re-enable `pointer-events-auto` on its own root element.

**Rationale:** `ToastViewport` is a fixed, full-width strip anchored at the bottom of the viewport (above `BottomNav` in z-order). This strip is present in the DOM even when no toasts are visible. Without `pointer-events-none` on the container, the empty strip swallows tap events intended for the `BottomNav` beneath it.

**Contract:**

- `ToastViewport` class string must include `pointer-events-none`.
- `Toast` (root) class string must include `pointer-events-auto`.
- Do not remove either class during style refactors.

## 13.2 `BottomNav` — full-height tap targets (`items-stretch`)

**Constraint:** The `BottomNav` `<ul>` must use `items-stretch` (not `items-center`). Each `<li>` must be `flex flex-1`; each tab's own interactive element must be `flex flex-1`.

**Rationale:** Without `items-stretch`, each tab's interactive element is only as tall as its content (icon + label), leaving dead strips above and below the tappable area within the `h-14` nav bar. `items-stretch` makes it fill the full column height so the entire strip is tappable regardless of where the finger lands.

**Contract:**

- `<ul class="... items-stretch ...">` — `items-center` is forbidden here.
- `<li class="flex flex-1">` — each tab column must fill the row height.
- The tab's interactive element carries `flex flex-1` and inherits the full height via flex stretch. For a destination tab that element is the `<a>`; for the trailing overflow ("More") tab it is a `SheetTrigger` (§17), which is why `SheetTrigger` forwards `class` (ui-spec-v03 §5.3.1) — the constraint is on **every** tab column, so a tab that is not an anchor must still be able to receive these classes.

## 13.3 `AppShell` — viewport-bounded shell (`h-dvh`), inner scroll

**Constraint:** The `AppShell` root must be `h-dvh` (the **dynamic** viewport height) — not `min-h-screen`, `h-screen`, or `min-h-dvh`. The root is a `flex flex-col` column of three rows: `TopBar`, then a `flex flex-1 overflow-hidden` row holding `SideNav` + `<main>`, then `BottomNav`. The scrolling region is the inner `<main class="flex-1 overflow-y-auto">`, **never** the outer shell.

**Rationale:** `h-dvh` caps the shell to the dynamic viewport so a tall page scrolls its inner `<main>` region instead of growing the whole document. This keeps sticky / viewport-anchored children — e.g. the desktop Chef Chat sidebar on `RecipeViewPage`, which sticks to the top with a bounded `max-height` — fixed within the viewport and lets their content scroll internally rather than pushing the page (regression fixed in #261, commit `c17120a`, which changed the root from `min-h-screen` → `h-dvh`). `h-dvh` (not `h-screen` / `100vh`) tracks the _dynamic_ viewport, so mobile browser chrome collapsing or expanding neither clips nor gaps the shell.

**Trade-off (explicit):** the outer shell can never be taller than the viewport. Any surface that genuinely needs to scroll the _whole_ shell (rather than an inner region) must opt out locally at the page level — do not change this primitive to accommodate it.

**Contract:**

- `AppShell` root class must include `h-dvh` **and** `flex flex-col`. `min-h-screen`, `h-screen`, and `min-h-dvh` are forbidden here.
- The `SideNav` + `<main>` row keeps `flex flex-1 overflow-hidden`; `<main>` keeps `flex-1 overflow-y-auto`. Scrolling lives in `<main>`, not the root.
- `<main>` retains its BottomNav-safe bottom padding (`pb-[calc(var(--salt-layout-bottom-nav-height)_+_env(safe-area-inset-bottom))] lg:pb-0`) so content clears the fixed mobile `BottomNav` (see §13.2). The height is a token as of #930 — the same one `BottomNav` reads, so the reservation cannot drift from what it reserves; it was the literal `3.5rem` in four places before that.

## 13.4 Shopping row swipe — touch-only, page-local (no `SwipeableRow` primitive)

**Constraint:** The horizontal swipe on a single shopping row (swipe right past **+78px** → check off; swipe left past **-78px** → delete via the undo snackbar; a short swipe springs back) is **touch-only** and lives **page-local** in `apps/web-pwa/src/routes/shopping/` (the Svelte action `apps/web-pwa/src/lib/swipe.svelte.ts` + the pure geometry `apps/web-pwa/src/lib/swipe.ts`). It is **not** a `@salt/ui-components` primitive.

**Rationale:** No spec in the v0.2–v0.4 family defines a `SwipeableRow`, and ui-spec-v02 forbids implementing a primitive no spec defines (§1: "No invention beyond what is written here"). Shopping is the only surface that swipes, so promoting the gesture into `@salt/ui-components` would mean authoring a whole new primitive spec (a `ui-spec-v05.md`) to serve a single consumer. Until a **second** surface needs swipe, the page-local implementation in shopping is the canonical one for the repo; that second surface — not now — is the trigger to promote it (with the spec that entails). Touch-only because a mouse-drag competes with the row's buttons, which stay the primary action on desktop — every action a swipe performs (check, delete) also has an always-present button, so no functionality is lost where the gesture is absent.

**Trade-off (explicit):** the gesture is unavailable to a mouse and under `prefers-reduced-motion: reduce`. This is deliberate — the buttons are the complete path; swipe is an enhancement layered only where a finger and full motion are both present.

**Contract:**

- **Coarse-pointer + touch gated.** The action no-ops unless `matchMedia('(pointer: coarse)')` matches **and** the pointer event's `pointerType === 'touch'`. On a desktop / fine pointer, rows are not draggable at all.
- **Reduced motion → not draggable.** Under `prefers-reduced-motion: reduce` the action no-ops (falling back to today's instant, button-only behaviour — no transform, no haptic), mirroring the other four lively-list treatments' reduced-motion fallback.
- **Thresholds are fixed:** `CHECK_THRESHOLD_PX = 78` (right) and `DELETE_THRESHOLD_PX = 78` (left); below threshold springs back. The release decision is pure arithmetic in `swipe.ts` (`resolveSwipe`) and is unit-tested without a DOM.
- **`touch-action: pan-y`** on the draggable element so a vertical scroll survives a drag attempt; the drag is claimed only past a `DRAG_START_PX` slop once horizontal travel dominates vertical.
- **Excluded row types.** Swipe is disabled on the breakdown-under-combined (`subordinate`) row, the product-form row, the "Need it?"/verify (`flagged`) row, in selection mode, and on a row mid check-off celebration (`exiting`). The combined row lives in `ShoppingListPage.svelte`, not `ShoppingItemRow.svelte`, so it is inherently excluded.
- **Composes with, never replaces, Phases 1 & 3.** The `translateX` drag and the reveal-behind layers live on an **inner** element; the `salt-row-collapse` root of `ShoppingItemRow.svelte` (its collapse + match-reveal transition directives) is never wrapped or transformed.
- **Reveal-behind layers reuse existing tokens only:** the check (right) layer is `bg-secondary-container` (sage); the delete (left) layer is `bg-destructive`. No new `--salt-*` token — `pnpm theme:check` stays green. The layers are `pointer-events-none` so they never swallow a button tap.

---

# 14. CanonIcon (primitive)

## 14.1 Overview

`CanonIcon` renders a square icon tile for a canon item. The tile always occupies the declared `size`; what is painted inside depends on the tri-state `thumbnail` value. It is intentionally simple: a `<span>` container with an optional `<img>` inside, plus two optional overlays (an initial letter, a reveal sweep) driven by the match-reveal props (§14.5).

The primitive duplicates a small amount of logic from `@salt/domain` (`isCanonIconRenderable`, `appendCacheBuster`) because `@salt/ui-components` is **external-only** and cannot import `@salt/domain`. Both copies must be kept in sync if the `"hidden"` sentinel or cache-bust join changes.

## 14.2 Props

| Name        | Type                            | Default | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thumbnail` | `string \| null`                | —       | Tri-state: a real download URL (renders `<img>`), `null` (pending — bare tile), or `"hidden"` (user opted out — bare tile). Required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `name`      | `string`                        | `''`    | `alt` text for the rendered `<img>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `size`      | `number`                        | `30`    | Tile (and icon) edge length in px; applied via inline `width`/`height` style.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `dimmed`    | `boolean`                       | `false` | Applies `opacity-40` — used for checked shopping-list items.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `version`   | `string \| number \| undefined` | —       | Per-regeneration cache-bust nonce. When non-empty, appended to the rendered `<img src>` as `?v=<version>` (or `&v=<version>` if the URL already contains `?`). Regenerated icons reuse the same byte-identical Storage URL, so the browser would otherwise serve a stale image without this nonce. Typically set to the canon item's `iconRequestedAt ?? updatedAt`. Omit or pass `null`/`undefined` to render the raw URL unchanged. `undefined` is explicit in the type (not just implied by `?`) so callers can safely pass a lookup result that widens to `undefined` under `exactOptionalPropertyTypes`. |
| `matched`   | `boolean`                       | `false` | The item this tile stands for is matched to a canon. At rest this changes only a **bare** tile (sage backdrop + initial letter); a tile that renders an `<img>` is unchanged at rest. Combined with `shimmer` it also lifts an icon tile for the reveal window. See §14.5.                                                                                                                                                                                                                                                                                                                                    |
| `shimmer`   | `boolean`                       | `false` | Play the one-shot match reveal on the tile: a translucent band sweeps across once, and — when `matched` is also true — the backdrop lifts to sage for the duration, then fades back. The **caller owns the window** (holds it `true` only for the reveal, and only when motion is allowed). See §14.5.                                                                                                                                                                                                                                                                                                        |
| `class`     | `string \| undefined`           | —       | Merged onto the root `<span>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 14.3 Tri-state `thumbnail` contract

| Value                             | Meaning                                       | Rendered output            |
| --------------------------------- | --------------------------------------------- | -------------------------- |
| non-empty string (not `"hidden"`) | Real icon URL (Firebase Storage download URL) | `<img>` inside the tile    |
| `null`                            | Icon has not been generated yet (pending)     | Bare tile (empty `<span>`) |
| `"hidden"`                        | User opted out of icon display                | Bare tile (empty `<span>`) |

The `renderable` predicate: `thumbnail !== null && thumbnail !== "hidden" && thumbnail.length > 0`.

## 14.4 Cache-bust behaviour

When an icon is regenerated, the Cloud Function writes a new image to the **same** Storage path, producing the same byte-identical download URL. Browsers cache by URL, so without intervention the stale image is served indefinitely.

The `version` prop solves this at the render layer:

```
bustedSrc = renderable && version != null && version !== ''
  ? `${thumbnail}${thumbnail.includes('?') ? '&' : '?'}v=${version}`
  : thumbnail
```

- `?` vs `&` join: uses `&` when the URL already has a query string, `?` otherwise — a raw Firebase Storage download URL typically has `?alt=media&token=…`, so the nonce always appends as `&v=`.
- A `null`, `undefined`, or empty-string `version` passes the raw URL through unchanged (no `?v=` appended).

## 14.5 Matched & reveal states

`matched` and `shimmer` serve the shopping list's "it found its home" moment (#571 Treatment 2), but the primitive keeps them general — it knows nothing about shopping lists, and the caller owns the reveal window.

### 14.5.1 The `lit` predicate

The sage backdrop is driven by one derived value:

```
sageBare = matched && !renderable
lit      = sageBare || (matched && shimmer)
```

| `matched` | `shimmer` | `renderable` | Backdrop                 | Initial letter  | Sweep overlay |
| --------- | --------- | ------------ | ------------------------ | --------------- | ------------- |
| `false`   | `false`   | `false`      | `bg-icon-tile`           | no              | no            |
| `false`   | `false`   | `true`       | none (transparent)       | no              | no            |
| `false`   | `true`    | `false`      | `bg-icon-tile`           | no              | yes           |
| `false`   | `true`    | `true`       | none (transparent)       | no              | yes           |
| `true`    | `false`   | `false`      | `bg-secondary-container` | yes (if `name`) | no            |
| `true`    | `false`   | `true`       | none (transparent)       | no              | no            |
| `true`    | `true`    | `false`      | `bg-secondary-container` | yes (if `name`) | yes           |
| `true`    | `true`    | `true`       | `bg-secondary-container` | no              | yes           |

Two rules fall out of this table and both are load-bearing:

- **`shimmer` alone never lights the tile.** An unmatched tile that sweeps keeps its resting backdrop — grey when bare, transparent when it renders an icon.
- **A matched tile with an icon lifts only during a reveal.** Gating the sage on `!renderable` alone made the moment invisible in its most common form — an item matching an established canon, which by now nearly always has a generated icon — leaving a sweep over an unchanged tile. The lift is transient (tied to `shimmer`) so the **resting** appearance of matched icons across the app is untouched.

### 14.5.2 At rest (`matched`, no `shimmer`)

Only a bare tile changes: it tints sage (`bg-secondary-container`) and shows the item's first initial, uppercased, in `text-accent-foreground` at `round(size * 0.5)` px, `aria-hidden`. This is the "found its home" resting state while the real icon generates. Empty `name` → no letter.

### 14.5.3 During a reveal (`matched` **and** `shimmer`)

Two things run at once, both starting on the same frame:

1. **The sage lift** — the grey↔sage change is a colour crossfade at `--duration-reveal` (400ms), carried by the tile's own `transition-colors duration-reveal`; when the caller closes the window it fades back the same way. The backdrop reads behind an icon because the pictograms leave margin and transparency around the artwork.
2. **The sweep** — `salt-icon-shimmer` slides one translucent band across the tile once over `--duration-shimmer` (700ms), **undelayed**. An absolutely-positioned overlay `<span>`, so it works over a bare, sage, or icon tile alike.

The caller's window must outlast the sweep for the one-shot to finish, and should not extend far past it: the sage lift drops when the window closes and that drop is the last thing the eye sees, so surplus reads as a separate trailing event.

### 14.5.4 Reduced motion

Fully suppressed under `prefers-reduced-motion: reduce`, belt and braces:

- The caller never sets `shimmer` when motion is reduced.
- `motion-reduce:` overrides are the second line of defence regardless: the tile keeps `bg-icon-tile` (`motion-reduce:bg-icon-tile` on the lit branch), `transition-colors` is `motion-reduce:transition-none`, and both the initial letter and the sweep overlay are `motion-reduce:hidden`.

Net effect under reduced motion: exactly today's grey bare tile, no letter, no sweep.

## 14.6 Tile styling

```
'salt-icon-lift relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded transition-colors duration-reveal ease-standard motion-reduce:transition-none'
```

plus the backdrop, which depends on **both** `lit` and `renderable`:

```
lit
  ? renderable ? 'bg-secondary-container motion-reduce:bg-transparent'
               : 'bg-secondary-container motion-reduce:bg-icon-tile'
  : renderable ? 'bg-transparent'
               : 'bg-icon-tile'
```

- `rounded` — the standard surface radius (ui-spec-v02 §2.3).
- **A tile that renders an icon has no backdrop.** The pictogram is the object; the pale grey square behind it (`--salt-icon-tile`, 93% lightness against a 100% white card) only diluted it. The tile keeps its box — `size`, `salt-icon-lift`, and the layout slot are unchanged — so nothing about column alignment moves.
- **A bare tile keeps `bg-icon-tile`.** It is a placeholder standing in for art that has not generated yet (or that the user hid), and it holds the text column straight down a list of part-matched rows. `bg-secondary-container` (sage) is the lit backdrop in both cases (§14.5).
- Every arm is a **literal** class string. Tailwind scans source text, so a composed `motion-reduce:${…}` would never generate a utility; the reduced-motion fallback is each state's own resting backdrop (§14.5.4).
- `salt-icon-lift` — footprint-shadow **geometry held at zero opacity** (`0 1px 2px hsl(195 20% 15% / 0)`). The ratified look is the icon sitting directly on the surface: with the tile transparent behind its art, no edge under it at all reads better than a hairline one, so the utility ships with nothing painted. The geometry stays declared rather than deleted so a footprint is one number away if a future surface needs the tile's square to read — and the tint is the palette's slate rather than neutral black so that edge would belong to Salt's cool greys. Deliberately not `shadow-sm`, which was never the fallback: at black/0.05 that token is too faint to define a 40px square. Defined in `salt.css` as a component-surface utility with literal values — no `--salt-*` token, so `pnpm theme:check` is unaffected.
- `relative` — the positioning context for the absolutely-positioned sweep overlay.
- `transition-colors duration-reveal ease-standard` — the grey↔sage crossfade, at the spec value rather than Tailwind's 150ms default; the static utility carries it so every consumer inherits the same pace.
- `overflow-hidden` — clips any image that slightly overflows the tile boundary, and confines the sweep band to the tile.
- The `<img>` inside uses `object-contain`, fills the tile (`h-full w-full`), and carries `salt-icon-art` — `saturate(1.4) contrast(1.16) drop-shadow(0 1px 1px hsl(195 20% 15% / 0.28))`. The generated palette is pale by design (measured mean saturation 0.11–0.50 against mean value 0.60–0.85), so this warms it without recolouring, and the shadow separates the pictogram's thick dark outline from the surface. It sits on the **image**, so a bare or sage tile is never filtered. Display-only: no stored asset changes, and the locked house style (docs/canon-icons.md) is untouched.
- `loading="lazy"` and `decoding="async"` defer off-screen images.

### 14.6.1 Sizing

A pictogram is drawn at one of **four** sizes, and `size` is typed `CanonIconSize = 32 | 40 | 64 | 96` so there is no fifth. The default is **32**, the bottom rung.

| size     | what sits there                                                                                                      | where                                                                                                                                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **32px** | a nested or secondary row, and an inline glyph inside a step's wrapped row — a picture that reads _under_ a 40px one | the product-form rows nested inside a catalog row; guided cook's mise-card header, prep-card ingredients, step-note container and its contents, and its loose-ingredient rows; the recipe reading view's per-step first-use and kit strips                         |
| **40px** | a primary list row, a chip, a pill                                                                                   | both shopping list rows, the recipe reading view's ingredient lines, cook mode's mise row and first-use chip, the catalog row, kitchen tools, the equipment list, guided cook's mise ingredient row, the ingredient match sheet, and `PictogramPill` (v0.12 §8.30) |
| **64px** | a sheet's or an edit page's subject header                                                                           | the shopping edit sheet, the equipment edit page                                                                                                                                                                                                                   |
| **96px** | a detail page — the record that _is_ the page                                                                        | the canon detail record                                                                                                                                                                                                                                            |

**Why a union and not a sentence.** This section said "every in-list and in-chip consumer renders at 40px" from #610 until #1051, and eight distinct values shipped at call sites underneath it — 26, 28, 32, 36, 40, 44, 64, 96 — with a ninth, 30, sitting in `CanonIcon` as its own default. The claim was guarded by nothing, so nothing went red. The rungs are now the prop's type: `pnpm typecheck` covers the `.ts` call sites and `pnpm check` the `.svelte` ones, which is where all of them live. A fifth rung is an amendment to this section and an edit to `CanonIconSize`, in that order.

**32 and 40 are one framing at two sizes.** Both are paired with the framing normalisation in `docs/canon-icons.md`: the asset's `contentMax: 108` is chosen for the 40px row tile, and 32 is that same art drawn smaller — no asset change, no regeneration. Prominence comes from the art filling its frame rather than from growing the tile.

## 14.7 Testing requirements

- Renders an `<img>` (with `data-testid="canon-icon-img"`) when `thumbnail` is a non-empty string that is not `"hidden"`.
- Renders **no** `<img>` when `thumbnail` is `null`.
- Renders **no** `<img>` when `thumbnail` is `"hidden"`.
- When `version` is a non-empty string/number, the rendered `<img src>` appends `?v=<version>` or `&v=<version>` correctly.
- When `version` is `null`, `undefined`, or `''`, the rendered src is the raw `thumbnail` URL.
- `dimmed` applies `opacity-40`; absence of `dimmed` does not.
- The root `<span>` has `data-testid="canon-icon"`.
- A **bare** tile has `bg-icon-tile`; a tile that renders an icon has `bg-transparent` and **not** `bg-icon-tile` (§14.6).
- The tile carries `salt-icon-lift` in every `thumbnail` state (real URL, `null`, `"hidden"`).
- `salt-icon-art` is on the `<img>`, never on the tile.

Matched & reveal states (§14.5):

- A bare `matched` tile has `bg-secondary-container`, not `bg-icon-tile`, and renders the uppercased name initial as `data-testid="canon-icon-initial"`, `aria-hidden`.
- No initial is rendered when `matched` but `name` is empty.
- A `matched` tile **with** an icon is unlit **at rest** (`bg-transparent`, no `bg-secondary-container`) and renders no initial.
- The reduced-motion fallback is per-state: a lit **bare** tile carries `motion-reduce:bg-icon-tile`, a lit **icon** tile carries `motion-reduce:bg-transparent` (§14.5.4).
- A `matched` tile with an icon **is** lit (`bg-secondary-container`) while `shimmer` is true, the `<img>` still renders, and no initial appears.
- An **unmatched** tile stays `bg-icon-tile` even while `shimmer` is true.
- The tile carries `transition-colors` and `duration-reveal` (not Tailwind's 150ms default).
- Not matched and no `shimmer` → the grey bare tile, unchanged, for every consumer that omits both props.
- `shimmer` renders the overlay as `data-testid="canon-icon-shimmer"` with the `salt-icon-shimmer` class; absent by default; present over a rendered icon too.
- axe: no violations for a rendered icon, nor for a matched + shimmering bare tile.

---

# 15. ImageCropper (primitive)

## 15.1 Overview

`ImageCropper` is a pan/zoom crop primitive for recipe hero photos. It wraps [`svelte-easy-crop`](https://www.npmjs.com/package/svelte-easy-crop) with a **locked 3:2 aspect ratio** (the recipe hero frame is always 3:2; this is not a prop) and exposes a single imperative method, `getCroppedBase64()`, via `bind:this`. The consumer calls this method from a "Save" button to obtain the cropped image as a bare base64 WebP string ready to hand to the upload callable.

Primary use case: the recipe photo upload/paste flow, where the user picks or pastes an image, adjusts the crop, and confirms.

## 15.2 Props

| Name      | Type                  | Default | Notes                                                                                                                                                 |
| --------- | --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`     | `string`              | —       | Object URL or data URL of the image to crop. Required. Changing `src` resets pan and zoom to their initial values so a re-pick always starts centred. |
| `maxEdge` | `number`              | `1600`  | Longest-edge cap (px) of the produced crop canvas. The server re-encodes to its own bound; this only limits the base64 payload sent over the wire.    |
| `class`   | `string \| undefined` | —       | Merged onto the outer wrapper `<div>`.                                                                                                                |

> **Aspect ratio is not a prop.** The recipe hero is always 3:2. Exposing `aspect` as a prop would allow callers to silently violate the recipe photo contract. If a future feature requires a different aspect, add a new primitive rather than parameterising this one.

## 15.3 Imperative handle (`getCroppedBase64`)

The component exposes one method on its instance, accessed via `bind:this`:

```ts
type ImageCropperHandle = {
  getCroppedBase64: () => Promise<string | null>;
};
```

**Contract:**

- Returns a **bare base64 string** (no `data:<mime>;base64,` prefix) of the cropped image, WebP-encoded at quality 0.92.
- Returns `null` when no crop area is ready yet (image still loading or not yet interacted with).
- The output canvas is forced to an exact 3:2 ratio (any sub-pixel rounding from the source selection is corrected at render time).
- `maxEdge` caps the long side of the canvas; the short side is derived from the 3:2 ratio.
- All Canvas/Blob work runs in the browser inside `ui-components` — never in `@salt/domain`.

**Typical call-site pattern:**

```svelte
<script lang="ts">
  import { ImageCropper } from '@salt/ui-components';
  import type { ImageCropperHandle } from '@salt/ui-components';

  let cropper = $state<ImageCropperHandle | undefined>(undefined);

  async function handleSave() {
    const base64 = await cropper?.getCroppedBase64();
    if (base64) await uploadRecipePhoto(base64);
  }
</script>

<ImageCropper bind:this={cropper} src={previewUrl} />
<Button onclick={handleSave}>Save photo</Button>
```

## 15.4 Behaviour

### Pan / zoom

- The crop stage is a fixed-3:2 container (`aspect-[3/2]`) with `svelte-easy-crop` filling it absolutely.
- The user pans by dragging the stage; zooms by mouse wheel, pinch (touch), or the zoom slider.
- `crop` (pan offset) and `zoom` are bound to `svelte-easy-crop`'s bindable props so the overlay stays in sync with the slider.

### Zoom slider

- A `<input type="range">` below the stage controls zoom (`min=1`, `max=3`, `step=0.01`).
- Labelled `aria-label="Zoom"` and carries `data-testid="image-cropper-zoom"`.

### Reset on new image

- A `$effect` keyed on `src` resets `crop`, `zoom`, and `croppedAreaPixels` to initial values whenever `src` changes, so re-picking an image always starts centred at 1×.

### Crop area tracking

- `svelte-easy-crop`'s `oncropcomplete` event fires on every pan/zoom change; the handler stores the pixel-space crop rectangle (`CropArea`) in `croppedAreaPixels`. `getCroppedBase64()` reads this rectangle.

## 15.5 Rendering pipeline (`getCroppedBase64`)

1. Read the stored `croppedAreaPixels` rectangle; return `null` if absent or zero-area.
2. Load the source image (`src`) via `new Image()` (promise-based).
3. Compute output dimensions: `outWidth = min(round(area.width), maxEdge)`, `outHeight = round(outWidth / (3/2))` — enforces exact 3:2 output.
4. Draw the selected source region onto an offscreen `<canvas>` at output dimensions via `ctx.drawImage`.
5. Encode as WebP at quality 0.92 via `canvas.toBlob('image/webp', 0.92)`.
6. Read the blob as a data URL via `FileReader` and strip the `data:<mime>;base64,` prefix.
7. Return the bare base64 string.

## 15.6 Testing requirements

- Renders a crop stage with the correct aspect ratio container (`aspect-[3/2]`).
- Renders a zoom slider with `data-testid="image-cropper-zoom"` and accessible `aria-label="Zoom"`.
- `getCroppedBase64()` returns `null` when no crop area is ready.
- `getCroppedBase64()` returns a non-empty string (bare base64, no `data:` prefix) after a crop is confirmed.
- Changing `src` resets pan, zoom, and crop area.
- The `class` prop is merged onto the outer wrapper `<div>`.

---

# 16. TopBar / AppShell — non-production environment banner

## 16.1 Overview

`TopBar` and `AppShell` accept two optional props, `envLabel` and `envClass`, that together render a centred environment banner on the top bar for non-production environments. The primitives themselves are **environment-agnostic** — they render whatever label and classes are passed in without branching on environment names or mapping environment strings to colours. The colour vocabulary lives entirely in `apps/web-pwa`, which supplies literal Tailwind classes so the PWA's Tailwind scanner can detect them via its own `@source` glob.

In production, both props are omitted and the bar renders with its default `bg-card` surface and no label.

## 16.2 `TopBar` props

| Name       | Type                  | Default     | Notes                                                                                                                                                                         |
| ---------- | --------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `envLabel` | `string \| undefined` | `undefined` | Centred environment label (e.g. `"Staging"`). Rendered dead-centre on the bar, independent of the `title` (left-aligned) and `actions` (right-aligned). Omit in production.   |
| `envClass` | `string \| undefined` | `undefined` | Tailwind classes overriding the bar surface — typically background, text, and border-colour tokens (e.g. `"bg-sky-100 text-sky-900 border-sky-200"`). Omit to keep `bg-card`. |

`envLabel` and `envClass` are independent: either can be supplied without the other, though in practice both are supplied together (a label with no colour override, or a colour override with no label, is unusual).

## 16.3 `AppShell` passthrough

`AppShell` forwards `envLabel` and `envClass` directly to the `TopBar` it renders. The props are identical in name and type on both components; `AppShell` adds no additional logic.

| Name       | Type                  | Notes                                 |
| ---------- | --------------------- | ------------------------------------- |
| `envLabel` | `string \| undefined` | Passed through to `TopBar` unchanged. |
| `envClass` | `string \| undefined` | Passed through to `TopBar` unchanged. |

## 16.4 Design contract

- **Environment-agnostic primitives.** `TopBar` and `AppShell` must not import or branch on any environment detection (e.g. `import.meta.env.MODE`, `PUBLIC_ENV`). They render whatever is passed in.
- **Colour vocabulary stays in the consuming app.** Tailwind only scans classes it can see as literals; environment-specific colour classes that exist only in runtime strings would be purged from the build. `apps/web-pwa` supplies the literal classes so they appear in source and are retained by Tailwind's `@source` scanner.
- **Omit in production.** When neither prop is passed, no banner is rendered and the bar keeps its default surface. Guard the props at the call site, not inside the primitive.

## 16.5 Typical call-site (web-pwa)

```svelte
<AppShell {navItems} {currentPath} envLabel={ENV_LABEL} envClass={ENV_CLASS}>…</AppShell>
```

Where `ENV_LABEL` and `ENV_CLASS` are derived from `$env/static/public` in `web-pwa`. Illustrative mapping (colour classes are Tailwind literals in the app source, not in the primitive):

| Environment | `envLabel`      | `envClass`                                          |
| ----------- | --------------- | --------------------------------------------------- |
| Local       | `"Local"`       | `"bg-sky-100 text-sky-900 border-sky-200"`          |
| Development | `"Development"` | `"bg-violet-100 text-violet-900 border-violet-200"` |
| Staging     | `"Staging"`     | `"bg-amber-100 text-amber-900 border-amber-200"`    |
| Production  | _(omit)_        | _(omit)_                                            |

## 16.6 Testing requirements

- When `envLabel` is provided, the label text is rendered centred on the bar.
- When `envLabel` is omitted, no label element is rendered.
- When `envClass` is provided, its classes are applied to the bar surface (replacing or extending the default surface class).
- When `envClass` is omitted, the bar uses its default `bg-card` surface.
- `AppShell` forwards both props to `TopBar` unchanged.

---

# 17. BottomNav overflow ("More") + `AppShell` `overflowNavItems`

## 17.1 Overview

Navigation is split into two tiers. **Primary** destinations (`navItems`) are the ones you cook with and stay on the mobile tab bar; **secondary** destinations (`overflowNavItems`) are folded behind a trailing "More" tab that opens them in a bottom `Sheet`. The split is expressed once, at the `AppShell` call site, and each viewport spends it differently:

- **Desktop (`SideNav`)** — no fold. `SideNav` receives `[...navItems, ...overflowNavItems]` and lists every destination inline; a vertical rail has the room.
- **Mobile (`BottomNav`)** — `BottomNav` receives `navItems` as its tabs and `overflowNavItems` separately, and renders the "More" tab itself.

**Rationale:** the bar is `h-14` and full-width; past four tabs each column is too narrow for the active-indicator pill (§17.5) and its label to sit legibly side by side. Four primary tabs plus More is the ceiling. The primitives are **destination-agnostic** — they do not know which routes are primary; the app supplies both lists.

## 17.2 `AppShell` props

- `navItems: NavItem[]` — primary destinations.
- `overflowNavItems?: NavItem[] = []` — secondary destinations. Forwarded to `BottomNav` as `overflowItems`; concatenated after `navItems` for `SideNav`.

`AppShell` adds no logic beyond that split — no reordering, no truncation, no promotion of an active overflow route into the primary tabs.

## 17.3 `BottomNav` props

- `items: NavItem[]` — the tabs rendered inline.
- `overflowItems?: NavItem[] = []` — destinations behind the More tab. **Empty (or omitted) renders no More tab at all** — a nav with nothing to fold looks exactly as it did before this section existed.
- `overflowLabel?: string = 'More'` — the tab's label **and** the title of the sheet it opens; one string, so the two can never disagree.
- `currentPath: string`, `class?: string` — unchanged.

## 17.4 Behaviour

- **The More tab is a `SheetTrigger`, not an anchor.** It has no `href`; it opens a `side="bottom"` `Sheet` listing the overflow destinations. It still occupies a full `<li class="flex flex-1">` tab column and the trigger itself carries `flex flex-1` (§13.2).
- **Selected state stands in for the fold.** The More tab renders as active whenever the current route matches **any** overflow item — otherwise a user sitting on a folded route sees nothing in the bar selected. Active matching uses the same prefix rule as the inline tabs.
- **Badges aggregate.** The More tab's badge is the **sum** of its overflow items' badges, and is omitted when that sum is zero. A count (the Admin needs-approval queue) must never be silently hidden by being folded away. Inside the sheet each row still shows its own badge.
- **Rows close the sheet on click.** Hash navigation does not unmount the sheet, so each destination row sets `open = false` on click.
- **Sheet content is scroll-bounded and gesture-safe** — `max-h-[70dvh] overflow-y-auto`, with bottom padding of `calc(1.5rem + env(safe-area-inset-bottom))` so the last row clears the home indicator.

## 17.5 Active indicator — filled capsule

**Constraint:** the selected tab is marked by a **filled capsule behind its icon** (`bg-accent text-accent-foreground`), not by colour alone.

**Rationale:** a shape cue stays legible under kitchen glare, at a glance, and for colour-blind users (WCAG 1.4.1 — not by colour alone). `accent`/`accent-foreground` are Material 3's secondary-container / on-secondary-container pair, and `SideNav` already uses them for its active row, so mobile and desktop read the same.

**Contract:**

- Active tab: capsule `bg-accent text-accent-foreground`; label `font-semibold text-foreground`.
- Inactive tab: icon and label both `muted-foreground`. `foreground/40` is **forbidden** here — at ~2.5:1 on the card it is under the WCAG text minimum for a 10px label, and now that the capsule does the differentiating work the inactive state does not need to be washed out. `muted-foreground` is ~9.7:1.
- The badge anchors to the capsule's **top edge**, not above it: the row is only `h-14`, so a badge hung off the top pokes through the nav's `border-t` and floats over the page behind it.

## 17.6 Testing requirements

- With `overflowItems` empty or omitted, no More tab is rendered and the bar is exactly `items.length` columns.
- With `overflowItems` non-empty, a trailing More tab is rendered, labelled `overflowLabel`, and its column is `flex flex-1` (§13.2).
- Activating the More tab opens a bottom sheet titled `overflowLabel` listing every overflow item.
- The More tab is active when `currentPath` matches an overflow item, and inactive when it matches an inline item.
- The More tab's badge equals the sum of the overflow items' badges, and is absent when that sum is zero.
- Clicking an overflow row closes the sheet.
- `AppShell` passes `[...navItems, ...overflowNavItems]` to `SideNav`, and `navItems` / `overflowNavItems` separately to `BottomNav`.
- The active tab carries `bg-accent`; inactive tabs carry `muted-foreground` and never `foreground/40`.
- axe: no violations for the bar with an overflow tab, both closed and open.
