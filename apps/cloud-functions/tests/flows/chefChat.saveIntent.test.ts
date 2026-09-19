/**
 * Asking the chef to save a recipe (issue #1480) — the server half.
 *
 * Five claims this phase makes, each a real defect if it is wrong:
 *
 *  1. RECOGNITION NEVER WRITES. `saveRecipe`'s handler has no Firestore in it at
 *     all — not a read, not a write — so a model that mishears an ordinary
 *     sentence cannot change anything by itself. Pinned by calling the handler
 *     with `getFirestore` rigged to throw: a handler that grows a body reaching
 *     for the database turns this red before the review does. The save stays in
 *     the browser, in the one create implementation (`chatRecipeAuthor.ts`),
 *     which `cloud-functions` could not reach even if it wanted to (Rule 2).
 *  2. IT IS GATED SERVER-SIDE, PER CALLER. A caller outside the `chat-save` flag
 *     gets a `tools:` array without it and a system prompt with no save section —
 *     so their chef cannot offer, recognise or record the ask, and their prompt
 *     is what it was before this shipped.
 *  3. A RECOGNISED ASK REACHES THE DOCUMENT, and names the turn it came from:
 *     `pendingSaveIntent` is the id of the assistant message written for that
 *     turn. This is the whole channel — the wire contract does not move, so
 *     #1303's deploy-skew corruption cannot recur.
 *  4. AN ORDINARY TURN RECORDS NOTHING, and clears anything left over. The field
 *     is rewritten on every turn, so a request nobody acted on cannot sit on the
 *     document re-firing on every reload.
 *  5. THE READ OF GENKIT'S MESSAGE HISTORY IS THE SHAPE GENKIT PRODUCES, and a
 *     response that carries none of it answers "nobody asked" rather than
 *     throwing.
 *
 * THE BOUNDARY on claim 5 (CLAUDE.md Rule 12): the fixtures below are written
 * from `@genkit-ai/ai@1.42.0`'s own source, not captured from a live model. They
 * pin OUR parsing against that shape; they cannot notice Genkit changing it. If
 * it does, the failure is a missed prompt — the person taps the icon that is
 * still right there — and never a wrong write, because of claim 1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import type { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { CHAT_SAVE_FLAG_KEY, LIBRARY_FLAG_KEY } from '@salt/observability/server';
import type { ChatSessionDoc } from '@salt/domain/schemas';

vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
vi.spyOn(logger, 'error').mockImplementation(() => undefined);

const mockGenerateStream = vi.fn();
vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    defineTool: (config: { name: string }, handler: unknown) => ({
      __tool: config.name,
      handler,
    }),
    generateStream: mockGenerateStream,
  },
}));
vi.mock('../../src/ai/fakeModel.js', () => ({ flowModel: vi.fn(async () => 'fake-model') }));
vi.mock('../../src/adapters/withAiTimeout.js', () => ({
  AI_TEXT_FLOW_TIMEOUT: { timeoutMs: 55_000, retries: 0 },
  withAiTimeout: (_flow: string, fn: () => Promise<unknown>) => fn(),
  withAiStreamTimeout: (_flow: string, stream: AsyncIterable<unknown>) => stream,
}));
// The real `reportServerError` is left in place, and `logger` is spied rather
// than mocked, to stay inside the unit-test spec's mock ceiling (UT-B1). Neither
// is reached: every case here takes a path that completes.
const mockGetFirestore = vi.fn();
vi.mock('firebase-admin/firestore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFirestore: () => mockGetFirestore(),
}));
const { mockFlagEnabled } = vi.hoisted(() => ({
  mockFlagEnabled: vi.fn(async (_key: string) => true),
}));
vi.mock('@salt/observability/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isServerFeatureEnabled: mockFlagEnabled,
}));

const { chefChatFlow, saveRecipeTool, turnRequestedRecipeSave, SAVE_RECIPE_TOOL_NAME } =
  await import('../../src/flows/chefChat.js');

const SIGNED_IN = { auth: { uid: 'u-1', token: { email: 'daniel@example.com' } } };

function storedSession(overrides: Partial<ChatSessionDoc> = {}): Record<string, unknown> {
  const doc: ChatSessionDoc = {
    id: 'sess-1',
    schemaVersion: 1,
    ownerUid: 'u-1',
    recipeId: null,
    basedOnRecipeId: null,
    title: 'New chat',
    messages: [],
    createdAt: '2026-09-18T08:00:00.000Z',
    updatedAt: '2026-09-18T08:00:00.000Z',
    reopenedAt: null,
    pendingSaveIntent: null,
    expiresAt: '2026-10-02T08:00:00.000Z',
    ...overrides,
  };
  // As it is on the wire since #1008: a `Timestamp`, not the ISO string.
  return { ...doc, expiresAt: Timestamp.fromDate(new Date(doc.expiresAt)) };
}

/**
 * A Firestore that holds the one chat session and refuses every other
 * collection. The prompt's context readers (equipment, favourites, notes, the
 * recipe) each degrade to '' on a failure by design, so refusing them here is
 * how this fixture keeps the assembled prompt down to the unconditional sections
 * — the same trick `chefChat.kitchenNotes.test.ts` plays.
 */
