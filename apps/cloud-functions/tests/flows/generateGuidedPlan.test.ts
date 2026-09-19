import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AI_FLOW_ROLES, GuidedPlanSchema, type GuidedPlanDoc } from '@salt/domain/schemas';

// Two collections now: `recipes` (read) and `guidedPlans` (read for `createdAt`,
// then written). They are kept apart so a test can fail one without the other —
// the whole point of the log-and-continue arms below.
const {
  mockGenerate,
  mockGet,
  mockDoc,
  mockCollection,
  mockPlanGet,
  mockPlanSet,
  mockPlanDoc,
  mockFlowModel,
} = vi.hoisted(() => {
  const mockGet = vi.fn();
  const mockDoc = vi.fn(() => ({ get: mockGet }));
  const mockPlanGet = vi.fn();
  const mockPlanSet = vi.fn();
  const mockPlanDoc = vi.fn(() => ({ get: mockPlanGet, set: mockPlanSet }));
  const mockCollection = vi.fn((name: string) =>
    name === 'guidedPlans' ? { doc: mockPlanDoc } : { doc: mockDoc },
  );
  return {
    mockGenerate: vi.fn(),
    mockGet,
    mockDoc,
    mockCollection,
    mockPlanGet,
    mockPlanSet,
    mockPlanDoc,
    mockFlowModel: vi.fn().mockResolvedValue('gemini-pro-latest'),
  };
});

vi.mock('firebase-functions', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const { logger } = await import('firebase-functions');
const logged = vi.mocked(logger.error);

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: mockGenerate,
  },
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: mockCollection }),
}));

// Stub withAiTimeout to call op() directly — timeout/retry logic is tested elsewhere.
// Bypass the real timer, but keep everything else the module exports (the
// shared budget constant, the stream guard) — a factory that lists only
// `withAiTimeout` goes stale the moment the module grows.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (_label: string, op: () => unknown) => op(),
}));

vi.mock('../../src/ai/fakeModel.js', () => ({
  flowModel: mockFlowModel,
}));

const { generateGuidedPlanFlow } = await import('../../src/flows/generateGuidedPlan.js');
const run = generateGuidedPlanFlow as unknown as (input: {
  recipeId: string;
}) => Promise<GuidedPlanDoc>;

