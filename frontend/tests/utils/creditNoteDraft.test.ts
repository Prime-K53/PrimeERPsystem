/**
 * Credit-note draft builder — pins the conventions the Quick action relies on:
 * fresh identity, credit_note status, positive amounts (ledger convention),
 * deep-cloned items, and a traceable link back to the source invoice.
 */
import { describe, it, expect } from 'vitest';
import { buildCreditNoteDraftFromInvoice, CREDIT_NOTE_STATUS } from '../../utils/creditNoteDraft';

const SOURCE = {
  id: 'INV-2041',
  invoiceNumber: 'INV-2041',
  customerId: 'C-1',
  customerName: 'Kaphuka PVT School',
  totalAmount: 125000,
  paidAmount: 25000,
  date: '2026-09-04',
  dueDate: '2026-10-04',
  status: 'Unpaid',
  paymentTerms: 'Net 30',
  salesAccountId: '41100',
  notes: 'Term 3 fees',
  items: [{ id: 'IT-1', name: 'Tuition', quantity: 1, price: 125000 }],
};

describe('buildCreditNoteDraftFromInvoice', () => {
  it('clears identity so the save path generates fresh numbers', () => {
    const draft = buildCreditNoteDraftFromInvoice(SOURCE, '2026-09-10');
    expect(draft.id).toBe('');
    expect(draft.invoiceNumber).toBe('');
  });

  it('marks the draft as a credit note with zero applied payment', () => {
    const draft = buildCreditNoteDraftFromInvoice(SOURCE, '2026-09-10');
    expect(draft.status).toBe(CREDIT_NOTE_STATUS);
    expect(draft.paidAmount).toBe(0);
    expect(draft.date).toBe('2026-09-10');
    expect(draft.dueDate).toBe('2026-09-10');
  });

  it('keeps positive amounts and customer context (ledger credit convention)', () => {
    const draft = buildCreditNoteDraftFromInvoice(SOURCE, '2026-09-10');
    expect(draft.totalAmount).toBe(125000);
    expect(draft.customerId).toBe('C-1');
    expect(draft.customerName).toBe('Kaphuka PVT School');
    expect(draft.salesAccountId).toBe('41100');
  });

  it('links back to the source invoice for traceability', () => {
    const draft = buildCreditNoteDraftFromInvoice(SOURCE, '2026-09-10');
    expect(draft.referenceDoc).toBe('INV-2041');
    expect(String(draft.notes)).toContain('INV-2041');
  });

  it('deep-clones line items so the source invoice is never mutated', () => {
    const draft = buildCreditNoteDraftFromInvoice(SOURCE, '2026-09-10');
    expect(draft.items).toEqual(SOURCE.items);
    expect(draft.items?.[0]).not.toBe(SOURCE.items[0]);
    (draft.items as any[])[0].price = 0;
    expect(SOURCE.items[0].price).toBe(125000);
  });
});
