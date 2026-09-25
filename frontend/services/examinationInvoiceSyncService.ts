import { Invoice } from '../types';
import { api } from './api';
import { dbService } from './db';
import { transactionService } from './transactionService';
import { ExaminationGeneratedInvoicePayload } from './examinationBatchService';
import { enrichInvoiceWithBatchPricing } from '../utils/examinationInvoicePricing';
import { ensureInvoiceVerificationToken } from '../utils/invoiceVerification';

export interface ExaminationInvoiceSyncResult {
  synced: boolean;
  fallbackUsed: boolean;
  invoiceId: string | null;
  message?: string;
}

const toNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeInvoiceStatus = (status: unknown): Invoice['status'] => {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'draft') return 'Draft';
  if (normalized === 'paid') return 'Paid';
  if (normalized === 'partial' || normalized === 'partially_paid') return 'Partial';
  if (normalized === 'overdue') return 'Overdue';
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'void') return 'Cancelled';
  return 'Unpaid';
};

const mapLineItems = (payload: ExaminationGeneratedInvoicePayload) => {
  const rows = Array.isArray(payload?.items) ? payload.items : [];
  if (rows.length === 0) {
    return [
      {
        id: `EXM-ITEM-${payload.id}`,
        itemId: `EXM-ITEM-${payload.id}`,
        name: 'Examination Service',
        sku: `EXM-${payload.id}`,
        description: `Examination invoice ${payload.invoiceNumber}`,
        category: 'Examination',
        type: 'Service' as const,
        unit: 'job',
        minStockLevel: 0,
        stock: 0,
        reserved: 0,
        price: toNumber(payload.totalAmount),
        cost: 0,
        quantity: 1,
        total: toNumber(payload.totalAmount)
      }
    ];
  }

  return rows.map((row, index) => ({
    id: String(row?.id || `EXM-ITEM-${payload.id}-${index + 1}`),
    itemId: String(row?.itemId || row?.id || `EXM-ITEM-${payload.id}-${index + 1}`),
    name: String(row?.name || `Examination Service ${index + 1}`),
    sku: String(row?.sku || `EXM-${payload.id}-${index + 1}`),
    description: String(row?.description || ''),
    category: String(row?.category || 'Examination'),
    type: 'Service' as const,
    unit: String(row?.unit || 'job'),
    minStockLevel: toNumber(row?.minStockLevel, 0),
    stock: toNumber(row?.stock, 0),
    reserved: toNumber(row?.reserved, 0),
    price: toNumber(row?.price, toNumber(row?.total)),
    cost: toNumber(row?.cost, 0),
    quantity: Math.max(1, toNumber(row?.quantity, 1)),
    total: toNumber(row?.total, toNumber(row?.price) * Math.max(1, toNumber(row?.quantity, 1)))
  }));
};

