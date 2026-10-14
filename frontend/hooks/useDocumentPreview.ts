import { createElement } from 'react';
import { logger } from '@/services/logger';
import { pdf } from '@react-pdf/renderer';
import { useDocumentStore, DocType } from '../stores/documentStore';
import { useAuth } from '../context/AuthContext';
import { useSales } from '../context/SalesContext';
import { useFinance } from '../context/FinanceContext';
import { mapToInvoiceData } from '../utils/pdfMapper';
import { enrichDocumentCustomerData } from '../utils/documentCustomerData';
import { isPosMirrorInvoiceRecord } from '../utils/invoiceIdentity';
import { buildPosReceiptDocFromInvoiceRecord } from '../utils/posReceiptFromInvoice';
import { verificationStoreForDocType } from '../utils/documentVerification';
import { transactionService } from '../services/transactionService';
import { PrimeDocument } from '../views/shared/components/PDF/PrimeDocument';
import { PrimeDocData } from '../views/shared/components/PDF/schemas';
import { attachDocumentSecurity } from '../utils/documentSecurity';
import { printDocumentUrl } from '../utils/documentPrint';
import { initializePrimePdfFonts } from '../views/shared/components/PDF/templateSettings';
import { validateDocumentData } from '../views/shared/components/PDF/documentValidation';

