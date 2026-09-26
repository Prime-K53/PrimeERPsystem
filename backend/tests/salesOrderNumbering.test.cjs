/**
 * salesOrderNumbering — hermetic unit tests for the unified P726 minter.
 *
 * Covers the pure decision surface (no network):
 *   determineSalesOrderOrigin / prefixForOrigin / prefixMatchesOrigin
 *   resolveSalesOrderSeries / resolveSeriesPadding / formatOfficialSalesOrderNumber
 *   isOfficialSalesOrderNumber / isLegacyOfficialNumber / needsOfficialNumber
 *   isUniqueViolation
 * Plus injected-dependency tests for claimNextSeriesSequence,
 * isOfficialNumberTaken and mintOfficialSalesOrderNumber (no Supabase).
 */

const numbering = require('../services/salesOrderNumbering.cjs');

describe('determineSalesOrderOrigin — persisted provenance, never prefixes', () => {
  it('conversion when request linkage is persisted', () => {
    expect(numbering.determineSalesOrderOrigin({ source_request_id: 'req-1' })).toBe('QUOTATION_REQUEST');
    expect(numbering.determineSalesOrderOrigin({ source_request_number: 'SO-2026-1' })).toBe('QUOTATION_REQUEST');
    expect(numbering.determineSalesOrderOrigin({ quotation_id: 'q-1' })).toBe('QUOTATION_REQUEST');
  });

  it('direct ERP otherwise (including reorder linkage and SO-prefixed numbers)', () => {
    expect(numbering.determineSalesOrderOrigin({})).toBe('DIRECT_ERP');
    expect(numbering.determineSalesOrderOrigin(null)).toBe('DIRECT_ERP');
    expect(numbering.determineSalesOrderOrigin({ reorder_of: 'x' })).toBe('DIRECT_ERP');
    // A provisional SO- number alone never implies conversion origin.
    expect(numbering.determineSalesOrderOrigin({ orderNumber: 'SO-P726/001' })).toBe('DIRECT_ERP');
  });

  it('prefixForOrigin maps origins to SO/ORD', () => {
    expect(numbering.prefixForOrigin('QUOTATION_REQUEST')).toBe('SO');
    expect(numbering.prefixForOrigin('DIRECT_ERP')).toBe('ORD');
    expect(numbering.prefixForOrigin('anything-else')).toBe('ORD');
  });

  it('prefixMatchesOrigin guards adoption of client-supplied numbers', () => {
    expect(numbering.prefixMatchesOrigin('SO-P726/028', { source_request_id: 'r' })).toBe(true);
    expect(numbering.prefixMatchesOrigin('so-p726/028', { source_request_id: 'r' })).toBe(true);
    expect(numbering.prefixMatchesOrigin('ORD-P726/028', {})).toBe(true);
    expect(numbering.prefixMatchesOrigin('SO-P726/028', {})).toBe(false);
    expect(numbering.prefixMatchesOrigin('ORD-P726/028', { quotation_id: 'q' })).toBe(false);
    expect(numbering.prefixMatchesOrigin('ORDER-P726/028', {})).toBe(false);
  });
});

describe('branch extension + padding resolution (mirrors frontend shared rule)', () => {
  const config = (numberingRules) => ({ transactionSettings: { numbering: numberingRules } });

  it('prefers the shared/global rule extension', () => {
    expect(
      numbering.resolveSalesOrderSeries(config({ sales_invoice: { extension: 'X' }, shared: { extension: 'P726' } }))
    ).toBe('P726');
    expect(
      numbering.resolveSalesOrderSeries(config({ global: { extension: 'P726' } }))
    ).toBe('P726');
  });

  it('falls back to any rule carrying an extension, else null (fail closed)', () => {
    expect(numbering.resolveSalesOrderSeries(config({ invoice: { extension: 'P726' } }))).toBe('P726');
    expect(numbering.resolveSalesOrderSeries(config({ shared: {} }))).toBeNull();
    expect(numbering.resolveSalesOrderSeries(null)).toBeNull();
    expect(numbering.resolveSalesOrderSeries({})).toBeNull();
  });

  it('resolves shared padding, defaulting safely', () => {
    expect(numbering.resolveSeriesPadding(config({ shared: { padding: 3 } }))).toBe(3);
    expect(numbering.resolveSeriesPadding(config({ shared: {} }))).toBe(4);
    expect(numbering.resolveSeriesPadding(null)).toBe(4);
  });

  it('formats official numbers with prefix, extension and zero-padded sequence', () => {
    expect(numbering.formatOfficialSalesOrderNumber('DIRECT_ERP', 'P726', 26, 3)).toBe('ORD-P726/026');
    expect(numbering.formatOfficialSalesOrderNumber('QUOTATION_REQUEST', 'P726', 28, 3)).toBe('SO-P726/028');
    expect(numbering.formatOfficialSalesOrderNumber('DIRECT_ERP', 'P726', 7)).toBe('ORD-P726/0007');
  });
});

