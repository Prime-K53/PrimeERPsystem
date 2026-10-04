import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, RefreshCw, X } from 'lucide-react';
import type { Order } from '../../../types';
import { getOrderCanonicalStatus, getOrderStatusActions, getOrderStatusClass, type OrderStatusAction } from './orderStatusUtils';

const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';

interface Props {
  order: Order | null;
  /** Receives the chosen status. The parent owns persistence + feedback. */
  onConfirm: (status: string) => Promise<void> | void;
  onClose: () => void;
}

const OrderStatusModal: React.FC<Props> = ({ order, onConfirm, onClose }) => {
  const [selected, setSelected] = useState<string>('');
  const [confirmed, setConfirmed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentStatus = order ? getOrderCanonicalStatus(order) : '';
  const actions = useMemo(() => (order ? getOrderStatusActions(order) : []), [order]);
  const chosen: OrderStatusAction | undefined = actions.find((a) => a.status === selected);

  // Reset per order so a previous selection can never leak into a new one.
  useEffect(() => {
    setSelected('');
    setConfirmed(false);
    setError(null);
    setIsSaving(false);
  }, [order?.id]);

  useEffect(() => {
    if (!order) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !isSaving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order, isSaving, onClose]);

  if (!order) return null;

  const orderLabel = order.orderNumber || order.id;
  const blocked = chosen?.requiresConfirmation && !confirmed;

  const submit = async () => {
    if (!chosen || blocked || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      await onConfirm(chosen.status);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Could not change the order status.');
      setIsSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: 'rgba(11,62,57,.32)', backdropFilter: 'blur(2px)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="order-status-modal-title"
      onClick={(e) => { if (e.target === e.currentTarget && !isSaving) onClose(); }}
    >
      <div
        className="w-full max-w-lg rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: paper, border: `1.4px solid ${hairline}` }}
      >
        <div className="flex items-start justify-between px-5 py-4" style={{ borderBottom: `1.4px solid ${hairline}` }}>
          <div>
            <h3 id="order-status-modal-title" className="text-[15px] font-bold" style={{ margin: 0, color: ink }}>
              Change order status
            </h3>
            <p className="text-[11.5px] mt-1" style={{ margin: 0, color: inkSoft }}>
              Order {orderLabel} · {order.customerName || 'Walk-in'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            aria-label="Close"
            className="p-1 rounded-lg disabled:opacity-40"
            style={{ color: inkSoft }}
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto" style={{ maxHeight: '62vh' }}>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: inkSoft }}>Current</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${getOrderStatusClass(currentStatus)}`}>
              {currentStatus}
            </span>
          </div>

          {actions.length === 0 ? (
            <div
              className="text-[12.5px] leading-relaxed rounded-xl px-4 py-3"
              style={{ background: '#f5f2ed', border: `1.4px solid ${hairline}`, color: inkSoft }}
            >
              {currentStatus} is a final status, so it cannot be changed here.
              {currentStatus === 'Cancelled' ? ' This order was cancelled.' : ' Use Cancel Order if the order must be stopped, or raise a new order.'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wide" style={{ color: inkSoft }}>Change to</span>
              {actions.map((action) => {
                const isSelected = selected === action.status;
                return (
                  <button
                    key={action.status}
                    type="button"
                    onClick={() => { setSelected(action.status); setConfirmed(false); setError(null); }}
                    aria-pressed={isSelected}
                    className="text-left rounded-xl px-3 py-2.5 transition-colors"
                    style={{
                      border: `1.4px solid ${isSelected ? '#1f8577' : hairline}`,
                      background: isSelected ? '#eef7f6' : paper,
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12.5px] font-bold" style={{ color: ink }}>{action.label}</span>
                      {isSelected && <Check size={14} style={{ color: '#1f8577' }} />}
                    </div>
                    <span className="block text-[11.5px] mt-0.5" style={{ color: inkSoft }}>{action.description}</span>
                  </button>
                );
              })}
            </div>
          )}

          {chosen?.warning && (
            <div
              className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-[11.5px] leading-relaxed"
              style={{ background: '#fef0ee', border: '1.4px solid #f3c6c0', color: '#b5493f' }}
            >
              <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{chosen.warning}</span>
            </div>
          )}

          {chosen?.requiresConfirmation && (
            <label className="flex items-start gap-2 text-[11.5px]" style={{ color: inkSoft }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>I understand this deducts stock and posts to the ledger.</span>
            </label>
          )}

          {error && (
            <div
              className="text-[11.5px] rounded-xl px-3 py-2"
              style={{ background: '#fef0ee', border: '1.4px solid #f3c6c0', color: '#b5493f' }}
              role="alert"
            >
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: `1.4px solid ${hairline}`, background: '#faf8f4' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="px-3.5 py-1.5 rounded-lg text-[12px] font-semibold disabled:opacity-50"
            style={{ border: `1.4px solid ${hairline}`, color: inkSoft, background: paper }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!chosen || blocked || isSaving || actions.length === 0}
            className="px-3.5 py-1.5 rounded-lg text-[12px] font-bold text-white disabled:opacity-50 inline-flex items-center gap-2"
            style={{ background: chosen ? '#1f8577' : '#a6d9d3' }}
          >
            {isSaving && <RefreshCw size={13} className="animate-spin" />}
            {isSaving ? 'Saving…' : 'Apply change'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OrderStatusModal;
