// Journey 4 — meal-plan week + shop day (issue #722).
//
// Cheap: no AI, no triggers, no notifications. What it covers is the pair of
// date-keyed collections the planner is built on, and the invariant that makes
// them work — `shoppingDays/{YYYY-MM-DD}.date` must equal its own doc id,
// because the daily reminder resolves it with a single `get` by that id.
//
// The blast-radius problem here is that both ids ARE dates, so neither can
// carry the `probe-` prefix the teardown guard keys off. The run is scoped by
// the date instead: a far-future week derived from the runId, which no
// household will ever plan and which no live query can reach (the planner
// range-queries the current week; the reminder gets today).

import { MealPlanWeekSchema, ShoppingDaySchema } from '@salt/domain/schemas';

import { readAsUser, writeAsUser } from '../harness/firestore.js';
import type { Journey } from '../harness/journey.js';
import { assert, type ProbeContext } from '../harness/runner.js';

/**
 * Far enough out that it can never collide with a real plan, spread across the
 * year by the runId so two concurrent probe runs do not collide with each
 * other either.
 */
function farFutureWeekStart(ctx: ProbeContext): string {
  let hash = 0;
  for (const char of ctx.runId) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  const start = new Date(Date.UTC(2099, 0, 1));
  start.setUTCDate(start.getUTCDate() + hash);
  return start.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

export const mealplanShopday: Journey = {
  name: 'mealplan-shopday',
  description: 'A planner week and its shop day round-trip and stay schema-valid.',
  domain: 'planner',

  async run(ctx) {
    const weekStart = farFutureWeekStart(ctx);
    const shopDate = addDays(weekStart, 2);
    const now = new Date().toISOString();

    // Date-keyed ids cannot carry the probe- prefix, so the deletion is
    // registered with an explicit reason and shows up in report.adoptedDocs.
    ctx.trackCreated('mealPlans', weekStart, `far-future probe week for run ${ctx.runId}`);
    ctx.trackCreated('shoppingDays', shopDate, `far-future probe shop day for run ${ctx.runId}`);

    // ---- The week ---------------------------------------------------------

    await ctx.step('the probe may write a planner week', async () => {
      const days: Record<string, unknown> = {};
      for (let offset = 0; offset < 7; offset += 1) {
        days[addDays(weekStart, offset)] = {
          note: offset === 0 ? `probe run ${ctx.runId}` : '',
          recipeIds: [],
          chefs: [],
          attendees: [],
          guests: 0,
        };
      }

      const result = await writeAsUser(ctx.env, ctx.identity, `mealPlans/${weekStart}`, {
        id: weekStart,
        schemaVersion: 1,
        startDate: weekStart,
        days,
        updatedAt: now,
      });
      assert(result.errorStatus === null, `week write refused: ${result.errorStatus ?? ''}`);
    });

    await ctx.step('the stored week satisfies the live MealPlanWeek schema', async () => {
      const result = await readAsUser(ctx.env, ctx.identity, `mealPlans/${weekStart}`);
      assert(result.errorStatus === null, `week read refused: ${result.errorStatus ?? ''}`);

      const parsed = MealPlanWeekSchema.safeParse(result.data);
      assert(
        parsed.success,
        `stored week fails MealPlanWeekSchema: ${parsed.success ? '' : parsed.error.message}`,
      );
      if (!parsed.success) return;

      assert(
        parsed.data.startDate === weekStart,
        `startDate ${parsed.data.startDate} does not match the doc id ${weekStart}`,
      );
      assert(
        Object.keys(parsed.data.days).length === 7,
        `expected 7 day entries, got ${Object.keys(parsed.data.days).length}`,
      );
    });

    // ---- The shop day -----------------------------------------------------

    await ctx.step('the probe may mark a shop day', async () => {
      const result = await writeAsUser(ctx.env, ctx.identity, `shoppingDays/${shopDate}`, {
        date: shopDate,
        slot: 'am',
        schemaVersion: 1,
        setBy: ctx.identity.uid,
        setAt: now,
      });
      assert(result.errorStatus === null, `shop day write refused: ${result.errorStatus ?? ''}`);
    });

    await ctx.step('the shop day is schema-valid and self-consistent with its id', async () => {
      const result = await readAsUser(ctx.env, ctx.identity, `shoppingDays/${shopDate}`);
      assert(result.errorStatus === null, `shop day read refused: ${result.errorStatus ?? ''}`);

      const parsed = ShoppingDaySchema.safeParse(result.data);
      assert(
        parsed.success,
        `stored shop day fails ShoppingDaySchema: ${parsed.success ? '' : parsed.error.message}`,
      );
      if (!parsed.success) return;

      // The load-bearing invariant: the reminder resolves the shop day by a
      // single `get` on the date id, so a doc whose `date` disagreed with its
      // own id would be unreachable and silently never nudge.
      assert(
        parsed.data.date === shopDate,
        `date field ${parsed.data.date} does not match the doc id ${shopDate}`,
      );
    });

    await ctx.step('a shop day is rescheduled by either partner, not just its setter', async () => {
      // `setBy` is audit-only and deliberately unpinned in the rules — the whole
      // point is that either partner may move the other's shop.
      const result = await writeAsUser(ctx.env, ctx.identity, `shoppingDays/${shopDate}`, {
        date: shopDate,
        slot: 'pm',
        schemaVersion: 1,
        setBy: 'salt-probe-not-me',
        setAt: new Date().toISOString(),
      });
      assert(result.errorStatus === null, `reschedule refused: ${result.errorStatus ?? ''}`);
    });
  },
};
