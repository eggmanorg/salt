/**
 * The callable contract, pinned (issue #928, Phase 3).
 *
 * Thirty `httpsCallable` wrappers across seventeen modules are one ten-line body
 * copied — and nine of those modules sit at **0% lines**. #913's rule bites
 * hardest here: characterisation tests before a behaviour-preserving refactor,
 * wherever the moved code is uncovered. This file is that net, and it is written
 * against the UNREFACTORED wrappers and committed alone, so the commit that
 * collapses them into one helper (Phase 4) is provably a no-op rather than
 * asserted to be one (#941 Track B).
 *
 * ─── What a row pins, and why each half matters ─────────────────────────────
 * Per wrapper: the callable NAME string, the REGION argument, the exact PAYLOAD
 * (with `traceparent` present *and* absent, where the wrapper takes one), the
 * client `timeout` option OR ITS ABSENCE, the success projection, and that a
 * thrown callable error becomes the right `Failure` and never escapes.
 *
 * The payload is compared against a LITERAL rather than against the input
 * object, because the thing most likely to break in a mechanical rewrite is the
 * SHAPE — `{...input, traceparent}` flattened where the wire schema expects a
 * nested field, an argument silently renamed, an optional dropped. Comparing
 * the payload to the very object that produced it would pass on all three.
 *
 * And it is `toStrictEqual`, which is load-bearing rather than fastidious.
 * `toEqual` treats `{force: false, traceparent: undefined}` as equal to
 * `{force: false}` — so the eight wrappers that build their payload with a
 * ternary specifically to keep an absent optional OFF the wire would all pass
 * a rewrite that spread `undefined` in instead. Verified by mutation: replacing
 * `traceparent ? {force, traceparent} : {force}` with `{force, traceparent}` in
 * `weatherCallables.ts` leaves every `toEqual` row green and turns the
 * `toStrictEqual` row red. That distinction is the whole of contract clause 8
 * ("absent means the field is not sent at all, never sent as `undefined`").
 *
 * `httpsCallable`'s ARGUMENT LIST is asserted as a value, not with
 * `toHaveBeenCalledWith`. That is what makes the absence of a `timeout` option
 * a real assertion: `toHaveBeenCalledWith(fns, 'name')` also passes on a call
 * that supplied a third argument. Twelve rows declare a timeout and sixteen
 * declare none, so "two arguments, not three" has to be falsifiable in both
 * directions.
 *
 * ─── What this net does NOT catch, stated rather than implied ───────────────
 * A row with `traced: null` asserts the payload it sends when called the only
 * way it can be called. It does not assert that the wrapper HAS no
 * `traceparent` parameter — if one were added and this table not updated, the
 * row would keep calling without it and keep passing. The barrel guard cannot
 * close that either: `Function.length` does not count optional parameters, so
 * there is nothing to derive the answer from. Nine of the twenty-eight rows
 * carry a traceparent today; adding a tenth means adding its `traced` block
 * here by hand, and no test will remind you.
 *
 * ─── The three deliberate exceptions, asserted as exceptions ────────────────
 * `callRequestEmailOtp` and `callVerifyEmailOtp` THROW rather than returning a
 * `Failure` — `auth.ts` maps them onto the OTP vocabulary, so the raw callable
 * error has to survive the adapter (`emailOtpCallables.ts:4-7`). `callMatchOrCreate`
 * returns the server's own `Result` envelope VERBATIM instead of re-wrapping it
 * (`canonMatching.ts:32`). All three are Rule 10's stated exceptions rather than
 * oversights, so each is pinned as the behaviour it is; a refactor that
 * "corrected" any of them would break `auth.ts` or double-wrap the canon result.
 *
 * ─── Only two module seams are doubled (UT-B1: cap of 5) ────────────────────
 * `firebase/functions` — the SDK boundary this package exists to wrap — and
 * `firebase/app`, which the barrel's subscription half imports. `firebase/
 * firestore` is deliberately NOT mocked: nothing here calls into it, and its
 * module-level import is inert.
 *
 * ─── `navigator.onLine` is stubbed true, deliberately ───────────────────────
 * `classifyCallableError` answers offline BEFORE reading any code
 * (`callableErrors.ts:22-28`), and that ordering is load-bearing and out of
 * scope here. Left undefined, every error row would collapse onto
 * `NetworkError`/`offline` and pin nothing about the mapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetFunctions, mockHttpsCallable, fn } = vi.hoisted(() => {
  // One callable double, re-armed per test. `fn.stream` exists because
  // `streamChefChat` calls it; every other row uses the function itself.
  const fn = Object.assign(vi.fn(), { stream: vi.fn() });
  return {
    fn,
    // The Functions instance is an OPAQUE SENTINEL carrying the region it was
    // built for, so a row can assert that the instance handed to httpsCallable
    // is the one built for FUNCTIONS_REGION — not merely that some instance was.
    mockGetFunctions: vi.fn((_app: unknown, region?: string) => ({ region })),
    mockHttpsCallable: vi.fn(() => fn),
  };
});

vi.mock('firebase/functions', () => ({
  getFunctions: mockGetFunctions,
  httpsCallable: mockHttpsCallable,
}));

vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({})) }));

import { ErrorCode } from '@salt/shared-types';
import {
  PHOTO_IMPORT_TIMEOUT_SECONDS,
  PROPOSE_SCHEDULE_CLIENT_TIMEOUT_MS,
} from '@salt/domain/schemas';
import * as barrel from '../src/index.js';
import { FUNCTIONS_REGION } from '../src/functionsRegion.js';
import { callRequestEmailOtp, callVerifyEmailOtp } from '../src/emailOtpCallables.js';

// The instance `getFunctions(undefined, FUNCTIONS_REGION)` produces. Every row
// asserts httpsCallable received THIS, which is the region assertion.
const REGIONED = { region: FUNCTIONS_REGION };

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

function callableError(code: string): Error {
  return Object.assign(new Error(`callable failed: ${code}`), { code });
}

async function* twoChunks(): AsyncGenerator<string> {
  yield 'Pre';
  yield 'heat.';
}

/** One wrapper's whole observable contract. */
interface Row {
  /** The exported symbol. The table-coverage guard matches the barrel on this. */
  readonly name: string;
  /** The callable name string the wrapper must ask for. */
  readonly callable: string;
  /**
   * The client `timeout` option, or absent for a wrapper that passes none.
   * ABSENCE IS ASSERTED, not merely unasserted: ten of these gain a timeout in
   * Phase 5 and twenty must not.
   */
  readonly timeout?: number;
  /** `res.data` the doubled callable resolves with. */
  readonly data: unknown;
  /** Invoke the wrapper WITHOUT a traceparent. */
  readonly call: () => Promise<unknown>;
  /** The exact payload `call()` must have put on the wire. */
  readonly payload: unknown;
  /** What `call()` must resolve to. */
  readonly ok: unknown;
  /** The same wrapper WITH a traceparent, or null when it takes none. */
  readonly traced: { readonly call: () => Promise<unknown>; readonly payload: unknown } | null;
  /** Callable error code → the value the wrapper must answer with. */
  readonly errors: ReadonlyArray<{ readonly code: string; readonly expected: unknown }>;
  /** `streamChefChat` drives `fn.stream`, not `fn`. */
  readonly stream?: true;
}

