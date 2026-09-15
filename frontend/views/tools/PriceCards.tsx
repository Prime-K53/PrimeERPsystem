import React, { useCallback, useMemo, useState } from 'react';
import { Plus, Tag, Search, Download, Image as ImageIcon, Package, Wallet, CalendarCheck } from 'lucide-react';
import { PriceCardModal } from './pricecard/PriceCardModal';
import {
  formatPriceCardAmount,
  loadPriceCardHistory,
  type PriceCardHistoryEntry,
} from '../../services/priceCardService';
import {
  teal, amber, paper, ink, inkSoft, hairline,
  inputStyle, btnGhostStyle, btnPrimaryStyle,
  PageHeader, KpiCards, EmptyState, tableHeadRow, tableHeadCell, tableCard,
} from './pricecard/priceCardChrome';

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
  const [searchTerm, setSearchTerm] = useState('');

  const handleClose = useCallback(() => {
    setModalOpen(false);
    setHistory(loadPriceCardHistory());
  }, []);

  const filtered = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    const list = history.slice(0, 50);
    if (!q) return list;
    return list.filter((h) =>
      (h.reference || '').toLowerCase().includes(q) ||
      (h.productNames || []).join(', ').toLowerCase().includes(q) ||
      (h.customerName || '').toLowerCase().includes(q),
    );
  }, [history, searchTerm]);

  const kpis = useMemo(() => {
    const totalValue = history.reduce((s, h) => s + Number(h.grandTotal || 0), 0);
    const totalLines = history.reduce((s, h) => s + (h.productNames?.length ?? 0), 0);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const thisMonth = history.filter((h) => {
      const d = new Date(h.issuedAt).getTime();
      return Number.isFinite(d) && d >= monthStart.getTime();
    }).length;
    const currency = history[0]?.currency || 'K';
    return [
      { label: 'Price Cards Issued', value: String(history.length), icon: ImageIcon, color: teal[700], bg: teal[50] },
      { label: 'Products Priced', value: String(totalLines), icon: Package, color: '#2563eb', bg: '#eff6ff' },
      { label: 'Total Quoted Value', value: history.length ? formatPriceCardAmount(totalValue, currency) : `${currency}0`, icon: Wallet, color: teal[700], bg: teal[50] },
      { label: 'Issued This Month', value: String(thisMonth), icon: CalendarCheck, color: amber[600], bg: amber[100] },
    ];
  }, [history]);

  const exportCsv = useCallback(() => {
    const headers = ['Reference', 'Products', 'Customer', 'Total', 'Currency', 'Issued'];
    const rows = filtered.map((h) => [
      h.reference || '',
      (h.productNames || []).join('; '),
      h.customerName || 'Walk-in',
      String(h.grandTotal ?? ''),
      h.currency || '',
      h.issuedAt ? new Date(h.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '',
    ]);
    const csv = [headers, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `price_cards_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filtered]);

  return (
    <div className="flex flex-col h-full" style={{ background: paper, fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink }}>
      <PageHeader
        icon={<Tag size={19} color="#fff" />}
        title="Price Cards"
        subtitle="Answer customer price inquiries with a professional image — same selling price as POS and Order Form · Informational only"
        actions={
          <>
            <span style={{ fontSize: 12, color: inkSoft }}>
              <b style={{ color: ink }}>{history.length}</b> cards issued
            </span>
            <button
              onClick={exportCsv}
              disabled={filtered.length === 0}
              style={{ ...btnGhostStyle, opacity: filtered.length === 0 ? 0.55 : 1, cursor: filtered.length === 0 ? 'not-allowed' : 'pointer' }}
              onMouseEnter={e => { if (filtered.length > 0) { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; } }}
              onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
            >
              <Download size={15} /> Export
            </button>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              style={btnPrimaryStyle}
              onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
            >
              <Plus size={15} /> New Price Card
            </button>
          </>
        }
      />

      <KpiCards items={kpis} />

      {/* Search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 28px' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
          <input
            type="text"
            placeholder="Search by reference, product, or customer…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ ...inputStyle, paddingLeft: 34 }}
          />
        </div>
      </div>

      {/* Recent price cards */}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 28px 28px' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.1, margin: '0 0 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ whiteSpace: 'nowrap' }}>Recent price cards ({filtered.length})</span>
          <div style={{ flex: 1, height: 1, background: hairline }} />
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Tag size={32} />}
            title={history.length === 0 ? 'No price cards generated yet' : 'No price cards match your search'}
            hint={history.length === 0 ? 'Click “New Price Card” to create the first professional price image for a customer.' : 'Try a different reference, product, or customer name.'}
          />
        ) : (
          <div style={tableCard}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={tableHeadRow}>
                  <th style={tableHeadCell}>Reference</th>
                  <th style={tableHeadCell}>Products</th>
                  <th style={tableHeadCell}>Customer</th>
                  <th style={{ ...tableHeadCell, textAlign: 'right' }}>Total</th>
                  <th style={{ ...tableHeadCell, textAlign: 'right' }}>Issued</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((h) => (
                  <tr
                    key={h.reference}
                    style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                    onMouseEnter={e => { e.currentTarget.style.background = teal[50]; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{
                          width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                          background: teal[100], color: teal[700],
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <Tag size={14} />
                        </div>
                        <span style={{ fontWeight: 700, fontSize: 13, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{h.reference}</span>
                      </div>
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: ink, maxWidth: 320, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {h.productNames.join(', ')}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13, color: inkSoft }}>
                      {h.customerName || 'Walk-in'}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 13, textAlign: 'right', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: teal[700], fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {formatPriceCardAmount(h.grandTotal, h.currency)}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: 12.5, textAlign: 'right', color: inkSoft, whiteSpace: 'nowrap' }}>
                      {new Date(h.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PriceCardModal open={modalOpen} initialItem={null} onClose={handleClose} />
    </div>
  );
};

export default PriceCards;