describe('official vs provisional classification', () => {
  it('recognises unified official numbers', () => {
    expect(numbering.isOfficialSalesOrderNumber('SO-P726/028')).toBe(true);
    expect(numbering.isOfficialSalesOrderNumber('ORD-P726/026')).toBe(true);
    expect(numbering.isOfficialSalesOrderNumber('ORDER-P726/026')).toBe(false);
    expect(numbering.isOfficialSalesOrderNumber('SO-P726/abc')).toBe(false);
    expect(numbering.isOfficialSalesOrderNumber('ORD-2026-000001')).toBe(false);
    expect(numbering.isOfficialSalesOrderNumber('')).toBe(false);
  });

  it('recognises legacy backend officials (kept, never minted)', () => {
    expect(numbering.isLegacyOfficialNumber('ORD-2026-000001')).toBe(true);
    expect(numbering.isLegacyOfficialNumber('ORD-P726/026')).toBe(false);
    expect(numbering.isLegacyOfficialNumber('SO-P726/028')).toBe(false);
  });

  it('needsOfficialNumber flags provisionals, legacy non-officials and missing numbers', () => {
    expect(numbering.needsOfficialNumber({ orderNumberProvisional: true })).toBe(true);
    expect(numbering.needsOfficialNumber({})).toBe(true);
    expect(numbering.needsOfficialNumber({ order_number: '' })).toBe(true);
    expect(numbering.needsOfficialNumber({ order_number: 'ORDER-P726/034' })).toBe(true);
    expect(numbering.needsOfficialNumber({ order_number: 'SO-P726/001', orderNumberProvisional: true })).toBe(true);
    expect(numbering.needsOfficialNumber({ order_number: 'SO-P726/028' })).toBe(false);
    expect(numbering.needsOfficialNumber({ order_number: 'ORD-P726/026' })).toBe(false);
    expect(numbering.needsOfficialNumber({ order_number: 'ORD-2026-000001' })).toBe(false);
  });

  it('detects unique-violation failures narrowly', () => {
    const violation = new Error('x');
    violation.response = { status: 409, data: { code: '23505', message: 'duplicate key' } };
    expect(numbering.isUniqueViolation(violation)).toBe(true);
    const other409 = new Error('x');
    other409.response = { status: 409, data: { code: 'PGRST100', message: 'bad' } };
    expect(numbering.isUniqueViolation(other409)).toBe(false);
    const serverError = new Error('x');
    serverError.response = { status: 500, data: {} };
    expect(numbering.isUniqueViolation(serverError)).toBe(false);
    expect(numbering.isUniqueViolation(new Error('Network Error'))).toBe(false);
    expect(numbering.isUniqueViolation(null)).toBe(false);
  });
});

