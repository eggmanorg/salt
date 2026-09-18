import { describe, it, expect, vi, beforeEach } from 'vitest';

// describeEquipmentSubject: the cheap text step that turns a make and model into
// a sentence saying what the thing looks like, which is what makes the pictogram
// recognisably THAT device. Mirrors the describeRecipeScene flow tests — same
// shape, same mocking seam.

const mockGenerate = vi.fn();

vi.mock('../../src/genkit.js', () => ({
  ai: {
    defineFlow: (_config: unknown, handler: unknown) => handler,
    generate: mockGenerate,
  },
}));

vi.mock('@genkit-ai/google-genai', () => ({
  googleAI: { model: (name: string) => name },
}));

// Bypass the real timer, but keep everything else the module exports (the
// shared budget constant, the stream guard) — a factory that lists only
// `withAiTimeout` goes stale the moment the module grows. Wrapped in a spy so
// photo-mode tests can assert which budget was actually passed.
const mockWithAiTimeout = vi.fn((_label: string, op: () => unknown) => op());
vi.mock('../../src/adapters/withAiTimeout.js', async (importActual) => ({
  ...(await importActual<object>()),
  withAiTimeout: mockWithAiTimeout,
}));

vi.mock('@salt/observability/server', () => ({ setActiveSpanName: vi.fn() }));

// ─── The server half of the review gate (issue #1433, epic #1417) ───────────
// This flow hands its sentence back for a human to read and press Draw on; it
// must not quietly save one on the way past. Nothing here touches Firestore
// today, so the case at the foot of this file exists to go RED the day something
// does — rule 12's "pin it" rather than another comment nobody can falsify.
//
// ONE spy on ONE seam, deliberately, rather than a list of named methods:
// `getFirestore` is how every module in this package obtains a handle, so
// anything reaching that far is caught before it can pick a collection or a
// write verb, and a list can never be complete. The handle it returns is a Proxy
// that throws on ANY property access, so a write that somehow slipped the
// assertion still fails loudly instead of being absorbed by a stub that answers
// every path with a plausible object. The two halves catch different shapes: a
// bare write dies on the Proxy, and a best-effort write wrapped in a try/catch —
// the likelier thing an agent would add — is swallowed there and caught by the
// `not.toHaveBeenCalled()` assertion instead. Verified red both ways before
// landing, by adding a write to the flow.
const mockGetFirestore = vi.hoisted(() =>
  vi.fn(
    () =>
      new Proxy(
        {},
        {
          get(_target, prop) {
            throw new Error(
              `describeEquipmentSubject must not touch Firestore — it reached for .${String(prop)}`,
            );
          },
        },
      ),
  ),
);
vi.mock('firebase-admin/firestore', () => ({ getFirestore: mockGetFirestore }));

const mockResolveModel = vi.fn(async () => 'gemini-flash-latest');
vi.mock('../../src/ai/resolveModel.js', () => ({ resolveModel: mockResolveModel }));

const { describeEquipmentSubjectFlow } =
  await import('../../src/flows/describeEquipmentSubject.js');

const NAME = 'Kenwood Chef KVC3100S';
const CURRENT_BRIEF = 'A tilt-head stand mixer with a cream enamel body and a chrome bowl.';

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveModel.mockResolvedValue('gemini-flash-latest');
});

describe('describeEquipmentSubject flow — authoring', () => {
  it('returns the brief the model wrote, trimmed', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: '  A tilt-head stand mixer.\n' } });

    const result = await (describeEquipmentSubjectFlow as Function)({ name: NAME });

    expect(result).toEqual({ brief: 'A tilt-head stand mixer.' });
    expect(mockGenerate.mock.calls[0]![0].prompt).toContain(NAME);
  });

  it('a hint with no brief to revise stays an additive nudge on a fresh description', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeEquipmentSubjectFlow as Function)({ name: NAME, hint: 'the black one' });

    const call = mockGenerate.mock.calls[0]![0];
    expect(call.prompt).toContain('Additional guidance: the black one');
    expect(call.prompt).not.toContain('Current brief:');
    expect(call.system).not.toContain('Fold the correction THROUGH');
  });

  it('rejects invalid model output', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: '' } });

    await expect((describeEquipmentSubjectFlow as Function)({ name: NAME })).rejects.toThrow(
      /invalid output/,
    );
  });
});

