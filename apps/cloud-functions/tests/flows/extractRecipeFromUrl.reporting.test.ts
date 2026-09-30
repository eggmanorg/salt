import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 3: the extractRecipeFromUrl onCall callable reports the GENUINE cause of
// a failure (raw error/stack, never the HttpsError envelope) before mapping to a
// user-facing HttpsError — but only for the UNEXPECTED failures:
//   • a non-UrlImportError throw (a bug)            → REPORT
//   • UrlImportError code 'ai-failed' (model failed)→ REPORT
//   • every other UrlImportError code (invalid/blocked/unreachable/not-a-recipe)
//     is an EXPECTED user outcome                    → SUPPRESS (do not report)
// The user-facing HttpsError mapping is unchanged in all cases.

// ─── Spy on the server error reporter + flush ─────────────────────────────────
const mockReport = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);

vi.mock('@salt/observability/server', () => ({
  initServerObservability: vi.fn(),
  runWithExtractedTraceContext: vi.fn((_h: unknown, fn: () => unknown) => fn()),
  runWithSuppliedTraceContext: vi.fn((_tp: unknown, fn: () => unknown) => fn()),
  attachAiOtlpSpanProcessor: vi.fn(),
  attachDistributedSpanProcessor: vi.fn(),
  createServerObservabilityErrorReportingAdapter: vi.fn(() => ({ report: mockReport })),
  flushServerObservability: mockFlush,
}));

// ─── Stub everything index.ts imports so module load is cheap & inert ─────────
class FakeHttpsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
vi.mock('firebase-functions/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  onCallGenkit: (_opts: unknown, _flow: unknown) => () => undefined,
  isSignedIn: () => ({}),
  HttpsError: FakeHttpsError,
}));
vi.mock('firebase-admin/app', () => ({ initializeApp: vi.fn() }));
vi.mock('firebase-functions/v2', () => ({ setGlobalOptions: vi.fn() }));
vi.mock('firebase-functions/params', () => ({ defineSecret: (name: string) => ({ name }) }));
vi.mock('@genkit-ai/firebase', () => ({ enableFirebaseTelemetry: vi.fn(async () => {}) }));
vi.mock('../../src/genkitTracing.js', () => ({ registerGenkitDevTracing: vi.fn() }));

// The flow under test — stubbed so we drive its outcome from the test.
const extractRecipeFromUrlFlow = vi.fn();
// Real UrlImportError shape (code + name) so the index.ts `instanceof` branch works.
class UrlImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UrlImportError';
  }
}
vi.mock('../../src/flows/extractRecipeFromUrl.js', () => ({
  extractRecipeFromUrlFlow,
  UrlImportError,
}));

// Remaining modules index.ts pulls in only to register functions.
vi.mock('../../src/flows/embedText.js', () => ({ embedTextFlow: vi.fn() }));
vi.mock('../../src/flows/arbitrateCanon.js', () => ({ arbitrateCanonFlow: vi.fn() }));
vi.mock('../../src/flows/matchOrCreateCanon.js', () => ({ matchOrCreateCanonFlow: vi.fn() }));
vi.mock('../../src/flows/canonicaliseRecipeIngredients.js', () => ({
  canonicaliseRecipeIngredientsFlow: vi.fn(),
}));
vi.mock('../../src/flows/identifyEquipment.js', () => ({ identifyEquipmentFlow: vi.fn() }));
vi.mock('../../src/flows/populateEquipmentEntry.js', () => ({
  populateEquipmentEntryFlow: vi.fn(),
}));
vi.mock('../../src/flows/parseRecipeIngredients.js', () => ({
  parseRecipeIngredientsFlow: vi.fn(),
}));
vi.mock('../../src/flows/chefChat.js', () => ({ chefChatFlow: vi.fn() }));
vi.mock('../../src/flows/authorRecipe.js', () => ({ authorRecipeFlow: vi.fn() }));
vi.mock('../../src/flows/generateChatTitle.js', () => ({ generateChatTitleFlow: vi.fn() }));
vi.mock('../../src/triggers/onShoppingListItemWrite.js', () => ({
  onShoppingListItemWrite: vi.fn(),
}));
vi.mock('../../src/triggers/onCanonItemWritten.js', () => ({ onCanonItemWritten: vi.fn() }));
vi.mock('../../src/ai/listAiModels.js', () => ({ handleListAiModels: vi.fn() }));
vi.mock('../../src/ai/testModel.js', () => ({ handleTestModel: vi.fn() }));
vi.mock('../../src/callables/regenerateCanonIcon.js', () => ({ regenerateCanonIcon: vi.fn() }));
vi.mock('../../src/auth/beforeMemberCreated.js', () => ({ beforeMemberCreated: vi.fn() }));

const { extractRecipeFromUrl } = await import('../../src/index.js');

const invoke = (data: Record<string, unknown>) =>
  (extractRecipeFromUrl as unknown as Function)({ auth: { uid: 'u1' }, data });

const VALID = { url: 'https://example.com/recipe' };

beforeEach(() => {
  vi.clearAllMocks();
  mockFlush.mockResolvedValue(undefined);
});

describe('extractRecipeFromUrl callable — selective failure reporting', () => {
  it('reports an UNEXPECTED (non-UrlImportError) cause, then maps to HttpsError', async () => {
    const bug = new Error('unexpected null deref in assembleDraft');
    extractRecipeFromUrlFlow.mockRejectedValue(bug);

    await expect(invoke(VALID)).rejects.toBeInstanceOf(FakeHttpsError);

    // The raw cause is reported (uncategorised), not the HttpsError envelope.
    expect(mockReport).toHaveBeenCalledWith(bug, undefined);
    expect(mockFlush).toHaveBeenCalled();
    // The reported arg is the genuine cause, not a FakeHttpsError.
    expect(mockReport.mock.calls[0]![0]).toBe(bug);
    expect(mockReport.mock.calls[0]![0]).not.toBeInstanceOf(FakeHttpsError);
  });

  it("reports a UrlImportError with code 'ai-failed' (the model itself failed)", async () => {
    const aiFail = new UrlImportError('ai-failed', 'model could not read the page');
    extractRecipeFromUrlFlow.mockRejectedValue(aiFail);

    await expect(invoke(VALID)).rejects.toBeInstanceOf(FakeHttpsError);

    expect(mockReport).toHaveBeenCalledWith(aiFail, undefined);
  });

  it.each([
    'invalid-url',
    'blocked-url',
    'fetch-failed',
    'not-a-recipe',
    'video-unavailable',
    'video-too-long',
  ])("does NOT report the EXPECTED UrlImportError code '%s' (suppressed)", async (code) => {
    extractRecipeFromUrlFlow.mockRejectedValue(new UrlImportError(code, 'expected outcome'));

    await expect(invoke(VALID)).rejects.toBeInstanceOf(FakeHttpsError);

    // Expected user outcomes are suppressed — only the mapped HttpsError
    // reaches the client; nothing is sent to PostHog error tracking.
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('does not report on the success path', async () => {
    extractRecipeFromUrlFlow.mockResolvedValue({ id: 'r1', title: 'Soup' });

    await invoke(VALID);

    expect(mockReport).not.toHaveBeenCalled();
  });
});
