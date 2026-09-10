import React, { useState } from 'react';
import { X, Calendar, Filter, Eye, Printer, Download, Clock, TrendingUp, Scale, Activity, Target, CheckCircle2, History } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useFinance } from '../context/FinanceContext';
import { useProcurement } from '../context/ProcurementContext';
import { useDocumentStore } from '../stores/documentStore';
import { calculateAccountBalances, getAgedData } from '../services/reportService';
import { computeTrialBalance, getCanonicalAccountType } from '../services/accountingEngine';
import { format, parseISO, startOfYear, endOfYear, startOfMonth, endOfMonth } from 'date-fns';
import { currencyService } from '../services/currencyService';
import {
  modalOverlay, modalCard, accentBar, modalHeader, iconBox, modalTitle, modalSubtitle, closeBtn,
  labelStyle, inputStyle, selectStyle, btnGhostStyle, tealBtn, modalBody, modalFooter, sectionTitle, sectionSubtitle, formGrid,
  inkSoft, hairline, paper, teal, ink
} from '../views/reports/reportModalStyles';

interface ReportOptionsModalProps {
    isOpen: boolean;
    onClose: () => void;
    reportType: 'IncomeStatement' | 'BalanceSheet' | 'CashFlow' | 'EquityStatement' | 'TrialBalance' | 'Budget' | 'AgedAR' | 'AgedAP';
    reportLabel: string;
}

