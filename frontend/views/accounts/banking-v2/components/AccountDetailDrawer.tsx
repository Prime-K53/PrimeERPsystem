/**
 * Account Detail Drawer.
 *
 * Side-panel view of a single bank account with tabs:
 *   - Overview (book balance, account info)
 *   - Transactions (filtered list)
 *   - Reconciliation (history + new)
 *   - Ledger (raw GL entries)
 *   - Attachments (placeholder)
 *
 * Uses inline data fetching via dbService to avoid loading the entire
 * app state.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Building2, ArrowRightLeft, CheckCircle2, FileText, X, Upload } from 'lucide-react';
import { dbService } from '../../../../services/db';
import { logger } from '../../../../services/logger';

interface Props {
  onClose: () => void;
  account: any;
  accounts: any[];
  transactions: any[];
  currency: string;
  coaBalance: number;
  onNewTransaction: () => void;
  onReconcile: () => void;
  onImportStatement?: () => void;
}



type Tab = 'overview' | 'transactions' | 'reconciliation' | 'ledger' | 'attachments';

export const AccountDetailDrawer: React.FC<Props> = ({ onClose, account, accounts, transactions, currency, coaBalance, onNewTransaction, onReconcile, onImportStatement }) => {
  const [tab, setTab] = useState<Tab>('overview');
  const [ledger, setLedger] = useState<any[]>([]);

  useEffect(() => {
    if (!account || tab !== 'ledger') return;
    (async () => {
      try {
        const coaId = account.coaId;
        if (!coaId) { setLedger([]); return; }
        const all = await dbService.getAll<any>('ledger');
        setLedger(all.filter((e) => e.debitAccountId === coaId || e.creditAccountId === coaId).sort((a, b) => b.date.localeCompare(a.date)));
      } catch (err) { logger.error(err); }
    })();
  }, [account, tab]);

  if (!account) return null;

  const acctTxns = useMemo(() => {
    return transactions.filter((t: any) => t.bankAccountId === account.id);
  }, [transactions, account]);

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(560px, 95vw)', background: '#FEFDFB', borderLeft: '1px solid #e4ddd1', boxShadow: '-12px 0 40px -10px rgba(0,0,0,.25)', zIndex: 50, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #e4ddd1', background: '#eef7f6' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: 'linear-gradient(155deg, #1f8577, #0f544c)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Building2 size={16} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0b3e39' }}>{account.name}</div>
            <div style={{ fontSize: 11, color: '#5c6567' }}>{account.bankName} · {account.accountNumber}</div>
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#5c6567' }}><X size={18} /></button>
      </div>

      <div style={{ display: 'flex', gap: 0, padding: '8px 12px', borderBottom: '1px solid #e4ddd1' }}>
        {(['overview', 'transactions', 'reconciliation', 'ledger', 'attachments'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 12px', border: 'none', background: 'transparent',
            borderBottom: tab === t ? '2px solid #1f8577' : '2px solid transparent',
            color: tab === t ? '#0b3e39' : '#5c6567', fontWeight: tab === t ? 700 : 500, fontSize: 12, cursor: 'pointer', textTransform: 'capitalize',
          }}>{t}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {tab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Stat label="Book Balance (GL)" value={coaBalance} currency={currency} />
              <Stat label="Cached Balance" value={account.balance || 0} currency={currency} tone={Math.abs(coaBalance - (account.balance || 0)) < 0.01 ? 'positive' : 'warning'} />
            </div>
            <KV k="Status" v={account.status} />
            <KV k="Bank" v={account.bankName} />
            <KV k="Account Number" v={account.accountNumber} />
            <KV k="Type" v={account.bankAccountType || 'Current'} />
            <KV k="Currency" v={account.currency} />
            <KV k="COA Mapping" v={account.coaId || '—'} />
            <KV k="Opening Balance" v={`${currency} ${(account.openingBalance || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} />
            <KV k="Last Reconciled" v={account.lastReconciliationDate || account.lastReconciledDate || '—'} />
            {account.notes && <KV k="Notes" v={account.notes} />}
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button onClick={onNewTransaction} style={btnPrimary}><ArrowRightLeft size={14} /> New Transaction</button>
              <button onClick={onReconcile} style={btnSecondary}><CheckCircle2 size={14} /> Reconcile</button>
              {onImportStatement && (
                <button onClick={onImportStatement} style={btnSecondary}><Upload size={14} /> Import Statement</button>
              )}
            </div>
          </div>
        )}
        {tab === 'transactions' && (
          <div>
            <div style={{ fontSize: 11, color: '#5c6567', marginBottom: 6 }}>{acctTxns.length} transactions</div>
            {acctTxns.slice(0, 50).map((t: any) => (
              <div key={t.id} style={{ padding: 10, borderRadius: 8, border: '1px solid #e4ddd1', marginBottom: 6, fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 600 }}>{t.description}</span>
                  <span style={{ fontWeight: 700, color: ['Deposit', 'Interest'].includes(t.type) ? '#059669' : '#991b1b' }}>{t.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <div style={{ fontSize: 11, color: '#5c6567' }}>{t.date} · {t.type} · {t.reference}</div>
              </div>
            ))}
          </div>
        )}
        {tab === 'reconciliation' && (
          <div>
            <button onClick={onReconcile} style={{ ...btnPrimary, marginBottom: 10 }}>Start New Reconciliation</button>
            <KV k="Last Reconciled" v={account.lastReconciliationDate || account.lastReconciledDate || 'Never'} />
            <KV k="Last Reconciliation ID" v={account.lastReconciliationId || '—'} />
          </div>
        )}
        {tab === 'ledger' && (
          <div>
            {ledger.length === 0 ? (
              <div style={{ padding: 12, fontSize: 12, color: '#5c6567', background: '#f6f3ed', borderRadius: 6 }}>No GL entries for this account.</div>
            ) : (
              <div>
                {ledger.slice(0, 50).map((e) => (
                  <div key={e.id} style={{ padding: 8, borderTop: '1px solid #e4ddd1', fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
                    <span>{e.date}</span>
                    <span><strong>Dr</strong> {e.debitAccountId} · <strong>Cr</strong> {e.creditAccountId}</span>
                    <span>{e.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === 'attachments' && (
          <div style={{ padding: 12, fontSize: 12, color: '#5c6567' }}>Attachments feature not yet implemented in this release. Use the Files module to attach documents and link them via reference.</div>
        )}
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number; currency: string; tone?: 'positive' | 'warning' | 'neutral' }> = ({ label, value, currency, tone = 'neutral' }) => (
  <div style={{ padding: 10, borderRadius: 8, background: tone === 'positive' ? '#f0fdf4' : tone === 'warning' ? '#fef9e7' : '#eef7f6', border: '1px solid #e4ddd1' }}>
    <div style={{ fontSize: 9, fontWeight: 700, color: '#5c6567', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color: '#0b3e39', marginTop: 2 }}>{currency} {value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
  </div>
);

const KV: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #f0ece3', fontSize: 12 }}>
    <span style={{ color: '#5c6567', fontWeight: 600, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5 }}>{k}</span>
    <span style={{ color: '#23282A' }}>{v}</span>
  </div>
);

const btnPrimary: React.CSSProperties = { padding: '8px 14px', borderRadius: 8, border: 'none', background: 'linear-gradient(155deg, #1f8577, #0f544c)', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 };
const btnSecondary: React.CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 };
