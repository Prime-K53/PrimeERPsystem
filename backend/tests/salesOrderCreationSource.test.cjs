/**
 * Sales Order creation_source — provenance contract under single-family
 * ORD numbering.
 *
 *   DIRECT_ERP       → ORD sequence (manual ERP, initial Draft)
 *   PORTAL_CONVERSION→ ORD sequence (portal quotation/request conversion, Confirmed)
 *   INVOICE_DERIVED  → ORD sequence (direct-invoice Order → Invoice chain, Confirmed)
 * Creation source is provenance/audit metadata only and MUST NOT affect the
 * number. Missing/invalid sources never default to portal/SO (safe fallback
 * DIRECT_ERP/ORD); request/quotation linkage remains as a backwards-compatible
 * portal fallback for provenance. Historical official numbers are never
 * renumbered (covered by salesOrderNumber.test.cjs gateway tests).
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

describe('determineSalesOrderOrigin — explicit source wins, linkage is fallback (provenance only)', () => {
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

  it('explicit INVOICE_DERIVED is its own origin, even with linkage', () => {
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

  it('legacy linkage fallback still yields portal provenance (backwards compatibility)', () => {
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

describe('prefixForOrigin — every origin resolves to ORD', () => {
  it('maps all known origins to ORD', () => {
    expect(numbering.prefixForOrigin('DIRECT_ERP')).toBe('ORD');
    expect(numbering.prefixForOrigin('PORTAL_CONVERSION')).toBe('ORD');
    expect(numbering.prefixForOrigin('QUOTATION_REQUEST')).toBe('ORD');
    expect(numbering.prefixForOrigin('INVOICE_DERIVED')).toBe('ORD');
  });

  it('unknown origins use ORD (never SO)', () => {
    expect(numbering.prefixForOrigin('anything-else')).toBe('ORD');
    expect(numbering.prefixForOrigin(null)).toBe('ORD');
  });
});

describe('prefixMatchesOrigin — only ORD is adoptable for new rows', () => {
  it('ORD matches every provenance (single family)', () => {
    expect(numbering.prefixMatchesOrigin('ORD-P726/028', { creation_source: 'DIRECT_ERP' })).toBe(true);
    expect(
      numbering.prefixMatchesOrigin('ORD-P726/028', { creation_source: 'PORTAL_CONVERSION' })
    ).toBe(true);
    expect(
      numbering.prefixMatchesOrigin('ORD-P726/028', { creation_source: 'INVOICE_DERIVED' })
    ).toBe(true);
    expect(numbering.prefixMatchesOrigin('ORD-P726/028', { source_request_id: 'r' })).toBe(true);
    expect(numbering.prefixMatchesOrigin('ORD-P726/028', {})).toBe(true);
  });

  it('SO never matches — SO candidates always mint fresh ORD', () => {
    expect(
      numbering.prefixMatchesOrigin('SO-P726/028', { creation_source: 'PORTAL_CONVERSION' })
    ).toBe(false);
    expect(numbering.prefixMatchesOrigin('SO-P726/028', { source_request_id: 'r' })).toBe(false);
    expect(numbering.prefixMatchesOrigin('SO-P726/028', {})).toBe(false);
  });
});

describe('mintOfficialSalesOrderNumber — one ORD family for all origins', () => {
  const config = {
    transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
  };
  const depsFor = (extra = {}) => ({
    getCompanyConfig: async () => config,
    httpPost: async () => ({ data: [50] }),
    ...extra,
  });

  it('mints ORD- for DIRECT_ERP, PORTAL_CONVERSION and INVOICE_DERIVED', async () => {
    await expect(
      numbering.mintOfficialSalesOrderNumber({ creation_source: 'DIRECT_ERP' }, depsFor())
    ).resolves.toBe('ORD-P726/050');
    await expect(
      numbering.mintOfficialSalesOrderNumber({ creation_source: 'PORTAL_CONVERSION' }, depsFor())
    ).resolves.toBe('ORD-P726/050');
    await expect(
      numbering.mintOfficialSalesOrderNumber({ creation_source: 'INVOICE_DERIVED' }, depsFor())
    ).resolves.toBe('ORD-P726/050');
    await expect(
      numbering.mintOfficialSalesOrderNumber({ source_request_id: 'req-1' }, depsFor())
    ).resolves.toBe('ORD-P726/050');
  });

  it('originOverride never changes the ORD prefix', async () => {
    await expect(
      numbering.mintOfficialSalesOrderNumber(
        {},
        { ...depsFor(), originOverride: numbering.ORIGIN_PORTAL }
      )
    ).resolves.toBe('ORD-P726/050');
    await expect(
      numbering.mintOfficialSalesOrderNumber(
        {},
        { ...depsFor(), originOverride: numbering.ORIGIN_INVOICE }
      )
    ).resolves.toBe('ORD-P726/050');
  });
});
