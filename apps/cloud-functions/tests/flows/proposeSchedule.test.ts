import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AI_FLOW_ROLES } from '@salt/domain/schemas';

const { mockGenerate, mockGet, mockDoc, mockCollection, mockFlowModel, aiTimeoutOptions } =
  vi.hoisted(() => {
    const mockGet = vi.fn();
    // Typed, not inferred: the suite asserts on WHICH collection and document
    // ids the flow asked for, and an inferred zero-argument mock records every
    // call as an empty tuple (#1135).
    const mockDoc = vi.fn<(id: string) => { get: typeof mockGet }>(() => ({ get: mockGet }));
    const mockCollection = vi.fn<(name: string) => { doc: typeof mockDoc }>(() => ({
      doc: mockDoc,
    }));
    return {
      mockGenerate: vi.fn(),
      mockGet,
      mockDoc,
      mockCollection,
      mockFlowModel: vi.fn().mockResolvedValue('gemini-pro-latest'),
      // Captured rather than ignored: the three deadlines nesting correctly (AI <
      // client < function) is the whole reason they live in one place, so the suite
      // has to be able to see which one this flow asked for.
      aiTimeoutOptions: {
        value: undefined as { timeoutMs?: number; retries?: number } | undefined,
      },
    };
  });

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: mockGenerate,
  },
}));

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({ collection: mockCollection }),
}));

// Stub withAiTimeout to call op() directly — timeout/retry behaviour is tested
// elsewhere — but record the options it was handed.
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (
    _label: string,
    op: () => unknown,
    options?: { timeoutMs?: number; retries?: number },
  ) => {
    aiTimeoutOptions.value = options;
    return op();
  },
}));

vi.mock('../../src/ai/fakeModel.js', () => ({
  flowModel: mockFlowModel,
}));

const { proposeScheduleFlow } = await import('../../src/flows/proposeSchedule.js');
const { STAGE_KIND_RULES } = await import('../../src/flows/extractProcessStages.js');
const {
  PROPOSE_SCHEDULE_AI_TIMEOUT_MS,
  PROPOSE_SCHEDULE_CLIENT_TIMEOUT_MS,
  PROPOSE_SCHEDULE_TIMEOUT_SECONDS,
} = await import('@salt/domain/schemas');

type ProposedStage = {
  label: string;
  kind: 'active' | 'wait';
  environment: {
    temperature:
      | { kind: 'fixed'; celsius: number }
      | { kind: 'range'; minCelsius: number; maxCelsius: number };
    equipmentId: string | null;
  } | null;
  duration: { kind: 'fixed'; minutes: number } | null;
  until: string | null;
  stepId: string | null;
  sourceStageId: string | null;
};
type Output = {
  stages: ProposedStage[];
  rationale: string;
  adjustment: { ingredientId: string; factor: number; reason: string } | null;
};
const run = proposeScheduleFlow as unknown as (input: {
  recipeId: string;
  targetEndAtLocal: string;
  quietHours?: { fromHour: number; toHour: number };
  ambientCelsius?: number | null;
}) => Promise<Output>;

// The household's places (issue #1286). The proofer is `dedicated`, the curing
// chamber `shared` with a standing setting — both shapes render, and the knife
// block is not a place at all.
const PROOFER = {
  id: 'eq-proofer',
  schemaVersion: 1,
  name: 'Dough proofer',
  accessories: [],
  rules: [],
  environment: {
    control: 'dedicated',
    minCelsius: 20,
    maxCelsius: 40,
    humidity: null,
    standing: null,
  },
  updatedAt: '2026-08-01T09:00:00.000Z',
};

const KNIFE_BLOCK = {
  id: 'eq-knives',
  schemaVersion: 1,
  name: 'Knife block',
  accessories: [],
  rules: [],
  environment: null,
  updatedAt: '2026-08-01T09:00:00.000Z',
};

function manifest(items: unknown[]) {
  return { schemaVersion: 1, updatedAt: '2026-08-01T09:00:00.000Z', items };
}

