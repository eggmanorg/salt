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
 * A fifth arrived with issue #1476, which reversed #1377's naming call:
 *
 *  5. THE CHEF USES THE APP'S OWN WORDS. The assembled system prompt says neither
 *     "recipe library" nor "kitchen note" — neither is a surface in Salt — in
 *     either gate state, and the two headings match `nav.ts`. Prompt text again,
 *     so a content assertion is the only thing that can hold it.
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
//
// KEY-AWARE since #1480, which put a SECOND gated tool on the same mock. Every
// assertion below is about the `library` flag, so this answers for that one and
// refuses everything else — which is also what keeps "all six tools" exact now
// that a seventh exists behind its own flag.
const { mockFlagEnabled } = vi.hoisted(() => ({
  mockFlagEnabled: vi.fn(async (key: string) => key === 'library'),
}));
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
  readEquipmentDetailTool,
  verifiedCaller,
  chefChatFlow,
} = await import('../../src/flows/chefChat.js');

beforeEach(() => {
  mockWarn.mockClear();
  mockGenerateStream.mockReset();
  mockFlagEnabled.mockClear();
  mockFlagEnabled.mockImplementation(async (key: string) => key === LIBRARY_FLAG_KEY);
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
      ok: true,
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
      ok: false,
      matches: [],
      totalNotes: 0,
    });
    expect(mockWarn).toHaveBeenCalled();
  });

  it('reports a failed search as a failure, never as an empty library', async () => {
    // The finding this pins: `{ matches: [], totalNotes: 0 }` alone is
    // byte-identical to a household that has genuinely written nothing, and
    // KITCHEN_NOTES_FRAMING tells the chef to say so plainly. `ok` is the only
    // thing that tells the two apart, so a failed read must set it false.
    const db = { collection: () => ({ get: () => Promise.reject(new Error('boom')) }) } as never;

    const result = await findKitchenNotesForChef(db, {});
    expect(result.ok).toBe(false);
    // And a genuinely empty library — the case this must not be confused with —
    // still reports ok: true.
    expect(await findKitchenNotesForChef(dbWith([]), {})).toMatchObject({
      ok: true,
      totalNotes: 0,
    });
  });

  it('browses newest edit first when no query narrows it', async () => {
    const library = [
      { id: 'p-older', data: pageDoc({ id: 'p-older', updatedAt: '2026-01-01T00:00:00.000Z' }) },
      { id: 'p-newer', data: pageDoc({ id: 'p-newer', updatedAt: '2026-03-01T00:00:00.000Z' }) },
    ];
    const result = await findKitchenNotesForChef(dbWith(library), {});
    expect(result.matches.map((m) => m.id)).toEqual(['p-newer', 'p-older']);
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

  it('calls these pages the Library, in both descriptions', () => {
    // The reverse of what this test asserted before issue #1476: the word belongs
    // to THESE pages, because `nav.ts` labels `#/library` "Library" and it opens
    // them. Only one of the two surfaces may hold it — the recipes side is now
    // "their recipes" — so this is what notices the collision coming back.
    expect(find?.description).toMatch(/\bLibrary\b/);
    expect(read?.description).toMatch(/\bLibrary\b/);
    expect(find?.description).not.toMatch(/kitchen note/i);
    expect(read?.description).not.toMatch(/kitchen note/i);
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

  it('tells the model that ok:false means the search failed, not that nothing was found', () => {
    expect(find?.description).toMatch(/ok comes back false/i);
    expect(find?.description).toMatch(/never say they have written nothing/i);
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

  it('gives a caller inside the flag all six tools and the Library section', async () => {
    const { tools, system } = await runTurn(signedIn);

    expect(tools).toEqual([
      findRecipesTool,
      readRecipeTool,
      readEquipmentDetailTool,
      findKitchenNotesTool,
      readKitchenNoteTool,
      writeKitchenNoteTool,
    ]);
    expect(system).toContain('## Their Library');
  });

  it('gives a caller OUTSIDE the flag neither tool and no mention of the Library', async () => {
    // The #831 leak this gate exists to close: a page written under the flag must
    // not reach a household member the feature is hidden from, through an answer
    // no browser gate can see.
    mockFlagEnabled.mockResolvedValue(false);
    const { tools, system } = await runTurn(signedIn);

    expect(tools).toEqual([findRecipesTool, readRecipeTool, readEquipmentDetailTool]);
    expect(system).not.toContain('## Their Library');
    expect(system).not.toMatch(/findKitchenNotes/);
    // And so cannot cause a page to be WRITTEN either — the write tool rides the
    // same gate rather than carrying one of its own.
    expect(tools).not.toContain(writeKitchenNoteTool);
  });

  // ─── The vocabulary, in both gate states (issue #1476) ─────────────────────
  //
  // The mechanism for the claim "the chef uses the app's own words". Neither
  // "Recipe Library" nor "Kitchen Notes" is a surface anyone can find in Salt,
  // and a chef that names them sends people nowhere — which is exactly what
  // happened in production: a recipe written to the Library, reported as NOT in
  // the "Recipe Library", and saved a second time by hand.
  //
  // Asserted on the ASSEMBLED system prompt rather than on the constants,
  // because a phrase reintroduced in CHEF_SYSTEM_BASE, LIBRARY_FRAMING or
  // KITCHEN_NOTES_FRAMING would be just as visible to the model and invisible to
  // a per-constant check. Both gate states are covered because the Library
  // sections only exist in one of them.
  //
  // THE BOUNDARY (CLAUDE.md Rule 12 — a claim nothing guarantees is not the claim
  // to make): this reaches only those two unconditional sections, and only the
  // two exact bigrams below — not the bare word "library". `dbWith` above throws
  // for every collection but `libraryPages`, so every GATED section (the
  // equipment framing, favourites, kitchen memory, `## Current recipe`,
  // variation framing) degrades to `''` in this fixture and never reaches
  // `options['system']` at all — a phrase reintroduced in any of them is
  // invisible here, not caught, whatever an earlier version of this comment
  // claimed. Nor does `options['system']` cover tool descriptions, which ride
  // separately in `options['tools']`: the Library side's two are pinned by the
  // per-description assertions below; the recipes side's are not pinned by
  // anything, and neither are the four schema `.describe()` files under
  // `packages/domain/src/schemas`. See `docs/library.md`'s Rule 12 ledger.
  //
  // The tool IDENTIFIERS survive this deliberately: `findKitchenNotes` and
  // `readKitchenNote` carry no space, so "kitchen note" does not match them.
  it.each([
    ['inside the flag', true],
    ['outside the flag', false],
  ])('never says "recipe library" or "kitchen note" to the model — %s', async (_label, inFlag) => {
    mockFlagEnabled.mockResolvedValue(inFlag);
    const { system } = await runTurn(signedIn);

    expect(system).not.toMatch(/recipe library/i);
    expect(system).not.toMatch(/kitchen note/i);
  });

  it('names the two surfaces as the app names them', async () => {
    const { system } = await runTurn(signedIn);

    // `nav.ts` labels `#/library` "Library"; `#/recipes` is Recipes. The two
    // headings the chef reads have to match, or the reply points at nothing.
    expect(system).toContain('## Their Library');
    expect(system).toContain('## Their own recipes');
    // And the separation #1377 built stays load-bearing under the new names.
    expect(system).toContain('THE LIBRARY IS NOT THEIR RECIPES');
  });

  it('fails CLOSED, and asks PostHog nothing, when no verified caller reached the flow', async () => {
    // `isServerFeatureEnabled` fails OPEN on a deployment with no PostHog key, so
    // the refusal has to happen before it is ever called.
    const { tools } = await runTurn(undefined);

    expect(tools).toEqual([findRecipesTool, readRecipeTool, readEquipmentDetailTool]);
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
    expect(options['tools']).toEqual([findRecipesTool, readRecipeTool, readEquipmentDetailTool]);
    expect(mockFlagEnabled).not.toHaveBeenCalled();
  });
});
