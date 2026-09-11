import type { CookSessionDoc } from '../schemas/index.js';

// The arguments a fresh cook session needs. `nowIso` is INJECTED rather than read
// from the clock (CLAUDE.md Rule 1 — domain is pure): the caller stamps the same
// instant on both `createdAt` and `updatedAt`.
export interface MakeFreshSessionArgs {
  /** Deterministic session id — composed by `cookSessionId`. */
  readonly id: string;
  readonly ownerUid: string;
  readonly recipeId: string;
  /** The live recipe's `updatedAt` at the moment cooking started (the drift baseline). */
  readonly recipeUpdatedAtAtStart: string;
  /** ISO timestamp for `createdAt`/`updatedAt`. Injected, never read from the clock here. */
  readonly nowIso: string;
}

// A brand-new session with nothing ticked (neither list — see `checkedPrepIds`),
// nothing done, and no timers running.
// `recipeUpdatedAtAtStart` is the snapshot `hasRecipeChanged` later compares the
// live recipe against.
export function makeFreshSession(args: MakeFreshSessionArgs): CookSessionDoc {
  return {
    id: args.id,
    schemaVersion: 1,
    ownerUid: args.ownerUid,
    recipeId: args.recipeId,
    recipeUpdatedAtAtStart: args.recipeUpdatedAtAtStart,
    checkedIngredientIds: [],
    checkedPrepIds: [],
    completedStepIds: [],
    activeTimers: [],
    // No serve time until someone sets one (issue #752). A fresh session never
    // carries one, including the meal's own — the cook plan writes it on the first
    // set, which is also what creates the session.
    serveAt: null,
    // As written (issue #1314). A cook that was OPENED at another number pins it
    // immediately afterwards, from the URL it arrived on — this constructor knows
    // nothing about the route and must not guess.
    servings: null,
    createdAt: args.nowIso,
    updatedAt: args.nowIso,
  };
}
