import React, { useState, useEffect, useMemo } from 'react';
import {
    Download, Calendar, CalendarCheck, Loader2, TrendingUp, TrendingDown,
    CheckCircle, AlertTriangle, FileText, Landmark, RefreshCw, Package,
} from 'lucide-react';
import { incomeSummaryService } from '../../services/incomeSummaryService';
import { checkBankingYearEnd, BankingYearEndReport } from '../../services/bankingYearEndService';
import { checkFixedAssetYearEnd, FixedAssetYearEndReport } from '../../services/fixedAssetYearEndService';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { IncomeSummaryEntry } from '../../types';
import { formatCurrency } from '../../utils/helpers';
import { currencyService } from '../../services/currencyService';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    btnGhostStyle, btnPrimaryStyle, btnDangerStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
    PageHeader, KpiCards, GhostButton, PrimaryButton, EmptyState,
    tableCard, tableHeadRow,
} from './components/financeChrome';

const YearEndClosing: React.FC = () => {
    const { user, companyConfig, checkPermission, notify } = useAuth();
    const { accounts, refreshAccounts } = useFinance();
    const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

    const [isLoading, setIsLoading] = useState(true);
    const [closingHistory, setClosingHistory] = useState<IncomeSummaryEntry[]>([]);
    const [isClosingModalOpen, setIsClosingModalOpen] = useState(false);
    const [closingResult, setClosingResult] = useState<any>(null);
    const [closingInProgress, setClosingInProgress] = useState(false);
    const [bankingReport, setBankingReport] = useState<BankingYearEndReport | null>(null);
    const [bankingReportLoading, setBankingReportLoading] = useState(false);
    const [selectedFyForBanking, setSelectedFyForBanking] = useState<number>(new Date().getFullYear());
    const [faReport, setFaReport] = useState<FixedAssetYearEndReport | null>(null);
    const [faReportLoading, setFaReportLoading] = useState(false);
    const [selectedFyForFA, setSelectedFyForFA] = useState<number>(new Date().getFullYear());

    const canEdit = checkPermission('accounts.edit');

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setIsLoading(true);
        try {
            await incomeSummaryService.initializeStore();
            const history = await incomeSummaryService.getClosingHistory();
            setClosingHistory(history);
        } catch (error) {
            notify('Failed to load closing history', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    const loadBankingReport = async (fy: number) => {
        setBankingReportLoading(true);
        try {
            const report = await checkBankingYearEnd(fy);
            setBankingReport(report);
        } catch (err) {
            notify('Failed to load banking year-end report', 'error');
        } finally {
            setBankingReportLoading(false);
        }
    };

    const loadFAReport = async (fy: number) => {
        setFaReportLoading(true);
        try {
            const report = await checkFixedAssetYearEnd(fy);
            setFaReport(report);
        } catch (err) {
            notify('Failed to load fixed-asset year-end report', 'error');
        } finally {
            setFaReportLoading(false);
        }
    };

    useEffect(() => { loadBankingReport(selectedFyForBanking); }, [selectedFyForBanking]);
    useEffect(() => { loadFAReport(selectedFyForFA); }, [selectedFyForFA]);

    const fiscalYears = useMemo(() => {
        const years = new Set<number>();
        years.add(new Date().getFullYear());
        years.add(new Date().getFullYear() - 1);
        years.add(new Date().getFullYear() - 2);
        closingHistory.forEach(entry => years.add(entry.fiscal_year));
        return Array.from(years).sort((a, b) => b - a);
    }, [closingHistory]);

    const groupedByYear = useMemo(() => {
        const grouped: Record<number, IncomeSummaryEntry[]> = {};
        for (const entry of closingHistory) {
            if (!grouped[entry.fiscal_year]) {
                grouped[entry.fiscal_year] = [];
            }
            grouped[entry.fiscal_year].push(entry);
        }
        return grouped;
    }, [closingHistory]);

    const handleCloseYear = async (fiscalYear: number) => {
        setClosingInProgress(true);
        try {
            const result = await incomeSummaryService.closeYear(fiscalYear, accounts);
            setClosingResult(result);
            setIsClosingModalOpen(true);
            await loadData();
            refreshAccounts();
            notify(`Year ${fiscalYear} closed successfully`, 'success');
        } catch (error: any) {
            notify(error.message || 'Failed to close year', 'error');
        } finally {
            setClosingInProgress(false);
        }
    };

    const exportToCSV = () => {
        const headers = ['Fiscal Year', 'Account', 'Type', 'Amount'];
        const rows = closingHistory.map(entry => [
            entry.fiscal_year.toString(),
            entry.account_name,
            entry.closing_type,
            entry.amount.toFixed(2),
        ]);

        const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `closing_history_${new Date().getFullYear()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const getClosingTypeIcon = (type: string) => {
        switch (type) {
            case 'income':
                return <TrendingUp size={14} style={{ color: teal[600] }} />;
            case 'expense':
                return <TrendingDown size={14} style={{ color: danger }} />;
            case 'net_profit':
                return <CheckCircle size={14} style={{ color: teal[600] }} />;
            case 'net_loss':
                return <AlertTriangle size={14} style={{ color: danger }} />;
            default:
                return <FileText size={14} style={{ color: inkSoft }} />;
        }
    };

    return (
        <div className="flex flex-col h-full" style={{ background: paper, fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink }}>
            <PageHeader
                icon={<CalendarCheck size={19} color="#fff" />}
                title="Year-End Closing"
                subtitle="Close income and expense accounts, transfer to retained earnings"
                actions={
                    <>
                        <button
                            onClick={exportToCSV}
                            style={btnGhostStyle}
                            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                        >
                            <Download size={15} />
                            Export
                        </button>
                        {canEdit && (
                            <button
                                onClick={() => setIsClosingModalOpen(true)}
                                style={{ ...btnPrimaryStyle, opacity: closingInProgress ? 0.65 : 1, cursor: closingInProgress ? 'not-allowed' : 'pointer' }}
                                disabled={closingInProgress}
                                onMouseEnter={e => { if (!closingInProgress) e.currentTarget.style.transform = 'translateY(-1px)'; }}
                                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
                            >
                                {closingInProgress ? (
                                    <Loader2 size={15} className="animate-spin" />
                                ) : (
                                    <Calendar size={15} />
                                )}
                                Close Year
                            </button>
                        )}
                    </>
                }
            />

            {/* Instructions */}
            <div style={{ padding: '18px 28px 0' }}>
                <div style={{
                    padding: 16, background: amber[100], borderRadius: 9, border: `1px solid ${amber[300]}`,
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <div style={{ padding: 8, borderRadius: 8, background: paper, color: amber[600] }}>
                            <AlertTriangle size={18} />
                        </div>
                        <h3 style={{ fontSize: 13, fontWeight: 700, color: ink, margin: 0 }}>Year-End Closing Process</h3>
                    </div>
                    <ol style={{ fontSize: 12.5, margin: 0, paddingLeft: 18, color: inkSoft, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <li>All income accounts are closed to Current Year Earnings (33000)</li>
                        <li>All expense accounts are closed to Current Year Earnings (33000)</li>
                        <li>Net Profit/Loss is transferred to Retained Earnings (32000)</li>
                        <li style={{ fontWeight: 600, color: danger }}>This action is irreversible. Ensure all transactions are recorded before closing.</li>
                    </ol>
                </div>
            </div>

            {/* Banking Reconciliation Status */}
            <div style={{ padding: '18px 28px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ padding: 8, borderRadius: 8, background: teal[50], color: teal[600] }}>
                            <Landmark size={16} />
                        </div>
                        <h3 style={{ fontSize: 13, fontWeight: 700, color: teal[800], margin: 0 }}>Banking Reconciliation Status — FY {selectedFyForBanking}</h3>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <select
                            value={selectedFyForBanking}
                            onChange={(e) => setSelectedFyForBanking(parseInt(e.target.value, 10))}
                            style={{ ...selectStyle, width: 110, padding: '7px 30px 7px 12px' }}
                        >
                            {[selectedFyForBanking, selectedFyForBanking - 1, selectedFyForBanking - 2].map((y) => (
                                <option key={y} value={y}>{y}</option>
                            ))}
                        </select>
                        <button
                            onClick={() => loadBankingReport(selectedFyForBanking)}
                            disabled={bankingReportLoading}
                            style={btnGhostStyle}
                            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                        >
                            {bankingReportLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                            Refresh
                        </button>
                    </div>
                </div>

                {bankingReportLoading && !bankingReport ? (
                    <div style={{ fontSize: 13, color: inkSoft }}>Checking banking accounts…</div>
                ) : bankingReport ? (
                    <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
                            <div style={{ padding: '12px 14px', borderRadius: 12, background: paper, border: `1.4px solid ${hairline}` }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 6 }}>Active Accounts</div>
                                <div style={{ fontSize: 18, fontWeight: 700, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{bankingReport.summary.activeAccounts}</div>
                            </div>
                            <div style={{ padding: '12px 14px', borderRadius: 12, background: paper, border: `1.4px solid ${hairline}` }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 6 }}>Unreconciled</div>
                                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: bankingReport.summary.unreconciledCount > 0 ? danger : teal[600] }}>{bankingReport.summary.unreconciledCount}</div>
                            </div>
                            <div style={{ padding: '12px 14px', borderRadius: 12, background: paper, border: `1.4px solid ${hairline}` }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 6 }}>Drafts</div>
                                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: bankingReport.summary.draftCount > 0 ? danger : teal[600] }}>{bankingReport.summary.draftCount}</div>
                            </div>
                            <div style={{ padding: '12px 14px', borderRadius: 12, background: paper, border: `1.4px solid ${hairline}` }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 6 }}>Stale Recons</div>
                                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: bankingReport.summary.staleAccounts > 0 ? danger : teal[600] }}>{bankingReport.summary.staleAccounts}</div>
                            </div>
                        </div>

                        {bankingReport.issues.length === 0 ? (
                            <div style={{ padding: 14, borderRadius: 9, border: `1px solid ${teal[100]}`, background: teal[50], color: teal[700], display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 600 }}>
                                <CheckCircle size={16} /> Banking reconciliation is complete for FY {selectedFyForBanking}. Safe to close.
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {bankingReport.issues.map((issue, i) => (
                                    <div
                                        key={i}
                                        style={{
                                            padding: 12, borderRadius: 9, border: `1px solid ${hairline}`,
                                            display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13,
                                            background: issue.severity === 'error' ? '#fef2f2' : issue.severity === 'warning' ? amber[100] : teal[50],
                                            color: issue.severity === 'error' ? danger : issue.severity === 'warning' ? amber[600] : ink,
                                            fontWeight: 500,
                                        }}
                                    >
                                        {issue.severity === 'error' ? <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} /> :
                                         issue.severity === 'warning' ? <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} /> :
                                         <FileText size={14} style={{ marginTop: 2, flexShrink: 0 }} />}
                                        <div>{issue.message}</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                ) : null}
            </div>

            {/* Fixed Asset Reconciliation Status */}
            <div style={{ padding: '18px 28px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ padding: 8, borderRadius: 8, background: teal[50], color: teal[600] }}>
                            <Package size={16} />
                        </div>
                        <h3 style={{ fontSize: 13, fontWeight: 700, color: teal[800], margin: 0 }}>Fixed Asset Reconciliation — FY {selectedFyForFA}</h3>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <select
                            value={selectedFyForFA}
                            onChange={(e) => setSelectedFyForFA(parseInt(e.target.value, 10))}
                            style={{ ...selectStyle, width: 110, padding: '7px 30px 7px 12px' }}
                        >
                            {[selectedFyForFA, selectedFyForFA - 1, selectedFyForFA - 2].map((y) => (
                                <option key={y} value={y}>{y}</option>
                            ))}
                        </select>
                        <button
                            onClick={() => loadFAReport(selectedFyForFA)}
                            disabled={faReportLoading}
                            style={btnGhostStyle}
                            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                        >
                            {faReportLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                            Refresh
                        </button>
                    </div>
                </div>

                {faReportLoading && !faReport ? (
                    <div style={{ fontSize: 13, color: inkSoft }}>Checking fixed assets…</div>
                ) : faReport ? (
                    <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
                            <div style={{ padding: '12px 14px', borderRadius: 12, background: paper, border: `1.4px solid ${hairline}` }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 6 }}>Active Assets</div>
                                <div style={{ fontSize: 18, fontWeight: 700, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{faReport.summary.activeAssets}</div>
                            </div>
                            <div style={{ padding: '12px 14px', borderRadius: 12, background: paper, border: `1.4px solid ${hairline}` }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 6 }}>Pending Cap.</div>
                                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: faReport.summary.pendingCapitalisation > 0 ? danger : teal[600] }}>{faReport.summary.pendingCapitalisation}</div>
                            </div>
                            <div style={{ padding: '12px 14px', borderRadius: 12, background: paper, border: `1.4px solid ${hairline}` }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 6 }}>Missing Mapping</div>
                                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: faReport.summary.missingMapping > 0 ? danger : teal[600] }}>{faReport.summary.missingMapping}</div>
                            </div>
                            <div style={{ padding: '12px 14px', borderRadius: 12, background: paper, border: `1.4px solid ${hairline}` }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 6 }}>Dep. Posted</div>
                                <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: faReport.summary.depreciationPosted ? teal[600] : amber[600] }}>{faReport.summary.depreciationPosted ? 'Yes' : 'No'}</div>
                            </div>
                        </div>

                        {faReport.issues.length === 0 ? (
                            <div style={{ padding: 14, borderRadius: 9, border: `1px solid ${teal[100]}`, background: teal[50], color: teal[700], display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, fontWeight: 600 }}>
                                <CheckCircle size={16} /> Fixed asset reconciliation complete for FY {selectedFyForFA}. Safe to close.
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {faReport.issues.map((issue, i) => (
                                    <div
                                        key={i}
                                        style={{
                                            padding: 12, borderRadius: 9, border: `1px solid ${hairline}`,
                                            display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13,
                                            background: issue.severity === 'error' ? '#fef2f2' : issue.severity === 'warning' ? amber[100] : teal[50],
                                            color: issue.severity === 'error' ? danger : issue.severity === 'warning' ? amber[600] : ink,
                                            fontWeight: 500,
                                        }}
                                    >
                                        {issue.severity === 'error' ? <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} /> :
                                         issue.severity === 'warning' ? <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} /> :
                                         <FileText size={14} style={{ marginTop: 2, flexShrink: 0 }} />}
                                        <div>{issue.message}</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                ) : null}
            </div>

            {/* Closing History */}
            <div style={{ flex: 1, overflow: 'auto', padding: '18px 28px 28px' }}>
                {isLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 256 }}>
                        <Loader2 size={24} className="animate-spin" style={{ color: teal[500] }} />
                    </div>
                ) : Object.keys(groupedByYear).length === 0 ? (
                    <EmptyState
                        icon={<Calendar size={32} />}
                        title="No closing entries found"
                        hint="Process year-end closing to create entries."
                    />
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                        {fiscalYears.map(year => (
                            <div key={year}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                                    <h3 style={{ fontSize: 15, fontWeight: 700, color: ink, margin: 0 }}>Fiscal Year {year}</h3>
                                    {!groupedByYear[year] && canEdit && (
                                        <button
                                            onClick={() => handleCloseYear(year)}
                                            style={{ ...btnPrimaryStyle, padding: '7px 14px', fontSize: 12.5 }}
                                            disabled={closingInProgress}
                                            onMouseEnter={e => { if (!closingInProgress) e.currentTarget.style.transform = 'translateY(-1px)'; }}
                                            onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
                                        >
                                            Close {year}
                                        </button>
                                    )}
                                </div>
                                {groupedByYear[year] && (
                                    <div style={tableCard}>
                                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                            <thead>
                                                <tr style={tableHeadRow}>
                                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Type</th>
                                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Account</th>
                                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Amount</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {groupedByYear[year].map((entry, idx) => (
                                                    <tr key={idx}
                                                        style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                                                        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                    >
                                                        <td style={{ padding: '12px 16px' }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                                <div style={{
                                                                    width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                                                                    background: teal[50],
                                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                                }}>
                                                                    {getClosingTypeIcon(entry.closing_type)}
                                                                </div>
                                                                <span style={{ fontSize: 13, color: ink, textTransform: 'capitalize', fontWeight: 500 }}>
                                                                    {entry.closing_type.replace('_', ' ')}
                                                                </span>
                                                            </div>
                                                        </td>
                                                        <td style={{ padding: '12px 16px', fontSize: 13, color: ink }}>
                                                            {entry.account_name}
                                                        </td>
                                                        <td style={{ padding: '12px 16px', fontSize: 13, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: ink, fontVariantNumeric: 'tabular-nums' }}>
                                                            {formatCurrency(entry.amount, currency)}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Closing Result Modal */}
            {closingResult && (
                <ClosingResultModal
                    result={closingResult}
                    onClose={() => { setIsClosingModalOpen(false); setClosingResult(null); }}
                    currency={currency}
                />
            )}

            {/* Close Year Selection Modal */}
            {isClosingModalOpen && !closingResult && canEdit && (
                <SelectYearModal
                    fiscalYears={fiscalYears}
                    onClose={() => setIsClosingModalOpen(false)}
                    onSelectYear={handleCloseYear}
                    isProcessing={closingInProgress}
                />
            )}
        </div>
    );
};

interface ClosingResultModalProps {
    result: any;
    onClose: () => void;
    currency: string;
}

const ClosingResultModal: React.FC<ClosingResultModalProps> = ({ result, onClose, currency }) => {
    return (
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(560)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<CheckCircle size={19} color="#fff" />}
                    title="Year-End Closing Complete"
                    subtitle="Income & expense closed to retained earnings"
                    onClose={onClose}
                />
                <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                        <div style={{ padding: 14, borderRadius: 12, background: paper, border: `1.4px solid ${hairline}` }}>
                            <p style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, margin: '0 0 6px' }}>Total Income Closed</p>
                            <p style={{ fontSize: 18, fontWeight: 700, color: teal[700], margin: 0, fontFamily: "'JetBrains Mono', monospace", letterSpacing: -0.2 }}>
                                {formatCurrency(result.incomeResult?.totalIncome || 0, currency)}
                            </p>
                        </div>
                        <div style={{ padding: 14, borderRadius: 12, background: paper, border: `1.4px solid ${hairline}` }}>
                            <p style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, margin: '0 0 6px' }}>Total Expenses Closed</p>
                            <p style={{ fontSize: 18, fontWeight: 700, color: danger, margin: 0, fontFamily: "'JetBrains Mono', monospace", letterSpacing: -0.2 }}>
                                {formatCurrency(result.expenseResult?.totalExpenses || 0, currency)}
                            </p>
                        </div>
                    </div>
                    <div style={{ padding: 16, borderRadius: 9, border: `1px solid ${hairline}`, background: result.netProfit > 0 ? '#d1fae5' : '#fee2e2', marginBottom: 14 }}>
                        <p style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.08, margin: '0 0 6px', color: result.netProfit > 0 ? '#065f46' : '#991b1b' }}>
                            {result.netProfit > 0 ? 'Net Profit' : 'Net Loss'}
                        </p>
                        <p style={{ fontSize: 22, fontWeight: 800, margin: 0, fontFamily: "'JetBrains Mono', monospace", letterSpacing: -0.2, color: result.netProfit > 0 ? teal[700] : danger }}>
                            {formatCurrency(result.netProfit || result.netLoss, currency)}
                        </p>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 18 }}>
                        <p style={{ fontSize: 12.5, color: inkSoft, margin: 0 }}>
                            Accounts closed: {result.incomeResult?.entriesClosed || 0} income, {result.expenseResult?.entriesClosed || 0} expense
                        </p>
                        <p style={{ fontSize: 12.5, color: inkSoft, margin: 0 }}>
                            Retained earnings entry: {result.retainedEarningsResult ? 'Created' : 'N/A'}
                        </p>
                    </div>
                </div>
                <ModalFooter
                    stepLabel="Close · posted to ledger"
                    onCancel={onClose}
                    submitLabel="Done"
                    onSubmit={onClose}
                />
            </div>
        </div>
    );
};

interface SelectYearModalProps {
    fiscalYears: number[];
    onClose: () => void;
    onSelectYear: (year: number) => void;
    isProcessing: boolean;
}

const SelectYearModal: React.FC<SelectYearModalProps> = ({ fiscalYears, onClose, onSelectYear, isProcessing }) => {
    const currentYear = new Date().getFullYear();
    const availableYears = fiscalYears.includes(currentYear) ? fiscalYears : [currentYear, ...fiscalYears];

    return (
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(480)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<Calendar size={19} color="#fff" />}
                    title="Select Fiscal Year to Close"
                    subtitle="Closing is irreversible — verify all entries"
                    onClose={onClose}
                />
                <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
                        {availableYears.map(year => (
                            <button
                                key={year}
                                onClick={() => onSelectYear(year)}
                                disabled={isProcessing}
                                style={{
                                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: 14, borderRadius: 9, border: `1.4px solid ${hairline}`, background: paper,
                                    cursor: isProcessing ? 'not-allowed' : 'pointer', opacity: isProcessing ? 0.65 : 1,
                                    transition: 'background .12s',
                                }}
                                onMouseEnter={e => { if (!isProcessing) e.currentTarget.style.background = teal[50]; }}
                                onMouseLeave={e => { e.currentTarget.style.background = paper; }}
                            >
                                <span style={{ fontWeight: 600, fontSize: 13.5, color: ink }}>Fiscal Year {year}</span>
                                <Calendar size={16} style={{ color: inkSoft }} />
                            </button>
                        ))}
                    </div>
                    <div style={{
                        padding: 14, background: amber[100], borderRadius: 9, border: `1px solid ${amber[300]}`,
                        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                    }}>
                        <div style={{ padding: 8, borderRadius: 8, background: paper, color: amber[600] }}>
                            <AlertTriangle size={18} />
                        </div>
                        <div style={{ fontSize: 12, color: ink, fontWeight: 500 }}>This action is irreversible. Ensure all transactions are recorded before closing.</div>
                    </div>
                </div>
                <ModalFooter
                    stepLabel="Select · fiscal year"
                    onCancel={onClose}
                    submitLabel="Done"
                    onSubmit={onClose}
                />
            </div>
        </div>
    );
};

export default YearEndClosing;
