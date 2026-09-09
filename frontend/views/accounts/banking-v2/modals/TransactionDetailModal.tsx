/**
 * Transaction Detail Modal.
 *
 * Shows the GL impact, source linkage, journal linkage, and history of a
 * single Bank Transaction. Read-only view.
 */

import React from 'react';
import { Dialog } from '../../../../components/Dialog';
import { ArrowRightLeft, ExternalLink } from 'lucide-react';
import { dbService } from '../../../../services/db';
import { logger } from '../../../../services/logger';
import { AttachmentsPanel } from '../components/AttachmentsPanel';

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
    <Dialog open={true} onOpenChange={() => onClose()} title="Transaction Detail" ariaLabel="Transaction Detail">
      <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: 'linear-gradient(155deg, #1f8577, #0f544c)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <ArrowRightLeft size={16} color="#fff" />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0b3e39' }}>{txn.description}</div>
            <div style={{ fontSize: 11, color: '#5c6567' }}>{txn.date} · {txn.type} · {acc?.name || '—'}</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Detail label="Status" value={txn.status || 'Posted'} />
          <Detail label="Amount" value={`${currency} ${(txn.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`} />
          <Detail label="Reference" value={txn.reference || txn.id} />
          <Detail label="Bank COA" value={txn.bankCOAId || acc?.coaId || '—'} />
          <Detail label="Counterparty COA" value={txn.counterpartyCOAId || '—'} />
          <Detail label="Expense Account" value={txn.expenseAccountId || '—'} />
          <Detail label="Income Account" value={txn.incomeAccountId || '—'} />
          <Detail label="Source Module" value={txn.sourceModule || 'Manual'} />
          <Detail label="Source Reference" value={txn.sourceReference || txn.sourceId || '—'} />
          <Detail label="Reconciled" value={txn.reconciled ? `Yes (${txn.clearedDate || '—'})` : 'No'} />
          <Detail label="Posted By" value={txn.postedBy || '—'} />
          <Detail label="Posted At" value={txn.postedAt || '—'} />
        </div>

        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#5c6567', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Linked Journal Entries</div>
          {ledgerEntries.length === 0 ? (
            <div style={{ padding: 10, fontSize: 12, color: '#5c6567', background: '#f6f3ed', borderRadius: 6 }}>No journal entries linked to this transaction.</div>
          ) : (
            <div style={{ background: '#fff', border: '1px solid #e4ddd1', borderRadius: 6 }}>
              {ledgerEntries.map((e) => (
                <div key={e.id} style={{ padding: 8, borderTop: '1px solid #e4ddd1', fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
                  <span>{e.date} · {e.description}</span>
                  <span><strong>Dr</strong> {e.debitAccountId} · <strong>Cr</strong> {e.creditAccountId} · {e.amount}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {txn.cheque && (
          <div style={{ background: '#eef7f6', padding: 10, borderRadius: 8, fontSize: 12 }}>
            Cheque #{txn.cheque.number} · Status {txn.cheque.status}
          </div>
        )}

        <AttachmentsPanel transactionId={txn.id} uploadedBy={uploadedBy} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid #e4ddd1', paddingTop: 10 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 9, border: '1px solid #e4ddd1', background: '#FEFDFB', color: '#5c6567', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Close</button>
        </div>
      </div>
    </Dialog>
  );
};

const Detail: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div style={{ fontSize: 9, fontWeight: 700, color: '#5c6567', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
    <div style={{ fontSize: 12.5, color: '#23282A', marginTop: 2 }}>{value}</div>
  </div>
);
