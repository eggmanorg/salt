import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { Member } from '@salt/domain';

// The cook-mode preference, where the person it describes sets it (issue #776).
//
// This is the one field a NON-ADMIN may write on their own member doc, so the
// control has to be honest about what is saved: it reads straight off the member
// store rather than holding local state, which means a refused write reverts by
// itself instead of leaving the UI claiming something Firestore does not agree
// with. The rules half of that contract is proved in
// firebase-sync/tests/firestoreRules.emulator.test.ts, which is where the
// escalation attempts live.

const { mockCurrentMember, mockPush, mockInstall } = await vi.hoisted(async () => {
  const { makeStore } = await import('./support/testStore.js');
  return {
    mockCurrentMember: makeStore<Member | null>(null),
    mockPush: {
      supported: false,
      configured: false,
      enabled: false,
      busy: false,
      permissionDenied: false,
      enable: vi.fn(),
      disable: vi.fn(),
    },
    mockInstall: { isIosSafari: false, isStandalone: true, canPrompt: false, prompt: vi.fn() },
  };
});

vi.mock('svelte-spa-router', () => ({ push: vi.fn() }));
vi.mock('../src/lib/auth.svelte.js', () => ({
  auth: { user: { uid: 'uid-1', email: 'cook@test' } },
}));
vi.mock('../src/lib/membersService.js', () => ({
  currentMember: mockCurrentMember,
  setMyCookMode: vi.fn().mockResolvedValue({ kind: 'ok', value: undefined }),
}));
vi.mock('../src/lib/toastStore.js', () => ({ addToast: vi.fn() }));
vi.mock('../src/lib/push.svelte.js', () => ({ push: mockPush }));
vi.mock('../src/lib/install.svelte.js', () => ({ install: mockInstall }));
vi.mock('../src/lib/observability.js', () => ({ submitFeedback: vi.fn() }));
vi.mock('@salt/firebase-sync', () => ({
  callListPushoverDevices: vi.fn().mockResolvedValue({ kind: 'ok', value: [] }),
}));

import SettingsPage from '../src/routes/settings/SettingsPage.svelte';
import { setMyCookMode } from '../src/lib/membersService.js';
import { addToast } from '../src/lib/toastStore.js';

function member(cookMode: 'standard' | 'guided'): Member {
  return {
    id: 'cook@test',
    schemaVersion: 1,
    name: 'Cook',
    email: 'cook@test',
    admin: false,
    sortOrder: 0,
    icon: null,
    cookMode,
    system: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCurrentMember._set(member('standard'));
});

describe('SettingsPage — when I cook', () => {
  it('shows the mode this person is actually on', () => {
    mockCurrentMember._set(member('guided'));
    render(SettingsPage);

    const guided = screen.getByRole('radio', { name: /Guided/ });
    expect(guided.getAttribute('aria-checked')).toBe('true');
  });

  it('saves the choice', async () => {
    render(SettingsPage);

    await userEvent.click(screen.getByRole('radio', { name: /Guided/ }));
    await waitFor(() => expect(setMyCookMode).toHaveBeenCalledWith('guided'));
  });

  it('saves the way back too', async () => {
    mockCurrentMember._set(member('guided'));
    render(SettingsPage);

    await userEvent.click(screen.getByRole('radio', { name: /Standard/ }));
    await waitFor(() => expect(setMyCookMode).toHaveBeenCalledWith('standard'));
  });

  it('says so when the write is refused', async () => {
    // A deliberate choice the person just made, not background housekeeping —
    // failing silently would leave them believing it was saved.
    vi.mocked(setMyCookMode).mockResolvedValueOnce({
      kind: 'err',
      error: { kind: 'AuthError', reason: 'forbidden' },
    });
    render(SettingsPage);

    await userEvent.click(screen.getByRole('radio', { name: /Guided/ }));
    await waitFor(() => expect(addToast).toHaveBeenCalled());
  });

  it('is not offered to a signed-in user the roster does not know', () => {
    // There is no member doc to write, and firestore.rules would refuse — a
    // control that can only fail is worse than no control.
    mockCurrentMember._set(null);
    render(SettingsPage);

    expect(screen.queryByTestId('settings-cook-mode')).toBeNull();
  });
});
