/**
 * examinationInvoicesTab.test.ts — Examination → Invoices tab contract.
 *
 * The tab is a specialized VIEW over canonical invoice records: it must
 * select exactly the examination invoices (same predicate the general list
 * exclusion uses), join each row to its owning batch, and never duplicate
 * records into a second store.
 */
import { describe, it, expect } from 'vitest';
import {
  selectExaminationInvoices,
  resolveExamInvoiceBatch,
  examInvoiceMenuItems,
} from '../../views/examination/ExaminationInvoices';
import { isExaminationInvoiceRecord, applyGeneralInvoiceScope } from '../../utils/invoiceIdentity';
// Module-wiring guard: the lazy route chunk fails to load if any named
// import below does not exist on its source module (Rollup hard-fails the
// chunk; esbuild-based tests would otherwise stay green). Every binding
// the view relies on is asserted here.
import { PreviewModal } from '../../views/shared/components/PDF/PreviewModal';
import { generatePrimeDocumentBlob } from '../../views/shared/components/PDF/generatePrimeDocumentBlob';
import { getStoredCompanyConfig, initializePrimePdfFonts } from '../../views/shared/components/PDF/templateSettings';
import { hydrateCompanyPdfAssets } from '../../utils/companyAssetUtils';
import { mapToInvoiceData } from '../../utils/pdfMapper';
import { attachDocumentSecurity } from '../../utils/documentSecurity';
import { enrichDocumentCustomerData } from '../../utils/documentCustomerData';
import { downloadBlob } from '../../utils/helpers';

const ORDINARY = { id: 'INV-001', invoiceNumber: 'INV-001', customerName: 'Shop', totalAmount: 500 };
const EXAM_BATCH = {
  id: 'EXM-100',
  invoiceNumber: 'EXM-100',
  customerName: 'Demo School',
  batchId: 'BTC-1',
  origin_module: 'examination',
  origin_batch_id: 'BTC-1',
  date: '2026-09-01T00:00:00.000Z',
  totalAmount: 8000,
  status: 'Unpaid',
  verificationToken: 'a'.repeat(64),
};
const LEGACY_JOB = {
  id: 'INV-900',
  invoiceNumber: 'INV-900',
  customerName: 'Old School',
  originModule: 'examination',
  category: 'Examination',
  totalAmount: 25000,
  status: 'Paid',
};
/**
 * Exact shape persisted by the legacy Production exam-paper producer
 * (api.production.generateExamInvoice). INV-series number and no origin module,
 * no document title, no batch linkage — the explicit `category` marker is the
 * only examination provenance the record carries. This is what made the tab
 * report "No examination invoices found" while a real examination invoice sat
 * in the store.
 */
const LEGACY_PRODUCTION_EXAM = {
  id: 'INV-P726/001',
  customerId: 'SCH-1',
  customerName: 'Demo School',
  date: '2026-09-20T00:00:00.000Z',
  dueDate: '2026-10-20T00:00:00.000Z',
  items: [],
  totalAmount: 3000,
  paidAmount: 0,
  status: 'Unpaid',
  type: 'Standard',
  category: 'Examination',
  notes: 'Converted from [Exam Batch] #[B1] on [9/20/2026] as accepted by [Demo School]',
  verificationToken: 'b'.repeat(64),
};

