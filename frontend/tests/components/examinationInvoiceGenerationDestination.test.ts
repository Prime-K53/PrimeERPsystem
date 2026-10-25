/**
 * examinationInvoiceGenerationDestination.test.ts — post-generation routing.
 *
 * Generating (or regenerating) an examination invoice must land the operator on
 * the EXAMINATION invoice list. It used to navigate to `/sales-flow/invoices`
 * — the general list — which scopes examination invoices out via
 * applyGeneralInvoiceScope, so the page the operator landed on never contained
 * the invoice that had just been created.
 *
 * The deliberate exception: batch-detail "View Invoice {id}" keeps targeting
 * `/sales-flow/invoices`, because that is where the canonical invoice detail
 * modal lives. The Examination Invoices list itself now opens an in-module
 * detail modal instead of navigating away. This suite pins both halves of that
 * rule so neither is broken by the other.
 *
 * Source-level contract (same technique as the lazy-route chunk guard in
 * examinationInvoicesTab.test.ts): these two views pull in the full
 * examination/finance/PDF module graph, so the handlers are asserted in
 * isolation by extracting each named handler body rather than mounting them.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const readSource = (relative: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', relative), 'utf8');

/** Extracts one top-level `const <name> = ... => { ... }` handler body. */
const handlerBody = (source: string, name: string): string => {
  const start = source.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`handler not found: ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated handler: ${name}`);
};

const EXAM_LIST = "navigate('/examination/invoices')";
const GENERAL_LIST = "'/sales-flow/invoices'";

describe('Examination invoice generation navigates to the examination invoice list', () => {
  const batchDetail = readSource('views/examination/ExaminationBatchDetail.tsx');
  const groupManager = readSource('views/examination/InvoiceGroupManager.tsx');
  const invoicesTab = readSource('views/examination/ExaminationInvoices.tsx');

  it('batch detail: generateInvoice lands on the examination list', () => {
    const body = handlerBody(batchDetail, 'handleGenerateInvoice');
    expect(body).toContain(EXAM_LIST);
    expect(body).not.toContain(GENERAL_LIST);
  });

  it('batch detail: regenerateInvoice lands on the examination list', () => {
    const body = handlerBody(batchDetail, 'handleRegenerateInvoice');
    expect(body).toContain(EXAM_LIST);
    expect(body).not.toContain(GENERAL_LIST);
  });

  it('invoice group: generateInvoiceForGroup lands on the examination list', () => {
    const body = handlerBody(groupManager, 'handleGenerateInvoice');
    expect(body).toContain(EXAM_LIST);
    expect(body).not.toContain(GENERAL_LIST);
  });

  it('generation success copy no longer promises the Sales invoice list', () => {
    expect(batchDetail).not.toContain('Opened Sales Invoices');
    expect(batchDetail).toContain('Opened Examination Invoices');
  });

  it('examination list opens its in-module detail modal instead of the general route', () => {
    // The list owns a detail modal over the same canonical record, so a row
    // click must stay in the Examination module. A route change to the general
    // invoice list is the regression this pins.
    expect(invoicesTab).toContain('setDetailRow(row)');
    expect(invoicesTab).toContain('<ExaminationInvoiceDetailModal');
    expect(invoicesTab).not.toContain(GENERAL_LIST);
  });

  it('batch detail keeps the deliberate canonical-invoice deep-link', () => {
    // The invoice detail modal lives on the general route and resolves against
    // the FULL invoice collection, so this explicit deep-link stays.
    expect(batchDetail).toContain(GENERAL_LIST);
    expect(groupManager).not.toContain(GENERAL_LIST); // group manager had no deep-link
  });
});