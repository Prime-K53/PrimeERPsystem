/**
 * Bank Statement Import — CSV parser with dedupe + auto-match preview.
 *
 * Workflow:
 *   1. User selects a bank account + CSV file
 *   2. We parse the CSV (header row required, columns: date, description,
 *      reference, amount | debit/credit, balance)
 *   3. We detect duplicates against existing transactions (fingerprint =
 *      accountId + date + |amount| + reference)
 *   4. We auto-match by amount ± tolerance within a date window
 *   5. User confirms; matched rows are marked cleared, unmatched are
 *      offered for creation as new transactions
 *
 * The import never creates GL entries on its own — only the user-confirmed
 * "Create Transaction" path does (via the existing postBankTransactionGL).
 */

import React, { useState, useMemo, useCallback } from 'react';
import { Upload, FileText, AlertCircle, CheckCircle2, Trash2, Plus, ArrowRightLeft } from 'lucide-react';
import { roundFinancial } from '../../../../utils/helpers';
import { logger } from '../../../../services/logger';
import { dbService } from '../../../../services/db';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, selectStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    tableHeadRow, EmptyState,
} from '../../components/financeChrome';

interface ParsedRow {
  rowIndex: number;
  date: string;
  description: string;
  reference: string;
  amount: number; // signed: +money in, -money out
  balance?: number;
  fingerprint: string;
}

interface MatchResult {
  row: ParsedRow;
  status: 'duplicate' | 'matched' | 'unmatched';
  matchedTxnId?: string;
  matchedTxnDescription?: string;
}

interface Props {
  onClose: () => void;
  onImported: (matchedTxnIds: string[], createdCount: number) => void | Promise<void>;
  account: any;
  accounts: any[];
  transactions: any[];
  currency: string;
}

const AMOUNT_TOLERANCE = 0.01;
const DATE_WINDOW_DAYS = 3;

function fingerprintOf(accountId: string, date: string, amount: number, reference: string): string {
  return `${accountId}|${date}|${Math.abs(roundFinancial(amount)).toFixed(2)}|${(reference || '').trim().toLowerCase()}`;
}

function parseAmount(amountStr: string, debitStr?: string, creditStr?: string): number {
  const norm = (s: string) => parseFloat((s || '').replace(/[,\s]/g, '')) || 0;
  if (debitStr !== undefined || creditStr !== undefined) {
    const dr = norm(debitStr || '0');
    const cr = norm(creditStr || '0');
    return roundFinancial(cr - dr);
  }
  const a = norm(amountStr);
  // If explicit sign, use it; else assume money-in (positive)
  return roundFinancial(a);
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(1).map((l) => splitCsvLine(l));
  return { header, rows };
}

function headerIndex(header: string[], names: string[]): number {
  for (const n of names) {
    const idx = header.indexOf(n);
    if (idx !== -1) return idx;
  }
  return -1;
}