const RECIPE = {
  id: 'recipe-1',
  schemaVersion: 1,
  kind: 'recipe',
  title: 'Ragù',
  description: 'A long-simmered sauce.',
  ingredients: [
    {
      id: 'grp-1',
      name: null,
      items: [
        {
          id: 'ing-1',
          rawText: '1 onion',
          parsed: null,
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
      ],
    },
  ],
  steps: [
    {
      id: 'step-1',
      text: 'Soften the onion.',
      timer: { durationMinutes: 10, description: null },
      note: null,
    },
  ],
  metadata: {
    servings: 4,
    tags: [],
  },
  source: null,
  notes: null,
  image: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
};

// A CORRECT plan, and it has to be: the container name is the only join between
// the two halves, so a fixture whose note says "the small bowl" about a job that
// filled a "small bowl" models a plan whose step can never show its contents
// (issue #761). The name is unique, says what is in the bowl, and is copied
// character for character onto the note — and the prep text gives a dimension
// rather than "finely".
const AI_OUTPUT = {
  prep: [
    { text: 'Dice the onion into 5mm dice', container: 'onion bowl', ingredientIds: ['ing-1'] },
  ],
  stepNotes: [
    {
      stepId: 'step-1',
      container: 'onion bowl',
      setup: 'small hob burner, medium-low',
      cue: 'a very gentle sizzle, not a crackle',
      checkIns: [{ atMinutes: 5, text: 'give it a stir' }],
      lookahead: 'the onions soften',
      getAhead: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFlowModel.mockResolvedValue('gemini-pro-latest');
  mockGet.mockResolvedValue({ exists: true, data: () => RECIPE });
  // No plan yet, the common case.
  mockPlanGet.mockResolvedValue({ exists: false, data: () => undefined });
  mockPlanSet.mockResolvedValue(undefined);
});

/** The document handed to `guidedPlans/{id}.set()`. */
function written(): GuidedPlanDoc {
  expect(mockPlanSet).toHaveBeenCalledTimes(1);
  return mockPlanSet.mock.calls[0]![0] as GuidedPlanDoc;
}

describe('generateGuidedPlan', () => {
  it('reads the recipe server-side by id and returns the plan it authored', async () => {
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });

    const result = await run({ recipeId: 'recipe-1' });

    expect(mockCollection).toHaveBeenCalledWith('recipes');
    expect(mockDoc).toHaveBeenCalledWith('recipe-1');
    expect(result.prep[0]!.text).toBe(AI_OUTPUT.prep[0]!.text);
    expect(result.stepNotes[0]!.cue).toBe(AI_OUTPUT.stepNotes[0]!.cue);
  });

  it('runs on the `pro` role — cue quality IS the feature', async () => {
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
    await run({ recipeId: 'recipe-1' });
    expect(mockFlowModel).toHaveBeenCalledWith('generateGuidedPlan');
    expect(AI_FLOW_ROLES.generateGuidedPlan).toBe('pro');
  });

  it('shows the model the ingredient and step IDS, and each step timer', async () => {
    // The output references those ids — an ingredient id per prep job, a step id
    // per note — and a model that cannot see an id cannot cite it. The timer is
    // shown because a check-in must land strictly inside it.
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
    await run({ recipeId: 'recipe-1' });
    const prompt = String(mockGenerate.mock.calls[0]![0].prompt);
    expect(prompt).toContain('[ing-1] 1 onion');
    expect(prompt).toContain('[step-1]');
    expect(prompt).toContain('timer: 10 minutes');
  });

  it('tells the model the container rules that make the plan joinable', async () => {
    // The prep/step-note halves join on the container NAME and nothing else, so the
    // two rules that keep that name resolvable — unique per job, verbatim on the
    // note — have to actually reach the model. They ride the system prompt.
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
    await run({ recipeId: 'recipe-1' });
    const system = String(mockGenerate.mock.calls[0]![0].system);
    expect(system).toContain('EVERY CONTAINER NAME MUST BE UNIQUE ACROSS THE WHOLE PREP LIST');
    expect(system).toContain('COPIED VERBATIM');
  });

  it('stores a note whose container no job fills, exactly as authored', async () => {
    // Deliberately NOT filtered or rejected. A container name that does not resolve
    // costs a step its contents and nothing more — the plan is still cookable, and
    // the editor is where it gets fixed, so dropping the note here would delete the
    // cue and setup the model got right along with the one word it got wrong.
    mockGenerate.mockResolvedValue({
      output: {
        ...AI_OUTPUT,
        stepNotes: [{ ...AI_OUTPUT.stepNotes[0], container: 'the tureen' }],
      },
    });

    const result = (await run({ recipeId: 'recipe-1' })) as unknown as {
      stepNotes: { container: string | null }[];
    };

    expect(result.stepNotes).toHaveLength(1);
    expect(result.stepNotes[0]!.container).toBe('the tureen');
  });

  it('drops a note for a step the recipe does not have', async () => {
    // A hallucinated step id would render as nothing in the editor anyway; storing
    // it makes every later reader handle a note the cook can never see.
    mockGenerate.mockResolvedValue({
      output: {
        ...AI_OUTPUT,
        stepNotes: [
          ...AI_OUTPUT.stepNotes,
          {
            stepId: 'step-99',
            container: null,
            setup: null,
            cue: 'invented',
            checkIns: [],
            lookahead: 'invented too',
            getAhead: null,
          },
        ],
      },
    });

    const result = await run({ recipeId: 'recipe-1' });

    expect(result.stepNotes.map((n) => n.stepId)).toEqual(['step-1']);
  });

  it('throws when the recipe does not exist', async () => {
    mockGet.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(run({ recipeId: 'nope' })).rejects.toThrow();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('throws when the stored recipe fails validation', async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ id: 'recipe-1', schemaVersion: 2 }) });
    await expect(run({ recipeId: 'recipe-1' })).rejects.toThrow();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('throws when the model output is not the expected shape', async () => {
    mockGenerate.mockResolvedValue({ output: { prep: 'not a list' } });
    await expect(run({ recipeId: 'recipe-1' })).rejects.toThrow(/invalid output/);
  });
});

