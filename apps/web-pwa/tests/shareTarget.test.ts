import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

// Web Share Target (issue #589). The manifest declares a GET target on '/', so the
// shared payload arrives as a query string that main.ts captures at boot and the
// app imports once auth resolves. `share_target` itself can't be driven from
// Playwright (the share sheet is OS-level), so this is the automated coverage:
// param parsing, the URL-cleaning boot hook, and the import hand-off.

const importRecipeFromUrl = vi.fn();
const stashImportedDraft = vi.fn();
const stashPendingImportUrl = vi.fn();
const push = vi.fn(async (_path: string) => {});

vi.mock('svelte-spa-router', () => ({ push: (p: string) => push(p) }));
vi.mock('../src/lib/recipeService.js', () => ({
  importRecipeFromUrl: (url: string, source?: string) => importRecipeFromUrl(url, source),
  stashImportedDraft: (draft: unknown) => stashImportedDraft(draft),
  urlImportMessage: (outcome: { kind: string; code?: string }) =>
    `friendly:${outcome.code ?? outcome.kind}`,
  isSignedOutFailure: (outcome: { kind: string }) => outcome.kind === 'AuthError',
  stashPendingImportUrl: (url: string) => stashPendingImportUrl(url),
}));

async function loadModule() {
  return import('../src/lib/shareTarget.js');
}

// jsdom won't navigate, so stand in a settable location and a replaceState spy.
let replaceState: ReturnType<typeof vi.fn>;

function setUrl(search: string, hash = '#/'): void {
  replaceState = vi.fn();
  vi.stubGlobal('location', { pathname: '/', search, hash, href: `/${search}${hash}` });
  vi.stubGlobal('history', { state: null, replaceState });
}

beforeEach(() => {
  vi.resetModules();
  importRecipeFromUrl.mockReset();
  stashImportedDraft.mockReset();
  push.mockReset();
  push.mockResolvedValue(undefined);
  setUrl('');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractSharedUrl', () => {
  it('takes the clean link from `url`', async () => {
    const { extractSharedUrl } = await loadModule();
    const params = new URLSearchParams({ url: 'https://example.com/recipe', text: 'look' });
    expect(extractSharedUrl(params)).toBe('https://example.com/recipe');
  });

  it('pulls the first link out of a caption in `text`', async () => {
    const { extractSharedUrl } = await loadModule();
    const params = new URLSearchParams({
      text: 'Best carbonara https://example.com/pasta?a=1 — try it https://other.com/x',
    });
    expect(extractSharedUrl(params)).toBe('https://example.com/pasta?a=1');
  });

  it('falls back to `title` when url and text carry no link', async () => {
    const { extractSharedUrl } = await loadModule();
    const params = new URLSearchParams({ text: 'no link here', title: 'see http://example.com/r' });
    expect(extractSharedUrl(params)).toBe('http://example.com/r');
  });

  it('trims trailing punctuation that hugs a shared link', async () => {
    const { extractSharedUrl } = await loadModule();
    const params = new URLSearchParams({ text: 'try (https://example.com/recipe).' });
    expect(extractSharedUrl(params)).toBe('https://example.com/recipe');
  });

  it('returns null when there is no URL at all', async () => {
    const { extractSharedUrl } = await loadModule();
    expect(extractSharedUrl(new URLSearchParams({ text: 'dinner tonight?' }))).toBeNull();
  });

  it('ignores non-http schemes', async () => {
    const { extractSharedUrl } = await loadModule();
    const params = new URLSearchParams({ text: 'mailto:chef@example.com ftp://example.com/x' });
    expect(extractSharedUrl(params)).toBeNull();
  });
});

describe('captureShareTarget', () => {
  it('captures the share, strips the query, and boots onto Recipes', async () => {
    // The default route is the shopping list — landing there and then silently
    // jumping away once the import finishes is what this rewrite prevents.
    setUrl('?url=https%3A%2F%2Fexample.com%2Fr', '#/shopping');
    const { captureShareTarget, takePendingShare } = await loadModule();
    captureShareTarget();

    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/recipes');
    expect(takePendingShare()).toEqual({ url: 'https://example.com/r' });
  });

  it('captures a linkless share so the app can explain itself', async () => {
    setUrl('?text=dinner+tonight');
    const { captureShareTarget, takePendingShare } = await loadModule();
    captureShareTarget();
    expect(takePendingShare()).toEqual({ url: null });
  });

  it('ignores a non-share query string and leaves the URL alone', async () => {
    setUrl('?apiKey=abc&mode=select');
    const { captureShareTarget, takePendingShare } = await loadModule();
    captureShareTarget();

    expect(replaceState).not.toHaveBeenCalled();
    expect(takePendingShare()).toBeNull();
  });

  it('is single-use, so a re-read cannot re-import', async () => {
    setUrl('?url=https%3A%2F%2Fexample.com%2Fr');
    const { captureShareTarget, takePendingShare } = await loadModule();
    captureShareTarget();

    expect(takePendingShare()).not.toBeNull();
    expect(takePendingShare()).toBeNull();
  });
});

