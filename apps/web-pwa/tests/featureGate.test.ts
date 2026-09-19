import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';

// The app's single question — "is this feature on for me?" (issue #831).
//
// The adapter's own suite owns the never-throws / fail-closed semantics; what this
// one pins is the layer above: that the app asks with the right flag key, that the
// store re-evaluates when a payload lands (rather than answering once at boot and
// going stale), and that one feature means one flag subscription however many
// screens are watching.

const { isEnabled, settled, onFlags } = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  settled: vi.fn(),
  onFlags: vi.fn(),
}));

vi.mock('@salt/observability', () => ({
  isObservabilityFeatureEnabled: isEnabled,
  areObservabilityFeatureFlagsSettled: settled,
  onObservabilityFeatureFlags: onFlags,
  // The flag key itself now comes from the adapter too (issue #1054), so the
  // whole-module mock has to carry it. Its REAL value, because the assertions
  // below check which key the adapter was asked about — a stub value here would
  // make them agree with themselves and prove nothing.
  BREAD_FLAG_KEY: 'bread',
  LIBRARY_FLAG_KEY: 'library',
  CHAT_SAVE_FLAG_KEY: 'chat-save',
}));

// Module state (the memoised store map, the shared revision store) is per-import,
// so each case takes a fresh copy.
type GateModule = typeof import('../src/lib/featureGate.js');

async function fresh(): Promise<GateModule> {
  vi.resetModules();
  return import('../src/lib/featureGate.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  isEnabled.mockReturnValue(true);
  settled.mockReturnValue(true);
  onFlags.mockImplementation(() => () => {});
});

describe('isFeatureEnabled', () => {
  it('asks the adapter for the feature’s PostHog flag key', async () => {
    const { isFeatureEnabled } = await fresh();

    expect(isFeatureEnabled('bread')).toBe(true);
    expect(isEnabled).toHaveBeenCalledWith('bread');
  });

  it('passes the adapter’s answer straight through when the flag is off', async () => {
    isEnabled.mockReturnValue(false);
    const { isFeatureEnabled } = await fresh();

    expect(isFeatureEnabled('bread')).toBe(false);
  });
});

describe('featureGate store', () => {
  it('reports the flag and whether the answer has arrived', async () => {
    isEnabled.mockReturnValue(false);
    settled.mockReturnValue(false);
    const { featureGate } = await fresh();

    expect(get(featureGate('bread'))).toEqual({ enabled: false, settled: false });
  });

  it('re-evaluates when PostHog delivers a payload', async () => {
    // The reason this is a store at all: the flag values live inside the SDK, so
    // an answer read once at boot would be wrong for the whole session that a
    // late-arriving payload turns on.
    let deliver: (() => void) | null = null;
    onFlags.mockImplementation((cb: () => void) => {
      deliver = cb;
      return () => {};
    });
    isEnabled.mockReturnValue(false);
    settled.mockReturnValue(false);
    const { featureGate } = await fresh();

    const seen: { enabled: boolean; settled: boolean }[] = [];
    const off = featureGate('bread').subscribe((v) => seen.push({ ...v }));

    isEnabled.mockReturnValue(true);
    settled.mockReturnValue(true);
    deliver!();
    off();

    expect(seen.at(0)).toEqual({ enabled: false, settled: false });
    expect(seen.at(-1)).toEqual({ enabled: true, settled: true });
  });

  it('memoises one store — and so one flag subscription — per feature', async () => {
    const { featureGate, breadGate } = await fresh();

    expect(featureGate('bread')).toBe(featureGate('bread'));
    // The exported convenience handle is that same store, not a second subscriber.
    expect(breadGate).toBe(featureGate('bread'));

    const a = featureGate('bread').subscribe(() => {});
    const b = featureGate('bread').subscribe(() => {});
    a();
    b();

    expect(onFlags).toHaveBeenCalledOnce();
  });

  it('unsubscribes from the adapter when the last subscriber leaves', async () => {
    const unsubscribe = vi.fn();
    onFlags.mockReturnValue(unsubscribe);
    const { featureGate } = await fresh();

    featureGate('bread').subscribe(() => {})();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