describe('Examination invoices tab selection', () => {
  it('selects examination invoices only (batch + legacy job)', () => {
    const rows = selectExaminationInvoices([ORDINARY, EXAM_BATCH, LEGACY_JOB] as any);
    expect(rows.map((row) => row.id).sort()).toEqual(['EXM-100', 'INV-900']);
  });

  it('returns the same canonical record (no duplication, no second store)', () => {
    const rows = selectExaminationInvoices([EXAM_BATCH] as any);
    expect(rows).toHaveLength(1);
    expect(rows[0].invoiceNumber).toBe('EXM-100');
    expect(rows[0].totalAmount).toBe(8000);
    expect(rows[0].verificationToken).toBe('a'.repeat(64));
  });

  it('matches the general-list exclusion predicate exactly', () => {
    const all = [ORDINARY, EXAM_BATCH, LEGACY_JOB] as any[];
    const inTab = new Set(selectExaminationInvoices(all).map((row) => row.id));
    const excludedFromGeneral = all.filter((invoice) => isExaminationInvoiceRecord(invoice)).map((invoice) => invoice.id);
    expect(Array.from(inTab).sort()).toEqual(excludedFromGeneral.sort());
  });

  it('joins rows to their owning batch', () => {
    const batches = [
      { id: 'batch-1', batch_number: 'BTC-1', name: 'Batch One', invoice_id: 'EXM-100' },
      { id: 'batch-2', batch_number: 'BTC-2', name: 'Batch Two' },
    ];
    const rows = selectExaminationInvoices([EXAM_BATCH] as any);
    expect(resolveExamInvoiceBatch(rows[0] as any, batches as any)?.id).toBe('batch-1');
    expect(resolveExamInvoiceBatch(rows[0] as any, [{ id: 'batch-9', batch_number: 'BTC-9' }] as any)).toBeNull();
  });

  it('ordinary invoices never match the examination predicate', () => {
    expect(isExaminationInvoiceRecord(ORDINARY as any)).toBe(false);
    expect(isExaminationInvoiceRecord(null)).toBe(false);
    expect(isExaminationInvoiceRecord({ id: 'INV-2', notes: 'examination of goods' } as any)).toBe(false);
  });

    it('general list keeps ordinary invoices and bypasses exact id searches', () => {    const all = [ORDINARY, EXAM_BATCH, LEGACY_JOB] as any[];
    expect(applyGeneralInvoiceScope(all).map((invoice) => invoice.id)).toEqual(['INV-001']);
    // Exact id/number search surfaces the record alongside ordinary rows.
    expect(applyGeneralInvoiceScope(all, 'EXM-100').map((invoice) => invoice.id)).toEqual(['INV-001', 'EXM-100']);
    expect(applyGeneralInvoiceScope(all, 'exm-100').map((invoice) => invoice.id)).toEqual(['INV-001', 'EXM-100']);
    expect(applyGeneralInvoiceScope(all, 'partial-match').map((invoice) => invoice.id)).toEqual(['INV-001']);
    expect(applyGeneralInvoiceScope(null)).toEqual([]);
  });

  it('menu offers full actions with void/purge gated by status', () => {
    expect(examInvoiceMenuItems({ status: 'Unpaid', paidAmount: 0, totalAmount: 8000 })).toEqual(
      ['view', 'preview', 'download', 'payment', 'ledger', 'void']
    );
    expect(examInvoiceMenuItems({ status: 'Paid', paidAmount: 8000, totalAmount: 8000 })).toEqual(
      ['view', 'preview', 'download', 'ledger']
    );
    expect(examInvoiceMenuItems({ status: 'Voided', paidAmount: 0, totalAmount: 8000 })).toEqual(
      ['view', 'preview', 'download', 'payment', 'ledger', 'purge']
    );
    expect(examInvoiceMenuItems({ status: 'Cancelled', paidAmount: 0, totalAmount: 8000 })).toEqual(
      ['view', 'preview', 'download', 'payment', 'ledger', 'purge']
    );
  });

  it('view module wiring resolves (lazy route chunk guard)', () => {
    // A missing named export fails the Rollup chunk build (blank route)
    // while esbuild-based tests stay green — so assert every binding the
    // view relies on is actually defined by its source module.
    expect(typeof PreviewModal).toBe('function');
    expect(typeof generatePrimeDocumentBlob).toBe('function');
    expect(typeof getStoredCompanyConfig).toBe('function');
    expect(typeof initializePrimePdfFonts).toBe('function');
    expect(typeof hydrateCompanyPdfAssets).toBe('function');
    expect(typeof mapToInvoiceData).toBe('function');
    expect(typeof attachDocumentSecurity).toBe('function');
    expect(typeof enrichDocumentCustomerData).toBe('function');
    expect(typeof downloadBlob).toBe('function');
  });

  it('view source imports resolve to real module exports (chunk-load guard)', async () => {
    // Static verification: every value import in ExaminationInvoices.tsx
    // must name an export that exists in the target module. This is what
    // broke the lazy route (wrong module path is invisible to esbuild).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const viewPath = path.resolve(__dirname, '../../views/examination/ExaminationInvoices.tsx');
    const viewDir = path.dirname(viewPath);
    const source = fs.readFileSync(viewPath, 'utf8');
    const importRe = /^import\s+(?!type)([^;]+?)\s+from\s+['"]([^'"]+)['"]/gm;
    const problems: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      const [, clause, spec] = match;
      if (!spec.startsWith('.')) continue; // packages/aliases resolve via bundler
      const names = clause
        .replace(/^[A-Za-z_$][\w$]*\s*,/, '')
        .replace(/^\*\s+as\s+[A-Za-z_$][\w$]*/, '')
        .split('{')[1]
        ?.split('}')[0]
        .split(',')
        .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean) || [];
      if (names.length === 0) continue;
      const candidates = [`${spec}.ts`, `${spec}.tsx`, `${spec}.ts`, `${spec}/index.ts`];
      const target = candidates
        .map((candidate) => path.resolve(viewDir, candidate))
        .find((candidate) => fs.existsSync(candidate));
      if (!target) {
        problems.push(`unresolvable module ${spec}`);
        continue;
      }
      const targetSource = fs.readFileSync(target, 'utf8');
      for (const name of names) {
        const exported =
          new RegExp(`export\\s+(const|let|var|function|class|async function)\\s+${name}\\b`).test(targetSource) ||
          new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(targetSource) ||
          new RegExp(`export\\s+default\\s+${name}\\b`).test(targetSource);
        if (!exported) problems.push(`${name} is not exported by ${spec}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('Examination invoices tab — POS / conversion invoices are not examination', () => {
  const POS = {
    id: 'POS-P726/023',
    invoiceNumber: 'POS-P726/023',
    customerName: 'Walk-in Customer',
    reference: 'POS-P726/023',
    notes: 'POS Sale - Source: POS',
    totalAmount: 25600,
    status: 'Paid',
    items: [],
  };
  const ORDER_CONVERSION = {
    id: 'INV-P726/030',
    invoiceNumber: 'INV-P726/030',
    conversionDetails: { sourceType: 'order', sourceNumber: 'ORD-1' },
    totalAmount: 1000,
  };
  const QUOTATION_CONVERSION = {
    id: 'INV-P726/031',
    invoiceNumber: 'INV-P726/031',
    conversionDetails: { sourceType: 'Quotation', sourceNumber: 'QT-1' },
    totalAmount: 2000,
  };

  it('selector excludes POS and conversion invoices (examination only)', () => {
    const rows = selectExaminationInvoices(
      [ORDINARY, POS, ORDER_CONVERSION, QUOTATION_CONVERSION, EXAM_BATCH, LEGACY_JOB] as any
    );
    expect(rows.map((row) => row.id).sort()).toEqual(['EXM-100', 'INV-900']);
  });

  it('general scope keeps POS and conversion invoices after the classifier fix', () => {
    const all = [ORDINARY, POS, ORDER_CONVERSION, QUOTATION_CONVERSION, EXAM_BATCH, LEGACY_JOB] as any[];
    expect(applyGeneralInvoiceScope(all).map((invoice) => invoice.id).sort()).toEqual([
      'INV-001',
      'INV-P726/030',
      'INV-P726/031',
      'POS-P726/023',
    ]);
  });

  it('a bare reference or conversion source is never examination provenance', () => {
    expect(isExaminationInvoiceRecord(POS as any)).toBe(false);
    expect(isExaminationInvoiceRecord(ORDER_CONVERSION as any)).toBe(false);
    expect(isExaminationInvoiceRecord(QUOTATION_CONVERSION as any)).toBe(false);
    expect(isExaminationInvoiceRecord({ id: 'INV-6', invoiceNumber: 'INV-6', reference: 'ORD-5' } as any)).toBe(false);
  });
});

describe('Examination invoices tab — legacy Production exam-paper invoices are examination', () => {
  it('selects the INV-numbered legacy production exam invoice (regression: empty tab)', () => {
    // Before the producer stamped `category`, isExaminationInvoiceRecord saw no
    // marker, no EXM number, no exam title and no batch linkage, so the tab
    // rendered "No examination invoices found" despite the stored invoice.
    const rows = selectExaminationInvoices([LEGACY_PRODUCTION_EXAM] as any);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('INV-P726/001');
    expect(rows[0].invoiceNumber).toBe('INV-P726/001');
    expect(rows[0].totalAmount).toBe(3000);
  });

  it('selects it regardless of the batch collection it is given', () => {
    expect(selectExaminationInvoices([LEGACY_PRODUCTION_EXAM] as any, [] as any)).toHaveLength(1);
    expect(selectExaminationInvoices([LEGACY_PRODUCTION_EXAM] as any, [{ id: 'unrelated' }] as any)).toHaveLength(1);
  });

  it('scopes it out of the general list but keeps exact-search reachability', () => {
    const ordinary = { id: 'INV-0009', invoiceNumber: 'INV-0009', totalAmount: 10 };
    const all = [ordinary, LEGACY_PRODUCTION_EXAM] as any[];
    expect(applyGeneralInvoiceScope(all).map((i) => i.id)).toEqual(['INV-0009']);
    expect(applyGeneralInvoiceScope(all, 'INV-P726/001').map((i) => i.id)).toEqual([
      'INV-0009',
      'INV-P726/001',
    ]);
  });

  it('the explicit category marker is load-bearing: strip it and it is unclassifiable', () => {
    const unmarked = { ...LEGACY_PRODUCTION_EXAM, category: undefined };
    expect(isExaminationInvoiceRecord(unmarked as any)).toBe(false);
    expect(selectExaminationInvoices([unmarked] as any)).toHaveLength(0);

    // The POS/conversion hardening must survive: with the marker stripped, a
    // plain `reference` or an order/quotation conversion source is still not
    // examination provenance.
    expect(isExaminationInvoiceRecord({ ...unmarked, reference: 'ORD-5' } as any)).toBe(false);
    expect(
      isExaminationInvoiceRecord({
        ...unmarked,
        conversionDetails: { sourceType: 'order', sourceNumber: 'ORD-5' },
      } as any)
    ).toBe(false);

    // A bare `batchId` names an examination batch only when a batch collection
    // is supplied and actually contains that batch — the tightened linkage
    // contract. With unrelated batches it classifies as nothing.
    const bareBatchId = { ...unmarked, batchId: 'B1' };
    expect(isExaminationInvoiceRecord(bareBatchId as any, [{ id: 'unrelated' }] as any)).toBe(false);
    expect(isExaminationInvoiceRecord(bareBatchId as any, [{ id: 'B1', batch_number: 'B1' }] as any)).toBe(true);
  });
});
