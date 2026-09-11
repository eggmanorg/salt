import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { CookSessionDoc, StepDoc } from '@salt/domain/schemas';
import { withEffectRoot } from './support/effectRoot.svelte.js';

/**
 * `probeVisibleStep`, pinned against synthetic rects.
 *
 * ─── Why this file exists ────────────────────────────────────────────────────
 * The probe is the one thing on the cook screens that is a pure function of GEOMETRY:
 * given where the viewport is and where each step's section is, it names the step the
 * footer acts on and measures the bottom fade. jsdom lays nothing out, so neither page
 * suite can reach it — `CookModePage.test.ts` says so at the top and works around it —
 * and until the wiring was lifted into `$lib/stepDeck` (issue #994) there was nowhere
 * to stand to hand it rects of our own.
 *
 * These cases are the CHARACTERISATION NET for optimising the probe. It runs on every
 * change of `deck.offset` and measures the viewport plus every step element each time;
 * anything that makes it cheaper has to leave every pair below unchanged. So the
 * assertions are outputs — the visible step and the fade height — never how many times
 * a rect was read.
 *
 * ─── The rules being pinned, and where they live ─────────────────────────────
 * The probe line is 8px below the top of the viewport, and the step that owns it is the
 * FIRST one in recipe order whose box spans it — `top <= line < bottom`. The fade is
 * whatever is left below that step's last line, put through `fadeHeightFor` (floor, cap
 * and rounding are ITS rules, tested without a DOM in `cookDeck.test.ts`; what is
 * checked here is that the probe hands it the right number).
 *
 * ─── Nothing here waits ──────────────────────────────────────────────────────
 * Every case sets the geometry, moves the deck and calls `flushSync()`. No settles, no
 * frames, no real clock — the two modules whose coverage once differed between macOS
 * and CI got that way by waiting on host timing instead of driving it (issue #967).
 */

const { mockCookSession } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return { mockCookSession: makeStore<CookSessionDoc | null>(null) };
});

vi.mock('../src/lib/cookSessionService.js', () => ({
  cookSession: mockCookSession,
  persistCookSession: vi.fn(async () => ({ kind: 'ok' as const })),
  getCookSessionSnapshot: () => mockCookSession._get(),
}));

const { createStepDeck } = await import('../src/lib/stepDeck.svelte.js');

// ─── The fixture ───────────────────────────────────────────────────────────────
// Four steps, because three is not enough to tell "the first that matches" from "the
// one nearest the top", and the fourth is the fallback marker below.
const STEPS: StepDoc[] = ['step-1', 'step-2', 'step-3', 'step-4'].map((id) => ({
  id,
  text: id,
  timer: null,
  note: null,
}));

/**
 * Steps 1–3 are already ticked, so `currentStep` falls back to STEP 4 whenever the probe
 * has not spoken. Load-bearing: with an untouched session the fallback would be step 1,
 * and a probe that answered "step 1" would be indistinguishable from a probe that never
 * ran. Every expectation below except the two that assert the fallback names a step the
 * fallback could not have produced.
 */
const SESSION: CookSessionDoc = {
  id: 'recipe-1_user-1',
  schemaVersion: 1,
  ownerUid: 'user-1',
  recipeId: 'recipe-1',
  recipeUpdatedAtAtStart: '2026-08-01T10:00:00.000Z',
  checkedIngredientIds: [],
  checkedPrepIds: [],
  completedStepIds: ['step-1', 'step-2', 'step-3'],
  activeTimers: [],
  serveAt: null,
  servings: null,
  createdAt: '2026-08-01T11:00:00.000Z',
  updatedAt: '2026-08-01T11:00:00.000Z',
};

type Rect = { top: number; bottom: number };

/** The viewport at rest. The probe line is therefore y = 8. */
const VIEWPORT: Rect = { top: 0, bottom: 800 };
const PROBE_LINE = VIEWPORT.top + 8;

/**
 * Where each step sits in the CONTENT column, before the deck's transform — so a rect is
 * `column - offset`, exactly as `translate3d(0, -offset, 0)` puts it on screen. Steps 1,
 * 2 and 4 are shorter than the 800px viewport; step 3 is 900 and taller than it, which is
 * the case that drives the fade to its floor.
 */
const COLUMN: Record<string, Rect> = {
  'step-1': { top: 0, bottom: 700 },
  'step-2': { top: 700, bottom: 1400 },
  'step-3': { top: 1400, bottom: 2300 },
  'step-4': { top: 2300, bottom: 2600 },
};

