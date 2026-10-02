/**
 * Sales Order creation_source — explicit origin contract.
 *
 * Covers business rules:
 *   DIRECT_ERP       → ORD sequence (manual ERP, initial Draft)
 *   PORTAL_CONVERSION→ SO sequence (portal quotation/request conversion, Confirmed)
 *   INVOICE_DERIVED  → ORD sequence (direct-invoice Order → Invoice chain, Confirmed;
 *                       never silently classified as portal/SO)
 * Missing/invalid sources never default to portal/SO (safe fallback DIRECT_ERP/ORD);
 * request/quotation linkage remains as a backwards-compatible portal fallback.
 * Historical official numbers are never renumbered (no mint assertions here —
 * preservation is covered by salesOrderNumber.test.cjs gateway tests).
 */

const numbering = require('../services/salesOrderNumbering.cjs');

describe('normalizeCreationSource — explicit source, never a silent SO fallback', () => {
  it('accepts the three canonical sources', () => {
    expect(numbering.normalizeCreationSource('DIRECT_ERP')).toBe('DIRECT_ERP');
    expect(numbering.normalizeCreationSource('PORTAL_CONVERSION')).toBe('PORTAL_CONVERSION');
    expect(numbering.normalizeCreationSource('INVOICE_DERIVED')).toBe('INVOICE_DERIVED');
  });

  it('maps the legacy QUOTATION_REQUEST alias to PORTAL_CONVERSION', () => {
    expect(numbering.normalizeCreationSource('QUOTATION_REQUEST')).toBe('PORTAL_CONVERSION');
    expect(numbering.normalizeCreationSource('quotation_request')).toBe('PORTAL_CONVERSION');
  });

  it('returns null for missing/invalid sources (callers must use the safe fallback)', () => {
    expect(numbering.normalizeCreationSource(null)).toBeNull();
    expect(numbering.normalizeCreationSource(undefined)).toBeNull();
    expect(numbering.normalizeCreationSource('')).toBeNull();
    expect(numbering.normalizeCreationSource('PORTAL')).toBeNull();
    expect(numbering.normalizeCreationSource('SO')).toBeNull();
    expect(numbering.normalizeCreationSource('invoice')).toBeNull();
  });

  it('reads both snake_case and camelCase spellings', () => {
    expect(numbering.readCreationSource({ creation_source: 'DIRECT_ERP' })).toBe('DIRECT_ERP');
    expect(numbering.readCreationSource({ creationSource: 'PORTAL_CONVERSION' })).toBe('PORTAL_CONVERSION');
    expect(numbering.readCreationSource({ creation_source: 'QUOTATION_REQUEST' })).toBe('PORTAL_CONVERSION');
    expect(numbering.readCreationSource({})).toBeNull();
    expect(numbering.readCreationSource(null)).toBeNull();
  });
});

describe('determineSalesOrderOrigin — explicit source wins, linkage is fallback', () => {
  it('explicit DIRECT_ERP stays direct even with linkage present', () => {
    expect(
      numbering.determineSalesOrderOrigin({ creation_source: 'DIRECT_ERP', source_request_id: 'req-1' })
    ).toBe('DIRECT_ERP');
  });

  it('explicit PORTAL_CONVERSION is portal even without linkage', () => {
    expect(numbering.determineSalesOrderOrigin({ creation_source: 'PORTAL_CONVERSION' })).toBe(
      'PORTAL_CONVERSION'
    );
    expect(numbering.determineSalesOrderOrigin({ creationSource: 'PORTAL_CONVERSION' })).toBe(
      'PORTAL_CONVERSION'
    );
  });

  it('explicit INVOICE_DERIVED is never classified as portal, even with linkage', () => {
    expect(numbering.determineSalesOrderOrigin({ creation_source: 'INVOICE_DERIVED' })).toBe(
      'INVOICE_DERIVED'
    );
    expect(
      numbering.determineSalesOrderOrigin({
        creation_source: 'INVOICE_DERIVED',
        source_request_id: 'req-1',
        quotation_id: 'q-1',
      })
    ).toBe('INVOICE_DERIVED');
  });

  it('legacy linkage fallback still yields portal SO (backwards compatibility)', () => {
    expect(numbering.determineSalesOrderOrigin({ source_request_id: 'req-1' })).toBe(
      'QUOTATION_REQUEST'
    );
    expect(numbering.determineSalesOrderOrigin({ sourceRequestId: 'req-1' })).toBe(
      'QUOTATION_REQUEST'
    );
    expect(numbering.determineSalesOrderOrigin({ quotation_id: 'q-1' })).toBe('QUOTATION_REQUEST');
    expect(numbering.determineSalesOrderOrigin({ quotationId: 'q-1' })).toBe('QUOTATION_REQUEST');
  });

  it('missing/invalid source with no linkage falls back to DIRECT_ERP (never SO)', () => {
    expect(numbering.determineSalesOrderOrigin({})).toBe('DIRECT_ERP');
    expect(numbering.determineSalesOrderOrigin({ creation_source: 'nonsense' })).toBe('DIRECT_ERP');
    expect(numbering.determineSalesOrderOrigin({ source: 'invoice' })).toBe('DIRECT_ERP');
  });
});

