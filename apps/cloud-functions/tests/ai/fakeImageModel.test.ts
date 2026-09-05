import { describe, it, expect, vi, afterEach } from 'vitest';

// aiFakeEnabled lives in fakeModel.ts, which ALSO registers a fake per AiFlowId
// at module load when the flag is on. Mocking the whole module (rather than just
// importing the real one) keeps that unrelated seam's side effects out of these
// assertions — this suite is about fakeImageModel.ts's own wiring only.
vi.mock('../../src/ai/fakeModel.js', () => ({
  aiFakeEnabled: () => process.env['FUNCTIONS_AI_FAKE'] === '1',
}));

vi.mock('@genkit-ai/google-genai', () => ({
  googleAI: { model: (name: string) => name },
}));

const mockDefineModel = vi.fn((_config: unknown, handler: unknown) => handler);
vi.mock('../../src/genkit.js', () => ({ ai: { defineModel: mockDefineModel } }));

const SEED = { url: 'data:image/webp;base64,AAAA', contentType: 'image/webp' } as const;
vi.mock('../../src/flows/assets/canonIconSeed.js', () => ({
  loadCanonIconSeed: () => SEED,
}));

const mockResolveModel = vi.fn(async (flowId: string) => `resolved-${flowId}`);
vi.mock('../../src/ai/resolveModel.js', () => ({ resolveModel: mockResolveModel }));

const ORIGINAL_FLAG = process.env['FUNCTIONS_AI_FAKE'];

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env['FUNCTIONS_AI_FAKE'];
  else process.env['FUNCTIONS_AI_FAKE'] = ORIGINAL_FLAG;
  vi.clearAllMocks();
});

describe('imageFlowModel — flag OFF (production, and emulator without the flag)', () => {
  it('returns googleAI.model(await resolveModel(flowId)) — the unchanged production path', async () => {
    delete process.env['FUNCTIONS_AI_FAKE'];
    vi.resetModules();
    const { imageFlowModel } = await import('../../src/ai/fakeImageModel.js');

    const model = await imageFlowModel('generateEquipmentIcon' as never);

    expect(mockResolveModel).toHaveBeenCalledWith('generateEquipmentIcon');
    expect(model).toBe('resolved-generateEquipmentIcon');
    expect(mockDefineModel).not.toHaveBeenCalled();
  });
});

describe('imageFlowModel — flag ON (e2e fake)', () => {
  it('registers exactly one fake image model at load, shared across every flow', async () => {
    process.env['FUNCTIONS_AI_FAKE'] = '1';
    vi.resetModules();
    const { imageFlowModel } = await import('../../src/ai/fakeImageModel.js');

    expect(mockDefineModel).toHaveBeenCalledTimes(1);
    expect(mockDefineModel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'e2e-fake/image' }),
      expect.any(Function),
    );

    const forCanon = await imageFlowModel('generateCanonIcon' as never);
    const forEquipment = await imageFlowModel('generateEquipmentIcon' as never);

    // Same shared instance for every flow — there is nothing to key on (issue
    // #1193): the canned image and behaviour never vary by flow or input.
    expect(forCanon).toBe(forEquipment);
    expect(mockResolveModel).not.toHaveBeenCalled();
  });

  it('the registered model returns the committed seed image as a media part', async () => {
    process.env['FUNCTIONS_AI_FAKE'] = '1';
    vi.resetModules();
    await import('../../src/ai/fakeImageModel.js');

    const [, handler] = mockDefineModel.mock.calls[0]!;
    const result = await (handler as () => Promise<unknown>)();

    expect(result).toEqual({
      finishReason: 'stop',
      message: {
        role: 'model',
        content: [{ media: { url: SEED.url, contentType: SEED.contentType } }],
      },
    });
  });
});
