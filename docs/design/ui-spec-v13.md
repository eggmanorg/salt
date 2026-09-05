# Salt 2.0 — UI Primitives Specification (v0.13)

**Status:** Ratified after the fact — see §0.1  
**Scope:** `@salt/ui-components` — `FormPage`, `DetailPage` (base contract), `EmptyState`, `ErrorState`  
**Audience:** AI code-generation agents + human contributors

> Rule: If anything is missing or ambiguous → STOP → extend this spec → regenerate.  
> No invention beyond what is written here.

This document extends **v0.2** through **v0.12**.  
All global rules, architecture, naming, styling, and testing conventions from v0.2 remain in force. v0.7 §1 (`DetailPage` fill mode) is unchanged and remains the owner of that mode; §2 below is the base component it amends.

---

## 0. v0.13 Scope

v0.13 specifies four components that were **already shipped**:

- **`FormPage`** — the titled form template: header, body, and a footer that owns the submit/cancel pair (§1)
- **`DetailPage`** — the base detail template: back affordance, title row, actions, optional metadata aside (§2). Fill mode stays in v0.7 §1.
- **`EmptyState`** — the "there is nothing here" panel (§8.31)
- **`ErrorState`** — the "this did not load" panel, with a retry (§8.32)

Nothing here changes any existing component's behaviour. Every clause below was
read off the shipped implementation and is a **ratification**, not a redesign:
the code is unchanged by this document, and any future change to it is a normal
amendment against these sections.

## 0.1 Why this spec is being written after the code (issue #976)

These four components shipped with provenance headers that named a real
document and a section that did not exist in it:

| component    | header said            | what that section actually is                                                 |
| ------------ | ---------------------- | ----------------------------------------------------------------------------- |
| `EmptyState` | `ui-spec-v02.md §8.25` | v0.2's §8 stops at **8.15 Progress**. §8.25 is v0.9's **CollapsibleSection**. |
| `ErrorState` | `ui-spec-v02.md §8.26` | v0.9's **DisclosureTrigger / DisclosureChevron**.                             |
| `FormPage`   | `ui-spec-v02.md §9.2`  | v0.2's §9 is the **Changelog**. §9.2 is v0.4's **ListPage behaviour**.        |
| `DetailPage` | `ui-spec-v02.md §9.3`  | v0.4's **`ListPage` props changes**.                                          |

`check-provenance.ts` resolved the **document** and never the `§`, so all eight
files passed. The header was not a stale cross-reference that drifted — there
was never a section behind it. CLAUDE.md's rule ("the specs are binding: if
something is missing or ambiguous, stop and extend the spec rather than
inventing") was not followed for these four, and the guard's blind spot is why
nobody noticed for the ~34 consuming files that grew on top of them.

The fix for the guard is in v0.2 §3.8 (amended v0.2.17): the checker now parses
the cited document's headings and fails when the cited section is not among
them. **Repointing these headers at some other existing section would have made
the guard green over components that still had no specification** — strictly
worse than the broken link, because the link at least announced itself. So the
sections were written instead, and this is them.

---

# 1. FormPage (template)

## 1.1 Overview

A **`FormPage`** is a whole page that is one form: a title, an optional line of
explanation, a body of fields the caller supplies, and a footer that owns the
submit/cancel pair so no page hand-rolls it.

It is the third page template, beside `ListPage` (v0.4 §9, v0.5 §1) and
`DetailPage` (§2). It renders a real `<form>` element and its submit button is a
real `type="submit"`, so Enter-in-a-field submits the way the platform already
does it — the template exists so that behaviour is free, not so it can be
re-implemented per page.

Consumers today: `SettingsPage`, `ShoppingListCreatePage`,
`EquipmentCapturePage`.

## 1.2 Anatomy

```
<form novalidate>                       ← flex column, gap-6
  <header>                              ← gap-1
    <h1>{title}</h1>                    ← text-xl, semibold, tracking-tight
    <p>{description}</p>                ← optional, text-sm, muted
  </header>
  <div>{children}</div>                 ← flex column, gap-4 — the fields
  <footer>                              ← right-aligned, gap-2, top border
    {footer}  OR  [Cancel] [Submit]
  </footer>
</form>
```

