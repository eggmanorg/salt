import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Phase 1: silent chunk-load auto-reload with a one-shot guard.
//
// setupPreloadErrorReload() is prod-only (mirrors registerServiceWorker's DEV
// no-op), so every test stubs import.meta.env.DEV = false. We mock
// window.location.reload (jsdom can't navigate) and dispatch the
// `vite:preloadError` event Vite fires when a hashed chunk 404s after a deploy.

const SESSION_KEY = 'salt:pwa:preloadReloadGuard';

let reload: ReturnType<typeof vi.fn>;
let addSpy: ReturnType<typeof vi.spyOn>;

async function loadSetup() {
  const mod = await import('../src/lib/pwa.js');
  return mod;
}

function firePreloadError(): void {
  window.dispatchEvent(new Event('vite:preloadError'));
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DEV', false);

  try {
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }

  reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });

  // Track listeners this test attaches so we can detach them afterwards —
  // window listeners survive Testing Library cleanup and would otherwise leak
  // across tests.
  addSpy = vi.spyOn(window, 'addEventListener');
});

afterEach(() => {
  for (const [type, handler] of addSpy.mock.calls) {
    window.removeEventListener(type as string, handler as EventListener);
  }
  addSpy.mockRestore();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('setupPreloadErrorReload (silent stale-chunk recovery, one-shot)', () => {
  it('reloads once on the first preloadError and sets the surviving-reload guard', async () => {
    const { setupPreloadErrorReload } = await loadSetup();
    setupPreloadErrorReload();

    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();

    firePreloadError();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(SESSION_KEY)).not.toBeNull();
  });

  it('does NOT reload on a second preloadError once the guard is set (no reload loop)', async () => {
    const { setupPreloadErrorReload } = await loadSetup();
    setupPreloadErrorReload();

    firePreloadError();
    expect(reload).toHaveBeenCalledTimes(1);

    // Second stale-chunk failure this session: the guard is set, so we stop.
    firePreloadError();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('treats a guard set BEFORE setup (survived a prior reload) as already tripped', async () => {
    window.sessionStorage.setItem(SESSION_KEY, '1');
    const { setupPreloadErrorReload } = await loadSetup();
    setupPreloadErrorReload();

    firePreloadError();

    expect(reload).not.toHaveBeenCalled();
  });

  it('is a no-op in dev builds', async () => {
    vi.stubEnv('DEV', true);
    const { setupPreloadErrorReload } = await loadSetup();
    setupPreloadErrorReload();

    firePreloadError();

    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('clearPreloadReloadGuard removes the flag so a later deploy gets its own reload', async () => {
    const { setupPreloadErrorReload, clearPreloadReloadGuard } = await loadSetup();
    setupPreloadErrorReload();

    firePreloadError();
    expect(window.sessionStorage.getItem(SESSION_KEY)).not.toBeNull();

    // Successful boot after the reload clears the guard.
    clearPreloadReloadGuard();
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('stands down when another reload is already on its way (shared latch, #1667)', async () => {
    const { setupPreloadErrorReload } = await loadSetup();
    // Same module instance as pwa.ts after loadSetup's resetModules.
    const { reloadPage } = await import('../src/lib/pageReload.js');
    setupPreloadErrorReload();

    // The stuck-write recovery (or the update flow) reloads first.
    reloadPage();
    firePreloadError();

    expect(reload).toHaveBeenCalledTimes(1);
    // Its one-shot guard is not spent on a reload it did not take.
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