/** Swapped per case for the overlap tests; reset to `COLUMN` before each. */
let column: Record<string, Rect> = COLUMN;
/** Where the deck currently sits. The stub reads it, so the rects move with the deck. */
let deckOffset = 0;
/**
 * The viewport's box RIGHT NOW. Only the resize case moves it; reset to `VIEWPORT`
 * before each. It is the one source of viewport geometry in this file — the element's
 * `clientHeight` is derived from it in `build`, so a case cannot move the box the probe
 * measures and the height the deck observes out of agreement with each other.
 */
let viewportRect: Rect = VIEWPORT;

/**
 * Every `ResizeObserver` the deck has constructed, as a "tell it something changed"
 * callback. jsdom ships none and `tests/setup.ts`'s stub is deliberately inert (it has
 * nothing to report, since jsdom lays nothing out), so the resize case installs one that
 * records instead — the observation itself still has to be driven by hand, which is
 * exactly the point of that case.
 */
let resizeNotifiers: Array<() => void> = [];

class RecordingResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeNotifiers.push(() => callback([], this as unknown as ResizeObserver));
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function domRect({ top, bottom }: Rect): DOMRect {
  const r = { x: 0, y: top, top, bottom, left: 0, right: 0, width: 0, height: bottom - top };
  return { ...r, toJSON: () => r } as DOMRect;
}

interface Ctx {
  stepDeck: ReturnType<typeof createStepDeck>;
  /** Move the deck to `offset` and let the probe run. The only clock in this file. */
  at: (offset: number) => void;
  /** Destroy a section's anchor, as unmounting it would. */
  unmount: (id: string) => void;
  /** Register a fresh element for a step, as a remount would. */
  remount: (id: string) => void;
  /**
   * Resize the viewport to `next` WITHOUT moving the deck, as a timers bar appearing or
   * a rotation does: swap the box the probe measures, then hand the deck's own
   * `ResizeObserver` the notification a browser would have sent it.
   */
  resize: (next: Rect) => void;
}

function build(): Ctx {
  const anchors = new Map<string, { destroy(): void }>();

  const stepDeck = createStepDeck({
    steps: () => STEPS,
    stage: () => 'steps',
    setStage: () => {},
    setPeeked: () => {},
  });

  const remount = (id: string): void => {
    const el = document.createElement('section');
    el.dataset.stepId = id;
    anchors.set(id, stepDeck.stepAnchor(el, id));
  };
  for (const step of STEPS) remount(step.id);

  // Binding the viewport is what puts the probe in business — before it, it returns
  // without reading anything.
  const viewport = document.createElement('div');
  viewport.dataset.role = 'viewport';
  // The deck measures its viewport with `clientHeight`, which jsdom always answers 0 to.
  // Deriving it from the same rect the probe measures is what lets the resize case move
  // both together.
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => viewportRect.bottom - viewportRect.top,
  });
  stepDeck.deck.viewportEl = viewport;
  stepDeck.deck.contentEl = document.createElement('div');

  return {
    stepDeck,
    at: (offset) => {
      deckOffset = offset;
      stepDeck.deck.place(offset);
      flushSync();
    },
    unmount: (id) => {
      anchors.get(id)?.destroy();
      anchors.delete(id);
    },
    remount,
    resize: (next) => {
      viewportRect = next;
      for (const notify of resizeNotifiers) notify();
      flushSync();
    },
  };
}

/** Build a deck inside an effect root, run the case, tear the root down. */
function withDeck(run: (ctx: Ctx) => void): void {
  withEffectRoot(build, run);
}