// The two mappings every wrapper shares unless it declares otherwise
// (`callableErrors.ts`): a CF 500 is a reportable server fault, and an
// unreachable function is suppressed transient noise.
const SERVER_FAULT = { kind: 'StorageError', reason: 'unavailable' };
const UNREACHABLE = { kind: 'NetworkError', reason: 'transient' };
const SHARED_ERRORS = [
  { code: 'functions/internal', expected: { kind: 'err', error: SERVER_FAULT } },
  { code: 'functions/unavailable', expected: { kind: 'err', error: UNREACHABLE } },
] as const;

// Typed flow inputs are cast rather than built in full. What is under test is
// the WIRE SHAPE the wrapper assembles from whatever it was handed — a domain
// object built field by field would make the payload assertions longer without
// making them stronger, and several of these schemas are large.
const cast = <T>(v: unknown): T => v as T;

const AUTHOR_INPUT = { messages: [{ role: 'user', text: 'a loaf' }] };
const CANONICALISE_INPUT = { recipeId: 'r1', ingredients: ['flour'] };
const MATCH_INPUT = { text: 'plain flour' };
const SCENE_INPUT = { recipeId: 'r1', title: 'Focaccia' };
const URL_INPUT = { url: 'https://example.com/loaf' };
const PHOTO_INPUT = { images: [{ imageBase64: 'B64', contentType: 'image/jpeg' }] };
const STAGES_INPUT = { recipeId: 'r1' };
const PLAN_INPUT = { recipeId: 'r1' };
const SCHEDULE_INPUT = { recipeId: 'r1', finishBy: '2026-01-01T18:00:00.000Z' };
const CHAT_INPUT = { sessionId: 's1', messages: [{ role: 'user', text: 'hi' }] };
const DRAW_INPUT = { itemName: 'Dutch oven', brief: 'a squat pot' };
const DESCRIBE_INPUT = { itemName: 'Dutch oven' };

