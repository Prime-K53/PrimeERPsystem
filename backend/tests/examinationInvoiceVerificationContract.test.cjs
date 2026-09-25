/**
 * examinationInvoiceVerificationContract.test.cjs — Phase 8 (backend half).
 *
 * Pins the ERP verification contract that Device B's link depends on, for
 * canonical examination invoices (including slash-bearing EXM numbers):
 *   number-hit (data.id OR data.invoiceNumber) AND stored-token equality
 *   → verified; anything else → generic miss.
 *
 * Uses a stub httpGet (no network, no credentials, no writes) against the
 * real verifyDocument service, mirroring the production-shaped rows the
 * canonical sync gateway commits for examination invoices.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase.test';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test-secret';

const { verifyDocument } = require('../services/documentVerificationService.cjs');

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const WRONG = '0'.repeat(64);

// Production-shaped rows: canonical examination invoices as committed by the
// sync gateway ({ id, data: { id, invoiceNumber, verificationToken, … } }).
const ROWS = [
  {
    id: 'EXM-0001',
    data: {
      id: 'EXM-0001',
      invoiceNumber: 'EXM-0001',
      date: '2026-09-20',
      customerName: 'School A',
      currency: 'MWK',
      subtotal: 1000,
      totalAmount: 1000,
      paidAmount: 0,
      status: 'Unpaid',
      verificationToken: TOKEN_A,
    },
  },
  {
    id: 'EXM-P726/0001',
    data: {
      id: 'EXM-P726/0001',
      invoiceNumber: 'EXM-P726/0001',
      date: '2026-09-20',
      customerName: 'Slash School',
      currency: 'MWK',
      subtotal: 2500,
      totalAmount: 2500,
      paidAmount: 0,
      status: 'Unpaid',
      verificationToken: TOKEN_B,
    },
  },
  {
    id: 'EXM-0003',
    data: {
      id: 'EXM-0003',
      invoiceNumber: 'EXM-0003',
      date: '2026-09-20',
      customerName: 'Untokened School',
      currency: 'MWK',
      subtotal: 500,
      totalAmount: 500,
      paidAmount: 0,
      status: 'Unpaid',
      // No verificationToken: legacy/fallback-shaped row — must never verify.
    },
  },
];

const stubHttpGet = async () => ({ data: ROWS });

describe('examination invoice verification contract', () => {
  test('canonical EXM number + token verifies', async () => {
    const result = await verifyDocument('invoice', 'EXM-0001', TOKEN_A, { httpGet: stubHttpGet });
    expect(result.ok).toBe(true);
    expect(result.data.invoiceNumber).toBe('EXM-0001');
  });

  test('slash-bearing EXM number verifies (id-only and number spelling)', async () => {
    const result = await verifyDocument('invoice', 'EXM-P726/0001', TOKEN_B, { httpGet: stubHttpGet });
    expect(result.ok).toBe(true);
    expect(result.data.invoiceNumber).toBe('EXM-P726/0001');
  });

  test('wrong token fails (no cross-acceptance between batches)', async () => {
    const result = await verifyDocument('invoice', 'EXM-0001', TOKEN_B, { httpGet: stubHttpGet });
    expect(result.ok).toBe(false);
  });

  test('unknown number fails generically', async () => {
    const result = await verifyDocument('invoice', 'EXM-9999', TOKEN_A, { httpGet: stubHttpGet });
    expect(result.ok).toBe(false);
  });

  test('untokened row never verifies (fallback-shaped records)', async () => {
    const result = await verifyDocument('invoice', 'EXM-0003', WRONG, { httpGet: stubHttpGet });
    expect(result.ok).toBe(false);
    const empty = await verifyDocument('invoice', 'EXM-0003', '', { httpGet: stubHttpGet });
    expect(empty.ok).toBe(false);
  });
});
