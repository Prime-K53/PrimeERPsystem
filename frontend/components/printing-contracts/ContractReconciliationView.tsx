/**
 * ContractReconciliationView.tsx — Phase 4 §5 read-only reconciliation.
 * Reuses reconcilePrintingContracts + contractFunds canonical calculations.
 * Customer-specific view + global discrepancy summary. Read-only by default:
 * no repair actions, no balance mutations. Warnings vs confirmed discrepancies
 * are distinguished; drill-down selects the contract.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, Search } from 'lucide-react';
import type {
  AssessmentContract,
  AssessmentContractItem,
  ContractDocument,
  Customer,
  LedgerEntry,
  WalletTransaction,
} from '../../types';
import { useFinanceStore } from '../../stores/financeStore';
import { useSalesStore } from '../../stores/salesStore';
import { reconcilePrintingContracts } from '../../utils/contractReconciliation';
import { customerFundingPosition, diagnoseReservationDrift } from '../../utils/contractFunds';
import { dbService } from '../../services/db';
import { durableSyncQueue } from '../../services/durableSyncQueue';
import { adjustmentQueueService, type AdjustmentQueueEntry } from '../../services/closedPeriodQueue';
import { customerNameOf as customerNameOfLookup } from '../../utils/customerDisplay';
import { formatMoney } from '../../utils/posMoney';
import {
  contractInk,
  contractInkSoft,
  contractHairline,
  contractPaper,
  contractTeal,
} from './contractModalChrome';

const money = (v: unknown, currency: string) => formatMoney(Number(v), currency);

interface Props {
  currency: string;
  onSelectContract: (id: string) => void;
}

const ContractReconciliationView: React.FC<Props> = ({ currency, onSelectContract }) => {
  const assessmentContracts = useFinanceStore((s) => s.assessmentContracts);
  const contractAssessments = useFinanceStore((s) => s.contractAssessments);
  const walletTransactions = useFinanceStore((s) => s.walletTransactions);
  const ledger = useFinanceStore((s) => (s as unknown as { ledger?: LedgerEntry[] }).ledger || []);
  const customers = useSalesStore((s) => s.customers);

  const [customerFilter, setCustomerFilter] = useState('');
  const [search, setSearch] = useState('');
  const [docs, setDocs] = useState<ContractDocument[]>([]);
  const [queueMetrics, setQueueMetrics] = useState<{ pending: number; failed: number; deadLetter: number } | null>(null);
  const [queueSample, setQueueSample] = useState<any[]>([]);
  const [adjustQueue, setAdjustQueue] = useState<AdjustmentQueueEntry[]>([]);

  useEffect(() => {
    dbService.getAll<ContractDocument>('contractDocuments' as any).then((rows) => setDocs(rows || [])).catch(() => setDocs([]));
    durableSyncQueue
      .getMetrics()
      .then((m: any) => setQueueMetrics({ pending: m.pending || 0, failed: m.failed || 0, deadLetter: m.deadLetter || 0 }))
      .catch(() => setQueueMetrics(null));
    (async () => {
      try {
        const [pending, failed, dead] = await Promise.all([
          durableSyncQueue.getAll('pending' as any).catch(() => []),
          durableSyncQueue.getAll('failed' as any).catch(() => []),
          durableSyncQueue.getAll('dead_letter' as any).catch(() => []),
        ]);
        const contractTables = new Set(['assessment_contracts', 'assessment_contract_items', 'contract_amendments', 'wallet_transactions', 'ledger_entries', 'contract_documents']);
        setQueueSample([...(pending as any[]), ...(failed as any[]), ...(dead as any[])].filter((op: any) => contractTables.has(String(op.table || ''))).slice(0, 20));
      } catch {
        setQueueSample([]);
      }
    })();
    adjustmentQueueService.listAdjustmentQueue().then(setAdjustQueue).catch(() => setAdjustQueue([]));
  }, []);

  const customerNameOf = (id?: string) => customerNameOfLookup(id, customers);

  const customerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of assessmentContracts || []) if (c.customer_id) ids.add(String(c.customer_id));
    return [...ids].sort();
  }, [assessmentContracts]);

  const filteredContracts = useMemo(() => {
    let list = [...(assessmentContracts || [])];
    if (customerFilter) list = list.filter((c) => String(c.customer_id) === customerFilter);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          String(c.contract_number || '').toLowerCase().includes(q) ||
          String(c.title || '').toLowerCase().includes(q) ||
          customerNameOf(c.customer_id).toLowerCase().includes(q),
      );
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assessmentContracts, customerFilter, search, customers]);

  const reports = useMemo(() => {
    const ids = customerFilter ? [customerFilter] : customerIds;
    return ids.map((cid) => {
      const customer = (customers as Customer[]).find((cc) => String(cc.id) === String(cid));
      const walletBalance = Number((customer as any)?.walletBalance || 0);
      const report = reconcilePrintingContracts({
        contracts: assessmentContracts || [],
        items: contractAssessments || [],
        walletTransactions: (walletTransactions || []) as WalletTransaction[],
        ledger: (ledger || []) as LedgerEntry[],
        customerId: cid,
        walletBalance,
      });
      const funding = customerFundingPosition({
        contracts: (assessmentContracts || []) as AssessmentContract[],
        items: (contractAssessments || []) as AssessmentContractItem[],
        customerId: cid,
        walletBalance,
      });
      return { cid, walletBalance, report, funding };
    });
  }, [customerIds, customerFilter, assessmentContracts, contractAssessments, walletTransactions, ledger, customers]);

  const globalDiscrepancies = useMemo(() => reports.flatMap((r) => r.report.discrepancies.map((d) => ({ cid: r.cid, text: d }))), [reports]);
  const drift = useMemo(
    () => diagnoseReservationDrift({ contracts: (assessmentContracts || []) as any, items: (contractAssessments || []) as any }),
    [assessmentContracts, contractAssessments],
  );

  const docsByContract = useMemo(() => {
    const map = new Map<string, ContractDocument[]>();
    for (const d of docs) {
      const cid = String(d.contract_id || '');
      if (!map.has(cid)) map.set(cid, []);
      map.get(cid)!.push(d);
    }
    for (const list of map.values()) list.sort((a, b) => Number(a.documentVersion || 0) - Number(b.documentVersion || 0));
    return map;
  }, [docs]);

  const missingDocs = useMemo(() => {
    const out: Array<{ contractId: string; contractNumber: string; kind: string }> = [];
    for (const c of filteredContracts) {
      const list = docsByContract.get(String(c.id)) || [];
      const schedules = list.filter((d) => d.documentType === 'printing_contract_schedule' && d.status === 'VALID');
      if ((c.status === 'active' || c.status === 'suspended') && schedules.length === 0) {
        out.push({ contractId: String(c.id), contractNumber: String(c.contract_number), kind: 'Active contract has no valid schedule version' });
      }
      const items = (contractAssessments || []).filter((it) => String(it.contract_id) === String(c.id) && String(it.status) === 'consumed');
      for (const it of items) {
        const hasReceipt = list.some((d) => d.documentType === 'printing_contract_completion_receipt' && String(d.assessmentItemId) === String(it.id) && d.status !== 'VOID');
        if (!hasReceipt) out.push({ contractId: String(c.id), contractNumber: String(c.contract_number), kind: `Consumed assessment ${it.assessment_name || it.id} has no receipt` });
      }
    }
    return out.slice(0, 30);
  }, [filteredContracts, docsByContract, contractAssessments]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} style={{ padding: '7px 10px', borderRadius: 8, border: `1px solid ${contractHairline}`, background: '#fff', fontSize: 12 }}>
          <option value="">All customers ({customerIds.length})</option>
          {customerIds.map((id) => (
            <option key={id} value={id}>{customerNameOf(id)} ({id})</option>
          ))}
        </select>
        <div style={{ position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: contractInkSoft }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter contracts" style={{ padding: '7px 10px 7px 28px', borderRadius: 8, border: `1px solid ${contractHairline}`, background: '#fff', fontSize: 12, width: 200 }} />
        </div>
        <span style={{ fontSize: 11, color: contractInkSoft }}>
          Read-only diagnostics — no balances are changed here. Repair actions require a separate approved workflow.
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        {[
          { label: 'Customers with contracts', value: String(customerIds.length) },
          { label: 'Contracts in view', value: String(filteredContracts.length) },
          { label: 'Confirmed discrepancies', value: String(globalDiscrepancies.length) },
          { label: 'Legacy drift rows', value: String(drift.length) },
          { label: 'Missing schedule/receipt records', value: String(missingDocs.length) },
          { label: 'Sync pending / failed / dead-letter', value: queueMetrics ? `${queueMetrics.pending} / ${queueMetrics.failed} / ${queueMetrics.deadLetter}` : '—' },
          { label: 'Awaiting adjustment decision', value: String(adjustQueue.length) },
        ].map((k) => (
          <div key={k.label} style={{ background: contractPaper, border: `1px solid ${contractHairline}`, borderRadius: 10, padding: 10 }}>
            <p style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.06, color: contractInkSoft, margin: '0 0 4px' }}>{k.label}</p>
            <p style={{ fontWeight: 700, color: contractInk, margin: 0, fontVariantNumeric: 'tabular-nums' }}>{k.value}</p>
          </div>
        ))}
      </div>

      {globalDiscrepancies.length > 0 && (
        <div style={{ background: '#fef0ee', border: '1px solid #f5c6c0', borderRadius: 10, padding: 12 }}>
          <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.06, color: '#b5493f', margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertTriangle size={13} /> Confirmed discrepancies ({globalDiscrepancies.length})
          </p>
          {globalDiscrepancies.slice(0, 12).map((d, i) => (
            <p key={i} style={{ fontSize: 12, color: '#7a2e28', margin: '3px 0' }}>{customerNameOf(d.cid)} — {d.text}</p>
          ))}
          {globalDiscrepancies.length > 12 && <p style={{ fontSize: 11, color: '#7a2e28' }}>+ {globalDiscrepancies.length - 12} more — filter by customer to review.</p>}
        </div>
      )}
      {globalDiscrepancies.length === 0 && (
        <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 10, padding: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <CheckCircle size={14} color="#047857" />
          <span style={{ fontSize: 12, color: '#065f46' }}>Derived balances reconcile with canonical wallet, reservation and ledger records for the current filter.</span>
        </div>
      )}

      {reports.map(({ cid, walletBalance, report, funding }) => (
        <div key={cid} style={{ background: '#fff', border: `1px solid ${contractHairline}`, borderRadius: 12, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <p style={{ fontWeight: 700, color: contractInk, margin: 0, fontSize: 13 }}>{customerNameOf(cid)} <span style={{ color: contractInkSoft, fontWeight: 400 }}>({cid})</span></p>
            <p className="finance-nums" style={{ fontSize: 12, color: contractInkSoft, margin: 0, fontVariantNumeric: 'tabular-nums' }}>
              Wallet {money(walletBalance, currency)} · Protected {money(report.totalActiveReservations, currency)} · Available for unrelated spending {money(report.availableForUnrelatedSpending, currency)}
            </p>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 900 }}>
              <thead>
                <tr style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.05, color: contractInkSoft }}>
                  {['Contract', 'Status', 'Counts (total / done / left)', 'Commercial value', 'Verified funding note', 'Original reserved', 'Remaining reserved', 'Consumed', 'Released', 'Unfunded', 'Documents'].map((h) => (
                    <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: `1px solid ${contractHairline}`, fontWeight: 800 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.contracts
                  .filter((line) => filteredContracts.some((c) => String(c.id) === String(line.contractId)))
                  .map((line) => {
                    const fund = funding.contracts.find((f) => f.contractId === line.contractId);
                    const docList = docsByContract.get(String(line.contractId)) || [];
                    return (
                      <tr key={line.contractId} style={{ borderBottom: `1px solid ${contractHairline}` }}>
                        <td style={{ padding: '7px 8px' }}>
                          <button onClick={() => onSelectContract(line.contractId)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: contractTeal[700], fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: 0 }}>
                            {line.contractNumber}
                          </button>
                        </td>
                        <td style={{ padding: '7px 8px', textTransform: 'capitalize' }}>{line.status}</td>
                        <td className="finance-nums" style={{ padding: '7px 8px', fontVariantNumeric: 'tabular-nums' }}>
                          {line.totalAssessments} / {line.consumedCount} / {Math.max(0, line.totalAssessments - line.consumedCount)}
                        </td>
                        <td className="finance-nums" style={{ padding: '7px 8px', fontVariantNumeric: 'tabular-nums' }}>{money(line.contractValue, currency)}</td>
                        <td style={{ padding: '7px 8px', color: contractInkSoft, fontSize: 11 }}>Commercial figure only — funding is the wallet balance above</td>
                        <td className="finance-nums" style={{ padding: '7px 8px', fontVariantNumeric: 'tabular-nums' }}>{money(line.originalReserved, currency)}</td>
                        <td className="finance-nums" style={{ padding: '7px 8px', fontVariantNumeric: 'tabular-nums' }}>{money(line.currentReserved, currency)}</td>
                        <td className="finance-nums" style={{ padding: '7px 8px', fontVariantNumeric: 'tabular-nums' }}>{money(line.consumedToDate, currency)}</td>
                        <td className="finance-nums" style={{ padding: '7px 8px', fontVariantNumeric: 'tabular-nums' }}>{money(line.releasedAmount, currency)}</td>
                        <td className="finance-nums" style={{ padding: '7px 8px', fontVariantNumeric: 'tabular-nums' }}>{money(fund?.unfundedObligation || 0, currency)}</td>
                        <td style={{ padding: '7px 8px', fontSize: 11, color: contractInkSoft }}>
                          {docList.length === 0 ? 'No versions yet' : docList.map((d) => `${d.documentType === 'printing_contract_schedule' ? 'Schedule' : 'Receipt'} v${d.documentVersion} (${d.status})`).join(' · ')}
                          {line.discrepancies.length > 0 && <span style={{ display: 'block', color: '#b5493f' }}>{line.discrepancies.join(' ')}</span>}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {report.contractWalletTransactions.length > 0 || report.contractLedgerEntries.length > 0 ? (
            <p style={{ fontSize: 11, color: contractInkSoft, margin: '8px 0 0' }}>
              Linked records: {report.contractWalletTransactions.length} wallet transaction(s) · {report.contractLedgerEntries.length} ledger entr(ies). Open the contract Wallet tab for the full list.
            </p>
          ) : (
            <p style={{ fontSize: 11, color: contractInkSoft, fontStyle: 'italic', margin: '8px 0 0' }}>No wallet or ledger rows reference these contracts yet.</p>
          )}
        </div>
      ))}

      {drift.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: 12 }}>
          <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.06, color: '#92400e', margin: '0 0 6px' }}>
            Legacy reservation drift (warning — not auto-repaired)
          </p>
          {drift.slice(0, 10).map((d) => (
            <p key={d.contractId} style={{ fontSize: 12, color: '#78350f', margin: '3px 0' }}>
              {d.contractNumber}: bucket {d.bucketReserved} vs canonical items {d.itemsReservedValue} — {d.detail}
              {' '}<button onClick={() => onSelectContract(d.contractId)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: contractTeal[700], fontWeight: 700, padding: 0 }}>Open</button>
            </p>
          ))}
        </div>
      )}

      {missingDocs.length > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${contractHairline}`, borderRadius: 10, padding: 12 }}>
          <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.06, color: contractInkSoft, margin: '0 0 6px' }}>
            Missing schedule / receipt records ({missingDocs.length})
          </p>
          {missingDocs.map((m, i) => (
            <p key={`${m.contractId}-${i}`} style={{ fontSize: 12, color: contractInk, margin: '3px 0' }}>
              {m.contractNumber} — {m.kind} {' '}
              <button onClick={() => onSelectContract(m.contractId)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: contractTeal[700], fontWeight: 700, padding: 0 }}>Open</button>
            </p>
          ))}
        </div>
      )}

      {adjustQueue.length > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${contractHairline}`, borderRadius: 10, padding: 12 }}>
          <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.06, color: '#92400e', margin: '0 0 4px' }}>
            Closed-period operations awaiting decision ({adjustQueue.length})
          </p>
          <p style={{ fontSize: 11, color: contractInkSoft, margin: '0 0 8px' }}>
            Review only. Original business dates are never rewritten, no adjustment is posted and no financial year is reopened here —
            anything requiring a financial adjustment stays pending the existing explicit approval flow.
          </p>
          {adjustQueue.map((e) => (
            <div key={e.queueId} style={{ borderTop: `1px solid ${contractHairline}`, paddingTop: 8, marginTop: 8, fontSize: 12 }}>
              <p className="finance-nums" style={{ margin: 0, color: contractInk, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                {e.table} · {e.recordId || '—'} · {e.operation} · {e.queueStatus}
              </p>
              <p style={{ margin: '4px 0 0', color: contractInkSoft }}>
                Business date: <b style={{ color: contractInk }}>{e.businessDate || 'missing'}</b>
                {' · '}Reason: {e.rejectionReason?.slice(0, 180) ?? ''}
              </p>
              {e.contractId && (
                <button onClick={() => onSelectContract(e.contractId as string)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: contractTeal[700], fontWeight: 700, padding: 0, fontSize: 11 }}>
                  Open contract {e.contractNumber || e.contractId}
                </button>
              )}
              <p style={{ margin: '4px 0 0', fontSize: 11, color: e.retryEligible ? '#047857' : '#92400e' }}>
                {e.retryEligible
                  ? 'Period is open — this operation can be re-queued unchanged.'
                  : e.retryBlockedBecause || 'Re-queueing is blocked.'}
              </p>
              {e.retryEligible && (
                <button
                  type="button"
                  onClick={async () => {
                    const res = await adjustmentQueueService.retryAdjustmentEntry(e.queueId);
                    setAdjustQueue(await adjustmentQueueService.listAdjustmentQueue());
                  }}
                  style={{ marginTop: 6, padding: '5px 10px', fontSize: 11, fontWeight: 700, borderRadius: 7, cursor: 'pointer', border: '1px solid #0f766e', background: '#0f766e', color: '#fff' }}
                >
                  Re-queue unchanged
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {queueSample.length > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${contractHairline}`, borderRadius: 10, padding: 12 }}>
          <p style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.06, color: contractInkSoft, margin: '0 0 6px' }}>
            Pending / rejected sync operations (contract tables, latest {queueSample.length})
          </p>
          {queueSample.map((op: any, i: number) => (
            <p key={i} className="finance-nums" style={{ fontSize: 11, color: contractInkSoft, margin: '2px 0', fontFamily: "'JetBrains Mono', monospace" }}>
              {String(op.table)} · {String(op.recordId || '')} · {String(op.status || '')}{op.lastError ? ` · ${String(op.lastError).slice(0, 120)}` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  );
};

export default ContractReconciliationView;
