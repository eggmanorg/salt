import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';

// Mock the auth store, install detection, and firebase env the LoginPage reads.
const { mockAuth, mockInstall } = vi.hoisted(() => ({
  mockAuth: {
    linkSent: false,
    needsEmail: false,
    codeSent: false,
    codeEmail: '',
    error: null as string | null,
    sendLink: vi.fn(async () => {}),
    completeWithEmail: vi.fn(async () => {}),
    requestCode: vi.fn(async () => {}),
    submitCode: vi.fn(async () => {}),
    resetCode: vi.fn(),
  },
  mockInstall: { isStandalone: false, isIosSafari: false, canPromptInstall: false },
}));
vi.mock('../src/lib/auth.svelte.js', () => ({ auth: mockAuth, devSignIn: vi.fn() }));
vi.mock('../src/lib/firebase.js', () => ({ useEmulators: false }));
vi.mock('../src/lib/install.svelte.js', () => ({ install: mockInstall }));

import LoginPage from '../src/components/LoginPage.svelte';

beforeEach(() => {
  cleanup();
  mockAuth.linkSent = false;
  mockAuth.needsEmail = false;
  mockAuth.codeSent = false;
  mockAuth.codeEmail = '';
  mockAuth.error = null;
  mockInstall.isStandalone = false;
  vi.clearAllMocks();
});

describe('LoginPage — email OTP (#546)', () => {
  it('leads with magic link off-standalone, offering the code path as an alternative', () => {
    render(LoginPage);
    expect(screen.getByText('Send magic link')).toBeInTheDocument();
    expect(screen.getByTestId('login-switch-to-code')).toBeInTheDocument();
    expect(screen.queryByTestId('login-request-code')).not.toBeInTheDocument();
  });

  it('leads with the code path when running standalone (installed iOS)', () => {
    mockInstall.isStandalone = true;
    render(LoginPage);
    expect(screen.getByTestId('login-request-code')).toBeInTheDocument();
    expect(screen.getByTestId('login-switch-to-link')).toBeInTheDocument();
    expect(screen.queryByText('Send magic link')).not.toBeInTheDocument();
  });

  it('sends a magic link for the entered email', async () => {
    render(LoginPage);
    await userEvent.type(screen.getByLabelText('Email'), 'cook@example.com');
    await userEvent.click(screen.getByText('Send magic link'));
    expect(mockAuth.sendLink).toHaveBeenCalledWith('cook@example.com');
    expect(mockAuth.requestCode).not.toHaveBeenCalled();
  });

  it('switches from magic link to the code method', async () => {
    render(LoginPage);
    await userEvent.click(screen.getByTestId('login-switch-to-code'));
    expect(screen.getByTestId('login-request-code')).toBeInTheDocument();
  });

  it('requests a code for the entered email', async () => {
    mockInstall.isStandalone = true;
    render(LoginPage);
    await userEvent.type(screen.getByLabelText('Email'), 'cook@example.com');
    await userEvent.click(screen.getByTestId('login-request-code'));
    expect(mockAuth.requestCode).toHaveBeenCalledWith('cook@example.com');
  });

  it('shows the code-entry step and verifies the entered code', async () => {
    mockAuth.codeSent = true;
    render(LoginPage);
    const input = screen.getByTestId('login-code-input');
    await userEvent.type(input, '123456');
    await userEvent.click(screen.getByTestId('login-verify-code'));
    expect(mockAuth.submitCode).toHaveBeenCalledWith('', '123456');
  });

  it('verifies against the restored email when the app relaunched on the code step', async () => {
    // The iOS case: the app was killed while the user fetched the code, so the
    // form's own email state is empty and the address comes from the store.
    mockAuth.codeSent = true;
    mockAuth.codeEmail = 'cook@example.com';
    render(LoginPage);
    expect(screen.getByText('cook@example.com')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('login-code-input'), '123456');
    await userEvent.click(screen.getByTestId('login-verify-code'));
    expect(mockAuth.submitCode).toHaveBeenCalledWith('cook@example.com', '123456');
  });

  it('lets the user go back to change email from the code step', async () => {
    mockAuth.codeSent = true;
    render(LoginPage);
    await userEvent.click(screen.getByTestId('login-change-email'));
    expect(mockAuth.resetCode).toHaveBeenCalledTimes(1);
  });
});
