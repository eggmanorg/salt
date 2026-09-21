import { describe, it, expect, beforeEach, vi, type Mocked } from 'vitest';
import { URL_IMPORT_FAILURE_CODES, PHOTO_IMPORT_FAILURE_CODES } from '@salt/domain/schemas';
import type { RecipePagePhoto } from '@salt/domain/schemas';

// Issue #740 — what the two import paths SAY and what they REPORT.
//
// The defect this pins shut had two halves, and the second is the one a copy
// test would miss: a signed-out import was told to the user as a verdict on the
// recipe site, AND it carried no DomainError category, so the §7.6 reporting
// gate at ErrorReportingPort could never see it. Both halves are asserted here
// — the message, and the fact that an AuthError now reaches the port while an
// ordinary import verdict does not.

const report = vi.fn();

// The recorder is the RICH one `recipeService.photoImport.test.ts` uses, not the
// two-field shim this file used to carry (issue #1055). The thin version captured
// only `attributes` and `errored`, and its `child: () => ({ end })` threw the
// child's NAME away — so the URL import's span name, `import.source`, child span
// name and traceparent were not merely unasserted, they were UNOBSERVABLE. Three
// of the four are about to be rewritten by a shared traced-action helper, and a
// rewrite nothing can see is not a refactor, it is a rewrite.
//
// `traceparent` is swappable so the inert-tracer path (empty string → the wrapper
// is called with `undefined`) is exercised on this path too.
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
  createObservabilityErrorReportingAdapter: vi.fn(() => ({ report })),
}));

vi.mock('@salt/firebase-sync', () => ({
  subscribeRecipes: vi.fn(() => vi.fn()),
  saveRecipeDoc: vi.fn(),
  deleteRecipe: vi.fn(),
  callParseRecipeIngredients: vi.fn(),
  callCanonicaliseRecipeIngredients: vi.fn(),
  callExtractRecipeFromUrl: vi.fn(),
  callExtractRecipeFromPhoto: vi.fn(),
  callAuthorRecipe: vi.fn(),
  callDescribeRecipeScene: vi.fn(),
  saveShoppingListItem: vi.fn(),
  isAuthTransitioning: vi.fn(() => false),
}));

vi.mock('../src/lib/canonService.js', () => ({ getCanonItemsSnapshot: vi.fn(() => []) }));

import * as firebaseSync from '@salt/firebase-sync';
import {
  importRecipeFromUrl,
  importRecipeFromPhoto,
  urlImportMessage,
  photoImportMessage,
  isSignedOutFailure,
  stashPendingImportUrl,
  takePendingImportUrl,
  authorRecipeTraced,
} from '../src/lib/recipeService.js';

const fs = firebaseSync as Mocked<typeof firebaseSync>;

const PAGES: RecipePagePhoto[] = [{ base64: 'AAAA', contentType: 'image/webp' }];
const SIGNED_OUT = { kind: 'AuthError', reason: 'unauthenticated' } as const;

beforeEach(() => {
  vi.clearAllMocks();
  spans.length = 0;
  tracer.traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  takePendingImportUrl(); // drain any stash a previous test left behind
});

function lastSpan(): SpanRecord {
  const span = spans.at(-1);
  if (!span) throw new Error('no span was started');
  return span;
}

describe('import copy — what the user is told', () => {
  it('says you are signed out, and never blames the page, on a dead session', () => {
    const message = urlImportMessage(SIGNED_OUT);
    expect(message).toMatch(/signed out/i);
    // The exact regression: the old code answered this with fetch-failed's copy.
    expect(message).not.toMatch(/reach that page|paywalled|blocking/i);
  });

  it('says the same thing on the photo path, and never blames the photos', () => {
    const message = photoImportMessage(SIGNED_OUT);
    expect(message).toMatch(/signed out/i);
    expect(message).not.toMatch(/photos|recipe reader/i);
    // One spelling of "signed out" across both paths — the whole point of moving
    // auth onto DomainError rather than into two bespoke code sets.
    expect(message).toBe(urlImportMessage(SIGNED_OUT));
  });

  it('is honestly vague about an unknown failure rather than confidently wrong', () => {
    const message = urlImportMessage({ kind: 'NetworkError', reason: 'transient' });
    expect(message).toMatch(/something went wrong/i);
    expect(message).not.toMatch(/reach that page/i);
  });

  it('keeps the existing copy for every genuine URL-import verdict', () => {
    const messages = URL_IMPORT_FAILURE_CODES.map((code) =>
      urlImportMessage({ kind: 'ImportError', code }),
    );
    expect(new Set(messages).size).toBe(URL_IMPORT_FAILURE_CODES.length);
    // The one that was right all along, and had to stay right.
    expect(urlImportMessage({ kind: 'ImportError', code: 'fetch-failed' })).toMatch(
      /couldn't reach that page/i,
    );
  });

  it('keeps the existing copy for every genuine photo-import verdict', () => {
    const messages = PHOTO_IMPORT_FAILURE_CODES.map((code) =>
      photoImportMessage({ kind: 'ImportError', code }),
    );
    expect(new Set(messages).size).toBe(PHOTO_IMPORT_FAILURE_CODES.length);
  });

  it('recognises only auth as the signed-out case', () => {
    expect(isSignedOutFailure(SIGNED_OUT)).toBe(true);
    expect(isSignedOutFailure({ kind: 'AuthError', reason: 'forbidden' })).toBe(true);
    expect(isSignedOutFailure({ kind: 'ImportError', code: 'fetch-failed' })).toBe(false);
    expect(isSignedOutFailure({ kind: 'NetworkError', reason: 'transient' })).toBe(false);
  });
});