const ReportOptionsModal: React.FC<ReportOptionsModalProps> = ({ isOpen, onClose, reportType, reportLabel }) => {
    const { accounts, ledger, budgets, invoices } = useFinance();
    const { purchases } = useProcurement();
    const { companyConfig, notify } = useAuth();
    const { safeOpenPreview } = useDocumentStore();
    const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

    const [dateRange, setDateRange] = useState({
        start: startOfYear(new Date()).toISOString().split('T')[0],
        end: endOfYear(new Date()).toISOString().split('T')[0]
    });
    const [compareWithPrevious, setCompareWithPrevious] = useState(false);

    if (!isOpen) return null;

    const handlePreview = () => {
        const balances = calculateAccountBalances(accounts, ledger, dateRange, compareWithPrevious);

        let reportData: any = {
            reportName: reportLabel,
            period: `${format(parseISO(dateRange.start), 'MMMM d, yyyy')} - ${format(parseISO(dateRange.end), 'MMMM d, yyyy')}`,
            currency,
            sections: []
        };

        // Canonical display-type resolution: synced accounts may carry the
        // uppercase account_type as source of truth with a stale/missing type.
        const displayTypeOf = (a: any): string => {
            const legacy = String(a?.type || '').trim();
            if (['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].includes(legacy)) return legacy;
            const canonical = getCanonicalAccountType(a);
            if (canonical === 'ASSET') return 'Asset';
            if (canonical === 'LIABILITY') return 'Liability';
            if (canonical === 'EQUITY') return 'Equity';
            if (canonical === 'INCOME') return 'Revenue';
            return 'Expense';
        };

        const getAccountRows = (types: string[]) => {
            return (accounts || [])
                .filter(a => types.includes(displayTypeOf(a)))
                .map(a => ({
                    label: a.name,
                    subText: a.code,
                    amount: balances.current[a.id] || 0,
                    prevAmount: balances.previous[a.id] || 0
                }))
                .filter(a => Math.abs(a.amount) > 0.001 || Math.abs(a.prevAmount) > 0.001)
                .sort((a, b) => a.subText.localeCompare(b.subText));
        };

        if (reportType === 'IncomeStatement') {
            const revenue = getAccountRows(['Revenue']);
            const expenses = getAccountRows(['Expense']);
            const totalRev = revenue.reduce((s, a) => s + a.amount, 0);
            const totalExp = expenses.reduce((s, a) => s + a.amount, 0);
            const prevTotalRev = revenue.reduce((s, a) => s + (a.prevAmount || 0), 0);
            const prevTotalExp = expenses.reduce((s, a) => s + (a.prevAmount || 0), 0);

            reportData.sections = [
                { title: 'Operating Revenue', rows: [...revenue, { label: 'Total Revenue', amount: totalRev, prevAmount: prevTotalRev, isTotal: true }] },
                { title: 'Operating Expenses', rows: [...expenses, { label: 'Total Expenses', amount: totalExp, prevAmount: prevTotalExp, isTotal: true }] }
            ];
            reportData.netPerformance = { label: 'Net Profit / (Loss)', amount: totalRev - totalExp, prevAmount: prevTotalRev - prevTotalExp };
        }
        else if (reportType === 'BalanceSheet') {
            const assets = getAccountRows(['Asset']);
            const liabilities = getAccountRows(['Liability']);
            const equity = getAccountRows(['Equity']);

            const totalAssets = assets.reduce((s, a) => s + a.amount, 0);
            const prevTotalAssets = assets.reduce((s, a) => s + (a.prevAmount || 0), 0);

            const revenue = getAccountRows(['Revenue']);
            const expenses = getAccountRows(['Expense']);
            const netIncome = revenue.reduce((s, a) => s + a.amount, 0) - expenses.reduce((s, a) => s + a.amount, 0);
            const prevNetIncome = revenue.reduce((s, a) => s + (a.prevAmount || 0), 0) - expenses.reduce((s, a) => s + (a.prevAmount || 0), 0);

            const totalLiaEqu = liabilities.reduce((s, a) => s + a.amount, 0) + equity.reduce((s, a) => s + a.amount, 0) + netIncome;
            const prevTotalLiaEqu = liabilities.reduce((s, a) => s + (a.prevAmount || 0), 0) + equity.reduce((s, a) => s + (a.prevAmount || 0), 0) + prevNetIncome;

            reportData.sections = [
                { title: 'Assets', rows: [...assets, { label: 'Total Assets', amount: totalAssets, prevAmount: prevTotalAssets, isTotal: true }] },
                {
                    title: 'Liabilities & Equity',
                    rows: [
                        ...liabilities,
                        ...equity,
                        { label: 'Net Profit / (Loss) for Period', amount: netIncome, prevAmount: prevNetIncome },
                        { label: 'Total Liabilities & Equity', amount: totalLiaEqu, prevAmount: prevTotalLiaEqu, isTotal: true }
                    ]
                }
            ];
        }
        else if (reportType === 'TrialBalance') {
            // Canonical trial balance: gross posted debits/credits per
            // account as of the report end date. Per-account asymmetry is
            // normal and never "out of balance" by itself.
            const trial = computeTrialBalance((accounts || []) as any[], (ledger || []) as any[], {
                asOfDate: dateRange.end
            });
            const debits = trial.lines
                .filter(l => l.totalDebit > 0)
                .map(l => ({ label: l.accountName, subText: l.accountCode, amount: l.totalDebit }));
            const credits = trial.lines
                .filter(l => l.totalCredit > 0)
                .map(l => ({ label: l.accountName, subText: l.accountCode, amount: l.totalCredit }));

            reportData.sections = [
                { title: 'Debit Balances', rows: debits },
                { title: 'Credit Balances', rows: credits }
            ];
            reportData.netPerformance = {
                label: trial.isBalanced
                    ? 'Trial Balance Totals (Debit / Credit) — BALANCED'
                    : 'Trial Balance Totals (Debit / Credit) — OUT OF BALANCE',
                amount: trial.totalDebits,
                prevAmount: trial.totalCredits
            };
        }
        else if (reportType === 'AgedAR' || reportType === 'AgedAP') {
            const aged = getAgedData(invoices, purchases);
            const data = reportType === 'AgedAR' ? aged.ar : aged.ap;

            reportData.sections = [
                {
                    title: 'Aging Summary',
                    rows: Object.entries(data.buckets).map(([bucket, amount]) => ({ label: `${bucket} Days`, amount: amount as number }))
                },
                {
                    title: 'Top Outstanding Items',
                    rows: data.items.sort((a: any, b: any) => b.balance - a.balance).slice(0, 10).map((i: any) => ({
                        label: i.customerName || i.supplierId || 'Unknown',
                        subText: `Due: ${format(parseISO(i.date), 'MMM d, yyyy')}`,
                        amount: i.balance
                    }))
                }
            ];
        }
        else if (reportType === 'Budget') {
            const start = parseISO(dateRange.start);
            const end = parseISO(dateRange.end);
            const activeBudgets = (budgets || []).filter(b => {
                const bDate = parseISO(`${b.month}-01`);
                return (bDate >= start || b.month === format(start, 'yyyy-MM')) &&
                    (bDate <= end || b.month === format(end, 'yyyy-MM'));
            });

            const items = (accounts || [])
                .filter(a => displayTypeOf(a) === 'Revenue' || displayTypeOf(a) === 'Expense')
                .map(acc => {
                    const actual = balances.current[acc.id] || 0;
                    const budgetAmount = activeBudgets
                        .filter(b => b.accountId === acc.id)
                        .reduce((sum, b) => sum + b.amount, 0);
                    return { label: acc.name, subText: acc.code, amount: actual, prevAmount: budgetAmount };
                })
                .filter(item => Math.abs(item.amount) > 0 || Math.abs(item.prevAmount) > 0);

            reportData.sections = [{ title: 'Budget vs Actual Performance', rows: items }];
        }
        else if (reportType === 'CashFlow') {
            const revenue = getAccountRows(['Revenue']);
            const expenses = getAccountRows(['Expense']);
            const totalRev = revenue.reduce((s, a) => s + a.amount, 0);
            const totalExp = expenses.reduce((s, a) => s + a.amount, 0);

            reportData.sections = [
                { title: 'Operating Activities (Inflow)', rows: revenue },
                { title: 'Operating Activities (Outflow)', rows: expenses.map(e => ({ ...e, amount: -e.amount })) }
            ];
            reportData.netPerformance = { label: 'Net Cash Flow from Operations', amount: totalRev - totalExp };
        }

        const result = safeOpenPreview('FISCAL_REPORT', reportData);
        if (result.success) {
            onClose();
        } else {
            notify(result.error || "Failed to generate preview", "error");
        }
    };

    return (
        <div style={modalOverlay} onClick={onClose}>
            <div style={{ ...modalCard, width: 560 }} onClick={(e) => e.stopPropagation()}>
                <div style={accentBar} />
                <div style={modalHeader}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <div style={iconBox}><Calendar size={19} color="#fff" /></div>
                        <div>
                            <h1 style={modalTitle}>{reportLabel}</h1>
                            <p style={modalSubtitle}>Configure report period and generation options</p>
                        </div>
                    </div>
                    <button onClick={onClose} aria-label="Close" style={closeBtn}
                        onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; }}
                        onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                    ><X size={15} /></button>
                </div>
                <div style={modalBody}>
                    <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>Start Date</label>
                        <div style={{ position: 'relative' }}>
                            <Calendar size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
                            <input
                                type="date"
                                value={dateRange.start}
                                onChange={e => setDateRange(prev => ({ ...prev, start: e.target.value }))}
                                style={{ ...inputStyle, paddingLeft: 36 }}
                                onFocus={e => { e.currentTarget.style.borderColor = teal[400]; e.currentTarget.style.background = teal[50]; }}
                                onBlur={e => { e.currentTarget.style.borderColor = hairline; e.currentTarget.style.background = paper; }}
                            />
                        </div>
                    </div>

                    <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>End Date</label>
                        <div style={{ position: 'relative' }}>
                            <Calendar size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
                            <input
                                type="date"
                                value={dateRange.end}
                                onChange={e => setDateRange(prev => ({ ...prev, end: e.target.value }))}
                                style={{ ...inputStyle, paddingLeft: 36 }}
                                onFocus={e => { e.currentTarget.style.borderColor = teal[400]; e.currentTarget.style.background = teal[50]; }}
                                onBlur={e => { e.currentTarget.style.borderColor = hairline; e.currentTarget.style.background = paper; }}
                            />
                        </div>
                    </div>

                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 24 }}>
                        {[
                            { label: 'This Year', start: startOfYear(new Date()), end: endOfYear(new Date()) },
                            { label: 'This Month', start: startOfMonth(new Date()), end: endOfMonth(new Date()) },
                            { label: 'Q1', start: new Date(new Date().getFullYear(), 0, 1), end: new Date(new Date().getFullYear(), 2, 31) },
                            { label: `FY ${new Date().getFullYear()}`, start: new Date(new Date().getFullYear(), 0, 1), end: new Date(new Date().getFullYear(), 11, 31) }
                        ].map(opt => (
                            <button
                                key={opt.label}
                                onClick={() => setDateRange({ start: opt.start.toISOString().split('T')[0], end: opt.end.toISOString().split('T')[0] })}
                                style={{
                                    padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                                    border: `1.4px solid ${hairline}`, background: paper, color: inkSoft,
                                    cursor: 'pointer', transition: 'all .12s', fontFamily: "'Inter', sans-serif"
                                }}
                                onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.borderColor = teal[200]; e.currentTarget.style.color = teal[700]; }}
                                onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.borderColor = hairline; e.currentTarget.style.color = inkSoft; }}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>

                    <div style={{ marginBottom: 18 }}>
                        <button
                            onClick={() => setCompareWithPrevious(!compareWithPrevious)}
                            style={{
                                width: '100%', padding: 16, borderRadius: 12, border: `1.4px solid ${compareWithPrevious ? teal[200] : hairline}`,
                                background: compareWithPrevious ? teal[50] : paper, cursor: 'pointer', transition: 'all .15s',
                                display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: "'Inter', sans-serif"
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <div style={{
                                    width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    background: compareWithPrevious ? teal[600] : teal[50], color: compareWithPrevious ? '#fff' : inkSoft,
                                    transition: 'all .15s'
                                }}>
                                    <Activity size={20} />
                                </div>
                                <div style={{ textAlign: 'left' }}>
                                    <p style={{ fontSize: 13, fontWeight: 700, color: ink, margin: 0 }}>Compare with Previous Period</p>
                                    <p style={{ fontSize: 11, color: inkSoft, margin: '2px 0 0' }}>Enable side-by-side comparison</p>
                                </div>
                            </div>
                            <div style={{
                                width: 44, height: 24, borderRadius: 12, position: 'relative', transition: 'all .15s',
                                background: compareWithPrevious ? teal[600] : hairline
                            }}>
                                <div style={{
                                    position: 'absolute', top: 2, width: 20, height: 20, borderRadius: '50%', background: '#fff',
                                    left: compareWithPrevious ? 22 : 2, transition: 'all .15s', boxShadow: '0 1px 3px rgba(0,0,0,.15)'
                                }} />
                            </div>
                        </button>
                    </div>
                </div>
                <div style={modalFooter}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: inkSoft, fontSize: 11, fontWeight: 600 }}>
                        <Filter size={14} />
                        <span>{dateRange.start} — {dateRange.end}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button type="button" onClick={onClose} style={btnGhostStyle}>Cancel</button>
                        <button type="button" onClick={handlePreview} style={tealBtn}>
                            <Eye size={14} />
                            Generate Preview
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ReportOptionsModal;