const CATALOG = { byRole: { text: [], image: [] }, fetchedAt: 1 };
const RECIPE = { id: 'r1', title: 'Focaccia' };
const PROMPT_RESULT = { prompt: 'a loaf, lit softly', model: 'gemini-x', seedFile: null };

const rows: readonly Row[] = [
  {
    name: 'callListAiModels',
    callable: 'listAiModels',
    data: CATALOG,
    call: () => barrel.callListAiModels(),
    payload: { forceRefresh: false },
    ok: { kind: 'ok', value: CATALOG },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callTestModel',
    callable: 'testModel',
    data: { ok: true },
    call: () => barrel.callTestModel('gemini-x'),
    // No `role` key at all, not `role: undefined` — the wrapper's ternary, and
    // the difference between an absent optional and a null one on the wire.
    payload: { model: 'gemini-x' },
    ok: { kind: 'ok', value: { ok: true } },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callAuthorRecipe',
    callable: 'authorRecipe',
    timeout: 120_000,
    data: RECIPE,
    call: () => barrel.callAuthorRecipe(cast(AUTHOR_INPUT)),
    payload: AUTHOR_INPUT,
    ok: { kind: 'ok', value: RECIPE },
    traced: {
      call: () => barrel.callAuthorRecipe(cast(AUTHOR_INPUT), TRACEPARENT),
      payload: { ...AUTHOR_INPUT, traceparent: TRACEPARENT },
    },
    errors: SHARED_ERRORS,
  },
  {
    name: 'callProposeSchedule',
    callable: 'proposeSchedule',
    // The one wrapper besides the photo import that already waits as long as its
    // function may run (`batchCallables.ts:26-30`). Phase 5 must not move it.
    timeout: PROPOSE_SCHEDULE_CLIENT_TIMEOUT_MS,
    data: { stages: [] },
    call: () => barrel.callProposeSchedule(cast(SCHEDULE_INPUT)),
    payload: SCHEDULE_INPUT,
    ok: { kind: 'ok', value: { stages: [] } },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callSetObservationImageUpload',
    callable: 'setObservationImageUpload',
    data: { ok: true },
    call: () => barrel.callSetObservationImageUpload('b1', 'o1', 'B64'),
    payload: { batchId: 'b1', observationId: 'o1', imageBase64: 'B64' },
    ok: { kind: 'ok', value: undefined },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callMatchOrCreate',
    callable: 'matchOrCreateCanon',
    // The server's own Result envelope, returned VERBATIM rather than re-wrapped
    // (`canonMatching.ts:32`) — one of Rule 10's two stated exceptions. A
    // refactor that wrapped it would produce {kind:'ok', value:{kind:'ok',…}}.
    data: { kind: 'err', error: { kind: 'ValidationError', code: 'CANON_TEXT_EMPTY' } },
    call: () => barrel.callMatchOrCreate(cast(MATCH_INPUT)),
    payload: MATCH_INPUT,
    ok: { kind: 'err', error: { kind: 'ValidationError', code: 'CANON_TEXT_EMPTY' } },
    traced: {
      call: () => barrel.callMatchOrCreate(cast(MATCH_INPUT), TRACEPARENT),
      payload: { ...MATCH_INPUT, traceparent: TRACEPARENT },
    },
    errors: SHARED_ERRORS,
  },
  {
    name: 'callCanonicaliseRecipeIngredients',
    callable: 'canonicaliseRecipeIngredients',
    timeout: 120_000,
    data: [],
    call: () => barrel.callCanonicaliseRecipeIngredients(cast(CANONICALISE_INPUT)),
    payload: CANONICALISE_INPUT,
    ok: { kind: 'ok', value: [] },
    traced: {
      call: () => barrel.callCanonicaliseRecipeIngredients(cast(CANONICALISE_INPUT), TRACEPARENT),
      payload: { ...CANONICALISE_INPUT, traceparent: TRACEPARENT },
    },
    errors: SHARED_ERRORS,
  },
  {
    name: 'callRegenerateCanonIcon',
    callable: 'regenerateCanonIcon',
    data: { ok: true },
    call: () => barrel.callRegenerateCanonIcon('c1'),
    payload: { canonId: 'c1' },
    ok: { kind: 'ok', value: undefined },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callGenerateChatTitle',
    callable: 'generateChatTitle',
    data: 'A loaf, discussed',
    call: () => barrel.callGenerateChatTitle('how do I prove?', 'slowly'),
    payload: { userMessage: 'how do I prove?', assistantResponse: 'slowly' },
    ok: { kind: 'ok', value: 'A loaf, discussed' },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'streamChefChat',
    callable: 'chefChat',
    stream: true,
    timeout: 120_000,
    // An OBJECT since #1299 — the reply text plus what the chef declared it
    // offered — and `.safeParse`d on the way in, so the row's `data` has to be
    // something that actually parses.
    data: { text: 'Preheat.', offered: ['dish-change'] },
    call: () => barrel.streamChefChat(cast(CHAT_INPUT), () => {}),
    payload: CHAT_INPUT,
    ok: { kind: 'ok', value: { text: 'Preheat.', offered: ['dish-change'] } },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callIdentifyEquipment',
    callable: 'identifyEquipment',
    data: { candidates: [] },
    call: () => barrel.callIdentifyEquipment('Dutch oven'),
    payload: { rawName: 'Dutch oven' },
    ok: { kind: 'ok', value: { candidates: [] } },
    traced: {
      call: () => barrel.callIdentifyEquipment('Dutch oven', TRACEPARENT),
      payload: { rawName: 'Dutch oven', traceparent: TRACEPARENT },
    },
    errors: SHARED_ERRORS,
  },
  {
    name: 'callPopulateEquipmentEntry',
    callable: 'populateEquipmentEntry',
    data: { name: 'Dutch oven', accessories: [] },
    call: () => barrel.callPopulateEquipmentEntry('Dutch oven'),
    payload: { confirmedName: 'Dutch oven' },
    ok: { kind: 'ok', value: { name: 'Dutch oven', accessories: [] } },
    traced: {
      call: () => barrel.callPopulateEquipmentEntry('Dutch oven', TRACEPARENT),
      payload: { confirmedName: 'Dutch oven', traceparent: TRACEPARENT },
    },
    errors: SHARED_ERRORS,
  },
  {
    name: 'callExtractProcessStages',
    callable: 'extractProcessStages',
    timeout: 90_000,
    data: { stages: [] },
    call: () => barrel.callExtractProcessStages(cast(STAGES_INPUT)),
    payload: STAGES_INPUT,
    ok: { kind: 'ok', value: { stages: [] } },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callGenerateGuidedPlan',
    callable: 'generateGuidedPlan',
    timeout: 90_000,
    data: { preps: [], stepNotes: [] },
    call: () => barrel.callGenerateGuidedPlan(cast(PLAN_INPUT)),
    payload: PLAN_INPUT,
    ok: { kind: 'ok', value: { preps: [], stepNotes: [] } },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callSetIconUpload',
    callable: 'setIconUpload',
    data: { ok: true },
    call: () => barrel.callSetIconUpload('canon', 'c1', 'B64'),
    payload: { family: 'canon', id: 'c1', imageBase64: 'B64' },
    ok: { kind: 'ok', value: undefined },
    traced: null,
    errors: [
      ...SHARED_ERRORS,
      // Its own arm, ahead of the shared mapper: the item was deleted under a
      // page already open. NotFound is a SUPPRESSED category, so this is the
      // difference between silence and a reported defect.
      {
        code: 'functions/not-found',
        expected: { kind: 'err', error: { kind: 'NotFound', resource: 'canon', id: 'c1' } },
      },
      // An override rather than an arm: the payload cap is the schema's, so a
      // refusal is a client-side programming error, worded plainly and
      // suppressed.
      {
        code: 'functions/invalid-argument',
        expected: {
          kind: 'err',
          error: {
            kind: 'ValidationError',
            code: ErrorCode.ICON_UPLOAD_REJECTED,
            message: 'That image could not be used.',
          },
        },
      },
    ],
  },
  {
    name: 'callGetImagePrompt',
    callable: 'getImagePrompt',
    data: PROMPT_RESULT,
    call: () => barrel.callGetImagePrompt('recipe', 'r1'),
    payload: { family: 'recipe', id: 'r1' },
    ok: { kind: 'ok', value: PROMPT_RESULT },
    traced: null,
    errors: [
      ...SHARED_ERRORS,
      {
        code: 'functions/not-found',
        expected: { kind: 'err', error: { kind: 'NotFound', resource: 'recipe', id: 'r1' } },
      },
    ],
  },
  {
    name: 'callListPushoverDevices',
    callable: 'listPushoverDevices',
    data: { status: 'ok', devices: [] },
    call: () => barrel.callListPushoverDevices(),
    // An EMPTY object, not no argument: the callable protocol sends a body.
    payload: {},
    ok: { kind: 'ok', value: { status: 'ok', devices: [] } },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callParseRecipeIngredients',
    callable: 'parseRecipeIngredients',
    timeout: 90_000,
    data: [],
    call: () => barrel.callParseRecipeIngredients('2 eggs'),
    payload: { rawText: '2 eggs' },
    ok: { kind: 'ok', value: [] },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callRegenerateRecipeImage',
    callable: 'regenerateRecipeImage',
    data: { ok: true },
    call: () => barrel.callRegenerateRecipeImage('r1'),
    payload: { recipeId: 'r1' },
    ok: { kind: 'ok', value: undefined },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callRedoRecipeKit',
    callable: 'redoRecipeKit',
    data: { ok: true },
    call: () => barrel.callRedoRecipeKit('r1'),
    payload: { recipeId: 'r1' },
    ok: { kind: 'ok', value: undefined },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callSetRecipeImageUpload',
    callable: 'setRecipeImageUpload',
    data: { ok: true },
    call: () => barrel.callSetRecipeImageUpload('r1', 'B64'),
    payload: { recipeId: 'r1', imageBase64: 'B64' },
    ok: { kind: 'ok', value: undefined },
    traced: null,
    errors: SHARED_ERRORS,
  },
  {
    name: 'callDescribeRecipeScene',
    callable: 'describeRecipeScene',
    timeout: 90_000,
    data: { brief: 'a loaf, lit softly' },
    call: () => barrel.callDescribeRecipeScene(cast(SCENE_INPUT)),
    payload: SCENE_INPUT,
    ok: { kind: 'ok', value: { brief: 'a loaf, lit softly' } },
    traced: {
      call: () => barrel.callDescribeRecipeScene(cast(SCENE_INPUT), TRACEPARENT),
      payload: { ...SCENE_INPUT, traceparent: TRACEPARENT },
    },
    errors: SHARED_ERRORS,
  },
  {
    name: 'callExtractRecipeFromUrl',
    callable: 'extractRecipeFromUrl',
    timeout: 120_000,
    data: RECIPE,
    call: () => barrel.callExtractRecipeFromUrl(cast(URL_INPUT)),
    payload: URL_INPUT,
    ok: { kind: 'ok', value: RECIPE },
    traced: {
      call: () => barrel.callExtractRecipeFromUrl(cast(URL_INPUT), TRACEPARENT),
      payload: { ...URL_INPUT, traceparent: TRACEPARENT },
    },
    // Its OWN failure vocabulary, not DomainError: the web copy map keys off
    // these codes (`classifyUrlImportError`). `internal` is a verdict on the
    // reader, `unavailable` on the fetch — the two the shared mapper would
    // flatten into StorageError and NetworkError.
    errors: [
      {
        code: 'functions/internal',
        expected: { kind: 'err', error: { kind: 'ImportError', code: 'ai-failed' } },
      },
      {
        code: 'functions/unavailable',
        expected: { kind: 'err', error: { kind: 'ImportError', code: 'fetch-failed' } },
      },
    ],
  },
  {
    name: 'callExtractRecipeFromPhoto',
    callable: 'extractRecipeFromPhoto',
    // Already waits as long as its function may run, from the SAME constant the
    // CF passes as `timeoutSeconds` (`recipeCallables.ts:262-265`). Phase 5 must
    // not move it.
    timeout: PHOTO_IMPORT_TIMEOUT_SECONDS * 1000,
    data: RECIPE,
    call: () => barrel.callExtractRecipeFromPhoto(cast(PHOTO_INPUT)),
    payload: PHOTO_INPUT,
    ok: { kind: 'ok', value: RECIPE },
    traced: {
      call: () => barrel.callExtractRecipeFromPhoto(cast(PHOTO_INPUT), TRACEPARENT),
      payload: { ...PHOTO_INPUT, traceparent: TRACEPARENT },
    },
    // A separate taxonomy from the URL import's, deliberately: invalid-url and
    // fetch-failed are meaningless about a photograph. `unavailable` has no arm
    // at all, so it falls to the shared mapper — which is the behaviour, not an
    // oversight (#740: a failure that never reached the reader must not be
    // narrated as a verdict on the user's photographs).
    errors: [
      {
        code: 'functions/internal',
        expected: { kind: 'err', error: { kind: 'ImportError', code: 'import-failed' } },
      },
      { code: 'functions/unavailable', expected: { kind: 'err', error: UNREACHABLE } },
    ],
  },
  {
    name: 'callRefreshWeatherForecast',
    callable: 'refreshWeatherForecast',
    data: { homeLocationSet: true, skipped: false, forecast: null },
    call: () => barrel.callRefreshWeatherForecast(),
    payload: { force: false },
    ok: { kind: 'ok', value: { homeLocationSet: true, skipped: false, forecast: null } },
    traced: {
      call: () => barrel.callRefreshWeatherForecast(true, TRACEPARENT),
      payload: { force: true, traceparent: TRACEPARENT },
    },
    errors: SHARED_ERRORS,
  },
  {
    name: 'callDrawEquipmentIcon',
    callable: 'drawEquipmentIcon',
    timeout: 300_000,
    data: { ok: true },
    call: () => barrel.callDrawEquipmentIcon(cast(DRAW_INPUT)),
    payload: DRAW_INPUT,
    ok: { kind: 'ok', value: undefined },
    traced: null,
    errors: [
      ...SHARED_ERRORS,
      // The kill switch being off, or no description written yet — expected
      // states with a friendly message, so suppressed rather than reported.
      {
        code: 'functions/failed-precondition',
        expected: {
          kind: 'err',
          error: { kind: 'ValidationError', code: ErrorCode.EQUIPMENT_ICON_NOT_DRAWABLE },
        },
      },
    ],
  },
  {
    name: 'callDescribeEquipmentSubject',
    callable: 'describeEquipmentSubject',
    timeout: 90_000,
    // Projects the BRIEF out of the wrapper object Genkit's structured output
    // requires. No caller wants the envelope, and a mechanical rewrite that
    // returned `res.data` would hand them one.
    data: { brief: 'a squat cast-iron pot' },
    call: () => barrel.callDescribeEquipmentSubject(cast(DESCRIBE_INPUT)),
    payload: DESCRIBE_INPUT,
    ok: { kind: 'ok', value: 'a squat cast-iron pot' },
    traced: null,
    errors: [
      ...SHARED_ERRORS,
      {
        code: 'functions/invalid-argument',
        expected: {
          kind: 'err',
          error: { kind: 'ValidationError', code: ErrorCode.EQUIPMENT_BRIEF_NOT_WRITABLE },
        },
      },
    ],
  },
  {
    name: 'callRegenerateProductFormIcon',
    callable: 'regenerateProductFormIcon',
    data: { ok: true },
    call: () => barrel.callRegenerateProductFormIcon('f1'),
    payload: { formId: 'f1' },
    ok: { kind: 'ok', value: undefined },
    traced: null,
    errors: SHARED_ERRORS,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetFunctions.mockImplementation((_app: unknown, region?: string) => ({ region }));
  mockHttpsCallable.mockImplementation(() => fn);
  // See the header: without this every error row collapses onto
  // NetworkError/offline and pins nothing about the mapping.
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The `(functionsInstance, name, options?)` triple, as a value. */
function callableArgs(): unknown[] {
  expect(mockHttpsCallable, 'the wrapper never asked for a callable').toHaveBeenCalledTimes(1);
  return mockHttpsCallable.mock.calls[0] as unknown[];
}

/** The single payload the wrapper put on the wire. */
function sentPayload(row: Row): unknown {
  const target = row.stream ? fn.stream : fn;
  expect(target, `${row.name} never invoked the callable`).toHaveBeenCalledTimes(1);
  return (target.mock.calls[0] as unknown[])[0];
}

function armSuccess(row: Row): void {
  if (row.stream) {
    fn.stream.mockResolvedValue({ stream: twoChunks(), data: Promise.resolve(row.data) });
    return;
  }
  fn.mockResolvedValue({ data: row.data });
}

describe.each(rows)('$name', (row) => {
  it('asks for its callable, in the one region, with the timeout it declares', async () => {
    armSuccess(row);
    await row.call();

    expect(mockGetFunctions).toHaveBeenCalledWith(undefined, FUNCTIONS_REGION);
    // The whole argument LIST, so a third argument cannot appear unnoticed:
    // `toHaveBeenCalledWith(REGIONED, name)` passes on a call that supplied a
    // timeout, and sixteen of these rows are pinning that they supply none.
    expect(callableArgs()).toEqual(
      row.timeout === undefined
        ? [REGIONED, row.callable]
        : [REGIONED, row.callable, { timeout: row.timeout }],
    );
  });

  it('sends the payload the wire schema expects, and projects the result', async () => {
    armSuccess(row);
    const result = await row.call();

    expect(sentPayload(row)).toStrictEqual(row.payload);
    expect(result).toEqual(row.ok);
  });

  it.runIf(row.traced)('rides the traceparent as a named field when it is given one', async () => {
    armSuccess(row);
    await row.traced!.call();

    expect(sentPayload(row)).toStrictEqual(row.traced!.payload);
  });

  it.each(row.errors)('answers $code with the failure it declares', async ({ code, expected }) => {
    const rejection = callableError(code);
    if (row.stream) fn.stream.mockRejectedValue(rejection);
    else fn.mockRejectedValue(rejection);

    // NEVER a throw (Rule 10). `resolves` rather than a try/catch, so a wrapper
    // that started throwing fails this row rather than escaping it.
    await expect(row.call()).resolves.toEqual(expected);
  });
});

// ─── The optionals, and that an absent one is ABSENT ────────────────────────
//
// Eight wrappers build their payload with a ternary rather than spreading an
// optional in, because `{k: undefined}` and `{}` are not the same thing on the
// wire: the callable protocol serialises the first as an explicit null the CF's
// wire schema may refuse. The rows above pin the ABSENT half; these pin the
// present half, plus the two that TRIM before deciding — a hint of whitespace
// is no hint (UT-D1: one it.each, not eight bodies).
const optionalCases = [
  {
    what: 'callTestModel attaches a role when it has one',
    call: () => barrel.callTestModel('gemini-x', 'fast'),
    payload: { model: 'gemini-x', role: 'fast' },
  },
  {
    what: 'callRegenerateCanonIcon trims a hint',
    call: () => barrel.callRegenerateCanonIcon('c1', '  greener  '),
    payload: { canonId: 'c1', hint: 'greener' },
  },
  {
    what: 'callRegenerateCanonIcon drops a hint that is only whitespace',
    call: () => barrel.callRegenerateCanonIcon('c1', '   '),
    payload: { canonId: 'c1' },
  },
  {
    what: 'callRegenerateProductFormIcon trims a hint',
    call: () => barrel.callRegenerateProductFormIcon('f1', '  bluer  '),
    payload: { formId: 'f1', hint: 'bluer' },
  },
  {
    what: 'callRegenerateRecipeImage trims a brief',
    call: () => barrel.callRegenerateRecipeImage('r1', '  on a board  '),
    payload: { recipeId: 'r1', brief: 'on a board' },
  },
  {
    what: 'callRegenerateRecipeImage drops a brief that is only whitespace',
    call: () => barrel.callRegenerateRecipeImage('r1', '  '),
    payload: { recipeId: 'r1' },
  },
  {
    what: 'callSetRecipeImageUpload attaches a contentType when it has one',
    call: () => barrel.callSetRecipeImageUpload('r1', 'B64', 'image/webp'),
    payload: { recipeId: 'r1', imageBase64: 'B64', contentType: 'image/webp' },
  },
  {
    what: 'callSetIconUpload attaches a contentType when it has one',
    call: () => barrel.callSetIconUpload('canon', 'c1', 'B64', 'image/webp'),
    payload: { family: 'canon', id: 'c1', imageBase64: 'B64', contentType: 'image/webp' },
  },
  {
    what: 'callSetObservationImageUpload attaches a contentType when it has one',
    call: () => barrel.callSetObservationImageUpload('b1', 'o1', 'B64', 'image/webp'),
    payload: {
      batchId: 'b1',
      observationId: 'o1',
      imageBase64: 'B64',
      contentType: 'image/webp',
    },
  },
] as const;

describe('the optional payload fields', () => {
  it.each(optionalCases)('$what', async ({ call, payload }) => {
    fn.mockResolvedValue({ data: { ok: true } });
    await call();
    expect(fn.mock.calls[0]![0]).toStrictEqual(payload);
  });
});

// ─── The trust boundary on the way back ─────────────────────────────────────
describe('callGetImagePrompt — the wire result is parsed, not trusted', () => {
  it('refuses a response that does not match its schema', async () => {
    // A callable response arrives as `unknown`; `imagePromptCallables.ts:52`
    // safeParses it. A shape mismatch is a corruption rather than a network
    // blip, so it maps to the REPORTED category — which is the whole point of
    // parsing it at all.
    fn.mockResolvedValue({ data: { prompt: 'a loaf', model: 42, seedFile: null } });

    await expect(barrel.callGetImagePrompt('canon', 'c1')).resolves.toEqual({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'corruption' },
    });
  });
});

// ─── The stream, chunk by chunk ─────────────────────────────────────────────
describe('streamChefChat — the chunks reach the caller as they arrive', () => {
  it('hands every chunk to onChunk and resolves to the assembled reply', async () => {
    fn.stream.mockResolvedValue({
      stream: twoChunks(),
      data: Promise.resolve({ text: 'Preheat.', offered: [] }),
    });
    const chunks: string[] = [];

    const result = await barrel.streamChefChat(cast(CHAT_INPUT), (c) => chunks.push(c));

    // The chunks AND their order: a rewrite that awaited the aggregate and
    // replayed it would satisfy "resolves to the reply" while delivering the
    // whole answer at once, which is the entire point of the stream.
    //
    // The chunks are still STRINGS (#1299). Only the resolved value widened, so a
    // change that pushed the declaration into the stream would fail here.
    expect(chunks).toEqual(['Pre', 'heat.']);
    expect(result).toEqual({ kind: 'ok', value: { text: 'Preheat.', offered: [] } });
  });

  it('defaults an absent declaration to nothing offered', async () => {
    // The fail-closed default lives on the schema, so a Cloud Function that
    // returned only the text would still parse — and offer no buttons.
    fn.stream.mockResolvedValue({
      stream: twoChunks(),
      data: Promise.resolve({ text: 'Preheat.' }),
    });

    const result = await barrel.streamChefChat(cast(CHAT_INPUT), () => {});

    expect(result).toEqual({ kind: 'ok', value: { text: 'Preheat.', offered: [] } });
  });

  it('reports a reply it cannot read as a corruption, rather than inventing one', async () => {
    // A browser on a new bundle against a Cloud Function deployed before #1299
    // gets a bare string here. StorageError so it is REPORTED — a shape mismatch
    // is a corruption, not a network blip.
    fn.stream.mockResolvedValue({ stream: twoChunks(), data: Promise.resolve('Preheat.') });

    const result = await barrel.streamChefChat(cast(CHAT_INPUT), () => {});

    expect(result).toEqual({
      kind: 'err',
      error: { kind: 'StorageError', reason: 'corruption' },
    });
  });
});

// ─── The two that THROW, and must go on throwing ────────────────────────────
describe('the email-OTP wrappers — Rule 10’s stated exception', () => {
  // `auth.ts` maps the raw callable error onto the OTP vocabulary (wrong code,
  // expired code, too many attempts), which it can only do if the error reaches
  // it. These two are thin on purpose; a refactor that gave them the shared
  // `Failure` return would silently turn every wrong-code message into a
  // generic one. See `emailOtpCallables.ts:4-7` and `auth.ts:153,:166`.
  it('callRequestEmailOtp sends the email and lets the callable error escape', async () => {
    fn.mockResolvedValue({ data: { ok: true } });
    await expect(callRequestEmailOtp('cook@example.com')).resolves.toBeUndefined();
    expect(callableArgs()).toEqual([REGIONED, 'requestEmailOtp']);
    expect(fn.mock.calls[0]![0]).toStrictEqual({ email: 'cook@example.com' });

    vi.clearAllMocks();
    mockHttpsCallable.mockImplementation(() => fn);
    fn.mockRejectedValue(callableError('functions/internal'));
    await expect(callRequestEmailOtp('cook@example.com')).rejects.toThrow();
  });

  it('callVerifyEmailOtp returns the custom token and lets the callable error escape', async () => {
    fn.mockResolvedValue({ data: { token: 'custom-token' } });
    await expect(callVerifyEmailOtp('cook@example.com', '123456')).resolves.toBe('custom-token');
    expect(callableArgs()).toEqual([REGIONED, 'verifyEmailOtp']);
    expect(fn.mock.calls[0]![0]).toStrictEqual({
      email: 'cook@example.com',
      code: '123456',
    });

    vi.clearAllMocks();
    mockHttpsCallable.mockImplementation(() => fn);
    // `failed-precondition` is the wrong-or-expired code, and the one arm
    // `auth.ts` most needs to see unmapped.
    fn.mockRejectedValue(callableError('functions/failed-precondition'));
    await expect(callVerifyEmailOtp('cook@example.com', '000000')).rejects.toThrow();
  });
});

// ─── The guard ──────────────────────────────────────────────────────────────
describe('callable contract — table coverage', () => {
  it('covers every call*/stream* the barrel exports — derived, not hand-kept', () => {
    const exported = Object.keys(barrel)
      .filter((k) => k.startsWith('call') || k.startsWith('stream'))
      .sort();
    const covered = rows.map((r) => r.name).sort();

    // Set equality both ways (UT-E2): a new wrapper exported without a row
    // fails, and so does a row left behind by a wrapper that was renamed or
    // deleted — the failure mode a one-directional check cannot see.
    expect(covered).toEqual(exported);
  });

  it('covers the two wrappers the barrel deliberately does not export', () => {
    // `callRequestEmailOtp`/`callVerifyEmailOtp` are package-INTERNAL, consumed
    // by `auth.ts` alone, so the barrel-derived guard above cannot reach them —
    // and they are the two whose contract ("throws") is least like the others
    // and most worth pinning. This asserts the internality too, so the day one
    // is exported the guard above starts covering it and this row goes red
    // rather than silently double-counting.
    expect(Object.keys(barrel)).not.toContain('callRequestEmailOtp');
    expect(Object.keys(barrel)).not.toContain('callVerifyEmailOtp');
    expect(typeof callRequestEmailOtp).toBe('function');
    expect(typeof callVerifyEmailOtp).toBe('function');
  });

  it('every row names a distinct callable, and says how it fails', () => {
    const names = rows.map((r) => r.callable);
    expect(new Set(names).size, 'two rows claim the same callable name').toBe(names.length);
    for (const r of rows) {
      expect(r.errors.length, `${r.name} pins no failure`).toBeGreaterThanOrEqual(2);
    }
  });
});
