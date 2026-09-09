/**
 * The household's notes reaching the chef's system prompt (issue #816, phase 2).
 *
 * The unit tests next door pin the read and the framing. What is pinned HERE is the
 * one property the whole phase is judged on from the outside: a household that has
 * written nothing gets the prompt it got yesterday, unchanged — the section is
 * ABSENT, not empty, not a heading with nothing under it. Everything else this
 * feature does is opt-in by having written a note.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase-functions', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const mockGenerateStream = vi.fn();
vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    // chefChat defines its findRecipes tool at module load (issue #840); the
    // identity stub keeps importing the module free for tests that are not about it.
    defineTool: (_config: unknown, handler: unknown) => handler,
    generateStream: mockGenerateStream,
  },
}));

vi.mock('../../src/ai/fakeModel.js', () => ({ flowModel: vi.fn(async () => 'fake-model') }));

// Bypass the real timer, but keep everything else the module exports (the
// shared budget constant, the stream guard) — a factory that lists only
// `withAiTimeout` goes stale the moment the module grows.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));

vi.mock('../../src/observability/reportServerError.js', () => ({
  reportFlowError: vi.fn(async () => undefined),
}));

// One getFirestore() serves every context read. Only `kitchenMemories` matters
// here; `recipes`, `equipmentManifest` and `canonData` resolve absent so their
// sections are omitted and the prompt is the base plus whatever the notes add.
const memoryDocs: { id: string; data: unknown }[] = [];
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        id,
        get: () => Promise.resolve({ exists: false, data: () => undefined }),
      }),
      get: () =>
        Promise.resolve({
          docs:
            name === 'kitchenMemories'
              ? memoryDocs.map((d) => ({ id: d.id, data: () => d.data }))
              : [],
        }),
    }),
    getAll: () => Promise.resolve([]),
  }),
}));

const { chefChatFlow } = await import('../../src/flows/chefChat.js');

function note(id: string, author: string, text: string, createdAt: string) {
  return { id, data: { id, schemaVersion: 1, author, text, createdAt } };
}

beforeEach(() => {
  vi.clearAllMocks();
  memoryDocs.length = 0;
  mockGenerateStream.mockReturnValue({
    stream: (async function* () {})(),
    response: Promise.resolve({ text: 'Try a fennel and orange salad alongside.' }),
  });
});

function systemPromptFrom(): string {
  return (mockGenerateStream.mock.calls[0]![0] as { system: string }).system;
}

async function send(input: Record<string, unknown> = {}): Promise<void> {
  await (chefChatFlow as Function)(
    { messages: [], newMessage: 'what shall we have tonight?', recipeId: null, ...input },
    () => {},
  );
}

describe('chefChat — kitchen memories', () => {
  it('leaves the prompt untouched for a household that has written nothing', async () => {
    await send({ speaker: 'Kate' });

    const system = systemPromptFrom();
    expect(system).not.toContain('What the household has told you');
    expect(system).not.toContain('You are talking to');
    // Not merely an empty heading — no trace of the feature at all.
    expect(system).not.toContain('preferences, not rules');
  });

  it('injects the notes, their authors, and who is being spoken to', async () => {
    memoryDocs.push(
      note('m1', 'Daniel', "I don't eat mushrooms", '2026-08-01T09:00:00.000Z'),
      note('m2', 'Kate', 'we like it spicy', '2026-08-01T10:00:00.000Z'),
    );

    await send({ speaker: 'Kate' });

    const system = systemPromptFrom();
    expect(system).toContain('What the household has told you');
    expect(system).toContain('You are talking to Kate.');
    expect(system).toContain('Daniel:');
    expect(system).toContain("- I don't eat mushrooms");
    expect(system).toContain('Kate:');
    expect(system).toContain('- we like it spicy');
  });

  it('still shows the notes when an older client sends no speaker', async () => {
    memoryDocs.push(note('m1', 'Daniel', "I don't eat mushrooms", '2026-08-01T09:00:00.000Z'));

    await send();

    const system = systemPromptFrom();
    expect(system).toContain('What the household has told you');
    expect(system).not.toContain('You are talking to');
    // …and the turn went to the model rather than failing on the missing field.
    expect(mockGenerateStream).toHaveBeenCalledTimes(1);
  });
});
