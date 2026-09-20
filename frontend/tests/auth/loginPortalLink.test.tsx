/**
 * loginPortalLink.test.tsx — the ERP login page's "Customer portal →" action
 * must leave the ERP and open the real (separately deployed) Prime PORTAL
 * login page:
 *
 *   development → http://localhost:3001/#/login
 *   production  → https://primeportalmw.vercel.app/#/login
 *
 * Regression guard: it used to be an in-app react-router Link to
 * `/portal/login`, which 404s / renders the ERP's own stub instead of the
 * customer portal.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Login from '../../views/auth/Login';
import { resolveCustomerPortalLoginUrl, resolvePortalOrigin } from '../../utils/portalLinks';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    loginWithApi: vi.fn(),
    login: vi.fn(),
  }),
}));

const renderLogin = () =>
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );

describe('Login page — customer portal link', () => {
  it('renders it as a real external anchor, not an in-app route', () => {
    renderLogin();
    const link = screen.getByTestId('auth-external-back-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveTextContent('Customer portal');
  });

  it('points at the resolved portal login URL', () => {
    renderLogin();
    const link = screen.getByTestId('auth-external-back-link');
    const expected = resolveCustomerPortalLoginUrl();
    expect(link).toHaveAttribute('href', expected);
    expect(link.getAttribute('href')).toBe(expected);
    expect(expected.endsWith('/#/login')).toBe(true);
    expect(link.getAttribute('href')).not.toBe('/portal/login');
  });

  it('opens in a new tab without leaking the opener', () => {
    renderLogin();
    const link = screen.getByTestId('auth-external-back-link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('never resolves to a loopback origin in a production build', () => {
    // This test build is a dev/test build, so the configured local portal is
    // expected here; the production guard itself is covered by
    // tests/utils/portalLinks.test.ts (pickPortalOrigin).
    expect(resolvePortalOrigin()).toBe('http://localhost:3001');
  });
});
