// Journey 3 — canon match/create + `onCanonItemWritten` (issue #722).
//
// OPT-IN: creating a canon item makes the trigger generate a pictogram with a
// real image model. That is the one thing issue #722 says to keep out of the
// default sweep, so `all` skips this journey unless --include-opt-in is given.
// Naming it explicitly always runs it.
//
// It covers both halves of the trigger — the icon branch and the embedding
// branch (which writes the companion `canonEmbeddings/{id}` doc, deliberately a
// separate collection so it cannot re-fire the trigger) — plus the
// `matchOrCreateCanon` callable on its match path.

import { CanonItemSchema } from '@salt/domain/schemas';

import { callCallable } from '../harness/callable.js';
import { writeAsUser } from '../harness/firestore.js';
import type { Journey } from '../harness/journey.js';
import { assert } from '../harness/runner.js';

import { deriveCanonSeeds } from './deriveCanonSeeds.js';

/** Image generation is the slowest thing in the app. */
const ICON_TIMEOUT_MS = 240_000;
const EMBEDDING_TIMEOUT_MS = 120_000;

/** Where `onCanonItemWritten` uploads the pictogram it generates. */
const ICON_STORAGE_PREFIX = 'canon-icons';

export const canonIcon: Journey = {
  name: 'canon-icon',
  description: 'matchOrCreateCanon matches, and a new canon item gets an icon + embedding.',
  domain: 'canon',
  optIn: 'generates a pictogram with a real image model (real cost)',

  async run(ctx) {
    // ---- matchOrCreateCanon, match path -----------------------------------

    const [existing] = await ctx.step('derive a canon name to match against', () =>
      deriveCanonSeeds(ctx, 1),
    );
    assert(existing !== undefined, 'no canon seed derived');

    await ctx.step('matchOrCreateCanon resolves an existing name without creating', async () => {
      const response = await callCallable(ctx.env, ctx.identity, 'matchOrCreateCanon', {
        rawName: existing.name,
      });

      assert(
        response.errorStatus === null,
        `callable failed: HTTP ${response.httpStatus} ${response.errorStatus ?? ''} ${response.errorMessage ?? ''}`,
      );

      const record = response.result as { kind?: unknown; value?: unknown };
      assert(record.kind === 'ok', `expected an ok result, got ${String(record.kind)}`);

      const value = record.value as { decision?: unknown; item?: unknown };
      assert(
        value.decision === 'created' ||
          value.decision === 'matched' ||
          value.decision === 'ai_arbitrated',
        `unknown decision ${String(value.decision)}`,
      );

      const parsed = CanonItemSchema.safeParse(value.item);
      assert(
        parsed.success,
        `returned item fails the live CanonItemSchema: ${parsed.success ? '' : parsed.error.message}`,
      );

      if (value.decision === 'created' && parsed.success) {
        ctx.warn(
          `matchOrCreateCanon CREATED ${parsed.data.id} for the existing name "${existing.name}"`,
        );
        ctx.trackCreated(
          'canonItems',
          parsed.data.id,
          'created by matchOrCreateCanon during this run',
        );
      }
    });

    // ---- The trigger: icon + embedding ------------------------------------

    const canonId = ctx.id('canon');
    const now = new Date().toISOString();

    ctx.track('canonItems', canonId);
    // Server-only collection: the probe cannot read or delete it as a user, so
    // teardown goes through admin. Still probe-prefixed, so the guard applies.
    ctx.track('canonEmbeddings', canonId);
    ctx.trackStorageObject(`${ICON_STORAGE_PREFIX}/${canonId}.webp`);

    await ctx.step('creating a canon item with no thumbnail arms the icon trigger', async () => {
      const result = await writeAsUser(ctx.env, ctx.identity, `canonItems/${canonId}`, {
        id: canonId,
        schemaVersion: 5,
        // A real, ordinary ingredient word: the pictogram prompt is built from
        // the name, and only the *structure* of the result is asserted.
        name: 'probe carrot',
        synonyms: [],
        aisleId: null,
        // null is what arms the trigger — a non-null thumbnail short-circuits it.
        thumbnail: null,
        needs_approval: false,
        shoppingBehavior: 'needed',
        updatedAt: now,
      });
      assert(result.errorStatus === null, `canon create refused: ${result.errorStatus ?? ''}`);
    });

    const thumbnail = await ctx.settle(
      'onCanonItemWritten generates and stores an icon',
      async () => {
        const snapshot = await ctx.admin.firestore.collection('canonItems').doc(canonId).get();
        const value = snapshot.get('thumbnail') as unknown;
        return typeof value === 'string' && value !== '' ? value : null;
      },
      { timeoutMs: ICON_TIMEOUT_MS },
    );

    await ctx.step('the stored canon item is still schema-valid after the trigger', async () => {
      assert(
        thumbnail.startsWith('http'),
        `expected a URL thumbnail, got "${thumbnail.slice(0, 60)}"`,
      );

      const snapshot = await ctx.admin.firestore.collection('canonItems').doc(canonId).get();
      const parsed = CanonItemSchema.safeParse(snapshot.data());
      assert(
        parsed.success,
        `trigger left a canon item the live schema rejects: ${parsed.success ? '' : parsed.error.message}`,
      );
    });

    await ctx.settle(
      'the embedding lands in the companion canonEmbeddings collection',
      async () => {
        const snapshot = await ctx.admin.firestore.collection('canonEmbeddings').doc(canonId).get();
        if (!snapshot.exists) return null;
        const embedding = snapshot.get('embedding') as unknown;
        if (!Array.isArray(embedding) || embedding.length === 0) return null;
        assert(
          embedding.every((value) => typeof value === 'number' && Number.isFinite(value)),
          'embedding contains a non-finite value',
        );
        return embedding.length;
      },
      { timeoutMs: EMBEDDING_TIMEOUT_MS },
    );
  },
};
