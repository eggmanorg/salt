# Salt 2.0 — UI Primitives Specification (v0.12)

**Status:** Planning  
**Scope:** `@salt/ui-components` — `PictogramPill`  
**Audience:** AI code-generation agents + human contributors

> Rule: If anything is missing or ambiguous → STOP → extend this spec → regenerate.  
> No invention beyond what is written here.

This document extends **v0.2** through **v0.11**.  
All global rules, architecture, naming, styling, and testing conventions from v0.2 remain in force, as do v0.4 §14 (`CanonIcon`) and the whole of v0.9 §8.23 (`Chip`) — this spec adds one component and changes nothing about either.

---

## 0. v0.12 Scope

v0.12 introduces:

- **`PictogramPill`** — a drawn object, named: a 40px pictogram and the words for it, in one static pill (§8.30)

Nothing in v0.12 changes any existing component. `Chip` is untouched in every respect — no new variant, no new size, no change to `.salt-chip--fact svg`.

---

# 8.30 PictogramPill

## 8.30.1 Overview

A **`PictogramPill`** states one physical object by showing it and naming it: a
40px pictogram tile at the pill's rounded left end, the object's words beside it.
It is read, never pressed.

Today's objects are kitchen tools — the recipe page's "You'll need" strip and the
kit a cook-mode step calls for — but the primitive knows nothing about kit. It is
handed an already-resolved thumbnail and a label; what the object is, and how the
label found its picture, belong to the caller (§8.30.7).

## 8.30.2 Why not a `Chip` (issue #955)

`Chip variant="fact"` is a **26px text pill**: `px-3 py-1 text-xs` over a border
box, built around a 12px monochrome lucide glyph (v0.9 §8.23.8). A drawn
pictogram does not fit in it in either direction.

- **At the chip's own icon size the picture is not a picture.** v0.4 §14.6.1 sets
  40px for every in-list and in-chip pictogram, paired with the `contentMax: 108`
  framing in `docs/canon-icons.md`. That framing leaves a transparent margin by
  design, and a landscape-shaped subject — a frying pan, a mandoline, a baking
  tray — paints only about half the nominal height. The first consumer that put a
  pictogram in a `fact` chip sized it at 18px and painted a 15 × 9 px smudge.
- **At 40px it stops being a chip.** A 40px tile inside `py-1` makes the pill
  ~48px tall, with 12px text floating beside a picture nearly four times its
  height.

So the container was what was wrong, not the number. The routes not taken, and
why:

- **A size variant on `Chip`** — refused by v0.9 §8.23.4, which records that one
  chip size replaced two that shipped from pages guessing. A size axis would
  re-legitimise exactly that drift.
- **Widening `.salt-chip--fact svg` to catch an `<img>`** — that clamps the
  picture to 12px, i.e. it makes a text pill able to hold a picture badly. (The
  `svg`-only selector was nevertheless a real hole: it is why a caller could
  size its own glyph at all. **Closed in v0.9.4**, and not by widening it —
  `Chip`'s `icon` is now an `IconName` the chip draws itself, so a raster glyph
  in that slot is a type error rather than a smudge.)
- **A fifth chip variant** — a `Chip` is a small text pill; `text-base`, a 40px
  tile and an asymmetric padding switch are not a variant of that, they are a
  different object. `PictogramPill` is deliberately **not** named `*Chip` so it
  cannot be read as one.

## 8.30.3 Anatomy and geometry

One box, one size. There are no variants and no size prop, for v0.9 §8.23.4's
reason: a size left to the call site drifts.

```
<span>                                    ← the pill: the whole component
  <span aria-hidden="true">               ← present only when there is a picture
    <CanonIcon size={40} name="" />       ← decorative; name empty, alt="" (§8.30.6)
  </span>
  <span>{label}</span>                    ← the words, and the accessible name
</span>
```

| Part               | Classes                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Pill               | `inline-flex items-center gap-2 rounded-full border border-dashed bg-card py-1 pr-4 text-base`           |
| Pill, left padding | `pl-1` with a picture, `pl-4` without (§8.30.4)                                                          |
| Tile               | `CanonIcon` at `size={40}`, `class="rounded-full"`, `name=""`, wrapped in `aria-hidden="true"` (§8.30.6) |
| Label              | `min-w-0 break-words`                                                                                    |

- **Dashed border, `bg-card`.** The pill inventories a thing you either have or
  do not; the dashed outline says "not one of the app's own objects — a thing in
  your kitchen", the same voice v0.9 §8.23 gives `expander`'s dashed pill for
  "not one of the things".
- **`text-base`, not `text-xs`.** The words are read across a worktop at arm's
  length, and they must hold their own beside a 40px picture rather than hide
  under it.
- **`break-words` and `min-w-0`.** "large heavy-based casserole dish" is a real
  label; it wraps inside the pill rather than pushing the row sideways. The
  caller owns the row and keeps the pill from stretching (`shrink-0 max-w-full`
  on a list item, as the cook-step list does).
- **`inline-flex`, not `flex`.** Every other static pill in the package
  (`.salt-chip--fact` and its siblings, v0.9 §8.23.8) is inline-level; a
  block-level pill stretches to fill any non-flex parent it is dropped into.
  `inline-flex` is what makes the pill sit inline in ordinary prose flow — the
  `shrink-0 max-w-full` above is a _separate_ obligation, for when the caller's
  own row is a flex container the pill must not stretch or overflow inside.

## 8.30.4 The padding switch

`pl-1` when a picture renders, `pl-4` when it does not.

The tile is round-cornered art in a round-ended pill: 4px of padding sets it
flush in the pill's left end, so the picture reads as the pill's own end rather
than as something floating inside it. With no tile the same 4px would leave the
words hard against the border, so the label falls back to the pill's normal 16px
inset and the pill reads as a plain word-pill.

