/**
 * examinationInvoiceGenerationDestination.test.ts — post-generation routing.
 *
 * Generating (or regenerating) an examination invoice must land the operator on
 * the EXAMINATION invoice list. It used to navigate to `/sales-flow/invoices`
 * — the general list — which scopes examination invoices out via
 * applyGeneralInvoiceScope, so the page the operator landed on never contained
 * the invoice that had just been created.
 *
 * The deliberate exception: explicit "View invoice" deep-links keep targeting
 * `/sales-flow/invoices`, because that is where the canonical invoice detail
 * modal lives. This suite pins both halves of that rule so neither is broken
 * by the other.
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

  it('explicit "View invoice" deep-links still open the canonical detail modal', () => {
    // These are deliberate: the invoice detail modal lives on the general
    // route, and it resolves against the FULL invoice collection, so scoping
    // examination invoices out of browsing never makes them unreachable.
    expect(invoicesTab).toContain(GENERAL_LIST); // Examination Invoices row -> View
    expect(batchDetail).toContain(GENERAL_LIST); // batch detail "View Invoice {id}" button
    expect(groupManager).not.toContain(GENERAL_LIST); // group manager had no deep-link
  });
});