export const useDocumentPreview = () => {
  const { safeOpenPreview } = useDocumentStore();
  const { notify, companyConfig, allUsers, user } = useAuth();
  const { customers } = useSales();
  const { invoices } = useFinance();

  const prepareDocument = async (
    openMode: 'preview' | 'print',
    type: DocType,
    rawData: any,
    boms?: any[],
    inventory?: any[]
  ) => {
    try {
      const originModule = String(rawData?.originModule || rawData?.origin_module || '').toLowerCase();
      const isExaminationInvoice = type === 'INVOICE' && (
        originModule === 'examination'
        || String(rawData?.documentTitle || rawData?.document_title || '').toLowerCase().includes('examination invoice')
        || String(rawData?.reference || '').toUpperCase().startsWith('EXM-BATCH-')
      );
      const effectiveType: DocType = isExaminationInvoice ? 'EXAMINATION_INVOICE' : type;

      // POS-mirror invoices preview/print as POS receipts, never as general
      // invoices — same narrow thermal-slip design the POS module itself
      // renders (PrimeDocument type 'POS_RECEIPT'). Detection mirrors the
      // SalesAudit revenue split (origin module, sale conversion source,
      // POS markers, or a reference naming a real POS sale).
      // Static markers classify cheaply; a bare `reference` needs the sale
      // lookup inside the builder as its second factor (no sale -> the
      // builder returns null and the ordinary INVOICE flow continues).
      const wantsPosReceipt =
        (type === 'INVOICE' && (isPosMirrorInvoiceRecord(rawData) || !!String((rawData as any)?.reference || '').trim())) ||
        (type === 'POS_RECEIPT' && !(rawData as any)?.receiptNumber);
      if (wantsPosReceipt && !isExaminationInvoice) {
        let receiptData: Record<string, unknown> | null = null;
        try {
          receiptData = await buildPosReceiptDocFromInvoiceRecord(rawData, {
            companyConfig,
            allUsers: allUsers as any,
            currentUserName: (user as any)?.name,
            footerMessage: companyConfig?.transactionSettings?.pos?.receiptFooter,
          });
        } catch (error: any) {
          notify('Failed to prepare POS receipt: ' + (error?.message || 'Unknown error'), 'error');
          return;
        }
        if (receiptData) {
          const posValidation = validateDocumentData('POS_RECEIPT', receiptData);
          if (!posValidation.valid) {
            notify(posValidation.error || 'POS receipt data is invalid', 'error');
            return;
          }
          if (openMode === 'print') {
            logger.debug('[useDocumentPreview] Starting POS receipt print', { id: (rawData as any)?.id });
            const startTime = performance.now();
            const securedData = await attachDocumentSecurity(receiptData as any, companyConfig?.companyName);
            await initializePrimePdfFonts();
            let printConfig = companyConfig ?? null;
            try {
              const { hydrateCompanyPdfAssets, withGrayscaleLogoForPrint } = await import('../utils/companyAssetUtils');
              printConfig = await withGrayscaleLogoForPrint(await hydrateCompanyPdfAssets(printConfig));
            } catch {
              // Grayscale logo is best-effort; mono template still prints B/W.
            }
            const blob = await pdf(createElement(PrimeDocument as any, {
              type: 'POS_RECEIPT',
              data: securedData as PrimeDocData,
              configOverride: printConfig,
              customers: customers as any,
              colorMode: 'mono',
            }) as any).toBlob();
            const duration = performance.now() - startTime;
            logger.debug('[useDocumentPreview] POS receipt print PDF generated', {
              size: blob.size,
              durationMs: Math.round(duration),
            });
            const blobUrl = URL.createObjectURL(blob);
            try {
              await printDocumentUrl(blobUrl, 'POS_RECEIPT print');
            } finally {
              window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
            }
            return;
          }
          const result = safeOpenPreview('POS_RECEIPT', receiptData);
          if (!result.success && result.error) {
            notify(result.error, 'error');
          }
          return;
        }
        // Not POS-proven after the sale lookup (explicit POS_RECEIPT routing
        // of an ordinary record): fall through to the requested-type flow,
        // whose validation reports the problem.
      }

      // Validate raw data BEFORE mapping (mapper adds safe placeholders)
      const rawValidation = validateDocumentData(effectiveType, rawData);
      if (!rawValidation.valid) {
        notify(rawValidation.error || 'Document data is invalid', 'error');
        return;
      }

      let enrichedData = enrichDocumentCustomerData(rawData, customers);

      const customerName = enrichedData?.customerName || enrichedData?.customer_name;
      if (customerName && invoices) {
        const totalOutstanding = (invoices as any[])
          .filter((inv: any) =>
            inv.customerName === customerName &&
            !['Paid', 'Cancelled', 'Void', 'Draft'].includes(String(inv.status || ''))
          )
          .reduce((sum: number, inv: any) => {
            const due = Math.max(0, Number(inv.totalAmount || 0) - Number(inv.paidAmount || 0));
            return sum + due;
          }, 0);
        enrichedData = { ...enrichedData, totalCustomerOutstanding: totalOutstanding };
      }

      if (effectiveType === 'SUBSCRIPTION' && rawData) {
        try {
          const customer = (customers || []).find((c: any) =>
            String(c.id) === String(rawData.customerId) || c.name === rawData.customerName
          );

          if (customer) {
            enrichedData = {
              ...enrichedData,
              walletBalance: customer.walletBalance || customer.wallet_balance || 0
            };
          }
        } catch (_) { /* Wallet balance enrichment is best-effort */ }
      }

      const mappedData = mapToInvoiceData(enrichedData, companyConfig, effectiveType, boms, inventory);

      // Verification-QR hardening (all types): a pre-token record (or a stale
      // object captured before an on-open backfill round-trip) would otherwise
      // map without verificationToken and attachDocumentSecurity would fall
      // back to the legacy human-readable QR. Issue+persist the permanent
      // token first (normal store save path — syncs like any other field;
      // never regenerates), so Preview/Print always encode the verification
      // URL. POS_RECEIPT has no directly stored record (it is represented by
      // its linked receipt record) and is resolved by its own flow.
      if (
        (mappedData as any) &&
        !(mappedData as any).verificationToken &&
        (enrichedData as any)?.id
      ) {
        const backingStore = verificationStoreForDocType(effectiveType);
        if (backingStore) {
          try {
            const recordId = String((enrichedData as any).id);
            const token =
              backingStore === 'invoices'
                ? (await transactionService.getOrIssueInvoiceVerificationToken(recordId)).token
                : (await transactionService.getOrIssueDocumentVerificationToken(backingStore, recordId)).token;
            if (token) (mappedData as any).verificationToken = token;
          } catch { /* offline-safe: QR keeps legacy payload until synced */ }
        }
      }

      if (openMode === 'print') {
        logger.debug('[useDocumentPreview] Starting print generation', { type: effectiveType });
        const startTime = performance.now();

        const securedData = await attachDocumentSecurity(mappedData as any, companyConfig?.companyName);
        await initializePrimePdfFonts();
        // Print renders the B/W copy (text black, fills grayscale so
        // backgrounds stay visible, logo converted to grayscale upstream).
        // Preview/download keep brand colors.
        // Hydrate first so FILE-/remote logos resolve to data URLs before
        // the grayscale conversion (mirrors PreviewModal's print path).
        let printConfig = companyConfig ?? null;
        try {
          const { hydrateCompanyPdfAssets, withGrayscaleLogoForPrint } = await import('../utils/companyAssetUtils');
          printConfig = await withGrayscaleLogoForPrint(await hydrateCompanyPdfAssets(printConfig));
        } catch {
          // Grayscale logo is best-effort; mono template still prints B/W.
        }
        const blob = await pdf(createElement(PrimeDocument as any, {
          type: effectiveType,
          data: securedData as PrimeDocData,
          configOverride: printConfig,
          customers: customers as any,
          colorMode: 'mono',
        }) as any).toBlob();

        const duration = performance.now() - startTime;
        logger.debug('[useDocumentPreview] Print PDF generated', {
          size: blob.size,
          durationMs: Math.round(duration),
        });

        const blobUrl = URL.createObjectURL(blob);

        try {
          await printDocumentUrl(blobUrl, `${effectiveType} print`);
        } finally {
          window.setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
        }

        return;
      }

      const result = safeOpenPreview(effectiveType, mappedData);
      if (!result.success && result.error) {
        notify(result.error, 'error');
      }
    } catch (error: any) {
      logger.error(`[useDocumentPreview] Mapping failed for ${type}:`, error);
      if (error.format) {
        logger.error(`[useDocumentPreview] Zod issues:`, error.format());
      }
      notify("Failed to prepare document data: " + (error.message || "Unknown error"), 'error');
    }
  };

  const handlePreview = (type: DocType, rawData: any, boms?: any[], inventory?: any[]) =>
    void prepareDocument('preview', type, rawData, boms, inventory);

  const handlePrint = (type: DocType, rawData: any, boms?: any[], inventory?: any[]) =>
    void prepareDocument('print', type, rawData, boms, inventory);

  return { handlePreview, handlePrint };
};