export const mapExaminationPayloadToInvoice = (
  payload: ExaminationGeneratedInvoicePayload
): Invoice & Record<string, unknown> => {
  const date = payload?.date || new Date().toISOString();
  const dueDate = payload?.dueDate || new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)).toISOString();
  const totalAmount = toNumber(payload?.totalAmount);
  const paidAmount = Math.max(0, Math.min(totalAmount, toNumber(payload?.paidAmount)));
  const sourceBatchNumber = String(payload?.batchId || payload?.origin_batch_id || '').trim();
  const acceptedBy = payload?.schoolName || payload?.customerName || 'Customer';
  // Canonical identity: Invoice.id === Invoice.invoiceNumber (the EXM number).
  // Producers guarantee payload.invoiceNumber is canonical; the payload id
  // mirrors it (see buildLocalInvoicePayload).
  const canonicalNumber = String(payload?.invoiceNumber || payload?.id);
  // Verification token is minted HERE — at the authoritative payload →
  // Invoice conversion — so every downstream writer (normal save, fallback
  // direct put, durable sync queue) carries it. Uses the single existing
  // implementation; existing tokens are never regenerated. processInvoice
  // re-ensures idempotently, so this stays compatible.
  const verificationToken = String(
    ensureInvoiceVerificationToken({
      verificationToken: (payload as unknown as Record<string, unknown>)?.verificationToken as string | undefined,
    } as Invoice).verificationToken || ''
  );

  return {
    id: canonicalNumber,
    date,
    dueDate,
    customerId: String(payload?.customerId || ''),
    customerName: String(payload?.customerName || 'Unknown Customer'),
    totalAmount,
    paidAmount,
    status: normalizeInvoiceStatus(payload?.status),
    items: mapLineItems(payload),
    subtotal: toNumber(payload?.preRoundingTotalAmount, totalAmount),
    materialTotal: toNumber(payload?.materialTotal, 0),
    adjustmentTotal: toNumber(payload?.adjustmentTotal, 0),
    adjustmentSnapshots: Array.isArray(payload?.adjustmentSnapshots) ? payload.adjustmentSnapshots : [],
    roundingDifference: toNumber(payload?.roundingDifference, 0),
    roundingTotal: toNumber(payload?.roundingDifference, 0),
    profitMarginTotal: Number((
      toNumber(payload?.preRoundingTotalAmount, totalAmount)
      - toNumber(payload?.materialTotal, 0)
      - toNumber(payload?.adjustmentTotal, 0)
    ).toFixed(2)),
    roundingMethod: payload?.roundingMethod || 'nearest_50',
    applyRounding: Boolean(payload?.applyRounding),
    classBreakdown: Array.isArray(payload?.classBreakdown) ? payload.classBreakdown : [],
    schoolName: payload?.schoolName || payload?.customerName,
    academicYear: payload?.academicYear,
    term: payload?.term,
    examType: payload?.examType,
    batchId: payload?.batchId || payload?.origin_batch_id || '',
    preRoundingTotalAmount: toNumber(payload?.preRoundingTotalAmount, totalAmount),
    documentTitle: payload?.documentTitle || 'Service Invoice',
    subAccountName: payload?.subAccountName || undefined,
    notes: payload?.notes || `Generated from examination batch ${payload?.origin_batch_id || ''}`,
    reference: payload?.reference || payload?.invoiceNumber || undefined,
    isConverted: Boolean(sourceBatchNumber),
    conversionDetails: sourceBatchNumber ? {
      sourceType: 'Examination Batch',
      sourceNumber: sourceBatchNumber,
      date: new Date(date).toLocaleDateString(),
      acceptedBy
    } : undefined,
    originModule: payload?.origin_module || 'examination',
    origin_module: payload?.origin_module || 'examination',
    category: 'Examination',
    originBatchId: payload?.origin_batch_id || '',
    origin_batch_id: payload?.origin_batch_id || '',
    backendInvoiceId: payload?.backendInvoiceId || '',
    invoiceNumber: canonicalNumber,
    verificationToken,
    currency: payload?.currency || 'MWK'
  };
};

const collectBatchInvoiceKeys = (payload?: ExaminationGeneratedInvoicePayload): string[] => {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const text = String(value || '').trim();
    if (text) keys.add(text);
  };
  add(payload?.batchId);
  const raw = payload as unknown as Record<string, unknown> | undefined;
  add(raw?.origin_batch_id);
  add(raw?.originBatchId);
  return Array.from(keys);
};

export const findFinanceInvoicesForBatch = async (batchKeys: string | string[]): Promise<Array<Record<string, any>>> => {
  const keys = (Array.isArray(batchKeys) ? batchKeys : [batchKeys])
    .map((key) => String(key || '').trim())
    .filter(Boolean);
  if (keys.length === 0) return [];
  const all = await dbService.getAll<Record<string, any>>('invoices').catch(() => []);
  return (all || []).filter((invoice) => {
    const candidates = [
      invoice?.batchId,
      invoice?.originBatchId,
      invoice?.origin_batch_id,
      invoice?.origin_batchId,
      invoice?.reference
    ].map((value) => String(value || '').trim());
    if (candidates.some((candidate) => candidate && keys.includes(candidate))) return true;
    const reference = String(invoice?.reference || '').toUpperCase();
    return keys.some((key) => key && reference === `EXM-BATCH-${String(key).toUpperCase()}`);
  });
};

