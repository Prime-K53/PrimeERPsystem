/**
 * documentPagination.tsx — GLOBAL shared document-layout capability.
 *
 * Extracted from the proven INVOICE reference implementation
 * (checkpoint-invoice-template-upgrade): dynamic Page X of Y, automatic
 * 1/2/3+ page handling, compact intermediate footer, full security footer
 * on the final page only, QR only on the final page, continuation header
 * on pages 2+, no forced page breaks, existing React-PDF flow untouched.
 *
 * Document renderers provide content only; this module owns ALL framing:
 * page numbering, continuation headers, intermediate footer, QR placement
 * (via the flowing security footer — the QR payload/algorithm itself lives
 * in utils/documentSecurity.ts and is NOT touched here).
 *
 * Presentation only. No accounting, payment, calculation, numbering,
 * database, API, or Portal logic is affected.
 */
import React from 'react';
import { Text } from '@react-pdf/renderer';

/**
 * Customer-facing PDF types sharing the global pagination behavior.
 * Deliberately excluded (legacy behavior preserved byte-identically):
 * - POS_RECEIPT: 250pt thermal-slip layout; A4 fixed furniture does not fit.
 * - WORK_ORDER: internal production document, not customer-facing.
 * - FISCAL_REPORT: system report, not a transactional customer document.
 */
export const PAGINATED_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'INVOICE',
  'QUOTATION',
  'ORDER',
  'SALES_ORDER',
  'PO',
  'SUBSCRIPTION',
  'EXAMINATION_INVOICE',
  'DELIVERY_NOTE',
  'RECEIPT',
  'SUPPLIER_PAYMENT',
  'SALES_EXCHANGE',
  'ACCOUNT_STATEMENT',
  'ACCOUNT_STATEMENT_SUMMARY',
]);

export const isPaginatedDocumentType = (type: string): boolean =>
  PAGINATED_DOCUMENT_TYPES.has(type);

export interface PaginationIdentity {
  /** Short document title, e.g. 'Invoice'. */
  title: string;
  /** Official document number from existing fields only. */
  number: string;
  /** Customer/supplier display name from existing fields only. */
  customer: string;
}

const textOf = (value: unknown): string => String(value ?? '').trim();

const firstText = (...values: unknown[]): string => {
  for (const value of values) {
    const t = textOf(value);
    if (t) return t;
  }
  return '';
};

/**
 * Resolve framing identity from EXISTING document fields only.
 * Never invents data: every value comes from a field the renderer or
 * mapper already carries. For INVOICE the result reproduces the reference
 * strings byte-identically (see invoiceTemplatePagination tests A–C).
 */
export function paginationIdentity(
  type: string,
  data: Record<string, unknown>,
  recipientName: string
): PaginationIdentity {
  const customer = textOf(recipientName);
  switch (type) {
    case 'INVOICE':
      return {
        title: 'Invoice',
        number: firstText(data.invoiceNumber, data.number, 'INV'),
        customer,
      };
    case 'QUOTATION':
      return {
        title: 'Quotation',
        number: firstText(data.quotationNumber, (data as any).quotationId, data.number, 'QTN'),
        customer,
      };
    case 'ORDER':
    case 'SALES_ORDER':
      return {
        title: 'Sales Order',
        number: firstText(data.orderNumber, data.number, 'ORD'),
        customer,
      };
    case 'PO':
      return {
        title: 'Purchase Order',
        number: firstText(data.number, (data as any).order_number, data.orderNumber, 'PO'),
        customer,
      };
    case 'SUBSCRIPTION':
      return {
        title: 'Recurring Invoice',
        number: firstText(data.number, 'SUB'),
        customer,
      };
    case 'EXAMINATION_INVOICE':
      return {
        title: 'Exam Invoice',
        number: firstText(data.number, 'INV'),
        customer,
      };
    case 'DELIVERY_NOTE':
      return {
        title: 'Delivery Note',
        number: firstText(
          (data as any).dnNumber,
          (data as any).deliveryNoteNumber,
          (data as any).delivery_number,
          data.number,
          'DN'
        ),
        customer,
      };
    case 'RECEIPT':
      return {
        title: 'Receipt',
        number: firstText(data.receiptNumber, data.number, 'RC'),
        customer: customer || firstText(data.customerName),
      };
    case 'SUPPLIER_PAYMENT':
      return {
        title: 'Supplier Payment',
        number: firstText((data as any).paymentNumber, (data as any).paymentId, 'SPAY'),
        customer: customer || firstText((data as any).supplierName),
      };
    case 'SALES_EXCHANGE':
      return {
        title: 'Exchange Note',
        number: firstText((data as any).exchangeNumber, data.number, 'EX'),
        customer: customer || firstText(data.customerName),
      };
    case 'ACCOUNT_STATEMENT':
    case 'ACCOUNT_STATEMENT_SUMMARY':
      return {
        title: 'Statement',
        number: firstText((data as any).statementNumber, data.number, 'STMT'),
        customer: customer || firstText(data.customerName),
      };
    default:
      return {
        title: textOf(type).charAt(0).toUpperCase() + textOf(type).slice(1).toLowerCase(),
        number: firstText(data.number, type),
        customer,
      };
  }
}

