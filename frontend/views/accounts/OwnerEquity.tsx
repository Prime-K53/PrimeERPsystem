import React, { useState, useEffect, useMemo } from 'react';
import {
    Plus, Search, Download, DollarSign, TrendingUp, TrendingDown,
    ArrowRightLeft, PieChart, FileText, X, Loader2, Wallet
} from 'lucide-react';
import { ownerEquityService } from '../../services/ownerEquityService';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { OwnerEquityTransaction } from '../../types';
import { formatCurrency, getDefaultDate } from '../../utils/helpers';

const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const assets = '#1f8577';
const danger = '#dc2626';

const OwnerEquity: React.FC = () => {
    const { user, companyConfig, checkPermission, notify } = useAuth();
    const { accounts, refreshAccounts } = useFinance();

    const [transactions, setTransactions] = useState<OwnerEquityTransaction[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [typeFilter, setTypeFilter] = useState<string>('All');
    const [dateFilter, setDateFilter] = useState<'This Year' | 'Last Year' | 'All Time'>('This Year');
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [balance, setBalance] = useState({ capital: 0, drawings: 0, net: 0 });

    const canEdit = checkPermission('accounts.edit');

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setIsLoading(true);
        try {
            await ownerEquityService.initializeStore();
            const data = await ownerEquityService.getAll();
            setTransactions(data);
            const bal = await ownerEquityService.getCapitalBalance(accounts);
            setBalance(bal);
        } catch (error) {
            notify('Failed to load owner equity data', 'error');
        } finally {
            setIsLoading(false);
        }
    };

    const filteredTransactions = useMemo(() => {
        const now = new Date();
        let data = transactions;

        if (dateFilter === 'This Year') {
            data = data.filter(tx => {
                const d = new Date(tx.date);
                return d.getFullYear() === now.getFullYear();
            });
        } else if (dateFilter === 'Last Year') {
            data = data.filter(tx => {
                const d = new Date(tx.date);
                return d.getFullYear() === now.getFullYear() - 1;
            });
        }

        if (typeFilter !== 'All') {
            data = data.filter(tx => tx.transaction_type === typeFilter);
        }

        if (searchTerm) {
            data = data.filter(tx =>
                tx.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                tx.reference?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                tx.amount.toString().includes(searchTerm)
            );
        }

        return data;
    }, [transactions, searchTerm, typeFilter, dateFilter]);

    const totals = useMemo(() => {
        return filteredTransactions.reduce((acc, tx) => ({
            contributions: acc.contributions + (tx.transaction_type === 'capital_contribution' ? tx.amount : 0),
            withdrawals: acc.withdrawals + (tx.transaction_type === 'capital_withdrawal' ? tx.amount : 0),
            distributions: acc.distributions + (tx.transaction_type === 'profit_distribution' ? tx.amount : 0),
        }), { contributions: 0, withdrawals: 0, distributions: 0 });
    }, [filteredTransactions]);

    const handleAddTransaction = async (type: string, data: any) => {
        try {
            if (type === 'contribution') {
                await ownerEquityService.createCapitalContribution(
                    data.amount,
                    data.description,
                    data.date,
                    data.reference,
                    accounts
                );
            } else if (type === 'withdrawal') {
                await ownerEquityService.createCapitalWithdrawal(
                    data.amount,
                    data.description,
                    data.date,
                    data.reference,
                    accounts
                );
            } else if (type === 'distribution') {
                await ownerEquityService.createProfitDistribution(
                    data.amount,
                    data.description,
                    data.date,
                    data.reference,
                    accounts
                );
            }
            notify('Transaction recorded successfully', 'success');
            setIsAddModalOpen(false);
            loadData();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to record transaction', 'error');
        }
    };

    const exportToCSV = () => {
        const headers = ['Date', 'Type', 'Description', 'Reference', 'Amount'];
        const rows = filteredTransactions.map(tx => [
            tx.date,
            tx.transaction_type.replace('_', ' '),
            tx.description,
            tx.reference || '',
            tx.amount.toFixed(2),
        ]);

        const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `owner_equity_${getDefaultDate()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const getTransactionIcon = (type: string) => {
        switch (type) {
            case 'capital_contribution':
                return <TrendingUp size={16} style={{ color: assets }} />;
            case 'capital_withdrawal':
                return <TrendingDown size={16} style={{ color: danger }} />;
            case 'profit_distribution':
                return <ArrowRightLeft size={16} style={{ color: inkSoft }} />;
            default:
                return <DollarSign size={16} style={{ color: inkSoft }} />;
        }
    };

    return (
        <div className="flex flex-col h-full" style={{ background: paper }}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                <div>
                    <h1 className="text-lg font-semibold" style={{ color: ink }}>Owner Equity</h1>
                    <p className="text-sm" style={{ color: inkSoft }}>Track capital contributions, withdrawals, and profit distributions</p>
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
                            onClick={() => setIsAddModalOpen(true)}
                            className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg text-white transition-colors"
                            style={{ background: assets }}
                        >
                            <Plus size={16} />
                            Add Transaction
                        </button>
                    )}
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-3 gap-4 px-6 py-4">
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <TrendingUp size={16} style={{ color: assets }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Total Capital Contributions</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: assets }}>
                        {formatCurrency(balance.capital)}
                    </span>
                </div>
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <TrendingDown size={16} style={{ color: danger }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Total Withdrawals/Distributions</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: danger }}>
                        {formatCurrency(balance.drawings)}
                    </span>
                </div>
                <div className="p-4 rounded-lg border" style={{ borderColor: hairline }}>
                    <div className="flex items-center gap-2 mb-2">
                        <Wallet size={16} style={{ color: inkSoft }} />
                        <span className="text-sm" style={{ color: inkSoft }}>Net Owner Equity</span>
                    </div>
                    <span className="text-xl font-semibold" style={{ color: balance.net >= 0 ? ink : danger }}>
                        {formatCurrency(balance.net)}
                    </span>
                </div>
            </div>

            {/* Filters */}
            <div className="flex items-center gap-4 px-6 py-3 border-b" style={{ borderColor: hairline }}>
                <div className="flex-1 relative">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: inkSoft }} />
                    <input
                        type="text"
                        placeholder="Search transactions..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 text-sm rounded-lg border outline-none"
                        style={{ borderColor: hairline }}
                    />
                </div>
                <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                    className="px-3 py-2 text-sm rounded-lg border outline-none"
                    style={{ borderColor: hairline }}
                >
                    <option value="All">All Types</option>
                    <option value="capital_contribution">Contributions</option>
                    <option value="capital_withdrawal">Withdrawals</option>
                    <option value="profit_distribution">Profit Distributions</option>
                </select>
                <select
                    value={dateFilter}
                    onChange={(e) => setDateFilter(e.target.value as any)}
                    className="px-3 py-2 text-sm rounded-lg border outline-none"
                    style={{ borderColor: hairline }}
                >
                    <option value="This Year">This Year</option>
                    <option value="Last Year">Last Year</option>
                    <option value="All Time">All Time</option>
                </select>
            </div>

            {/* Transaction List */}
            <div className="flex-1 overflow-auto px-6 py-4">
                {isLoading ? (
                    <div className="flex items-center justify-center h-64">
                        <Loader2 size={24} className="animate-spin" style={{ color: assets }} />
                    </div>
                ) : filteredTransactions.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64" style={{ color: inkSoft }}>
                        <PieChart size={48} className="mb-4 opacity-50" />
                        <p>No transactions found</p>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {filteredTransactions.map(tx => (
                            <div
                                key={tx.id}
                                className="flex items-center justify-between p-4 rounded-lg border"
                                style={{ borderColor: hairline, background: paper }}
                            >
                                <div className="flex items-center gap-4">
                                    <div className="p-2 rounded-lg" style={{ background: '#f3f4f6' }}>
                                        {getTransactionIcon(tx.transaction_type)}
                                    </div>
                                    <div>
                                        <p className="font-medium text-sm" style={{ color: ink }}>
                                            {tx.description}
                                        </p>
                                        <div className="flex items-center gap-2 text-xs" style={{ color: inkSoft }}>
                                            <span>{tx.date}</span>
                                            {tx.reference && (
                                                <>
                                                    <span>•</span>
                                                    <span>{tx.reference}</span>
                                                </>
                                            )}
                                            <span className="capitalize">• {tx.transaction_type.replace('_', ' ')}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="text-right">
                                    <p
                                        className="font-semibold font-mono"
                                        style={{
                                            color: tx.transaction_type === 'capital_contribution' ? assets : danger
                                        }}
                                    >
                                        {tx.transaction_type === 'capital_contribution' ? '+' : '-'}
                                        {formatCurrency(tx.amount)}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Add Transaction Modal */}
            {isAddModalOpen && (
                <AddTransactionModal
                    onClose={() => setIsAddModalOpen(false)}
                    onSubmit={handleAddTransaction}
                />
            )}
        </div>
    );
};

interface AddTransactionModalProps {
    onClose: () => void;
    onSubmit: (type: string, data: any) => void;
}

const AddTransactionModal: React.FC<AddTransactionModalProps> = ({ onClose, onSubmit }) => {
    const [type, setType] = useState<'contribution' | 'withdrawal' | 'distribution'>('contribution');
    const [formData, setFormData] = useState({
        amount: '',
        description: '',
        date: getDefaultDate(),
        reference: '',
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit(type, {
            ...formData,
            amount: parseFloat(formData.amount),
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="bg-white rounded-xl w-full max-w-md mx-4 shadow-xl">
                <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: hairline }}>
                    <h2 className="text-lg font-semibold" style={{ color: ink }}>Add Owner Equity Transaction</h2>
                    <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
                        <X size={20} style={{ color: inkSoft }} />
                    </button>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-2" style={{ color: ink }}>Transaction Type</label>
                        <div className="grid grid-cols-3 gap-2">
                            {[
                                { value: 'contribution', label: 'Contribution', icon: <TrendingUp size={16} />, color: assets },
                                { value: 'withdrawal', label: 'Withdrawal', icon: <TrendingDown size={16} />, color: danger },
                                { value: 'distribution', label: 'Distribution', icon: <ArrowRightLeft size={16} />, color: inkSoft },
                            ].map(opt => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => setType(opt.value as any)}
                                    className="flex flex-col items-center gap-1 p-3 rounded-lg border-2 transition-colors"
                                    style={{
                                        borderColor: type === opt.value ? opt.color : hairline,
                                        background: type === opt.value ? `${opt.color}10` : paper,
                                    }}
                                >
                                    <span style={{ color: opt.color }}>{opt.icon}</span>
                                    <span className="text-xs font-medium" style={{ color: ink }}>{opt.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Amount</label>
                        <input
                            type="number"
                            required
                            min="0.01"
                            step="0.01"
                            value={formData.amount}
                            onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Description</label>
                        <input
                            type="text"
                            required
                            value={formData.description}
                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium mb-1" style={{ color: ink }}>Date</label>
                        <input
                            type="date"
                            required
                            value={formData.date}
                            onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                            className="w-full px-3 py-2 text-sm rounded-lg border outline-none"
                            style={{ borderColor: hairline }}
                        />
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
                            Record Transaction
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default OwnerEquity;