function fakeDb(session: Record<string, unknown> | null) {
  const set = vi.fn(async (_doc: Record<string, unknown>) => undefined);
  const ref = {
    get: async () => ({ exists: session !== null, id: 'sess-1', data: () => session }),
    set,
  };
  const db = {
    collection: (name: string) => {
      if (name !== 'chatSessions') throw new Error(`unexpected collection ${name}`);
      return { doc: () => ref };
    },
  };
  return { db: db as unknown as ReturnType<typeof getFirestore>, set };
}

/**
 * What Genkit hands back after a turn that called a tool.
 *
 * `GenerateResponse.messages` is the last request's messages plus the final model
 * message, and the tool loop carries the model message holding the `toolRequest`
 * forward into every subsequent request — so the call is still in there when the
 * turn ends, several messages back from the prose the reader saw.
 */
function responseWithToolCall(toolName: string) {
  return {
    text: 'Saving that now.',
    messages: [
      { role: 'user', content: [{ text: 'create a recipe from this' }] },
      { role: 'model', content: [{ toolRequest: { name: toolName, input: {} } }] },
      {
        role: 'tool',
        content: [{ toolResponse: { name: toolName, output: { requested: true } } }],
      },
      { role: 'model', content: [{ text: 'Saving that now.' }] },
    ],
  };
}

function plainResponse() {
  return {
    text: 'A pilaf, at a guess.',
    messages: [
      { role: 'user', content: [{ text: 'what can I make with what I have?' }] },
      { role: 'model', content: [{ text: 'A pilaf, at a guess.' }] },
    ],
  };
}

async function runTurn(
  response: unknown,
  opts: {
    session?: Record<string, unknown> | null;
    context?: Record<string, unknown> | undefined;
  } = {},
): Promise<{ tools: unknown[]; system: string; written: Record<string, unknown> | undefined }> {
  const { db, set } = fakeDb(opts.session === undefined ? storedSession() : opts.session);
  mockGetFirestore.mockReturnValue(db);
  mockGenerateStream.mockReturnValue({
    stream: (async function* () {
      yield { text: 'Saving that now.' };
    })(),
    response: Promise.resolve(response),
  });

  const sideChannel = Object.assign(() => undefined, {
    context: 'context' in opts ? opts.context : SIGNED_IN,
  });
  await (chefChatFlow as unknown as (input: unknown, cb: unknown) => Promise<string>)(
    {
      messages: [],
      newMessage: 'create a recipe from this',
      recipeId: null,
      sessionId: 'sess-1',
    },
    sideChannel,
  );

  const options = mockGenerateStream.mock.calls[0]?.[0] as Record<string, unknown>;
  return {
    tools: options['tools'] as unknown[],
    system: String(options['system']),
    written: set.mock.calls.at(-1)?.[0],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFlagEnabled.mockImplementation(async (_key: string) => true);
});

// ─── 1. Recognition never writes ─────────────────────────────────────────────

describe('saveRecipe — the tool that records and does nothing', () => {
  it('answers without touching Firestore at all', async () => {
    // The pin for the whole feature's safety property. `getFirestore` throws
    // here, so a handler that reads or writes ANYTHING cannot resolve — including
    // one written in the `(input) => doThing(getFirestore(), input)` shape the
    // Library's write tool uses, where the call is in the wrapper.
    mockGetFirestore.mockImplementation(() => {
      throw new Error('the save tool must not reach Firestore');
    });
    const tool = saveRecipeTool as unknown as { handler: (input: unknown) => Promise<unknown> };

    await expect(tool.handler({})).resolves.toEqual({ requested: true });
  });

  it('gives the same answer every time, because there is nothing to vary', async () => {
    const tool = saveRecipeTool as unknown as { handler: (input: unknown) => Promise<unknown> };

    await expect(tool.handler({})).resolves.toEqual(await tool.handler({}));
  });

  it('is registered under the name the reply is scanned for', () => {
    expect(saveRecipeTool).toMatchObject({ __tool: SAVE_RECIPE_TOOL_NAME });
  });
});

// ─── 2. The gate ─────────────────────────────────────────────────────────────