/** Fixed-element geometry shared by every paginated document. */
export const paginationFurnitureStyles = {
  continuation: {
    position: 'absolute' as const,
    top: 24,
    left: 40,
    right: 40,
    textAlign: 'center' as const,
    fontSize: 8,
    color: '#64748b',
  },
  intermediate: {
    position: 'absolute' as const,
    bottom: 38,
    left: 40,
    right: 40,
    textAlign: 'center' as const,
    fontSize: 8,
    color: '#64748b',
  },
  pageNumber: {
    position: 'absolute' as const,
    bottom: 24,
    left: 40,
    right: 40,
    textAlign: 'right' as const,
    fontSize: 8,
    color: '#64748b',
  },
};

/**
 * The three fixed furniture elements. Page info comes from React-PDF's
 * render prop — total page count is never hard-coded, pages are never
 * forced: 1 page renders Page 1 of 1, N pages render Page X of N.
 */
export function PaginationFurniture({
  identity,
  companyName,
  verificationNote,
}: {
  identity: PaginationIdentity;
  companyName: string;
  /**
   * Intermediate-page verification sentence. Defaults to the QR-based
   * reference wording; documents without a QR (e.g. printing contracts)
   * pass their own honest wording.
   */
  verificationNote?: string;
}) {
  const note = verificationNote
    ?? 'Computer-generated document. Verify authenticity using the QR code on the final page.';
  return (
    <>
      <Text
        fixed
        style={paginationFurnitureStyles.continuation}
        render={({ pageNumber }: { pageNumber: number }) =>
          pageNumber > 1
            ? `${identity.title} ${identity.number} · ${identity.customer} — continued`
            : ''
        }
      />
      <Text
        fixed
        style={paginationFurnitureStyles.intermediate}
        render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          pageNumber < totalPages
            ? `${companyName} · ${identity.title} ${identity.number} · ${note}`
            : ''
        }
      />
      <Text
        fixed
        style={paginationFurnitureStyles.pageNumber}
        render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          `Page ${pageNumber} of ${totalPages}`
        }
      />
    </>
  );
}

/** Styling for the DOCUMENT VERIFICATION label heading the flowing footer. */
export const verificationLabelStyle = {
  fontSize: 9,
  fontWeight: 'bold' as const,
  color: '#334155',
  letterSpacing: 1.5,
  marginBottom: 4,
};

/**
 * Deprecated: the DOCUMENT AUTHENTICATION & VERIFICATION header is now
 * rendered inside the shared SecurityFooter (PrimeDocument) so every
 * channel — fixed and flowing — matches the approved reference exactly.
 * Kept as a null render so existing call sites
 * (<VerificationLabel /> + <SecurityFooter />) produce a single block
 * instead of a duplicated heading. Page-text assertions should target the
 * SecurityFooter title ('DOCUMENT AUTHENTICATION & VERIFICATION').
 */
export function VerificationLabel({ fontScale = 1 }: { fontScale?: number }) {
  void fontScale;
  return null;
}
