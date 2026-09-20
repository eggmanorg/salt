import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { KitchenToolDoc } from '@salt/domain/schemas';
import { failure, success, type DomainError, type ReadResult } from '@salt/shared-types';

/**
 * The write ORDERING of the two verbs #1489 added, pinned (CLAUDE.md Rule 12).
 *
 * Neither `promoteKitchenToolMatcher` nor `moveKitchenToolMatcher` is atomic —
 * both are two plain client `setDoc`s, per the deliberate no-callable stance at
 * the head of `kitchenToolService.ts`. So each has to choose which half may fail,
 * and both choose the same way `canonService.ts`'s `splitMostRecentSynonym`
 * chose: THE GAINING WRITE GOES FIRST. A refused second write leaves the phrase
 * duplicated, which is recoverable; the opposite ordering destroys what a person
 * typed.
 *
 * That sentence is a claim about order, and order is exactly the thing a later
 * "tidy-up" reverses without noticing. These four tests are what goes red when it
 * does. Verified red by swapping the two `commitKitchenTool` calls in each
 * command before writing them, not merely by assertion.
 *
 * WHAT IS DELIBERATELY *NOT* PINNED: which picture the phrase draws during the
 * duplicate window. `resolveKitchenToolMatch` breaks a length tie by array order
 * (the `>` at `resolveKitchenTool.ts:66-90` is strict), so the answer is
 * unspecified and the header on `promoteKitchenToolMatcher` says so rather than
 * claiming otherwise. A test asserting one answer there would be pinning an
 * accident.
 *
 * THE SEAM is `@salt/firebase-sync`, the adapter boundary the architecture
 * defines; `@salt/observability` is mocked because the service builds a real
 * PostHog reporting adapter at first use.
 */

const { toolSink } = await vi.hoisted(async () => ({
  toolSink: { push: null as null | ((tools: readonly unknown[]) => void) },
}));

vi.mock('@salt/observability', () => ({
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: vi.fn() })),
}));
vi.mock('@salt/firebase-sync', () => ({
  subscribeKitchenTools: vi.fn((onTools: (tools: readonly unknown[]) => void) => {
    toolSink.push = onTools;
    return () => {};
  }),
  upsertKitchenTool: vi.fn(async () => success(undefined)),
  deleteKitchenTool: vi.fn(async () => success(undefined)),
}));

import { upsertKitchenTool } from '@salt/firebase-sync';
import {
  initKitchenToolSync,
  moveKitchenToolMatcher,
  promoteKitchenToolMatcher,
  __resetKitchenToolServiceForTest,
} from '../src/lib/kitchenToolService.js';

function tool(id: string, label: string, matchers: string[] = []): KitchenToolDoc {
  return {
    id,
    schemaVersion: 1,
    label,
    matchers,
    thumbnail: `https://example.com/kit/${id}.webp`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// A StorageError is the reportable category (§7.6), so a command that
// accidentally swallowed the failure would also lose the report.
const REFUSED: ReadResult<void, DomainError> = failure({
  kind: 'StorageError',
  reason: 'unavailable',
});

/** The documents handed to the adapter, in the order they were handed over. */
function writes(): KitchenToolDoc[] {
  return vi.mocked(upsertKitchenTool).mock.calls.map((c) => c[0] as KitchenToolDoc);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upsertKitchenTool).mockResolvedValue(success(undefined));
  initKitchenToolSync();
  toolSink.push?.([]);
});

afterEach(() => {
  __resetKitchenToolServiceForTest();
  toolSink.push = null;
});

