const {
  validateProductsPayload,
  buildVariantSkuBase,
  buildVariantId,
  slugifyVariantToken,
  normalizeSkuKey,
} = require('../services/variantSku.cjs');

const productsRow = (data) => ({ id: data.id, data });

const products = (...docs) => docs.map(productsRow);

describe('variant SKU generation', () => {
  it('slugifies variant names into readable tokens', () => {
    expect(slugifyVariantToken('48 Pages')).toBe('48-PAGES');
    expect(slugifyVariantToken('A4 Blue')).toBe('A4-BLUE');
  });

  it('strips the parent name prefix the editor adds', () => {
    expect(slugifyVariantToken('Exercise Book - A4 Blue', 'Exercise Book')).toBe('A4-BLUE');
  });

  it('builds the documented PAPER-001-A4-BLUE shape', () => {
    expect(buildVariantSkuBase('PAPER-001', 'PRD-1', { name: 'A4 Blue' })).toBe('PAPER-001-A4-BLUE');
  });

  it('builds deterministic variant ids', () => {
    expect(buildVariantId('PRD-0001', 0)).toBe('VAR-PRD-0001-1');
  });

  it('normalises SKU comparison keys', () => {
    expect(normalizeSkuKey('  exb-48 ')).toBe('EXB-48');
  });
});

