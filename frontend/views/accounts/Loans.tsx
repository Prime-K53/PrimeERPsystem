import React, { useState, useEffect, useMemo } from 'react';
import {
    Plus, Search, Download, Building2, DollarSign, Calendar,
    X, Loader2, TrendingDown, Percent, FileText, ChevronRight,
    AlertTriangle, Landmark, Wallet,
} from 'lucide-react';
import { loanService } from '../../services/loanService';
import { ledgerService } from '../../services/ledgerService';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { Loan, LoanRepayment } from '../../types';
import { formatCurrency, getDefaultDate } from '../../utils/helpers';
import { currencyService } from '../../services/currencyService';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger, assets,
    labelStyle, inputStyle, textareaStyle, selectStyle, sectionLabelStyle,
    btnGhostStyle, btnPrimaryStyle,
    modalOverlayStyle, modalShell, AccentStripe, ModalHeader, ModalFooter,
} from './components/financeChrome';

const Loans: React.FC = () => {
    const { user, companyConfig, checkPermission, notify } = useAuth();
    const { accounts, refreshAccounts } = useFinance();
    const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

    const [loans, setLoans] = useState<Loan[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('All');
    const [isAddLoanModalOpen, setIsAddLoanModalOpen] = useState(false);
    const [isRepaymentModalOpen, setIsRepaymentModalOpen] = useState(false);
    const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
    const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);
    const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);
    const [schedule, setSchedule] = useState<Array<{ period: number; date: string; payment: number; principal: number; interest: number; balance: number }>>([]);
    const [editFormData, setEditFormData] = useState<any>(null);
    const [cancelReason, setCancelReason] = useState('');
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
            await loanService.createLoan(data, accounts, data.bank_account_id);
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
                accounts,
                data.bank_account_id
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

    const handlePostInterestAccrual = async () => {
        const now = new Date();
        try {
            await loanService.postMonthlyInterestAccrual(now.getFullYear(), now.getMonth() + 1, accounts);
            notify('Interest accrual posted successfully', 'success');
            loadData();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to post interest accrual', 'error');
        }
    };

    const handleViewSchedule = (loan: Loan) => {
        const schedule = loanService.calculateAmortizationSchedule(loan);
        setSchedule(schedule);
        setSelectedLoan(loan);
        setIsScheduleModalOpen(true);
    };

    const handleEditLoan = (loan: Loan) => {
        setEditFormData({ ...loan });
        setSelectedLoan(loan);
        setIsEditModalOpen(true);
    };

    const handleSaveEdit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedLoan) return;
        try {
            await loanService.updateLoan(selectedLoan.id, editFormData);
            notify('Loan updated successfully', 'success');
            setIsEditModalOpen(false);
            setSelectedLoan(null);
            setEditFormData(null);
            loadData();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to update loan', 'error');
        }
    };

    const handleCancelLoan = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedLoan) return;
        try {
            const reversalEntry = await ledgerService.createJournalEntry({
                date: new Date().toISOString().split('T')[0],
                description: `Loan cancellation reversal: ${selectedLoan.lender_name} - ${cancelReason}`,
                reference: `LOAN-CANCEL-${selectedLoan.id}`,
                lines: [
                    {
                        debitAccountId: selectedLoan.loan_account_id || '22100',
                        creditAccountId: selectedLoan.bank_account_id || '11210',
                        amount: selectedLoan.current_balance,
                        description: `Reversal of loan principal`,
                    }
                ],
                entryType: 'LOAN_CANCELLATION',
            });

            await loanService.updateLoan(selectedLoan.id, {
                status: 'cancelled',
                notes: `${selectedLoan.notes || ''}\nCancelled: ${cancelReason}`,
            });

            notify('Loan cancelled successfully', 'success');
            setIsCancelModalOpen(false);
            setSelectedLoan(null);
            setCancelReason('');
            loadData();
            refreshAccounts();
        } catch (error: any) {
            notify(error.message || 'Failed to cancel loan', 'error');
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

    const kpis = [
        { label: 'Total Outstanding', value: formatCurrency(summary.totalOutstanding, currency), icon: DollarSign, color: danger, bg: '#fdeeee' },
        { label: 'Total Interest Paid', value: formatCurrency(summary.totalInterestPaid, currency), icon: Percent, color: teal[700], bg: teal[50] },
        { label: 'Active Loans', value: String(summary.activeLoans), icon: Building2, color: amber[600], bg: amber[100] },
    ];

    return (
        <div className="flex flex-col h-full" style={{ background: paper, fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink }}>
            {/* Header — Add-Customer modal header language */}
            <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '22px 28px 18px',
                borderBottom: `1px solid ${hairline}`,
                background: paper, position: 'relative',
            }}>
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 40%, ${amber[500]} 100%)` }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{
                        width: 40, height: 40, borderRadius: 10,
                        background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        boxShadow: '0 4px 10px -3px rgba(15,84,76,.6)', flexShrink: 0
                    }}>
                        <Landmark size={19} color="#fff" />
                    </div>
                    <div>
                        <h1 style={{
                            fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400,
                            fontSize: 22, margin: 0, color: teal[800], letterSpacing: 0.2
                        }}>
                            Loans & Borrowings
                        </h1>
                        <p style={{ margin: '2px 0 0', fontSize: 11.5, color: inkSoft, letterSpacing: 0.02 }}>
                            Loan ledger &mdash; borrowings, repayments &amp; interest
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
                            onClick={handlePostInterestAccrual}
                            style={btnGhostStyle}
                            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                        >
                            <Percent size={15} />
                            Post Accrual
                        </button>
                    )}
                    {canEdit && (
                        <button
                            onClick={() => setIsAddLoanModalOpen(true)}
                            style={btnPrimaryStyle}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
                        >
                            <Plus size={15} />
                            Add Loan
                        </button>
                    )}
                </div>
            </div>

            {/* Summary Cards — KpiCards language */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, padding: '18px 28px 0' }}>
                {kpis.map((item, idx) => (
                    <div key={idx} style={{ padding: '14px 16px', borderRadius: 14, background: paper, border: `1.4px solid ${hairline}`, borderLeft: `4px solid ${item.color}`, boxShadow: '0 1px 3px rgba(0,0,0,.04)', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                        <div style={{ padding: 10, borderRadius: 10, background: item.bg, color: item.color, display: 'inline-flex' }}><item.icon size={20} /></div>
                        <div style={{ minWidth: 0 }}>
                            <p style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, margin: '0 0 6px' }}>{item.label}</p>
                            <p style={{ fontSize: 18, fontWeight: 700, color: ink, margin: 0, fontFamily: "'JetBrains Mono', monospace", letterSpacing: -0.2 }}>{item.value}</p>
                        </div>
                    </div>
                ))}
            </div>

            {/* Filters */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 28px' }}>
                <div style={{ flex: 1, position: 'relative' }}>
                    <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
                    <input
                        type="text"
                        placeholder="Search by lender or loan type..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{ ...inputStyle, paddingLeft: 34 }}
                    />
                </div>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    style={{ ...selectStyle, width: 190 }}
                >
                    <option value="All">All Status</option>
                    <option value="active">Active</option>
                    <option value="fully_paid">Fully Paid</option>
                    <option value="defaulted">Defaulted</option>
                    <option value="cancelled">Cancelled</option>
                </select>
            </div>

            {/* Loans Table */}
            <div style={{ flex: 1, overflow: 'auto', padding: '0 28px 28px' }}>
                {isLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 256 }}>
                        <Loader2 size={24} className="animate-spin" style={{ color: teal[500] }} />
                    </div>
                ) : filteredLoans.length === 0 ? (
                    <div style={{
                        textAlign: 'center', padding: 48,
                        border: `2px dashed ${teal[100]}`, borderRadius: 12, background: teal[50]
                    }}>
                        <Building2 size={32} style={{ margin: '0 auto 12', color: teal[200] }} />
                        <p style={{ fontSize: 13, fontWeight: 700, color: teal[300], margin: 0 }}>No loans found</p>
                        <p style={{ fontSize: 11.5, color: inkSoft, margin: '6px 0 0' }}>Add a borrowing to start tracking repayments and interest.</p>
                    </div>
                ) : (
                    <div style={{ background: paper, border: `1.4px solid ${hairline}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,.04)' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ background: teal[50], textAlign: 'left', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08 }}>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Lender</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Type</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Principal</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Balance</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'right' }}>Rate</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700 }}>Status</th>
                                    <th style={{ padding: '12px 16px', fontWeight: 700, textAlign: 'center' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredLoans.map(loan => (
                                    <tr key={loan.id}
                                        style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                                        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                    >
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                <div style={{
                                                    width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                                                    background: teal[100], color: teal[700],
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    fontSize: 13, fontWeight: 700
                                                }}>
                                                    {(loan.lender_name || '?').charAt(0).toUpperCase()}
                                                </div>
                                                <div>
                                                    <p style={{ fontWeight: 600, fontSize: 13, color: ink, margin: 0 }}>{loan.lender_name}</p>
                                                    {loan.account_number && (
                                                        <p style={{ fontSize: 11, color: inkSoft, margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>{loan.account_number}</p>
                                                    )}
                                                </div>
                                            </div>
                                        </td>
                                        <td style={{ padding: '12px 16px', fontSize: 13, color: ink, textTransform: 'capitalize' }}>
                                            {loan.loan_type.replace('_', ' ')}
                                        </td>
                                        <td style={{ padding: '12px 16px', fontSize: 13, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", color: ink, fontVariantNumeric: 'tabular-nums' }}>
                                            {formatCurrency(loan.principal_amount, currency)}
                                        </td>
                                        <td style={{ padding: '12px 16px', fontSize: 13, textAlign: 'right', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: loan.current_balance > 0 ? danger : teal[700], fontVariantNumeric: 'tabular-nums' }}>
                                            {formatCurrency(loan.current_balance, currency)}
                                        </td>
                                        <td style={{ padding: '12px 16px', fontSize: 13, textAlign: 'right', color: ink, fontFamily: "'JetBrains Mono', monospace" }}>
                                            {loan.interest_rate}%
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <span
                                                style={{
                                                    padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 20, textTransform: 'capitalize',
                                                    background: loan.status === 'active' ? '#d1fae5' : loan.status === 'fully_paid' ? '#dbeafe' : loan.status === 'cancelled' ? '#f1f5f9' : '#fee2e2',
                                                    color: loan.status === 'active' ? '#065f46' : loan.status === 'fully_paid' ? '#1e40af' : loan.status === 'cancelled' ? '#64748b' : '#991b1b'
                                                }}
                                            >
                                                {loan.status.replace('_', ' ')}
                                            </span>
                                        </td>
                                        <td style={{ padding: '12px 16px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                                {loan.status === 'active' && canEdit && (
                                                    <button
                                                        onClick={() => {
                                                            setSelectedLoan(loan);
                                                            setIsRepaymentModalOpen(true);
                                                        }}
                                                        style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
                                                        title="Record Repayment"
                                                        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                    >
                                                        <TrendingDown size={16} style={{ color: teal[600] }} />
                                                    </button>
                                                )}
                                                {loan.status === 'active' && canEdit && (
                                                    <button
                                                        onClick={() => handleViewSchedule(loan)}
                                                        style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
                                                        title="View Amortization Schedule"
                                                        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                    >
                                                        <Calendar size={16} style={{ color: inkSoft }} />
                                                    </button>
                                                )}
                                                {loan.status === 'active' && canEdit && (
                                                    <button
                                                        onClick={() => handleEditLoan(loan)}
                                                        style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
                                                        title="Edit Loan"
                                                        onMouseEnter={e => e.currentTarget.style.background = teal[50]}
                                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                    >
                                                        <FileText size={16} style={{ color: inkSoft }} />
                                                    </button>
                                                )}
                                                {loan.status === 'active' && canEdit && (
                                                    <button
                                                        onClick={() => { setSelectedLoan(loan); setIsCancelModalOpen(true); }}
                                                        style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer' }}
                                                        title="Cancel Loan"
                                                        onMouseEnter={e => e.currentTarget.style.background = '#fdeeee'}
                                                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                    >
                                                        <X size={16} style={{ color: danger }} />
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Add Loan Modal */}
            {isAddLoanModalOpen && (
                <AddLoanModal
                    onClose={() => setIsAddLoanModalOpen(false)}
                    onSubmit={handleAddLoan}
                    accounts={accounts}
                    currency={currency}
                />
            )}

            {/* Repayment Modal */}
            {isRepaymentModalOpen && selectedLoan && (
                <RepaymentModal
                    loan={selectedLoan}
                    onClose={() => { setIsRepaymentModalOpen(false); setSelectedLoan(null); }}
                    onSubmit={handleProcessRepayment}
                    accounts={accounts}
                    currency={currency}
                />
            )}

            {/* Amortization Schedule Modal */}
            {isScheduleModalOpen && selectedLoan && (
                <div style={modalOverlayStyle} onClick={() => setIsScheduleModalOpen(false)}>
                    <div style={modalShell(800)} onClick={e => e.stopPropagation()}>
                        <AccentStripe />
                        <ModalHeader
                            icon={<Calendar size={19} color="#fff" />}
                            title={`Schedule — ${selectedLoan.lender_name}`}
                            subtitle={`Amortization · ${selectedLoan.repayment_terms_months} months · ${selectedLoan.interest_rate}% p.a.`}
                            onClose={() => setIsScheduleModalOpen(false)}
                        />
                        <div style={{ padding: '20px 28px', overflowY: 'auto' }}>
                            {schedule.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: 32, border: `2px dashed ${teal[100]}`, borderRadius: 12, background: teal[50] }}>
                                    <p style={{ fontSize: 13, fontWeight: 700, color: teal[300], margin: 0 }}>No schedule available</p>
                                </div>
                            ) : (
                                <div style={{ border: `1.4px solid ${hairline}`, borderRadius: 12, overflow: 'hidden' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                        <thead>
                                            <tr style={{ background: teal[50], textAlign: 'left', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08 }}>
                                                <th style={{ padding: '10px 14px' }}>Period</th>
                                                <th style={{ padding: '10px 14px' }}>Date</th>
                                                <th style={{ padding: '10px 14px', textAlign: 'right' }}>Payment</th>
                                                <th style={{ padding: '10px 14px', textAlign: 'right' }}>Principal</th>
                                                <th style={{ padding: '10px 14px', textAlign: 'right' }}>Interest</th>
                                                <th style={{ padding: '10px 14px', textAlign: 'right' }}>Balance</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {schedule.map((row) => (
                                                <tr key={row.period} style={{ borderTop: `1px solid ${hairline}` }}>
                                                    <td style={{ padding: '9px 14px', fontFamily: "'JetBrains Mono', monospace", color: inkSoft }}>{row.period}</td>
                                                    <td style={{ padding: '9px 14px', color: ink }}>{row.date}</td>
                                                    <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(row.payment, currency)}</td>
                                                    <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(row.principal, currency)}</td>
                                                    <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(row.interest, currency)}</td>
                                                    <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{formatCurrency(row.balance, currency)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                        <ModalFooter stepLabel={`Schedule · ${schedule.length} periods`} onCancel={() => setIsScheduleModalOpen(false)} submitLabel="Done" onSubmit={() => setIsScheduleModalOpen(false)} />
                    </div>
                </div>
            )}

            {/* Edit Loan Modal */}
            {isEditModalOpen && selectedLoan && editFormData && (
                <div style={modalOverlayStyle} onClick={() => { setIsEditModalOpen(false); setSelectedLoan(null); setEditFormData(null); }}>
                    <div style={modalShell(560)} onClick={e => e.stopPropagation()}>
                        <AccentStripe />
                        <ModalHeader
                            icon={<FileText size={19} color="#fff" />}
                            title="Edit Loan"
                            subtitle={`${selectedLoan.lender_name} — update terms & status`}
                            onClose={() => { setIsEditModalOpen(false); setSelectedLoan(null); setEditFormData(null); }}
                        />
                        <form id="edit-loan-form" onSubmit={handleSaveEdit} style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                                <div style={{ gridColumn: '1 / -1' }}>
                                    <label style={labelStyle}>Lender Name <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                    <input
                                        type="text"
                                        required
                                        value={editFormData.lender_name}
                                        onChange={(e) => setEditFormData({ ...editFormData, lender_name: e.target.value })}
                                        style={inputStyle}
                                        placeholder="Lender / institution"
                                    />
                                </div>
                                <div>
                                    <label style={labelStyle}>Interest Rate (% p.a.)</label>
                                    <input
                                        type="number"
                                        required
                                        min="0"
                                        step="0.01"
                                        value={editFormData.interest_rate}
                                        onChange={(e) => setEditFormData({ ...editFormData, interest_rate: parseFloat(e.target.value) })}
                                        style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                    />
                                </div>
                                <div>
                                    <label style={labelStyle}>Status</label>
                                    <select
                                        value={editFormData.status}
                                        onChange={(e) => setEditFormData({ ...editFormData, status: e.target.value })}
                                        style={selectStyle}
                                    >
                                        <option value="active">Active</option>
                                        <option value="fully_paid">Fully Paid</option>
                                        <option value="defaulted">Defaulted</option>
                                        <option value="cancelled">Cancelled</option>
                                    </select>
                                </div>
                            </div>
                            <div style={{ ...sectionLabelStyle }}><span>Notes</span></div>
                            <div style={{ marginBottom: 18 }}>
                                <textarea
                                    value={editFormData.notes || ''}
                                    onChange={(e) => setEditFormData({ ...editFormData, notes: e.target.value })}
                                    style={textareaStyle}
                                    rows={3}
                                    placeholder="Internal notes for this borrowing…"
                                />
                            </div>
                        </form>
                        <ModalFooter
                            stepLabel="Edit · terms & status"
                            onCancel={() => { setIsEditModalOpen(false); setSelectedLoan(null); setEditFormData(null); }}
                            submitLabel="Save Changes"
                            submitFormId="edit-loan-form"
                        />
                    </div>
                </div>
            )}

            {/* Cancel Loan Modal */}
            {isCancelModalOpen && selectedLoan && (
                <div style={modalOverlayStyle} onClick={() => { setIsCancelModalOpen(false); setSelectedLoan(null); setCancelReason(''); }}>
                    <div style={modalShell(520)} onClick={e => e.stopPropagation()}>
                        <AccentStripe />
                        <ModalHeader
                            icon={<AlertTriangle size={19} color="#fff" />}
                            title="Cancel Loan"
                            subtitle="Reversal will be posted to the ledger"
                            onClose={() => { setIsCancelModalOpen(false); setSelectedLoan(null); setCancelReason(''); }}
                            dangerTile
                        />
                        <form id="cancel-loan-form" onSubmit={handleCancelLoan} style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                            <div style={{
                                padding: 14, background: amber[100], borderRadius: 9, border: `1px solid ${amber[300]}`,
                                display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                            }}>
                                <div style={{ padding: 8, borderRadius: 8, background: paper, color: amber[600] }}>
                                    <Wallet size={18} />
                                </div>
                                <div>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: ink }}>{selectedLoan.lender_name}</div>
                                    <div style={{ fontSize: 11.5, color: inkSoft, fontWeight: 500 }}>
                                        Outstanding Balance: <b style={{ color: danger, fontFamily: "'JetBrains Mono', monospace" }}>{formatCurrency(selectedLoan.current_balance, currency)}</b>
                                    </div>
                                </div>
                            </div>
                            <div style={{ marginBottom: 18 }}>
                                <label style={labelStyle}>Reason for Cancellation <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                                <textarea
                                    required
                                    value={cancelReason}
                                    onChange={(e) => setCancelReason(e.target.value)}
                                    style={textareaStyle}
                                    rows={3}
                                    placeholder="e.g. Refinanced with another lender…"
                                />
                            </div>
                        </form>
                        <ModalFooter
                            stepLabel="Cancel · posts reversal"
                            onCancel={() => { setIsCancelModalOpen(false); setSelectedLoan(null); setCancelReason(''); }}
                            submitLabel="Cancel Loan"
                            submitFormId="cancel-loan-form"
                            danger
                        />
                    </div>
                </div>
            )}
        </div>
    );
};

interface AddLoanModalProps {
    onClose: () => void;
    onSubmit: (data: any) => void;
    accounts: any[];
    currency: string;
}

const AddLoanModal: React.FC<AddLoanModalProps> = ({ onClose, onSubmit, accounts, currency }) => {
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
        bank_account_id: '',
    });

    const bankAccounts = accounts.filter((a: any) =>
        a.subtype === 'BANK' || a.subtype === 'CASH' || a.subtype === 'MOBILE_MONEY' || a.account_group === 'CURRENT_ASSET'
    );

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
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(640)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<Landmark size={19} color="#fff" />}
                    title="Add New Loan"
                    subtitle="New borrowing record — Loan ledger"
                    onClose={onClose}
                />
                <div style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                        <form id="add-loan-form" onSubmit={handleSubmit}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                                <div>
                                    <label style={labelStyle}>
                                        Lender Name <span style={{ color: danger, fontWeight: 700 }}>*</span>
                                    </label>
                                    <input
                                        type="text"
                                        required
                                        value={formData.lender_name}
                                        onChange={(e) => setFormData({ ...formData, lender_name: e.target.value })}
                                        placeholder="Bank / lender name"
                                        style={inputStyle}
                                    />
                                </div>
                                <div>
                                    <label style={labelStyle}>Loan Type</label>
                                    <select
                                        value={formData.loan_type}
                                        onChange={(e) => setFormData({ ...formData, loan_type: e.target.value as any })}
                                        style={selectStyle}
                                    >
                                        <option value="bank_loan">Bank Loan</option>
                                        <option value="other_loan">Other Loan</option>
                                        <option value="shareholder_loan">Shareholder Loan</option>
                                    </select>
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                                <div>
                                    <label style={labelStyle}>
                                        Principal Amount <span style={{ color: danger, fontWeight: 700 }}>*</span>
                                    </label>
                                    <div style={{ position: 'relative' }}>
                                        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                                        <input
                                            type="number"
                                            required
                                            min="0"
                                            step="0.01"
                                            value={formData.principal_amount}
                                            onChange={(e) => setFormData({ ...formData, principal_amount: e.target.value })}
                                            placeholder="0.00"
                                            style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                        />
                                    </div>
                                </div>
                                <div>
                                    <label style={labelStyle}>
                                        Interest Rate (% p.a.) <span style={{ color: danger, fontWeight: 700 }}>*</span>
                                    </label>
                                    <div style={{ position: 'relative' }}>
                                        <input
                                            type="number"
                                            required
                                            min="0"
                                            step="0.01"
                                            value={formData.interest_rate}
                                            onChange={(e) => setFormData({ ...formData, interest_rate: e.target.value })}
                                            placeholder="e.g. 18.5"
                                            style={{ ...inputStyle, paddingRight: 34, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                        />
                                        <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>%</span>
                                    </div>
                                </div>
                            </div>

                            <div style={sectionLabelStyle}><span>Lender &amp; Disbursement</span></div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                                <div>
                                    <label style={labelStyle}>Account Number</label>
                                    <input
                                        type="text"
                                        value={formData.account_number}
                                        onChange={(e) => setFormData({ ...formData, account_number: e.target.value })}
                                        placeholder="Loan / account ref"
                                        style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                                    />
                                </div>
                                <div>
                                    <label style={labelStyle}>Disbursement Account</label>
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
                            </div>
                            <div style={{ marginBottom: 18 }}>
                                <label style={labelStyle}>
                                    Collateral
                                    <span style={{
                                        fontSize: 9.5, fontWeight: 600, color: inkSoft,
                                        background: teal[50], padding: '1px 6px', borderRadius: 20,
                                        letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6
                                    }}>Optional</span>
                                </label>
                                <input
                                    type="text"
                                    value={formData.collateral}
                                    onChange={(e) => setFormData({ ...formData, collateral: e.target.value })}
                                    placeholder="Security pledged, if any"
                                    style={inputStyle}
                                />
                            </div>

                            <div style={sectionLabelStyle}><span>Repayment Terms</span></div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                                <div>
                                    <label style={labelStyle}>
                                        Term (Months) <span style={{ color: danger, fontWeight: 700 }}>*</span>
                                    </label>
                                    <input
                                        type="number"
                                        required
                                        min="1"
                                        value={formData.repayment_terms_months}
                                        onChange={(e) => setFormData({ ...formData, repayment_terms_months: e.target.value })}
                                        placeholder="e.g. 24"
                                        style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                    />
                                </div>
                                <div>
                                    <label style={labelStyle}>
                                        Start Date <span style={{ color: danger, fontWeight: 700 }}>*</span>
                                    </label>
                                    <input
                                        type="date"
                                        required
                                        value={formData.start_date}
                                        onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
                                        style={inputStyle}
                                    />
                                </div>
                                <div>
                                    <label style={labelStyle}>Repayment Frequency</label>
                                    <select
                                        value={formData.repayment_frequency}
                                        onChange={(e) => setFormData({ ...formData, repayment_frequency: e.target.value as any })}
                                        style={selectStyle}
                                    >
                                        <option value="monthly">Monthly</option>
                                        <option value="quarterly">Quarterly</option>
                                        <option value="annually">Annually</option>
                                    </select>
                                </div>
                                <div>
                                    <label style={labelStyle}>Interest Type</label>
                                    <select
                                        value={formData.interest_rate_type}
                                        onChange={(e) => setFormData({ ...formData, interest_rate_type: e.target.value as any })}
                                        style={selectStyle}
                                    >
                                        <option value="fixed">Fixed</option>
                                        <option value="variable">Variable</option>
                                    </select>
                                </div>
                                <div>
                                    <label style={labelStyle}>Grace Period (Months)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        value={formData.grace_period_months}
                                        onChange={(e) => setFormData({ ...formData, grace_period_months: e.target.value })}
                                        placeholder="0"
                                        style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                    />
                                </div>
                            </div>

                            <div style={sectionLabelStyle}><span>Notes &amp; Posting</span></div>
                            <div style={{
                                padding: 16, background: teal[50], borderRadius: 9, border: `1px solid ${teal[100]}`,
                                display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                            }}>
                                <div style={{ padding: 8, borderRadius: 8, background: teal[100], color: teal[600] }}>
                                    <DollarSign size={18} />
                                </div>
                                <div>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: teal[800] }}>Double-entry posting</div>
                                    <div style={{ fontSize: 11, color: inkSoft, fontWeight: 500 }}>Principal posts Dr Bank / Cr Loan liability on save. Interest accrues monthly.</div>
                                </div>
                            </div>
                            <div style={{ marginBottom: 18 }}>
                                <label style={labelStyle}>Internal Notes</label>
                                <textarea
                                    value={formData.notes}
                                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                                    rows={4}
                                    placeholder="e.g. Purpose of borrowing, covenants…"
                                    style={textareaStyle}
                                />
                            </div>
                        </form>
                </div>

                <ModalFooter
                    stepLabel="New borrowing · Loan ledger"
                    onCancel={onClose}
                    submitLabel="Add Loan"
                    submitFormId="add-loan-form"
                />
            </div>
        </div>
    );
};

interface RepaymentModalProps {
    loan: Loan;
    onClose: () => void;
    onSubmit: (data: any) => void;
    accounts: any[];
    currency: string;
}

const RepaymentModal: React.FC<RepaymentModalProps> = ({ loan, onClose, onSubmit, accounts, currency }) => {
    const [formData, setFormData] = useState({
        repaymentDate: getDefaultDate(),
        principalAmount: '',
        interestAmount: '',
        reference: '',
        bank_account_id: loan.bank_account_id || '',
    });

    const bankAccounts = accounts.filter((a: any) =>
        a.subtype === 'BANK' || a.subtype === 'CASH' || a.subtype === 'MOBILE_MONEY' || a.account_group === 'CURRENT_ASSET'
    );

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
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={modalShell(560)} onClick={e => e.stopPropagation()}>
                <AccentStripe />
                <ModalHeader
                    icon={<TrendingDown size={19} color="#fff" />}
                    title="Record Repayment"
                    subtitle={`${loan.lender_name} — loan repayment`}
                    onClose={onClose}
                />
                <form id="repayment-form" onSubmit={handleSubmit} style={{ padding: '24px 28px 8px', overflowY: 'auto' }}>
                    <div style={{
                        padding: 14, background: amber[100], borderRadius: 9, border: `1px solid ${amber[300]}`,
                        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18
                    }}>
                        <div style={{ padding: 8, borderRadius: 8, background: paper, color: amber[600] }}>
                            <Wallet size={18} />
                        </div>
                        <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: ink }}>{loan.lender_name}</div>
                            <div style={{ fontSize: 11.5, color: inkSoft, fontWeight: 500 }}>
                                Outstanding: <b style={{ color: danger, fontFamily: "'JetBrains Mono', monospace" }}>{formatCurrency(loan.current_balance, currency)}</b>
                                <span style={{ margin: '0 6px', color: hairline }}>|</span> Rate: {loan.interest_rate}%
                            </div>
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
                        <div style={{ gridColumn: '1 / -1' }}>
                            <label style={labelStyle}>Repayment Bank Account</label>
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
                        <div style={{ gridColumn: '1 / -1' }}>
                            <label style={labelStyle}>Repayment Date <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                            <input
                                type="date"
                                required
                                value={formData.repaymentDate}
                                onChange={(e) => setFormData({ ...formData, repaymentDate: e.target.value })}
                                style={inputStyle}
                            />
                        </div>
                        <div>
                            <label style={labelStyle}>Principal Amount <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                            <div style={{ position: 'relative' }}>
                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                                <input
                                    type="number"
                                    required
                                    min="0"
                                    max={loan.current_balance}
                                    step="0.01"
                                    value={formData.principalAmount}
                                    onChange={(e) => setFormData({ ...formData, principalAmount: e.target.value })}
                                    placeholder="0.00"
                                    style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                />
                            </div>
                        </div>
                        <div>
                            <label style={labelStyle}>Interest Amount <span style={{ color: danger, fontWeight: 700 }}>*</span></label>
                            <div style={{ position: 'relative' }}>
                                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft, fontWeight: 700, fontSize: 13 }}>{currency}</span>
                                <input
                                    type="number"
                                    required
                                    min="0"
                                    step="0.01"
                                    value={formData.interestAmount}
                                    onChange={(e) => setFormData({ ...formData, interestAmount: e.target.value })}
                                    placeholder="0.00"
                                    style={{ ...inputStyle, paddingLeft: 28, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}
                                />
                            </div>
                        </div>
                    </div>
                    <div style={{ marginBottom: 18 }}>
                        <label style={labelStyle}>
                            Reference
                            <span style={{
                                fontSize: 9.5, fontWeight: 600, color: inkSoft,
                                background: teal[50], padding: '1px 6px', borderRadius: 20,
                                letterSpacing: 0.03, textTransform: 'uppercase', marginLeft: 6
                            }}>Optional</span>
                        </label>
                        <input
                            type="text"
                            value={formData.reference}
                            onChange={(e) => setFormData({ ...formData, reference: e.target.value })}
                            placeholder="Payment ref / receipt no."
                            style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }}
                        />
                    </div>
                </form>
                <ModalFooter stepLabel="Repayment · Dr Loan / Cr Bank" onCancel={onClose} submitLabel="Record Repayment" submitFormId="repayment-form" />
            </div>
        </div>
    );
};

export default Loans;
