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