const LOAF_RECIPE = {
  id: 'recipe-1',
  schemaVersion: 1,
  kind: 'recipe',
  title: 'Overnight white tin',
  description: 'A slow loaf.',
  ingredients: [
    {
      id: 'group-1',
      name: null,
      items: [
        {
          id: 'ing-flour',
          rawText: 'Strong white flour',
          parsed: null,
          canonId: null,
          matchState: 'pending',
          isOptional: false,
          firstUsedInStepId: null,
        },
        {
          id: 'ing-yeast',
          rawText: 'Instant yeast',
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
    { id: 'step-1', text: 'Mix the flour, water, salt and yeast.', timer: null, note: null },
    { id: 'step-2', text: 'Leave it to bulk ferment.', timer: null, note: null },
    { id: 'step-3', text: 'Bake.', timer: null, note: null },
  ],
  metadata: {
    servings: 1,
    tags: [],
  },
  source: null,
  notes: null,
  image: null,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
};

const LOAF_FORMULA = {
  recipeId: 'recipe-1',
  components: [
    { ingredientId: 'ing-flour', percent: 100, inBasis: true },
    { ingredientId: 'ing-yeast', percent: 1.2, inBasis: false },
  ],
  referenceYield: { kind: 'basis', grams: 500 },
  schemaVersion: 1,
  process: [
    {
      id: 'stage-mix',
      label: 'Mix',
      kind: 'active',
      environment: null,
      duration: { kind: 'fixed', minutes: 20 },
      until: null,
      stepId: 'step-1',
    },
    {
      id: 'stage-bulk',
      label: 'Bulk ferment',
      kind: 'wait',
      environment: { temperature: { kind: 'fixed', celsius: 20 }, equipmentId: null },
      duration: { kind: 'fixed', minutes: 90 },
      until: 'until doubled',
      stepId: 'step-2',
    },
    {
      id: 'stage-bake',
      label: 'Bake',
      kind: 'active',
      environment: { temperature: { kind: 'fixed', celsius: 230 }, equipmentId: null },
      duration: { kind: 'fixed', minutes: 45 },
      until: null,
      stepId: 'step-3',
    },
  ],
};

function proposedStage(overrides: Partial<ProposedStage> = {}): ProposedStage {
  return {
    label: 'Bulk ferment',
    kind: 'wait',
    environment: { temperature: { kind: 'fixed', celsius: 20 }, equipmentId: null },
    duration: { kind: 'fixed', minutes: 90 },
    until: null,
    stepId: 'step-2',
    sourceStageId: 'stage-bulk',
    ...overrides,
  };
}

const AI_OUTPUT: Output = {
  stages: [
    proposedStage({ label: 'Mix', kind: 'active', stepId: 'step-1', sourceStageId: 'stage-mix' }),
    proposedStage({ label: 'Bulk ferment, counter', duration: { kind: 'fixed', minutes: 20 } }),
    proposedStage({
      label: 'Cold retard',
      environment: { temperature: { kind: 'fixed', celsius: 4 }, equipmentId: null },
      duration: { kind: 'fixed', minutes: 480 },
      stepId: null,
      sourceStageId: null,
    }),
    proposedStage({ label: 'Bake', kind: 'active', stepId: 'step-3', sourceStageId: 'stage-bake' }),
  ],
  rationale: 'The retard is long because you want the bake at 07:30.',
  adjustment: {
    ingredientId: 'ing-yeast',
    factor: 0.66,
    reason: 'Eight hours in the fridge does the work the yeast was doing.',
  },
};

// One `get` per collection, in the order the flow asks for them.
//
// `equipmentManifest` joined the list in #1286. It defaults to ABSENT, so every
// test that does not seed places exercises the degrade-to-nothing path — which is
// the behaviour a household with no chambers gets.
function stubDocs(recipe: unknown, formula: unknown, equipmentManifest: unknown = null): void {
  mockGet.mockImplementation(() => {
    const collection = mockCollection.mock.calls[mockGet.mock.calls.length - 1]?.[0];
    const doc =
      collection === 'formulas'
        ? formula
        : collection === 'equipmentManifest'
          ? equipmentManifest
          : recipe;
    return Promise.resolve({ exists: doc !== null, data: () => doc ?? undefined });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  aiTimeoutOptions.value = undefined;
  mockFlowModel.mockResolvedValue('gemini-pro-latest');
  stubDocs(LOAF_RECIPE, LOAF_FORMULA);
  mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
});

describe('proposeSchedule', () => {
  it('reads the recipe AND its formula server-side, from ids alone', async () => {
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });

    expect(mockCollection.mock.calls.map((c) => c[0])).toEqual([
      'recipes',
      'formulas',
      // The equipment manifest rides in the same round trip (issue #1286).
      'equipmentManifest',
    ]);
    // `formulas/{recipeId}` — one document per recipe, the deterministic id.
    expect(mockDoc.mock.calls.map((c) => c[0])).toEqual(['recipe-1', 'recipe-1', 'current']);
  });

  it('runs on the better tier — this is judgement, not transcription', async () => {
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(mockFlowModel).toHaveBeenCalledWith('proposeSchedule');
    expect(AI_FLOW_ROLES.proposeSchedule).toBe('pro');
  });

  it('caps the thinking budget and warms the temperature', async () => {
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    // The spike: 65–108 s uncapped against 19–31 s capped, at unchanged quality.
    expect(mockGenerate.mock.calls[0]![0].config).toEqual({
      temperature: 0.4,
      thinkingConfig: { thinkingBudget: 4096 },
    });
  });

  it('returns the stages, the rationale and the adjustment', async () => {
    const result = await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(result.stages.map((s) => s.label)).toEqual([
      'Mix',
      'Bulk ferment, counter',
      'Cold retard',
      'Bake',
    ]);
    expect(result.rationale).toContain('07:30');
    expect(result.adjustment).toEqual(AI_OUTPUT.adjustment);
  });
});

describe('proposeSchedule — no timestamps, no grams', () => {
  it('asks for neither, in as many words', async () => {
    // The load-bearing constraint of the whole flow: `resolveSchedule` computes the
    // clock (and lands on the requested minute by construction) and `solveFormula`
    // computes the weights. A model asked for either would only be a second, worse
    // answer to a question already answered exactly.
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    const system = String(mockGenerate.mock.calls[0]![0].system);
    expect(system).toContain('NO CLOCK TIMES');
    expect(system).toContain('NO WEIGHTS');
  });

  it('shows the formula as percentages with labels, and no grams anywhere', async () => {
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    const prompt = String(mockGenerate.mock.calls[0]![0].prompt);
    expect(prompt).toContain('[ing-yeast] Instant yeast — 1.2%');
    expect(prompt).not.toMatch(/\d+\s?g\b/);
  });
});

describe('proposeSchedule — the four things the prompt must say', () => {
  beforeEach(async () => {
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
  });

  it('states the active/wait rule verbatim, with the bake pinned', () => {
    // Quoted from the ONE definition, by importing the constant its sibling flow
    // publishes rather than by paraphrasing it a second time. The spike's headline
    // defect was the bake being labelled differently on each of three recipes.
    const system = String(mockGenerate.mock.calls[0]![0].system);
    expect(system).toContain(STAGE_KIND_RULES);
    expect(system).toContain('THE BAKE IS `active`. THE PREHEAT IS `wait`.');
  });

  it('forbids a stage STARTING inside quiet hours', () => {
    const system = String(mockGenerate.mock.calls[0]![0].system);
    expect(system).toContain("NO STAGE MAY *START* DURING THE HOUSEHOLD'S QUIET HOURS");
  });

  it('sanctions the preheat nesting inside the final proof', () => {
    const system = String(mockGenerate.mock.calls[0]![0].system);
    expect(system).toContain('The preheat MAY sit inside the final proof');
  });

  it('says that declining to restructure is a real answer', () => {
    const system = String(mockGenerate.mock.calls[0]![0].system);
    expect(system).toContain('DOING NOTHING IS A REAL ANSWER');
    expect(system).toContain('RETURN IT UNCHANGED');
  });
});

describe('proposeSchedule — the household constraint', () => {
  it('quotes the hours it was given', async () => {
    await run({
      recipeId: 'recipe-1',
      targetEndAtLocal: '2026-08-15T07:30',
      quietHours: { fromHour: 22, toHour: 7 },
    });
    expect(String(mockGenerate.mock.calls[0]![0].prompt)).toContain('22:00 to 07:00');
  });

  it('falls back to the household default when none is given', async () => {
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    // The spike's own phrasing: nobody is awake between 23:00 and 06:00.
    expect(String(mockGenerate.mock.calls[0]![0].prompt)).toContain('23:00 to 06:00');
  });

  it('gives the target as a wall clock with its weekday, never as an instant', async () => {
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(String(mockGenerate.mock.calls[0]![0].prompt)).toContain(
      'Finished by: Saturday 2026-08-15 at 07:30',
    );
  });

  it('shows the existing process with its stage ids, for the citations', async () => {
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    const prompt = String(mockGenerate.mock.calls[0]![0].prompt);
    expect(prompt).toContain(
      '[stage-bulk] · wait · "Bulk ferment" · 90 min · 20 °C · (until doubled) · step step-2',
    );
  });
});

describe('proposeSchedule — the timeouts cannot drift', () => {
  it('gives the AI call its own budget and no retry', async () => {
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(aiTimeoutOptions.value).toEqual({
      timeoutMs: PROPOSE_SCHEDULE_AI_TIMEOUT_MS,
      retries: 0,
    });
  });

  it('nests the three deadlines: AI budget < client < function', () => {
    // The client's must also exceed the callable SDK's 70 s default, which is the
    // whole reason the wrapper passes one at all.
    expect(PROPOSE_SCHEDULE_AI_TIMEOUT_MS).toBeLessThan(PROPOSE_SCHEDULE_CLIENT_TIMEOUT_MS);
    expect(PROPOSE_SCHEDULE_CLIENT_TIMEOUT_MS).toBeLessThan(
      PROPOSE_SCHEDULE_TIMEOUT_SECONDS * 1000,
    );
    expect(PROPOSE_SCHEDULE_CLIENT_TIMEOUT_MS).toBeGreaterThan(70_000);
  });
});

describe('proposeSchedule — hallucinated ids', () => {
  it('drops a citation to a stage that is not there, not the stage', async () => {
    // The extraction precedent, not the guided-plan one: `sourceStageId` is an
    // optional one-way back-reference and a cold retard is still a cold retard
    // without one. Losing the stage would tear a hole in the middle of the schedule.
    mockGenerate.mockResolvedValue({
      output: { ...AI_OUTPUT, stages: [proposedStage({ sourceStageId: 'stage-99' })] },
    });
    const result = await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.label).toBe('Bulk ferment');
    expect(result.stages[0]!.sourceStageId).toBeNull();
  });

  it('drops a citation to a step that is not there, not the stage', async () => {
    mockGenerate.mockResolvedValue({
      output: { ...AI_OUTPUT, stages: [proposedStage({ stepId: 'step-99' })] },
    });
    const result = await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.stepId).toBeNull();
    expect(result.stages[0]!.sourceStageId).toBe('stage-bulk');
  });

  it('leaves real citations alone', async () => {
    const result = await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(result.stages.map((s) => s.sourceStageId)).toEqual([
      'stage-mix',
      'stage-bulk',
      null,
      'stage-bake',
    ]);
  });

  it('drops an adjustment naming an ingredient the formula does not hold, whole', async () => {
    // Here the GUIDED-PLAN precedent is the right one and extraction's is not: a
    // note is nothing without its step, and a factor is nothing without the
    // component it multiplies — there is no id to null and still have a meaning.
    mockGenerate.mockResolvedValue({
      output: {
        ...AI_OUTPUT,
        adjustment: { ingredientId: 'ing-99', factor: 0.5, reason: 'Less of it.' },
      },
    });
    const result = await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(result.adjustment).toBeNull();
    // The words survive the number.
    expect(result.rationale).toBe(AI_OUTPUT.rationale);
    expect(result.stages).toHaveLength(4);
  });
});

