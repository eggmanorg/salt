# Salt 2.0 — UI Primitives Specification (v0.16)

**Status:** Planning  
**Scope:** `@salt/ui-components` — `Progress` presentational mode  
**Audience:** AI code-generation agents + human contributors

> Rule: If anything is missing or ambiguous → STOP → extend this spec → regenerate.  
> No invention beyond what is written here.

This document extends **v0.2** through **v0.15**.  
All global rules, architecture, naming, styling, and testing conventions from v0.2 remain in force, as does the whole of v0.2 §8.15 (`Progress`) — this spec adds one boolean prop and the alternate rendering it selects, and changes nothing else about the primitive.

---

## 0. v0.16 Scope

v0.16 introduces:

- **`Progress` presentational mode** — a `presentational` prop that renders the same bar as phrasing content, outside the accessibility tree (§1)

Nothing in v0.16 changes the default behaviour of any existing component. `presentational` defaults to `false`; every call site that does not pass it renders exactly the markup v0.2 §8.15 specifies, `role="progressbar"` and `aria-live="polite"` included.

---

# 1. Progress — Presentational mode

## 1.1 Why a mode, and why it is a spec amendment

The mode exists for one shape that v0.2 §8.15 cannot express: **a bar whose figure the surrounding content already states in words, inside a control.** The batch card on `/batches` is that shape (issue #1471, from #1407). The card is one `<button>` you tap to open the run, and inside it, two lines apart, sit the same fact twice — `1780 g — 26% lost of 35%` in words, and the bar as a picture of it.

Under the default mode that costs two things:

1. **The live region is read on every pass.** `aria-live="polite"` inside a `<button>` is announced whenever the button is read, not only when the value moves — so a person going down the list hears the bar bundled into every card, on top of the figure the card already gave them. ARIA's presentational-children rule strips descendant **roles** inside a `<button>` in most screen readers, which is why `role="progressbar"` is the lesser half of the problem; that rule does **not** silence a live region, and the live region is the half people actually hear.
2. **The markup is invalid.** `Progress.Root` renders a `<div>` containing a `<div>`. A `<button>` may contain **phrasing content only**, so a bar is the one block-level thing on a card whose every other child is a `<span>`.

`announce="off"` is not this. It removes `aria-live` and nothing else: `role="progressbar"` with its `aria-valuenow` still restates the figure, and the two `<div>`s still sit inside the `<button>`. The gap v0.2 §8.15 leaves is that `Progress` can say "announce" or "don't announce" but never **"this is a picture — ignore it"**, and only the second of those also fixes the content model.

A prop change to a primitive is a spec amendment rather than a call-site decision, by the precedent of v0.11. This is that amendment, written before the prop was added.

Why not something else:

- **A second bar primitive** — issue #1407's **Must not touch** forbids a new `@salt/ui-components` primitive, and a second bar would duplicate geometry that must stay pixel-identical to the first.
- **`Dial` (v0.8)** — a radial SVG ring. A different visual idiom carrying a different meaning; #1407 settled on the bar.
- **`aria-hidden` wrapped round the existing markup at the call site** — silences the announcement and leaves the `<div>`-in-`<button>` violation exactly where it was. Half a fix.
- **The card ceasing to be a `<button>`** — a live region inside an `<a>` is announced on every reading too, so it does not fix the defect at all, and it overturns a settled decision about the tap target.

## 1.2 What this amends in v0.2 §8.15

v0.2 §8.15 stays in force in full. Its **Accessibility** bullets — bits-ui `Progress.Root`, `role="progressbar"`, `aria-valuemin`/`aria-valuemax`/`aria-valuenow`, `aria-label`, `aria-live` when `announce` is `'polite'` — describe the **default mode**, and remain binding for it without exception. §1.4 below is what replaces them, and only when `presentational` is `true`.

Its **Behavior** and **Styling** sections are amended in no respect. Indeterminate, determinate, clamping and every CVA class apply identically in both modes, by construction: the two branches share one headless state object and one computed transform string.

## 1.3 Props

Additive to the v0.2 §8.15 table.

| Name             | Type      | Default | Notes                                                                                                                        |
| ---------------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `presentational` | `boolean` | `false` | `true` renders the bar as phrasing content, outside the accessibility tree. `announce` and `ariaLabel` are ignored when set. |

A boolean and not a third `announce` value. `announce` is about a live region; this mode is about what the bar **is**, and it changes the element names as well as the ARIA.

## 1.4 Behaviour — what the mode renders

When `presentational` is `true`:

- The root is a `<span>` carrying `progressRootVariants()` plus `block`, and `aria-hidden="true"`.
- The indicator is a `<span>` carrying `progressIndicatorVariants({ indeterminate })` plus `block`.
- There is **no** `role`, **no** `aria-live`, **no** `aria-valuemin`/`aria-valuemax`/`aria-valuenow`, and **no** `aria-label`.
- bits-ui is not used. `Progress.Root` cannot render a span, and its `data-*` tokens describe a widget that is no longer there.
- The determinate transform, the indeterminate animation and the clamp are the default mode's, unchanged.

`block` is the whole of the visual difference in the markup and it restores nothing more than what a `<div>` gave for free — an inline `<span>` would drop `w-full` and `h-full` on the floor. Geometry, colour and the transform are otherwise identical, and §1.6 pins that.

**`aria-hidden="true"` is safe here and would not be on an arbitrary subtree:** the mode renders two empty spans and nothing else. It can contain no text, no control and nothing focusable, so it cannot hide anything from a screen reader that a sighted user can reach.

## 1.5 When to use it

- Use it when the bar sits **inside** a control (`<button>`, `<a>`), where the default mode is both loud and invalid markup.
- Use it when the same figure is already stated in words **within the same announced unit**, so the bar adds nothing a screen reader user does not already have.
- **Do not** use it for a bar that is the only statement of progress. That bar is the default mode's job, and silencing it removes the figure from a screen reader entirely rather than de-duplicating it.

The choice is the call site's, made against those three sentences. Nothing here changes an existing call site: `MinePage`, `BatchDetailPage` and `MealCookPlanPage` each render the bar standing alone, outside any control, and the announcing default is correct for all three.

## 1.6 Testing requirements

Additive to v0.2 §6, which stands in full.

- `presentational` renders **no** element with `role="progressbar"`, no `aria-live` and no `aria-valuenow`.
- `presentational` renders the **same** determinate transform style as the default mode at the same `value` and `max` — asserted against the default mode's own output, not against a literal, so the two cannot drift.
- `presentational` renders no `<div>`.
- `axe` is clean in both determinate and indeterminate presentational renders.
- Every existing `Progress` assertion still passes unchanged, proving the default is untouched.

## 1.7 Forbidden

- **Do not give the presentational mode a `role`, an `aria-label`, or any `aria-value*`.** A picture of a figure stated in words is either out of the tree or it is the default mode; there is nothing in between.
- **Do not diverge the geometry.** Any class, transform or clamp added to one mode is added to both, or it is a bug. Keep the shared headless state and the shared transform string.
- **Do not reach for it to quieten a bar that is the only statement of progress** (§1.5).
- **Do not extend the mode to carry text, a control, or anything focusable.** `aria-hidden` is only safe over the two empty spans §1.4 describes.
