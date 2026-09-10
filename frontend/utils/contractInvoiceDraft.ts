import type { AssessmentContractItem, CartItem, Customer, Invoice } from '../types';
import { getCustomerDisplayName } from './customerDisplay';

export interface ContractFormLine {
  key: string;
  assessment_name: string;
  assessment_type: string;
  assessment_grade: string;
  assessment_subject: string;
  assessment_date: string;
  quantity: number;
  unit_price: number;
}

export const emptyContractLine = (assessmentType = 'examination'): ContractFormLine => ({
  key: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  assessment_name: '',
  assessment_type: assessmentType,
  assessment_grade: '',
  assessment_subject: '',
  assessment_date: new Date().toISOString().slice(0, 10),
  quantity: 1,
  unit_price: 0,
});

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const contractLineAmount = (line: Pick<ContractFormLine, 'quantity' | 'unit_price'>): number =>
  Math.max(0, Math.floor(num(line.quantity))) * Math.max(0, num(line.unit_price));

export const contractLinesTotal = (lines: Pick<ContractFormLine, 'quantity' | 'unit_price'>[]): number =>
  (lines || []).reduce((sum, l) => sum + contractLineAmount(l), 0);

export const contractLinesQuantity = (lines: Pick<ContractFormLine, 'quantity'>[]): number =>
  (lines || []).reduce((sum, l) => sum + Math.max(0, Math.floor(num(l.quantity))), 0);

export const isValidContractLine = (line: Pick<ContractFormLine, 'assessment_name' | 'quantity' | 'unit_price'>): boolean =>
  String(line.assessment_name || '').trim().length > 0 &&
  Math.floor(num(line.quantity)) > 0 &&
  num(line.unit_price) >= 0;

const lineLabel = (line: ContractFormLine): string => {
  const bits = [line.assessment_grade, line.assessment_subject].filter(Boolean).join(' · ');
  return bits ? `${line.assessment_name} (${bits})` : line.assessment_name;
};

export interface ContractItemBuildContext {
  contract_id: string;
  company_id: string;
  customer_id: string;
  school_id: string;
  created_by: string;
  now: string;
}

/**
 * Expand invoice-style form lines into contractual assessment records.
 * Each unit of quantity becomes one `reserved` assessment item at the line's
 * unit price, so entitlement counts stay exact (max_assessments = Σ qty).
 */
export const buildContractItemsFromLines = (
  ctx: ContractItemBuildContext,
  lines: ContractFormLine[],
): AssessmentContractItem[] => {
  const items: AssessmentContractItem[] = [];
  for (const line of lines || []) {
    if (!isValidContractLine(line)) continue;
    const qty = Math.max(0, Math.floor(num(line.quantity)));
    const unitPrice = Math.max(0, num(line.unit_price));
    for (let i = 0; i < qty; i++) {
      items.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
        contract_id: ctx.contract_id,
        company_id: ctx.company_id,
        customer_id: ctx.customer_id,
        school_id: ctx.school_id,
        assessment_type: line.assessment_type || 'examination',
        assessment_grade: line.assessment_grade || undefined,
        assessment_subject: line.assessment_subject || undefined,
        assessment_name: line.assessment_name.trim(),
        assessment_date: line.assessment_date
          ? new Date(line.assessment_date).toISOString()
          : undefined,
        status: 'reserved',
        item_price: unitPrice,
        reserved_at: ctx.now,
        created_by: ctx.created_by,
        created_at: ctx.now,
        updated_at: ctx.now,
        version: 1,
        data: {},
      });
    }
  }
  return items;
};

export interface ContractInvoiceBuildContext {
  contract_number: string;
  contract_title: string;
  customer: Pick<Customer, 'id' | 'name'> & Record<string, any>;
  issuedDate: string;
  terms?: string;
  notes?: string;
}

/**
 * Build a sales-invoice draft from a printing contract, exactly like an
 * invoice issued from the sales flow: Unpaid (receivable, no stock movement —
 * service lines carry no inventory product), referenced to the contract.
 * Saved through the standard issuance path (`addInvoice`).
 */
export const buildInvoiceDraftFromContract = (
  ctx: ContractInvoiceBuildContext,
  lines: ContractFormLine[],
): Partial<Invoice> & Record<string, any> => {
  const valid = (lines || []).filter(isValidContractLine);
  const items: CartItem[] = valid.map((line) => ({
    id: `CL-${line.key}`,
    name: lineLabel(line),
    description: `${line.assessment_type || 'Printing'} — contract ${ctx.contract_number}`,
    quantity: Math.max(0, Math.floor(num(line.quantity))),
    price: Math.max(0, num(line.unit_price)),
    cost: 0,
    type: 'Service',
    unit: 'job',
  }));
  const total = contractLinesTotal(valid);
  const customerName = getCustomerDisplayName({
    businessName: (ctx.customer as any)?.businessName ?? null,
    companyName: (ctx.customer as any)?.companyName ?? null,
    legacyCustomerName: ctx.customer?.name ?? null,
  });

  return {
    id: '',
    invoiceNumber: '',
    customerId: ctx.customer?.id || '',
    customerName,
    date: ctx.issuedDate,
    dueDate: ctx.issuedDate,
    status: 'Unpaid',
    paidAmount: 0,
    totalAmount: total,
    items,
    reference: ctx.contract_number,
    referenceDoc: ctx.contract_number,
    notes: `Printing contract ${ctx.contract_number} — ${ctx.contract_title}${ctx.notes ? `. ${ctx.notes}` : ''}`,
    paymentTerms: '',
    originModule: 'printing_contract',
  };
};
