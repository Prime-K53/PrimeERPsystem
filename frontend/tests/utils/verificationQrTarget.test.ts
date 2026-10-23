/**
 * verificationQrTarget.test.ts — WHERE a scanned QR code lands.
 *
 * A customer scans the QR on a printed document and must land on the
 * verification result, never on a login page.
 *
 * The customer PORTAL renders its public verification page only for a fixed
 * list of document types (its route whitelist):
 *
 *   /^\/(verify\/invoice|verify\/(receipt|quotation|sales-order|purchase-order|
 *       delivery-note|supplier-payment|statement))/
 *
 * For any other type the Portal falls through to its authenticated shell, so
 * a scanner lands on the Portal LOGIN page. The printing contract, the
 * assessment schedule, the completion receipt and work orders are NOT in that
 * list — their QR codes must therefore point at the app that serves the
 * verification route for EVERY type: the ERP app's public /#/verify route
 * (which renders for an unauthenticated visitor).
 */
import { describe, it, expect } from 'vitest';
import {
  PORTAL_SERVED_VERIFICATION_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  buildDocumentVerificationUrl,
  isPortalServedVerificationType,
  pickVerificationBaseUrl,
  resolveVerificationBaseUrl,
} from '../../utils/documentVerification';
import { buildSecurityQrPayload } from '../../utils/documentSecurity';

const PORTAL = 'https://primeportalmw.vercel.app';
const APP = 'https://erp.example.com';
const TOKEN = 'a'.repeat(64);

describe('the Portal-served verification types', () => {
  it('covers every supported type (the Portal serves every /verify/... route)', () => {
    expect([...PORTAL_SERVED_VERIFICATION_TYPES].sort())
      .toEqual([...SUPPORTED_DOCUMENT_TYPES].sort());
  });

  it('includes the contract documents, so their QR never dead-ends on a login', () => {
    for (const type of [
      'printing_contract',
      'printing_contract_schedule',
      'printing_contract_completion_receipt',
      'work_order',
    ] as const) {
      expect(isPortalServedVerificationType(type)).toBe(true);
    }
  });
});

describe('which origin a verification URL points at', () => {
  it('uses the Portal for the types it serves', () => {
    expect(pickVerificationBaseUrl({
      type: 'invoice', portalOrigin: PORTAL, appOrigin: APP, isProduction: true,
    })).toBe(PORTAL);
    expect(pickVerificationBaseUrl({
      type: 'statement', portalOrigin: PORTAL, appOrigin: APP, isProduction: true,
    })).toBe(PORTAL);
  });

  it('uses the Portal for the contract documents too (it serves them now)', () => {
    expect(pickVerificationBaseUrl({
      type: 'printing_contract_schedule', portalOrigin: PORTAL, appOrigin: APP, isProduction: true,
    })).toBe(PORTAL);
    expect(pickVerificationBaseUrl({
      type: 'printing_contract', portalOrigin: PORTAL, appOrigin: APP, isProduction: true,
    })).toBe(PORTAL);
  });

  it('falls back to the app that serves the route for a type the Portal does not know', () => {
    // A type that is NOT in the Portal-served list (a new one, before the
    // Portal is confirmed to serve it) must not be pointed at the Portal: the
    // Portal would send the scanner to its login page.
    const unknown = 'brand_new_type' as unknown as Parameters<typeof pickVerificationBaseUrl>[0]['type'];
    expect(pickVerificationBaseUrl({
      type: unknown, portalOrigin: PORTAL, appOrigin: APP, isProduction: true,
    })).toBe(APP);
  });

  it('fails closed in production when the Portal origin is missing', () => {
    expect(pickVerificationBaseUrl({
      type: 'invoice', portalOrigin: '', appOrigin: APP, isProduction: true,
    })).toBe('');
  });

  it('falls back to the running app outside production', () => {
    expect(pickVerificationBaseUrl({
      type: 'invoice', portalOrigin: '', appOrigin: APP, isProduction: false,
    })).toBe(APP);
  });
});

describe('the QR code a printed document carries', () => {
  it('points a schedule at the Portal', () => {
    const url = buildDocumentVerificationUrl({
      documentType: 'printing_contract_schedule',
      documentNumber: 'PC-P726/023',
      verificationToken: TOKEN,
    }, PORTAL);
    expect(url).toBe(`${PORTAL}/#/verify/printing-contract-schedule/PC-P726%2F023?t=${TOKEN}`);
  });

  it('points an invoice at the Portal', () => {
    const url = buildDocumentVerificationUrl({
      documentType: 'invoice',
      documentNumber: 'INV-P726/029',
      verificationToken: TOKEN,
    }, PORTAL);
    expect(url).toBe(`${PORTAL}/#/verify/invoice/INV-P726%2F029?t=${TOKEN}`);
  });

  it('keeps a schedule QR on the same public surface as an invoice', () => {
    const originOf = (payload: string) => payload.split('/#/verify/')[0];
    const schedulePayload = buildSecurityQrPayload({
      documentType: 'printing_contract_schedule',
      contractNumber: 'PC-P726/023',
      verificationToken: TOKEN,
    }, 'Prime Printing Service');
    const invoicePayload = buildSecurityQrPayload({
      documentType: 'invoice',
      invoiceNumber: 'INV-P726/029',
      verificationToken: TOKEN,
    }, 'Prime Printing Service');
    expect(schedulePayload).toContain('/#/verify/printing-contract-schedule/');
    expect(schedulePayload).toContain(`?t=${TOKEN}`);
    // The contract documents follow the same surface rule as the documents the
    // Portal has always served: whatever origin the invoice QR uses, the
    // schedule QR uses.
    expect(originOf(schedulePayload)).toBe(originOf(invoicePayload));
  });
});