describe('proposeSchedule — the trust boundaries', () => {
  it('throws when the recipe does not exist', async () => {
    stubDocs(null, LOAF_FORMULA);
    await expect(run({ recipeId: 'nope', targetEndAtLocal: '2026-08-15T07:30' })).rejects.toThrow();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('reports the recipe first when both the recipe and its formula are missing', async () => {
    // Behavior Contract clause 5: a recipe that is missing AND has no formula
    // must still report the recipe, not the formula. `requireRecipeFrom` runs
    // before the formula's `.exists` check in the flow body, so this should be
    // `not-found` (the recipe's code) rather than `failed-precondition` (the
    // formula's) — but nothing else in this suite distinguishes the two codes
    // for `proposeSchedule`, so a future edit that reordered the checks would
    // pass every other case here while silently breaking this one.
    stubDocs(null, null);
    await expect(
      run({ recipeId: 'nope', targetEndAtLocal: '2026-08-15T07:30' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('throws when the stored recipe fails validation', async () => {
    // An object, so it reaches RecipeSchema and fails there rather than at
    // `exists` — the same payload the guided-plan and extraction suites use.
    // Its formula is valid, so a `failed-precondition` here can only be the
    // recipe's parse, which is the path this suite otherwise never took.
    stubDocs({ id: 'recipe-1', schemaVersion: 2 }, LOAF_FORMULA);
    await expect(
      run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('throws when the recipe has no formula', async () => {
    stubDocs(LOAF_RECIPE, null);
    await expect(
      run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' }),
    ).rejects.toThrow();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('throws when the stored formula fails validation', async () => {
    stubDocs(LOAF_RECIPE, { recipeId: 'recipe-1', components: 'not a list' });
    await expect(
      run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' }),
    ).rejects.toThrow();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('throws when the formula has no process to reschedule', async () => {
    const { process: _process, ...noProcess } = LOAF_FORMULA;
    stubDocs(LOAF_RECIPE, noProcess);
    await expect(
      run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' }),
    ).rejects.toThrow();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('throws when the model output is not the expected shape', async () => {
    mockGenerate.mockResolvedValue({ output: { stages: 'not a list' } });
    await expect(
      run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' }),
    ).rejects.toThrow(/invalid output/);
  });

  it('throws on an empty proposal — that is a failure, not a decline', async () => {
    // Declining means returning the process as it stands, which diffs to no
    // changes. No stages at all would render as "remove everything", which is never
    // right for a dough that has to be mixed and baked.
    mockGenerate.mockResolvedValue({ output: { ...AI_OUTPUT, stages: [] } });
    await expect(
      run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' }),
    ).rejects.toThrow(/no stages/);
  });
});

describe('proposeSchedule — the kitchen, and the places (issue #1286)', () => {
  it('tells the model how warm the kitchen actually is', async () => {
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30', ambientCelsius: 26 });
    expect(String(mockGenerate.mock.calls[0]![0].prompt)).toContain(
      'Kitchen temperature today: 26 °C',
    );
  });

  it('says nothing about the kitchen when nobody answered, rather than guessing one', async () => {
    // A made-up room temperature is worse than none: the model would reason from
    // it as though somebody had measured it.
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(String(mockGenerate.mock.calls[0]![0].prompt)).not.toContain('Kitchen temperature');

    mockGenerate.mockClear();
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30', ambientCelsius: null });
    expect(String(mockGenerate.mock.calls[0]![0].prompt)).not.toContain('Kitchen temperature');
  });

  it('no longer names an assumed counter and fridge', async () => {
    // The whole point of the places section: the household's own kit, not two
    // appliances the prompt guessed it owns.
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(String(mockGenerate.mock.calls[0]![0].system)).not.toContain('(counter, fridge)');
  });

  it('shows the household its own places, with their ids and their figures', async () => {
    stubDocs(LOAF_RECIPE, LOAF_FORMULA, manifest([PROOFER, KNIFE_BLOCK]));
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });

    const system = String(mockGenerate.mock.calls[0]![0].system);
    expect(system).toContain('Places this household can put something');
    expect(system).toContain('[eq-proofer] Dough proofer');
    expect(system).toContain('holds a temperature: 20–40 °C');
    // A knife block is not somewhere a prove happens.
    expect(system).not.toContain('Knife block');
  });

  it('names the place a stage is already in, rather than showing a bare id', async () => {
    const inProofer = {
      ...LOAF_FORMULA,
      process: LOAF_FORMULA.process.map((stage) =>
        stage.id === 'stage-bulk'
          ? {
              ...stage,
              environment: {
                temperature: { kind: 'fixed', celsius: 24 },
                equipmentId: 'eq-proofer',
              },
            }
          : stage,
      ),
    };
    stubDocs(LOAF_RECIPE, inProofer, manifest([PROOFER]));
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });

    const prompt = String(mockGenerate.mock.calls[0]![0].prompt);
    expect(prompt).toContain('in the Dough proofer');
  });

  it('renders no places section at all for a household that has described none', async () => {
    // Byte-for-byte the prompt it had before this issue — the degrade path, and
    // the one every other test in this file is silently exercising.
    await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    const system = String(mockGenerate.mock.calls[0]![0].system);
    expect(system).not.toContain('Places this household can put something');
  });

  it('survives a corrupt manifest, and simply shows no places', async () => {
    stubDocs(LOAF_RECIPE, LOAF_FORMULA, { schemaVersion: 'not a number' });
    const result = await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(result.stages).toHaveLength(4);
    expect(String(mockGenerate.mock.calls[0]![0].system)).not.toContain(
      'Places this household can put something',
    );
  });

  it('drops an equipmentId the manifest does not hold, and KEEPS the stage', async () => {
    stubDocs(LOAF_RECIPE, LOAF_FORMULA, manifest([PROOFER]));
    mockGenerate.mockResolvedValue({
      output: {
        ...AI_OUTPUT,
        stages: [
          proposedStage({
            label: 'Bulk ferment',
            environment: { temperature: { kind: 'fixed', celsius: 24 }, equipmentId: 'eq-proofer' },
          }),
          proposedStage({
            label: 'Cold retard',
            environment: { temperature: { kind: 'fixed', celsius: 4 }, equipmentId: 'eq-invented' },
          }),
          proposedStage({ label: 'Bake', kind: 'active', environment: null }),
        ],
      },
    });

    const result = await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(result.stages.map((s) => s.label)).toEqual(['Bulk ferment', 'Cold retard', 'Bake']);
    expect(result.stages[0]!.environment!.equipmentId).toBe('eq-proofer');
    // The place goes; the stage stays. Same one-way rule as `sourceStageId`.
    expect(result.stages[1]!.environment!.equipmentId).toBeNull();
    expect(result.stages[1]!.environment!.temperature).toEqual({ kind: 'fixed', celsius: 4 });
    expect(result.stages[2]!.environment).toBeNull();
  });

  it('drops every place when there is no manifest to resolve them against', async () => {
    mockGenerate.mockResolvedValue({
      output: {
        ...AI_OUTPUT,
        stages: [
          proposedStage({
            environment: { temperature: { kind: 'fixed', celsius: 24 }, equipmentId: 'eq-proofer' },
          }),
        ],
      },
    });
    const result = await run({ recipeId: 'recipe-1', targetEndAtLocal: '2026-08-15T07:30' });
    expect(result.stages[0]!.environment!.equipmentId).toBeNull();
  });
});
