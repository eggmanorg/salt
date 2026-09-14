/**
 * The chef's kitchen-notes tools (issue #1377, phase 1) — the read half.
 *
 * Four properties this phase CLAIMS, each pinned here because a sentence nothing
 * can falsify is worth nothing:
 *
 *  1. THE TOOLS ARE GATED SERVER-SIDE, PER CALLER. A caller outside the `library`
 *     flag gets a `tools:` array with neither notes tool in it, and a system
 *     prompt with no notes section — so their chef cannot mention, offer or reach
 *     a page. That is the #831 leak this phase would otherwise open.
 *  2. THE UID COMES FROM THE VERIFIED CALLER AND NOWHERE ELSE. The gate is asked
 *     about the uid Genkit's action context carries — what `onCallGenkit` copies
 *     out of the verified ID token — and a request with no such context is refused
 *     the tools rather than given them.
 *  3. THE READ IS TWO-STEP, AND BOTH DESCRIPTIONS SAY WHEN NOT TO CALL. Prompt
 *     text, so nothing but a content assertion can hold it in place.
 *  4. A CORRUPT PAGE IS SKIPPED, NOT THROWN ON, and an unreadable one is reported
 *     as "could not open" rather than "deleted".
 *
 * The summary and the filter are not tested here: both are pure and live in
 * `@salt/domain`, pinned by `pageSummary.test.ts` and `searchLibraryPages.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from 'firebase-functions';
import { LIBRARY_FLAG_KEY } from '@salt/observability/server';

// A SPY on the real logger rather than a sixth `vi.mock`, which would put this
// file over the unit-test spec's mock ceiling (UT-B1). The warn calls are what
// prove the skip-invalid and degrade-on-failure paths were taken.
const mockWarn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

const mockGenerateStream = vi.fn();
const defineToolCalls: { name: string; description: string }[] = [];

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    defineTool: (config: { name: string; description: string }, handler: unknown) => {
      defineToolCalls.push(config);
      return { __tool: config.name, handler };
    },
    generateStream: mockGenerateStream,
  },
}));
vi.mock('../../src/ai/fakeModel.js', () => ({ flowModel: vi.fn(async () => 'fake-model') }));
vi.mock('../../src/adapters/withAiTimeout.js', () => ({
  AI_TEXT_FLOW_TIMEOUT: { timeoutMs: 55_000, retries: 0 },
  withAiTimeout: (_flow: string, fn: () => Promise<unknown>) => fn(),
  withAiStreamTimeout: (_flow: string, stream: AsyncIterable<unknown>) => stream,
}));

const mockGetFirestore = vi.fn();
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => mockGetFirestore() }));

// The ONE export this file substitutes, with the rest of the module left real —
// `reportServerError.ts` imports from here too, and replacing the whole module
// would break its bindings for no gain.
// `vi.hoisted` because the mock factory below is hoisted above this file's own
// imports, and one of those imports pulls in the very module being mocked.
const { mockFlagEnabled } = vi.hoisted(() => ({ mockFlagEnabled: vi.fn(async () => true) }));
vi.mock('@salt/observability/server', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isServerFeatureEnabled: mockFlagEnabled,
}));

const {
  findKitchenNotesForChef,
  readKitchenNoteForChef,
  findKitchenNotesTool,
  readKitchenNoteTool,
  writeKitchenNoteTool,
  findRecipesTool,
  readRecipeTool,
  verifiedCaller,
  chefChatFlow,
} = await import('../../src/flows/chefChat.js');

beforeEach(() => {
  mockWarn.mockClear();
  mockGenerateStream.mockReset();
  mockFlagEnabled.mockClear();
  mockFlagEnabled.mockResolvedValue(true);
});

// ─── A Firestore holding libraryPages, and nothing else ──────────────────────

interface StoredPage {
  readonly id: string;
  readonly data: Record<string, unknown>;
}

function pageDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p-sous-vide',
    schemaVersion: 1,
    kind: 'note',
    title: 'Sous vide times',
    body: '# Sous vide times\n\nChuck at 65 °C for 24 hours.',
    tags: ['sous-vide'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    createdBy: 'Daniel',
    lastEditedBy: 'Daniel',
    revisions: [],
    ...over,
  };
}

/** A db that refuses any collection but `libraryPages`. */
function dbWith(pages: StoredPage[]): never {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const db = {
    collection: (name: string) => {
      if (name !== 'libraryPages') throw new Error(`unexpected collection ${name}`);
      return {
        get: () => Promise.resolve({ docs: pages.map((p) => ({ id: p.id, data: () => p.data })) }),
        doc: (id: string) => ({
          get: () => {
            const hit = byId.get(id);
            return Promise.resolve({
              exists: hit !== undefined,
              id,
              data: () => hit?.data,
            });
          },
        }),
      };
    },
  };
  return db as never;
}