export const StatementImportModal: React.FC<Props> = ({ onClose, onImported, account, accounts, transactions, currency }) => {
  const [accountId, setAccountId] = useState<string>(account?.id || accounts[0]?.id || '');
  const [fileName, setFileName] = useState<string>('');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const activeAccounts = useMemo(() => accounts.filter((a) => a.status === 'Active'), [accounts]);
  const selAccount = activeAccounts.find((a) => a.id === accountId);

  const accountTxns = useMemo(
    () => transactions.filter((t) => t.bankAccountId === accountId && (t.status === 'Posted' || !t.status)),
    [transactions, accountId],
  );

  const existingFingerprints = useMemo(() => {
    const s = new Set<string>();
    for (const t of accountTxns) {
      const fp = fingerprintOf(accountId, t.date, t.amount, t.reference || '');
      s.add(fp);
    }
    return s;
  }, [accountTxns, accountId]);

  const matchResults: MatchResult[] = useMemo(() => {
    return parsedRows.map((row) => {
      // Exact fingerprint match → duplicate
      if (existingFingerprints.has(row.fingerprint)) {
        const exact = accountTxns.find((t) => fingerprintOf(accountId, t.date, t.amount, t.reference || '') === row.fingerprint);
        return { row, status: 'duplicate' as const, matchedTxnId: exact?.id, matchedTxnDescription: exact?.description };
      }
      // Auto-match by amount + date window
      const windowStart = new Date(row.date);
      windowStart.setDate(windowStart.getDate() - DATE_WINDOW_DAYS);
      const windowEnd = new Date(row.date);
      windowEnd.setDate(windowEnd.getDate() + DATE_WINDOW_DAYS);
      const candidate = accountTxns.find((t) => {
        if (t.date < windowStart.toISOString().slice(0, 10)) return false;
        if (t.date > windowEnd.toISOString().slice(0, 10)) return false;
        return Math.abs(roundFinancial(t.amount) - Math.abs(roundFinancial(row.amount))) < AMOUNT_TOLERANCE;
      });
      if (candidate) return { row, status: 'matched', matchedTxnId: candidate.id, matchedTxnDescription: candidate.description };
      return { row, status: 'unmatched' };
    });
  }, [parsedRows, existingFingerprints, accountTxns, accountId]);

  const counts = useMemo(() => {
    const c = { duplicate: 0, matched: 0, unmatched: 0 };
    for (const m of matchResults) c[m.status]++;
    return c;
  }, [matchResults]);

  const handleFile = useCallback((file: File) => {
    setParseError(null);
    setParsedRows([]);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const { header, rows } = parseCsv(text);
        if (header.length === 0) { setParseError('CSV is empty or unreadable'); return; }
        const dateIdx = headerIndex(header, ['date', 'transaction date', 'txn date']);
        const descIdx = headerIndex(header, ['description', 'narrative', 'details', 'memo']);
        const refIdx = headerIndex(header, ['reference', 'ref', 'cheque', 'cheque no']);
        const amountIdx = headerIndex(header, ['amount', 'value']);
        const debitIdx = headerIndex(header, ['debit', 'dr', 'withdrawal', 'paid out']);
        const creditIdx = headerIndex(header, ['credit', 'cr', 'deposit', 'paid in']);
        const balanceIdx = headerIndex(header, ['balance', 'running balance']);
        if (dateIdx === -1 || descIdx === -1 || (amountIdx === -1 && (debitIdx === -1 || creditIdx === -1))) {
          setParseError('CSV must have columns: date, description, reference, amount (or debit + credit). Optional: balance.');
          return;
        }
        const parsed: ParsedRow[] = [];
        rows.forEach((cols, i) => {
          const date = (cols[dateIdx] || '').slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
          const description = cols[descIdx] || '';
          const reference = refIdx !== -1 ? (cols[refIdx] || '') : '';
          const amount = parseAmount(amountIdx !== -1 ? cols[amountIdx] : '', debitIdx !== -1 ? cols[debitIdx] : undefined, creditIdx !== -1 ? cols[creditIdx] : undefined);
          if (Math.abs(amount) < 0.01) return;
          const balance = balanceIdx !== -1 ? parseFloat((cols[balanceIdx] || '').replace(/[,\s]/g, '')) || undefined : undefined;
          parsed.push({
            rowIndex: i,
            date,
            description,
            reference,
            amount,
            balance,
            fingerprint: fingerprintOf(accountId, date, amount, reference),
          });
        });
        if (parsed.length === 0) { setParseError('No valid rows found in CSV'); return; }
        setParsedRows(parsed);
      } catch (err) {
        logger.error('CSV parse failed', err);
        setParseError(`Failed to parse CSV: ${(err as Error).message}`);
      }
    };
    reader.onerror = () => setParseError('Failed to read file');
    reader.readAsText(file);
  }, [accountId]);

  const importNow = useCallback(async () => {
    if (!accountId || matchResults.length === 0) return;
    setImporting(true);
    try {
      // 1) Mark matched & duplicate rows as cleared
      const clearedIds: string[] = [];
      const now = new Date().toISOString();
      for (const m of matchResults) {
        if (m.status === 'duplicate' || m.status === 'matched') {
          if (m.matchedTxnId) {
            const existing = await dbService.get<any>('bankTransactions', m.matchedTxnId);
            if (existing) {
              await dbService.put('bankTransactions', { ...existing, reconciled: true, clearedDate: existing.clearedDate || now });
              clearedIds.push(m.matchedTxnId);
            }
          }
        }
      }
      // 2) Save statement metadata so it shows in the Statements tab
      const statementId = `STMT-${Date.now()}`;
      await dbService.put('bankStatements', {
        id: statementId,
        bankAccountId: accountId,
        fileName,
        importedAt: now,
        rowCount: matchResults.length,
        matchedCount: counts.matched + counts.duplicate,
        unmatchedCount: counts.unmatched,
        rows: matchResults.map((m) => ({
          date: m.row.date,
          description: m.row.description,
          reference: m.row.reference,
          amount: m.row.amount,
          status: m.status,
          matchedTxnId: m.matchedTxnId,
        })),
      });

      await onImported(clearedIds, counts.unmatched);
      onClose();
    } catch (err) {
      logger.error('Statement import failed', err);
      setParseError(`Import failed: ${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  }, [accountId, matchResults, counts, fileName, onImported, onClose]);

  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div style={modalShell(780)} onClick={e => e.stopPropagation()}>
        <AccentStripe />
        <ModalHeader
          icon={<Upload size={19} color="#fff" />}
          title="Import Bank Statement"
          subtitle={`${selAccount?.name || 'Bank account'} · CSV dedupe & auto-match`}
          onClose={onClose}
        />
        <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
            <div>
              <label style={labelStyle}>Bank Account <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <select
                value={accountId}
                onChange={(e) => { setAccountId(e.target.value); setParsedRows([]); setFileName(''); setParseError(null); }}
                style={selectStyle}
              >
                {activeAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>CSV File <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
              <label style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', borderStyle: 'dashed', color: fileName ? ink : inkSoft }}>
                <Upload size={14} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName || 'Choose CSV file…'}</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                />
              </label>
            </div>
          </div>

          {parseError && (
            <div style={{ padding: '10px 14px', borderRadius: 9, background: '#fdeeee', border: `1px solid ${danger}`, color: danger, fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <AlertCircle size={14} /> {parseError}
            </div>
          )}

          {parsedRows.length > 0 && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
                <Stat label="Total Rows" value={matchResults.length} />
                <Stat label="Matched" value={counts.matched + counts.duplicate} tone="positive" />
                <Stat label="Duplicates (skipped)" value={counts.duplicate} tone="neutral" />
                <Stat label="Unmatched (review)" value={counts.unmatched} tone={counts.unmatched > 0 ? 'danger' : 'neutral'} />
              </div>

              <div style={{ border: `1.4px solid ${hairline}`, borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
                <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                      <tr style={tableHeadRow}>
                        <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>Date</th>
                        <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>Description</th>
                        <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>Reference</th>
                        <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700 }}>Amount</th>
                        <th style={{ padding: '10px 14px', textAlign: 'center', fontWeight: 700 }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matchResults.map((m) => (
                        <tr key={m.row.rowIndex}
                          style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                          onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <td style={{ padding: '10px 14px', color: ink, whiteSpace: 'nowrap' }}>{m.row.date}</td>
                          <td style={{ padding: '10px 14px', fontWeight: 600, color: ink }}>{m.row.description}</td>
                          <td style={{ padding: '10px 14px', color: inkSoft, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{m.row.reference || '—'}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', color: m.row.amount >= 0 ? teal[700] : danger }}>
                            {m.row.amount >= 0 ? '+' : '−'}{currency} {Math.abs(m.row.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                            <span style={{
                              padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                              background: m.status === 'matched' ? teal[50] : m.status === 'duplicate' ? amber[100] : '#fdeeee',
                              color: m.status === 'matched' ? teal[700] : m.status === 'duplicate' ? amber[600] : danger,
                            }}>
                              {m.status === 'matched' ? '✓ Matched' : m.status === 'duplicate' ? '= Duplicate' : '! Unmatched'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ padding: '10px 14px', borderRadius: 9, background: teal[50], border: `1px solid ${teal[100]}`, fontSize: 12, color: ink, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <FileText size={14} style={{ color: teal[700], flexShrink: 0 }} />
                <span>Importing marks matched/duplicate ERP transactions as <strong>cleared</strong>. Unmatched rows are saved for review — use “New Transaction” to create them.</span>
              </div>
            </>
          )}

          {parsedRows.length === 0 && !parseError && (
            <EmptyState icon={<Upload size={32} />} title="No file parsed yet" hint="Choose a CSV with columns: date, description, reference, amount (or debit + credit)." />
          )}
        </div>
        <ModalFooter
          stepLabel={`Import · ${parsedRows.length} rows`}
          onCancel={onClose}
          submitLabel={importing ? 'Importing…' : 'Confirm Import'}
          onSubmit={importNow}
        />
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: number; tone?: 'positive' | 'danger' | 'neutral' }> = ({ label, value, tone = 'neutral' }) => {
  const bg = tone === 'positive' ? teal[50] : tone === 'danger' ? '#fdeeee' : teal[50];
  const fg = tone === 'positive' ? teal[700] : tone === 'danger' ? danger : ink;
  const bar = tone === 'positive' ? teal[500] : tone === 'danger' ? danger : hairline;
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, background: paper, border: `1.4px solid ${hairline}`, borderLeft: `4px solid ${bar}` }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: fg, marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
    </div>
  );
};

export default StatementImportModal;
