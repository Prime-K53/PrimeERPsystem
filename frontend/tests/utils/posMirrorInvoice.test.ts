/**
 * posMirrorInvoice.test.ts — POS-mirror invoices preview as POS receipts.
 *
 * The general invoice list routes POS-mirror invoices to the narrow
 * thermal-slip POS receipt design (PrimeDocument 'POS_RECEIPT') instead of
 * the general invoice design. Covers the shared predicate
 * (isPosMirrorInvoiceRecord — mirrors the SalesAudit revenue split) and the
 * invoice->receipt builder (linked-sale fidelity first, invoice synthesis
 * fallback), with service modules mocked so no IndexedDB is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPosMirrorInvoiceRecord } from '../../utils/invoiceIdentity';
import {
  buildPosReceiptDocFromInvoiceRecord,
  resolvePosReceiptRefForSale,
} from '../../utils/posReceiptFromInvoice';
import { PosReceiptSchema } from '../../views/shared/components/PDF/schemas';
import { dbService } from '../../services/db';
import { transactionService } from '../../services/transactionService';

vi.mock('../../services/db', () => ({
  dbService: { get: vi.fn(), getAll: vi.fn() },
}));

vi.mock('../../services/transactionService', () => ({
  transactionService: { getOrIssueDocumentVerificationToken: vi.fn() },
}));

const mockedGet = vi.mocked(dbService.get);
const mockedGetAll = vi.mocked(dbService.getAll);
const mockedIssueToken = vi.mocked(
  transactionService.getOrIssueDocumentVerificationToken
);

beforeEach(() => {
  vi.clearAllMocks();
  mockedGet.mockResolvedValue(null);
  mockedGetAll.mockResolvedValue([]);
});

const baseInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'INV-P726/101',
  invoiceNumber: 'INV-P726/101',
  date: '2026-09-14',
  customerName: 'Walk-in Customer',
  items: [
    { name: 'A4 Photocopy', quantity: 10, unitPrice: 150, total: 1500 },
    { name: 'Binding', quantity: 1, unitPrice: 2000, total: 2000 },
  ],
  subtotal: 3500,
  totalAmount: 3500,
  paidAmount: 3500,
  paymentMethod: 'Cash',
  status: 'Paid',
  ...overrides,
});

describe('isPosMirrorInvoiceRecord', () => {
  it('matches explicit POS markers', () => {
    expect(isPosMirrorInvoiceRecord(baseInvoice({ originModule: 'pos' }))).toBe(true);
    expect(isPosMirrorInvoiceRecord(baseInvoice({ origin_module: 'POS' }))).toBe(true);
    expect(
      isPosMirrorInvoiceRecord(baseInvoice({ conversionDetails: { sourceType: 'sale' } }))
    ).toBe(true);
    expect(
      isPosMirrorInvoiceRecord(baseInvoice({ conversionDetails: { sourceType: 'Sale' } }))
    ).toBe(true);
    expect(isPosMirrorInvoiceRecord(baseInvoice({ sourceType: 'POS' }))).toBe(true);
    expect(isPosMirrorInvoiceRecord(baseInvoice({ notes: 'POS sale #S-1' }))).toBe(true);
    expect(isPosMirrorInvoiceRecord(baseInvoice({ notes: 'Source: POS terminal 2' }))).toBe(true);
  });

  it('matches a reference naming a known sale, only with the sale set', () => {
    const withRef = baseInvoice({ reference: 'SALE-99' });
    expect(isPosMirrorInvoiceRecord(withRef)).toBe(false);
    expect(isPosMirrorInvoiceRecord(withRef, new Set(['SALE-99']))).toBe(true);
    expect(isPosMirrorInvoiceRecord(withRef, ['OTHER-1'])).toBe(false);
  });

  it('rejects ordinary and examination invoices', () => {
    expect(isPosMirrorInvoiceRecord(baseInvoice())).toBe(false);
    expect(isPosMirrorInvoiceRecord(baseInvoice({ reference: 'ORD-P726/5' }))).toBe(false);
    expect(isPosMirrorInvoiceRecord(baseInvoice({ originModule: 'examination' }))).toBe(false);
    expect(isPosMirrorInvoiceRecord(baseInvoice({ notes: 'Deposit for job' }))).toBe(false);
    expect(isPosMirrorInvoiceRecord(null)).toBe(false);
    expect(isPosMirrorInvoiceRecord(undefined)).toBe(false);
    expect(isPosMirrorInvoiceRecord('pos' as unknown as Record<string, unknown>)).toBe(false);
  });
});

describe('resolvePosReceiptRefForSale', () => {
  it('links the first REC row and mints a token when missing', async () => {
    mockedGetAll.mockResolvedValue([
      { id: 'REC-2', reference: 'SALE-1' },
      { id: 'REC-1', reference: 'SALE-1', verificationToken: 't'.repeat(64) },
    ]);
    mockedIssueToken.mockResolvedValue({ token: 'n'.repeat(64) } as never);

    // No token on first-by-id row -> issues one (deterministic first id).
    const ref = await resolvePosReceiptRefForSale('SALE-1', 'FALLBACK');
    expect(ref.receiptNumber).toBe('REC-1');
    expect(ref.verificationToken).toBe('t'.repeat(64));
    expect(mockedIssueToken).not.toHaveBeenCalled();
  });

  it('falls back to the sale number when no REC row exists', async () => {
    const ref = await resolvePosReceiptRefForSale('SALE-9', 'SALE-9');
    expect(ref).toEqual({ receiptNumber: 'SALE-9' });
  });
});

describe('buildPosReceiptDocFromInvoiceRecord', () => {
  const ctx = (overrides: Record<string, unknown> = {}) => ({
    companyConfig: { companyName: 'Acme', currencySymbol: 'K' },
    ...overrides,
  });

  it('returns null for ordinary invoices (no markers, no linked sale)', async () => {
    await expect(
      buildPosReceiptDocFromInvoiceRecord(baseInvoice(), ctx())
    ).resolves.toBeNull();
    await expect(buildPosReceiptDocFromInvoiceRecord(null, ctx())).resolves.toBeNull();
  });

  it('synthesizes a valid receipt from a marked invoice without a sale', async () => {
    const receipt = await buildPosReceiptDocFromInvoiceRecord(
      baseInvoice({ originModule: 'pos' }),
      ctx({
        findReceiptRef: async (saleId: string) => ({ receiptNumber: saleId }),
      })
    );
    expect(receipt).not.toBeNull();
    expect(PosReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(receipt?.receiptNumber).toBe('INV-P726/101');
    expect(receipt?.cashierName).toBe('Cashier');
    expect(receipt?.totalAmount).toBe(3500);
    expect(receipt?.paymentMethod).toBe('Cash');
    expect((receipt?.items as unknown[])?.length).toBe(2);
  });

  it('prefers the linked sale and resolves the cashier + receipt token', async () => {
    const sale = {
      id: 'SALE-7',
      date: '2026-09-14',
      customerName: 'Jane',
      cashierId: 'U-1',
      items: [{ name: 'Flyers', quantity: 100, price: 50, total: 5000 }],
      subtotal: 5000,
      totalAmount: 5000,
      paymentMethod: 'Cash',
      payments: [{ method: 'Cash', amount: 5000 }],
    };
    const receipt = await buildPosReceiptDocFromInvoiceRecord(
      baseInvoice({ reference: 'SALE-7' }),
      ctx({
        allUsers: [{ id: 'U-1', fullName: 'Cashier Jane' }],
        currentUserName: 'Owner',
        findSale: async () => sale,
        findReceiptRef: async () => ({
          receiptNumber: 'REC-7',
          verificationToken: 'v'.repeat(64),
        }),
      })
    );
    expect(receipt?.cashierName).toBe('Cashier Jane');
    expect(receipt?.customerName).toBe('Jane');
    expect(receipt?.receiptNumber).toBe('REC-7');
    expect(receipt?.verificationToken).toBe('v'.repeat(64));
    expect(receipt?.totalAmount).toBe(5000);
  });

  it('falls back to synthesis when the linked sale is gone', async () => {
    mockedGet.mockResolvedValue(null);
    const receipt = await buildPosReceiptDocFromInvoiceRecord(
      baseInvoice({ conversionDetails: { sourceType: 'sale' }, reference: 'SALE-GONE' }),
      ctx({ findReceiptRef: async (saleId: string) => ({ receiptNumber: saleId }) })
    );
    // Synthesized receipts are numbered by the invoice being previewed.
    expect(receipt?.receiptNumber).toBe('INV-P726/101');
    expect(PosReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it('throws a readable error when the receipt cannot be built', async () => {
    await expect(
      buildPosReceiptDocFromInvoiceRecord(
        baseInvoice({ originModule: 'pos', items: [] }),
        ctx({ findReceiptRef: async (saleId: string) => ({ receiptNumber: saleId }) })
      )
    ).rejects.toThrow(/POS receipt validation failed/);
  });
});
