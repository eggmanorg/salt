import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AI_FLOW_ROLES } from '@salt/domain/schemas';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { mockGenerate, mockGet, mockDoc, mockCollection, mockManifestGet, mockFlowModel } =
  vi.hoisted(() => {
    const mockGet = vi.fn();
    const mockDoc = vi.fn(() => ({ get: mockGet }));
    // The equipment manifest is a SECOND read on the same Firestore stub (issue
    // #1281), so the collection has to dispatch — otherwise the manifest read
    // gets handed a recipe and the places section silently disappears.
    const mockManifestGet = vi.fn().mockResolvedValue({ exists: false });
    const mockCollection = vi.fn((name: string) =>
      name === 'equipmentManifest' ? { doc: () => ({ get: mockManifestGet }) } : { doc: mockDoc },
    );
    return {
      mockGenerate: vi.fn(),
      mockGet,
      mockDoc,
      mockCollection,
      mockManifestGet,
      mockFlowModel: vi.fn().mockResolvedValue('gemini-flash-lite-latest'),
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

const { extractProcessStagesFlow, STAGE_KIND_RULES } =
  await import('../../src/flows/extractProcessStages.js');
type Stage = {
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
  optional: boolean;
};
const run = extractProcessStagesFlow as unknown as (input: {
  recipeId: string;
}) => Promise<{ stages: Stage[] }>;

// A real bread shape: the two things the spike got wrong are both in here. The
// method has a preheat AND a bake (which side the oven falls on), and it has a
// single sentence carrying more than one rest (the one extraction swallowed).
const LOAF = {
  id: 'recipe-1',
  schemaVersion: 1,
  kind: 'recipe',
  title: 'Overnight white tin',
  description: 'A slow loaf.',
  ingredients: [],
  steps: [
    { id: 'step-1', text: 'Mix the flour, water, salt and yeast.', timer: null, note: null },
    {
      id: 'step-2',
      text: 'Leave it to bulk ferment.',
      timer: { durationMinutes: 240, description: null },
      note: null,
    },
    { id: 'step-3', text: 'Preheat the oven to 230°C.', timer: null, note: null },
    {
      id: 'step-4',
      text: 'Bake.',
      timer: { durationMinutes: 40, description: null },
      note: null,
    },
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

function stage(overrides: Partial<Stage> = {}): Stage {
  return {
    label: 'Bulk ferment',
    kind: 'wait',
    environment: { temperature: { kind: 'fixed', celsius: 20 }, equipmentId: null },
    duration: { kind: 'fixed', minutes: 240 },
    until: null,
    stepId: 'step-2',
    optional: false,
    ...overrides,
  };
}

const AI_OUTPUT = {
  stages: [
    stage({ label: 'Mix', kind: 'active', environment: null, stepId: 'step-1' }),
    stage(),
    stage({
      label: 'Preheat the oven',
      kind: 'wait',
      environment: { temperature: { kind: 'fixed', celsius: 230 }, equipmentId: null },
      duration: { kind: 'fixed', minutes: 20 },
      stepId: 'step-3',
    }),
    stage({
      label: 'Bake',
      kind: 'active',
      environment: { temperature: { kind: 'fixed', celsius: 230 }, equipmentId: null },
      duration: { kind: 'fixed', minutes: 40 },
      stepId: 'step-4',
    }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFlowModel.mockResolvedValue('gemini-flash-lite-latest');
  mockGet.mockResolvedValue({ exists: true, data: () => LOAF });
  mockManifestGet.mockResolvedValue({ exists: false });
});

describe('extractProcessStages', () => {
  it('reads the recipe server-side by id and returns the stages in order', async () => {
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });

    const result = await run({ recipeId: 'recipe-1' });

    expect(mockCollection).toHaveBeenCalledWith('recipes');
    expect(mockDoc).toHaveBeenCalledWith('recipe-1');
    expect(result.stages.map((s) => s.label)).toEqual([
      'Mix',
      'Bulk ferment',
      'Preheat the oven',
      'Bake',
    ]);
  });

  it('runs on the cheap tier — this is transcription, not judgement', async () => {
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
    await run({ recipeId: 'recipe-1' });
    expect(mockFlowModel).toHaveBeenCalledWith('extractProcessStages');
    expect(AI_FLOW_ROLES.extractProcessStages).toBe('lite');
    // Temperature 0 for the same reason: there is one correct reading of a method,
    // and every degree of creativity is a degree of invented proof.
    expect(mockGenerate.mock.calls[0]![0].config).toEqual({ temperature: 0 });
  });

  it('shows the model each step id and the timer already parsed onto it', async () => {
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
    await run({ recipeId: 'recipe-1' });
    const prompt = String(mockGenerate.mock.calls[0]![0].prompt);
    expect(prompt).toContain('[step-2]');
    expect(prompt).toContain('timer: 240 minutes');
  });
});

/**
 * `packages/domain/src/schemas/process.ts`, found from the workspace root rather
 * than by counting `../` (issue #919). The old `'../../../../packages/domain/…'`
 * was correct only while this test sat exactly four levels down; moving the file
 * one directory would have broken it with an ENOENT that reads like a missing
 * schema rather than like a moved test.
 */
function processSchemaPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('no pnpm-workspace.yaml above this test');
    dir = parent;
  }
  return join(dir, 'packages/domain/src/schemas/process.ts');
}

/**
 * The indented paragraphs of the schema's `active vs wait` block — the definition
 * itself, without the prose around it explaining why it is there. The definition
 * is indented under the block header; the commentary sits flush at `// `.
 */
function activeVsWaitParagraphs(source: string): string[] {
  const block = /─ active vs wait ─[^\n]*\n([\s\S]*?)\nexport const ProcessStageKindSchema/.exec(
    source,
  );
  if (!block) return [];
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of (block[1] as string).split('\n')) {
    const indented = /^\/\/ {3,}(.*)$/.exec(line);
    if (indented) current.push((indented[1] as string).trim());
    else if (current.length > 0) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs;
}

describe('extractProcessStages — which side the oven falls on', () => {
  // THE SPIKE'S HEADLINE DEFECT. The bake came back labelled differently on each of
  // three bread recipes because nothing anywhere said whether an oven is attended.
  // The fix is a definition that exists exactly once and is quoted, not paraphrased.

  it('states the rule in the prompt, verbatim, with the bake pinned', async () => {
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
    await run({ recipeId: 'recipe-1' });
    const system = String(mockGenerate.mock.calls[0]![0].system);
    expect(system).toContain(STAGE_KIND_RULES);
    expect(system).toContain('THE BAKE IS `active`. THE PREHEAT IS `wait`.');
  });

  it('says the same thing as the schema the stages are stored under', async () => {
    // The drift guard. The definition lives in ProcessStageKindSchema's field docs
    // AND in this prompt; a change to one that is not made to the other is exactly
    // how the bake starts moving between recipes again.
    //
    // ─── Read from the schema, not remembered here (issue #919) ───────────────
    // This used to hold the three sentences VERBATIM — ~40 words each — which made
    // the test a THIRD copy of a definition whose whole point is to exist exactly
    // once. Three copies drift faster than two, and the third was the one nobody
    // would think to look at. It now reads the paragraphs OUT of the schema and
    // requires the prompt to contain each, so the schema stays the single source
    // and an edit reaching only one of the two goes red on the words that moved.
    const definition = activeVsWaitParagraphs(readFileSync(processSchemaPath(), 'utf8'));

    // Anti-vacuity: an extractor that stopped finding the block would make the
    // loop below iterate over nothing and pass in silence — the exact failure the
    // rewrite removes, reintroduced by the back door.
    expect(
      definition.length,
      'the `active vs wait` block was not found in the schema — this guard is reading nothing',
    ).toBe(3);

    // Comment prefixes, line wrapping and which words are SHOUTED differ between a
    // code comment and a prompt; the words themselves must not.
    const flatten = (text: string) =>
      text
        .replace(/^\s*\/\/ ?/gm, '')
        .replace(/\s+/g, ' ')
        .toUpperCase();
    const promptText = flatten(STAGE_KIND_RULES);

    for (const paragraph of definition) {
      expect(promptText).toContain(flatten(paragraph));
    }
  });
});

describe('extractProcessStages — a recipe with nothing to wait for', () => {
  it('returns nothing rather than inventing a proof', async () => {
    // Enforced in code, not merely asked for in the prompt: a model told to list
    // stages will always find some, and the difference between "this has no
    // process" and a confidently invented rise is the whole feature. The actives
    // are only worth returning as the gaps BETWEEN waits.
    mockGenerate.mockResolvedValue({
      output: {
        stages: [
          stage({ label: 'Mix', kind: 'active', stepId: 'step-1' }),
          stage({ label: 'Bake', kind: 'active', stepId: 'step-4' }),
        ],
      },
    });

    const result = await run({ recipeId: 'recipe-1' });

    expect(result.stages).toEqual([]);
  });

  it('tells the model so as well', async () => {
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
    await run({ recipeId: 'recipe-1' });
    const system = String(mockGenerate.mock.calls[0]![0].system);
    expect(system).toContain('NEVER invent a proof');
  });
});

describe('extractProcessStages — a step the recipe itself calls optional (issue #1275)', () => {
  it('tells the model what optional means, and that nothing else qualifies', async () => {
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
    await run({ recipeId: 'recipe-1' });
    const system = String(mockGenerate.mock.calls[0]![0].system);
    // The rule is the method's OWN words, not the model's judgement about what
    // sounds inessential — the same posture as the `active`/`wait` rule, which
    // exists because the spike was inconsistent without one.
    expect(system).toContain('the method itself says the step may be left out');
    expect(system).toContain('Anything else is false');
  });

  it('carries the mark back on the stage the model marked', async () => {
    mockGenerate.mockResolvedValue({
      output: {
        stages: [
          stage(),
          stage({ label: 'Brush with milk', kind: 'active', stepId: 'step-3', optional: true }),
        ],
      },
    });

    const result = await run({ recipeId: 'recipe-1' });

    expect(result.stages.map((s) => s.optional)).toEqual([false, true]);
  });

  it('reads a stage the model left the field off as not optional', async () => {
    // The schema's read default doing its job on the AI boundary as well as the
    // Firestore one: a model that omits the key must not fail the whole extraction.
    const { optional: _optional, ...withoutTheField } = stage();
    mockGenerate.mockResolvedValue({ output: { stages: [withoutTheField] } });

    const result = await run({ recipeId: 'recipe-1' });

    expect(result.stages[0]!.optional).toBe(false);
  });
});

describe('extractProcessStages — hallucinated step ids', () => {
  it('drops the citation, not the stage', async () => {
    // Deliberately GENTLER than generateGuidedPlan, which drops the whole note: a
    // note IS an annotation on a step and is nothing without one, whereas `stepId`
    // is an optional one-way back-reference and a bulk ferment is still a bulk
    // ferment without it. Losing a real wait to a mistyped id is the loss this
    // feature exists to prevent.
    mockGenerate.mockResolvedValue({
      output: { stages: [stage({ stepId: 'step-99' })] },
    });

    const result = await run({ recipeId: 'recipe-1' });

    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.label).toBe('Bulk ferment');
    expect(result.stages[0]!.stepId).toBeNull();
  });

  it('leaves a real step id alone', async () => {
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });
    const result = await run({ recipeId: 'recipe-1' });
    expect(result.stages.map((s) => s.stepId)).toEqual(['step-1', 'step-2', 'step-3', 'step-4']);
  });
});

