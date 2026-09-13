import { describe, it, expect } from 'vitest';
import { KitchenTimersSchema } from '../../src/schemas/index.js';

/**
 * BACK-COMPAT ON READ for `kitchenTimers/{uid}` (issue #1327, Phase 2).
 *
 * `origin` was added to `KitchenTimerSchema` long after timers were in
 * production, and a kitchen-timers document is never migrated: it is written
 * whole by the client and read whole by the delivery trigger, and the only thing
 * that ever rewrites it is the owner starting their next timer. So every timer
 * already in Firestore — and every one started from My Kitchen since — must parse
 * with no `origin` at all and read as `null`.
 *
 * This is the same proof `legacyBatchDocument.test.ts` gives Phase 1's two batch
 * fields, for the same reason: `.default(null)` is a claim about documents nobody
 * is going to rewrite, and a claim like that is worth a test rather than a
 * comment.
 */
describe('a kitchenTimers document written before it knew about origins', () => {
  // Exactly the shape #842 shipped: no `origin` key anywhere.
  const legacy = {
    ownerUid: 'uid-a',
    timers: [
      {
        id: 'timer-1',
        label: 'Eggs',
        endsAt: '2026-08-16T18:10:00.000Z',
        durationMinutes: 10,
        notify: true,
      },
    ],
  };

  it('parses, and reads its timer as one from nowhere in particular', () => {
    const parsed = KitchenTimersSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.timers[0]?.origin).toBeNull();
  });

  it('leaves everything else about the timer exactly as it was written', () => {
    const parsed = KitchenTimersSchema.safeParse(legacy);
    expect(parsed.success && parsed.data.timers[0]).toMatchObject({
      id: 'timer-1',
      label: 'Eggs',
      durationMinutes: 10,
      notify: true,
    });
  });

  // An explicit null is what the client writes for a My Kitchen timer from now
  // on; it must be indistinguishable from the absent key above.
  it('reads an explicit null origin the same way', () => {
    const parsed = KitchenTimersSchema.safeParse({
      ...legacy,
      timers: [{ ...legacy.timers[0], origin: null }],
    });
    expect(parsed.success && parsed.data.timers[0]?.origin).toBeNull();
  });

  // A batch timer's stepId is nullable INSIDE a non-null origin — armed from the
  // batch cook page but on no step — and that is a different fact from `origin:
  // null`. A schema that collapsed the two would lose the deep link.
  it('keeps an ad-hoc batch timer distinguishable from a kitchen one', () => {
    const parsed = KitchenTimersSchema.safeParse({
      ...legacy,
      timers: [{ ...legacy.timers[0], origin: { batchId: 'batch-1', stepId: null } }],
    });
    expect(parsed.success && parsed.data.timers[0]?.origin).toEqual({
      batchId: 'batch-1',
      stepId: null,
    });
  });
});