describe('import reporting — what reaches error tracking', () => {
  it('reports a signed-out URL import, with its category, to the port', async () => {
    fs.callExtractRecipeFromUrl.mockResolvedValue({ kind: 'err', error: SIGNED_OUT });

    await importRecipeFromUrl('https://example.com/r');

    expect(report).toHaveBeenCalledTimes(1);
    // Gated BY CATEGORY (§7.6), which is exactly what the old bespoke code could
    // not supply.
    expect(report.mock.calls[0]![1]).toBe('AuthError');
  });

  it('reports a signed-out PHOTO import too — the sibling defect', async () => {
    fs.callExtractRecipeFromPhoto.mockResolvedValue({ kind: 'err', error: SIGNED_OUT });

    await importRecipeFromPhoto(PAGES);

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![1]).toBe('AuthError');
  });

  it('does not report an ordinary import verdict — that is not an incident', async () => {
    fs.callExtractRecipeFromUrl.mockResolvedValue({
      kind: 'err',
      error: { kind: 'ImportError', code: 'not-a-recipe' },
    });

    await importRecipeFromUrl('https://example.com/r');

    expect(report).not.toHaveBeenCalled();
  });

  it('hands NetworkError to the port and lets the gate suppress it', async () => {
    fs.callExtractRecipeFromUrl.mockResolvedValue({
      kind: 'err',
      error: { kind: 'NetworkError', reason: 'transient' },
    });

    await importRecipeFromUrl('https://example.com/r');

    // The service does not second-guess the policy — it passes the category and
    // the port's gate drops it. Asserting the call, not a suppression here, is
    // what keeps the "gated by category, not by call-site shape" rule honest.
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![1]).toBe('NetworkError');
  });

  it('labels the span with the category when there is no import code', async () => {
    fs.callExtractRecipeFromUrl.mockResolvedValue({ kind: 'err', error: SIGNED_OUT });

    await importRecipeFromUrl('https://example.com/r');

    expect(spans.at(-1)!.attributes['import.outcome']).toBe('AuthError');
    expect(spans.at(-1)!.errored).toBe(true);
  });

  it('still labels the span with the bespoke code when there is one', async () => {
    fs.callExtractRecipeFromUrl.mockResolvedValue({
      kind: 'err',
      error: { kind: 'ImportError', code: 'ai-failed' },
    });

    await importRecipeFromUrl('https://example.com/r');

    expect(spans.at(-1)!.attributes['import.outcome']).toBe('ai-failed');
  });
});

describe('the pasted URL survives the sign-in round trip', () => {
  it('hands the URL back exactly once', () => {
    stashPendingImportUrl('https://example.com/recipes/ragu');
    expect(takePendingImportUrl()).toBe('https://example.com/recipes/ragu');
    // Single-use: coming back to the list later must not resurrect a link the
    // user has moved on from.
    expect(takePendingImportUrl()).toBeNull();
  });

  it('trims, and treats a blank URL as nothing to rescue', () => {
    stashPendingImportUrl('  https://example.com/r  ');
    expect(takePendingImportUrl()).toBe('https://example.com/r');

    stashPendingImportUrl('   ');
    expect(takePendingImportUrl()).toBeNull();
  });
});

// ─── The traced user actions (issue #1055 characterisation) ────────────────────
// `recipeService` wraps three callables in the SAME twenty-four-line skeleton —
// root span, named child span, pre-call attributes, an outcome attribute, an
// error mark, `end()` in a `finally`. Only one of the three (photo import) was
// pinned; the URL import's span was unobservable through this file's old
// recorder, and `authorRecipeTraced`'s span was asserted nowhere in the repo,
// because both suites that reach it mock `recipeService` wholesale.
//
// The three are about to become one helper with three call sites. Everything a
// caller of that helper can get wrong — the span NAME, the CHILD name, which
// attribute key carries the outcome, whether `setError` fires, whether the
// traceparent reaches the callable, and whether the span is ended — is pinned
// below, for the two paths that had no cover.