describe('prefixForOrigin — invoice-derived uses ORD, never portal SO', () => {
  it('maps DIRECT_ERP and INVOICE_DERIVED to ORD', () => {
    expect(numbering.prefixForOrigin('DIRECT_ERP')).toBe('ORD');
    expect(numbering.prefixForOrigin('INVOICE_DERIVED')).toBe('ORD');
  });

  it('maps PORTAL_CONVERSION and legacy QUOTATION_REQUEST to SO', () => {
    expect(numbering.prefixForOrigin('PORTAL_CONVERSION')).toBe('SO');
    expect(numbering.prefixForOrigin('QUOTATION_REQUEST')).toBe('SO');
  });

  it('unknown origins use the safe ORD fallback, never SO', () => {
    expect(numbering.prefixForOrigin('anything-else')).toBe('ORD');
    expect(numbering.prefixForOrigin(null)).toBe('ORD');
  });
});

describe('prefixMatchesOrigin — adoption guard respects explicit sources', () => {
  it('SO matches portal sources only', () => {
    expect(
      numbering.prefixMatchesOrigin('SO-P726/028', { creation_source: 'PORTAL_CONVERSION' })
    ).toBe(true);
    expect(
      numbering.prefixMatchesOrigin('SO-P726/028', { source_request_id: 'r' })
    ).toBe(true);
    expect(numbering.prefixMatchesOrigin('SO-P726/028', { creation_source: 'DIRECT_ERP' })).toBe(
      false
    );
    expect(
      numbering.prefixMatchesOrigin('SO-P726/028', { creation_source: 'INVOICE_DERIVED' })
    ).toBe(false);
  });

  it('ORD matches direct and invoice-derived sources only', () => {
    expect(numbering.prefixMatchesOrigin('ORD-P726/028', {})).toBe(true);
    expect(
      numbering.prefixMatchesOrigin('ORD-P726/028', { creation_source: 'INVOICE_DERIVED' })
    ).toBe(true);
    expect(
      numbering.prefixMatchesOrigin('ORD-P726/028', { creation_source: 'PORTAL_CONVERSION' })
    ).toBe(false);
    expect(numbering.prefixMatchesOrigin('ORD-P726/028', { quotation_id: 'q' })).toBe(false);
  });
});

describe('mintOfficialSalesOrderNumber — explicit invoice-derived rule', () => {
  const config = {
    transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
  };
  const depsFor = (extra = {}) => ({
    getCompanyConfig: async () => config,
    httpPost: async () => ({ data: [50] }),
    ...extra,
  });

  it('mints ORD- for DIRECT_ERP', async () => {
    await expect(
      numbering.mintOfficialSalesOrderNumber({ creation_source: 'DIRECT_ERP' }, depsFor())
    ).resolves.toBe('ORD-P726/050');
  });

  it('mints SO- for PORTAL_CONVERSION and legacy QUOTATION_REQUEST', async () => {
    await expect(
      numbering.mintOfficialSalesOrderNumber({ creation_source: 'PORTAL_CONVERSION' }, depsFor())
    ).resolves.toBe('SO-P726/050');
    await expect(
      numbering.mintOfficialSalesOrderNumber({ creation_source: 'QUOTATION_REQUEST' }, depsFor())
    ).resolves.toBe('SO-P726/050');
  });

  it('mints ORD- for INVOICE_DERIVED (explicit rule, ERP family sequence)', async () => {
    await expect(
      numbering.mintOfficialSalesOrderNumber({ creation_source: 'INVOICE_DERIVED' }, depsFor())
    ).resolves.toBe('ORD-P726/050');
  });

  it('originOverride PORTAL_CONVERSION wins (portal conversion call sites)', async () => {
    await expect(
      numbering.mintOfficialSalesOrderNumber(
        {},
        { ...depsFor(), originOverride: numbering.ORIGIN_PORTAL }
      )
    ).resolves.toBe('SO-P726/050');
  });
});
