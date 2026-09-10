import React, { useState, useEffect, useMemo } from 'react';
import {
    Search, Download, DollarSign, TrendingUp, TrendingDown,
    ArrowRightLeft, PieChart, Wallet, UserCog, Loader2,
} from 'lucide-react';
import { ownerEquityService } from '../../services/ownerEquityService';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { OwnerEquityTransaction } from '../../types';
import { formatCurrency, getDefaultDate } from '../../utils/helpers';
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

const OwnerEquity: React.FC = () => {
    const { user, companyConfig, checkPermission, notify } = useAuth();
    const { accounts, refreshAccounts } = useFinance();
    const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

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
            losses: acc.losses + (tx.transaction_type === 'loss_allocation' ? tx.amount : 0),
        }), { contributions: 0, withdrawals: 0, distributions: 0, losses: 0 });
    }, [filteredTransactions]);

    const handleAddTransaction = async (type: string, data: any) => {
        try {
            if (type === 'contribution') {
                await ownerEquityService.createCapitalContribution(
                    data.amount,
                    data.description,
                    data.date,
                    data.reference,
                    accounts,
                    data.bank_account_id,
                    data.owner_name
                );
            } else if (type === 'withdrawal') {
                await ownerEquityService.createCapitalWithdrawal(
                    data.amount,
                    data.description,
                    data.date,
                    data.reference,
                    accounts,
                    data.bank_account_id,
                    data.owner_name
                );
            } else if (type === 'distribution') {
                await ownerEquityService.createProfitDistribution(
                    data.amount,
                    data.description,
                    data.date,
                    data.reference,
                    accounts,
                    data.bank_account_id,
                    data.owner_name
                );
            } else if (type === 'loss_allocation') {
                await ownerEquityService.createLossAllocation(
                    data.amount,
                    data.description,
                    data.date,
                    data.reference,
                    accounts,
                    data.bank_account_id,
                    data.owner_name
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
                return <TrendingUp size={16} style={{ color: teal[600] }} />;
            case 'capital_withdrawal':
                return <TrendingDown size={16} style={{ color: danger }} />;
            case 'profit_distribution':
                return <ArrowRightLeft size={16} style={{ color: inkSoft }} />;
            case 'loss_allocation':
                return <ArrowRightLeft size={16} style={{ color: '#7c3aed' }} />;
            default:
                return <DollarSign size={16} style={{ color: inkSoft }} />;
        }
    };

    const getTileBg = (type: string) => {
        switch (type) {
            case 'capital_contribution':
                return teal[50];
            case 'capital_withdrawal':
                return '#fdeeee';
            case 'profit_distribution':
                return '#dbeafe';
            case 'loss_allocation':
                return '#ede9fe';
            default:
                return teal[50];
        }
    };

    const getTypePill = (type: string): { bg: string; color: string } => {
        switch (type) {
            case 'capital_contribution':
                return { bg: '#d1fae5', color: '#065f46' };
            case 'capital_withdrawal':
                return { bg: '#fee2e2', color: '#991b1b' };
            case 'profit_distribution':
                return { bg: '#dbeafe', color: '#1e40af' };
            case 'loss_allocation':
                return { bg: '#ede9fe', color: '#5b21b6' };
            default:
                return { bg: teal[50], color: teal[800] };
        }
    };

    const kpis = [
        { label: 'Total Capital Contributions', value: formatCurrency(balance.capital, currency), icon: TrendingUp, color: teal[700], bg: teal[50] },
        { label: 'Total Withdrawals/Distributions', value: formatCurrency(balance.drawings, currency), icon: TrendingDown, color: danger, bg: '#fdeeee' },
        { label: 'Net Owner Equity', value: formatCurrency(balance.net, currency), icon: Wallet, color: amber[600], bg: amber[100] },
    ];

    return (
        <div className="flex flex-col h-full" style={{ background: paper, fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink }}>
            <PageHeader
                icon={<UserCog size={19} color="#fff" />}
                title="Owner Equity"
                subtitle="Track capital contributions, withdrawals, and profit distributions"
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
                                onClick={() => setIsAddModalOpen(true)}
                                style={btnPrimaryStyle}
                                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
                                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
                            >
                                <ArrowRightLeft size={15} />
                                Add Transaction
                            </button>
                        )}
                    </>
                }
            />

            <KpiCards items={kpis} />

            {/* Filters */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 28px' }}>
                <div style={{ flex: 1, position: 'relative' }}>
                    <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
                    <input
                        type="text"
                        placeholder="Search transactions..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{ ...inputStyle, paddingLeft: 34 }}
                    />
                </div>
                <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                    style={{ ...selectStyle, width: 200 }}
                >
                    <option value="All">All Types</option>
                    <option value="capital_contribution">Contributions</option>
                    <option value="capital_withdrawal">Withdrawals</option>
                    <option value="profit_distribution">Profit Distributions</option>
                    <option value="loss_allocation">Loss Allocations</option>
                </select>
                <select
                    value={dateFilter}
                    onChange={(e) => setDateFilter(e.target.value as any)}
                    style={{ ...selectStyle, width: 150 }}
                >
                    <option value="This Year">This Year</option>
                    <option value="Last Year">Last Year</option>
                    <option value="All Time">All Time</option>
                </select>
            </div>

            {/* Transaction Table */}
            <div style={{ flex: 1, overflow: 'auto', padding: '0 28px 28px' }}>
                {isLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 256 }}>
                        <Loader2 size={24} className="animate-spin" style={{ color: teal[500] }} />
                    </div>
                ) : filteredTransactions.length === 0 ? (
                    <EmptyState
                        icon={<PieChart size={32} />}
                        title="No transactions found"
                        hint="Record a capital movement to start tracking owner equity."
                    />
                ) : (
                    <div style={tableCard}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={tableHeadRow}>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Transaction</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Type</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Date</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Amount</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredTransactions.map(tx => {
                                    const pill = getTypePill(tx.transaction_type);
                                    return (
                                        <tr key={tx.id}
                                            style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                                            onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                        >
                                            <td style={{ padding: '12px 16px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                    <div style={{
                                                        width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                                                        background: getTileBg(tx.transaction_type),
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    }}>
                                                        {getTransactionIcon(tx.transaction_type)}
                                                    </div>
                                                    <div style={{ minWidth: 0 }}>
                                                        <p style={{ fontWeight: 600, fontSize: 13, color: ink, margin: 0 }}>{tx.description}</p>
                                                        <p style={{ fontSize: 11, color: inkSoft, margin: 0 }}>
                                                            {tx.reference && (
                                                                <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{tx.reference}</span>
                                                            )}
                                                            {tx.reference && <span> • </span>}
                                                            {tx.owner_name && (
                                                                <span style={{ fontWeight: 600 }}>{tx.owner_name}</span>
                                                            )}
                                                            {tx.owner_name && <span> • </span>}
                                                            <span style={{ textTransform: 'capitalize' }}>{tx.transaction_type.replace('_', ' ')}</span>
                                                        </p>
                                                    </div>
                                                </div>
                                            </td>
                                            <td style={{ padding: '12px 16px' }}>
                                                <span style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 20, textTransform: 'capitalize', background: pill.bg, color: pill.color }}>
                                                    {tx.transaction_type.replace('_', ' ')}
                                                </span>
                                            </td>
                                            <td style={{ padding: '12px 16px', fontSize: 13, color: ink, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                                                {tx.date}
                                            </td>
                                            <td style={{
                                                padding: '12px 16px', fontSize: 13, textAlign: 'right', fontWeight: 700,
                                                fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums',
                                                color: tx.transaction_type === 'capital_contribution' ? teal[700] : danger
                                            }}>
                                                {tx.transaction_type === 'capital_contribution' ? '+' : '-'}{formatCurrency(tx.amount, currency)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Add Transaction Modal */}
            {isAddModalOpen && (
                <AddTransactionModal
                    onClose={() => setIsAddModalOpen(false)}
                    onSubmit={handleAddTransaction}
                    accounts={accounts}
                    currency={currency}
                />
            )}
        </div>
    );
};

interface AddTransactionModalProps {
    onClose: () => void;
    onSubmit: (type: string, data: any) => void;
    accounts: any[];
    currency: string;
}

const AddTransactionModal: React.FC<AddTransactionModalProps> = ({ onClose, onSubmit, accounts, currency }) => {
    const [type, setType] = useState<'contribution' | 'withdrawal' | 'distribution' | 'loss_allocation'>('contribution');
    const [formData, setFormData] = useState({
        amount: '',
        description: '',
        date: getDefaultDate(),
        reference: '',
        bank_account_id: '',
        owner_name: '',
    });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit(type, {
            ...formData,
            amount: parseFloat(formData.amount),
        });
    };

    const bankAccounts = accounts.filter((a: any) =>
        a.subtype === 'BANK' || a.subtype === 'CASH' || a.subtype === 'MOBILE_MONEY' || a.account_group === 'CURRENT_ASSET'
    );

    return (
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(600)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<Wallet size={19} color="#fff" />}
                    title="Add Owner Equity Transaction"
                    subtitle="Capital movement — Owner equity ledger"
                    onClose={onClose}
                />
                <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                    <form id="add-equity-form" onSubmit={handleSubmit}>
                        <div style={{ marginBottom: 18 }}>
                            <label style={labelStyle}>Transaction Type <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                {[
                                    { value: 'contribution', label: 'Contribution', icon: <TrendingUp size={16} />, color: teal[600] },
                                    { value: 'withdrawal', label: 'Withdrawal', icon: <TrendingDown size={16} />, color: danger },
                                    { value: 'distribution', label: 'Distribution', icon: <ArrowRightLeft size={16} />, color: inkSoft },
                                    { value: 'loss_allocation', label: 'Loss Allocation', icon: <ArrowRightLeft size={16} />, color: '#7c3aed' },
                                ].map(opt => (
                                    <button
                                        key={opt.value}
                                        type="button"
                                        onClick={() => setType(opt.value as any)}
                                        style={{
                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                                            padding: 12, borderRadius: 9, cursor: 'pointer', transition: 'all .15s ease',
                                            border: `1.4px solid ${type === opt.value ? opt.color : hairline}`,
                                            background: type === opt.value ? `${opt.color}14` : paper,
                                        }}
                                        onMouseEnter={e => { if (type !== opt.value) e.currentTarget.style.background = teal[50]; }}
                                        onMouseLeave={e => { if (type !== opt.value) e.currentTarget.style.background = paper; }}
                                    >
                                        <span style={{ color: opt.color }}>{opt.icon}</span>
                                        <span style={{ fontSize: 12, fontWeight: 600, color: ink }}>{opt.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div style={sectionLabelStyle}><span>Funding &amp; Details</span></div>
                        <div style={{ marginBottom: 18 }}>
                            <label style={labelStyle}>Bank Account</label>
                            <select
                                value={formData.bank_account_id}
                                onChange={(e) => setFormData({ ...formData, bank_account_id: e.target.value })}
                                style={selectStyle}
                            >
                                <option value="">Select bank account</option>
                                {bankAccounts.map((acc: any) => (
                                    <option key={acc.id} value={acc.id}>
                                        {acc.name} ({acc.account_number || acc.code})
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div style={{ marginBottom: 18 }}>
                            <label style={labelStyle}>
                                Owner / Partner Name
                                <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                            </label>
                            <input
                                type="text"
                                value={formData.owner_name}
                                onChange={(e) => setFormData({ ...formData, owner_name: e.target.value })}
                                placeholder="e.g. John Doe"
                                style={inputStyle}
                            />
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                            <div>
                                <label style={labelStyle}>Amount <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <div style={{ position: 'relative' }}>
                                    <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                                    <input
                                        type="number"
                                        required
                                        min="0.01"
                                        step="0.01"
                                        value={formData.amount}
                                        onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                                        placeholder="0.00"
                                        style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                    />
                                </div>
                            </div>
                            <div>
                                <label style={labelStyle}>Date <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <input
                                    type="date"
                                    required
                                    value={formData.date}
                                    onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                                    style={inputStyle}
                                />
                            </div>
                        </div>

                        <div style={{ marginBottom: 18 }}>
                            <label style={labelStyle}>Description <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                            <input
                                type="text"
                                required
                                value={formData.description}
                                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                placeholder="e.g. Additional capital injection"
                                style={inputStyle}
                            />
                        </div>

                        <div style={{ marginBottom: 18 }}>
                            <label style={labelStyle}>
                                Reference
                                <span style={{ fontSize: 9.5, fontWeight: 600, color: inkSoft, background: teal[50], padding: '1px 6px', borderRadius: 20, letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6 }}>Optional</span>
                            </label>
                            <input
                                type="text"
                                value={formData.reference}
                                onChange={(e) => setFormData({ ...formData, reference: e.target.value })}
                                placeholder="Ref / receipt no."
                                style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                            />
                        </div>

                        <div style={{
                            padding: 16, background: teal[50], borderRadius: 9, border: `1px solid ${teal[100]}`,
                            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                        }}>
                            <div style={{ padding: 8, borderRadius: 8, background: teal[100], color: teal[600] }}>
                                <ArrowRightLeft size={18} />
                            </div>
                            <div>
                                <div style={{ fontSize: 13, fontWeight: 700, color: teal[800] }}>Double-entry posting</div>
                                <div style={{ fontSize: 11, color: inkSoft, fontWeight: 500 }}>Contributions post Dr Bank / Cr Capital. Withdrawals and distributions reverse.</div>
                            </div>
                        </div>
                    </form>
                </div>
                <ModalFooter
                    stepLabel="New movement · Equity ledger"
                    onCancel={onClose}
                    submitLabel="Record Transaction"
                    submitFormId="add-equity-form"
                />
            </div>
        </div>
    );
};

export default OwnerEquity;
