/**
 * Banking Attachments Panel.
 *
 * Reusable attachment UI for any banking record (transaction, statement,
 * reconciliation). Reuses:
 *   - `bankingAttachmentsService` for upload/list/remove
 *   - `dbService.getFile` for blob-URL resolution (cloud → local cache)
 *   - The user's auth context for uploadedBy attribution
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Paperclip, Upload, FileText, FileImage, Trash2, Download, X } from 'lucide-react';
import { bankingAttachmentsService, BankingAttachment } from '../../../../services/bankingAttachmentsService';
import { logger } from '../../../../services/logger';

const hairline = '#e4ddd1';
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const teal = { 50: '#eef7f6', 600: '#1f8577', 700: '#166b5e' };
const danger = { 50: '#fef2f2', 600: '#991b1b' };

interface Props {
  transactionId: string;
  uploadedBy?: string;
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[u]}`;
}

function fileIcon(mime?: string) {
  if (!mime) return <FileText size={20} color={teal[600]} />;
  if (mime.startsWith('image/')) return <FileImage size={20} color="#8b5cf6" />;
  return <FileText size={20} color={teal[600]} />;
}

export const AttachmentsPanel: React.FC<Props> = ({ transactionId, uploadedBy }) => {
  const [items, setItems] = useState<BankingAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await bankingAttachmentsService.getForTransaction(transactionId);
      setItems(list);
    } catch (err) {
      logger.error('[AttachmentsPanel] load failed', err);
      setError('Failed to load attachments');
    } finally {
      setLoading(false);
    }
  }, [transactionId]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      await bankingAttachmentsService.uploadForTransaction(transactionId, file, uploadedBy);
      await refresh();
    } catch (err) {
      logger.error('[AttachmentsPanel] upload failed', err);
      setError((err as Error).message || 'Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleRemove = async (att: BankingAttachment) => {
    if (!confirm(`Remove "${att.fileName}"?`)) return;
    try {
      await bankingAttachmentsService.remove(att.id);
      await refresh();
    } catch (err) {
      logger.error('[AttachmentsPanel] remove failed', err);
      setError('Failed to remove');
    }
  };

  const handleOpen = async (att: BankingAttachment) => {
    try {
      const url = await bankingAttachmentsService.resolveUrl(att.fileRef);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      else setError('File unavailable');
    } catch (err) {
      logger.error('[AttachmentsPanel] open failed', err);
      setError('Failed to open file');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Paperclip size={14} color={inkSoft} />
          <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.6 }}>Attachments ({items.length})</span>
        </div>
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', borderRadius: 6, border: `1px solid ${hairline}`,
          background: paper, color: teal[700], cursor: uploading ? 'not-allowed' : 'pointer',
          fontSize: 11, fontWeight: 600, opacity: uploading ? 0.6 : 1,
        }}>
          <Upload size={12} /> {uploading ? 'Uploading…' : 'Attach File'}
          <input type="file" style={{ display: 'none' }} onChange={handleUpload} disabled={uploading} />
        </label>
      </div>

      {error && (
        <div style={{ padding: 8, borderRadius: 6, background: danger[50], color: danger[600], fontSize: 11 }}>{error}</div>
      )}

      {loading ? (
        <div style={{ padding: 8, fontSize: 11, color: inkSoft }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: 10, fontSize: 11, color: inkSoft, background: teal[50], borderRadius: 6 }}>
          No attachments. Upload receipts, statements, or supporting documents.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map((att) => (
            <div key={att.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              padding: 8, border: `1px solid ${hairline}`, borderRadius: 6, background: paper,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {fileIcon(att.mimeType)}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: ink, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.fileName}</div>
                  <div style={{ fontSize: 10, color: inkSoft }}>{formatSize(att.size)} · {att.uploadedAt.slice(0, 10)} · {att.uploadedBy || 'system'}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => handleOpen(att)} title="Open" style={{ padding: 4, borderRadius: 4, border: `1px solid ${hairline}`, background: paper, color: teal[700], cursor: 'pointer' }}>
                  <Download size={12} />
                </button>
                <button onClick={() => handleRemove(att)} title="Remove" style={{ padding: 4, borderRadius: 4, border: `1px solid ${hairline}`, background: paper, color: danger[600], cursor: 'pointer' }}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AttachmentsPanel;
