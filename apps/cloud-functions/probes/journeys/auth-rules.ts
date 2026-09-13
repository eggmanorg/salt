// Journey 1 — auth + rules (issue #722).
//
// The probe user signs in for real, reads what it may, and is denied what it
// may not. Nothing here spends an AI token and nothing here touches a
// collection with a Firestore trigger, so it is the cheap canary: if this fails,
// no other journey's result means anything.
//
// Two tricks keep it free of side effects:
//
//   * Permission is asserted against *non-existent* documents. Firestore answers
//     PERMISSION_DENIED before it answers NOT_FOUND, so a 404 proves the read
//     was allowed and a 403 proves it was refused — without writing anything.
//   * The one collection it does write is `chatSessions`, which is owner-scoped
//     (so it exercises the per-user rules) and carries no trigger.

import { ChatSessionSchema } from '@salt/domain/schemas';

import { callCallable } from '../harness/callable.js';
import { deleteAsUser, readAsUser, writeAsUser } from '../harness/firestore.js';
import type { Journey } from '../harness/journey.js';
import { assert, type ProbeContext } from '../harness/runner.js';

/** A uid that is definitively not the probe's, for owner-scoping assertions. */
const FOREIGN_UID = 'salt-probe-not-me';

async function assertReadAllowed(ctx: ProbeContext, path: string): Promise<void> {
  const result = await readAsUser(ctx.env, ctx.identity, path);
  assert(
    result.errorStatus === 'NOT_FOUND',
    `expected an allowed read of an absent ${path} (NOT_FOUND), got ${result.errorStatus ?? 'OK'}`,
  );
}

async function assertReadDenied(ctx: ProbeContext, path: string): Promise<void> {
  const result = await readAsUser(ctx.env, ctx.identity, path);
  assert(
    result.errorStatus === 'PERMISSION_DENIED',
    `expected ${path} to be denied, got ${result.errorStatus ?? 'OK'}`,
  );
}

async function assertWriteDenied(
  ctx: ProbeContext,
  path: string,
  doc: Record<string, unknown>,
): Promise<void> {
  const result = await writeAsUser(ctx.env, ctx.identity, path, doc);
  assert(
    result.errorStatus === 'PERMISSION_DENIED',
    `expected a write to ${path} to be denied, got ${result.errorStatus ?? 'OK'}`,
  );
}