describe('chefChat — whose chef can be asked to save', () => {
  it('asks PostHog about the chat-save flag for the verified caller', async () => {
    await runTurn(plainResponse());

    expect(mockFlagEnabled).toHaveBeenCalledWith(CHAT_SAVE_FLAG_KEY, 'u-1', {
      email: 'daniel@example.com',
    });
  });

  it('gives a caller inside the flag the tool and the saving section', async () => {
    mockFlagEnabled.mockImplementation(async (key: string) => key === CHAT_SAVE_FLAG_KEY);
    const { tools, system } = await runTurn(plainResponse());

    expect(tools).toContain(saveRecipeTool);
    expect(system).toContain('## Saving one of their recipes');
  });

  it('gives a caller outside the flag neither the tool nor a word about it', async () => {
    // With the key off the chat behaves exactly as it does today: no seventh
    // tool, and a prompt with nothing in it that could invite the ask.
    mockFlagEnabled.mockImplementation(async (key: string) => key === LIBRARY_FLAG_KEY);
    const { tools, system } = await runTurn(plainResponse());

    expect(tools).not.toContain(saveRecipeTool);
    expect(system).not.toContain('## Saving one of their recipes');
    expect(system).not.toMatch(/saveRecipe/);
  });

  it('records nothing for a caller outside the flag, even if the tool were called', async () => {
    // Belt and braces, and deliberately: the array is the only route to the tool,
    // so this can only happen if something else goes wrong — and when it does,
    // the answer is still "nothing was asked for".
    mockFlagEnabled.mockImplementation(async (key: string) => key === LIBRARY_FLAG_KEY);
    const { written } = await runTurn(responseWithToolCall(SAVE_RECIPE_TOOL_NAME));

    expect(written?.['pendingSaveIntent']).toBe(null);
  });

  it('fails closed, and asks PostHog nothing, when no verified caller reached the flow', async () => {
    const { tools } = await runTurn(plainResponse(), { context: undefined });

    expect(tools).not.toContain(saveRecipeTool);
    expect(mockFlagEnabled).not.toHaveBeenCalled();
  });
});

// ─── 3 & 4. What reaches the chat document ───────────────────────────────────

describe('chefChat — the request on the document', () => {
  it('records the ask against the assistant turn it came from', async () => {
    const { written } = await runTurn(responseWithToolCall(SAVE_RECIPE_TOOL_NAME));

    const messages = written?.['messages'] as { id: string; role: string }[];
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(written?.['pendingSaveIntent']).toBe(assistant?.id);
    expect(written?.['pendingSaveIntent']).toEqual(expect.any(String));
  });

  it('records nothing on an ordinary conversational turn', async () => {
    // The other half of Rule 12's demand here: "it only fires when asked" is only
    // a claim if something goes red when an ordinary turn starts firing one.
    const { written } = await runTurn(plainResponse());

    expect(written?.['pendingSaveIntent']).toBe(null);
  });

  it('clears a request the next turn did not repeat', async () => {
    // The flow's half of the clearing rule. Without it, a request nobody acted on
    // sits on the document and re-fires on every reload for the life of the chat.
    const { written } = await runTurn(plainResponse(), {
      session: storedSession({ pendingSaveIntent: 'an-old-turn' }),
    });

    expect(written?.['pendingSaveIntent']).toBe(null);
  });

  it('leaves the reply and the transcript exactly as they were', async () => {
    // The wire contract does not move — that is the whole reason this channel was
    // chosen over #1303's split output schema. The reply is still the prose.
    const { written } = await runTurn(responseWithToolCall(SAVE_RECIPE_TOOL_NAME));

    const messages = written?.['messages'] as { role: string; text: string }[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.text).toBe('Saving that now.');
  });
});

// ─── 5. Reading Genkit's message history ─────────────────────────────────────

describe('turnRequestedRecipeSave', () => {
  it('finds a tool request several messages back from the final reply', () => {
    expect(turnRequestedRecipeSave(responseWithToolCall(SAVE_RECIPE_TOOL_NAME))).toBe(true);
  });

  it('accepts a namespaced name, as a plugin-registered tool would carry', () => {
    expect(
      turnRequestedRecipeSave(responseWithToolCall(`some-plugin/${SAVE_RECIPE_TOOL_NAME}`)),
    ).toBe(true);
  });

  it('is not fooled by another tool, or by a name that merely contains it', () => {
    expect(turnRequestedRecipeSave(responseWithToolCall('writeKitchenNote'))).toBe(false);
    expect(turnRequestedRecipeSave(responseWithToolCall('unsaveRecipe'))).toBe(false);
  });

  it('says no for an ordinary turn', () => {
    expect(turnRequestedRecipeSave(plainResponse())).toBe(false);
  });

  it('says no rather than throwing when the response carries no history', () => {
    // `GenerateResponse.messages` THROWS without a request reference. Every test
    // double in this repo is such a response, and so is any aggregate Genkit hands
    // back without one — none of them is a reason to lose a paid-for turn.
    const throwing = {
      get messages(): never {
        throw new Error("Can't construct history for response without request reference.");
      },
    };
    expect(turnRequestedRecipeSave(throwing)).toBe(false);
    expect(turnRequestedRecipeSave(undefined)).toBe(false);
    expect(turnRequestedRecipeSave({ text: 'hello' })).toBe(false);
  });
});