describe('extractProcessStages — the trust boundaries', () => {
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
    mockGenerate.mockResolvedValue({ output: { stages: 'not a list' } });
    await expect(run({ recipeId: 'recipe-1' })).rejects.toThrow(/invalid output/);
  });
});

// ─── Places (issue #1281) ─────────────────────────────────────────────────────

const PROOFER = {
  id: 'eq-proofer',
  schemaVersion: 1 as const,
  name: 'Dough proofer',
  accessories: [],
  rules: [],
  environment: {
    control: 'dedicated' as const,
    minCelsius: 20,
    maxCelsius: 50,
    humidity: null,
    standing: null,
  },
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const KNIFE = {
  id: 'eq-knife',
  schemaVersion: 1 as const,
  name: 'Sharp knife',
  accessories: [],
  rules: [],
  environment: null,
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function seedManifest(items: unknown[]): void {
  mockManifestGet.mockResolvedValue({
    exists: true,
    data: () => ({ schemaVersion: 1, updatedAt: '2026-09-01T00:00:00.000Z', items }),
  });
}

function systemPrompt(): string {
  return (mockGenerate.mock.calls[0]![0] as { system: string }).system;
}

describe('extractProcessStages — the household places', () => {
  it('shows the places it owns, with their ids, and never the kit that is not one', async () => {
    seedManifest([PROOFER, KNIFE]);
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });

    await run({ recipeId: 'recipe-1' });

    const system = systemPrompt();
    expect(system).toContain('[eq-proofer] Dough proofer');
    expect(system).toContain('holds a temperature: 20–50 °C');
    expect(system).not.toContain('Sharp knife');
    // The counter must stay reachable as an answer, or every prove gets a chamber.
    expect(system).toContain('names NO place');
  });

  it('leaves the prompt byte-for-byte as it was when no place is described', async () => {
    // A household that has described nothing gets exactly today's behaviour.
    seedManifest([KNIFE]);
    mockGenerate.mockResolvedValue({ output: AI_OUTPUT });

    await run({ recipeId: 'recipe-1' });

    const system = systemPrompt();
    expect(system).not.toContain('Places this household can put something');
    // The stage instructions themselves are untouched — it is the whole section
    // that is absent, not a sentence inside it.
    expect(system).toContain(STAGE_KIND_RULES);
  });

  it('keeps a place the manifest actually has', async () => {
    seedManifest([PROOFER]);
    mockGenerate.mockResolvedValue({
      output: {
        stages: [
          stage({
            environment: {
              temperature: { kind: 'range', minCelsius: 22, maxCelsius: 26 },
              equipmentId: 'eq-proofer',
            },
          }),
        ],
      },
    });

    const result = await run({ recipeId: 'recipe-1' });

    expect(result.stages[0]!.environment).toEqual({
      temperature: { kind: 'range', minCelsius: 22, maxCelsius: 26 },
      equipmentId: 'eq-proofer',
    });
  });

  it('drops an invented place, and keeps the stage and its temperature', async () => {
    // Same treatment as a hallucinated `stepId`: the reference goes, the stage
    // stays. Throwing away a real wait because the model mistyped an id is the
    // loss this feature exists to prevent.
    seedManifest([PROOFER]);
    mockGenerate.mockResolvedValue({
      output: {
        stages: [
          stage({
            environment: {
              temperature: { kind: 'fixed', celsius: 24 },
              equipmentId: 'eq-does-not-exist',
            },
          }),
        ],
      },
    });

    const result = await run({ recipeId: 'recipe-1' });

    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]!.environment).toEqual({
      temperature: { kind: 'fixed', celsius: 24 },
      equipmentId: null,
    });
  });

  it('drops an id naming equipment that is not a place', async () => {
    seedManifest([PROOFER, KNIFE]);
    mockGenerate.mockResolvedValue({
      output: {
        stages: [
          stage({
            environment: {
              temperature: { kind: 'fixed', celsius: 24 },
              equipmentId: 'eq-knife',
            },
          }),
        ],
      },
    });

    const result = await run({ recipeId: 'recipe-1' });

    expect(result.stages[0]!.environment!.equipmentId).toBeNull();
  });
});
