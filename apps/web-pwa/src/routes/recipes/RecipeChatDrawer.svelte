<!--
  The chef, raised over the recipe rather than instead of it (issue #696).

  NON-MODAL, and that is the whole point: the recipe above stays scrollable, tappable and
  exactly where you left it, so the chef's answer and the ingredients it refers to are
  readable in one glance. So there is deliberately NO `role="dialog"`, no `aria-modal`, no
  focus trap and no scroll lock — this is a `<section aria-label="Chef chat">`. `Sheet` is
  Dialog-based and sets `pointer-events: none` on `<body>`, which would make the recipe
  behind it dead; that is also why `MealDayEditor` needs its portal workaround (#674).

  Two stops: peek (the latest reply and the message box) and full (most of the screen, with
  the page header still showing — a non-modal overlay that covers everything reproduces
  #641). It never covers `BottomNav`, so navigation is reachable throughout.

  Geometry is shared, not re-invented: the resting heights come from `./chatDrawer.ts`, the
  drag resistance and the landing-stop arithmetic from `lib/cookDeck.ts`, and the spring
  from `lib/deckSpring.svelte.ts` — the same physics cook mode settles with, including its
  reduced-motion short-circuit. What is NOT reused is `createDeck` itself: that pages a
  measured column by a transform, and a drawer whose composer must stay at the bottom of
  the visible panel has to move its HEIGHT.
-->
<script lang="ts">
  import type { ChatSessionDoc } from '@salt/domain/schemas';
  import { Button, Icon } from '@salt/ui-components';
  import type { Snippet } from 'svelte';

  import {
    RUBBER_BAND,
    chooseLandingStop,
    nearestStopIndex,
    rubberBand,
  } from '../../lib/cookDeck.js';
  import { createDeckSpring } from '../../lib/deckSpring.svelte.js';
  import { DRAG_START_PX } from '../../lib/swipe.js';
  import ChatThread from '../chat/ChatThread.svelte';
  import type { ChatThreadState } from '../chat/chatThreadState.svelte.js';
  import { deriveDrawerStops, type DrawerStops } from './chatDrawer.js';

  interface Props {
    session: ChatSessionDoc;
    thread: ChatThreadState;
    onClose: () => void;
    /** Hand this conversation to the full chat page. */
    onOpenFull: () => void;
    /**
     * The recipe's own chat actions — "Update recipe" and "Save as new recipe" —
     * rendered in the header beside expand and close. They belong to the host because
     * they act on the DISH, not on the conversation; they sit up here, behind one
     * glyph, because a bar under the transcript costs a phone-height drawer more than
     * the actions are worth (#878) and a menu costs the header nothing (#1310).
     *
     * The host passes the whole control, trigger included, because the trigger's
     * testid has to differ per surface: the recipe page's docked column and this
     * drawer can both be mounted at once.
     */
    headerActions?: Snippet | undefined;
    /** Openers for an empty conversation — forwarded straight to `ChatThread`. */
    starters?: { label: string; text: string }[] | undefined;
  }
  let { session, thread, onClose, onOpenFull, headerActions, starters }: Props = $props();

  // `DRAG_START_PX` — the slop before a touch counts as a drag rather than a tap
  // on the handle — is imported from `lib/swipe.js` (issue #933). It is the one
  // number here that is NOT drawer-specific: it is about the human hand, not
  // about how far this surface travels.
  //
  // Cook mode's thresholds are stated relative to a SCREEN-sized section; the drawer's
  // travel is roughly half a screen, so a slow drag would have to cross most of it to
  // commit. These are the same numbers scaled to that travel — a fifth of it commits,
  // and a gentler flick than a page-turn is enough to throw it to the other stop.
  const COMMIT_RATIO = 0.2;
  const FLING_PX_PER_MS = 0.35;

  let panelEl = $state<HTMLElement | undefined>(undefined);
  // Re-measured whenever the viewport changes: the bottom edge moves with the safe-area
  // inset and the height of the screen changes on rotation.
  let stops = $state<DrawerStops>({ peek: 0, full: 0 });
  const height = createDeckSpring(0);

  function measure(): DrawerStops {
    const el = panelEl;
    if (!el || typeof window === 'undefined') return { peek: 0, full: 0 };
    return deriveDrawerStops(el.getBoundingClientRect().bottom, window.innerHeight);
  }

  // It RISES: mounted at nothing and sprung up to the peek, so opening a chat reads as the
  // chef coming to you rather than the page suddenly being half a chat.
  $effect(() => {
    if (!panelEl) return;
    // Held in a local and only then published: reading `stops` back here would make this
    // effect depend on state it has just written.
    const measured = measure();
    stops = measured;
    height.place(0);
    height.animateTo(measured.peek);
  });

  $effect(() => {
    if (typeof window === 'undefined') return;
    const onResize = (): void => {
      stops = measure();
      // Stay at whichever stop you were nearest; the numbers behind it have changed.
      height.place(atFull() ? stops.full : stops.peek);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  /** The travel between the two stops. 0 on a viewport too short to have two. */
  const limit = $derived(Math.max(0, stops.full - stops.peek));

  function atFull(): boolean {
    return nearestStopIndex(height.current - stops.peek, [0, limit]) === 1;
  }

  function goTo(index: number, velocity = 0): void {
    height.animateTo(stops.peek + (index === 1 ? limit : 0), velocity);
  }

  // ─── The gesture ────────────────────────────────────────────────────────────────────
  let dragging = false;
  let dragPointer: number | null = null;
  let dragStartY = 0;
  let dragStartOffset = 0;
  let dragStartIndex = 0;
  let lastMoveY = 0;
  let lastMoveTime = 0;
  let dragVelocity = 0; // px/ms, positive = drawer growing
  // A released drag ends in a click on the handle; without this, every drag would also
  // toggle the stop it just landed on.
  let draggedThisGesture = false;

  function handlePointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // Captured HERE, not once the drag is recognised. The handle is a 40px grab bar and
    // a drag leaves it within the first few pixels; without capture from the outset the
    // moves retarget to the recipe behind, the gesture is never seen, and the drawer
    // simply does not move. (Touch pointers get implicit capture and would have hidden
    // this; a trackpad drag would not.) A capture does not stop the click that follows,
    // so tap-to-toggle is unaffected.
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    height.stop();
    stops = measure();
    dragPointer = event.pointerId;
    dragging = false;
    draggedThisGesture = false;
    dragStartY = event.clientY;
    dragStartOffset = height.current - stops.peek;
    dragStartIndex = nearestStopIndex(dragStartOffset, [0, limit]);
    lastMoveY = event.clientY;
    lastMoveTime = event.timeStamp;
    dragVelocity = 0;
  }

  function handlePointerMove(event: PointerEvent): void {
    if (dragPointer !== event.pointerId) return;
    const travelled = dragStartY - event.clientY;
    if (!dragging) {
      if (Math.abs(travelled) < DRAG_START_PX) return;
      dragging = true;
      draggedThisGesture = true;
    }
    height.place(stops.peek + rubberBand(dragStartOffset + travelled, limit, RUBBER_BAND));
    const elapsed = event.timeStamp - lastMoveTime;
    if (elapsed > 0) {
      // Smoothed, so one erratic sample at the moment of release can't fling the drawer.
      dragVelocity = dragVelocity * 0.7 + ((lastMoveY - event.clientY) / elapsed) * 0.3;
      lastMoveY = event.clientY;
      lastMoveTime = event.timeStamp;
    }
  }

  function handlePointerUp(event: PointerEvent): void {
    if (dragPointer !== event.pointerId) return;
    dragPointer = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    if (!dragging) return; // a tap — the click handler toggles
    dragging = false;
    const offset = height.current - stops.peek;
    const index = chooseLandingStop({
      stops: [0, limit],
      startIndex: dragStartIndex,
      offset,
      dragged: offset - dragStartOffset,
      velocity: dragVelocity,
      screen: limit || 1,
      commitRatio: COMMIT_RATIO,
      flingPxPerMs: FLING_PX_PER_MS,
    });
    goTo(index, dragVelocity * 1000); // px/ms → px/s
  }

  function handleToggle(): void {
    if (draggedThisGesture) {
      draggedThisGesture = false;
      return;
    }
    goTo(atFull() ? 0 : 1);
  }

  function handleHandleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    goTo(event.key === 'ArrowUp' ? 1 : 0);
  }

  // Escape closes, as it would anywhere else — but only from inside the drawer. There is no
  // focus trap, so a document-level listener would steal the key from the live page behind.
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onClose();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  bind:this={panelEl}
  aria-label="Chef chat"
  data-testid="recipe-chat-drawer"
  onkeydown={handleKeydown}
  class="fixed inset-x-0 bottom-[calc(var(--salt-layout-bottom-nav-height)_+_env(safe-area-inset-bottom))] z-20 flex flex-col overflow-hidden rounded-t-lg border border-b-0 border-border bg-card shadow-lg lg:bottom-0"
  style="height: {Math.round(height.current)}px"
>
  <div class="shrink-0 border-b border-border">
    <button
      type="button"
      class="flex w-full touch-none items-center justify-center py-2"
      aria-label={atFull() ? 'Shrink chat' : 'Expand chat'}
      data-testid="recipe-chat-drawer-handle"
      onpointerdown={handlePointerDown}
      onpointermove={handlePointerMove}
      onpointerup={handlePointerUp}
      onpointercancel={handlePointerUp}
      onclick={handleToggle}
      onkeydown={handleHandleKeydown}
    >
      <span class="h-1.5 w-10 rounded-full bg-muted-foreground/40"></span>
    </button>
    <div class="flex items-center justify-between gap-2 px-3 pb-2">
      <p class="min-w-0 truncate text-sm font-medium">{session.title}</p>
      <!-- Title, the chat actions, expand, close (issue #1310). -->
      <div class="flex shrink-0 items-center gap-1">
        {@render headerActions?.()}
        <Button
          size="sm"
          variant="ghost"
          onclick={onOpenFull}
          ariaLabel="Open full chat"
          data-testid="recipe-chat-drawer-expand"
        >
          <Icon name="ExternalLink" size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onclick={onClose}
          ariaLabel="Close chat"
          data-testid="recipe-chat-drawer-close"
        >
          <Icon name="X" size={16} />
        </Button>
      </div>
    </div>
  </div>

  <ChatThread
    {session}
    {thread}
    layout="panel"
    emptyText="Ask me anything about this recipe."
    {starters}
  />
</section>
