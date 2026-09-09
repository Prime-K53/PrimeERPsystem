/**
 * Banking Attachments Service.
 *
 * Bridges bank transactions to the existing file storage layer:
 *   - `dbService.saveFile(file)` handles cloud + local blob storage
 *     (Supabase Storage / IndexedDB) and is already used by inventory
 *     and other modules.
 *   - This service stores metadata (id, fileName, mimeType, size, uploaded
 *     by, uploaded at) in a separate `bankingAttachments` store keyed by
 *     `transactionId`.
 *
 * We deliberately reuse `dbService.saveFile` rather than build a parallel
 * file pipeline — Prime ERP's offline/sync architecture already handles
 * blob queueing, signed-URL caching and cloud sync for files.
 */

import { dbService } from './db';
import { logger } from './logger';

export interface BankingAttachment {
  id: string;
  transactionId: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedBy?: string;
  uploadedAt: string;
  fileRef: string; // fileId stored in `files` store via dbService.saveFile
}

export const bankingAttachmentsService = {
  /**
   * Upload a file and link it to a banking transaction.
   * Returns the persisted attachment metadata.
   */
  async uploadForTransaction(transactionId: string, file: File, uploadedBy?: string): Promise<BankingAttachment> {
    try {
      const fileRef = await dbService.saveFile(file);
      const att: BankingAttachment = {
        id: `BATT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        transactionId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        uploadedBy,
        uploadedAt: new Date().toISOString(),
        fileRef,
      };
      await dbService.put('bankingAttachments', att);
      return att;
    } catch (err) {
      logger.error('[BankingAttachments] Upload failed', err);
      throw err;
    }
  },

  async getForTransaction(transactionId: string): Promise<BankingAttachment[]> {
    const all = await dbService.getAll<BankingAttachment>('bankingAttachments');
    return all.filter((a) => a.transactionId === transactionId).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  },

  async remove(attachmentId: string): Promise<void> {
    await dbService.delete('bankingAttachments', attachmentId);
  },

  /**
   * Returns a signed-URL or blob URL for an attachment.
   * Reuses dbService.getFile (cloud → local cache fallback).
   */
  async resolveUrl(fileRef: string): Promise<string | null> {
    return dbService.getFile(fileRef);
  },
};
