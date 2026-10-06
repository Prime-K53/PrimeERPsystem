'use strict';

/**
 * examinationInvoiceNumbering.test.cjs — P0 regression: the Examination Invoice
 * identity (EXM-{series}/NNN) is server-authoritative.
 *
 * Incident: batches BTC-P726/023 (K550,000) and BTC-P726/021 (K200,250) —
 * different batches, different schools — BOTH became EXM-P726/022 and both
 * posted AR onto that single `referenceId`, so the 200,250 invoice reported
 * "net posted AR 750,250 — reduction of 550,000 pending".
 *
 * Cause: the EXM namespace was minted device-locally from the browser's
 * `invoices` collection. Because an Examination Invoice's `id` IS its ledger
 * `referenceId`, the identity cannot be minted locally and renamed afterwards
 * — the AR row already references it. This mirrors the Sales Order authority
 * (migration 0027 / salesOrderNumbering), same pattern, same RPC claim.
 */

const numbering = require('../services/examinationInvoiceNumbering.cjs');

describe('examinationInvoiceNumbering — EXM format is preserved exactly', () => {
  it('formats EXM-{series}/{padded} byte-identically to the frontend rule', () => {
    // Observed live shape: EXM-P726/022 (3-digit padding).
    expect(numbering.formatExaminationInvoiceNumber('P726', 22, 3)).toBe('EXM-P726/022');
    expect(numbering.formatExaminationInvoiceNumber('P726', 1, 3)).toBe('EXM-P726/001');
    expect(numbering.formatExaminationInvoiceNumber('P727', 7, 3)).toBe('EXM-P726/007'.replace('P726', 'P727'));
    expect(numbering.formatExaminationInvoiceNumber('P726', 22, 6)).toBe('EXM-P726/000022');
  });

  it('recognises only the official EXM shape', () => {
    expect(numbering.isExaminationInvoiceNumber('EXM-P726/022')).toBe(true);
    expect(numbering.isExaminationInvoiceNumber('EXM-P726/022', 'P726')).toBe(true);
    expect(numbering.isExaminationInvoiceNumber('EXM-P726/022', 'P727')).toBe(false);
    // Never a sales or POS identity.
    expect(numbering.isExaminationInvoiceNumber('INV-P726/022')).toBe(false);
    expect(numbering.isExaminationInvoiceNumber('POS-P726/022')).toBe(false);
    expect(numbering.isExaminationInvoiceNumber('')).toBe(false);
    expect(numbering.isExaminationInvoiceNumber(null)).toBe(false);
  });

  it('parses series + sequence', () => {
    expect(numbering.parseExaminationInvoiceNumber('EXM-P726/022')).toEqual({ series: 'P726', sequence: 22 });
    expect(numbering.parseExaminationInvoiceNumber('INV-P726/022')).toBeNull();
  });

  it('resolves the series from the shared/global numbering rule', () => {
    expect(numbering.resolveExaminationSeries({
      transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
    })).toBe('P726');
    expect(numbering.resolveExaminationSeries({
      transactionSettings: { numbering: { examination_invoice: { extension: 'P728' } } },
    })).toBe('P728');
    expect(numbering.resolveExaminationSeries(null)).toBeNull();
    expect(numbering.resolveExaminationSeries({ transactionSettings: { numbering: {} } })).toBeNull();
  });

  it('derives the prefix separator exactly like utils/numbering.ts', () => {
    expect(numbering.buildPrefixSeparator('EXM')).toBe('-');
    expect(numbering.buildPrefixSeparator('EXM-')).toBe('');
    expect(numbering.buildPrefixSeparator('')).toBe('');
  });
});

describe('examinationInvoiceNumbering — the claim is atomic and convergent', () => {
  it('claims through the service-role RPC, never a local scan', async () => {
    const calls = [];
    const httpPost = async (url, body) => {
      calls.push({ url, body });
      return { data: [23] };
    };
    const seq = await numbering.claimNextSeriesSequence('P726', { httpPost });
    expect(seq).toBe(23);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/rest/v1/rpc/claim_next_examination_invoice_number');
    expect(calls[0].body).toEqual({ p_series: 'P726' });
  });

  it('rejects an invalid series before touching the network', async () => {
    let called = 0;
    const httpPost = async () => { called += 1; return { data: [1] }; };
    await expect(numbering.claimNextSeriesSequence('P726/../etc', { httpPost })).rejects.toMatchObject({
      code: 'SERIES_INVALID',
    });
    expect(numbering.claimNextSeriesSequence('P726/bad', { httpPost })).rejects.toMatchObject({ code: 'SERIES_INVALID' });
    expect(numbering.claimNextSeriesSequence('', { httpPost })).rejects.toMatchObject({ code: 'SERIES_INVALID' });
    expect(called).toBe(0);
  });

  it('two concurrent claimants receive DIFFERENT identities (never 22/22)', async () => {
    // Models the server counter: each claim consumes the next value, so the
    // second can never receive the first's number.
    let counter = 22;
    const httpPost = async () => ({ data: [++counter] });
    const [a, b] = await Promise.all([
      numbering.claimNextSeriesSequence('P726', { httpPost }),
      numbering.claimNextSeriesSequence('P726', { httpPost }),
    ]);
    expect(a).not.toBe(b);
    expect(new Set([a, b]).size).toBe(2);
    const minted = [a, b].map((s) => numbering.formatExaminationInvoiceNumber('P726', s, 3));
    expect(new Set(minted).size).toBe(2);
    for (const value of minted) {
      expect(numbering.isExaminationInvoiceNumber(value)).toBe(true);
    }
  });

  it('fails closed when the counter is unreachable', async () => {
    await expect(
      numbering.claimNextSeriesSequence('P726', {
        httpPost: async () => { throw new Error('transport down'); },
      })
    ).rejects.toThrow(/transport down/);
  });

  it('rejects a non-integer claim result rather than inventing a number', async () => {
    await expect(
      numbering.claimNextSeriesSequence('P726', { httpPost: async () => ({ data: [null] }) })
    ).rejects.toMatchObject({ code: 'SEQUENCE_INVALID' });
    await expect(
      numbering.claimNextSeriesSequence('P726', { httpPost: async () => ({ data: [0] }) })
    ).rejects.toMatchObject({ code: 'SEQUENCE_INVALID' });
    await expect(
      numbering.claimNextSeriesSequence('P726', { httpPost: async () => ({ data: ['abc'] }) })
    ).rejects.toMatchObject({ code: 'SEQUENCE_INVALID' });
  });

  it('refuses to mint when the series is unconfigured (never invents a series)', async () => {
    await expect(
      numbering.mintExaminationInvoiceNumber({}, { getCompanyConfig: async () => null })
    ).rejects.toMatchObject({ code: 'SERIES_UNCONFIGURED' });
  });

  it('mints an authoritative EXM identity end to end', async () => {
    const httpPost = async () => ({ data: [24] });
    const invoiceNumber = await numbering.mintExaminationInvoiceNumber(
      {},
      {
        getCompanyConfig: async () => ({
          transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
        }),
        httpPost,
      }
    );
    expect(invoiceNumber).toBe('EXM-P726/024');
    expect(numbering.isExaminationInvoiceNumber(invoiceNumber, 'P726')).toBe(true);
  });

  it('introduces no tenancy/organization/company scoping', () => {
    const source = require('fs').readFileSync(
      require.resolve('../services/examinationInvoiceNumbering.cjs'),
      'utf8'
    );
    for (const forbidden of ['tenant_id', 'tenantId', 'organization_id', 'company_id', 'companyId']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
