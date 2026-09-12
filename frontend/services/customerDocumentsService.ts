/**
 * Customer Documents Service.
 *
 * Mirrors the proven `bankingAttachmentsService` pattern for customer files:
 *   - File blobs go through `dbService.saveFile` / `dbService.getFile`
 *     (Supabase Storage with IndexedDB offline cache + sync queue).
 *   - Attachment metadata lives on the customer record itself
 *     (`customer.documents`), so it persists through the existing
 *     `transactionService.saveCustomer` whole-object pipeline with no
 *     IndexedDB migration or new object store required.
 *
 * The caller persists the returned customer object via `updateCustomer`
 * from SalesContext (which normalizes, refetches and audits).
 */

import { dbService } from './db';
import { logger } from './logger';
import type { Customer, CustomerDocument } from '../types';

const makeId = () =>
  `CDOC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const formatCustomerDocSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const customerDocumentsService = {
  /**
   * Save a file blob and append its metadata to the customer record.
   * Returns the updated customer object — the caller must persist it
   * (e.g. via `updateCustomer`).
   */
  async upload(customer: Customer, file: File, uploadedBy?: string): Promise<Customer> {
    try {
      const fileRef = await dbService.saveFile(file);
      const doc: CustomerDocument = {
        id: makeId(),
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        uploadedBy,
        uploadedAt: new Date().toISOString(),
        fileRef,
      };
      const documents = [...(customer.documents || []), doc];
      return { ...customer, documents };
    } catch (err) {
      logger.error('[CustomerDocuments] Upload failed', err);
      throw err;
    }
  },

  /**
   * Remove attachment metadata from the customer record.
   * Returns the updated customer object for the caller to persist.
   */
  remove(customer: Customer, documentId: string): Customer {
    const documents = (customer.documents || []).filter(d => d.id !== documentId);
    return { ...customer, documents };
  },

  /**
   * Resolve a downloadable URL for an attachment
   * (signed cloud URL with local blob-cache fallback).
   */
  async resolveUrl(fileRef: string): Promise<string | null> {
    return dbService.getFile(fileRef);
  },
};