describe('promoteKitchenToolMatcher — a name gets a picture of its own', () => {
  const PARENT = tool('mixing-bowl', 'Mixing bowl', ['large bowl', 'batter bowl']);

  beforeEach(() => {
    toolSink.push?.([PARENT]);
  });

  it('writes the NEW tool before it trims the parent', async () => {
    const result = await promoteKitchenToolMatcher(PARENT, 'large bowl');

    expect(result.kind).toBe('ok');
    expect(writes()).toHaveLength(2);
    // First: the gaining document. Its slug comes from the phrase, and
    // `thumbnail: null` is what the `onKitchenToolWritten` edge guard reads to
    // decide to draw — this verb is the one that spends an image.
    expect(writes()[0]).toMatchObject({
      id: 'large-bowl',
      label: 'large bowl',
      matchers: [],
      thumbnail: null,
    });
    // Second: the parent, minus the phrase and keeping everything else.
    expect(writes()[1]).toMatchObject({
      id: 'mixing-bowl',
      matchers: ['batter bowl'],
      thumbnail: 'https://example.com/kit/mixing-bowl.webp',
    });
  });

  it('a refused trim leaves the phrase on BOTH documents, and the new tool survives', async () => {
    // The recoverable half, and the whole reason for the ordering: the second
    // write is the one allowed to fail.
    vi.mocked(upsertKitchenTool)
      .mockResolvedValueOnce(success(undefined))
      .mockResolvedValueOnce(REFUSED);

    const result = await promoteKitchenToolMatcher(PARENT, 'large bowl');

    expect(result.kind).toBe('err');
    // The new tool was written and is not rolled back — there is no transaction
    // here and inventing an undo write would be a third path to get wrong.
    expect(writes()[0]).toMatchObject({ id: 'large-bowl' });
    // And the parent still answers to the phrase, because its trim never landed.
    expect(PARENT.matchers).toContain('large bowl');
  });

  it('a colliding slug writes NOTHING AT ALL', async () => {
    // `createKitchenTool` is pure and takes the whole vocabulary, so the refusal
    // happens before the first write rather than after it.
    toolSink.push?.([PARENT, tool('large-bowl', 'Large bowl')]);

    const result = await promoteKitchenToolMatcher(PARENT, 'large bowl');

    expect(result).toEqual(failure({ kind: 'ConflictError' }));
    expect(writes()).toHaveLength(0);
  });
});

describe('moveKitchenToolMatcher — a name changes hands', () => {
  const FROM = tool('mixing-bowl', 'Mixing bowl', ['large bowl', 'batter bowl']);
  const TO = tool('salad-bowl', 'Salad bowl', ['serving bowl']);

  beforeEach(() => {
    toolSink.push?.([FROM, TO]);
  });

  it('writes the DESTINATION before it trims the source, and draws nothing', async () => {
    const result = await moveKitchenToolMatcher(FROM, TO, 'large bowl');

    expect(result.kind).toBe('ok');
    expect(writes()).toHaveLength(2);
    expect(writes()[0]).toMatchObject({
      id: 'salad-bowl',
      matchers: ['serving bowl', 'large bowl'],
      // The move costs nothing: the destination keeps the picture it had, and no
      // document is minted, so no trigger fires and no image is spent.
      thumbnail: 'https://example.com/kit/salad-bowl.webp',
    });
    expect(writes()[1]).toMatchObject({ id: 'mixing-bowl', matchers: ['batter bowl'] });
  });

  it('a refused source-trim leaves the phrase on both tools', async () => {
    vi.mocked(upsertKitchenTool)
      .mockResolvedValueOnce(success(undefined))
      .mockResolvedValueOnce(REFUSED);

    const result = await moveKitchenToolMatcher(FROM, TO, 'large bowl');

    expect(result.kind).toBe('err');
    expect(writes()[0]).toMatchObject({ matchers: ['serving bowl', 'large bowl'] });
    expect(FROM.matchers).toContain('large bowl');
  });
});

describe('both verbs refuse a document the domain cannot update, before any write', () => {
  // `updateKitchenTool` is the only thing between these commands and a document
  // with no usable name, and it is reached THREE times across the two of them —
  // the parent's trim, the destination's append, the source's trim. Each has to
  // answer `err` with nothing written, and a guard nothing exercises is a guard
  // nobody knows works (Rule 10).
  //
  // A blank label is the whole of what it refuses. It cannot arrive from
  // Firestore — the schema forbids it — so this is a defensive contract rather
  // than a reachable user path, and it is stated that way rather than dressed up
  // as a scenario.
  const BLANK = tool('blank', '   ', ['large bowl']);

  it.each([
    [
      'promote, when the parent cannot be trimmed',
      () => promoteKitchenToolMatcher(BLANK, 'large bowl'),
    ],
    [
      'move, when the destination cannot be appended to',
      () =>
        moveKitchenToolMatcher(
          tool('mixing-bowl', 'Mixing bowl', ['large bowl']),
          BLANK,
          'large bowl',
        ),
    ],
    [
      'move, when the source cannot be trimmed',
      () => moveKitchenToolMatcher(BLANK, tool('salad-bowl', 'Salad bowl'), 'large bowl'),
    ],
  ])('%s', async (_name, run) => {
    const result = await run();

    expect(result.kind).toBe('err');
    expect(writes()).toHaveLength(0);
  });
});
