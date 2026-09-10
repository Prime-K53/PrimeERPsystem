/**
 * Transaction Detail Modal.
 *
 * Shows the GL impact, source linkage, journal linkage, and history of a
 * single Bank Transaction. Read-only view.
 */

import React from 'react';
import { ArrowRightLeft, ExternalLink } from 'lucide-react';
import { dbService } from '../../../../services/db';
import { logger } from '../../../../services/logger';
import { AttachmentsPanel } from '../components/AttachmentsPanel';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, paper, ink, inkSoft, hairline,
    labelStyle, sectionLabelStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
} from '../../components/financeChrome';

interface Props {
  onClose: () => void;
  txn: any;
  accounts: any[];
  currency: string;
  uploadedBy?: string;
}

export const TransactionDetailModal: React.FC<Props> = ({ onClose, txn, accounts, currency, uploadedBy }) => {
  const [ledgerEntries, setLedgerEntries] = React.useState<any[]>([]);

  React.useEffect(() => {
    if (!txn) return;
    (async () => {
      try {
        const all = await dbService.getAll<any>('ledger');
        const linked = all.filter((e) => e.referenceId === txn.id || e.referenceId === txn.reference || e.referenceId === `REV-${txn.id}`);
        setLedgerEntries(linked);
      } catch (err) { logger.error(err); }
    })();
  }, [txn]);

  if (!txn) return null;
  const acc = accounts.find((a) => a.id === txn.bankAccountId);

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalShell(640)} onClick={e => e.stopPropagation()}>
        <AccentStripe />
        <ModalHeader
          icon={<ArrowRightLeft size={19} color="#fff" />}
          title={txn.description || 'Transaction Detail'}
          subtitle={`${txn.date} · ${txn.type} · ${acc?.name || '—'}`}
          onClose={onClose}
        />
        <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
            <Detail label="Status" value={txn.status || 'Posted'} />
            <Detail label="Amount" value={`${currency} ${(txn.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} mono bold />
            <Detail label="Reference" value={txn.reference || txn.id} mono />
            <Detail label="Bank COA" value={txn.bankCOAId || acc?.coaId || '—'} mono />
            <Detail label="Counterparty COA" value={txn.counterpartyCOAId || '—'} mono />
            <Detail label="Expense Account" value={txn.expenseAccountId || '—'} mono />
            <Detail label="Income Account" value={txn.incomeAccountId || '—'} mono />
            <Detail label="Source Module" value={txn.sourceModule || 'Manual'} />
            <Detail label="Source Reference" value={txn.sourceReference || txn.sourceId || '—'} mono />
            <Detail label="Reconciled" value={txn.reconciled ? `Yes (${txn.clearedDate || '—'})` : 'No'} />
            <Detail label="Posted By" value={txn.postedBy || '—'} />
            <Detail label="Posted At" value={txn.postedAt || '—'} />
          </div>

          <div style={sectionLabelStyle}><span>Linked Journal Entries</span></div>
          <div style={{ marginBottom: 18 }}>
            {ledgerEntries.length === 0 ? (
              <div style={{ padding: 14, fontSize: 12.5, color: inkSoft, background: teal[50], border: `1px solid ${hairline}`, borderRadius: 10 }}>No journal entries linked to this transaction.</div>
            ) : (
              <div style={{ background: paper, border: `1.4px solid ${hairline}`, borderRadius: 10, overflow: 'hidden' }}>
                {ledgerEntries.map((e) => (
                  <div key={e.id} style={{ padding: '10px 14px', borderTop: `1px solid ${hairline}`, fontSize: 12.5, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <span style={{ color: ink }}>{e.date} · {e.description}</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: inkSoft }}><strong>Dr</strong> {e.debitAccountId} · <strong>Cr</strong> {e.creditAccountId} · {e.amount}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {txn.cheque && (
            <div style={{ background: teal[50], border: `1px solid ${teal[100]}`, padding: '10px 14px', borderRadius: 9, fontSize: 12.5, color: ink, marginBottom: 18 }}>
              Cheque #{txn.cheque.number} · Status {txn.cheque.status}
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <AttachmentsPanel transactionId={txn.id} uploadedBy={uploadedBy} />
          </div>
        </div>
        <ModalFooter stepLabel="Detail · read-only" onCancel={onClose} submitLabel="Close" onSubmit={onClose} />
      </div>
    </div>
  );
};

const Detail: React.FC<{ label: string; value: string; mono?: boolean; bold?: boolean }> = ({ label, value, mono, bold }) => (
  <div>
    <div style={labelStyle}>{label}</div>
    <div style={{ fontSize: 13, color: ink, marginTop: 2, fontWeight: bold ? 700 : 500, fontFamily: mono ? "'JetBrains Mono', monospace" : undefined }}>{value}</div>
  </div>
);
