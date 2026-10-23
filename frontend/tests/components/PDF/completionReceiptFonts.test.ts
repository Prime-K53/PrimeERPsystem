/**
 * completionReceiptFonts.test.ts — PDF font-family guard.
 *
 * @react-pdf/renderer throws "Font family not registered: …" for any
 * fontFamily that is neither a PDF standard-14 family nor explicitly
 * registered through Font.register(). A CSS font stack
 * (e.g. "'JetBrains Mono', monospace") is therefore a hard failure that
 * surfaces as "Preview Failed" in the document preview modal.
 *
 * These tests render the completion receipt (the document that prints
 * monospace reference ids) and assert that every fontFamily used by the
 * PDF templates resolves to a family react-pdf can actually embed.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';

const PDF_DIR = path.resolve(__dirname, '../../../views/shared/components/PDF');

/** Families react-pdf can embed without an explicit Font.register() call. */
const RESOLVABLE_FAMILIES = new Set([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Symbol',
  'ZapfDingbats',
  // Registered in templateSettings.initializePrimePdfFonts().
  'Comic Sans MS',
]);

const receipt: any = {
  receiptNumber: 'CCR-0001',
  contractNumber: 'PC-0007',
  date: '2026-09-19T00:00:00.000Z',
  version: 1,
  status: 'completed',
  customerName: 'Acme School',
  schoolName: 'Acme Primary',
  item: {
    assessmentName: 'Mathematics',
    grade: 'Grade 8',
    subject: 'Maths',
    consumedAt: '2026-09-18T00:00:00.000Z',
    unitPrice: 1250,
  },
  sequence: 1,
  totalAssessments: 4,
  completedToDate: 1,
  remainingAssessments: 3,
  contractValue: 5000,
  amountDebited: 1250,
  totalConsumedToDate: 1250,
  remainingReservedFunds: 3750,
  unallocatedFunds: 0,
  walletBalanceAfter: 500,
  walletTransactionId: 'wt-9f2c',
  ledgerEntryId: 'le-71ab',
  contentHash: 'c'.repeat(64),
};

const collectTemplateFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return collectTemplateFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });

describe('PDF template font families', () => {
  it('renders the contract completion receipt without an unregistered font', async () => {
    const out = await pdf(
      React.createElement(PrimeDocument as any, {
        type: 'CONTRACT_COMPLETION_RECEIPT',
        data: receipt,
      })
    ).toString();

    expect(typeof out).toBe('string');
    expect(String(out).length).toBeGreaterThan(0);
  });

  it('uses only font families react-pdf can resolve', () => {
    const offenders: string[] = [];

    for (const file of collectTemplateFiles(PDF_DIR)) {
      const source = readFileSync(file, 'utf8');
      // Only react-pdf templates can trigger the renderer error; DOM styles
      // in the same folder (e.g. the modal chrome) are plain CSS.
      if (!source.includes("from '@react-pdf/renderer'")) continue;
      const matches = source.matchAll(/fontFamily\s*:\s*(?:'([^']*)'|"([^"]*)")/g);
      for (const match of matches) {
        const family = match[1] ?? match[2] ?? '';
        if (RESOLVABLE_FAMILIES.has(family)) continue;
        offenders.push(`${path.relative(PDF_DIR, file)}: ${family}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