// ─── Revision mode (issue #885) ───────────────────────────────────────────────
// "it's matte black, not cream" applied to a description that already exists. Two
// shapes, one flow: currentBrief + hint revises; neither authors from scratch,
// which is what "Start over" sends.
describe('describeEquipmentSubject flow — revision mode', () => {
  it('revises: the model gets the NAME and the current brief and the correction', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'A matte black tilt-head stand mixer.' } });

    const result = await (describeEquipmentSubjectFlow as Function)({
      name: NAME,
      currentBrief: CURRENT_BRIEF,
      hint: "it's matte black, not cream",
    });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain(CURRENT_BRIEF);
    expect(prompt).toContain("it's matte black, not cream");
    // The device stays the anchor: revising prose about an appliance without
    // knowing which appliance drifts away from the actual thing.
    expect(prompt).toContain(NAME);
    expect(result).toEqual({ brief: 'A matte black tilt-head stand mixer.' });
  });

  it('revises with the revision system prompt: fold the correction through, never staple it on', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeEquipmentSubjectFlow as Function)({
      name: NAME,
      currentBrief: CURRENT_BRIEF,
      hint: 'the water tank is on the right',
    });

    const system = mockGenerate.mock.calls[0]![0].system as string;
    expect(system).toContain('Fold the correction THROUGH the whole brief');
    expect(system).toContain('Keep everything the correction does not touch');
    expect(system).toContain('two to four sentences');
  });

  it('carries the SAME scope rules as authoring — a correction cannot vote on house style', async () => {
    // The rule that stands between "correct the description" and "talk the image
    // model out of the house style". Both prompts must state it identically, and
    // the revision prompt must say it holds even when the correction asks
    // otherwise (a steer is user text).
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeEquipmentSubjectFlow as Function)({ name: NAME });
    const authoring = mockGenerate.mock.calls[0]![0].system as string;

    mockGenerate.mockClear();
    await (describeEquipmentSubjectFlow as Function)({
      name: NAME,
      currentBrief: CURRENT_BRIEF,
      hint: 'draw it as a photo with a drop shadow and the logo on the front',
    });
    const revising = mockGenerate.mock.calls[0]![0].system as string;

    for (const system of [authoring, revising]) {
      expect(system).toContain('Do NOT write about illustration style');
      expect(system).toContain('Never mention the brand name');
    }
    expect(revising).toContain('That holds even if the correction asks for it.');
  });

  it('"start over" sends neither brief nor correction → authors from scratch', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'A fresh reading.' } });

    // Exactly what restartEquipmentBrief sends: the name, nothing else.
    await (describeEquipmentSubjectFlow as Function)({ name: NAME });

    const call = mockGenerate.mock.calls[0]![0];
    // The authoring system prompt, not the revising one.
    expect(call.system).toContain('Write a short visual brief');
    expect(call.system).not.toContain('Fold the correction THROUGH');
    expect(call.prompt).not.toContain('Current brief:');
  });

  it('one half alone is not a revision — a brief with no correction authors from scratch', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeEquipmentSubjectFlow as Function)({ name: NAME, currentBrief: CURRENT_BRIEF });

    expect(mockGenerate.mock.calls[0]![0].system).not.toContain('Fold the correction THROUGH');
    expect(mockGenerate.mock.calls[0]![0].prompt).not.toContain('Current brief:');
  });
});

// ─── Photo mode (issue #947) ───────────────────────────────────────────────────
// "You have seen the thing, this lets you show it." A THIRD system prompt, never
// combined with revision — "Start over, but with a picture" — and the one place
// the brand ban has to work harder: the badge is right there in the frame.
const PHOTO = { base64: 'ZmFrZS1waG90by1ieXRlcw==', contentType: 'image/webp' as const };