describe('runPendingShareImport', () => {
  async function loadWithShare(search: string) {
    setUrl(search);
    const mod = await loadModule();
    mod.captureShareTarget();
    const { toasts } = await import('../src/lib/toastStore.js');
    return { ...mod, toasts };
  }

  it('does nothing when no share was captured', async () => {
    const { runPendingShareImport } = await loadModule();
    await runPendingShareImport(true);
    expect(importRecipeFromUrl).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('routes onto the page of the recipe the callable already persisted', async () => {
    // Since #616 the CF writes the recipe, so the client opens an EXISTING id
    // rather than creating one at /recipes/new — and since issue #1319 Phase 7 it
    // opens the recipe's own page, where the unreviewed banner lives and
    // everything is editable in place, rather than a separate editor.
    const draft = { id: 'r1', title: 'Carbonara' };
    importRecipeFromUrl.mockResolvedValue({ kind: 'ok', value: draft });
    const { runPendingShareImport } = await loadWithShare('?url=https%3A%2F%2Fexample.com%2Fr');

    await runPendingShareImport(true);

    expect(importRecipeFromUrl).toHaveBeenCalledWith('https://example.com/r', 'share');
    expect(stashImportedDraft).toHaveBeenCalledWith(draft);
    expect(push).toHaveBeenCalledWith('/recipes/r1');
  });

  it('says an import is running for the whole extraction, then takes it down', async () => {
    // The user has to be told something is happening: this runs at boot from the
    // share sheet and the extraction takes several seconds. A toast, not an
    // in-page banner — whatever route is up is usually still loading, and
    // ListPage renders a bare spinner in place of its content while it syncs.
    let finish: (r: unknown) => void = () => {};
    importRecipeFromUrl.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const mod = await loadWithShare('?url=https%3A%2F%2Fwww.example.com%2Fr');

    const running = mod.runPendingShareImport(true);
    const live = get(mod.toasts);
    expect(live).toHaveLength(1);
    expect(live[0]!.message).toBe('Importing recipe from example.com in the background…');

    finish({ kind: 'ok', value: { id: 'r1', title: 'Carbonara' } });
    await running;

    // Taken down on completion rather than left to time out.
    expect(get(mod.toasts)).toHaveLength(0);
  });

  it('degrades to a toast (not an unhandled rejection) if the import throws', async () => {
    importRecipeFromUrl.mockRejectedValue(new Error('boom'));
    const mod = await loadWithShare('?url=https%3A%2F%2Fexample.com%2Fr');

    await expect(mod.runPendingShareImport(true)).resolves.toBeUndefined();
    expect(get(mod.toasts).at(-1)?.message).toMatch(/could not import that link/i);
    expect(push).toHaveBeenCalledWith('/recipes');
  });

  it('shows the friendly message and lands on Recipes when the import fails', async () => {
    importRecipeFromUrl.mockResolvedValue({
      kind: 'err',
      error: { kind: 'ImportError', code: 'not-a-recipe' },
    });
    const { runPendingShareImport, toasts } = await loadWithShare(
      '?url=https%3A%2F%2Fexample.com%2Fr',
    );

    await runPendingShareImport(true);

    expect(stashImportedDraft).not.toHaveBeenCalled();
    expect(stashPendingImportUrl).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/recipes');
    expect(get(toasts).at(-1)?.message).toBe('friendly:not-a-recipe');
  });

  // A share that dies on a dead session hands the link on rather than dropping it
  // (issue #740): the user came from another app, so re-copying may mean going
  // back to find the link again.
  it('rescues the shared link for the import sheet when the session has died', async () => {
    importRecipeFromUrl.mockResolvedValue({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'unauthenticated' },
    });
    const { runPendingShareImport, toasts } = await loadWithShare(
      '?url=https%3A%2F%2Fexample.com%2Fr',
    );

    await runPendingShareImport(true);

    expect(stashPendingImportUrl).toHaveBeenCalledWith('https://example.com/r');
    expect(push).toHaveBeenCalledWith('/recipes');
    expect(get(toasts).at(-1)?.message).toBe('friendly:AuthError');
  });

  it('explains a linkless share instead of firing a doomed import', async () => {
    const { runPendingShareImport, toasts } = await loadWithShare('?text=dinner+tonight');

    await runPendingShareImport(true);

    expect(importRecipeFromUrl).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/recipes');
    expect(get(toasts).at(-1)?.message).toMatch(/web link/i);
  });

  it('drops the share with a toast when signed out', async () => {
    const { runPendingShareImport, toasts } = await loadWithShare(
      '?url=https%3A%2F%2Fexample.com%2Fr',
    );

    await runPendingShareImport(false);

    expect(importRecipeFromUrl).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(get(toasts).at(-1)?.message).toMatch(/sign in/i);
  });

  it('says where the recipe landed if navigation fails', async () => {
    // The recipe is safely persisted by then, so a failed navigation is cosmetic
    // — the toast points at it rather than implying the import was lost.
    importRecipeFromUrl.mockResolvedValue({ kind: 'ok', value: { id: 'r1', title: 'Carbonara' } });
    push.mockRejectedValue(new Error('no route'));
    const { runPendingShareImport, toasts } = await loadWithShare(
      '?url=https%3A%2F%2Fexample.com%2Fr',
    );

    await runPendingShareImport(true);

    expect(get(toasts).at(-1)?.message).toMatch(/imported "Carbonara" — find it in Recipes/i);
  });
});
