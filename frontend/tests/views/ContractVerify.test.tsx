import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContractVerify from '../../views/portal/ContractVerify';

const baseBodyVerified = {
  verified: true,
  result: 'verified',
  documentVerified: true,
  integrityVerified: true,
  integrityResult: 'Integrity Verified',
  contractNumber: 'PC-P726/023',
  customerName: 'Mtakataka CCAP School',
  contractDate: '2026-09-01',
  status: 'ACTIVE',
  total: 79800,
  currency: 'MWK',
  companyName: 'Prime Printing Service',
};

const setUrl = (query = '') => {
  window.history.replaceState({}, '', `/verify${query}`);
};

const makeFetch = (body: any, ok = true, status = 200) => {
  const fn = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as any;
  vi.stubGlobal('fetch', fn);
  return fn;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ContractVerify independent verification', () => {
  beforeEach(() => {
    setUrl('');
  });

  it('shows both verification checks as successful independently', async () => {
    setUrl('?c=PC-P726-023&h=' + 'a'.repeat(64));
    makeFetch(baseBodyVerified);

    render(<ContractVerify />);

    await waitFor(() => {
      expect(screen.getByText(/Document Verification/i)).toBeInTheDocument();
      expect(screen.getByText(/SHA-256 Integrity Verification/i)).toBeInTheDocument();
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(screen.getByText('Integrity Verified')).toBeInTheDocument();
    });
    expect(screen.getByText(/Verified - matches our records/i)).toBeInTheDocument();
  });

  it('shows document verified but integrity mismatch with the protective warning', async () => {
    setUrl('?c=PC-P726-023&h=' + 'b'.repeat(64));
    makeFetch({
      verified: false,
      result: 'altered',
      documentVerified: true,
      integrityVerified: false,
      integrityResult: 'Integrity Mismatch',
      reason: 'integrity_failed',
      error: 'The contract record does not match the supplied digest.',
    });

    render(<ContractVerify />);

    await waitFor(() => {
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(screen.getByText('Integrity Mismatch')).toBeInTheDocument();
    });
    expect(screen.getByText(/Do not rely on this copy/i)).toBeInTheDocument();
  });

  it('shows Hash Missing and never Integrity Verified when no stored hash exists', async () => {
    setUrl('?c=PC-NEW&h=' + 'c'.repeat(64));
    makeFetch({
      verified: false,
      result: 'altered',
      documentVerified: true,
      integrityVerified: false,
      integrityResult: 'Hash Missing',
      reason: 'missing_stored_hash',
      error: 'The contract record does not match the supplied digest.',
    });

    render(<ContractVerify />);

    await waitFor(() => {
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(screen.getByText('Hash Missing')).toBeInTheDocument();
    });
    expect(screen.queryByText('Integrity Verified')).not.toBeInTheDocument();
    expect(screen.getByText(/No authoritative SHA-256 content hash/i)).toBeInTheDocument();
  });

  it('shows Not Found and does not expose contract details', async () => {
    setUrl('?c=PC-UNKNOWN&h=' + 'd'.repeat(64));
    makeFetch({
      verified: false,
      result: 'not_found',
      documentVerified: false,
      integrityVerified: false,
      integrityResult: 'Not Evaluated',
      reason: 'no_match',
      error: 'No contract matches that number, short code or hash.',
    });

    render(<ContractVerify />);

    await waitFor(() => {
      expect(screen.getByText('Not Found / Invalid')).toBeInTheDocument();
      expect(screen.getByText('Not Evaluated')).toBeInTheDocument();
    });
    expect(screen.queryByText('Document Verified')).not.toBeInTheDocument();
    expect(screen.queryByText('Mtakataka CCAP School')).not.toBeInTheDocument();
  });

  it('shows Unavailable and no successful verification on backend outage', async () => {
    setUrl('?c=PC-P726-023&h=' + 'e'.repeat(64));
    makeFetch({ error: 'Verification is temporarily unavailable.' }, false, 503);

    render(<ContractVerify />);

    await waitFor(() => {
      expect(screen.getByText('Unavailable')).toBeInTheDocument();
      expect(screen.getByText('Integrity Check Unavailable')).toBeInTheDocument();
    });
    expect(screen.queryByText('Integrity Verified')).not.toBeInTheDocument();
  });

  it('keeps a voided contract visibly voided when integrity passes', async () => {
    setUrl('?c=PC-VOID&h=' + 'f'.repeat(64));
    makeFetch({
      ...baseBodyVerified,
      contractNumber: 'PC-VOID',
      status: 'VOIDED',
    });

    render(<ContractVerify />);

    await waitFor(() => {
      expect(screen.getByText('Verified')).toBeInTheDocument();
      expect(screen.getByText('Integrity Verified')).toBeInTheDocument();
      expect(screen.getByText(/VOIDED|Voided/i)).toBeInTheDocument();
    });
  });

  it('preserves QR query parameters and lookup behavior', async () => {
    const hash = '1'.repeat(64);
    setUrl(`?c=PC-P726-023&h=${hash}`);
    const fetchMock = makeFetch(baseBodyVerified);

    render(<ContractVerify />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
      const firstUrl = String(fetchMock.mock.calls[0][0]);
      expect(firstUrl).toContain('/public/documents/contract-verify?');
      expect(firstUrl).toContain('c=PC-P726-023');
      expect(firstUrl).toContain(`h=${hash}`);
      expect(screen.getByText('Verified')).toBeInTheDocument();
    });
  });
});
