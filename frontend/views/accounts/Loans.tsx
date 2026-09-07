import React, { useState, useEffect, useMemo } from 'react';
import {
    Plus, Search, Download, Building2, DollarSign, Calendar,
    X, Loader2, TrendingDown, Percent, FileText
} from 'lucide-react';
import { loanService } from '../../services/loanService';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { Loan, LoanRepayment } from '../../types';
import { formatCurrency, getDefaultDate } from '../../utils/helpers';

const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const assets = '#1f8577';
const danger = '#dc2626';

const Loans: React.FC = () => {
    const { user, companyConfig, checkPermission, notify } = useAuth();
    const { accounts, refreshAccounts } = useFinance();

    const [loans, setLoans] = useState<Loan[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('All');
    const [isAddLoanModalOpen, setIsAddLoanModalOpen] = useState(false);
    const [isRepaymentModalOpen, setIsRepaymentModalOpen] = useState(false);
    const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
    const [summary, setSummary] = useState({ totalOutstanding: 0, totalInterestPaid: 0, activeLoans: 0 });

    const canEdit = checkPermission('accounts.edit');

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setIsLoading(true);
        try {
            await loanService.initializeStores();
            const data = await loanService.getAllLoans();
            const sum = await loanService.getLoanSummary();
            setLoans(data);
            setSummary(sum);
        } catch (error) {
            notify('Failed to load loans', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    const filteredLoans = useMemo(() => {
        return loans.filter(loan => {
            if (statusFilter !== 'All' && loan.status !== statusFilter) return false;
            if (searchTerm) {
                const search = searchTerm.toLowerCase();
                return loan.lender_name.toLowerCase().includes(search) ||
                    loan.loan_type.toLowerCase().includes(search);
            }
            return true;
        });
    }, [loans, searchTerm, statusFilter]);

    const handleAddLoan = async (data: any) => {
        try {
            await loanService.createLoan(data);
            notify('Loan added successfully', 'success');
            setIsAddLoanModalOpen(false);
            loadData();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to add loan', 'error');
        }
    };

    const handleProcessRepayment = async (data: any) => {
        try {
            await loanService.processRepayment(
                data.loanId,
                data.principalAmount,
                data.interestAmount,
                data.repaymentDate,
                data.reference,
                accounts
            );
            notify('Repayment processed successfully', 'success');
            setIsRepaymentModalOpen(false);
            setSelectedLoan(null);
            loadData();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to process repayment', 'error');
        }
    };

    const exportToCSV = () => {
        const headers = ['Lender', 'Type', 'Principal', 'Current Balance', 'Interest Rate', 'Start Date', 'Status'];
        const rows = filteredLoans.map(loan => [
            loan.lender_name,
            loan.loan_type.replace('_', ' '),
            loan.principal_amount.toFixed(2),
            loan.current_balance.toFixed(2),
            `${loan.interest_rate}%`,
            loan.start_date,
            loan.status,
        ]);

        const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `loans_${getDefaultDate()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="flex flex-col h-full" style={{ background: paper }}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                <div>
                    <h1 className="text-lg font-semibold" style={{ color: ink }}>Loans & Borrowings</h1>
                    <p className="text-sm" style={{ color: inkSoft }}>Manage loans, track repayments and interest</p>
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
                            onClick={() => setIsAddLoanModalOpen(true)}
                            className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg text-white transition-colors"
                            style={{ background: assets }}
                        >
                            <Plus size={16} />
                            Add Loan
                        </button>
                    )}
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-3 gap-4 px-6 py-4">
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <DollarSign size={16} style={{ color: inkSoft }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Total Outstanding</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: danger }}>
                        {formatCurrency(summary.totalOutstanding)}
                    </span>
                </div>
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <Percent size={16} style={{ color: inkSoft }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Total Interest Paid</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: ink }}>
                        {formatCurrency(summary.totalInterestPaid)}
                    </span>
                </div>
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <Building2 size={16} style={{ color: inkSoft }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Active Loans</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: ink }}>{summary.activeLoans}</span>
                </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-4 px-6 py-3 border-b" style={{ borderColor: hairline }}>
                <div className="flex-1 relative">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: inkSoft }} />
                    <input
                        type="text"
                        placeholder="Search loans..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 text-sm rounded-lg border outline-none"
                        style={{ borderColor: hairline }}
                    />
                </div>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="px-3 py-2 text-sm rounded-lg border outline-none"
                    style={{ borderColor: hairline }}
                >
                    <option value="All">All Status</option>
                    <option value="active">Active</option>
                    <option value="fully_paid">Fully Paid</option>
                    <option value="defaulted">Defaulted</option>
                </select>
            </div>

            {/* Loans Table */}
            <div className="flex-1 overflow-auto px-6 py-4">
                {isLoading ? (
                    <div className="flex items-center justify-center h-64">
                        <Loader2 size={24} className="animate-spin" style={{ color: assets }} />
                    </div>
                ) : filteredLoans.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64" style={{ color: inkSoft }}>
                        <Building2 size={48} className="mb-4 opacity-50" />
                        <p>No loans found</p>
                    </div>
                ) : (
                    <table className="w-full">
                        <thead>
                            <tr className="text-left text-xs" style={{ color: inkSoft }}>
                                <th className="pb-3 font-medium">Lender</th>
                                <th className="pb-3 font-medium">Type</th>
                                <th className="pb-3 font-medium text-right">Principal</th>
                                <th className="pb-3 font-medium text-right">Balance</th>
                                <th className="pb-3 font-medium text-right">Interest Rate</th>
                                <th className="pb-3 font-medium">Status</th>
                                <th className="pb-3 font-medium text-center">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredLoans.map(loan => (
                                <tr key={loan.id} className="border-t" style={{ borderColor: hairline }}>
                                    <td className="py-3">
                                        <div>
                                            <p className="font-medium text-sm" style={{ color: ink }}>{loan.lender_name}</p>
                                            {loan.account_number && (
                                                <p className="text-xs" style={{ color: inkSoft }}>{loan.account_number}</p>
                                            )}
                                        </div>
                                    </td>
                                    <td className="py-3 text-sm capitalize" style={{ color: ink }}>
                                        {loan.loan_type.replace('_', ' ')}
                                    </td>
                                    <td className="py-3 text-sm text-right font-mono" style={{ color: ink }}>
                                        {formatCurrency(loan.principal_amount)}
                                    </td>
                                    <td className="py-3 text-sm text-right font-mono" style={{ color: loan.current_balance > 0 ? danger : assets }}>
                                        {formatCurrency(loan.current_balance)}
                                    </td>
                                    <td className="py-3 text-sm text-right" style={{ color: ink }}>
                                        {loan.interest_rate}%
                                    </td>
                                    <td className="py-3">
                                        <span
                                            className="px-2 py-1 text-xs rounded-full capitalize"
                                            style={{
                                                background: loan.status === 'active' ? '#d1fae5' : loan.status === 'fully_paid' ? '#dbeafe' : '#fee2e2',
                                                color: loan.status === 'active' ? '#065f46' : loan.status === 'fully_paid' ? '#1e40af' : '#991b1b'
                                            }}
                                        >
                                            {loan.status.replace('_', ' ')}
                                        </span>
                                    </td>
                                    <td className="py-3">
                                        <div className="flex items-center justify-center gap-2">
                                            {loan.status === 'active' && canEdit && (
                                                <button
                                                    onClick={() => {
                                                        setSelectedLoan(loan);
                                                        setIsRepaymentModalOpen(true);
                                                    }}
                                                    className="p-1.5 rounded hover:bg-gray-100 transition-colors"
                                                    title="Record Repayment"
                                                >
                                                    <TrendingDown size={16} style={{ color: assets }} />
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Add Loan Modal */}
            {isAddLoanModalOpen && (
                <AddLoanModal
                    onClose={() => setIsAddLoanModalOpen(false)}
                    onSubmit={handleAddLoan}
                />
            )}

            {/* Repayment Modal */}
            {isRepaymentModalOpen && selectedLoan && (
                <RepaymentModal
                    loan={selectedLoan}
                    onClose={() => { setIsRepaymentModalOpen(false); setSelectedLoan(null); }}
                    onSubmit={handleProcessRepayment}
                />
            )}
        </div>
    );
};

interface AddLoanModalProps {
    onClose: () => void;
    onSubmit: (data: any) => void;
}

const AddLoanModal: React.FC<AddLoanModalProps> = ({ onClose, onSubmit }) => {
    const [formData, setFormData] = useState({
        loan_type: 'bank_loan' as const,
        lender_name: '',
        account_number: '',
        principal_amount: '',
        interest_rate: '',
        interest_rate_type: 'fixed' as const,
        repayment_terms_months: '',
        start_date: getDefaultDate(),
        repayment_frequency: 'monthly' as const,
        collateral: '',
        grace_period_months: '0',
        notes: '',
        status: 'active' as const,
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit({
            ...formData,
            principal_amount: parseFloat(formData.principal_amount),
            interest_rate: parseFloat(formData.interest_rate),
            repayment_terms_months: parseInt(formData.repayment_terms_months),
            grace_period_months: parseInt(formData.grace_period_months) || 0,
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-md mx-4 shadow-xl max-h-[90vh] overflow-auto">
                <div className="flex items-center justify-between px-6 py-4 border-b sticky top-0 bg-white" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Add New Loan</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Loan Type</label>
                        <select
                            value={formData.loan_type}
                            onChange={(e) => setFormData({ ...formData, loan_type: e.target.value as any })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        >
                            <option value="bank_loan">Bank Loan</option>
                            <option value="other_loan">Other Loan</option>
                            <option value="shareholder_loan">Shareholder Loan</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Lender Name</label>
                        <input
                            type="text"
                            required
                            value={formData.lender_name}
                            onChange={(e) => setFormData({ ...formData, lender_name: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Principal Amount</label>
                            <input
                                type="number"
                                required
                                min="0"
                                step="0.01"
                                value={formData.principal_amount}
                                onChange={(e) => setFormData({ ...formData, principal_amount: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Interest Rate (% p.a.)</label>
                            <input
                                type="number"
                                required
                                min="0"
                                step="0.01"
                                value={formData.interest_rate}
                                onChange={(e) => setFormData({ ...formData, interest_rate: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Term (Months)</label>
                            <input
                                type="number"
                                required
                                min="1"
                                value={formData.repayment_terms_months}
                                onChange={(e) => setFormData({ ...formData, repayment_terms_months: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Start Date</label>
                            <input
                                type="date"
                                required
                                value={formData.start_date}
                                onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Collateral (Optional)</label>
                        <input
                            type="text"
                            value={formData.collateral}
                            onChange={(e) => setFormData({ ...formData, collateral: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>
                    <div className="flex justify-end gap-3 pt-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border" style={{ borderColor: hairline, color: ink }}>
                            Cancel
                        </button>
                        <button type="submit" className="px-4 py-2 text-sm rounded-lg text-white" style={{ background: assets }}>
                            Add Loan
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

interface RepaymentModalProps {
    loan: Loan;
    onClose: () => void;
    onSubmit: (data: any) => void;
}

const RepaymentModal: React.FC<RepaymentModalProps> = ({ loan, onClose, onSubmit }) => {
    const [formData, setFormData] = useState({
        repaymentDate: getDefaultDate(),
        principalAmount: '',
        interestAmount: '',
        reference: '',
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit({
            loanId: loan.id,
            ...formData,
            principalAmount: parseFloat(formData.principalAmount) || 0,
            interestAmount: parseFloat(formData.interestAmount) || 0,
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-md mx-4 shadow-xl">
                <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Record Repayment</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    <div className="p-3 rounded-lg border" style={{ borderColor: hairline, background: '#fef3c7' }}>
                        <p className="text-sm font-medium" style={{ color: '#92400e' }}>{loan.lender_name}</p>
                        <p className="text-xs" style={{ color: '#92400e' }}>
                            Outstanding Balance: {formatCurrency(loan.current_balance)} | Interest Rate: {loan.interest_rate}%
                        </p>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Repayment Date</label>
                        <input
                            type="date"
                            required
                            value={formData.repaymentDate}
                            onChange={(e) => setFormData({ ...formData, repaymentDate: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Principal Amount</label>
                            <input
                                type="number"
                                required
                                min="0"
                                max={loan.current_balance}
                                step="0.01"
                                value={formData.principalAmount}
                                onChange={(e) => setFormData({ ...formData, principalAmount: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Interest Amount</label>
                            <input
                                type="number"
                                required
                                min="0"
                                step="0.01"
                                value={formData.interestAmount}
                                onChange={(e) => setFormData({ ...formData, interestAmount: e.target.value })}
                                className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                                style={{ borderColor: hairline }}
                            />
                        </div>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Reference (Optional)</label>
                        <input
                            type="text"
                            value={formData.reference}
                            onChange={(e) => setFormData({ ...formData, reference: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>
                    <div className="flex justify-end gap-3 pt-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-lg border" style={{ borderColor: hairline, color: ink }}>
                            Cancel
                        </button>
                        <button type="submit" className="px-4 py-2 text-sm rounded-lg text-white" style={{ background: assets }}>
                            Record Repayment
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default Loans;
