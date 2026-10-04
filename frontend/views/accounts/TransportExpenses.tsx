import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Truck, X, CheckCircle, AlertTriangle, RotateCcw, ChevronRight, FileText, XCircle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { dbService } from '../../services/db';
import {
  createTransportExpense,
  postTransportExpense,
  voidTransportExpense,
  TRANSPORT_EXPENSE_DEBIT_ACCOUNT,
  type CreateTransportExpenseInput,
} from '../../services/transportExpenseService';
import type { TransportExpense } from '../../types';

/* Design tokens mirroring the Clients "Add Customer" modal (ClientModal.tsx) */
const teal = {
  50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7',
  400: '#3fa294', 500: '#1f8577', 600: '#146b60', 700: '#0f544c',
  800: '#0b3e39', 900: '#082e2a'
};
const amber = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' };
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const danger = '#b5493f';

interface DraftLine {
  description: string;
  amount: string;
  classification: 'OUTBOUND_TRANSPORT' | 'NON_TRANSPORT';
  supplierId: string;
  accountId: string;
}

const emptyLine = (supplierId: string): DraftLine => ({
  description: '',
  amount: '',
  classification: 'OUTBOUND_TRANSPORT',
  supplierId,
  accountId: '',
});

const statusPill = (status: string): React.CSSProperties => {
  const base: React.CSSProperties = {
    display: 'inline-block', padding: '4px 12px', borderRadius: 999,
    fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '.04em', border: '1px solid transparent',
  };
  if (status === 'POSTED') {
    return { ...base, background: teal[50], color: teal[700], borderColor: teal[200] };
  }
  if (status === 'VOIDED') {
    return { ...base, background: '#fdf2f2', color: danger, borderColor: '#f5c6c6' };
  }
  return { ...base, background: '#f5f4f0', color: inkSoft, borderColor: hairline };
};