beforeEach(() => {
  column = COLUMN;
  deckOffset = 0;
  viewportRect = VIEWPORT;
  resizeNotifiers = [];
  vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
  mockCookSession._set(SESSION);
  // Fake timers so the landing effect's `requestAnimationFrame` — the one thing here
  // that would otherwise move the deck on its own — is inert unless a test asks for it.
  // No test asks.
  vi.useFakeTimers();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const el = this as HTMLElement;
    if (el.dataset?.role === 'viewport') return domRect(viewportRect);
    const id = el.dataset?.stepId;
    const seat = id === undefined ? undefined : column[id];
    if (!seat) return domRect({ top: 0, bottom: 0 });
    return domRect({ top: seat.top - deckOffset, bottom: seat.bottom - deckOffset });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createStepDeck — which step the probe names', () => {
  it('names the step whose section spans the probe line', () => {
    withDeck(({ stepDeck }) => {
      // Nothing moved yet: the deck rests at 0 and step 1 fills the top of the screen.
      expect(stepDeck.currentStep?.id).toBe('step-1');
    });
  });

  it('follows the deck as it moves, step by step', () => {
    withDeck(({ stepDeck, at }) => {
      at(700);
      expect(stepDeck.currentStep?.id).toBe('step-2');
      at(1400);
      expect(stepDeck.currentStep?.id).toBe('step-3');
      at(2300);
      expect(stepDeck.currentStep?.id).toBe('step-4');
    });
  });

  it('re-answers mid-travel, not only where the deck comes to rest', () => {
    // The probe runs on every frame the spring produces, so the footer never lags a
    // gesture. These are offsets no stop exists at.
    withDeck(({ stepDeck, at }) => {
      at(123);
      expect(stepDeck.currentStep?.id).toBe('step-1');
      at(600);
      expect(stepDeck.currentStep?.id).toBe('step-1');
      at(1000);
      expect(stepDeck.currentStep?.id).toBe('step-2');
      at(1500);
      expect(stepDeck.currentStep?.id).toBe('step-3');
      at(2295);
      expect(stepDeck.currentStep?.id).toBe('step-4');
    });
  });

  it('gives the line to the step that STARTS on it, not the one that ends on it', () => {
    withDeck(({ stepDeck, at }) => {
      // One pixel earlier, the outgoing step still owns the line by a single pixel.
      at(700 - PROBE_LINE - 1);
      expect(stepDeck.currentStep?.id).toBe('step-1');
      // Dead on it: step 1's bottom IS the line and step 2's top IS the line. The
      // half-open interval is what stops both — or neither — answering.
      at(700 - PROBE_LINE);
      expect(stepDeck.currentStep?.id).toBe('step-2');
    });
  });

  it('takes the first step in RECIPE order when two sections overlap the line', () => {
    // Not "the topmost", not "the tallest", and not registration order — a collapsed
    // done row and the step below it can both cross the line while a step is peeked.
    column = { ...COLUMN, 'step-3': { top: 0, bottom: 900 } };
    withDeck(({ stepDeck }) => {
      expect(stepDeck.currentStep?.id).toBe('step-1');
    });
  });

  it('skips a section that has been unmounted', () => {
    column = { ...COLUMN, 'step-3': { top: 0, bottom: 900 } };
    withDeck(({ stepDeck, at, unmount }) => {
      expect(stepDeck.currentStep?.id).toBe('step-1');
      unmount('step-1');
      at(1);
      // Step 3 is the only other section across the line now.
      expect(stepDeck.currentStep?.id).toBe('step-3');
    });
  });

  it('picks up a section mounted after it has already probed', () => {
    withDeck(({ stepDeck, at, unmount, remount }) => {
      unmount('step-3');
      at(1400);
      // Nothing spans the line with step 3 gone, so the previous answer stands.
      expect(stepDeck.currentStep?.id).toBe('step-1');
      remount('step-3');
      at(1401);
      expect(stepDeck.currentStep?.id).toBe('step-3');
    });
  });

  it('leaves the last answer standing when nothing spans the line', () => {
    withDeck(({ stepDeck, at }) => {
      at(700);
      expect(stepDeck.currentStep?.id).toBe('step-2');
      expect(stepDeck.fadeHeight).toBe(100);
      // Past the end of the column — every section is above the line.
      at(5000);
      expect(stepDeck.currentStep?.id).toBe('step-2');
      expect(stepDeck.fadeHeight).toBe(100);
    });
  });

  it('says nothing at all before the viewport is bound', () => {
    // `currentStep` is step 4 here — the first INCOMPLETE step, its fallback — which is
    // the answer the footer gets for the frame before the first probe.
    withEffectRoot(
      () =>
        createStepDeck({
          steps: () => STEPS,
          stage: () => 'steps',
          setStage: () => {},
          setPeeked: () => {},
        }),
      (stepDeck) => {
        expect(stepDeck.currentStep?.id).toBe('step-4');
        expect(stepDeck.fadeHeight).toBe(0);
      },
    );
  });
});