The body is a flex column with `gap-4`, which is the page's field rhythm.
A caller that needs a different rhythm for one group wraps that group; it does
not restyle the body.

## 1.3 The form is real, and `novalidate` is deliberate

- The root element is a `<form>`, and submission goes through its `submit`
  event. The template calls `preventDefault()` and then `onSubmit`, so the
  caller never sees a navigation and never has to remember to stop one.
- `novalidate` is set, so the browser's own constraint bubbles never appear.
  Validation is the page's, expressed through the fields' own `error` /
  `invalid` props (v0.2 §8.2) and through `canSubmit`. Two validation systems
  disagreeing on the same form is worse than one, and the platform's cannot be
  styled or translated.
- `canSubmit` disables the submit button; it does **not** block the `submit`
  event, because a disabled button cannot raise one. There is no second gate
  inside the handler.

## 1.4 Submitting

- `isSubmitting` puts the submit button into its `loading` state (v0.2 §4.3) and
  disables the cancel button. Both, together: a cancel that stays live during an
  in-flight write is a way to leave the page mid-write.
- `isSubmitting` does **not** disable the fields. A form that grays out under
  the user mid-keystroke reads as broken; the submit button is the gate.
- The template performs no submission of its own. `onSubmit` is the page's, and
  every error, toast and navigation after it is the page's too.

## 1.5 The footer snippet replaces the pair, it does not extend it

When `footer` is supplied it is rendered **instead of** the default
cancel/submit pair, inside the same right-aligned footer row. There is no
prop for "an extra button beside the defaults": a page that needs a third
action supplies the whole row, which keeps the default's contract (what
`isSubmitting` and `canSubmit` mean) from applying to buttons it knows nothing
about.

`submitLabel`, `cancelLabel`, `isSubmitting`, `canSubmit`, `onCancel` are all
inert when `footer` is supplied. This is declared, not enforced.

## 1.6 Props

| Name           | Type                           | Default     | Notes                                                                    |
| -------------- | ------------------------------ | ----------- | ------------------------------------------------------------------------ |
| `title`        | `string`                       | —           | Required. Rendered as the page's `<h1>`.                                 |
| `description`  | `string`                       | `undefined` | One line under the title.                                                |
| `submitLabel`  | `string`                       | `'Save'`    | Default-footer only (§1.5).                                              |
| `cancelLabel`  | `string`                       | `'Cancel'`  | Default-footer only.                                                     |
| `isSubmitting` | `boolean`                      | `false`     | Submit shows `loading`; cancel is disabled (§1.4).                       |
| `canSubmit`    | `boolean`                      | `true`      | `false` disables the submit button.                                      |
| `onSubmit`     | `(event: SubmitEvent) => void` | `undefined` | Called after `preventDefault()`.                                         |
| `onCancel`     | `() => void`                   | `undefined` | Omitted ⇒ **no cancel button is rendered at all** in the default footer. |
| `footer`       | `Snippet`                      | `undefined` | Replaces the whole default pair (§1.5).                                  |
| `children`     | `Snippet`                      | `undefined` | The fields.                                                              |
| `class`        | `string`                       | —           | Merged onto the `<form>` via `cn`.                                       |

## 1.7 Testing requirements

- Renders a `<form>`; the submit button is `type="submit"`.
- Submitting calls `onSubmit` and does not navigate (`defaultPrevented`).
- `canSubmit: false` disables the submit button.
- `isSubmitting` disables cancel and puts submit in its loading state.
- No `onCancel` ⇒ no cancel button.
- `footer` replaces both default buttons.
- The title renders as the page's `<h1>`.

## 1.8 Forbidden

- **Do not validate inside the template.** §1.3.
- **Do not add a prop for one more footer button.** §1.5 — supply the snippet.
- **Do not disable the fields while submitting.** §1.4.
- **Do not remove `novalidate`.** §1.3.

---

# 2. DetailPage (template) — base contract

## 2.1 Overview

A **`DetailPage`** is one thing, shown: an optional back affordance, a title
(and optional subtitle), an optional cluster of actions, an optional metadata
aside, and a body.

