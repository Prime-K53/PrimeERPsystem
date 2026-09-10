import type { Invoice } from '../types';

const cloneValue = <T,>(value: T): T => {
  if (value == null) return value;
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
};

export const CREDIT_NOTE_STATUS = 'credit_note' as const;

/**
 * Build a credit-note draft from a posted invoice.
 *
 * Conventions (must stay in sync with the rest of the app):
 * - Positive amounts + `status: 'credit_note'`. The canonical ledger
 *   (`services/customerLedger.ts`), statements and the customer workspace
 *   already treat credit_note invoices as credits; amounts are never negated.
 * - Identity fields are cleared so the save path generates fresh ones.
 * - Line items are deep-cloned so editing the draft can never mutate the
 *   source invoice.
 * - Posting behaviour is unchanged: the draft travels the standard
 *   OrderForm → updateInvoice record path (plain put, no ledger entries),
 *   exactly like a duplicated-invoice draft.
 */
export const buildCreditNoteDraftFromInvoice = (
  invoice: Partial<Invoice> & Record<string, any>,
  issuedDate: string = new Date().toISOString().split('T')[0],
): Partial<Invoice> & Record<string, any> => {
  const sourceRef = invoice.invoiceNumber || invoice.id || '';
  const items = Array.isArray(invoice.items)
    ? invoice.items.map((item: any) => cloneValue(item))
    : [];

  return {
    ...cloneValue(invoice),
    id: '',
    invoiceNumber: '',
    items,
    date: issuedDate,
    dueDate: issuedDate,
    status: CREDIT_NOTE_STATUS,
    paidAmount: 0,
    allocations: [],
    conversionDetails: undefined,
    referenceDoc: sourceRef,
    notes: `Credit note against Invoice #${sourceRef}${invoice.notes ? ` — ${invoice.notes}` : ''}`,
  };
};
