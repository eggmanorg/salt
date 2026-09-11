import { fromStore } from 'svelte/store';
import { withStepDone } from '@salt/domain';
import { cookSession, persistCookSession, getCookSessionSnapshot } from './cookSessionService.js';

/**
 * The cook SESSION's half of `createStepDeck`'s progress seam (issue #1327).
 *
 * The deck used to read `completedStepIds` off the session and write through
 * `persistCookSession` itself, which made "a deck" and "a cook session" the same
 * thing. The batch cook page runs the same deck with its ticks on the batch
 * document, so the deck now takes the pair as options — and this is the pair the
 * two RECIPE cook screens pass, verbatim and identically, exactly as they passed
 * every other option to it.
 *
 * It lives here rather than at each call site so plain cook mode and the guided
 * cook cannot drift apart over it, which was the whole point of #994's shared deck.
 *
 * Runes in a factory, following `./stepDeck.svelte.ts`: the `fromStore` bridge
 * declared here belongs to the component that calls it. A `$store`
 * auto-subscription is component syntax and does not exist in a `.svelte.ts`
 * module.
 */
export function createCookSessionStepProgress(): {
  completedStepIds: () => ReadonlySet<string>;
  setStepDone: (id: string, done: boolean) => void;
} {
  const session = fromStore(cookSession);
  const completedStepIds = $derived(new Set(session.current?.completedStepIds ?? []));

  return {
    completedStepIds: () => completedStepIds,
    setStepDone(id: string, done: boolean): void {
      // The SNAPSHOT, not the derived set: the write is a whole document and the
      // producer needs the document, not a projection of it.
      const s = getCookSessionSnapshot();
      if (!s) return;
      const next = withStepDone(s, id, done);
      // Identity means the step was already in that state — skip the write.
      if (next === s) return;
      void persistCookSession(next);
    },
  };
}
