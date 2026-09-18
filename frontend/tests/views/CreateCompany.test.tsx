/**
 * CreateCompany.test.tsx — create-new-company page reachable from login.
 *
 * - renders company + admin sections with a back-to-login link
 * - blocks submit until required fields are valid
 * - shows a field error when passwords don't match (no API call)
 * - surfaces a backend 409 duplicate as an error and never completes setup
 * - on success calls register-company, provisions the workspace via
 *   completeSetup, and navigates home
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockNavigate, mockUseAuth, mockRegisterCompany } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockUseAuth: vi.fn(),
  mockRegisterCompany: vi.fn(),
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
  return { ...actual, registerCompany: mockRegisterCompany };
});

vi.mock('../../services/api', () => ({
  api: { system: { createFinancialYear: vi.fn().mockResolvedValue({}) } },
}));

import CreateCompany from '../../views/auth/CreateCompany';
import Login from '../../views/auth/Login';
import { ApiError } from '../../services/authApiClient';

const completeSetup = vi.fn();
const signUpSupabase = vi.fn();

function baseAuth() {
  return {
    user: null,
    companyConfig: {},
    completeSetup,
    validatePasswordStrength: () => ({ valid: true, errors: [] as string[] }),
    signUpSupabase,
  };
}

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function fillValidForm() {
  fireEvent.change(screen.getByLabelText(/company name/i), { target: { value: 'Acme Corporation' } });
  fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'jane_admin' } });
  fireEvent.change(screen.getByLabelText(/^email/i), { target: { value: 'jane@acme.com' } });
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 's3cret!pw' } });
  fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 's3cret!pw' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  completeSetup.mockResolvedValue(undefined);
  signUpSupabase.mockResolvedValue({ success: true });
  mockRegisterCompany.mockResolvedValue({
    message: 'Company registered successfully',
    user: { id: 'u1', username: 'jane_admin', email: 'jane@acme.com', role: 'Admin', permissions: [] },
    token: 'tok-123',
    company: { name: 'Acme Corporation' },
  });
  mockUseAuth.mockReturnValue(baseAuth());
});

describe('Create new company entry point', () => {
  it('login page links to the create-company page', () => {
    mockUseAuth.mockReturnValue({ user: null, loginWithApi: vi.fn(), login: vi.fn() });
    renderWithRouter(<Login />);
    const link = screen.getByRole('link', { name: /create new company/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/register-company'));
  });
});

describe('CreateCompany page', () => {
  it('renders company + admin sections with a back link', () => {
    renderWithRouter(<CreateCompany />);
    expect(screen.getByRole('heading', { name: /create new company/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/company name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/login')
    );
  });

  it('keeps submit disabled until required fields are filled', () => {
    renderWithRouter(<CreateCompany />);
    expect(screen.getByRole('button', { name: /create company/i })).toBeDisabled();
    fillValidForm();
    expect(screen.getByRole('button', { name: /create company/i })).toBeEnabled();
  });

  it('shows a field error for mismatched passwords without calling the API', () => {
    renderWithRouter(<CreateCompany />);
    fillValidForm();
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'different!' } });
    fireEvent.click(screen.getByRole('button', { name: /create company/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/don't match/i);
    expect(mockRegisterCompany).not.toHaveBeenCalled();
    expect(completeSetup).not.toHaveBeenCalled();
  });

  it('surfaces a backend duplicate as an error and never completes setup', async () => {
    mockRegisterCompany.mockRejectedValue(new ApiError('An account with this email already exists', 409, {}));
    renderWithRouter(<CreateCompany />);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /create company/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(completeSetup).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('provisions the workspace and navigates home on success', async () => {
    renderWithRouter(<CreateCompany />);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /create company/i }));
    await waitFor(() => expect(mockRegisterCompany).toHaveBeenCalledTimes(1));
    expect(mockRegisterCompany).toHaveBeenCalledWith(
      expect.objectContaining({
        companyName: 'Acme Corporation',
        adminUsername: 'jane_admin',
        adminEmail: 'jane@acme.com',
      })
    );
    await waitFor(() => expect(completeSetup).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('falls through to local setup when the backend is unreachable', async () => {
    mockRegisterCompany.mockRejectedValue(new TypeError('Failed to fetch'));
    renderWithRouter(<CreateCompany />);
    fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: /create company/i }));
    await waitFor(() => expect(completeSetup).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });
});