describe('creation — the gateway stamps identity onto the payload', () => {
  it('gives a variant a stable id and a unique SKU', () => {
    const payload = { id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001', variants: [{ name: '48 Pages' }] };
    expect(validateProductsPayload(payload, [])).toBeNull();
    expect(payload.variants[0].id).toBe('VAR-PRD-0001-1');
    expect(payload.variants[0].sku).toBe('EXB-001-48-PAGES');
  });

  it('gives multiple variants distinct ids and SKUs', () => {
    const payload = {
      id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001',
      variants: [{ name: '48 Pages' }, { name: '96 Pages' }, { name: 'A4 Blue' }],
    };
    validateProductsPayload(payload, []);
    expect(payload.variants.map(v => v.id)).toEqual([
      'VAR-PRD-0001-1', 'VAR-PRD-0001-2', 'VAR-PRD-0001-3',
    ]);
    expect(payload.variants.map(v => v.sku)).toEqual([
      'EXB-001-48-PAGES', 'EXB-001-96-PAGES', 'EXB-001-A4-BLUE',
    ]);
  });

  it('leaves a parent without variants untouched', () => {
    const payload = { id: 'PRD-0001', name: 'Paper', sku: 'A4P-001' };
    expect(validateProductsPayload(payload, [])).toBeNull();
    expect(payload.variants).toBeUndefined();
  });

  it('is a no-op for a delete-shaped or malformed payload', () => {
    expect(validateProductsPayload(null, [])).toBeNull();
  });
});

describe('uniqueness — one global namespace', () => {
  it('rejects a variant SKU equal to its own parent SKU', () => {
    const payload = { id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001', variants: [{ id: 'v1', sku: 'EXB-001' }] };
    expect(validateProductsPayload(payload, [])).toMatch(/parent item/i);
  });

  it('rejects a variant SKU equal to another parent item SKU', () => {
    const rows = products({ id: 'PRD-0002', name: 'Ledger', sku: 'EXB-001' });
    const payload = { id: 'PRD-0001', name: 'Exercise Book', sku: 'INV-1', variants: [{ id: 'v1', sku: 'EXB-001' }] };
    expect(validateProductsPayload(payload, rows)).toMatch(/already used by item "Ledger"/i);
  });

  it('rejects a duplicate variant SKU on the same parent', () => {
    const payload = {
      id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001',
      variants: [{ id: 'v1', sku: 'SAME' }, { id: 'v2', sku: 'SAME' }],
    };
    expect(validateProductsPayload(payload, [])).toMatch(/already used by variant/i);
  });

  it('rejects a variant SKU colliding with another parent variant SKU', () => {
    const rows = products({ id: 'PRD-0002', name: 'Notebook', sku: 'NTB-1', variants: [{ id: 'o1', sku: 'SHARED' }] });
    const payload = { id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-1', variants: [{ id: 'v1', sku: 'SHARED' }] };
    expect(validateProductsPayload(payload, rows)).toMatch(/already used by variant/i);
  });

  it('is case-insensitive', () => {
    const rows = products({ id: 'PRD-0002', name: 'Ledger', sku: 'EXB-001' });
    const payload = { id: 'PRD-0001', name: 'Exercise Book', sku: 'INV-1', variants: [{ id: 'v1', sku: 'exb-001' }] };
    expect(validateProductsPayload(payload, rows)).toBeTruthy();
  });

  it('lets a record keep its own current variant SKU on update', () => {
    const rows = products({
      id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001',
      variants: [{ id: 'v1', name: '48 Pages', sku: 'EXB-001-48-PAGES' }],
    });
    const payload = {
      id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001',
      variants: [{ id: 'v1', name: '48 Pages', sku: 'EXB-001-48-PAGES' }],
    };
    expect(validateProductsPayload(payload, rows)).toBeNull();
  });

  it('mints a suffixed SKU when the base candidate is taken', () => {
    const rows = products({ id: 'PRD-0002', name: 'Other', sku: 'O-1', variants: [{ id: 'o1', sku: 'EXB-001-A4' }] });
    const payload = { id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001', variants: [{ name: 'A4' }] };
    expect(validateProductsPayload(payload, rows)).toBeNull();
    expect(payload.variants[0].sku).toBe('EXB-001-A4-2');
  });

  it('rejects a malformed SKU', () => {
    const payload = { id: 'PRD-0001', name: 'X', sku: 'INV-1', variants: [{ id: 'v1', sku: 'bad sku!' }] };
    expect(validateProductsPayload(payload, [])).toMatch(/Invalid variant SKU/i);
  });
});

describe('preservation guarantees', () => {
  it('never rewrites an existing variant id or SKU', () => {
    const payload = {
      id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001',
      variants: [{ id: 'keep-1', name: '48 Pages', sku: 'LEGACY-A' }],
    };
    validateProductsPayload(payload, []);
    expect(payload.variants[0].id).toBe('keep-1');
    expect(payload.variants[0].sku).toBe('LEGACY-A');
  });

  it('preserves stock, prices and attributes while stamping identity', () => {
    const payload = {
      id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001',
      variants: [{ name: '48 Pages', costPrice: 8, sellingPrice: 15, stock: 42, attributes: { pages: 48 } }],
    };
    validateProductsPayload(payload, []);
    const v = payload.variants[0];
    expect(v.id).toBe('VAR-PRD-0001-1');
    expect(v.sku).toBe('EXB-001-48-PAGES');
    expect(v.stock).toBe(42);
    expect(v.costPrice).toBe(8);
    expect(v.sellingPrice).toBe(15);
    expect(v.attributes).toEqual({ pages: 48 });
  });

  it('never changes the parent SKU', () => {
    const payload = { id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001', variants: [{ name: '48 Pages' }] };
    validateProductsPayload(payload, []);
    expect(payload.sku).toBe('EXB-001');
  });

  it('deduplicates repeated variant ids inside one item', () => {
    const payload = {
      id: 'PRD-0001', name: 'X', sku: 'EXB-001',
      variants: [{ id: 'dup', name: 'A' }, { id: 'dup', name: 'B' }],
    };
    validateProductsPayload(payload, []);
    expect(payload.variants[0].id).toBe('dup');
    expect(payload.variants[1].id).not.toBe('dup');
  });
});

describe('idempotency', () => {
  it('re-running the validation on its own output changes nothing', () => {
    const rows = products({ id: 'PRD-0002', name: 'Ledger', sku: 'LEDG-001', variants: [{ name: '48 Pages' }] });
    const payload = { id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001', variants: [{ name: '48 Pages' }] };

    validateProductsPayload(payload, rows);
    const first = JSON.stringify(payload.variants);

    // Second pass sees the first pass's output as existing data.
    validateProductsPayload(payload, [...rows, productsRow({ ...payload })]);
    expect(JSON.stringify(payload.variants)).toBe(first);
  });

  it('mints the same SKU for the same input every time', () => {
    const rows = products({ id: 'PRD-0002', name: 'Other', sku: 'O-1', variants: [{ id: 'o1', sku: 'EXB-001-A4' }] });
    const a = { id: 'PRD-0001', name: 'X', sku: 'EXB-001', variants: [{ name: 'A4' }] };
    const b = { id: 'PRD-0001', name: 'X', sku: 'EXB-001', variants: [{ name: 'A4' }] };
    validateProductsPayload(a, rows);
    validateProductsPayload(b, rows);
    expect(a.variants[0].sku).toBe(b.variants[0].sku);
  });
});