const TransportExpenses: React.FC = () => {
  const { notify } = useAuth();
  const [expenses, setExpenses] = useState<TransportExpense[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [supplierId, setSupplierId] = useState('');
  const [businessDate, setBusinessDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [settlementMode, setSettlementMode] = useState<'AP' | 'CASH'>('AP');
  const [settlementAccountId, setSettlementAccountId] = useState('11110');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine('')]);
  const [confirmVoidId, setConfirmVoidId] = useState<string | null>(null);

  const refresh = async () => {
    const [all, sups] = await Promise.all([
      dbService.getAll<TransportExpense>('transportExpenses' as never),
      dbService.getAll<any>('suppliers' as never),
    ]);
    setExpenses((all || []).filter((e) => !e.isReversal));
    setSuppliers(sups || []);
  };

  useEffect(() => {
    refresh().catch((err) => notify(`Failed to load transport expenses: ${String((err as Error)?.message || err)}`, 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = useMemo(() => {
    const transport = lines
      .filter((l) => l.classification === 'OUTBOUND_TRANSPORT')
      .reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    return { transport, total };
  }, [lines]);

  /* Document KPIs — live from the same expense store as the table below.
     These describe source documents (counts and posted money), not the
     Transport Budget ledger balance (see /revenue/transport-budget). */
  const docKpis = useMemo(() => {
    let postedTransport = 0;
    let postedTotal = 0;
    let postedCount = 0;
    let voidedCount = 0;
    let voidedTotal = 0;
    let draftCount = 0;
    for (const e of expenses || []) {
      const docTotal = Number(e.totalAmount || 0);
      if (e.status === 'POSTED') {
        postedCount += 1;
        postedTotal += docTotal;
        postedTransport += (e.lines || [])
          .filter((l) => l.classification === 'OUTBOUND_TRANSPORT')
          .reduce((s, l) => s + (Number(l.amount) || 0), 0);
      } else if (e.status === 'VOIDED') {
        voidedCount += 1;
        voidedTotal += docTotal;
      } else {
        draftCount += 1;
      }
    }
    return { postedTransport, postedTotal, postedCount, voidedCount, voidedTotal, draftCount };
  }, [expenses]);

  const formatMoney = (value: number) =>
    Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const kpiCards = [
    {
      label: 'Posted Transport',
      value: formatMoney(docKpis.postedTransport),
      subtext: `${docKpis.postedCount} posted document(s) · 52610 legs`,
      icon: Truck, border: teal[500], iconBg: teal[50], iconColor: teal[500], textColor: teal[700],
    },
    {
      label: 'Posted Total',
      value: formatMoney(docKpis.postedTotal),
      subtext: `${docKpis.postedCount} posted document(s) incl. non-transport`,
      icon: CheckCircle, border: teal[600], iconBg: teal[50], iconColor: teal[600], textColor: teal[700],
    },
    {
      label: 'Voided',
      value: formatMoney(docKpis.voidedTotal),
      subtext: `${docKpis.voidedCount} voided document(s) · reversed`,
      icon: XCircle,
      border: docKpis.voidedCount > 0 ? danger : hairline,
      iconBg: docKpis.voidedCount > 0 ? '#fdf2f2' : '#f5f4f0',
      iconColor: docKpis.voidedCount > 0 ? danger : inkSoft,
      textColor: docKpis.voidedCount > 0 ? danger : inkSoft,
    },
    {
      label: 'Drafts',
      value: String(docKpis.draftCount),
      subtext: 'awaiting posting · no ledger effect',
      icon: FileText, border: amber[500], iconBg: amber[100], iconColor: amber[600], textColor: ink,
    },
  ];

  const handleCreateAndPost = async () => {
    setSaving(true);
    try {
      const input: CreateTransportExpenseInput = {
        supplierId: supplierId || null,
        settlementMode,
        settlementAccountId: settlementMode === 'CASH' ? settlementAccountId : null,
        businessDate,
        lines: lines.map((l) => ({
          description: l.description,
          amount: Number(l.amount),
          classification: l.classification,
          supplierId: l.supplierId,
          accountId: l.classification === 'NON_TRANSPORT' ? l.accountId || null : null,
        })),
      };
      const created = await createTransportExpense(input);
      const posted = await postTransportExpense(created.id);
      notify(`Transport expense posted (${posted.totalAmount.toFixed(2)}).`, 'success');
      setIsFormOpen(false);
      setLines([emptyLine('')]);
      await refresh();
    } catch (err) {
      notify(`Transport expense failed: ${String((err as Error)?.message || err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleVoid = async (id: string) => {
    try {
      await voidTransportExpense(id, 'Manual void from Transport Expenses');
      notify('Transport expense voided with reversal.', 'success');
      setConfirmVoidId(null);
      await refresh();
    } catch (err) {
      notify(`Void failed: ${String((err as Error)?.message || err)}`, 'error');
    }
  };

  return (
    <div style={{
      padding: '28px 32px', maxWidth: 1200, margin: '0 auto',
      fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink,
    }}>
      {/* Page header — Add Customer title treatment */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 10px -3px rgba(15,84,76,.6)', flexShrink: 0
          }}>
            <Truck size={19} color="#fff" />
          </div>
          <div>
            <h1 style={{
              fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400,
              fontSize: 22, margin: 0, color: teal[800], letterSpacing: 0.2
            }}>
              Courier &amp; Delivery Transport Expenses
            </h1>
            <p style={{ margin: '2px 0 0', fontSize: 11.5, color: inkSoft, letterSpacing: 0.02 }}>
              Authoritative outbound transport source &mdash; debits {TRANSPORT_EXPENSE_DEBIT_ACCOUNT} only;
              never customer charges, never Landing Cost.
            </p>
          </div>
        </div>
        <button
          onClick={() => setIsFormOpen(true)}
          style={{
            fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
            padding: '9px 18px', borderRadius: 9, cursor: 'pointer', border: '1.4px solid transparent',
            background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
            color: '#fff', display: 'flex', alignItems: 'center', gap: 7,
            boxShadow: '0 6px 16px -6px rgba(15,84,76,.55)',
            transition: 'all .15s ease', whiteSpace: 'nowrap'
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 8px 20px -6px rgba(15,84,76,.65)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 6px 16px -6px rgba(15,84,76,.55)'; }}
        >
          <Plus size={15} /> New transport expense
        </button>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
        {kpiCards.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} style={{ background: paper, padding: '12px 16px', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,.04)', border: `1.4px solid ${hairline}`, borderLeft: `4px solid ${kpi.border}`, display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{ padding: 10, borderRadius: 9, background: kpi.iconBg, color: kpi.iconColor, flexShrink: 0 }}>
                <Icon size={20} />
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: -0.01, margin: '0 0 4px' }}>{kpi.label}</p>
                <p className="finance-nums" style={{ fontSize: 18, fontWeight: 600, color: kpi.textColor, margin: 0, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{kpi.value}</p>
                <p style={{ fontSize: 10, color: inkSoft, margin: '2px 0 0' }}>{kpi.subtext}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Ledger card */}
      <div style={{
        background: paper, border: `1px solid ${hairline}`, borderRadius: 14,
        boxShadow: '0 1px 3px rgba(0,0,0,.04)', overflow: 'hidden'
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: teal[50] }}>
                {['Date', 'Supplier', 'Transport', 'Total', 'Mode', 'Status'].map((h, i) => (
                  <th key={h} style={{
                    padding: '10px 16px', fontSize: 10, fontWeight: 700, color: teal[800],
                    textTransform: 'uppercase', letterSpacing: '.06em', textAlign: i >= 2 && i <= 3 ? 'right' : 'left',
                    borderBottom: `1px solid ${hairline}`, whiteSpace: 'nowrap'
                  }}>
                    {h}
                  </th>
                ))}
                <th style={{ padding: '10px 16px', borderBottom: `1px solid ${hairline}` }} />
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => {
                const transportTotal = (e.lines || [])
                  .filter((l) => l.classification === 'OUTBOUND_TRANSPORT')
                  .reduce((s, l) => s + (Number(l.amount) || 0), 0);
                const supplierName =
                  suppliers.find((s) => String(s.id) === String(e.supplierId))?.name ||
                  e.supplierId ||
                  '—';
                return (
                  <tr key={e.id} style={{ borderBottom: `1px solid ${hairline}`, transition: 'background .12s' }}
                    onMouseEnter={e2 => { e2.currentTarget.style.background = teal[50]; }}
                    onMouseLeave={e2 => { e2.currentTarget.style.background = 'transparent'; }}
                  >
                    <td style={{ padding: '12px 16px', fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5, color: inkSoft, whiteSpace: 'nowrap' }}>
                      {e.businessDate}
                    </td>
                    <td style={{ padding: '12px 16px', fontWeight: 600 }}>{supplierName}</td>
                    <td className="finance-nums" style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 700, color: teal[700], fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                      {transportTotal.toFixed(2)}
                    </td>
                    <td className="finance-nums" style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                      {Number(e.totalAmount || 0).toFixed(2)}
                    </td>
                    <td style={{ padding: '12px 16px', color: inkSoft, fontSize: 12.5 }}>{e.settlementMode}</td>
                    <td style={{ padding: '12px 16px' }}>
                      <span style={statusPill(e.status)}>{e.status}</span>
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {e.status === 'POSTED' &&
                        (confirmVoidId === e.id ? (
                          <span style={{ display: 'inline-flex', gap: 8 }}>
                            <button
                              onClick={() => handleVoid(e.id)}
                              style={{
                                fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 600,
                                padding: '7px 14px', borderRadius: 9, cursor: 'pointer',
                                background: danger, border: '1px solid transparent', color: '#fff',
                              }}
                            >
                              Confirm void
                            </button>
                            <button
                              onClick={() => setConfirmVoidId(null)}
                              style={btnGhostStyleSmall}
                              onMouseEnter={e2 => { e2.currentTarget.style.background = teal[50]; e2.currentTarget.style.color = teal[800]; e2.currentTarget.style.borderColor = teal[200]; }}
                              onMouseLeave={e2 => { e2.currentTarget.style.background = paper; e2.currentTarget.style.color = inkSoft; e2.currentTarget.style.borderColor = hairline; }}
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmVoidId(e.id)}
                            style={btnGhostStyleSmall}
                            onMouseEnter={e2 => { e2.currentTarget.style.background = teal[50]; e2.currentTarget.style.color = teal[800]; e2.currentTarget.style.borderColor = teal[200]; }}
                            onMouseLeave={e2 => { e2.currentTarget.style.background = paper; e2.currentTarget.style.color = inkSoft; e2.currentTarget.style.borderColor = hairline; }}
                          >
                            <RotateCcw size={13} /> Void
                          </button>
                        ))}
                    </td>
                  </tr>
                );
              })}
              {expenses.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 32, textAlign: 'center' }}>
                    <Truck size={28} style={{ margin: '0 auto 10', color: teal[200] }} />
                    <p style={{ fontSize: 13, fontWeight: 700, color: teal[300], margin: 0 }}>
                      No transport expenses yet
                    </p>
                    <p style={{ fontSize: 11.5, color: inkSoft, margin: '4px 0 0' }}>
                      Record your first courier expense to start the outbound ledger.
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isFormOpen && (
        <div className="transport-modal-overlay" style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(15, 23, 42, 0.6)',
          padding: '40px 20px', fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink,
        }}>
          <div className="transport-modal-content" style={{
            width: 780, maxWidth: '100%', maxHeight: '92vh',
            background: paper, borderRadius: 14,
            boxShadow: '0 30px 70px -20px rgba(0,0,0,.55), 0 8px 24px -8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative'
          }}>
            {/* Accent stripe */}
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 4,
              background: `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 40%, ${amber[500]} 100%)`
            }} />

            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '22px 28px 18px',
              borderBottom: `1px solid ${hairline}`,
              background: paper
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10,
                  background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 4px 10px -3px rgba(15,84,76,.6)', flexShrink: 0
                }}>
                  <Truck size={19} color="#fff" />
                </div>
                <div>
                  <h1 style={{
                    fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400,
                    fontSize: 22, margin: 0, color: teal[800], letterSpacing: 0.2
                  }}>
                    New Transport Expense
                  </h1>
                  <p style={{ margin: '2px 0 0', fontSize: 11.5, color: inkSoft, letterSpacing: 0.02 }}>
                    Courier source document &mdash; posts to {TRANSPORT_EXPENSE_DEBIT_ACCOUNT}
                  </p>
                </div>
              </div>
              <button onClick={() => setIsFormOpen(false)} aria-label="Close" style={{
                width: 32, height: 32, borderRadius: 8,
                border: `1px solid ${hairline}`, background: paper, color: inkSoft,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', transition: 'all .15s ease', fontSize: 16
              }}
                onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; }}
                onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
              >
                <X size={15} />
              </button>
            </div>

            {/* Body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px 30px 8px' }}>
              <div style={sectionLabelStyle}><span>Expense Details</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                <div>
                  <label style={labelStyle}>Supplier</label>
                  <select
                    value={supplierId}
                    onChange={(e) => {
                      setSupplierId(e.target.value);
                      setLines((prev) =>
                        prev.map((l) => ({ ...l, supplierId: l.supplierId || e.target.value })),
                      );
                    }}
                    style={selectStyle}
                  >
                    <option value="">Select supplier…</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name || s.id}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Business Date</label>
                  <input
                    type="date"
                    value={businessDate}
                    onChange={(e) => setBusinessDate(e.target.value)}
                    style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Settlement</label>
                  <select
                    value={settlementMode}
                    onChange={(e) => setSettlementMode(e.target.value as 'AP' | 'CASH')}
                    style={selectStyle}
                  >
                    <option value="AP">Supplier AP (21110)</option>
                    <option value="CASH">Cash / bank now</option>
                  </select>
                </div>
                {settlementMode === 'CASH' && (
                  <div>
                    <label style={labelStyle}>Cash / Bank Account ID</label>
                    <input
                      value={settlementAccountId}
                      onChange={(e) => setSettlementAccountId(e.target.value)}
                      style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                    />
                  </div>
                )}
              </div>

              <div style={sectionLabelStyle}><span>Expense Lines</span></div>
              <div style={{ display: 'grid', gap: 12, marginBottom: 14 }}>
                {lines.map((line, index) => (
                  <div key={index} style={{
                    padding: 14, background: paper, border: `1px solid ${hairline}`,
                    borderRadius: 12, position: 'relative', transition: 'border-color .15s'
                  }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = teal[200]; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = hairline; }}
                  >
                    <button
                      onClick={() => setLines((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))}
                      title="Remove line"
                      style={{
                        position: 'absolute', top: 10, right: 10,
                        padding: 6, background: 'transparent', border: 'none',
                        color: inkSoft, cursor: 'pointer', borderRadius: 6
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = `${danger}15`; e.currentTarget.style.color = danger; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = inkSoft; }}
                    >
                      <X size={14} />
                    </button>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12, paddingRight: 28 }}>
                      <div>
                        <label style={labelStyle}>Description</label>
                        <input
                          placeholder="e.g. Lilongwe delivery run"
                          value={line.description}
                          onChange={(e) =>
                            setLines((prev) => prev.map((l, i) => (i === index ? { ...l, description: e.target.value } : l)))
                          }
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <label style={labelStyle}>Amount</label>
                        <div style={{ position: 'relative' }}>
                          <input
                            placeholder="0.00"
                            inputMode="decimal"
                            value={line.amount}
                            onChange={(e) =>
                              setLines((prev) => prev.map((l, i) => (i === index ? { ...l, amount: e.target.value } : l)))
                            }
                            style={{
                              ...inputStyle, textAlign: 'right',
                              fontFamily: "'JetBrains Mono', monospace",
                              fontVariantNumeric: 'tabular-nums', fontWeight: 600,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div>
                        <label style={labelStyle}>Classification</label>
                        <select
                          value={line.classification}
                          onChange={(e) =>
                            setLines((prev) =>
                              prev.map((l, i) =>
                                i === index ? { ...l, classification: e.target.value as DraftLine['classification'] } : l,
                              ),
                            )
                          }
                          style={selectStyle}
                        >
                          <option value="OUTBOUND_TRANSPORT">OUTBOUND_TRANSPORT</option>
                          <option value="NON_TRANSPORT">NON_TRANSPORT</option>
                        </select>
                      </div>
                      <div>
                        <label style={labelStyle}>
                          Debit Account
                          {line.classification === 'OUTBOUND_TRANSPORT' && (
                            <span style={{
                              fontSize: 9.5, fontWeight: 600, color: teal[700],
                              background: teal[50], padding: '1px 6px', borderRadius: 20,
                              letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6
                            }}>Auto 52610</span>
                          )}
                        </label>
                        <input
                          placeholder={line.classification === 'NON_TRANSPORT' ? 'Account ID' : 'Auto 52610'}
                          value={line.classification === 'NON_TRANSPORT' ? line.accountId : ''}
                          disabled={line.classification !== 'NON_TRANSPORT'}
                          onChange={(e) =>
                            setLines((prev) => prev.map((l, i) => (i === index ? { ...l, accountId: e.target.value } : l)))
                          }
                          style={{
                            ...inputStyle,
                            fontFamily: "'JetBrains Mono', monospace",
                            ...(line.classification !== 'NON_TRANSPORT'
                              ? { background: teal[50], color: inkSoft, cursor: 'not-allowed' }
                              : {}),
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setLines((prev) => [...prev, emptyLine(supplierId)])}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 14px', background: teal[500], color: '#fff',
                  borderRadius: 9, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  boxShadow: '0 4px 10px -4px rgba(15,84,76,.4)', marginBottom: 18,
                  fontFamily: "'Inter', sans-serif",
                }}
              >
                <Plus size={15} />
                Add Line
              </button>

              <div style={{
                padding: 16, background: teal[50], borderRadius: 9, border: `1px solid ${teal[100]}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 18
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: teal[800] }}>
                  Document Totals
                </div>
                <div className="finance-nums" style={{
                  fontSize: 13, fontWeight: 700, color: teal[800],
                  fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums'
                }}>
                  Transport {totals.transport.toFixed(2)} · Total {totals.total.toFixed(2)}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 14, padding: '16px 28px',
              borderTop: `1px solid ${hairline}`, background: paper
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: inkSoft }}>
                <AlertTriangle size={13} style={{ color: amber[600], flexShrink: 0 }} />
                Posting is immutable. Void creates a separate reversal.
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={() => setIsFormOpen(false)}
                  disabled={saving}
                  style={{
                    ...btnGhostStyle,
                    ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                  onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateAndPost}
                  disabled={saving}
                  style={{
                    fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
                    padding: '9px 18px', borderRadius: 9,
                    cursor: saving ? 'not-allowed' : 'pointer', border: '1.4px solid transparent',
                    background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                    color: '#fff', display: 'flex', alignItems: 'center', gap: 7,
                    boxShadow: '0 6px 16px -6px rgba(15,84,76,.55)',
                    transition: 'all .15s ease',
                    ...(saving ? { opacity: 0.7 } : {}),
                  }}
                  onMouseEnter={e => { if (!saving) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 8px 20px -6px rgba(15,84,76,.65)'; } }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 6px 16px -6px rgba(15,84,76,.55)'; }}
                >
                  {saving ? 'Posting…' : (<><CheckCircle size={14} /> Create &amp; Post</>)}
                  {!saving && <ChevronRight size={14} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const labelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  fontSize: 12, fontWeight: 600, color: teal[800],
  marginBottom: 6, letterSpacing: 0.01
};

const inputStyle: React.CSSProperties = {
  width: '100%', fontFamily: "'Inter', sans-serif", fontSize: 13.5,
  color: ink, background: paper,
  border: `1.4px solid ${hairline}`, borderRadius: 9,
  padding: '9px 12px', outline: 'none',
  transition: 'border-color .15s ease, box-shadow .15s ease, background .15s ease'
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235c6567'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: 30,
  cursor: 'pointer'
};

const sectionLabelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  margin: '26px 0 14px'
};

const btnGhostStyle: React.CSSProperties = {
  fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
  padding: '9px 18px', borderRadius: 9, cursor: 'pointer',
  background: paper, border: `1.4px solid ${hairline}`, color: inkSoft,
  display: 'flex', alignItems: 'center', gap: 7, transition: 'all .15s ease'
};

const btnGhostStyleSmall: React.CSSProperties = {
  fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 600,
  padding: '7px 14px', borderRadius: 9, cursor: 'pointer',
  background: paper, border: `1px solid ${hairline}`, color: inkSoft,
  display: 'inline-flex', alignItems: 'center', gap: 6, transition: 'all .15s ease'
};

export default TransportExpenses;
