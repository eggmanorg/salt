/**
 * Which budget each trigger-only flow actually passes (issue #1418).
 *
 * The companion to `tests/aiBudgetVsFunctionQuota.test.ts`, which pins the
 * relationship between `AI_TRIGGER_FLOW_TIMEOUT` and the quota of the function
 * it is derived from. That relationship is worth nothing if the flows go on
 * taking the callable budget, and this file is what stops them: it is red on the
 * code as it shipped, where both flows passed `AI_TEXT_FLOW_TIMEOUT`.
 *
 * Kept apart from its companion so neither file has to mock the other's world —
 * reading the trigger's registered options needs the Firebase runtime stubbed,
 * running a flow needs Genkit stubbed, and one file wanting both is a wiring
 * diagram rather than a unit (UT-B1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The budget each flow passes, captured per label. Spreading the real module is
// load-bearing: a factory listing only `withAiTimeout` would hand this file its
// own fiction of the constants it is asserting against.
const budgetByLabel = new Map<string, unknown>();
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: (label: string, op: () => unknown, opts: unknown) => {
    budgetByLabel.set(label, opts);
    return op();
  },
}));

const mockGenerate = vi.fn();
vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: mockGenerate,
  },
}));
vi.mock('@genkit-ai/google-genai', () => ({ googleAI: { model: (name: string) => name } }));
vi.mock('../../src/ai/resolveModel.js', () => ({
  resolveModel: vi.fn().mockResolvedValue('gemini-flash-latest'),
}));
// equipmentContext.ts pulls in firebase-functions for its warn logs; the flow
// only uses its pure string half.
vi.mock('firebase-functions', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { AI_TRIGGER_FLOW_TIMEOUT, AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS } =
  await import('../../src/adapters/withAiTimeout.js');
const { identifyRecipeKitFlow } = await import('../../src/flows/identifyRecipeKit.js');
const { estimateRecipeTimesFlow } = await import('../../src/flows/estimateRecipeTimes.js');

beforeEach(() => {
  mockGenerate.mockReset();
  budgetByLabel.clear();
});

/**
 * Every flow whose ONLY host is `onRecipeWritten`. Deliberately not "every flow
 * the trigger calls": `describeRecipeScene` and `generateRecipeImage` are also
 * reachable from a 90s callable, where the callable's quota is the binding one
 * (issue #1418, Open Question 4). Adding a dual-hosted flow to this list without
 * also raising its callable is how this guard would start asserting a falsehood.
 */
const TRIGGER_ONLY_FLOWS = [
  {
    label: 'identifyRecipeKit',
    run: () =>
      identifyRecipeKitFlow({
        title: 'Champ',
        description: null,
        ingredients: ['1kg floury potatoes'],
        steps: [{ id: 's1', text: 'Boil the potatoes until tender.' }],
        equipment: [],
      }),
  },
  {
    label: 'estimateRecipeTimes',
    run: () =>
      estimateRecipeTimesFlow({
        title: 'Champ',
        description: null,
        servings: 4,
        ingredients: ['1kg floury potatoes'],
        steps: [{ text: 'Boil the potatoes until tender.', timerMinutes: 15 }],
      }),
  },
] as const;

describe('trigger-only flows take the trigger budget, not the callable one', () => {
  for (const flow of TRIGGER_ONLY_FLOWS) {
    it(`${flow.label} passes AI_TRIGGER_FLOW_TIMEOUT`, async () => {
      mockGenerate.mockResolvedValue({ output: { kit: [] } });
      await flow.run();
      expect(
        budgetByLabel.get(flow.label),
        `${flow.label}'s only host is onRecipeWritten (${AI_TRIGGER_FUNCTION_TIMEOUT_SECONDS}s), ` +
          `so it must take AI_TRIGGER_FLOW_TIMEOUT. AI_TEXT_FLOW_TIMEOUT is sized and ` +
          `justified for a callable someone is sat watching.`,
      ).toEqual(AI_TRIGGER_FLOW_TIMEOUT);
    });
  }
});