describe('claimNextSeriesSequence (injected transport)', () => {
  it('returns integer claims from array or scalar RPC shapes', async () => {
    await expect(
      numbering.claimNextSeriesSequence('P726', { httpPost: async () => ({ data: [38] }) })
    ).resolves.toBe(38);
    await expect(
      numbering.claimNextSeriesSequence('P726', { httpPost: async () => ({ data: 39 }) })
    ).resolves.toBe(39);
  });

  it('passes the series through to the RPC body', async () => {
    const seen = [];
    const httpPost = async (url, body) => {
      seen.push({ url, body });
      return { data: [1] };
    };
    await numbering.claimNextSeriesSequence('P727', { httpPost });
    expect(seen).toHaveLength(1);
    expect(String(seen[0].url)).toContain('/rpc/claim_next_sales_order_number');
    expect(seen[0].body).toEqual({ p_series: 'P727' });
  });

  it('rejects invalid claim values instead of minting garbage', async () => {
    await expect(
      numbering.claimNextSeriesSequence('P726', { httpPost: async () => ({ data: [0] }) })
    ).rejects.toEqual(expect.objectContaining({ code: 'SEQUENCE_INVALID' }));
    await expect(
      numbering.claimNextSeriesSequence('P726', { httpPost: async () => ({ data: null }) })
    ).rejects.toEqual(expect.objectContaining({ code: 'SEQUENCE_INVALID' }));
  });

  it('rejects blank/invalid series without touching the transport', async () => {
    const httpPost = jest.fn(async () => ({ data: [1] }));
    await expect(numbering.claimNextSeriesSequence('', { httpPost })).rejects.toEqual(
      expect.objectContaining({ code: 'SERIES_INVALID' })
    );
    await expect(numbering.claimNextSeriesSequence('P 726', { httpPost })).rejects.toEqual(
      expect.objectContaining({ code: 'SERIES_INVALID' })
    );
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('fails closed without configuration (no MAX()+1 fallback)', async () => {
    const savedUrl = process.env.SUPABASE_URL;
    const savedKey = process.env.SUPABASE_SECRET_KEY;
    const savedVite = process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.VITE_SUPABASE_URL;
    try {
      await expect(numbering.claimNextSeriesSequence('P726', {})).rejects.toEqual(
        expect.objectContaining({ code: 'SEQUENCE_UNAVAILABLE' })
      );
    } finally {
      if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
      if (savedKey !== undefined) process.env.SUPABASE_SECRET_KEY = savedKey;
      if (savedVite !== undefined) process.env.VITE_SUPABASE_URL = savedVite;
    }
  });
});

describe('isOfficialNumberTaken (injected transport)', () => {
  const rows = (ids) => async () => ({ data: ids.map((id) => ({ id })) });

  it('true when another row holds the number in either field', async () => {
    await expect(numbering.isOfficialNumberTaken('SO-P726/028', { httpGet: rows(['other']) })).resolves.toBe(true);
  });

  it('false when unused, and when only the writing row holds it (replay)', async () => {
    await expect(numbering.isOfficialNumberTaken('SO-P726/028', { httpGet: rows([]) })).resolves.toBe(false);
    await expect(
      numbering.isOfficialNumberTaken('SO-P726/028', { httpGet: rows(['same-row']), excludeId: 'same-row' })
    ).resolves.toBe(false);
  });

  it('false without configuration', async () => {
    const savedUrl = process.env.SUPABASE_URL;
    const savedKey = process.env.SUPABASE_SECRET_KEY;
    const savedVite = process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.VITE_SUPABASE_URL;
    try {
      await expect(numbering.isOfficialNumberTaken('SO-P726/028', {})).resolves.toBe(false);
    } finally {
      if (savedUrl !== undefined) process.env.SUPABASE_URL = savedUrl;
      if (savedKey !== undefined) process.env.SUPABASE_SECRET_KEY = savedKey;
      if (savedVite !== undefined) process.env.VITE_SUPABASE_URL = savedVite;
    }
  });
});

describe('mintOfficialSalesOrderNumber (injected config + transport)', () => {
  const config = {
    transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
  };

  it('mints SO- for conversion linkage, ORD- for direct rows', async () => {
    const httpPost = jest.fn(async () => ({ data: [40] }));
    await expect(
      numbering.mintOfficialSalesOrderNumber(
        { source_request_id: 'req-1' },
        { getCompanyConfig: async () => config, httpPost }
      )
    ).resolves.toBe('SO-P726/040');
    await expect(
      numbering.mintOfficialSalesOrderNumber(
        { customer_id: 'c' },
        { getCompanyConfig: async () => config, httpPost }
      )
    ).resolves.toBe('ORD-P726/040');
  });

  it('originOverride wins over payload linkage', async () => {
    const httpPost = jest.fn(async () => ({ data: [41] }));
    await expect(
      numbering.mintOfficialSalesOrderNumber(
        {},
        { getCompanyConfig: async () => config, httpPost, originOverride: 'QUOTATION_REQUEST' }
      )
    ).resolves.toBe('SO-P726/041');
  });

  it('fails closed without a configured branch extension', async () => {
    const httpPost = jest.fn(async () => ({ data: [42] }));
    await expect(
      numbering.mintOfficialSalesOrderNumber({}, { getCompanyConfig: async () => ({}), httpPost })
    ).rejects.toEqual(expect.objectContaining({ code: 'SERIES_UNCONFIGURED' }));
    expect(httpPost).not.toHaveBeenCalled();
  });
});

describe('alternate series proof — P727 has an independent sequence', () => {
  const configP727 = {
    transactionSettings: { numbering: { shared: { extension: 'P727', padding: 3 } } },
  };

  it('P727 direct → ORD-P727/001; P727 conversion → SO-P727/002', async () => {
    const httpPost = jest.fn(async () => ({ data: [1] }));
    const deps = { getCompanyConfig: async () => configP727, httpPost };
    await expect(numbering.mintOfficialSalesOrderNumber({ customer_id: 'c' }, deps)).resolves.toBe(
      'ORD-P727/001'
    );
    httpPost.mockResolvedValueOnce({ data: [2] });
    await expect(
      numbering.mintOfficialSalesOrderNumber({ source_request_id: 'req-9' }, deps)
    ).resolves.toBe('SO-P727/002');
  });

  it('independent counters: P726=27 and P727=4 advance separately, never one stream', async () => {
    // Series-keyed RPC mock: each series has its OWN counter, mirroring the
    // per-series rows + advisory locks in migration 0027.
    const counters = new Map([['P726', 27], ['P727', 4]]);
    const httpPost = jest.fn(async (url, body) => {
      expect(String(url)).toContain('/rpc/claim_next_sales_order_number');
      const series = body.p_series;
      const next = (counters.get(series) || 0) + 1;
      counters.set(series, next);
      return { data: next };
    });
    const depsFor = (config) => ({ getCompanyConfig: async () => config, httpPost });
    const p726Config = {
      transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
    };
    const p727Config = {
      transactionSettings: { numbering: { shared: { extension: 'P727', padding: 3 } } },
    };
    await expect(
      numbering.mintOfficialSalesOrderNumber({ customer_id: 'c' }, depsFor(p726Config))
    ).resolves.toBe('ORD-P726/028');
    await expect(
      numbering.mintOfficialSalesOrderNumber({ customer_id: 'c' }, depsFor(p727Config))
    ).resolves.toBe('ORD-P727/005');
    // Interleaved claims keep advancing their own series only.
    await expect(
      numbering.mintOfficialSalesOrderNumber({ source_request_id: 'r' }, depsFor(p727Config))
    ).resolves.toBe('SO-P727/006');
    await expect(
      numbering.mintOfficialSalesOrderNumber({ source_request_id: 'r' }, depsFor(p726Config))
    ).resolves.toBe('SO-P726/029');
  });

  it('returning to P726 continues from the existing P726 counter (no reset, no reuse)', async () => {
    const counters = new Map([['P726', 29]]);
    const httpPost = jest.fn(async (url, body) => {
      const next = (counters.get(body.p_series) || 0) + 1;
      counters.set(body.p_series, next);
      return { data: next };
    });
    const p726Config = {
      transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
    };
    await expect(
      numbering.mintOfficialSalesOrderNumber(
        {},
        { getCompanyConfig: async () => p726Config, httpPost, originOverride: 'DIRECT_ERP' }
      )
    ).resolves.toBe('ORD-P726/030');
  });

  it('historical P726 recognition does not depend on the current series', () => {
    expect(numbering.isOfficialSalesOrderNumber('SO-P726/028')).toBe(true);
    expect(numbering.isOfficialSalesOrderNumber('ORD-P726/029')).toBe(true);
    expect(numbering.isOfficialSalesOrderNumber('SO-P726/028', 'P727')).toBe(false);
    expect(numbering.isOfficialSalesOrderNumber('SO-P727/002', 'P727')).toBe(true);
    expect(numbering.parseOfficialSalesOrderNumber('ORD-P726/029')).toEqual({
      kind: 'sales_order',
      origin: 'DIRECT',
      series: 'P726',
      sequence: 29,
    });
    expect(numbering.parseOfficialSalesOrderNumber('ORDER-P726/029')).toBeNull();
    expect(numbering.parseOfficialSalesOrderNumber('ORD-2026-000001')).toBeNull();
  });

  it('a provisional SO-P726/999 never becomes official by resemblance', async () => {
    // Even with an official-shaped provisional, minting consumes the counter
    // and formats from origin + configured series — never adopts the text.
    const httpPost = jest.fn(async () => ({ data: [999] }));
    const configP726 = {
      transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
    };
    await expect(
      numbering.mintOfficialSalesOrderNumber(
        { orderNumber: 'SO-P726/999', orderNumberProvisional: true },
        { getCompanyConfig: async () => configP726, httpPost }
      )
    ).resolves.toBe('ORD-P726/999');
  });

  it('no P726 hard-code in the allocation path: alternate series passes end to end', async () => {
    const seen = [];
    const httpPost = jest.fn(async (url, body) => {
      seen.push({ url, body });
      return { data: [12] };
    });
    const configP728 = {
      transactionSettings: { numbering: { shared: { extension: 'P728', padding: 4 } } },
    };
    const number = await numbering.mintOfficialSalesOrderNumber(
      { source_request_id: 'req-x' },
      { getCompanyConfig: async () => configP728, httpPost }
    );
    expect(number).toBe('SO-P728/0012');
    expect(seen[0].body).toEqual({ p_series: 'P728' });
    expect(String(seen[0].url)).toContain('/rpc/claim_next_sales_order_number');
    expect(String(seen[0].url)).not.toContain('p726');
  });
});