export const persistRegeneratedExaminationInvoiceToFinance = async (
  payload?: ExaminationGeneratedInvoicePayload,
  options?: { previousInvoiceId?: string | null; reason?: string }
): Promise<ExaminationInvoiceSyncResult & { voidedInvoiceIds?: string[] }> => {
  if (!payload) {
    return { synced: false, fallbackUsed: false, invoiceId: null, message: 'No invoice payload to sync.' };
  }
  const batchKeys = collectBatchInvoiceKeys(payload);
  if (options?.previousInvoiceId) batchKeys.push(String(options.previousInvoiceId));
  const existing = await findFinanceInvoicesForBatch(batchKeys);
  const active = existing.filter((invoice) => {
    const status = String(invoice?.status || '').trim().toLowerCase();
    return status !== 'cancelled' && status !== 'voided' && status !== 'void';
  });

  for (const invoice of active) {
    const status = String(invoice?.status || '').trim().toLowerCase();
    const paidAmount = toNumber(invoice?.paidAmount, 0);
    if (status === 'paid' || status === 'partial' || paidAmount > 0.005) {
      return {
        synced: false,
        fallbackUsed: false,
        invoiceId: null,
        message: `Cannot regenerate: existing invoice ${invoice?.id} is ${invoice?.status} with payments applied. Void or refund it first.`
      };
    }
  }

  const voidedInvoiceIds: string[] = [];
  for (const invoice of active) {
    const invoiceId = String(invoice?.id || '').trim();
    if (!invoiceId || invoiceId === String(payload?.invoiceNumber || payload?.id)) continue;
    try {
      await transactionService.voidInvoice(invoiceId, `Voided by examination invoice regeneration${options?.reason ? `: ${options.reason}` : ''}`);
      voidedInvoiceIds.push(invoiceId);
    } catch (error: any) {
      const message = String(error?.message || '');
      if (!message.toLowerCase().includes('already voided')) {
        return {
          synced: false,
          fallbackUsed: false,
          invoiceId: null,
          voidedInvoiceIds,
          message: message || `Failed to void previous invoice ${invoiceId}.`
        };
      }
      voidedInvoiceIds.push(invoiceId);
    }
  }

  const result = await persistExaminationInvoiceToFinance(payload);
  return { ...result, voidedInvoiceIds };
};

export const persistExaminationInvoiceToFinance = async (
  payload?: ExaminationGeneratedInvoicePayload
): Promise<ExaminationInvoiceSyncResult> => {
  if (!payload) {
    return { synced: false, fallbackUsed: false, invoiceId: null, message: 'No invoice payload to sync.' };
  }

  let invoice = mapExaminationPayloadToInvoice(payload);
  const batchId = String(payload?.batchId || payload?.origin_batch_id || '').trim();
  if (batchId) {
    const localBatch = await dbService.get<any>('examinationBatches', batchId);
    if (localBatch) {
      invoice = enrichInvoiceWithBatchPricing(invoice, localBatch);
    }
  }
  // Re-ensure after enrichment (spread-preserving, idempotent): from this
  // point on, EVERY writer below — normal save, fallback direct put,
  // processInvoice retry — persists and enqueues a tokened invoice. The
  // fallback path must never store/enqueue an untokened examination invoice.
  invoice = ensureInvoiceVerificationToken(invoice);

  try {
    await api.finance.saveInvoice(invoice);
    return { synced: true, fallbackUsed: false, invoiceId: String(invoice.id) };
  } catch (error: any) {
    // Clean up idempotency key from failed first attempt to prevent duplicate errors on retry
    const idempotencyKey = (invoice as Invoice & Record<string, unknown>)?.idempotencyKey || `invoice:${invoice.id}`;
    try {
      await dbService.executeAtomicOperation(
        ['idempotencyKeys'],
        async (tx) => {
          const store = tx.objectStore('idempotencyKeys');
          await store.delete(idempotencyKey);
        }
      );
    } catch (_) { /* cleanup is best-effort */ }

    // Finance API failed - attempt local fallback: save invoice and post via transactionService
    let savedLocally = false;
    try {
      await dbService.put('invoices', invoice);
      savedLocally = true;
    } catch (fallbackError: any) {
      // If saving locally fails, return failure
      return {
        synced: false,
        fallbackUsed: true,
        invoiceId: null,
        message: fallbackError?.message || error?.message || 'Failed to sync invoice to local finance store.'
      };
    }

    // Try to process the invoice locally to ensure ledger entries are created
    try {
      await transactionService.processInvoice(invoice);
      return {
        synced: true,
        fallbackUsed: true,
        invoiceId: String(invoice.id),
        message: error?.message || 'Finance API save failed; invoice saved locally and ledger posted.'
      };
    } catch (txError: any) {
      // Clean up idempotency key on failure so retry can work
    const idempotencyKey = (invoice as Record<string, unknown>)?.idempotencyKey || `invoice:${invoice.id}`;
      try {
        await dbService.executeAtomicOperation(
          ['idempotencyKeys'],
          async (tx) => {
            const store = tx.objectStore('idempotencyKeys');
            await store.delete(idempotencyKey);
          }
        );
      } catch (cleanupError) {
        // Ignore cleanup errors - non-critical
        console.warn('[ExaminationInvoice] Failed to cleanup idempotency key:', cleanupError);
      }

      // Ledger posting failed, but invoice is saved locally
      return {
        synced: true,
        fallbackUsed: true,
        invoiceId: savedLocally ? String(invoice.id) : null,
        message: txError?.message || error?.message || 'Finance API save failed; invoice saved locally but ledger posting failed.'
      };
    }
  }
};