v0.7 §1 specifies its `fill` mode and is unaffected by this section. This
section is the component v0.7 amends — it had no home before, which is why v0.7
had to describe itself as an amendment to a section that did not exist.

## 2.2 Anatomy

```
<section>                               ← flex column, gap-6 (+ h-full min-h-0 under fill)
  <header>                              ← flex column, gap-3
    [← Back]                            ← optional, ghost sm Button, ArrowLeft leading
    <div flex-wrap items-start gap-3>
      <div>                             ← min-w-0
        <h1>{title}</h1>   OR   {titleSlot}
        <p>{subtitle}</p>               ← optional, text-sm, muted
      </div>
      <div ml-auto shrink-0>{actions}</div>   ← optional
    </div>
  </header>
  {metadata}
    ? grid [1fr minmax(220px,280px)] — body + sticky aside
    : body alone
</section>
```

## 2.3 The actions cluster is `ml-auto`, not `justify-between`

The title row wraps. With `justify-between`, a row that wrapped put the actions
on their own line at **flex-start** — left-aligned, under the title, which reads
as a second title rather than as controls. `ml-auto` on the actions keeps them
right-aligned in both cases: inline with the title when they fit, and still
right when they wrap. `shrink-0` keeps them from being compressed by a long
title, and `min-w-0` on the title column is what lets the title truncate instead
of pushing them off.

## 2.4 `titleSlot` replaces the heading, and owns its own semantics

`titleSlot` renders **instead of** the `<h1>`, for a title that is not only
text — a title with a chip, an inline editable title. A page that supplies it
takes on the heading semantics itself: the template renders no `<h1>` in that
case, and a page that renders none has a document with no page heading.

`title` remains required even when `titleSlot` is supplied — it is the prop the
page is identified by and the fallback if the slot is ever dropped.

## 2.5 The metadata aside

Supplying `metadata` switches the body to a two-column grid at `lg` and above —
`[1fr minmax(220px, 280px)]`, `items-start` — with the aside `lg:sticky
lg:top-4`. Below `lg` it is one column and the aside falls under the body.

**`metadata` and `fill` are mutually exclusive** (v0.7 §1.5): the aside's
stickiness presupposes the ancestor scroller that `fill` removes. Declared, not
enforced.

## 2.6 Props

| Name        | Type         | Default     | Notes                                                            |
| ----------- | ------------ | ----------- | ---------------------------------------------------------------- |
| `title`     | `string`     | —           | Required, even with `titleSlot` (§2.4).                          |
| `subtitle`  | `string`     | `undefined` | One line under the title.                                        |
| `onBack`    | `() => void` | `undefined` | Omitted ⇒ no back button. The template never touches the router. |
| `backLabel` | `string`     | `'Back'`    |                                                                  |
| `actions`   | `Snippet`    | `undefined` | Right-aligned cluster (§2.3).                                    |
| `metadata`  | `Snippet`    | `undefined` | The aside (§2.5). Not with `fill`.                               |
| `titleSlot` | `Snippet`    | `undefined` | Replaces the `<h1>` (§2.4).                                      |
| `children`  | `Snippet`    | `undefined` | The body.                                                        |
| `class`     | `string`     | —           | Merged onto the `<section>` via `cn`.                            |
| `fill`      | `boolean`    | `false`     | **v0.7 §1.3** — specified there, listed here for completeness.   |

## 2.7 Testing requirements

- Renders the title as an `<h1>`; `titleSlot` replaces it and no `<h1>` remains.
- No `onBack` ⇒ no back button; with it, clicking calls `onBack`.
- `actions` are right-aligned via `ml-auto` and do not shrink.
- `metadata` renders the aside and the two-column grid; without it, neither.
- Fill mode is covered by v0.7 §1.7 and already has its suite.

## 2.8 Forbidden

- **Do not navigate from inside the template.** `onBack` is a callback; routing
  is the app's.
- **Do not combine `metadata` with `fill`.** §2.5.
- **Do not restore `justify-between` on the title row.** §2.3.

---

# 8.31 EmptyState

## 8.31.1 Overview

