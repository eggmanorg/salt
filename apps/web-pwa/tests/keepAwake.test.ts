import { describe, it, expect, beforeEach, vi } from 'vitest';

// The app-wide keep-awake switch (issue #1620). The platform wrapper underneath
// (`createWakeLock`) is tested on its own in wakeLock.test.ts; here it is a fake,
// and what is asserted is the switch: one controller however many buttons read
// it, the toasts, and that a refusal is never shown as on.

const { mockWakeLock, mockSupported } = vi.hoisted(() => ({
  mockWakeLock: { enable: vi.fn(async () => true), disable: vi.fn(async () => {}) },
  mockSupported: { value: true },
}));

vi.mock('../src/lib/wakeLock.js', () => ({
  isWakeLockSupported: vi.fn(() => mockSupported.value),
  createWakeLock: vi.fn(() => mockWakeLock),
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));

import { keepAwake, __resetKeepAwakeForTest } from '../src/lib/keepAwake.svelte.js';
import { createWakeLock } from '../src/lib/wakeLock.js';
import { addToast } from '../src/lib/toastStore.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockSupported.value = true;
  __resetKeepAwakeForTest();
});

describe('keepAwake', () => {
  it('turns on, confirming only once the browser has granted the lock', async () => {
    await keepAwake.toggle();

    expect(mockWakeLock.enable).toHaveBeenCalledTimes(1);
    expect(keepAwake.held).toBe(true);
    expect(addToast).toHaveBeenCalledWith('Screen will stay awake', 'success');
  });

  it('turns off again, releasing the lock', async () => {
    await keepAwake.toggle();
    await keepAwake.toggle();

    expect(mockWakeLock.disable).toHaveBeenCalledTimes(1);
    expect(keepAwake.held).toBe(false);
    expect(addToast).toHaveBeenLastCalledWith('Screen can sleep again', 'success');
  });

  it('stays off when the browser refuses', async () => {
    mockWakeLock.enable.mockResolvedValueOnce(false);

    await keepAwake.toggle();

    expect(keepAwake.held).toBe(false);
    expect(addToast).toHaveBeenCalledWith(
      "Your browser wouldn't let the screen stay awake.",
      'destructive',
    );
  });

  it('builds one platform controller, however many times it is flipped', async () => {
    await keepAwake.toggle();
    await keepAwake.toggle();
    await keepAwake.toggle();

    expect(createWakeLock).toHaveBeenCalledTimes(1);
  });

  it('ignores a second tap while the first is still settling', async () => {
    let grant: (v: boolean) => void = () => {};
    mockWakeLock.enable.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (grant = resolve)),
    );

    const first = keepAwake.toggle();
    await keepAwake.toggle();
    grant(true);
    await first;

    expect(mockWakeLock.enable).toHaveBeenCalledTimes(1);
    expect(mockWakeLock.disable).not.toHaveBeenCalled();
    expect(keepAwake.held).toBe(true);
  });

  it('reports unsupported, and a tap there claims nothing', async () => {
    mockSupported.value = false;

    expect(keepAwake.supported).toBe(false);
    await keepAwake.toggle();
    expect(createWakeLock).not.toHaveBeenCalled();
    expect(keepAwake.held).toBe(false);
  });
});
