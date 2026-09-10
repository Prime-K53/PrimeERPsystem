/**
 * Account Detail view (centered modal — Add-Customer language, no sidebar).
 *
 * Tabs:
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
import { Building2, ArrowRightLeft, CheckCircle2, FileText, Upload } from 'lucide-react';
import { dbService } from '../../../../services/db';
import { logger } from '../../../../services/logger';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, sectionLabelStyle,
    btnGhostStyle, btnPrimaryStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    EmptyState,
} from '../components/financeChrome';

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

  const acctTxns = useMemo(() => {
    if (!account) return [];
    return transactions.filter((t: any) => t.bankAccountId === account.id);
  }, [transactions, account]);

  if (!account) return null;

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalShell(640)} onClick={e => e.stopPropagation()}>
        <AccentStripe />
        <ModalHeader
          icon={<Building2 size={19} color="#fff" />}
          title={account.name}
          subtitle={`${account.bankName || '—'} · ${account.accountNumber || '—'}`}
          onClose={onClose}
        />

        <div style={{ display: 'flex', gap: 4, padding: '0 28px', borderBottom: `1px solid ${hairline}`, background: paper, flexShrink: 0 }}>
          {(['overview', 'transactions', 'reconciliation', 'ledger', 'attachments'] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '10px 12px', border: 'none', background: 'transparent',
              borderBottom: tab === t ? `2px solid ${teal[600]}` : '2px solid transparent',
              color: tab === t ? teal[700] : inkSoft, fontWeight: tab === t ? 700 : 500, fontSize: 12.5, cursor: 'pointer', textTransform: 'capitalize',
            }}>{t}</button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
          {tab === 'overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
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
                <button onClick={onNewTransaction} style={btnPrimaryStyle}><ArrowRightLeft size={14} /> New Transaction</button>
                <button onClick={onReconcile} style={btnGhostStyle}><CheckCircle2 size={14} /> Reconcile</button>
                {onImportStatement && (
                  <button onClick={onImportStatement} style={btnGhostStyle}><Upload size={14} /> Import Statement</button>
                )}
              </div>
            </div>
          )}
          {tab === 'transactions' && (
            <div>
              <div style={sectionLabelStyle}><span>{acctTxns.length} transactions</span></div>
              {acctTxns.length === 0 ? (
                <EmptyState icon={<ArrowRightLeft size={32} />} title="No transactions" hint="No transactions for this account yet." />
              ) : acctTxns.slice(0, 50).map((t: any) => (
                <div key={t.id}
                  style={{ padding: '10px 14px', borderRadius: 10, border: `1.4px solid ${hairline}`, marginBottom: 8, fontSize: 12.5, transition: 'background .12s' }}
                  onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ fontWeight: 600, color: ink }}>{t.description}</span>
                    <span style={{ fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: ['Deposit', 'Interest'].includes(t.type) ? teal[700] : danger }}>{t.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                  <div style={{ fontSize: 11, color: inkSoft }}>{t.date} · {t.type} · {t.reference}</div>
                </div>
              ))}
            </div>
          )}
          {tab === 'reconciliation' && (
            <div>
              <button onClick={onReconcile} style={{ ...btnPrimaryStyle, marginBottom: 14 }}>Start New Reconciliation</button>
              <KV k="Last Reconciled" v={account.lastReconciliationDate || account.lastReconciledDate || 'Never'} />
              <KV k="Last Reconciliation ID" v={account.lastReconciliationId || '—'} />
            </div>
          )}
          {tab === 'ledger' && (
            <div>
              {ledger.length === 0 ? (
                <EmptyState icon={<FileText size={32} />} title="No GL entries" hint="No GL entries for this account." />
              ) : (
                <div style={{ border: `1.4px solid ${hairline}`, borderRadius: 10, overflow: 'hidden' }}>
                  {ledger.slice(0, 50).map((e) => (
                    <div key={e.id} style={{ padding: '10px 14px', borderTop: `1px solid ${hairline}`, fontSize: 12.5, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <span style={{ color: ink }}>{e.date}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", color: inkSoft }}><strong>Dr</strong> {e.debitAccountId} · <strong>Cr</strong> {e.creditAccountId}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: ink }}>{e.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab === 'attachments' && (
            <div style={{ padding: 16, fontSize: 12.5, color: inkSoft, background: teal[50], border: `1px solid ${hairline}`, borderRadius: 10 }}>Attachments feature not yet implemented in this release. Use the Files module to attach documents and link them via reference.</div>
          )}
        </div>
        <ModalFooter stepLabel="Account · detail view" onCancel={onClose} submitLabel="Close" onSubmit={onClose} />
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number; currency: string; tone?: 'positive' | 'warning' | 'neutral' }> = ({ label, value, currency, tone = 'neutral' }) => (
  <div style={{ padding: '12px 14px', borderRadius: 10, background: paper, border: `1.4px solid ${hairline}`, borderLeft: `4px solid ${tone === 'positive' ? teal[500] : tone === 'warning' ? amber[500] : hairline}` }}>
    <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08 }}>{label}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color: ink, marginTop: 4, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{currency} {value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
  </div>
);

const KV: React.FC<{ k: string; v: string }> = ({ k, v }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: `1px solid ${hairline}`, fontSize: 12.5 }}>
    <span style={{ color: inkSoft, fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.08 }}>{k}</span>
    <span style={{ color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{v}</span>
  </div>
);
