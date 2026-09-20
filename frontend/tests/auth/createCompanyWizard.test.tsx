/**
 * createCompanyWizard.test.tsx — Create-company signup is a 3-step wizard
 * (Company → Admin → Review) that renders inside the shared split-card
 * AuthLayout shell and only submits from the final step.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreateCompany from '../../views/auth/CreateCompany';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    companyConfig: { companyName: '', currencySymbol: 'K' },
    completeSetup: vi.fn(),
    validatePasswordStrength: () => ({ valid: true, errors: [] }),
    signUpSupabase: vi.fn(),
  }),
}));

const renderWizard = () =>
  render(
    <MemoryRouter>
      <CreateCompany />
    </MemoryRouter>,
  );

describe('CreateCompany wizard', () => {
  it('starts on step 1 with company fields only', () => {
    renderWizard();
    expect(screen.getByRole('heading', { name: 'Create new company' })).toBeTruthy();
    expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();
    expect(screen.getByLabelText('Company name')).toBeInTheDocument();
    // Admin fields are not mounted until step 2.
    expect(screen.queryByLabelText('Full name')).toBeNull();
    expect(screen.queryByText('Review & confirm')).toBeNull();
  });

  it('renders the stepper with all three stage labels', () => {
    renderWizard();
    const stepper = screen.getByLabelText('Signup progress');
    for (const label of ['Company', 'Admin', 'Review']) {
      expect(within(stepper).getByText(label)).toBeTruthy();
    }
  });

  it('blocks Continue until the company name is valid, then advances', () => {
    renderWizard();
    const continueBtn = screen.getByRole('button', { name: /Continue/ });
    expect(continueBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Prime Printing Service' } });
    expect(continueBtn).not.toBeDisabled();

    fireEvent.click(continueBtn);
    expect(screen.getByText(/Step 2 of 3/)).toBeTruthy();
    expect(screen.getByLabelText('Full name')).toBeInTheDocument();
  });

  it('validates the admin step before reaching the review step', () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Prime Printing Service' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    const adminContinue = screen.getByRole('button', { name: /Continue/ });
    expect(adminContinue).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Jane Admin' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'jane.admin' } });
    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'jane@company.mw' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'secret123' } });
    expect(adminContinue).not.toBeDisabled();

    fireEvent.click(adminContinue);
    expect(screen.getByText(/Step 3 of 3/)).toBeTruthy();
    expect(screen.getByText('Review & confirm')).toBeTruthy();
    // Only the final step exposes the submit action.
    expect(screen.getByRole('button', { name: /Create Company/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue →' })).toBeNull();
  });

  it('lets the user go back a step and keeps entered values', () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'Prime Printing Service' } });
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    fireEvent.click(screen.getByRole('button', { name: /← Back/ }));

    expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();
    expect((screen.getByLabelText('Company name') as HTMLInputElement).value).toBe('Prime Printing Service');
  });
});