This is one class switch on one condition, not an axis. It is not exposed as a
prop: the condition is "is there a picture", which the component already knows.

## 8.30.5 The picture, and the three ways there isn't one

`thumbnail` is `CanonIcon`'s tri-state (v0.4 §14.2), plus the caller's own
"nothing resolved". A picture renders only for a non-empty string that is not the
`"hidden"` sentinel. In every other case — `null`, `"hidden"`, `''`, omitted —
the pill renders **no tile at all**, not a bare `CanonIcon` placeholder.

That is the whole of the miss path: a blank grey square inside a pill reads as a
broken picture, where words alone read as an object nobody has drawn yet. It also
means the pictogram kill-switch costs pictures and nothing else — the words are
the content, and a substitute picture is never shown.

The component therefore repeats `CanonIcon`'s renderable predicate rather than
delegating it, because it must decide the padding (§8.30.4) before it decides to
render a tile. Keep the two in sync if the `"hidden"` sentinel or the rule
changes — the same standing note `CanonIcon` itself carries, for the same reason
(`ui-components` is external-only and cannot import `@salt/domain`'s
`isCanonIconRenderable`).

## 8.30.6 Semantics — static, like the static chips

The pill renders a `<span>`, and v0.9 §8.23.8's reasoning applies verbatim: a
thing that cannot be pressed must not be reachable by Tab, and must not be
announced as a control.

- **No `onclick`.** Typed `never`. A pill that does something is a `Chip`
  (`filter`/`expander`) or a `Button`; if neither fits, amend this spec.
- **No hover, no focus ring, no pressed state.** There is nothing to press.
- **The words are the accessible content; the tile is decorative and silent.**
  The label span is what a reader gets — the tile must not repeat it.
  `CanonIcon` renders with an empty `name` (so its `<img alt>` is `""`), and
  the tile is wrapped in `aria-hidden="true"`. Without both, a screen reader
  announces the object twice: once from the image `alt`, once from the label
  span beside it. (An early draft of this section reasoned the opposite way —
  "the tile adds nothing a reader does not already get" — but that is the
  argument _for_ silencing it, not evidence it was already silent. The
  per-step kit row (`RecipeViewPage.svelte`'s `recipe-view-step-kit`) already
  solved this by hand with the same `aria-hidden` + empty/`sr-only` pattern;
  the primitive now does it natively so no caller has to remember.)
- **The pill is one element, not a list.** Row semantics — `<ul>`/`<li>`, an
  `aria-label` naming the set — belong to the caller, the only party that knows
  what the row is a list of.

## 8.30.7 Props

| Name        | Type                            | Default     | Notes                                                                                                        |
| ----------- | ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `label`     | `string`                        | —           | The object's words. Required: a pill with no name is a picture, and a picture on its own is not the content. |
| `thumbnail` | `string \| null \| undefined`   | `undefined` | An **already-resolved** pictogram URL, or one of the no-picture states (§8.30.5).                            |
| `version`   | `string \| number \| undefined` | `undefined` | Cache-bust nonce, passed straight to `CanonIcon` (v0.4 §14.4).                                               |
| `class`     | `string`                        | —           | Merged onto the pill via `cn`.                                                                               |

Plus the `HTMLAttributes<HTMLElement>` passthrough (`data-testid`, `data-*`,
`id`, `title`, `aria-*`), minus `onclick`, which is `never` (§8.30.6).

**The component never resolves a label into a picture.** The lookup is the
consuming app's — `kitIcons`'s `kitIconFor` / `kitIconVersionFor`
(`apps/web-pwa/src/lib/kitIcons.ts`) today — and it lives in `apps/web-pwa`
because it reads Firestore-backed vocabularies. A primitive that resolved names
would need those vocabularies, which is the layer-map boundary `ui-components`
exists on the far side of.

## 8.30.8 Testing requirements

- Renders a `<span>`, never a `<button>`; carries no `aria-pressed`, and
  `queryByRole('button')` finds nothing.
- Not reachable by Tab — no tab stop of its own.
- Renders the label's words.
- With a thumbnail: renders `CanonIcon` at 40px (the tile's inline
  `width: 40px`), and the pill carries `pl-1` and not `pl-4`.
- Without a thumbnail — `null`, `"hidden"`, `''` and omitted — renders **no**
  `canon-icon` tile at all, and the pill carries `pl-4` and not `pl-1`.
- `version` reaches the rendered `<img src>` as the cache-bust (v0.4 §14.7 owns
  the join rule; this is only that it is passed through).
- `data-testid` and the rest of the passthrough land on the pill element.
- The pill is inline-level (`inline-flex`, not `flex`), so it does not
  stretch to fill a non-flex parent.
- With a thumbnail, the tile is not part of the accessible name: it is
  `aria-hidden` and its `<img>` carries an empty `alt`, so the label is
  announced once, not twice. (This is not axe-detectable — axe has no rule for
  a doubled announcement — so a green axe run is not evidence either way.)
- No axe violations, with a picture and without.

## 8.30.9 Forbidden

- **Do not add a size prop or a size variant.** One size (§8.30.3). If a surface
  genuinely needs another, that is a v0.13 section, not a call-site number.
- **Do not add an `onclick`, a hover treatment or a focus ring.** §8.30.6.
- **Do not render a bare `CanonIcon` placeholder on a miss.** §8.30.5.
- **Do not resolve a label into a picture inside the primitive.** §8.30.7.
- **Do not hand-roll this pill in an app again.** It existed as two byte-identical
  copies in `apps/web-pwa` before this spec, and the third surface that needed it
  reached for the wrong primitive instead. That is the mechanism the promotion
  closes.