// ─── 4. Reading the notes ─────────────────────────────────────────────────────

describe('findKitchenNotes — what comes back', () => {
  it('carries the id, title, tags and a summary derived from the body', async () => {
    const result = await findKitchenNotesForChef(dbWith([{ id: 'p-1', data: pageDoc() }]), {});

    expect(result).toEqual({
      matches: [
        {
          id: 'p-1',
          title: 'Sous vide times',
          tags: ['sous-vide'],
          summary: 'Sous vide times Chuck at 65 °C for 24 hours.',
        },
      ],
      totalNotes: 1,
    });
  });

  it('takes the id from the document, not from the field inside it', async () => {
    // A page carrying a stale `id` would otherwise hand the chef an id that opens
    // nothing.
    const result = await findKitchenNotesForChef(
      dbWith([{ id: 'p-real', data: pageDoc({ id: 'p-stale' }) }]),
      {},
    );
    expect(result.matches[0]?.id).toBe('p-real');
  });

  it('narrows on a query, and still reports how many notes exist', async () => {
    const library = [
      { id: 'p-1', data: pageDoc() },
      { id: 'p-2', data: pageDoc({ title: 'The Weck jars', body: 'A tapered 1 L jar.' }) },
    ];
    const result = await findKitchenNotesForChef(dbWith(library), { query: 'weck' });

    expect(result.matches.map((m) => m.id)).toEqual(['p-2']);
    expect(result.totalNotes).toBe(2);
  });

  it('skips a corrupt page without losing the rest, and warns', async () => {
    const result = await findKitchenNotesForChef(
      dbWith([
        { id: 'p-bad', data: { nonsense: true } },
        { id: 'p-good', data: pageDoc() },
      ]),
      {},
    );

    expect(result.matches.map((m) => m.id)).toEqual(['p-good']);
    expect(result.totalNotes).toBe(1);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('returns nothing, and warns, rather than throwing when Firestore fails', async () => {
    // Rule 10: a tool reports a failure the model can say out loud; it never
    // throws out of the model's own loop.
    const db = { collection: () => ({ get: () => Promise.reject(new Error('boom')) }) } as never;

    await expect(findKitchenNotesForChef(db, {})).resolves.toEqual({
      matches: [],
      totalNotes: 0,
    });
    expect(mockWarn).toHaveBeenCalled();
  });
});

describe('readKitchenNote — opening one in full', () => {
  it('returns the title and the body exactly as the household wrote them', async () => {
    await expect(
      readKitchenNoteForChef(dbWith([{ id: 'p-1', data: pageDoc() }]), { id: 'p-1' }),
    ).resolves.toEqual({
      found: true,
      title: 'Sous vide times',
      body: '# Sous vide times\n\nChuck at 65 °C for 24 hours.',
    });
  });

  it('reports a note it cannot open, for every reason it cannot open one', async () => {
    const missing = readKitchenNoteForChef(dbWith([]), { id: 'p-gone' });
    const corrupt = readKitchenNoteForChef(dbWith([{ id: 'p-1', data: { nonsense: true } }]), {
      id: 'p-1',
    });
    const threw = readKitchenNoteForChef(
      {
        collection: () => ({ doc: () => ({ get: () => Promise.reject(new Error('boom')) }) }),
      } as never,
      { id: 'p-1' },
    );

    // The same answer for all three, which is why the description must not tell
    // the model that `found: false` means the note was deleted.
    for (const result of await Promise.all([missing, corrupt, threw])) {
      expect(result).toEqual({ found: false, title: null, body: null });
    }
  });
});

// ─── 3. What the model is told ────────────────────────────────────────────────

describe('the kitchen-notes tools the model is shown', () => {
  const find = defineToolCalls.find((c) => c.name === 'findKitchenNotes');
  const read = defineToolCalls.find((c) => c.name === 'readKitchenNote');

  it('registers both, and returns them as the tool values', () => {
    expect(findKitchenNotesTool).toMatchObject({ __tool: 'findKitchenNotes' });
    expect(readKitchenNoteTool).toMatchObject({ __tool: 'readKitchenNote' });
  });

  it('wires each tool to its own handler, against the live Firestore', async () => {
    // The registered handler is what the model actually reaches, and it is a
    // different function from the exported one the cases above drive. Crossing the
    // wires here would be invisible to every other test in this file.
    mockGetFirestore.mockReturnValue(dbWith([{ id: 'p-1', data: pageDoc() }]));
    const tools = { find: findKitchenNotesTool, read: readKitchenNoteTool } as unknown as {
      find: { handler: (i: unknown) => Promise<{ matches: { id: string }[] }> };
      read: { handler: (i: unknown) => Promise<{ title: string | null }> };
    };

    await expect(tools.find.handler({})).resolves.toMatchObject({ matches: [{ id: 'p-1' }] });
    await expect(tools.read.handler({ id: 'p-1' })).resolves.toMatchObject({
      title: 'Sous vide times',
    });
  });

  it('never calls these pages a library, in either description', () => {
    // `LIBRARY_FRAMING` already spends that word on the household's saved
    // RECIPES. Two things under one name in one prompt is a collision for the
    // model, and this is what notices the word creeping back in.
    expect(find?.description).not.toMatch(/library/i);
    expect(read?.description).not.toMatch(/library/i);
  });

  it('tells the model when NOT to call each of them', () => {
    expect(find?.description).toContain('DO NOT CALL IT');
    expect(read?.description).toContain('DO NOT CALL IT');
    expect(find?.description).toMatch(/technique/i);
    expect(find?.description).toMatch(/just answer/i);
  });

  it('says the search line is often the whole answer, and when to open the note', () => {
    // The two-step read's load-bearing half: a chef that opens every note it
    // finds has spent the turn reading.
    expect(find?.description).toMatch(/SHALLOW/);
    expect(find?.description).toMatch(/readKitchenNote only when/i);
    expect(read?.description).toMatch(/when the line from findKitchenNotes already answers/i);
  });

  it('tells the model that found:false is not "deleted"', () => {
    expect(read?.description).toMatch(/never state that it has been deleted/i);
    expect(read?.description).toMatch(/never invent its contents/i);
  });
});

// ─── 1 & 2. The server-side gate ──────────────────────────────────────────────

describe('verifiedCaller — where the uid comes from', () => {
  it('reads the uid and the email off the verified auth context', () => {
    expect(
      verifiedCaller({ auth: { uid: 'u-1', token: { email: 'daniel@example.com' } } }),
    ).toEqual({ uid: 'u-1', email: 'daniel@example.com' });
  });

  it('takes the uid alone when no usable email rides with it', () => {
    expect(verifiedCaller({ auth: { uid: 'u-1' } })).toEqual({ uid: 'u-1' });
    expect(verifiedCaller({ auth: { uid: 'u-1', token: {} } })).toEqual({ uid: 'u-1' });
    expect(verifiedCaller({ auth: { uid: 'u-1', token: { email: '' } } })).toEqual({ uid: 'u-1' });
    expect(verifiedCaller({ auth: { uid: 'u-1', token: { email: 42 } } })).toEqual({ uid: 'u-1' });
  });

  it('refuses a context with no verified uid in it', () => {
    expect(verifiedCaller(undefined)).toBeNull();
    expect(verifiedCaller({})).toBeNull();
    expect(verifiedCaller({ auth: {} })).toBeNull();
    expect(verifiedCaller({ auth: { uid: '' } })).toBeNull();
    // And a uid that is not a string — the shape a forged context would take.
    expect(verifiedCaller({ auth: { uid: { toString: () => 'u-1' } } })).toBeNull();
  });
});

describe('chefChat — whose chat gets the notes tools', () => {
  async function runTurn(
    context?: Record<string, unknown>,
  ): Promise<{ tools: unknown[]; system: string }> {
    mockGetFirestore.mockReturnValue(dbWith([{ id: 'p-1', data: pageDoc() }]));
    mockGenerateStream.mockReturnValue({
      stream: (async function* () {
        yield { text: 'hello' };
      })(),
      response: Promise.resolve({ text: 'hello' }),
    });

    const sideChannel = Object.assign(() => undefined, { context });
    await (chefChatFlow as unknown as (input: unknown, cb: unknown) => Promise<string>)(
      { messages: [], newMessage: 'how long do I sous vide chuck?', recipeId: null },
      sideChannel,
    );

    const options = mockGenerateStream.mock.calls[0]?.[0] as Record<string, unknown>;
    return { tools: options['tools'] as unknown[], system: String(options['system']) };
  }

  const signedIn = { auth: { uid: 'u-1', token: { email: 'daniel@example.com' } } };

  it('asks PostHog about the shared flag key, for the verified caller', async () => {
    await runTurn(signedIn);
    expect(mockFlagEnabled).toHaveBeenCalledWith(LIBRARY_FLAG_KEY, 'u-1', {
      email: 'daniel@example.com',
    });
  });

  it('asks about the uid alone when the verified token carries no email', async () => {
    // An absent person property is fine; a made-up one is not, so nothing is sent
    // rather than a placeholder.
    await runTurn({ auth: { uid: 'u-2' } });
    expect(mockFlagEnabled).toHaveBeenCalledWith(LIBRARY_FLAG_KEY, 'u-2', undefined);
  });

  it('gives a caller inside the flag all five tools and the notes section', async () => {
    const { tools, system } = await runTurn(signedIn);

    expect(tools).toEqual([
      findRecipesTool,
      readRecipeTool,
      findKitchenNotesTool,
      readKitchenNoteTool,
      writeKitchenNoteTool,
    ]);
    expect(system).toContain('## Their own kitchen notes');
  });

  it('gives a caller OUTSIDE the flag neither tool and no mention of notes', async () => {
    // The #831 leak this gate exists to close: a page written under the flag must
    // not reach a household member the feature is hidden from, through an answer
    // no browser gate can see.
    mockFlagEnabled.mockResolvedValue(false);
    const { tools, system } = await runTurn(signedIn);

    expect(tools).toEqual([findRecipesTool, readRecipeTool]);
    expect(system).not.toContain('## Their own kitchen notes');
    expect(system).not.toMatch(/findKitchenNotes/);
    // And so cannot cause a note to be WRITTEN either — the write tool rides the
    // same gate rather than carrying one of its own.
    expect(tools).not.toContain(writeKitchenNoteTool);
  });

  it('fails CLOSED, and asks PostHog nothing, when no verified caller reached the flow', async () => {
    // `isServerFeatureEnabled` fails OPEN on a deployment with no PostHog key, so
    // the refusal has to happen before it is ever called.
    const { tools } = await runTurn(undefined);

    expect(tools).toEqual([findRecipesTool, readRecipeTool]);
    expect(mockFlagEnabled).not.toHaveBeenCalled();
  });

  it('never reads an identity out of the request body', async () => {
    // A uid in the payload is not a gate. `ChefChatInputSchema` has no field for
    // one, and `speaker` is a display NAME — this asserts that sending either
    // alongside no verified context still gets no tools.
    mockGetFirestore.mockReturnValue(dbWith([{ id: 'p-1', data: pageDoc() }]));
    mockGenerateStream.mockReturnValue({
      stream: (async function* () {
        yield { text: 'hello' };
      })(),
      response: Promise.resolve({ text: 'hello' }),
    });

    await (chefChatFlow as unknown as (input: unknown, cb: unknown) => Promise<string>)(
      { messages: [], newMessage: 'hi', recipeId: null, speaker: 'Daniel', uid: 'u-1' },
      () => undefined,
    );

    const options = mockGenerateStream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options['tools']).toEqual([findRecipesTool, readRecipeTool]);
    expect(mockFlagEnabled).not.toHaveBeenCalled();
  });
});