An **`EmptyState`** is the panel that says a place that could hold things
currently holds none: a dashed-border box with an optional icon, a title, an
optional line of explanation, and an optional row of actions.

It is `ListPage`'s default empty rendering (`title="Nothing here yet"`, v0.4
§9), and pages use it directly for their own empties — a filtered list with no
matches, a route that found nothing.

## 8.31.2 Empty is not an error

`EmptyState` is `role="status"` and `ErrorState` is `role="alert"` (§8.32.2),
and the split is the whole reason there are two components rather than one with
a `tone` prop:

- **Empty is an expected, polite state.** Nothing failed. `status` is a polite
  live region: a screen reader finishes what it is saying first.
- **Its border is dashed** — the established "a container, with nothing in it"
  drawing. `ErrorState` is solid and tinted.
- **It offers what to do next, not what to retry.** `actions` is a way in
  ("Add the first one"), not a way to try again.

A page showing `EmptyState` for a failed load is a bug: it tells the user their
data is absent when it is merely unreachable.

## 8.31.3 The title is required, the rest is not

`title` is the only required prop. An empty state with no words is an empty box,
which is the thing it exists to explain. Everything else — icon, description,
actions — is optional, and the common call (`ListPage`'s) passes only the title.

## 8.31.4 Props

| Name          | Type      | Default     | Notes                                                                                                           |
| ------------- | --------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `title`       | `string`  | —           | Required (§8.31.3). Rendered as an `<h3>`.                                                                      |
| `description` | `string`  | `undefined` | `max-w-md`, so it wraps at a readable measure rather than the panel's width.                                    |
| `icon`        | `Snippet` | `undefined` | Rendered above the title, in `text-muted-foreground`. The caller supplies the `Icon`; the primitive picks none. |
| `actions`     | `Snippet` | `undefined` | A centred row below.                                                                                            |
| `class`       | `string`  | —           | Merged onto the panel via `cn`.                                                                                 |

Everything else — `data-testid`, `data-*`, `id`, `aria-*` — rides `...rest` onto
the panel element, as it does on `Chip` (v0.9 §8.23.3). Added in v0.13.1 by
issue #930 Phase 9: four hand-rolled empty states being migrated onto this
component were selected by `data-testid` in their pages' tests, and without a
passthrough the migration would have meant either deleting the attribute or
leaving the site hand-rolled.

**`role` is the one attribute that is not passable.** §8.31.2 makes the
`status` / `alert` split the whole reason `EmptyState` and `ErrorState` are two
components rather than one with a `tone`, so a caller able to override it could
collapse that distinction from the outside. `role` is `Omit`ted from the
passthrough type and applied after the spread.

The heading level is `<h3>`, fixed. The panel sits inside a page that already
owns `<h1>` (and often an `<h2>` section), and a state panel is never the
document's own heading. It is not a prop: a level that varies per call is a
level nobody checks.

## 8.31.5 Testing requirements

- Renders `role="status"`, never `role="alert"`.
- Renders the title as an `<h3>`.
- Omitted `description`, `icon`, `actions` render nothing at all — no empty
  wrapper elements.
- `icon` and `actions` snippets render where §8.31.1's anatomy says.
- A passed `data-*` attribute reaches the panel, and a passed `role` does not
  displace `status`.
- No axe violations, with and without each optional part.

## 8.31.6 Forbidden

- **Do not add a `tone` or `variant` prop to make it look like an error.**
  §8.31.2 — that is `ErrorState`.
- **Do not make the heading level a prop.** §8.31.4.
- **Do not default an icon.** The primitive has no vocabulary for what the empty
  thing is.
- **Do not make `role` passable.** §8.31.2, and see the props note above.

---

# 8.32 ErrorState

## 8.32.1 Overview

An **`ErrorState`** is the panel that says something did not load: a
destructive-tinted box with a warning icon, a title that defaults to
"Something went wrong", an optional explanation, and a retry.

It is `ListPage`'s default error rendering (v0.4 §9) — bare `<ErrorState />`,
every prop defaulted — which is why the defaults are the ones that read
correctly with no arguments at all.

## 8.32.2 `role="alert"`, and the icon is labelled

- The panel is `role="alert"` — an assertive live region. A load that failed
  interrupts, because the content the user asked for is not coming.
- The warning icon carries `ariaLabel="Error"` rather than being decorative.
  It is the only thing in the panel that names the _kind_ of state when the
  title has been overridden to something specific.
- The title defaults to `'Something went wrong'`, so `<ErrorState />` is a
  complete, sayable panel.

## 8.32.3 Retry: `onRetry` renders it, `actions` replaces it

Two props, and the precedence between them is one way:

1. `actions` supplied ⇒ `actions` renders, and `onRetry` is **inert**.
2. Otherwise `onRetry` supplied ⇒ a `variant="outline" size="sm"` button
   labelled `retryLabel`.
3. Neither ⇒ no button. The panel still says what happened.

A page that needs "Retry" plus "Go back" supplies `actions` and owns both,
for the same reason `FormPage`'s footer works that way (§1.5): the default
exists to be free, not to be extended.

## 8.32.4 The template never retries

`onRetry` is a callback. `ErrorState` holds no attempt count, no backoff, no
in-flight state — a retry that is running is the page's `isLoading`, and the
page swaps the panel out. A primitive that owned retry state would own a
lifecycle it cannot see the end of.

## 8.32.5 Props

| Name          | Type         | Default                  | Notes                                                                         |
| ------------- | ------------ | ------------------------ | ----------------------------------------------------------------------------- |
| `title`       | `string`     | `'Something went wrong'` | Rendered as an `<h3>` (§8.31.4's reasoning applies identically).              |
| `description` | `string`     | `undefined`              | `max-w-md`. Put the human-readable cause here — never a raw error or a stack. |
| `onRetry`     | `() => void` | `undefined`              | Renders the retry button (§8.32.3).                                           |
| `retryLabel`  | `string`     | `'Try again'`            |                                                                               |
| `actions`     | `Snippet`    | `undefined`              | Replaces the retry button entirely.                                           |
| `class`       | `string`     | —                        | Merged onto the panel via `cn`.                                               |

Everything else — `data-testid`, `data-*`, `id`, `aria-*` — rides `...rest` onto
the panel element, exactly as on `EmptyState` (§8.31.4). Added in v0.13.2 by
issue #993 Phase 1, for the same reason §8.31.4 records: a hand-rolled failure
panel being migrated onto this component (`CookLoadingOrphan`) was selected by
`data-testid` in both cook pages' tests, and without a passthrough the migration
would have meant either deleting the attribute or keeping a wrapper element
whose only remaining job was to hold it.

**`role` is the one attribute that is not passable**, on the same reasoning as
§8.31.4: §8.31.2 makes the `status` / `alert` split the reason the two
components exist, so `role` is `Omit`ted from the passthrough type and applied
after the spread.

## 8.32.6 Testing requirements

- Renders `role="alert"`.
- `<ErrorState />` with no props renders the default title and no button.
- `onRetry` renders a button labelled `retryLabel`; clicking calls `onRetry`.
- `actions` and `onRetry` together render `actions` only — no retry button.
- The warning icon is labelled, not `aria-hidden`.
- No axe violations in each of the three cases in §8.32.3.
- A passed `data-*` attribute reaches the panel, and a passed `role` does not
  displace `alert`.

## 8.32.7 Forbidden

- **Do not put a raw error message, code or stack in `description`.** It is
  read by the family, not by us; and error reporting has its own channel
  (`ErrorReportingPort`, salt-architecture §7.6).
- **Do not add retry state to the primitive.** §8.32.4.
- **Do not use `EmptyState` for a failure, or this for an empty.** §8.31.2.

---

# 9. Changelog

| Date       | Version | Summary                                                                                                                                                     |
| ---------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-28 | v0.13   | Initial. Ratifies `FormPage` (§1), `DetailPage` base (§2), `EmptyState` (§8.31) and `ErrorState` (§8.32), which shipped without a spec section; issue #976. |
| 2026-09-05 | v0.13.2 | `ErrorState` gains the `...rest` passthrough `EmptyState` got in v0.13.1, `role` still excluded (§8.32.5); issue #993 Phase 1.                              |
