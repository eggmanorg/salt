/// <reference path="../../src/lib/types/e2e.d.ts" />
import type { Page } from '@playwright/test';

/**
 * Write out the recipe page's coalesced in-place edits and wait for Firestore to
 * ack them (issue #1304).
 *
 * A settling step through the `window.__e2e` bridge, which is the sanctioned
 * shape (`docs/e2e-test-spec.md` NF-A1) — and emphatically not a sleep in
 * disguise: the promise this awaits is the one the `setDoc` settles.
 *
 * WHY A SPEC CANNOT SETTLE THIS ITSELF. An in-place edit is coalesced behind a
 * 400 ms debounce (issue #1319) and the store is updated OPTIMISTICALLY, so
 * nothing the page renders distinguishes "written" from "about to be written" —
 * the heading shows the new title either way. Under emulators the client runs
 * without `persistentLocalCache` (`src/lib/firebase.ts`), so a write that has
 * not landed is not queued anywhere a reload could replay it; it is simply lost.
 * A `page.reload()` taken straight after Done therefore used to be a coin flip,
 * which is why two specs declined to take one at all.
 *
 * WHY IT IS NOT MERELY THE PLANNER'S HELPER RENAMED. `settlePlannerWrites` in
 * `mealplan-split.spec.ts` covers a spec that never flushed — `page.fill()` does
 * not blur, so the component's own flush never ran and the write is still
 * QUEUED. Here the opposite is true: pressing Done already calls
 * `flushRecipeWrites`, so by the time this helper's own call arrives a CDP hop
 * later there is nothing queued and the write is already on the wire. Waiting
 * for THAT is what `writeCoalescer`'s in-flight set was added for (#1304); a
 * queue-only flush would resolve here having done nothing at all.
 */
export async function settleRecipeWrites(page: Page): Promise<void> {
  await page.evaluate(() => window.__e2e!.flushRecipeWrites());
}
