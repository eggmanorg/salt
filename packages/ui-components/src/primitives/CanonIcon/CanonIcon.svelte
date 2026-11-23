<!-- spec: ui-spec-v04.md §14 v0.4 -->
<script lang="ts">
  import { cn } from '../../lib/cn';
  import type { CanonIconProps } from './CanonIcon.types';

  let {
    thumbnail,
    name = '',
    size = 32,
    dimmed = false,
    version,
    matched = false,
    shimmer = false,
    class: className,
  }: CanonIconProps = $props();

  // Sentinel `thumbnail` value meaning "user hid this icon; never regenerate".
  // The same string as @salt/domain's `CANON_ICON_HIDDEN` — see the note below
  // for why it is respelled here rather than imported.
  const HIDDEN = 'hidden';

  // Tri-state render boundary. This mirrors @salt/domain's
  // `isCanonIconRenderable`; ui-components cannot import @salt/domain
  // (external-only per the layer map, `eslint.config.js`'s
  // `{ from: 'ui-components', allow: [] }`, and a package.json carrying no
  // `@salt/*` dependency at all), so the logic is duplicated here as the single
  // render boundary.
  //
  // THE COPY IS NOW HELD BY A TEST, NOT BY THIS COMMENT (issue #933).
  // `apps/web-pwa/tests/canonIconParity.test.ts` mounts this component and
  // asserts its rendered `src` and its render/no-render decision match
  // `appendCacheBuster` and `isCanonIconRenderable` over a shared input table —
  // `web-pwa` being the one package that may legally import both. Editing either
  // side alone turns that test red. Asking the next author to remember is what
  // failed before.
  const renderable = $derived(thumbnail !== null && thumbnail !== HIDDEN && thumbnail.length > 0);

  // Display-time cache-bust. A regenerated icon reuses the same (byte-identical)
  // Storage download URL, so the browser serves the stale image; appending a
  // per-regeneration `?v=`/`&v=` nonce forces a re-fetch. Only applied when the
  // icon is renderable (never to `null`/`"hidden"`) and a non-empty `version` is
  // present (an empty version carries no cache-key info); otherwise the raw URL
  // passes through unchanged. Behaviourally identical to @salt/domain's
  // `appendCacheBuster`; the `?`/`&`-aware join is inlined here because
  // ui-components is external-only and cannot import a @salt/domain helper (same
  // reason `isCanonIconRenderable` is duplicated). `canonIconParity.test.ts`
  // holds this one to `appendCacheBuster` too — including the `&` join and the
  // `0`-is-a-real-version case.
  const bustedSrc = $derived(
    renderable && thumbnail !== null && version != null && version !== ''
      ? `${thumbnail}${thumbnail.includes('?') ? '&' : '?'}v=${version}`
      : thumbnail,
  );

  // The sage "found its home" tint applies only to a BARE matched tile — a tile
  // that already renders an icon keeps its neutral `bg-icon-tile` backdrop, so
  // matched icons across the app are visually untouched. The first letter fills
  // the otherwise-empty sage square; empty when there is no name.
  //
  // Sage is the "lit up" state the reveal produces, so it is gated with the reveal:
  // under reduced motion the bare matched tile stays grey with no letter — exactly
  // today's appearance — via `motion-reduce:` overrides (the sage colour never
  // animates then either, `transition-colors` being `motion-reduce:transition-none`).
  const sageBare = $derived(matched && !renderable);
  const initial = $derived(name.trim().charAt(0).toUpperCase());

  // ...but a tile that DOES render an icon still lights up for the duration of a
  // reveal. Gating the sage on `!renderable` meant the "it found its home" moment
  // was invisible in its most common form — an item matching an established canon,
  // which by now nearly always has a generated icon — leaving only a sweep over an
  // unchanged tile. `shimmer` is true solely for the reveal window, so this is a
  // transient lift that fades back to `bg-icon-tile` via the tile's
  // `transition-colors` (at `duration-reveal`, the #571 400ms tile crossfade —
  // the pictograms leave their backdrop visible around and through the artwork,
  // so the lift reads behind an icon too); the resting appearance of matched
  // icons across the app is still untouched, which is what the note above is
  // protecting.
  const lit = $derived(sageBare || (matched && shimmer));

  // The tile's backdrop, in one place because four states share it.
  //
  // A tile that RENDERS AN ICON has no backdrop: the pictogram is the object, and
  // the pale grey square behind it (`--salt-icon-tile`, 93% lightness on a 100%
  // white card) only ever diluted it. The tile keeps its box — `size`,
  // `salt-icon-lift`, and the layout slot are unchanged — so nothing about column
  // alignment moves.
  //
  // A BARE tile keeps the grey square. It is a placeholder standing in for art
  // that hasn't generated yet (or that the user hid), and it is what holds the
  // text column straight down a list of part-matched rows; dropping it there
  // would leave the shadow of an empty box and a ragged column.
  //
  // The sage lift is unchanged in both cases (§14.5) — it still reads around and
  // through the artwork. Every arm is a literal string: Tailwind scans source
  // text, so a composed `motion-reduce:${…}` would never be generated. The
  // reduced-motion fallback is each state's own resting backdrop.
  const backdrop = $derived(
    lit
      ? renderable
        ? 'bg-secondary-container motion-reduce:bg-transparent'
        : 'bg-secondary-container motion-reduce:bg-icon-tile'
      : renderable
        ? 'bg-transparent'
        : 'bg-icon-tile',
  );
</script>

<span
  class={cn(
    'salt-icon-lift relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded transition-colors duration-reveal ease-standard motion-reduce:transition-none',
    backdrop,
    dimmed && 'opacity-40',
    className,
  )}
  style="width: {size}px; height: {size}px;"
  data-testid="canon-icon"
>
  {#if renderable}
    <img
      src={bustedSrc}
      alt={name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      class="salt-icon-art h-full w-full object-contain"
      data-testid="canon-icon-img"
    />
  {:else if sageBare && initial}
    <span
      class="pointer-events-none select-none font-semibold leading-none text-accent-foreground motion-reduce:hidden"
      style="font-size: {Math.round(size * 0.5)}px;"
      aria-hidden="true"
      data-testid="canon-icon-initial"
    >
      {initial}
    </span>
  {/if}
  {#if shimmer}
    <span
      class="salt-icon-shimmer pointer-events-none absolute inset-0 motion-reduce:hidden"
      aria-hidden="true"
      data-testid="canon-icon-shimmer"
    ></span>
  {/if}
</span>