export const authRules: Journey = {
  name: 'auth-rules',
  description: 'Probe user signs in, reads what it may, is denied what it may not.',
  domain: 'auth',

  async run(ctx) {
    const absent = ctx.id('absent');

    // ---- Callable attestation -------------------------------------------
    // #718 Phase 2a made every callable reject an unattested request. These
    // two assertions are what stop the harness silently degrading if the
    // App Check minting path ever breaks: a probe that lost attestation would
    // otherwise just look like a broken function.

    await ctx.step('an unattested callable request is refused', async () => {
      const response = await callCallable(
        ctx.env,
        ctx.identity,
        'embedText',
        {},
        {
          withoutAppCheck: true,
        },
      );
      assert(
        response.errorStatus === 'UNAUTHENTICATED',
        `expected UNAUTHENTICATED without App Check, got HTTP ${response.httpStatus} ${response.errorStatus ?? 'OK'}`,
      );
    });

    await ctx.step('an unauthenticated callable request is refused', async () => {
      // Attested but signed out: App Check passes, so the refusal comes from
      // the callable's own `isSignedIn()` policy — PERMISSION_DENIED, not
      // UNAUTHENTICATED. The two statuses are how a probe tells the App Check
      // gate and the auth gate apart.
      const response = await callCallable(
        ctx.env,
        ctx.identity,
        'embedText',
        {},
        {
          withoutAuth: true,
        },
      );
      assert(
        response.errorStatus === 'PERMISSION_DENIED',
        `expected PERMISSION_DENIED without an ID token, got HTTP ${response.httpStatus} ${response.errorStatus ?? 'OK'}`,
      );
    });

    await ctx.step('a fully attested callable request reaches the handler', async () => {
      // `listAiModels` is admin-gated and spends nothing. The probe is
      // deliberately not an admin, so PERMISSION_DENIED is the *success* case:
      // the request cleared App Check and auth and ran the handler's own gate.
      const response = await callCallable(ctx.env, ctx.identity, 'listAiModels', {});
      assert(
        response.errorStatus !== 'UNAUTHENTICATED',
        `attested call was still rejected as UNAUTHENTICATED (HTTP ${response.httpStatus})`,
      );
      assert(
        response.errorStatus === 'PERMISSION_DENIED',
        `expected the admin gate to refuse a non-admin probe, got HTTP ${response.httpStatus} ${response.errorStatus ?? 'OK'} ${response.errorMessage ?? ''}`,
      );
    });

    // ---- Reads the probe user may make -----------------------------------

    await ctx.step('family-shared collections are readable', async () => {
      for (const collection of ['recipes', 'canonItems', 'productForms', 'mealPlans', 'members']) {
        await assertReadAllowed(ctx, `${collection}/${absent}`);
      }
    });

    // ---- Reads it may not ------------------------------------------------

    await ctx.step('server-only collections are closed to the client', async () => {
      for (const collection of ['canonEmbeddings', 'timerDeliveries', 'emailOtps']) {
        await assertReadDenied(ctx, `${collection}/${absent}`);
      }
    });

    await ctx.step('an unmatched collection falls through to the catch-all deny', async () => {
      await assertReadDenied(ctx, `probeNoSuchCollection/${absent}`);
    });

    // ---- Writes it may not -----------------------------------------------

    await ctx.step('admin-only writes are refused for a non-admin', async () => {
      await assertWriteDenied(ctx, `members/${absent}`, { admin: true });
      await assertWriteDenied(ctx, `devSettings/${absent}`, { probe: true });
    });

    await ctx.step('the CF-owned weather cache is closed to every client', async () => {
      await assertWriteDenied(ctx, `weatherForecast/${absent}`, { probe: true });
    });

    // ---- Owner-scoped round trip ------------------------------------------

    const sessionId = ctx.id('chat');
    const sessionPath = `chatSessions/${sessionId}`;
    const now = new Date().toISOString();
    // A Date, not an ISO string: both the REST harness and the Admin SDK store
    // it as a Firestore `Timestamp`, so probe leftovers are swept by the TTL
    // policy instead of being the one class of doc it skips (#1008).
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    ctx.track('chatSessions', sessionId);

    await ctx.step('a session claiming another owner is refused on create', async () => {
      await assertWriteDenied(ctx, sessionPath, {
        id: sessionId,
        schemaVersion: 1,
        ownerUid: FOREIGN_UID,
        recipeId: null,
        title: 'probe',
        messages: [],
        createdAt: now,
        updatedAt: now,
        expiresAt,
      });
    });

    await ctx.step('the probe may create its own session', async () => {
      const result = await writeAsUser(ctx.env, ctx.identity, sessionPath, {
        id: sessionId,
        schemaVersion: 1,
        ownerUid: ctx.identity.uid,
        recipeId: null,
        title: `probe ${ctx.runId}`,
        messages: [],
        createdAt: now,
        updatedAt: now,
        expiresAt,
      });
      assert(result.errorStatus === null, `create refused: ${result.errorStatus ?? ''}`);
    });

    await ctx.step('the stored session satisfies the live ChatSession schema', async () => {
      const result = await readAsUser(ctx.env, ctx.identity, sessionPath);
      assert(result.errorStatus === null, `read refused: ${result.errorStatus ?? ''}`);

      // Validated against the *same* schema the app reads with, so a schema
      // change lands here rather than drifting silently.
      const parsed = ChatSessionSchema.safeParse(result.data);
      assert(
        parsed.success,
        `round-tripped session fails ChatSessionSchema: ${
          parsed.success ? '' : parsed.error.message
        }`,
      );
    });

    await ctx.step("another user's session is invisible to the probe", async () => {
      const foreignId = ctx.id('foreign-chat');
      ctx.track('chatSessions', foreignId);

      // Seeded with the Admin SDK precisely because rules would refuse it.
      await ctx.admin.firestore
        .collection('chatSessions')
        .doc(foreignId)
        .set({
          id: foreignId,
          schemaVersion: 1,
          ownerUid: FOREIGN_UID,
          recipeId: null,
          title: `probe ${ctx.runId} foreign`,
          messages: [],
          createdAt: now,
          updatedAt: now,
          expiresAt,
        });

      await assertReadDenied(ctx, `chatSessions/${foreignId}`);
    });

    await ctx.step('the probe may delete its own session', async () => {
      const result = await deleteAsUser(ctx.env, ctx.identity, sessionPath);
      assert(result.errorStatus === null, `delete refused: ${result.errorStatus ?? ''}`);
    });
  },
};
