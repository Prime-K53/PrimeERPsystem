import React, { useState, useEffect, useMemo } from 'react';
import {
    Plus, Search, Download, Calendar, X,
    Loader2, TrendingUp, TrendingDown, CheckCircle, AlertTriangle, FileText
} from 'lucide-react';
import { incomeSummaryService } from '../../services/incomeSummaryService';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { IncomeSummaryEntry } from '../../types';
import { formatCurrency } from '../../utils/helpers';

const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const assets = '#1f8577';
const danger = '#dc2626';

const YearEndClosing: React.FC = () => {
    const { user, companyConfig, checkPermission, notify } = useAuth();
    const { accounts, refreshAccounts } = useFinance();

    const [isLoading, setIsLoading] = useState(true);
    const [closingHistory, setClosingHistory] = useState<IncomeSummaryEntry[]>([]);
    const [isClosingModalOpen, setIsClosingModalOpen] = useState(false);
    const [closingResult, setClosingResult] = useState<any>(null);
    const [closingInProgress, setClosingInProgress] = useState(false);

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
                return <TrendingUp size={14} style={{ color: assets }} />;
            case 'expense':
                return <TrendingDown size={14} style={{ color: danger }} />;
            case 'net_profit':
                return <CheckCircle size={14} style={{ color: assets }} />;
            case 'net_loss':
                return <AlertTriangle size={14} style={{ color: danger }} />;
            default:
                return <FileText size={14} style={{ color: inkSoft }} />;
        }
    };

    return (
        <div className="flex flex-col h-full" style={{ background: paper }}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                <div>
                    <h1 className="text-lg font-semibold" style={{ color: ink }}>Year-End Closing</h1>
                    <p className="text-sm" style={{ color: inkSoft }}>Close income and expense accounts, transfer to retained earnings</p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        onClick={exportToCSV}
                        className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg border transition-colors"
                        style={{ borderColor: hairline, color: ink }}
                    >
                        <Download size={16} />
                        Export
                    </button>
                    {canEdit && (
                        <button
                            onClick={() => setIsClosingModalOpen(true)}
                            className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg text-white transition-colors"
                            style={{ background: assets }}
                            disabled={closingInProgress}
                        >
                            {closingInProgress ? (
                                <Loader2 size={16} className="animate-spin" />
                            ) : (
                                <Calendar size={16} />
                            )}
                            Close Year
                        </button>
                    )}
                </div>
            </div>

            {/* Instructions */}
            <div className="px-6 py-4 border-b" style={{ borderColor: hairline }}>
                <div className="p-4 rounded-lg" style={{ background: '#f3f4f6' }}>
                    <h3 className="font-medium mb-2" style={{ color: ink }}>Year-End Closing Process</h3>
                    <ol className="text-sm space-y-1" style={{ color: inkSoft }}>
                        <li>1. All income accounts are closed to Current Year Earnings (33000)</li>
                        <li>2. All expense accounts are closed to Current Year Earnings (33000)</li>
                        <li>3. Net Profit/Loss is transferred to Retained Earnings (32000)</li>
                        <li className="font-medium" style={{ color: danger }}>This action is irreversible. Ensure all transactions are recorded before closing.</li>
                    </ol>
                </div>
            </div>

            {/* Closing History */}
            <div className="flex-1 overflow-auto px-6 py-4">
                {isLoading ? (
                    <div className="flex items-center justify-center h-64">
                        <Loader2 size={24} className="animate-spin" style={{ color: assets }} />
                    </div>
                ) : Object.keys(groupedByYear).length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64" style={{ color: inkSoft }}>
                        <Calendar size={48} className="mb-4 opacity-50" />
                        <p>No closing entries found</p>
                        <p className="text-sm mt-2">Process year-end closing to create entries</p>
                    </div>
                ) : (
                    <div className="space-y-6">
                        {fiscalYears.map(year => (
                            <div key={year}>
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="font-semibold text-lg" style={{ color: ink }}>Fiscal Year {year}</h3>
                                    {!groupedByYear[year] && canEdit && (
                                        <button
                                            onClick={() => handleCloseYear(year)}
                                            className="px-3 py-1.5 text-sm rounded-lg text-white transition-colors"
                                            style={{ background: assets }}
                                            disabled={closingInProgress}
                                        >
                                            Close {year}
                                        </button>
                                    )}
                                </div>
                                {groupedByYear[year] && (
                                    <div className="rounded-lg border overflow-hidden" style={{ borderColor: hairline }}>
                                        <table className="w-full">
                                            <thead>
                                                <tr className="text-left text-xs" style={{ background: '#f3f4f6', color: inkSoft }}>
                                                    <th className="px-4 py-2 font-medium">Type</th>
                                                    <th className="px-4 py-2 font-medium">Account</th>
                                                    <th className="px-4 py-2 font-medium text-right">Amount</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {groupedByYear[year].map((entry, idx) => (
                                                    <tr key={idx} className="border-t" style={{ borderColor: hairline }}>
                                                        <td className="px-4 py-3">
                                                            <div className="flex items-center gap-2">
                                                                {getClosingTypeIcon(entry.closing_type)}
                                                                <span className="text-sm capitalize" style={{ color: ink }}>
                                                                    {entry.closing_type.replace('_', ' ')}
                                                                </span>
                                                            </div>
                                                        </td>
                                                        <td className="px-4 py-3 text-sm" style={{ color: ink }}>
                                                            {entry.account_name}
                                                        </td>
                                                        <td className="px-4 py-3 text-sm text-right font-mono" style={{ color: ink }}>
                                                            {formatCurrency(entry.amount)}
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
}

const ClosingResultModal: React.FC<ClosingResultModalProps> = ({ result, onClose }) => {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-md mx-4 shadow-xl">
                <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Year-End Closing Complete</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <div className="p-6 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                            <p className="text-sm" style={{ color: inkSoft }}>Total Income Closed</p>
                            <p className="text-lg font-semibold" style={{ color: assets }}>
                                {formatCurrency(result.incomeResult?.totalIncome || 0)}
                            </p>
                        </div>
                        <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                            <p className="text-sm" style={{ color: inkSoft }}>Total Expenses Closed</p>
                            <p className="text-lg font-semibold" style={{ color: danger }}>
                                {formatCurrency(result.expenseResult?.totalExpenses || 0)}
                            </p>
                        </div>
                    </div>
                    <div className="p-4 rounded-lg border" style={{ borderColor: hairline, background: result.netProfit > 0 ? '#d1fae5' : '#fee2e2' }}>
                        <p className="text-sm" style={{ color: result.netProfit > 0 ? '#065f46' : '#991b1b' }}>
                            {result.netProfit > 0 ? 'Net Profit' : 'Net Loss'}
                        </p>
                        <p className="text-2xl font-bold" style={{ color: result.netProfit > 0 ? assets : danger }}>
                            {formatCurrency(result.netProfit || result.netLoss)}
                        </p>
                    </div>
                    <div className="space-y-2">
                        <p className="text-sm" style={{ color: inkSoft }}>
                            Accounts closed: {result.incomeResult?.entriesClosed || 0} income, {result.expenseResult?.entriesClosed || 0} expense
                        </p>
                        <p className="text-sm" style={{ color: inkSoft }}>
                            Retained earnings entry: {result.retainedEarningsResult ? 'Created' : 'N/A'}
                        </p>
                    </div>
                    <div className="flex justify-end pt-4">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm rounded-lg text-white"
                            style={{ background: assets }}
                        >
                            Done
                        </button>
                    </div>
                </div>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-sm mx-4 shadow-xl">
                <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Select Fiscal Year to Close</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <div className="p-6 space-y-3">
                    {availableYears.map(year => (
                        <button
                            key={year}
                            onClick={() => onSelectYear(year)}
                            disabled={isProcessing}
                            className="w-full flex items-center justify-between p-4 rounded-lg border transition-colors hover:border-gray-400"
                            style={{ borderColor: hairline }}
                        >
                            <span className="font-medium" style={{ color: ink }}>Fiscal Year {year}</span>
                            <Calendar size={16} style={{ color: inkSoft }} />
                        </button>
                    ))}
                    <div className="flex justify-end pt-4">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm rounded-lg border"
                            style={{ borderColor: hairline, color: ink }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default YearEndClosing;