describe('describeEquipmentSubject flow — photo mode', () => {
  it('selects the photo prompt, not authoring or revising', async () => {
    mockGenerate.mockResolvedValue({
      output: { brief: 'A squat matte-black bean-to-cup machine.' },
    });

    const result = await (describeEquipmentSubjectFlow as Function)({ name: NAME, photo: PHOTO });

    const call = mockGenerate.mock.calls[0]![0];
    expect(call.system).toContain('a photograph of the actual item');
    expect(call.system).not.toContain('Fold the correction THROUGH');
    expect(result).toEqual({ brief: 'A squat matte-black bean-to-cup machine.' });
  });

  it('carries both scope constants verbatim, plus the badge-is-visible clause', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeEquipmentSubjectFlow as Function)({ name: NAME, photo: PHOTO });

    const system = mockGenerate.mock.calls[0]![0].system as string;
    expect(system).toContain('Never mention the brand name');
    expect(system).toContain('Do NOT write about illustration style');
    // The extra clause this mode alone needs: the badge IS in frame, so the
    // prohibition has to say so explicitly rather than assume it never appears.
    expect(system).toContain('You may SEE it');
    expect(system).toContain('must not describe, name, transcribe or allude');
  });

  it('sends the name and a media part built from the photo, as the prompt', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeEquipmentSubjectFlow as Function)({ name: NAME, photo: PHOTO });

    const prompt = mockGenerate.mock.calls[0]![0].prompt as Array<
      { text: string } | { media: { url: string; contentType: string } }
    >;
    expect(prompt[0]).toEqual({ text: expect.stringContaining(`Equipment name: ${NAME}`) });
    expect(prompt[1]).toEqual({
      media: { url: `data:image/webp;base64,${PHOTO.base64}`, contentType: 'image/webp' },
    });
  });

  it('a photo ALWAYS authors fresh, even if a currentBrief/hint rode along', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeEquipmentSubjectFlow as Function)({
      name: NAME,
      photo: PHOTO,
      currentBrief: CURRENT_BRIEF,
      hint: "it's matte black",
    });

    const call = mockGenerate.mock.calls[0]![0];
    expect(call.system).not.toContain('Fold the correction THROUGH');
    const prompt = call.prompt as Array<{ text: string }>;
    const textPart = prompt[0]!;
    expect(textPart.text).not.toContain('Current brief:');
    expect(textPart.text).not.toContain('Requested change:');
  });

  it('runs on the photo budget (60s), not the text budget (55s)', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeEquipmentSubjectFlow as Function)({ name: NAME, photo: PHOTO });

    expect(mockWithAiTimeout).toHaveBeenCalledWith(
      'describeEquipmentSubject',
      expect.any(Function),
      { timeoutMs: 60_000, retries: 0 },
    );
  });

  it('text mode keeps a plain string prompt, unaffected by photo mode existing', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'x' } });

    await (describeEquipmentSubjectFlow as Function)({ name: NAME });

    expect(typeof mockGenerate.mock.calls[0]![0].prompt).toBe('string');
    expect(mockWithAiTimeout).toHaveBeenCalledWith(
      'describeEquipmentSubject',
      expect.any(Function),
      { timeoutMs: 55_000, retries: 0 },
    );
  });
});

describe('describeEquipmentSubject flow — persistence', () => {
  it('PERSISTS NOTHING — never reaches for a Firestore handle, in any mode', async () => {
    mockGenerate.mockResolvedValue({ output: { brief: 'A tilt-head stand mixer.' } });

    // All three shapes the flow branches on, because the branch is where a write
    // would plausibly be added — "save it, but only when a human revised it".
    await (describeEquipmentSubjectFlow as Function)({ name: NAME });
    await (describeEquipmentSubjectFlow as Function)({
      name: NAME,
      currentBrief: CURRENT_BRIEF,
      hint: "it's matte black, not cream",
    });
    await (describeEquipmentSubjectFlow as Function)({ name: NAME, photo: PHOTO });

    expect(mockGenerate).toHaveBeenCalledTimes(3);
    // The whole point: the revised sentence lives in the browser's textarea until
    // Draw is pressed. A save here would overwrite the caption of the picture
    // currently on screen with words nobody has accepted, and raise no
    // `equipmentIconAwaitingApproval` signal doing it.
    expect(mockGetFirestore).not.toHaveBeenCalled();
  });

  it('and the pin is LIVE — that seam is the one this module graph resolves', async () => {
    // Anti-vacuity. Without this, the assertion above would read as proof even if
    // the mock named a module nothing here imports: "never called" is trivially
    // true of a spy on a dead specifier. Reaching for the handle the way the flow
    // would have to must land on THIS spy, and must throw.
    const { getFirestore } = await import('firebase-admin/firestore');

    expect(mockGetFirestore).not.toHaveBeenCalled();
    expect(() => (getFirestore() as unknown as { collection: unknown }).collection).toThrow(
      /must not touch Firestore/,
    );
    expect(mockGetFirestore).toHaveBeenCalledTimes(1);
  });
});