// THE REGRESSION SUITE for issue #1416. The plan used to be assembled and written
// by the browser after this callable resolved, so a phone that locked during the
// one-to-three-minute call threw away a finished plan — silently, with the model
// already paid for. Nothing below touches the client: if these pass, the document
// exists whatever the browser does next.
describe('generateGuidedPlan — the flow writes the document', () => {
  beforeEach(() => {
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
  });

  it('writes the plan to guidedPlans/{recipeId} before it returns', async () => {
    await run({ recipeId: 'recipe-1' });

    expect(mockCollection).toHaveBeenCalledWith('guidedPlans');
    expect(mockPlanDoc).toHaveBeenCalledWith('recipe-1');
    expect(written().id).toBe('recipe-1');
    expect(written().recipeId).toBe('recipe-1');
  });

  it('writes a document the stored schema accepts', async () => {
    // The write is a full `.set()` on the live collection, so a document that would
    // not survive `GuidedPlanSchema` is one the subscription then skips — the plan
    // would be in Firestore and invisible, which is the original bug wearing a
    // different hat.
    await run({ recipeId: 'recipe-1' });
    expect(GuidedPlanSchema.safeParse(written()).success).toBe(true);
  });

  it('returns exactly what it wrote, so the page needs no second source', async () => {
    const result = await run({ recipeId: 'recipe-1' });
    expect(result).toEqual(written());
  });

  it('flags the plan unreviewed — the ONLY place needs_approval is ever set', async () => {
    // Dropped by a human save and set nowhere else. A plan authored or corrected
    // by hand is never flagged.
    await run({ recipeId: 'recipe-1' });
    expect(written().needs_approval).toBe(true);
  });

  it('mints a prep id per entry — the model authors content, never identity', async () => {
    await run({ recipeId: 'recipe-1' });
    const plan = written();
    expect(plan.prep).toHaveLength(1);
    expect(plan.prep[0]!.id).toBeTruthy();
    expect(plan.prep[0]!.text).toBe('Dice the onion into 5mm dice');
  });

  it('stamps recipeUpdatedAtAtSave from the recipe IT read', async () => {
    // Strictly more correct than the client stamping it from its own copy, which
    // could be staler than the recipe the plan was actually written against.
    await run({ recipeId: 'recipe-1' });
    expect(written().recipeUpdatedAtAtSave).toBe(RECIPE.updatedAt);
  });

  it('carries createdAt across a re-run — the plan for this recipe is not new', async () => {
    mockPlanGet.mockResolvedValue({
      exists: true,
      data: () => ({ createdAt: '2026-07-01T00:00:00.000Z' }),
    });

    await run({ recipeId: 'recipe-1' });

    const plan = written();
    expect(plan.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(plan.updatedAt > plan.createdAt).toBe(true);
  });

  it('dates a first plan now, when there is nothing to carry across', async () => {
    await run({ recipeId: 'recipe-1' });
    expect(written().createdAt).toBe(written().updatedAt);
  });

  it('still returns the plan when the write fails, rather than binning the call', async () => {
    // `persistAuthoredRecipe`'s shape: a generation that has already been paid for
    // is never thrown away over a write error. The editor paints it and the cook's
    // Save writes it — and THAT is the boundary, because the recovery takes a Save.
    mockPlanSet.mockRejectedValue(new Error('unavailable'));

    const result = await run({ recipeId: 'recipe-1' });

    expect(result.prep).toHaveLength(1);
    expect(result.needs_approval).toBe(true);
  });

  it('still writes the plan when the existing-plan read fails', async () => {
    // A cosmetic `createdAt` is not worth failing a finished generation over.
    mockPlanGet.mockRejectedValue(new Error('unavailable'));

    const result = await run({ recipeId: 'recipe-1' });

    expect(written().createdAt).toBe(written().updatedAt);
    expect(result).toEqual(written());
  });

  it('logs a write failure that rejected with something other than an Error', async () => {
    // Firestore is not the only thing that can reject here, and a rejection that
    // is not an `Error` must still reach the log with a readable value rather than
    // "[object Object]" — the log line is the only trace a failed write leaves.
    mockPlanSet.mockRejectedValue('quota exhausted');

    const result = await run({ recipeId: 'recipe-1' });

    expect(result.prep).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith(
      'generateGuidedPlan: failed to persist the plan',
      expect.objectContaining({ error: 'quota exhausted' }),
    );
  });

  it('logs a read failure that rejected with something other than an Error', async () => {
    mockPlanGet.mockRejectedValue('quota exhausted');

    await run({ recipeId: 'recipe-1' });

    expect(logged).toHaveBeenCalledWith(
      'generateGuidedPlan: failed to read the existing plan',
      expect.objectContaining({ error: 'quota exhausted' }),
    );
  });

  it('writes nothing when the model output is unusable', async () => {
    mockGenerate.mockResolvedValue({ output: { prep: 'not a list' } });
    await expect(run({ recipeId: 'recipe-1' })).rejects.toThrow(/invalid output/);
    expect(mockPlanSet).not.toHaveBeenCalled();
  });

  it('writes nothing when the recipe does not exist', async () => {
    mockGet.mockResolvedValue({ exists: false, data: () => undefined });
    await expect(run({ recipeId: 'nope' })).rejects.toThrow();
    expect(mockPlanSet).not.toHaveBeenCalled();
  });
});
