import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { PHOTO_IMPORT_FAILURE_CODES, type RecipePagePhoto } from '@salt/domain/schemas';
import type { Recipe } from '@salt/domain';

// ─── Span recorder ────────────────────────────────────────────────────────────
// Photo import roots a BROWSER span (issue #362) exactly as the URL import does,
// so the CF + AI sub-tree nests under a trace that originates at the click. The
// recorder captures what the service says about the action; `traceparent` is
// swappable so the inert-tracer path (empty string → the wrapper is called with
// `undefined`) is exercised too.

interface SpanRecord {
  name: string;
  attributes: Record<string, unknown>;
  children: string[];
  errored: boolean;
  ended: boolean;
}

const { spans, tracer } = vi.hoisted(() => ({
  spans: [] as SpanRecord[],
  tracer: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
}));

// `recipeService` stamps recipe attribution from `currentMember` (issue #845),
// so it now pulls in the real `membersService` — which reaches `auth.svelte.js`,
// whose import of `firebase.ts` boots the SDK at module load. Stub the auth
// store as the shopping-list suites do: nobody signed in, so no name is
// available and nothing is stamped.
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: { user: null } }));
vi.mock('@salt/observability', () => ({
  startUserActionSpan: vi.fn((name: string) => {
    const record: SpanRecord = {
      name,
      attributes: {},
      children: [],
      errored: false,
      ended: false,
    };
    spans.push(record);
    return {
      child: (childName: string) => {
        record.children.push(childName);
        return { end: () => {} };
      },
      end: () => {
        record.ended = true;
      },
      setAttribute: (key: string, value: unknown) => {
        record.attributes[key] = value;
      },
      setError: () => {
        record.errored = true;
      },
      get traceparent() {
        return tracer.traceparent;
      },
    };
  }),
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report: () => {} })),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipeDoc: vi.fn(),
  deleteRecipe: vi.fn(),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  callExtractRecipeFromUrl: vi.fn(),
  callExtractRecipeFromPhoto: vi.fn(),
  callDescribeRecipeScene: vi.fn(),
  saveShoppingListItem: vi.fn(),
  isAuthTransitioning: vi.fn(() => false),
}));

vi.mock('../src/lib/canonService.js', () => ({ getCanonItemsSnapshot: vi.fn(() => []) }));

import * as firebaseSync from '@salt/firebase-sync';
import { importRecipeFromPhoto, photoImportMessage } from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

const DRAFT: Recipe = {
  cureCategory: null,
  id: 'imported-1',
  schemaVersion: 1,
  kind: 'recipe',
  title: 'Braised Beef',
  description: null,
  ingredients: [],
  steps: [],
  metadata: {
    servings: 4,
    tags: [],
  },
  source: { type: 'book', book: { title: 'The Roasting Tin', page: 62 } },
  notes: null,
  needs_approval: true,
  producesCanonId: null,
  componentRecipeIds: [],
  kit: [],
  image: null,
  createdBy: '',
  lastEditedBy: '',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const PAGES: RecipePagePhoto[] = [
  { base64: 'AAAA', contentType: 'image/webp' },
  { base64: 'BBBB', contentType: 'image/webp' },
];

function lastSpan(): SpanRecord {
  const span = spans.at(-1);
  if (!span) throw new Error('no span was started');
  return span;
}

beforeEach(() => {
  vi.clearAllMocks();
  spans.length = 0;
  tracer.traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
});

describe('importRecipeFromPhoto', () => {
  it('sends the captured pages and returns the persisted draft', async () => {
    fs.callExtractRecipeFromPhoto.mockResolvedValue({ kind: 'ok', value: DRAFT });

    const result = await importRecipeFromPhoto(PAGES);

    expect(result).toEqual({ kind: 'ok', value: DRAFT });
    expect(fs.callExtractRecipeFromPhoto).toHaveBeenCalledTimes(1);
    const [input] = fs.callExtractRecipeFromPhoto.mock.calls[0]!;
    expect(input).toEqual({ images: PAGES });
  });

  it('roots a browser span and hands its traceparent to the callable', async () => {
    fs.callExtractRecipeFromPhoto.mockResolvedValue({ kind: 'ok', value: DRAFT });

    await importRecipeFromPhoto(PAGES);

    // The trace ORIGINATES here in the browser; the callable carries the W3C id
    // so the CF + AI sub-tree nests under it rather than re-rooting.
    expect(fs.callExtractRecipeFromPhoto.mock.calls[0]![1]).toBe(tracer.traceparent);

    const span = lastSpan();
    expect(span.name).toBe('Import recipe from photo');
    expect(span.children).toEqual(['callExtractRecipeFromPhoto']);
    expect(span.attributes['import.source']).toBe('photo');
    // Page count is the one dimension that materially predicts latency.
    expect(span.attributes['import.pageCount']).toBe(2);
    expect(span.attributes['import.outcome']).toBe('ok');
    expect(span.errored).toBe(false);
    expect(span.ended).toBe(true);
  });

  it('omits the traceparent entirely when tracing is inert', async () => {
    // Best-effort tracing: an inert tracer yields an empty traceparent, and the
    // import must then behave exactly as a bare callable call.
    tracer.traceparent = '';
    fs.callExtractRecipeFromPhoto.mockResolvedValue({ kind: 'ok', value: DRAFT });

    await importRecipeFromPhoto(PAGES);

    expect(fs.callExtractRecipeFromPhoto.mock.calls[0]![1]).toBeUndefined();
  });

  it('passes the failure code straight through and marks the span errored', async () => {
    fs.callExtractRecipeFromPhoto.mockResolvedValue({
      kind: 'err',
      error: { kind: 'ImportError', code: 'unreadable-photos' },
    });

    const result = await importRecipeFromPhoto(PAGES);

    expect(result).toEqual({
      kind: 'err',
      error: { kind: 'ImportError', code: 'unreadable-photos' },
    });
    const span = lastSpan();
    expect(span.attributes['import.outcome']).toBe('unreadable-photos');
    expect(span.errored).toBe(true);
    expect(span.ended).toBe(true);
  });

  it('ends the span even when the adapter rejects', async () => {
    // The adapter never throws (Rule 10), but the `finally` must not depend on
    // that promise — a leaked root span would silently poison the trace.
    fs.callExtractRecipeFromPhoto.mockRejectedValue(new Error('boom'));

    await expect(importRecipeFromPhoto(PAGES)).rejects.toThrow('boom');
    expect(lastSpan().ended).toBe(true);
  });

  it('reports the page count it was actually given', async () => {
    fs.callExtractRecipeFromPhoto.mockResolvedValue({ kind: 'ok', value: DRAFT });

    await importRecipeFromPhoto([PAGES[0]!]);

    expect(lastSpan().attributes['import.pageCount']).toBe(1);
  });
});

describe('photoImportMessage', () => {
  it('has distinct, non-empty copy for every photo-import failure code', () => {
    const messages = PHOTO_IMPORT_FAILURE_CODES.map((code) =>
      photoImportMessage({ kind: 'ImportError', code }),
    );
    expect(messages.every((m) => m.trim().length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(PHOTO_IMPORT_FAILURE_CODES.length);
  });

  it('covers blurry photos and "no recipe here" with the one message', () => {
    // The server genuinely cannot tell those two apart, so the copy must not
    // claim either — it has to point at the remedy that fixes both.
    const message = photoImportMessage({ kind: 'ImportError', code: 'unreadable-photos' });
    expect(message).toContain('couldn’t read a recipe');
    expect(message).toMatch(/sharper|brighter/);
  });
});
