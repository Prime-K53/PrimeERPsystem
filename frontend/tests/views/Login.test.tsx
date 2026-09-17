/**
 * Login.test.tsx — admin login page.
 *
 * Covers the gaps fixed in this pass:
 * - submit stays disabled until email + password are non-empty
 * - invalid email format shows a field error and never hits the API
 * - successful API login establishes the session and navigates home
 * - API 401 falls back to the legacy provider; INVALID shows an error
 *   and clears the password field
 * - legacy MFA_REQUIRED switches to the verification-code step, and the
 *   code can be submitted to complete sign-in
 * - legacy EXPIRED shows the expired-password message
 * - an already-authenticated visit redirects home
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockNavigate, mockUseAuth, mockApiLogin } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUseAuth: vi.fn(),
  mockApiLogin: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../context/AuthContext', () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));

vi.mock('../../services/authApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/authApiClient')>();
  return { ...actual, loginWithApi: mockApiLogin };
});

import Login from '../../views/auth/Login';
import { ApiError } from '../../services/authApiClient';

const establishSession = vi.fn();
const legacyLogin = vi.fn();

function renderLogin() {
  return render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );
}

function fillCredentials(email = 'admin@company.com', password = 's3cret!pw') {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: password } });
}

beforeEach(() => {
  vi.clearAllMocks();
  establishSession.mockResolvedValue(undefined);
  legacyLogin.mockResolvedValue('INVALID');
  mockUseAuth.mockReturnValue({ user: null, loginWithApi: establishSession, login: legacyLogin });
  mockApiLogin.mockResolvedValue({
    user: { id: 'u1', username: 'admin@company.com', email: 'admin@company.com', role: 'Admin' },
    token: 'tok-123',
  });
});

describe('admin Login', () => {
  it('keeps Sign In disabled until email and password are entered', () => {
    renderLogin();
    const submit = screen.getByRole('button', { name: /sign in/i });
    expect(submit).toBeDisabled();
    fillCredentials();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
  });

  it('shows a field error for an invalid email and never calls the API', () => {
    renderLogin();
    fillCredentials('not-an-email', 's3cret!pw');
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/valid email/i);
    expect(mockApiLogin).not.toHaveBeenCalled();
    expect(legacyLogin).not.toHaveBeenCalled();
  });

  it('establishes the session and navigates home on API success', async () => {
    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(establishSession).toHaveBeenCalledTimes(1));
    const [sessionUser, token] = establishSession.mock.calls[0];
    expect(sessionUser.email).toBe('admin@company.com');
    expect(token).toBe('tok-123');
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('falls back to legacy login on API 401 and shows an error for INVALID', async () => {
    mockApiLogin.mockRejectedValue(new ApiError('Email or password is incorrect', 401, { message: 'Email or password is incorrect' }));
    legacyLogin.mockResolvedValue('INVALID');
    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(legacyLogin).toHaveBeenCalledWith('admin@company.com', 's3cret!pw', undefined));
    expect(await screen.findByText(/invalid credentials/i)).toBeInTheDocument();
    // Password is cleared after a failed attempt; the email is kept.
    expect(screen.getByLabelText(/^password/i)).toHaveValue('');
    expect(screen.getByLabelText(/email/i)).toHaveValue('admin@company.com');
  });

  it('switches to the MFA step when legacy login requires it, then completes sign-in', async () => {
    mockApiLogin.mockRejectedValue(new ApiError('Unauthorized', 401, {}));
    legacyLogin.mockResolvedValueOnce('MFA_REQUIRED').mockResolvedValueOnce('SUCCESS');
    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    const codeInput = await screen.findByLabelText(/verification code/i);
    expect(codeInput).toBeInTheDocument();
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify & sign in/i }));
    await waitFor(() =>
      expect(legacyLogin).toHaveBeenCalledWith('admin@company.com', 's3cret!pw', '123456'),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('shows the expired-password message for EXPIRED', async () => {
    mockApiLogin.mockRejectedValue(new ApiError('Unauthorized', 401, {}));
    legacyLogin.mockResolvedValue('EXPIRED');
    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/password has expired/i)).toBeInTheDocument();
  });

  it('shows a network message when the server cannot be reached', async () => {
    mockApiLogin.mockRejectedValue(new TypeError('Failed to fetch'));
    renderLogin();
    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/cannot reach the server/i)).toBeInTheDocument();
  });

  it('redirects home when already authenticated', () => {
    mockUseAuth.mockReturnValue({
      user: { id: 'u1', email: 'admin@company.com' },
      loginWithApi: establishSession,
      login: legacyLogin,
    });
    renderLogin();
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });
});
