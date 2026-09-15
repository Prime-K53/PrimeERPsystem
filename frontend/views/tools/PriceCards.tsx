import React, { useCallback, useState } from 'react';
import { Plus, Tag } from 'lucide-react';
import { PriceCardModal } from './pricecard/PriceCardModal';
import {
  formatPriceCardAmount,
  loadPriceCardHistory,
  type PriceCardHistoryEntry,
} from '../../services/priceCardService';

/**
 * PriceCards — Smart Operations tool page (ERP only).
 *
 * Standalone entry point for the Price Card workflow: search any product,
 * preview the customer-facing price image, generate a high-resolution PNG
 * and share it (WhatsApp / download). Informational only — never creates
 * sales, quotations, orders, invoices, payments, or ledger entries.
 */
export const PriceCards: React.FC = () => {
  const [modalOpen, setModalOpen] = useState(false);
  const [history, setHistory] = useState<PriceCardHistoryEntry[]>(() => loadPriceCardHistory());

  const handleClose = useCallback(() => {
    setModalOpen(false);
    setHistory(loadPriceCardHistory());
  }, []);

  return (
    <div style={{ padding: '20px 24px', maxWidth: 980, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: '#0b3e39', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Tag size={18} /> Price Cards
          </h1>
          <p style={{ fontSize: 13, color: '#5c6567', margin: '6px 0 0', lineHeight: 1.5 }}>
            Answer customer price inquiries with a professional image in seconds.
            Uses the same selling price as POS and Order Form. Informational only.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', minHeight: 44,
            borderRadius: 10, border: 'none', background: 'linear-gradient(155deg, #1f8577, #0f544c)',
            color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
            boxShadow: '0 6px 16px -6px rgba(15,84,76,.55)',
          }}
        >
          <Plus size={16} /> New Price Card
        </button>
      </div>

      <div style={{ marginTop: 18 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#5c6567', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          Recent price cards ({history.length})
        </div>
        {history.length === 0 ? (
          <div style={{ fontSize: 13, color: '#8a9494', border: '1px dashed #e4ddd1', borderRadius: 10, padding: '18px 14px', textAlign: 'center', background: '#FEFDFB' }}>
            No price cards generated yet on this device. Click “New Price Card” to create the first one.
          </div>
        ) : (
          <div style={{ border: '1px solid #e4ddd1', borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
            {history.slice(0, 20).map((h) => (
              <div key={h.reference} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid #f1ede4', fontSize: 13 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: '#23282a' }}>{h.reference}</div>
                  <div style={{ color: '#5c6567', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {h.productNames.join(', ')}
                    {h.customerName ? ` • for ${h.customerName}` : ''}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontWeight: 800, color: '#0f544c' }}>{formatPriceCardAmount(h.grandTotal, h.currency)}</div>
                  <div style={{ fontSize: 11.5, color: '#8a9494' }}>
                    {new Date(h.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <PriceCardModal open={modalOpen} initialItem={null} onClose={handleClose} />
    </div>
  );
};

export default PriceCards;
