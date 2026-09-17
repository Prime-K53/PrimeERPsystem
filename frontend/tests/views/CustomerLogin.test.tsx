/**
 * CustomerLogin.test.tsx — customer portal login page.
 *
 * Regression coverage for the fixed 2FA handoff bug: when the server
 * answers `requiresTwoFactor`, the Verify button must become usable
 * (previously `submitting` was never reset, leaving it disabled).
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockNavigate, mockLoginWithApi } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockLoginWithApi: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../context/CustomerAuthContext', () => ({
  useCustomerAuth: () => ({ loginWithApi: mockLoginWithApi }),
}));

import CustomerLogin from '../../views/portal/CustomerLogin';

function renderPortalLogin() {
  return render(
    <MemoryRouter>
      <CustomerLogin />
    </MemoryRouter>,
  );
}

function fillPortalCredentials(email = 'you@company.com', password = 's3cret!pw') {
  fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: password } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoginWithApi.mockResolvedValue({ success: true });
});

describe('customer portal Login', () => {
  it('signs in and navigates to the portal dashboard on success', async () => {
    renderPortalLogin();
    fillPortalCredentials();
    fireEvent.click(screen.getByRole('button', { name: /sign in to customer portal/i }));
    await waitFor(() =>
      expect(mockLoginWithApi).toHaveBeenCalledWith('you@company.com', 's3cret!pw'),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/portal/dashboard', { replace: true });
  });

  it('shows an error and clears the password on failure', async () => {
    mockLoginWithApi.mockResolvedValue({ success: false, message: 'Email or password is incorrect' });
    renderPortalLogin();
    fillPortalCredentials();
    fireEvent.click(screen.getByRole('button', { name: /sign in to customer portal/i }));
    expect(await screen.findByText(/email or password is incorrect/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toHaveValue('');
  });

  it('enables the Verify button after the server requests two-factor auth', async () => {
    mockLoginWithApi.mockResolvedValueOnce({
      success: false,
      requiresTwoFactor: true,
      pendingToken: 'pending-123',
    });
    renderPortalLogin();
    fillPortalCredentials();
    fireEvent.click(screen.getByRole('button', { name: /sign in to customer portal/i }));

    const codeInput = await screen.findByLabelText(/verification code/i);
    fireEvent.change(codeInput, { target: { value: '654321' } });
    const verify = screen.getByRole('button', { name: /verify & sign in/i });
    // Regression: submitting was never reset on the 2FA handoff, so this
    // button stayed disabled and sign-in could never complete.
    expect(verify).toBeEnabled();

    mockLoginWithApi.mockResolvedValueOnce({ success: true });
    fireEvent.click(verify);
    await waitFor(() =>
      expect(mockLoginWithApi).toHaveBeenCalledWith('you@company.com', 's3cret!pw', '654321'),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/portal/dashboard', { replace: true });
  });

  it('toggles password visibility', () => {
    renderPortalLogin();
    const password = screen.getByLabelText(/^password/i) as HTMLInputElement;
    expect(password.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: /show password/i }));
    expect(password.type).toBe('text');
  });
});