describe('the URL import span', () => {
  it.each([
    ['the import button on the recipe list', 'button'],
    ['the Web Share Target hand-off', 'share'],
  ] as const)('roots a span naming the host, from %s', async (_entry, source) => {
    fs.callExtractRecipeFromUrl.mockResolvedValue({ kind: 'ok', value: {} as never });

    await importRecipeFromUrl('https://cooking.example.com/recipes/ragu', source);

    const span = lastSpan();
    // The HOST, not the full URL: enough to tell which sites people import from
    // without carrying the path, which is closer to user content.
    expect(span.name).toBe('Import recipe from cooking.example.com');
    expect(span.children).toEqual(['callExtractRecipeFromUrl']);
    // The only way to tell whether share-to-Salt is actually used (issue #589).
    expect(span.attributes['import.source']).toBe(source);
    expect(span.attributes['import.outcome']).toBe('ok');
    expect(span.errored).toBe(false);
    expect(span.ended).toBe(true);
    // The trace ORIGINATES in the browser; the callable carries the W3C id so the
    // CF + AI sub-tree nests under it rather than re-rooting.
    expect(fs.callExtractRecipeFromUrl.mock.calls[0]![1]).toBe(tracer.traceparent);
  });

  it('falls back to a fixed name when the URL has no host to read', async () => {
    fs.callExtractRecipeFromUrl.mockResolvedValue({ kind: 'ok', value: {} as never });

    await importRecipeFromUrl('not a url at all');

    expect(lastSpan().name).toBe('Import recipe from url');
  });

  it('defaults the source to the button when the caller does not say', async () => {
    fs.callExtractRecipeFromUrl.mockResolvedValue({ kind: 'ok', value: {} as never });

    await importRecipeFromUrl('https://example.com/r');

    expect(lastSpan().attributes['import.source']).toBe('button');
  });

  it('omits the traceparent entirely when tracing is inert', async () => {
    // Best-effort tracing (Rule 10): an inert tracer yields an empty traceparent,
    // and the import must then behave exactly as a bare callable call.
    tracer.traceparent = '';
    fs.callExtractRecipeFromUrl.mockResolvedValue({ kind: 'ok', value: {} as never });

    await importRecipeFromUrl('https://example.com/r');

    expect(fs.callExtractRecipeFromUrl.mock.calls[0]![1]).toBeUndefined();
  });

  it('ends the span even when the adapter rejects', async () => {
    // The adapter never throws (Rule 10), but the `finally` must not depend on
    // that — a leaked root span would silently poison the trace.
    fs.callExtractRecipeFromUrl.mockRejectedValue(new Error('boom'));

    await expect(importRecipeFromUrl('https://example.com/r')).rejects.toThrow('boom');
    expect(lastSpan().ended).toBe(true);
  });
});

describe('the authored-recipe span', () => {
  const INPUT = { intent: 'create', message: 'a loaf' } as never;

  it('names the span after the recipe when the caller knows the title', async () => {
    fs.callAuthorRecipe.mockResolvedValue({ kind: 'ok', value: {} as never });

    await authorRecipeTraced(INPUT, '  Overnight white tin  ');

    const span = lastSpan();
    // Bounded family-shared content is allowed in a span name, and trimmed.
    expect(span.name).toBe('Author recipe: Overnight white tin');
    expect(span.children).toEqual(['callAuthorRecipe']);
    expect(fs.callAuthorRecipe.mock.calls[0]![1]).toBe(tracer.traceparent);
  });

  it.each([
    ['no hint at all', undefined],
    ['a hint that is only whitespace', '   '],
  ])('falls back to the bare name given %s', async (_case, hint) => {
    fs.callAuthorRecipe.mockResolvedValue({ kind: 'ok', value: {} as never });

    await authorRecipeTraced(INPUT, hint);

    expect(lastSpan().name).toBe('Author recipe');
  });

  it('carries its own attribute key, and returns the result unwrapped', async () => {
    const authored = { id: 'r-1', title: 'Overnight white tin' };
    fs.callAuthorRecipe.mockResolvedValue({ kind: 'ok', value: authored as never });

    const result = await authorRecipeTraced(INPUT);

    // `author.outcome`, NOT `import.outcome` — this is not an import, and the two
    // must not be conflated by a shared helper that hard-codes one key.
    expect(lastSpan().attributes['author.outcome']).toBe('ok');
    expect(lastSpan().attributes['import.outcome']).toBeUndefined();
    expect(lastSpan().errored).toBe(false);
    // Returned as-is, not re-wrapped in a fresh success().
    expect(result).toEqual({ kind: 'ok', value: authored });
  });

  it('labels a failure with the error KIND, and never reports it', async () => {
    fs.callAuthorRecipe.mockResolvedValue({ kind: 'err', error: SIGNED_OUT });

    const result = await authorRecipeTraced(INPUT);

    const span = lastSpan();
    // The error's `kind`, not `importOutcomeLabel` — authoring has no import
    // codes to prefer, so the category is the whole answer.
    expect(span.attributes['author.outcome']).toBe('AuthError');
    expect(span.errored).toBe(true);
    expect(span.ended).toBe(true);
    expect(result).toEqual({ kind: 'err', error: SIGNED_OUT });
    // The import paths call `reportImportFailure` inside the span's lifetime.
    // This one deliberately does not — there is no import copy to choose and no
    // second surface to keep in agreement.
    expect(report).not.toHaveBeenCalled();
  });

  it('ends the span even when the adapter rejects', async () => {
    fs.callAuthorRecipe.mockRejectedValue(new Error('boom'));

    await expect(authorRecipeTraced(INPUT)).rejects.toThrow('boom');
    expect(lastSpan().ended).toBe(true);
  });
});