describe('createStepDeck — how tall the probe makes the fade', () => {
  it('measures the gap between the current step and the bottom of the viewport', () => {
    withDeck(({ stepDeck }) => {
      // Step 1 ends at 700; the viewport ends at 800.
      expect(stepDeck.fadeHeight).toBe(100);
    });
  });

  it('re-measures even when the step it is measuring has not changed', () => {
    // The half of the probe an optimisation is most likely to lose: the visible step is
    // step 1 at every offset below, and the fade is different at each.
    withDeck(({ stepDeck, at }) => {
      expect(stepDeck.fadeHeight).toBe(100);
      at(100);
      expect(stepDeck.fadeHeight).toBe(200);
      at(300);
      expect(stepDeck.fadeHeight).toBe(224);
      at(50);
      expect(stepDeck.fadeHeight).toBe(150);
    });
  });

  it('caps the fade at the most next-step the deck will ever show', () => {
    withDeck(({ stepDeck, at }) => {
      // Step 1's last line is 9px down the screen: 791px of step 2 below it, and the
      // fade covers 224 of them.
      at(691);
      expect(stepDeck.currentStep?.id).toBe('step-1');
      expect(stepDeck.fadeHeight).toBe(224);
    });
  });

  it('floors the fade under a step taller than the screen', () => {
    withDeck(({ stepDeck, at }) => {
      // Step 3 runs 100px past the bottom edge — a negative gap. The fade is the only
      // cue left that there is more below, so it never goes to nothing.
      at(1400);
      expect(stepDeck.currentStep?.id).toBe('step-3');
      expect(stepDeck.fadeHeight).toBe(64);
    });
  });

  it('rounds a sub-pixel gap rather than truncating it', () => {
    // Mid-spring the offset is fractional on almost every frame, and a fade height is
    // written into a `style` attribute.
    withDeck(({ stepDeck, at }) => {
      at(0.4);
      expect(stepDeck.fadeHeight).toBe(100); // gap 100.4
      at(0.6);
      expect(stepDeck.fadeHeight).toBe(101); // gap 100.6
    });
  });

  it('keeps step and fade in step with each other across a whole travel', () => {
    // One gesture, read as the deck actually produces it: the pair at each offset, not
    // one output at a time.
    withDeck(({ stepDeck, at }) => {
      const seen: [string | undefined, number][] = [];
      for (const offset of [0, 200, 500, 691, 692, 700, 900, 1400]) {
        at(offset);
        seen.push([stepDeck.currentStep?.id, stepDeck.fadeHeight]);
      }
      expect(seen).toEqual([
        ['step-1', 100],
        ['step-1', 224],
        ['step-1', 224],
        ['step-1', 224],
        ['step-2', 92],
        ['step-2', 100],
        ['step-2', 224],
        ['step-3', 64],
      ]);
    });
  });
});

describe('createStepDeck — when the viewport changes under a standing deck', () => {
  /**
   * The dependency the rest of this file cannot see.
   *
   * Every case above moves the DECK, so a probe wired to `deck.offset` alone would
   * satisfy all of them. But the probe measures the viewport too, and the viewport
   * changes on its own: the timers bar appears, the recipe-changed banner drops in, the
   * phone rotates. Nothing has moved by a pixel and yet both answers are stale — the
   * fade is covering a peek that is no longer that size, and the probe line may not even
   * be over the same step any more. That is what the `void deck.viewportHeight` read in
   * the probe's effect is for, and it is invisible to a net driven only by offsets: this
   * case was written by deleting that read and watching nothing go red.
   *
   * It has to drive both halves by hand. jsdom lays nothing out, so `clientHeight` is 0
   * and `tests/setup.ts`'s `ResizeObserver` is inert by necessity — `resize` swaps the
   * synthetic viewport box and fires the observer the deck built, which is the pair of
   * events a browser delivers together. Each move below changes the viewport's HEIGHT,
   * because height is what the deck observes and therefore what it can notice.
   */
  it('re-probes on a resize, with the deck standing still', () => {
    withDeck(({ stepDeck, resize }) => {
      expect(stepDeck.currentStep?.id).toBe('step-1');
      expect(stepDeck.fadeHeight).toBe(100);

      // The timers bar appears: 100px off the bottom, same deck offset. Step 1 now ends
      // exactly on the bottom edge, so there is no peek left and the fade sits on its
      // floor — a step whose answer did not change, and whose fade did.
      resize({ top: 0, bottom: 700 });
      expect(stepDeck.currentStep?.id).toBe('step-1');
      expect(stepDeck.fadeHeight).toBe(64);

      // Now the deck is both taller and further down the screen, which carries the probe
      // line clear of step 1 altogether. Both answers move.
      resize({ top: 700, bottom: 1600 });
      expect(stepDeck.currentStep?.id).toBe('step-2');
      expect(stepDeck.fadeHeight).toBe(200);
    });
  });
});
