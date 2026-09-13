// Journey 6 — chef chat (issue #722).
//
// The strictest application of "never assert on AI prose". Everything hard here
// is structural: the callable answered at all, it answered with a non-empty
// string, the title is short enough to be a title, and the persisted session
// still satisfies `ChatSessionSchema`. Whether the answer is any *good* is a
// semantic judgement, so it is recorded with `warn()` and can never fail a run
// — an AI that phrases things differently one morning is not a regression.
//
// chefChat is a streaming flow. Invoked over the plain callable protocol (no
// `&stream=true`) it resolves to the complete string, which is exactly what a
// contract-level probe wants.

import { ChatSessionSchema } from '@salt/domain/schemas';

import { callCallable } from '../harness/callable.js';
import { readAsUser, writeAsUser } from '../harness/firestore.js';
import type { Journey } from '../harness/journey.js';
import { assert } from '../harness/runner.js';

/** A question with an unambiguous, stable, checkable subject. */
const QUESTION = 'How many grams are in one kilogram?';

/** Titles are specified as 2–5 words; allow slack before even warning. */
const TITLE_WORD_CEILING = 8;

export const chefChat: Journey = {
  name: 'chef-chat',
  description: 'The chef answers, a title is generated, and the session persists owner-scoped.',
  domain: 'chat',

  async run(ctx) {
    const answer = await ctx.step('chefChat returns a non-empty answer', async () => {
      const response = await callCallable(ctx.env, ctx.identity, 'chefChat', {
        messages: [],
        newMessage: QUESTION,
        recipeId: null,
      });

      assert(
        response.errorStatus === null,
        `chefChat failed: HTTP ${response.httpStatus} ${response.errorStatus ?? ''} ${response.errorMessage ?? ''}`,
      );
      assert(
        typeof response.result === 'string' && response.result.trim() !== '',
        'chefChat returned something other than a non-empty string',
      );
      return response.result as string;
    });

    // Semantic judgement — soft, always. "1000" is about as stable as a cooking
    // assistant's output gets, and even so a miss is a warning, not a failure.
    if (!/1[ ,.]?000/.test(answer)) {
      ctx.warn(
        `chefChat's answer to "${QUESTION}" did not contain 1000 — worth an eyeball: ${answer.slice(0, 120)}`,
      );
    }

    const title = await ctx.step('generateChatTitle returns a usable title', async () => {
      const response = await callCallable(ctx.env, ctx.identity, 'generateChatTitle', {
        userMessage: QUESTION,
        assistantResponse: answer,
      });

      assert(
        response.errorStatus === null,
        `generateChatTitle failed: HTTP ${response.httpStatus} ${response.errorStatus ?? ''} ${response.errorMessage ?? ''}`,
      );
      assert(
        typeof response.result === 'string' && response.result.trim() !== '',
        'generateChatTitle returned something other than a non-empty string',
      );
      return (response.result as string).trim();
    });

    const wordCount = title.split(/\s+/).length;
    if (wordCount > TITLE_WORD_CEILING) {
      ctx.warn(`generateChatTitle returned ${wordCount} words, not a 2-5 word title: "${title}"`);
    }

    // ---- Persistence, owner-scoped ---------------------------------------

    const sessionId = ctx.id('chat');
    const now = new Date().toISOString();
    ctx.track('chatSessions', sessionId);

    await ctx.step('the exchange persists as an owner-scoped session', async () => {
      const result = await writeAsUser(ctx.env, ctx.identity, `chatSessions/${sessionId}`, {
        id: sessionId,
        schemaVersion: 1,
        ownerUid: ctx.identity.uid,
        recipeId: null,
        title,
        messages: [
          { id: `${sessionId}-1`, role: 'user', text: QUESTION, createdAt: now },
          { id: `${sessionId}-2`, role: 'assistant', text: answer, createdAt: now },
        ],
        createdAt: now,
        updatedAt: now,
        // A Date, not an ISO string: the harness encodes it as a Firestore
        // `timestampValue`, the one shape the TTL policy sweeps (#1008) — a
        // string here would make probe leftovers the docs the policy never
        // touches. Reads decode it back to a string, so the schema round-trip
        // below still holds.
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      assert(result.errorStatus === null, `session write refused: ${result.errorStatus ?? ''}`);
    });

    await ctx.step('the persisted session round-trips through the live schema', async () => {
      const result = await readAsUser(ctx.env, ctx.identity, `chatSessions/${sessionId}`);
      assert(result.errorStatus === null, `session read refused: ${result.errorStatus ?? ''}`);

      const parsed = ChatSessionSchema.safeParse(result.data);
      assert(
        parsed.success,
        `persisted session fails ChatSessionSchema: ${parsed.success ? '' : parsed.error.message}`,
      );
      if (!parsed.success) return;

      assert(parsed.data.messages.length === 2, 'expected the two-turn exchange to round-trip');
      assert(
        parsed.data.messages[1]?.text === answer,
        "the assistant's turn did not survive the round trip intact",
      );
    });
  },
};
