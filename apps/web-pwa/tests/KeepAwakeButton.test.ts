import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';

// The keep-awake button (issue #1620): the title bar's and each cook screen's.
// They are views of ONE switch, so the load-bearing tests render two and flip
// one, and unmount one and check the other is untouched.

const { mockWakeLock, mockSupported } = vi.hoisted(() => ({
  mockWakeLock: { enable: vi.fn(async () => true), disable: vi.fn(async () => {}) },
  mockSupported: { value: true },
}));

vi.mock('../src/lib/wakeLock.js', () => ({
  isWakeLockSupported: vi.fn(() => mockSupported.value),
  createWakeLock: vi.fn(() => mockWakeLock),
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));

import KeepAwakeButton from '../src/components/KeepAwakeButton.svelte';
import { __resetKeepAwakeForTest } from '../src/lib/keepAwake.svelte.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockSupported.value = true;
  __resetKeepAwakeForTest();
});

afterEach(() => {
  cleanup();
});

describe('KeepAwakeButton', () => {
  it('renders nothing where the browser has no Screen Wake Lock', () => {
    mockSupported.value = false;
    render(KeepAwakeButton, { props: { placement: 'bar', 'data-testid': 'bar' } });

    expect(screen.queryByTestId('bar')).toBeNull();
  });

  it('is one switch shown twice: flipping one lights the other', async () => {
    render(KeepAwakeButton, { props: { placement: 'bar', 'data-testid': 'bar' } });
    render(KeepAwakeButton, { props: { placement: 'cook', 'data-testid': 'cook' } });

    await fireEvent.click(screen.getByTestId('cook'));

    await waitFor(() => expect(screen.getByTestId('bar')).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByTestId('cook')).toHaveAttribute('aria-pressed', 'true');
    expect(mockWakeLock.enable).toHaveBeenCalledTimes(1);
  });

  it('does not let the screen sleep when one of its buttons unmounts', async () => {
    render(KeepAwakeButton, { props: { placement: 'bar', 'data-testid': 'bar' } });
    const cook = render(KeepAwakeButton, { props: { placement: 'cook', 'data-testid': 'cook' } });
    await fireEvent.click(screen.getByTestId('cook'));
    await waitFor(() => expect(screen.getByTestId('bar')).toHaveAttribute('aria-pressed', 'true'));

    cook.unmount();

    expect(mockWakeLock.disable).not.toHaveBeenCalled();
    expect(screen.getByTestId('bar')).toHaveAttribute('aria-pressed', 'true');
  });

  it('leaves it off when the browser refuses', async () => {
    mockWakeLock.enable.mockResolvedValueOnce(false);
    render(KeepAwakeButton, { props: { placement: 'bar', 'data-testid': 'bar' } });

    await fireEvent.click(screen.getByTestId('bar'));

    await waitFor(() => expect(mockWakeLock.enable).toHaveBeenCalled());
    expect(screen.getByTestId('bar')).toHaveAttribute('aria-pressed', 'false');
  });

  // The title bar's surface is four colours (prod plus three environment banners,
  // staging's amber among them), so ON must be drawn by an outline in the bar's own
  // colour, never by a colour of its own.
  it('in the title bar, shows ON by outline and tint in the bar colour, not a hue', async () => {
    render(KeepAwakeButton, { props: { placement: 'bar', 'data-testid': 'bar' } });
    const button = screen.getByTestId('bar');
    expect(button.className).not.toContain('border-current');

    await fireEvent.click(button);

    await waitFor(() => expect(button.className).toContain('border-current'));
    expect(button.className).toContain('bg-current/15');
    expect(button.innerHTML).not.toContain('text-warning');
  });

  it('in a cook header, shows ON in the warning colour', async () => {
    render(KeepAwakeButton, { props: { placement: 'cook', 'data-testid': 'cook' } });
    const button = screen.getByTestId('cook');
    expect(button.innerHTML).toContain('text-muted-foreground');

    await fireEvent.click(button);

    await waitFor(() => expect(button.innerHTML).toContain('text-warning'));
  });
});
