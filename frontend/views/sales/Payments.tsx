
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { logger } from '../../services/logger';
import { Banknote as PaymentIcon, Plus, Trash2, X, Search, Calendar, Eye, Mail, ArrowRight, AlertTriangle, Wallet, MoreVertical, Building2, Undo2, Printer, Edit2, FileText, Download, Loader2, ExternalLink, BarChart3, FileBarChart, RefreshCw, Link2, CreditCard, Landmark, Smartphone, ChevronDown, ChevronRight, ArrowUpDown, SlidersHorizontal, CircleDollarSign, Banknote } from 'lucide-react';
import { useData } from '../../context/DataContext';
import { useAuth } from '../../context/AuthContext';
import { useFinance } from '../../context/FinanceContext';
import { useSales } from '../../context/SalesContext';
import { useOrders } from '../../context/OrdersContext';
import { OFFLINE_MODE, DEFAULT_ACCOUNTS, ACCOUNT_IDS, getPaymentAccountOptions } from '../../constants';
import { CustomerPayment, InvoiceAllocation, Sale, Invoice, SupplierPayment, PurchaseAllocation, LedgerEntry, WalletTransaction, Order, OrderPayment } from '../../types';
import { useLocation, useNavigate } from 'react-router-dom';
import { useHighlight } from '../../hooks/useHighlight';
import { useDocumentVerificationLink } from '../../hooks/useDocumentVerificationLink';
import { ClientModal } from './components/ClientModal';
import { TransactionRefLink } from '../../components/TransactionRefLink';
import {
    openTransactionRef,
    transactionRefKey,
    transactionRefUnavailableMessage,
    useTransactionRefTarget,
} from '../../hooks/useTransactionRefDeepLink';
import { generateNextId, roundFinancial } from '../../utils/helpers';
import { getCustomerOptionLabel } from '../../utils/customerDisplay';
import { getOrderOutstanding, isOrderPaymentEligible } from './components/orderStatusUtils';
import { getDefaultDate, validateDateInFY } from '../../utils/financialYearUtils';
import { useProcurement } from '../../context/ProcurementContext';
import { useBankingStore } from '../../context/BankingContext';
import { api } from '../../services/api';
import { paymentService } from '../../services/paymentService';
import { PreviewModal } from '../shared/components/PDF/PreviewModal';
import { dbService } from '../../services/db';
import { ReceiptSchema, PosReceiptSchema, SupplierPaymentSchema } from '../shared/components/PDF/schemas';
import {
    buildCustomerReceiptDoc,
    buildPosReceiptDoc,
    buildSupplierPaymentDoc
} from '../../services/receiptCalculationService';
import { createStatementSnapshot } from '../../services/statementService';
import {
    downloadCsv,
    filterCustomerPayments,
    getAllocatedTotal,
    getAllocationStatus,
    getPaymentInvoiceRefs,
    getPaymentMethodKey,
    getUnallocatedTotal,
    paginateList,
    paymentsToCsv,
    sortCustomerPayments,
    summarizePayments,
    type AllocationStatus,
    type PaymentSortKey,
    type SortDir,
} from '../../utils/customerPaymentsList';

/**
 * Customer Payment Hover Card
 */
const teal = {
  50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7',
  400: '#3fa294', 500: '#1f8577', 600: '#146b60', 700: '#0f544c',
  800: '#0b3e39', 900: '#082e2a'
};
const amber = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' };
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const danger = '#b5493f';

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: teal[800],
  marginBottom: 6, letterSpacing: 0.01
};
const inputStyle: React.CSSProperties = {
  width: '100%', fontFamily: "'Inter', sans-serif", fontSize: 13.5,
  color: ink, background: paper,
  border: '1.4px solid #e4ddd1', borderRadius: 9,
  padding: '9px 12px', outline: 'none'
};
const selectStyle: React.CSSProperties = {
  ...inputStyle, appearance: 'none', cursor: 'pointer', paddingRight: 30,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235c6567'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center'
};
const btnPrimaryStyle: React.CSSProperties = {
  fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
  padding: '9px 18px', borderRadius: 9, cursor: 'pointer',
  background: 'linear-gradient(155deg, #1f8577, #0f544c)', color: '#fff', border: 'none',
  display: 'flex', alignItems: 'center', gap: 7,
  boxShadow: '0 6px 16px -6px rgba(15,84,76,.55)'
};
const btnGhostStyle: React.CSSProperties = {
  fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
  padding: '9px 18px', borderRadius: 9, cursor: 'pointer',
  background: paper, border: '1.4px solid #e4ddd1', color: inkSoft,
  display: 'flex', alignItems: 'center', gap: 7, transition: 'all .15s ease'
};

const CustomerPaymentHoverCard: React.FC<{
    pos: { x: number, y: number },
    payment: CustomerPayment
}> = ({ pos, payment }) => {
    const { companyConfig } = useAuth();
    const currency = companyConfig.currencySymbol;

    return (
        <div
            className="fixed z-[100] pointer-events-none animate-in fade-in zoom-in-95 duration-200"
            style={{ top: pos.y + 10, left: pos.x + 10 }}
        >
            <div className="bg-[#FEFDFB] backdrop-blur-md border border-[#e4ddd1] rounded-2xl shadow-premium p-4 min-w-[200px] flex flex-col gap-3">
                <div className="flex items-center gap-3 border-b border-[#e4ddd1] pb-3">
                    <div className="w-8 h-8 rounded-lg bg-[#eef7f6] flex items-center justify-center text-[#1f8577]">
                        <PaymentIcon size={16} />
                    </div>
                    <div>
                        <p className="text-[10px] font-bold text-[#1f8577] uppercase tracking-tight">Payment Note</p>
                        <p className="text-xs font-bold text-[#23282A] font-mono">{payment.id}</p>
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="flex justify-between items-center text-[10px]">
                        <span className="text-[#5c6567] font-bold uppercase tracking-tight">Customer</span>
                        <span className="text-[#23282A] font-bold truncate max-w-[120px]">{payment.customerName}</span>
                    </div>
                    {payment.subAccountName && (
                        <div className="flex justify-between items-center text-[10px]">
                            <span className="text-[#5c6567] font-bold uppercase tracking-tight">Account</span>
                            <span className="text-[#1f8577] font-bold truncate max-w-[120px]">{payment.subAccountName}</span>
                        </div>
                    )}
                    <div className="flex justify-between items-center text-[10px]">
                        <span className="text-[#5c6567] font-bold uppercase tracking-tight">Amount</span>
                        <span className="text-[#1f8577] font-bold finance-nums">{currency}{(payment.amount || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between items-center text-[10px]">
                        <span className="text-[#5c6567] font-bold uppercase tracking-tight">Method</span>
                        <span className="text-[#1f8577] font-bold">{payment.paymentMethod}</span>
                    </div>
                </div>

                <div className="bg-[#eef7f6] rounded-lg p-2 flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-[#1f8577] rounded-full animate-pulse"></div>
                    <span className="text-[9px] text-[#5c6567] font-bold uppercase tracking-tight italic font-mono">Live Secure Ledger</span>
                </div>
            </div>
        </div>
    );
};

/**
 * Supplier Payment Hover Card
 */
const SupplierPaymentHoverCard: React.FC<{
    pos: { x: number, y: number },
    payment: SupplierPayment
}> = ({ pos, payment }) => {
    const { companyConfig } = useAuth();
    const { suppliers } = useProcurement();
    const currency = companyConfig.currencySymbol;
    const supplier = suppliers.find(s => s.id === payment.supplierId);

    return (
        <div
            className="fixed z-[100] pointer-events-none animate-in fade-in zoom-in-95 duration-200"
            style={{ top: pos.y + 10, left: pos.x + 10 }}
        >
            <div className="bg-[#FEFDFB] backdrop-blur-md border border-[#e4ddd1] rounded-2xl shadow-premium p-4 min-w-[200px] flex flex-col gap-3">
                <div className="flex items-center gap-3 border-b border-[#e4ddd1] pb-3">
                    <div className="w-8 h-8 rounded-lg bg-[#eef7f6] flex items-center justify-center text-[#1f8577]">
                        <Wallet size={16} />
                    </div>
                    <div>
                        <p className="text-[10px] font-bold text-[#1f8577] uppercase tracking-tight">Supplier Payment</p>
                        <p className="text-xs font-bold text-[#23282A] font-mono">{payment.id}</p>
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="flex justify-between items-center text-[10px]">
                        <span className="text-[#5c6567] font-bold uppercase tracking-tight">Supplier</span>
                        <span className="text-[#23282A] font-bold truncate max-w-[120px]">{supplier?.name || 'Unknown'}</span>
                    </div>
                    <div className="flex justify-between items-center text-[10px]">
                        <span className="text-[#5c6567] font-bold uppercase tracking-tight">Amount</span>
                        <span className="text-[#1f8577] font-bold finance-nums">{currency}{(payment.amount || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between items-center text-[10px]">
                        <span className="text-[#5c6567] font-bold uppercase tracking-tight">Method</span>
                        <span className="text-[#1f8577] font-bold">{payment.paymentMethod}</span>
                    </div>
                    {payment.reference && (
                        <div className="flex justify-between items-center text-[10px]">
                            <span className="text-[#5c6567] font-bold uppercase tracking-tight">Ref</span>
                            <span className="text-[#23282A] font-medium truncate max-w-[120px]">{payment.reference}</span>
                        </div>
                    )}
                </div>

                <div className="bg-[#eef7f6] rounded-lg p-2 flex items-center gap-2">
                    <div className="w-1.5 h-1.5 bg-[#1f8577] rounded-full animate-pulse"></div>
                    <span className="text-[9px] text-[#5c6567] font-bold uppercase tracking-tight italic font-mono">Ledger Verified</span>
                </div>
            </div>
        </div>
    );
};

interface SupplierDetailPanelProps {
    payment: SupplierPayment | null;
    onClose: () => void;
    onVoid: (id: string) => void;
}

const SupplierDetailPanel: React.FC<SupplierDetailPanelProps> = ({ payment, onClose, onVoid }) => {
    const { companyConfig } = useAuth();
    const { suppliers } = useProcurement();
    const { copyVerificationLink, openVerificationLink } = useDocumentVerificationLink();
    const currency = companyConfig.currencySymbol;

    if (!payment) return null;

    const supplier = suppliers.find(s => s.id === payment.supplierId);

    return (
        <div className="fixed top-0 right-0 w-[450px] h-full bg-[#FEFDFB] shadow-2xl z-[120] border-l border-[#e4ddd1] animate-in slide-in-from-right duration-300 flex flex-col">
            <div className="p-6 border-b border-[#e4ddd1] bg-[#eef7f6] flex justify-between items-center">
                <div>
                    <h2 className="text-lg font-bold text-[#23282A] tracking-tight">Payment Details</h2>
                    <p className="text-[10px] font-mono font-bold text-[#5c6567] uppercase">{payment.id}</p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => { void copyVerificationLink('supplier_payment', 'supplierPayments', payment.id, (payment as any).paymentNumber || payment.id); }}
                        className="p-2 text-[#5c6567] hover:text-[#1f8577] rounded-lg hover:bg-[#eef7f6] transition-all"
                        title="Copy Verification Link"
                    >
                        <Link2 size={18} />
                    </button>
                    <button
                        onClick={() => { void openVerificationLink('supplier_payment', 'supplierPayments', payment.id, (payment as any).paymentNumber || payment.id); }}
                        className="p-2 text-[#5c6567] hover:text-[#1f8577] rounded-lg hover:bg-[#eef7f6] transition-all"
                        title="View Verification"
                    >
                        <ExternalLink size={18} />
                    </button>
                    <button
                        onClick={() => { if (confirm("Void this supplier payment?")) onVoid(payment.id); }}
                        className="p-2 text-[#5c6567] hover:text-[#b5493f] rounded-lg hover:bg-[#fef2f2] transition-all"
                    >
                        <Trash2 size={18} />
                    </button>
                    <button onClick={onClose} className="p-2 text-[#5c6567] hover:text-[#23282A] rounded-lg hover:bg-[#eef7f6] transition-all">
                        <X size={20} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-8 space-y-8 custom-scrollbar">
                <div className="flex items-center justify-between p-6 bg-[#FEFDFB] rounded-2xl border border-[#e4ddd1] shadow-sm">
                    <div>
                        <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1">Total Amount Paid</label>
                        <p className="text-3xl font-black text-[#23282A] finance-nums">{currency}{(payment.amount || 0).toLocaleString()}</p>
                    </div>
                    <div className="text-right">
                        <span className={`px-3 py-1 rounded-full text-[10px] font-bold border ${payment.status === 'Cleared' ? 'bg-[#eef7f6] text-[#0f544c] border-[#d3ece9]' :
                            payment.status === 'Voided' ? 'bg-[#fef2f2] text-[#b5493f] border-[#fcd5d0]' :
                                'bg-[#fbead0] text-[#b97e2b] border-[#eec27a]'
                            }`}>
                            {payment.status}
                        </span>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                    <div>
                        <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1.5">Supplier</label>
                        <p className="font-semibold text-[#23282A] text-[13px]">{supplier?.name || 'Unknown'}</p>
                    </div>
                    <div>
                        <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1.5">Payment Date</label>
                        <p className="font-semibold text-[#23282A] text-[13px]">{new Date(payment.date).toLocaleDateString(undefined, { dateStyle: 'long' })}</p>
                    </div>
                    <div>
                        <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1.5">Payment Account</label>
                        <div className="flex items-center gap-2">
                             <div className={`w-2 h-2 rounded-full ${payment.accountId === '11110' ? 'bg-[#1f8577]' : (payment.accountId === '11230' ? 'bg-[#3fa294]' : 'bg-[#d99a3f]')}`}></div>
                                     <p className="font-semibold text-[#23282A] text-[13px]">
                                {DEFAULT_ACCOUNTS.find(a => a.id === payment.accountId)?.name || payment.paymentMethod}
                            </p>
                        </div>
                    </div>
                    <div>
                        <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1.5">Reference</label>
                        <p className="font-semibold text-[#23282A] text-[13px]">{payment.reference || 'N/A'}</p>
                    </div>
                </div>

                {payment.notes && (
                    <div className="p-3 bg-[#eef7f6] rounded-xl border border-[#e4ddd1]">
                        <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1">Notes</label>
                        <p className="text-[12px] italic text-[#5c6567]">{payment.notes}</p>
                    </div>
                )}

                {/* Allocations Table */}
                <div className="space-y-3">
                    <h3 className="text-[14px] font-bold text-[#23282A] flex items-center gap-2">
                        <ArrowRight size={16} className="text-[#1f8577]" />
                        Bill Allocations
                    </h3>
                    <div className="border border-[#e4ddd1] rounded-xl overflow-hidden bg-[#FEFDFB] shadow-sm">
                        <table className="w-full text-left text-[13px]">
                            <thead className="bg-[#eef7f6] border-b border-[#e4ddd1]">
                                <tr>
                                    <th className="table-header">Bill ID</th>
                                    <th className="table-header text-right">Amount</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[#e4ddd1]">
                                {(payment.allocations || []).map((a, i) => (
                                    <tr key={i} className="hover:bg-[#eef7f6]/50 transition-colors">
                                        <td className="table-body-cell font-medium text-[#1f8577]">#{a.purchaseId}</td>
                                        <td className="table-body-cell text-right font-bold finance-nums">{currency}{(a.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                    </tr>
                                ))}
                                {(!payment.allocations || payment.allocations.length === 0) && (
                                    <tr>
                                        <td colSpan={2} className="table-body-cell text-center text-[#5c6567] italic">No allocations recorded</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
};

/**
 * Customer Payment Detail Panel (Slide-out)
 */
const CustomerPaymentDetailPanel: React.FC<{
    payment: CustomerPayment | null;
    onClose: () => void;
    onDelete: (id: string) => void;
    onPurge: (id: string) => void;
    onEdit: (payment: CustomerPayment) => void;
    onPreview: (payment: CustomerPayment) => void;
    onStatement: (customerId: string, customerName: string) => void;
}> = ({ payment, onClose, onDelete, onPurge, onEdit, onPreview, onStatement }) => {
    const { companyConfig, notify } = useAuth();
    const { ledger, accounts } = useFinance();
    const { copyVerificationLink, openVerificationLink } = useDocumentVerificationLink();
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState<'Details' | 'Accounting'>('Details');
    const currency = companyConfig.currencySymbol;
    const panelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (payment && panelRef.current && !panelRef.current.contains(event.target as Node)) {
                onClose();
            }
        };
        if (payment) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [payment, onClose]);

    if (!payment) return null;

    const allocated = (payment.allocations || []).reduce((s, a) => s + (a.amount || 0), 0);

    return (
        <div
            ref={panelRef}
            className={`fixed inset-y-0 right-0 w-[450px] bg-[#FEFDFB] shadow-2xl z-[120] transform transition-transform duration-300 ease-in-out border-l border-[#e4ddd1] flex flex-col font-['Inter',_sans-serif] text-[13px] leading-[1.5] text-[#23282A] ${payment ? 'translate-x-0' : 'translate-x-full'}`}
        >
            {/* Header */}
            <div className="px-4 py-3 border-b border-[#e4ddd1] flex justify-between items-center bg-[#FEFDFB]">
                <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-lg bg-[#eef7f6] text-[#1f8577] flex items-center justify-center">
                        <PaymentIcon size={18} />
                    </div>
                    <div>
                        <h2 className="text-[20px] font-semibold text-[#0b3e39] leading-tight">Payment Details</h2>
                        <p className="text-[10px] text-[#5c6567] font-bold uppercase tracking-tight">{payment.id}</p>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="p-1.5 hover:bg-[#e4ddd1] rounded-lg transition-colors text-[#5c6567] hover:text-[#23282A]"
                >
                    <X size={20} />
                </button>
            </div>

            {/* Tab Navigation */}
            <div className="flex border-b border-[#e4ddd1] px-4 bg-[#FEFDFB] shrink-0">
                {['Details', 'Accounting'].map(tab => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab as 'Details' | 'Accounting')}
                        className={`px-4 py-3 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all ${activeTab === tab ? 'border-[#0b3e39] text-[#0b3e39]' : 'border-transparent text-[#5c6567] hover:text-[#23282A]'}`}
                    >
                        {tab}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-8">
                {activeTab === 'Details' ? (
                    <>
                        {/* Status and Amount Card */}
                        <div className="bg-[#eef7f6] rounded-2xl p-4 border border-[#e4ddd1] flex justify-between items-center">
                            <div>
                                <p className="text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1">Total Amount</p>
                                <p className="text-[24px] font-bold text-[#23282A] finance-nums">
                                    {currency}{(payment.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                </p>
                            </div>
                            <div className="text-right">
                                <p className="text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1">Status</p>
                                <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-tight border ${payment.status === 'Cleared' ? 'bg-[#eef7f6] text-[#0f544c] border-[#d3ece9]' :
                                    payment.status === 'Pending' ? 'bg-[#fbead0] text-[#b97e2b] border-[#eec27a]' :
                                        'bg-[#fef2f2] text-[#b5493f] border-[#fcd5d0]'
                                    }`}>
                                    {payment.status}
                                </span>
                            </div>
                        </div>

                        {/* Information Grid */}
                        <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                            <div>
                                <div className="flex items-center gap-2">
                                    <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1.5">Customer Name</label>
                                    <button
                                        onClick={() => navigate('/sales-flow/customers', { state: { customerId: payment.customerId } })}
                                        className="hover:text-[#1f8577] transition-colors flex items-center gap-1 group"
                                    >
                                        <ExternalLink size={12} className="text-[#5c6567] group-hover:text-[#1f8577]" />
                                    </button>
                                </div>
                                <p className="font-semibold text-[#23282A] text-[13px]">{payment.customerName}</p>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1.5">Payment Date</label>
                                <p className="font-semibold text-[#23282A] text-[13px]">{new Date(payment.date).toLocaleDateString(undefined, { dateStyle: 'long' })}</p>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1.5">Payment Account</label>
                                <div className="flex items-center gap-2">
                             <div className={`w-2 h-2 rounded-full ${payment.accountId === '11110' ? 'bg-[#1f8577]' : (payment.accountId === '11230' ? 'bg-[#3fa294]' : 'bg-[#d99a3f]')}`}></div>
                                     <p className="font-semibold text-[#23282A] text-[13px]">
                                        {DEFAULT_ACCOUNTS.find(a => a.id === payment.accountId)?.name || payment.paymentMethod}
                                    </p>
                                </div>
                            </div>
                            <div>
                                <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1.5">Reference</label>
                                <p className="font-semibold text-[#23282A] text-[13px]">{payment.reference || 'N/A'}</p>
                            </div>
                            {payment.subAccountName && (
                                <div>
                                    <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1.5">Account Context</label>
                                    <p className="font-semibold text-[#1f8577] text-[13px]">{payment.subAccountName}</p>
                                </div>
                            )}
                        </div>

                        {/* Allocations Table */}
                        <div className="space-y-3">
                            <h3 className="text-[14px] font-bold text-[#23282A] flex items-center gap-2">
                                <ArrowRight size={16} className="text-[#1f8577]" />
                                Document Allocations
                            </h3>
                            <div className="border border-[#e4ddd1] rounded-xl overflow-hidden bg-[#FEFDFB] shadow-sm">
                                <table className="w-full text-left text-[13px]">
                                    <thead className="bg-[#eef7f6] border-b border-[#e4ddd1]">
                                        <tr>
                                            <th className="table-header">Document</th>
                                            <th className="table-header">Type</th>
                                            <th className="table-header text-right">Amount</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#e4ddd1]">
                                        {(payment.allocations || []).map((a, i) => (
                                            <tr key={i} className="hover:bg-[#eef7f6]/50 transition-colors">
                                                <td className="table-body-cell font-medium text-[#1f8577]">#{a.invoiceId}</td>
                                                <td className="table-body-cell">
                                                    <span className="text-[9px] font-bold text-[#1f8577] bg-[#eef7f6] px-1.5 py-0.5 rounded uppercase">Invoice</span>
                                                </td>
                                                <td className="table-body-cell text-right font-bold finance-nums">{currency}{(a.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                            </tr>
                                        ))}
                                        {((payment as any).orderAllocations || []).map((a: any, i: number) => (
                                            <tr key={`ord-${i}`} className="hover:bg-[#eef7f6]/50 transition-colors">
                                                <td className="table-body-cell font-medium text-[#b97e2b]">#{a.orderId}</td>
                                                <td className="table-body-cell">
                                                    <span className="text-[9px] font-bold text-[#b97e2b] bg-[#fbead0] px-1.5 py-0.5 rounded uppercase">Order</span>
                                                </td>
                                                <td className="table-body-cell text-right font-bold finance-nums">{currency}{(a.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                            </tr>
                                        ))}
                                        {(!payment.allocations || payment.allocations.length === 0) && (!(payment as any).orderAllocations || (payment as any).orderAllocations.length === 0) && (
                                            <tr>
                                                <td colSpan={3} className="table-body-cell text-center text-[#5c6567] italic">No allocations recorded</td>
                                            </tr>
                                        )}
                                    </tbody>
                                    <tfoot className="bg-[#eef7f6]/50 font-bold border-t border-[#e4ddd1]">
                                        <tr>
                                            <td className="table-body-cell text-[#5c6567]" colSpan={2}>Total Allocated</td>
                                            <td className="table-body-cell text-right text-[#23282A] finance-nums">
                                                {currency}{allocated.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                            </td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                        </div>

                        {/* Notes */}
                        {payment.notes && (
                            <div className="p-3 bg-[#eef7f6] rounded-xl border border-[#e4ddd1]">
                                <label className="block text-[10px] font-bold text-[#5c6567] uppercase tracking-tight mb-1">Internal Notes</label>
                                <p className="text-[12px] italic text-[#5c6567]">{payment.notes}</p>
                            </div>
                        )}
                    </>
                ) : (
                    /* Accounting Tab */
                    <div className="space-y-4 animate-in fade-in duration-300">
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-[10px] font-black text-[#5c6567] uppercase tracking-widest flex items-center gap-2">
                                <BarChart3 size={14} className="text-[#1f8577]" /> GL Postings
                            </label>
                                <span className="text-[9px] font-black bg-[#eef7f6] text-[#0b3e39] px-1.5 py-0.5 rounded uppercase">Live Ledger</span>
                        </div>

                        <div className="space-y-3">
                            {ledger.filter(e => e.referenceId === payment.id).map(entry => (
                                    <div key={entry.id} className="p-4 bg-[#FEFDFB] border border-[#e4ddd1] rounded-2xl shadow-sm hover:border-[#a6d9d3] transition-all group">
                                    <div className="flex justify-between items-start mb-3">
                                        <div className="text-[11px] font-bold text-[#23282A] group-hover:text-[#0f544c] transition-colors">{entry.description}</div>
                                        <div className="text-[10px] font-black text-[#23282A]">{currency}{(entry.amount || 0).toLocaleString()}</div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="bg-[#eef7f6]/50 p-2 rounded-xl border border-[#e4ddd1]">
                                            <div className="text-[8px] font-black text-[#5c6567] uppercase mb-0.5">Debit</div>
                                            <div className="text-[10px] font-black text-[#1f8577] truncate">
                                                {accounts.find(a => a.id === entry.debitAccountId || a.code === entry.debitAccountId)?.name || entry.debitAccountId}
                                            </div>
                                        </div>
                                        <div className="bg-[#fef2f2] p-2 rounded-xl border border-[#e4ddd1]">
                                            <div className="text-[8px] font-black text-[#b5493f] uppercase mb-0.5">Credit</div>
                                            <div className="text-[10px] font-black text-[#b5493f] truncate">
                                                {accounts.find(a => a.id === entry.creditAccountId || a.code === entry.creditAccountId)?.name || entry.creditAccountId}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {ledger.filter(e => e.referenceId === payment.id).length === 0 && (
                                <div className="p-10 text-center text-[#5c6567] italic font-medium">No ledger entries found for this payment.</div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Actions */}
            <div className="p-4 border-t border-[#e4ddd1] bg-[#eef7f6]/50 flex flex-wrap gap-2 shrink-0">
                <button
                    onClick={() => onPreview(payment)}
                    className="flex-1 min-w-[120px] text-white px-3 py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 transition-all active:scale-95 shadow-sm" style={{ background: 'linear-gradient(155deg, #1f8577, #0f544c)' }}
                >
                    <Printer size={14} /> Preview Receipt
                </button>
                <button
                    onClick={() => {
                        if (payment.customerId) {
                            onStatement(payment.customerId, payment.customerName);
                        } else {
                            notify("No customer ID", "warning");
                        }
                    }}
                    className="flex-1 min-w-[120px] bg-[#FEFDFB] border border-[#e4ddd1] text-[#5c6567] px-3 py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[#eef7f6] transition-all active:scale-95 shadow-sm"
                >
                    <FileBarChart size={14} /> Customer Statement
                </button>
                <button
                    onClick={() => { onEdit(payment); onClose(); }}
                    className="flex-1 min-w-[120px] bg-[#FEFDFB] border border-[#e4ddd1] text-[#5c6567] px-3 py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[#eef7f6] hover:border-[#d4cdc2] transition-all active:scale-95 shadow-sm"
                >
                    <Edit2 size={14} /> Edit Details
                </button>
                {payment && (
                    <>
                        <button
                            onClick={() => copyVerificationLink('receipt', 'customerPayments', payment.id, payment.id)}
                            className="flex-1 min-w-[120px] bg-[#FEFDFB] border border-[#e4ddd1] text-[#5c6567] px-3 py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[#eef7f6] transition-all active:scale-95 shadow-sm"
                        >
                            <Link2 size={14} /> Copy Verification Link
                        </button>
                        <button
                            onClick={() => openVerificationLink('receipt', 'customerPayments', payment.id, payment.id)}
                            className="flex-1 min-w-[120px] bg-[#FEFDFB] border border-[#e4ddd1] text-[#5c6567] px-3 py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[#eef7f6] transition-all active:scale-95 shadow-sm"
                        >
                            <ExternalLink size={14} /> View Verification
                        </button>
                    </>
                )}
                {String(payment.status || '').toLowerCase() === 'voided' ? (
                    <button
                        onClick={() => {
                            if (confirm("Permanently delete this voided payment?\n\nThis removes the record completely and cannot be undone.")) {
                                onPurge(payment.id);
                                onClose();
                            }
                        }}
                        className="w-full bg-[#FEFDFB] border border-[#b5493f] text-[#b5493f] px-3 py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[#fef2f2] transition-all active:scale-95 shadow-sm"
                    >
                        <Trash2 size={14} /> Delete Permanently
                    </button>
                ) : (
                    <button
                        onClick={() => { onDelete(payment.id); onClose(); }}
                        className="w-full bg-[#FEFDFB] border border-[#e4ddd1] text-[#b5493f] px-3 py-2.5 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-[#fef2f2] transition-all active:scale-95 shadow-sm"
                    >
                        <Trash2 size={14} /> Void Payment
                    </button>
                )}
            </div>
        </div>
    );
};

/**
 * Payment method icon — visual recognition for Cash / Bank / Card /
 * Mobile Money / Wallet methods on the admin list.
 */
const PaymentMethodIcon: React.FC<{ method: string; size?: number }> = ({ method, size = 14 }) => {
    const m = String(method || '').toLowerCase();
    if (m.includes('card')) return <CreditCard size={size} />;
    if (m.includes('bank') || m.includes('transfer') || m.includes('cheque') || m.includes('check')) return <Landmark size={size} />;
    if (m.includes('mobile') || m.includes('momo') || m.includes('m-pesa') || m.includes('mpesa')) return <Smartphone size={size} />;
    if (m.includes('wallet')) return <Wallet size={size} />;
    if (m.includes('cash')) return <Banknote size={size} />;
    return <CircleDollarSign size={size} />;
};

const ALLOCATION_BADGE: Record<AllocationStatus, { label: string; className: string }> = {
    allocated: { label: 'Allocated', className: 'bg-[#eef7f6] text-[#0f544c] border-[#d3ece9]' },
    partial: { label: 'Partial', className: 'bg-[#fbead0] text-[#b97e2b] border-[#eec27a]' },
    unallocated: { label: 'Unallocated', className: 'bg-[#f1f5f9] text-[#5c6567] border-[#e4ddd1]' },
};

const PAYMENTS_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const Payments: React.FC = () => {
    const { refreshAllData } = useData();
    const { companyConfig, notify, user, allUsers } = useAuth();
    const { customerPayments, addCustomerPayment, updateCustomerPayment, deleteCustomerPayment, permanentlyDeleteCustomerPayment, customers, sales, addCustomer, updateCustomer } = useSales();
    const { invoices, updateInvoice, getDocumentVerificationToken } = useFinance();
    const { orders, recordPayment: recordOrderPayment } = useOrders();
    const { suppliers } = useProcurement();
    const { postJournalEntry, supplierPayments = [], recordSupplierPayment, updateSupplierPayment, voidSupplierPayment, accounts: coaAccounts } = useFinance();
    const { purchases = [] } = useProcurement();
    const { copyVerificationLink, openVerificationLink } = useDocumentVerificationLink();
    const { accounts: bankAccounts, fetchBankingData } = useBankingStore();
    const currency = companyConfig.currencySymbol;
    const location = useLocation();
    useHighlight();
    const navigate = useNavigate();

    const isProcurement = location.pathname.startsWith('/procurement');
    const [activeTab, setActiveTab] = useState<'Received' | 'Made'>(isProcurement ? 'Made' : 'Received');

    useEffect(() => {
        if (isProcurement) {
            setActiveTab('Made');
        } else {
            setActiveTab('Received');
        }
    }, [isProcurement]);

    const customerNames = useMemo(() => {
        const names = new Set<string>();
        // Use official customers list first
        customers?.forEach((c: any) => {
            if (c.name) names.add(c.name);
        });
        // Add names from invoices/customerPayments/orders just in case
        invoices?.forEach((inv: any) => {
            if (inv.customerName) names.add(inv.customerName);
        });
        orders?.forEach((o: any) => {
            if (o.customerName) names.add(o.customerName);
        });
        customerPayments?.forEach((payment: any) => {
            if (payment.customerName) names.add(payment.customerName);
        });
        // Add school name if redirected from examination module
        if (location.state?.isExamInvoice && location.state?.customer) {
            names.add(location.state.customer);
        }
        return Array.from(names).sort();
    }, [customers, invoices, customerPayments, location.state]);

    // State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editMode, setEditMode] = useState(false);
    const [currentId, setCurrentId] = useState<string | null>(null);
    const [searchTerm, setSearchTerm] = useState('');
    // --- Admin list upgrades: advanced filters / sorting / batch selection ---
    const [showListFilters, setShowListFilters] = useState(false);
    const [methodFilter, setMethodFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState('all');
    const [allocationFilter, setAllocationFilter] = useState<'all' | AllocationStatus>('all');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [minAmount, setMinAmount] = useState('');
    const [maxAmount, setMaxAmount] = useState('');
    const [invoiceRefFilter, setInvoiceRefFilter] = useState('');
    const [sortBy, setSortBy] = useState<PaymentSortKey>('date');
    const [sortDir, setSortDir] = useState<SortDir>('desc');
    const [listPage, setListPage] = useState(1);
    const [listPageSize, setListPageSize] = useState(25);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const [generatedId, setGeneratedId] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
    const hoverTimerRef = useRef<any | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const lastRefreshAtRef = useRef(0);

    const [selectedPayment, setSelectedPayment] = useState<CustomerPayment | null>(null);

    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [menuPos, setMenuPos] = useState<{ x: number, y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const [formData, setFormData] = useState<Partial<CustomerPayment>>({
        date: getDefaultDate(),
        customerName: '',
        subAccountName: 'Main',
        amount: 0,
        paymentMethod: 'Cash',
        accountId: '1000',
        reference: '',
        notes: '',
        bankCharges: 0,
        status: 'Cleared',
        reconciled: false,
        excessHandling: 'Change'
    });

    const [customerSearchTerm, setCustomerSearchTerm] = useState('');
    const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
    const customerDropdownRef = useRef<HTMLDivElement>(null);
    const [isClientModalOpen, setIsClientModalOpen] = useState(false);
 
    const [allocations, setAllocations] = useState<Array<{ invoiceId: string; orderId?: string; amount: number; [key: string]: any }>>([]);
    const [previewState, setPreviewState] = useState<{ isOpen: boolean, data: any, type: 'RECEIPT' | 'ACCOUNT_STATEMENT' | 'POS_RECEIPT' | 'SUPPLIER_PAYMENT' }>({
        isOpen: false,
        data: null,
        type: 'RECEIPT'
    });
    const [successModal, setSuccessModal] = useState<{ open: boolean; payment: CustomerPayment | null }>({ open: false, payment: null });

    useEffect(() => {
        fetchBankingData?.();
    }, [fetchBankingData]);

    const handlePreviewReceipt = async (payment: CustomerPayment) => {
        try {
            // Verification-QR hardening: the receipt QR must encode the
            // official receipt record's verification URL. Ensure the payment's
            // permanent token first (normal save path; never regenerates).
            let tokenedPayment: any = payment;
            if (payment?.id && !(payment as any).verificationToken && getDocumentVerificationToken) {
                try {
                    const token = await getDocumentVerificationToken('customerPayments', String(payment.id));
                    if (token) tokenedPayment = { ...(payment as any), verificationToken: token };
                } catch { /* offline-safe: legacy payload until synced */ }
            }
            // Check if this payment is linked to a POS sale.
            //
            // POS receipts must render through the POS receipt template, never
            // the general invoice template. Link detection therefore accepts
            // every shape processSale writes: `reference === sale.id`, the
            // split-payment variants (`POS-<saleId>`, `POS-<saleId>-<n>`) and
            // the `POS Sale #<id>` note. A POS payment that failed to match
            // would silently fall through to the RECEIPT/invoice branch below
            // and print the wrong document.
            const linkedSale = (() => {
                const reference = String(tokenedPayment.reference || '').trim();
                // Resolve against the real sale ids rather than parsing the
                // reference: Sale ids are generated with their own prefixes and
                // may themselves contain dashes/numbers (e.g. `POS-000123`,
                // `SALE-2026-0417`), so every `POS-…` shape cannot be decoded by
                // stripping a fixed prefix and suffix.
                const byId = (id: unknown) =>
                    id ? sales.find(s => String(s.id) === String(id)) || null : null;

                if (reference) {
                    const direct = byId(reference);
                    if (direct) return direct;
                    // Split payments: `POS-<saleId>` and `POS-<saleId>-<n>`.
                    const stripped = reference.replace(/^POS-/, '').replace(/-\d+$/, '');
                    const viaStripped = byId(stripped);
                    if (viaStripped) return viaStripped;
                    // Longest-prefix match covers sale ids that themselves
                    // start with POS- (double prefix: `POS-POS-000123-2`).
                    const prefixHit = sales.find(s => reference.startsWith(`${s.id}-`) || reference === `POS-${s.id}`);
                    if (prefixHit) return prefixHit;
                }

                // Note form: `POS Sale #<saleId> - Cash`. Match the sale id out
                // of the note by testing known ids, since the id may contain
                // the characters a character-class strip would eat.
                const note = String(tokenedPayment.notes || '');
                if (/pos\s+sale/i.test(note)) {
                    return sales.find(s => note.includes(`#${s.id}`)) || null;
                }
                return null;
            })();

            if (linkedSale) {
                const cashierUser = allUsers?.find(u => u.id === linkedSale.cashierId);
                const resolvedCashierName = cashierUser?.name || cashierUser?.fullName || cashierUser?.username || user?.name || 'Cashier';
                const previewData = buildPosReceiptDoc({
                    sale: linkedSale,
                    // The POS receipt is backed by this official receipt record.
                    receiptRef: {
                        receiptNumber: String(tokenedPayment.id),
                        ...(tokenedPayment.verificationToken ? { verificationToken: String(tokenedPayment.verificationToken) } : {}),
                    },
                    cashierName: resolvedCashierName,
                    customerName: linkedSale.customerName || 'Walk-in Customer',
                    footerMessage: companyConfig.transactionSettings?.pos?.receiptFooter || companyConfig.receiptFooter || '',
                    // Without this the doc builder falls back to a hard-coded
                    // company identity on the POS receipt payload.
                    companyConfig
                });
                
                // Validate required fields
                if (!previewData.receiptNumber) throw new Error('Missing receiptNumber');
                if (!previewData.date) throw new Error('Missing date');
                if (!previewData.items || previewData.items.length === 0) throw new Error('Missing or empty items array');
                
                const parsed = PosReceiptSchema.safeParse(previewData);
                if (!parsed.success) {
                    logger.error('POS receipt validation errors:', parsed.error.issues);
                    const message = parsed.error.issues[0]?.message || 'Invalid POS receipt payload';
                    throw new Error(`POS receipt validation failed: ${message}`);
                }

                setPreviewState({
                    isOpen: true,
                    type: 'POS_RECEIPT',
                    data: parsed.data
                });
            } else {
                const currentBalance = tokenedPayment.customerId
                    ? await paymentService.getCustomerOutstandingBalance(tokenedPayment.customerId)
                    : 0;

                const appliedOrders = (tokenedPayment as any).orderAllocations?.map((a: any) => a.orderId) || [];
                const formattedData = buildCustomerReceiptDoc({
                    payment: tokenedPayment,
                    customerName: tokenedPayment.customerName,
                    currentBalance,
                    currencySymbol: currency,
                    appliedOrders
                });
                
                // Validate required fields
                if (!formattedData.receiptNumber) throw new Error('Missing receiptNumber');
                if (!formattedData.date) throw new Error('Missing date');
                if (!formattedData.customerName) throw new Error('Missing customerName');
                
                const parsed = ReceiptSchema.safeParse(formattedData);
                if (!parsed.success) {
                    logger.error('Customer receipt validation errors:', parsed.error.issues);
                    const message = parsed.error.issues[0]?.message || 'Invalid receipt payload';
                    throw new Error(`Customer receipt validation failed: ${message}`);
                }

                setPreviewState({
                    isOpen: true,
                    type: 'RECEIPT',
                    data: parsed.data
                });
            }
        } catch (err) {
            logger.error('Failed to open receipt preview:', err);
            const errorMessage = err instanceof Error ? err.message : String(err);
            notify(`Failed to generate receipt preview: ${errorMessage}`, "error");
        }
    };

    const handlePreviewStatement = async (customerId: string, customerName: string) => {
        try {
            // Use current month as default range
            const end = new Date();
            const start = new Date(end.getFullYear(), end.getMonth(), 1);

            const startDate = start.toISOString().split('T')[0];
            const endDate = end.toISOString().split('T')[0];

            const entries = await paymentService.getCustomerLedger(customerId, startDate, endDate);

            // Calculate opening balance (balance before the selected range)
            const allEntriesBefore = await paymentService.getCustomerLedger(customerId, '1970-01-01', new Date(start.getTime() - 86400000).toISOString().split('T')[0]);
            const openingBalance = allEntriesBefore.reduce((sum, e) => sum + (e.debit - e.credit), 0);

            let currentRunningBalance = openingBalance;
            const transactions = entries.map(e => {
                currentRunningBalance += (e.debit - e.credit);
                return {
                    date: new Date(e.date).toLocaleDateString('en-GB'),
                    reference: e.reference_no,
                    memo: e.memo || (e.debit > 0 ? 'Invoice' : 'Payment'),
                    debit: e.debit,
                    credit: e.credit,
                    runningBalance: currentRunningBalance
                };
            });

            const totalDebits = entries.reduce((s, e) => s + e.debit, 0);
            const totalCredits = entries.reduce((s, e) => s + e.credit, 0);

            // Freeze an immutable snapshot: the QR verifies THIS statement,
            // never the customer's live balance.
            const snapshot = await createStatementSnapshot({
                customerId,
                customerName,
                periodStart: startDate,
                periodEnd: endDate,
                currency,
                openingBalance,
                transactions,
                totalInvoiced: totalDebits,
                totalReceived: totalCredits,
                closingBalance: currentRunningBalance
            }, companyConfig);

            setPreviewState({
                isOpen: true,
                type: 'ACCOUNT_STATEMENT',
                data: {
                    ...snapshot,
                    date: snapshot.statementDate,
                    documentType: 'statement',
                    startDate: snapshot.periodStart,
                    endDate: snapshot.periodEnd,
                    finalBalance: snapshot.closingBalance
                }
            });
            notify(`Statement ${snapshot.statementNumber} issued`, "success");
        } catch (err) {
            logger.error('Failed to generate statement:', err);
            notify("Failed to generate statement preview", "error");
        }
    };

    // Supplier Payment State
    const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);
    const [supplierEditMode, setSupplierEditMode] = useState(false);
    const [currentSupplierPaymentId, setCurrentSupplierPaymentId] = useState<string | null>(null);
    const [supplierFormData, setSupplierFormData] = useState<Partial<SupplierPayment>>({
        date: getDefaultDate(),
        supplierId: '',
        amount: 0,
        paymentMethod: 'Cash',
        accountId: '1000',
        reference: '',
        notes: '',
        status: 'Cleared',
        reconciled: false
    });
    const [supplierAllocations, setSupplierAllocations] = useState<PurchaseAllocation[]>([]);
    const [selectedSupplierPayment, setSelectedSupplierPayment] = useState<SupplierPayment | null>(null);

    // Universal clickable transaction references: receipts / payments / supplier
    // payments opened from statements, reports, ledgers and search results.
    const txRef = useTransactionRefTarget();
    const txRefKey = transactionRefKey(txRef);
    const lastTxRefKeyRef = useRef('');

    useEffect(() => {
        if (!txRef || !txRefKey || txRefKey === lastTxRefKeyRef.current) return;

        const isSupplierRef = txRef.type === 'supplier-payment';
        if (isProcurement !== isSupplierRef) return;

        const collection = isSupplierRef ? supplierPayments : customerPayments;
        if (collection === undefined || collection === null) return;

        const outcome = openTransactionRef(collection as any[], txRef);
        if (outcome.status === 'none') return;

        if (outcome.status === 'ok' && outcome.record) {
            if (isSupplierRef) setSelectedSupplierPayment(outcome.record as SupplierPayment);
            else setSelectedPayment(outcome.record as CustomerPayment);
        }
        lastTxRefKeyRef.current = txRefKey;
        if (outcome.status === 'missing' || outcome.status === 'ambiguous') {
            notify(transactionRefUnavailableMessage(outcome), 'error');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [txRefKey, isProcurement, customerPayments, supplierPayments]);

    const handleContextMenu = (e: React.MouseEvent, id: string) => {
        e.preventDefault();
        e.stopPropagation();
        const x = Math.min(e.clientX, window.innerWidth - 220);
        const y = Math.min(e.clientY, window.innerHeight - 250);
        setMenuPos({ x, y });
        setOpenMenuId(id);
    };

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setOpenMenuId(null);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const refreshModuleData = React.useCallback(async (force = false) => {
        const now = Date.now();
        if (!force && now - lastRefreshAtRef.current < 1200) {
            return;
        }

        lastRefreshAtRef.current = now;
        setIsRefreshing(true);
        try {
            await refreshAllData?.();
        } finally {
            setIsRefreshing(false);
        }
    }, [refreshAllData]);

    useEffect(() => {
        const handleWindowFocus = () => {
            refreshModuleData().catch(() => undefined);
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                refreshModuleData().catch(() => undefined);
            }
        };

        window.addEventListener('focus', handleWindowFocus);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            window.removeEventListener('focus', handleWindowFocus);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [refreshModuleData]);

    const excessAmount = useMemo(() => {
        // Coerce like the trim effect below: allocation amounts originate from
        // `<input type="number">`, so they can be strings. Summing them raw made
        // `s + a.amount` concatenate, reporting a bogus excess (and hiding a
        // genuine one) as soon as two allocations were present.
        const totalAllocated = allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0);
        return Math.max(0, (Number(formData.amount) || 0) - totalAllocated);
    }, [formData.amount, allocations]);

    // Allow partial payments: if the user reduces the payment amount below the
    // currently allocated total, trim allocations proportionally so the save
    // does not fail with "allocations exceed payment amount".
    useEffect(() => {
        const paymentAmount = Number(formData.amount) || 0;
        const totalAllocated = allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0);

        if (paymentAmount < 0.01 || allocations.length === 0) return;
        if (totalAllocated <= paymentAmount + 0.01) return;

        let remaining = paymentAmount;
        const trimmed = allocations.map(a => {
            const due = Number(a.amount) || 0;
            const take = Math.min(due, remaining);
            remaining -= take;
            return { ...a, amount: take };
        });

        setAllocations(trimmed);
    }, [formData.amount, allocations.length]);

    const modalOpenedRef = useRef(false);

    useEffect(() => {
        if (location.state?.action === 'create' && !modalOpenedRef.current) {
            // Mark as handled to prevent automatic re-opening on re-renders
            modalOpenedRef.current = true;
            resetForm();
            if (location.state.customer || location.state.customerId) {
                const customer = location.state.customer
                    ? customers.find((c: any) => c.name === location.state.customer)
                    : null;
                const customerById = location.state.customerId
                    ? customers.find((c: any) => c.id === location.state.customerId)
                    : null;
                const matchedCustomer = customer || customerById;
                const customerName = matchedCustomer?.name || location.state.customer || '';
                const customerId = matchedCustomer?.id || location.state.customerId || '';

                setFormData(prev => ({
                    ...prev,
                    customerName,
                    customerId,
                    subAccountName: location.state.subAccount || 'Main',
                    excessHandling: location.state.isTopUp ? 'Wallet' : 'Change',
                    notes: location.state.isTopUp ? `Wallet Top-up for ${location.state.subAccount || 'Main'}` : (location.state.isExamInvoice ? `Payment for Examination Invoice ${location.state.invoiceId}` : location.state.orderId ? `Payment for Order ${location.state.orderId}` : ''),
                    amount: location.state.isExamInvoice ? location.state.amount : 0
                }));

                // If redirected from "Save and Pay Now" or Examination module or Customer Workspace
                if (location.state.isExamInvoice && location.state.invoiceId) {
                    // For Exam Invoices, we don't have them in the main invoices context
                    // We just set the amount and a virtual allocation
                    setAllocations([{
                        invoiceId: location.state.invoiceId,
                        amount: location.state.amount
                    }]);
                } else if (!location.state.isTopUp) {
                    // Mirror `availableInvoices` exactly: the prefill total and the
                    // pre-allocated amounts must not include documents the modal
                    // would then refuse to show, otherwise the header amount and
                    // the allocation table disagree on open.
                    const unpaid = invoices.filter(i =>
                        (i.customerName === customerName || i.customerId === customerId) &&
                        i.status !== 'Paid' &&
                        i.status !== 'Draft' &&
                        i.status !== 'Cancelled' &&
                        i.status !== 'Void'
                    );
                    const unpaidOrders = orders.filter(o =>
                        (o.customerName === customerName || o.customerId === customerId) &&
                        isOrderPaymentEligible(o)
                    );
                    const invoiceDue = (i: any) => Math.max(0, (Number(i.totalAmount) || 0) - (Number(i.paidAmount) || 0));
                    const totalDue = unpaid.reduce((s, i) => s + invoiceDue(i), 0) +
                        unpaidOrders.reduce((s, o) => s + getOrderOutstanding(o), 0);

                    setFormData(prev => ({ ...prev, amount: roundFinancial(totalDue) }));

                    const initialAllocations = [
                        ...unpaid.map(i => ({ invoiceId: i.id, amount: invoiceDue(i) })),
                        ...unpaidOrders.map(o => ({ invoiceId: '', orderId: o.id, amount: getOrderOutstanding(o) }))
                    ];

                    // If a specific invoiceId was provided, only allocate to that invoice
                    if (location.state.invoiceId) {
                        const specificUnpaid = unpaid.filter(i => i.id === location.state.invoiceId);
                        if (specificUnpaid.length > 0) {
                            setAllocations(specificUnpaid.map(i => ({
                                invoiceId: i.id,
                                amount: invoiceDue(i)
                            })));
                            setFormData(prev => ({
                                ...prev,
                                amount: roundFinancial(invoiceDue(specificUnpaid[0]))
                            }));
                        } else {
                            setAllocations(initialAllocations);
                        }
                    } else if (location.state.orderId) {
                        const specificOrder = unpaidOrders.filter(o => o.id === location.state.orderId);
                        if (specificOrder.length > 0) {
                            setAllocations(specificOrder.map(o => ({
                                invoiceId: '',
                                orderId: o.id,
                                amount: getOrderOutstanding(o)
                            })));
                            setFormData(prev => ({
                                ...prev,
                                amount: roundFinancial(getOrderOutstanding(specificOrder[0]))
                            }));
                        } else {
                            setAllocations(initialAllocations);
                        }
                    } else {
                        setAllocations(initialAllocations);
                    }
                }
            }
            setIsModalOpen(true);
            
            // Clear the location state to prevent the modal from reopening on re-renders
            navigate(location.pathname, { replace: true, state: {} });
        }
        
        // Reset the flag when navigating away from the page
        return () => {
            if (!location.state?.action) {
                modalOpenedRef.current = false;
            }
        };
    }, [location, invoices, orders]);

    const resetForm = () => {
        const nextId = generateNextId('pay', customerPayments, companyConfig);
        setGeneratedId(nextId);
        setFormData({
            date: getDefaultDate(),
            customerName: '',
            customerId: '',
            subAccountName: 'Main',
            amount: 0,
            paymentMethod: 'Cash',
            accountId: '1000',
            reference: '',
            notes: '',
            bankCharges: 0,
            status: 'Cleared',
            reconciled: false,
            excessHandling: 'Change'
        });
        setAllocations([]); setEditMode(false); setCurrentId(null);
    };

    const handleOpenCreate = () => { resetForm(); setIsModalOpen(true); };

    const handleSave = async () => {
        if (isSubmitting) return;
        if (!formData.customerName || !formData.amount) {
            notify("Please complete all required fields.", "error");
            return;
        }

        setIsSubmitting(true);
        try {
            if (formData.paymentMethod === 'Wallet') {
                const cust = customers.find((c: any) => c.name === formData.customerName);
                const walletBal = cust?.walletBalance || 0;
                if (Number(formData.amount) > walletBal) {
                    notify(`Insufficient wallet balance. Available: ${currency}${walletBal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`, "error");
                    setIsSubmitting(false);
                    return;
                }
            }

            const dateError = validateDateInFY(formData.date || '');
            if (dateError) {
                notify(dateError, "error");
                setIsSubmitting(false);
                return;
            }

            let finalAllocations = [...allocations];
            const paymentAmount = Number(formData.amount);

            // Auto-allocate if no allocations exist but there are available documents
            if (finalAllocations.length === 0 && (availableInvoices.length > 0 || availableOrders.length > 0) && paymentAmount > 0) {
                let remaining = paymentAmount;
                const combined = [
                    ...availableInvoices.map(i => ({ ...i, docType: 'invoice' as const })),
                    ...availableOrders.map(o => ({ ...o, docType: 'order' as const }))
                ].sort((a, b) => {
                    const da = (a as any).orderDate || (a as any).date;
                    const db = (b as any).orderDate || (b as any).date;
                    return new Date(da).getTime() - new Date(db).getTime();
                });

                for (const doc of combined) {
                    if (remaining <= 0) break;
                    const due = doc.docType === 'order'
                        ? getOrderOutstanding(doc)
                        : Math.max(0, (Number((doc as any).totalAmount) || 0) - (Number((doc as any).paidAmount) || 0));
                    const amt = Math.min(remaining, due);
                    if (amt > 0) {
                        if (doc.docType === 'invoice') {
                            finalAllocations.push({ invoiceId: doc.id, amount: amt });
                        } else {
                            finalAllocations.push({ invoiceId: '', orderId: doc.id, amount: amt });
                        }
                        remaining -= amt;
                    }
                }
            }

            // Regenerate ID to prevent collisions (unless editing)
            const finalId = (editMode && currentId) ? currentId : generateNextId('pay', customerPayments, companyConfig);

            const invoiceAllocations = finalAllocations.filter(a => a.invoiceId && !a.orderId && a.amount > 0);
            const orderAllocations = finalAllocations.filter(a => a.orderId && a.amount > 0);
            const newPayment = {
                ...formData,
                date: formData.date!,
                id: finalId,
                allocations: invoiceAllocations.map(a => ({ invoiceId: a.invoiceId, amount: a.amount })),
                amount: paymentAmount,
                customerName: formData.customerName!,
                paymentMethod: formData.paymentMethod!,
                status: formData.status,
                reconciled: formData.reconciled || false,
                excessAmount: excessAmount > 0 ? excessAmount : undefined,
                excessHandling: excessAmount > 0 ? formData.excessHandling : undefined,
                orderAllocations: orderAllocations.map(a => ({ orderId: a.orderId!, amount: a.amount }))
            };

            if (editMode) {
                const existing = customerPayments.find(p => p.id === finalId);
                if (!existing) {
                    notify(`Payment ${finalId} not found for update.`, "error");
                    return;
                }

                const metadataOnlyUpdate: CustomerPayment = {
                    ...existing,
                    reference: formData.reference || '',
                    notes: formData.notes || '',
                    status: formData.status || existing.status,
                    reconciled: formData.reconciled ?? existing.reconciled,
                    bankCharges: formData.bankCharges ?? existing.bankCharges,
                    subAccountName: formData.subAccountName || existing.subAccountName
                };

                await updateCustomerPayment(metadataOnlyUpdate);
            } else {
                await addCustomerPayment(newPayment as CustomerPayment);
            }

            // Process order allocations - record payment against each order.
            // `recordOrderPayment` already maintains paidAmount/remainingBalance
            // and derives paymentStatus, so the previous follow-up
            // `updateOrderStatus(orderId, 'Paid' | 'Partially Paid')` was
            // redundant. It also fed legacy payment-only strings into a
            // workflow-status API, where they canonicalize to 'Confirmed' and
            // trip the terminal-transition guard — aborting the save after the
            // customer payment had already been posted.
            for (const alloc of orderAllocations) {
                const order = orders.find(o => o.id === alloc.orderId);
                if (!order) continue;
                await recordOrderPayment(alloc.orderId, {
                    id: `OP-${Date.now()}-${alloc.orderId}`,
                    orderId: alloc.orderId,
                    amountPaid: alloc.amount,
                    paymentDate: formData.date || new Date().toISOString(),
                    paymentMethod: formData.paymentMethod || 'Cash',
                    recordedBy: user?.name || 'System',
                    reference: formData.reference || `Payment via ${finalId}`
                });
            }

            // Show success modal first — then user chooses to preview
            if (!editMode) {
                const postedPayment = (await dbService.get<CustomerPayment>('customerPayments', newPayment.id)) || (newPayment as CustomerPayment);
                setSuccessModal({ open: true, payment: postedPayment });
            }

            // Handle Examination Invoice payment sync
            if (location.state?.isExamInvoice && location.state?.sqliteInvoiceId) {
                try {
                    await api.production.payExamInvoice(
                        location.state.sqliteInvoiceId,
                        formData.paymentMethod || 'Cash'
                    );
                } catch (err) {
                    logger.error('Failed to sync payment to exam module:', err);
                }
            }

            setIsModalOpen(false);
            notify(
                editMode
                    ? `Payment ${newPayment.id} metadata updated successfully.`
                    : `Payment ${newPayment.id} processed successfully.`,
                "success"
            );
        } catch (err: any) {
            logger.error('Payment save failed:', err);
            notify(err?.message || "Failed to save payment.", "error");
        } finally {
            setIsSubmitting(false);
        }
    };

    const filteredCustomers = useMemo(() => {
        const term = (customerSearchTerm || '').toLowerCase().trim();
        if (!term) return customers || [];
        return (customers || []).filter((c: any) =>
            getCustomerOptionLabel(c).toLowerCase().includes(term) ||
            (c.name || '').toLowerCase().includes(term) ||
            (c.id || '').toLowerCase().includes(term) ||
            (c.phone || '').toLowerCase().includes(term)
        );
    }, [customers, customerSearchTerm]);

    const availableInvoices = useMemo(() => {
        if (!formData.customerName) return [];

        // Filter invoices by customer and sub-account
        const baseInvoices = invoices.filter(i => {
            // Check customer name match
            const customerMatch = i.customerName === formData.customerName;

            // Check sub-account match
            const subAccountMatch = !formData.subAccountName ||
                formData.subAccountName === 'Main' ||
                i.subAccountName === formData.subAccountName;

            // Check status
            const statusMatch = i.status !== 'Paid' &&
                i.status !== 'Draft' &&
                i.status !== 'Cancelled' &&
                i.status !== 'Void';

            return customerMatch && subAccountMatch && statusMatch;
        });

        // Inject exam invoice if applicable (only if it matches sub-account context)
        if (location.state?.isExamInvoice && formData.customerName === location.state.customer) {
            const examInvoiceId = location.state.invoiceId;
            if (!baseInvoices.find(i => i.id === examInvoiceId)) {
                // Check if exam invoice should be included based on sub-account
                const shouldIncludeExam = !formData.subAccountName ||
                    formData.subAccountName === 'Main' ||
                    location.state.subAccount === formData.subAccountName;

                if (shouldIncludeExam) {
                    baseInvoices.push({
                        id: examInvoiceId,
                        customerName: location.state.customer,
                        totalAmount: location.state.amount,
                        paidAmount: 0,
                        status: 'Unpaid',
                        date: new Date().toISOString(),
                        dueDate: new Date().toISOString(),
                        items: [],
                        subAccountName: location.state.subAccount || 'Main'
                    } as Invoice);
                }
            }
        }
        return baseInvoices;
    }, [invoices, formData.customerName, formData.subAccountName, location.state]);

    /**
     * Orders that can still be settled by a customer payment.
     *
     * Eligibility is status-aware via `isOrderPaymentEligible`. The previous
     * `o.status === 'Processing'` literal was the regression: `orders` comes
     * from `useOrders()`, which serves the legacy projection of canonical sales
     * orders, and that projection rewrites `status` to 'Paid' / 'Partially Paid'
     * / 'Converted' as soon as an order is invoiced or partially paid. Matching
     * the literal therefore hid almost every genuinely payable order.
     *
     * Customer matching accepts either the id or the display name so an order
     * saved under the legacy customer name still matches the picker, which
     * stores the business display name.
     */
    const availableOrders = useMemo(() => {
        if (!formData.customerName && !formData.customerId) return [];

        return orders.filter(o => {
            const customerMatch = (!!formData.customerId && o.customerId === formData.customerId)
                || o.customerName === formData.customerName;
            const subAccountMatch = !formData.subAccountName ||
                formData.subAccountName === 'Main' ||
                o.subAccountName === formData.subAccountName;
            return customerMatch && subAccountMatch && isOrderPaymentEligible(o);
        });
    }, [orders, formData.customerId, formData.customerName, formData.subAccountName]);

    const handleAutoAllocate = () => {
        let remaining = Number(formData.amount);
        const newAllocations: Array<{ invoiceId: string; orderId?: string; amount: number; [key: string]: any }> = [];
        const combined = [
            ...availableInvoices.map(i => ({ ...i, docType: 'invoice' as const })),
            ...availableOrders.map(o => ({ ...o, docType: 'order' as const }))
        ].sort((a, b) => {
            const da = (a as any).orderDate || (a as any).date;
            const db = (b as any).orderDate || (b as any).date;
            return new Date(da).getTime() - new Date(db).getTime();
        });

        for (const doc of combined) {
            if (remaining <= 0) break;
            const due = doc.docType === 'order'
                ? getOrderOutstanding(doc)
                : Math.max(0, (Number((doc as any).totalAmount) || 0) - (Number((doc as any).paidAmount) || 0));
            const amt = Math.min(remaining, due);
            if (doc.docType === 'invoice') {
                newAllocations.push({ invoiceId: doc.id, amount: amt });
            } else {
                newAllocations.push({ invoiceId: '', orderId: doc.id, amount: amt });
            }
            remaining -= amt;
        }
        setAllocations(newAllocations);
    };

    const handleMouseEnter = (id: string, e: React.MouseEvent) => {
        const { clientX, clientY } = e;
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(() => {
            setHoveredId(id);
            setHoverPos({ x: clientX, y: clientY });
        }, 800);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (hoveredId) setHoveredId(null);
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };

    const handleMouseLeave = () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        setHoveredId(null);
    };

    // --- Upgraded list pipeline: advanced filter -> sort -> paginate ---
    const listFilters = useMemo(() => ({
        search: searchTerm,
        method: methodFilter,
        status: statusFilter,
        allocation: allocationFilter,
        dateFrom,
        dateTo,
        minAmount: minAmount === '' ? '' as const : Number(minAmount),
        maxAmount: maxAmount === '' ? '' as const : Number(maxAmount),
        invoiceId: invoiceRefFilter,
    }), [searchTerm, methodFilter, statusFilter, allocationFilter, dateFrom, dateTo, minAmount, maxAmount, invoiceRefFilter]);

    const filteredPaymentsAll = useMemo(
        () => sortCustomerPayments(filterCustomerPayments(customerPayments || [], listFilters as never), sortBy, sortDir),
        [customerPayments, listFilters, sortBy, sortDir],
    );

    const paymentSummary = useMemo(() => summarizePayments(filteredPaymentsAll as never), [filteredPaymentsAll]);

    const methodOptions = useMemo(() => {
        const set = new Set<string>();
        (customerPayments || []).forEach((p: never) => set.add(getPaymentMethodKey(p as never)));
        return Array.from(set).sort();
    }, [customerPayments]);

    const statusOptions = useMemo(() => {
        const set = new Set<string>();
        (customerPayments || []).forEach((p: never) => { if ((p as { status?: string }).status) set.add(String((p as { status?: string }).status)); });
        return Array.from(set).sort();
    }, [customerPayments]);

    const pagedPayments = useMemo(
        () => paginateList(filteredPaymentsAll, listPage, listPageSize),
        [filteredPaymentsAll, listPage, listPageSize],
    );
    const filteredPayments = pagedPayments.rows;

    const hasActiveListFilters = Boolean(
        searchTerm || methodFilter !== 'all' || statusFilter !== 'all' || allocationFilter !== 'all' ||
        dateFrom || dateTo || minAmount !== '' || maxAmount !== '' || invoiceRefFilter,
    );

    const clearListFilters = () => {
        setSearchTerm('');
        setMethodFilter('all');
        setStatusFilter('all');
        setAllocationFilter('all');
        setDateFrom('');
        setDateTo('');
        setMinAmount('');
        setMaxAmount('');
        setInvoiceRefFilter('');
        setListPage(1);
    };

    // Reset to first page + drop selections that are no longer visible.
    useEffect(() => {
        setListPage(1);
    }, [searchTerm, methodFilter, statusFilter, allocationFilter, dateFrom, dateTo, minAmount, maxAmount, invoiceRefFilter, sortBy, sortDir, listPageSize]);

    useEffect(() => {
        setSelectedIds((prev) => prev.filter((id) => filteredPaymentsAll.some((p) => p.id === id)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filteredPaymentsAll.length]);

    // Keyboard shortcut: "/" focuses the list search.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (e.key === '/' && activeTab === 'Received' && target && !/INPUT|TEXTAREA|SELECT/.test(target.tagName)) {
                e.preventDefault();
                searchInputRef.current?.focus();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [activeTab]);

    const toggleSelectAllVisible = () => {
        const visibleIds = filteredPayments.map((p) => p.id);
        const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
        setSelectedIds(allSelected ? selectedIds.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...selectedIds, ...visibleIds])));
    };

    const toggleSelectOne = (id: string) => {
        setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    };

    const handleExportFilteredCsv = () => {
        const rows = selectedIds.length > 0
            ? filteredPaymentsAll.filter((p) => selectedIds.includes(p.id))
            : filteredPaymentsAll;
        downloadCsv(`customer-payments-${new Date().toISOString().slice(0, 10)}.csv`, paymentsToCsv(rows as never));
        notify(`Exported ${rows.length} payment${rows.length === 1 ? '' : 's'} to CSV.`, 'success');
    };

    const handleBatchVoidSelected = async () => {
        if (selectedIds.length === 0) return;
        if (!confirm(`Void ${selectedIds.length} selected payment${selectedIds.length === 1 ? '' : 's'}?`)) return;
        let ok = 0;
        for (const id of selectedIds) {
            try {
                await deleteCustomerPayment(id);
                ok += 1;
            } catch { /* per-row errors already notified */ }
        }
        setSelectedIds([]);
        notify(`Voided ${ok} of ${selectedIds.length} payments.`, ok > 0 ? 'success' : 'error');
    };

    const hoveredPayment = useMemo(() => (customerPayments || []).find(payment => payment.id === hoveredId), [customerPayments, hoveredId]);

    const renderContextMenu = () => {
        if (!openMenuId || !menuPos) return null;
        const payment = customerPayments.find(payment => payment.id === openMenuId);
        if (!payment) return null;

        // Calculate optimal position to keep menu fully visible
        const menuWidth = 208; // w-52 = 208px
        const menuHeight = 200; // Estimated height for all menu items
        
        let x = menuPos.x;
        let y = menuPos.y;
        
        // Adjust horizontal position if menu would go off-screen
        if (x + menuWidth > window.innerWidth) {
            x = Math.max(0, window.innerWidth - menuWidth);
        }
        
        // Adjust vertical position if menu would go off-screen
        if (y + menuHeight > window.innerHeight) {
            y = Math.max(0, window.innerHeight - menuHeight);
        }

        return (
            <div
                ref={menuRef}
                className="fixed w-52 bg-[#FEFDFB]/95 backdrop-blur-xl rounded-xl shadow-premium border border-[#e4ddd1] z-[110] animate-in fade-in zoom-in-95 duration-100 flex flex-col py-1.5 overflow-y-auto custom-scrollbar"
                style={{ top: y, left: x, maxHeight: '90vh' }}
            >
                <div className="px-3 py-1 mb-1 border-b border-[#e4ddd1]">
                    <p className="text-[10px] font-bold text-[#5c6567] uppercase tracking-tight">Payment Options</p>
                </div>
                <button onClick={() => { setOpenMenuId(null); notify("Remittance email queued.", "success"); }} className="w-full text-left px-4 py-2 text-xs font-medium text-[#23282A] hover:bg-[#eef7f6] hover:text-[#1f8577] flex items-center gap-3 transition-colors">
                    <Mail size={14} /> Email Remittance
                </button>
                <div className="h-px bg-[#e4ddd1] my-1"></div>
                {String(payment.status || '').toLowerCase() === 'voided' ? (
                    <button onClick={() => { if (confirm("Permanently delete this voided payment?\n\nThis removes the record completely and cannot be undone.")) { permanentlyDeleteCustomerPayment(payment.id).then(() => notify("Voided payment deleted permanently.", "info")).catch(() => {}); } setOpenMenuId(null); }} className="w-full text-left px-4 py-2 text-xs font-medium text-[#b5493f] hover:bg-[#fef2f2] flex items-center gap-3 transition-colors">
                        <Trash2 size={14} /> Delete Permanently
                    </button>
                ) : (
                    <button onClick={() => { if (confirm("Void this payment?")) { deleteCustomerPayment(payment.id).catch(() => {}); } setOpenMenuId(null); }} className="w-full text-left px-4 py-2 text-xs font-medium text-[#b5493f] hover:bg-[#fef2f2] flex items-center gap-3 transition-colors">
                        <Trash2 size={14} /> Void Payment
                    </button>
                )}
            </div>
        );
    };

    return (
        <div className="p-3 md:p-6 max-w-[1600px] mx-auto h-[calc(100vh-4rem)] flex flex-col relative">
            {renderContextMenu()}

            {hoveredId && hoverPos && activeTab === 'Received' && customerPayments.find(payment => payment.id === hoveredId) && (
                <CustomerPaymentHoverCard pos={hoverPos} payment={customerPayments.find(payment => payment.id === hoveredId)!} />
            )}

            {hoveredId && hoverPos && activeTab === 'Made' && supplierPayments.find(p => p.id === hoveredId) && (
                <SupplierPaymentHoverCard pos={hoverPos} payment={supplierPayments.find(p => p.id === hoveredId)!} />
            )}

            <div className="mb-4 flex flex-col md:flex-row justify-between md:items-center gap-4 shrink-0">
                <div>
                    <h1 className="text-[22px] font-semibold text-[#23282A] flex items-center gap-2 tracking-tight">
                        <PaymentIcon className="text-[#1f8577]" size={20} /> 
                        {isProcurement ? 'Supplier Payments' : 'Customer Payments'}
                    </h1>
                    <p className="text-xs font-normal text-[#5c6567] mt-0.5">
                        {isProcurement ? 'Record and manage payments made to your suppliers.' : 'Process and track payments received from your customers.'}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => refreshModuleData(true).catch(() => undefined)}
                        disabled={isRefreshing}
                        className="flex items-center gap-2 rounded-xl border border-[#e4ddd1] bg-[#FEFDFB] px-3 py-1.5 text-xs font-bold text-[#5c6567] shadow-sm transition-all hover:bg-[#eef7f6] disabled:cursor-not-allowed disabled:opacity-60"
                        title="Refresh invoicing and billing data"
                    >
                        <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
                        Refresh
                    </button>
                    <button
                        onClick={activeTab === 'Received' ? handleOpenCreate : () => setIsSupplierModalOpen(true)}
                        className="bg-[#1f8577] text-white px-3 py-1.5 rounded-xl font-bold text-xs flex items-center gap-2 hover:bg-[#146b60] shadow-sm transition-all"
                    >
                        <Plus size={14} /> {activeTab === 'Received' ? 'New Payment' : 'New Supplier Payment'}
                    </button>
                </div>
            </div>

            {/* Tab switcher removed for separated flows */}

            {activeTab === 'Received' ? (
                <>
                    {isModalOpen && (
                        <div
                            style={{
                                position:'fixed', inset:0, zIndex:9999,
                                display:'flex', alignItems:'center', justifyContent:'center',
                                background:'rgba(15,23,42,.6)',
                                padding:'40px 20px', fontFamily:"'Inter','DM Sans',sans-serif", fontSize:13.5, color:'#23282A',
                            }}
                            onClick={(e) => { if (e.target === e.currentTarget) { modalOpenedRef.current = false; setIsModalOpen(false); } }}
                        >
                            <div style={{
                                width:960, maxWidth:'100%', maxHeight:'92vh',
                                background:'#FEFDFB', borderRadius:14,
                                boxShadow:'0 30px 70px -20px rgba(0,0,0,.55), 0 8px 24px -8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04)',
                                display:'flex', flexDirection:'column', overflow:'hidden', position:'relative'
                            }}>
                                <div style={{
                                    position:'absolute', top:0, left:0, right:0, height:4,
                                    background:'linear-gradient(90deg,#146b60,#3fa294 40%,#d99a3f 100%)'
                                }} />
                                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 18px 14px', borderBottom:'1px solid #e4ddd1' }}>
                                    <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                                        <div style={{
                                            width:40, height:40, borderRadius:10,
                                            background:'linear-gradient(155deg,#1f8577,#0f544c)',
                                            display:'flex', alignItems:'center', justifyContent:'center',
                                            boxShadow:'0 4px 10px -3px rgba(15,84,76,.6)', flexShrink:0
                                        }}>
                                            <PaymentIcon size={19} color="#fff" />
                                        </div>
                                        <div>
                                            <h1 style={{ fontFamily:"'DM Serif Display','Georgia',serif", fontWeight:400, fontSize:22, margin:0, color:'#0b3e39', letterSpacing:0.2 }}>Record Customer Payment</h1>
                                            <p style={{ margin:'2px 0 0', fontSize:11.5, color:'#5c6567', letterSpacing:0.02 }}>Process payment and allocate to invoices or orders</p>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            modalOpenedRef.current = false;
                                            setIsModalOpen(false);
                                        }}
                                        style={{
                                            width:32, height:32, borderRadius:8,
                                            border:'1px solid #e4ddd1', background:'#FEFDFB', color:'#5c6567',
                                            display:'flex', alignItems:'center', justifyContent:'center',
                                            cursor:'pointer', transition:'all .15s ease'
                                        }}
                                        onMouseEnter={e => { e.currentTarget.style.background = '#eef7f6'; e.currentTarget.style.color = '#0f544c'; e.currentTarget.style.borderColor = '#a6d9d3'; }}
                                        onMouseLeave={e => { e.currentTarget.style.background = '#FEFDFB'; e.currentTarget.style.color = '#5c6567'; e.currentTarget.style.borderColor = '#e4ddd1'; }}
                                    ><X size={15} /></button>
                                </div>

                                <div style={{ display:'flex', flex:1, minHeight:0 }}>
                                    <div style={{ width:310, background:'#eef7f6', padding:'18px 20px 16px', borderRight:'1px solid #e4ddd1', display:'flex', flexDirection:'column', flexShrink:0, overflowY:'auto' }}>
                                        {editMode && (
                                            <div style={{ padding:'8px 12px', background:'#fbead0', border:'1px solid #eec27a', borderRadius:8, marginBottom:8 }}>
                                                <p style={{ fontSize:11, fontWeight:600, color:'#b97e2b', display:'flex', alignItems:'center', gap:4 }}>
                                                    <AlertTriangle size={12} style={{flexShrink:0}} />
                                                    Financial fields are locked after posting. Use Void and Re-post for corrections.
                                                </p>
                                            </div>
                                        )}

                                        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                                            <div>
                                                <div style={{ fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                                                    <span>Customer</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => { setIsClientModalOpen(true); }}
                                                        style={{ fontSize:10, fontWeight:700, color:'#1f8577', background:'transparent', border:'none', cursor:'pointer', padding:0, textTransform:'none', letterSpacing:'normal' }}
                                                    >
                                                        + New Customer
                                                    </button>
                                                </div>
                                                <div ref={customerDropdownRef} style={{ position:'relative' }}>
                                                    <input
                                                        type="text"
                                                        placeholder="Search customer..."
                                                        value={customerSearchTerm || formData.customerName || ''}
                                                        disabled={editMode}
                                                        onChange={e => { setCustomerSearchTerm(e.target.value); setShowCustomerDropdown(true); }}
                                                        onFocus={() => setShowCustomerDropdown(true)}
                                                        onBlur={() => setTimeout(() => setShowCustomerDropdown(false), 200)}
                                                        style={{ width:'100%', height:36, padding:'0 32px 0 10px', border:'1.4px solid #e4ddd1', borderRadius:8, fontSize:13, fontWeight:600, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none' }}
                                                    />
                                                    <Search size={14} style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', color:'#5c6567' }} />
                                                    {showCustomerDropdown && (
                                                        <div style={{ position:'absolute', left:0, right:0, top:'100%', zIndex:50, marginTop:4, background:'#fff', border:'1px solid #e4ddd1', borderRadius:8, boxShadow:'0 4px 12px rgba(0,0,0,0.08)', maxHeight:320, overflowY:'auto' }}>
                                                            {filteredCustomers.length > 0 ? filteredCustomers.map((c: any) => (
                                                                <button
                                                                    key={c.id}
                                                                    type="button"
                                                                    onMouseDown={e => {
                                                                        e.preventDefault();
                                                                        setFormData({ ...formData, customerName: getCustomerOptionLabel(c), customerId: c.id, subAccountName: 'Main' });
                                                                        setAllocations([]);
                                                                        setCustomerSearchTerm('');
                                                                        setShowCustomerDropdown(false);
                                                                    }}
                                                                    style={{ width:'100%', textAlign:'left', padding:'8px 10px', fontSize:13, color:'#23282A', background:'transparent', border:'none', borderBottom:'1px solid #f0ebe0', cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'space-between' }}
                                                                    onMouseEnter={e => { e.currentTarget.style.background = '#eef7f6'; }}
                                                                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                                                >
                                                                    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{getCustomerOptionLabel(c)}</span>
                                                                    {(c.balance || c.outstandingBalance) ? (
                                                                        <span style={{ marginLeft:8, fontSize:11, fontWeight:600, whiteSpace:'nowrap', color: (Number(c.balance || c.outstandingBalance) > 0) ? '#b5493f' : '#1f8577' }}>
                                                                            {currency}{(Number(c.balance || c.outstandingBalance)).toLocaleString()}
                                                                        </span>
                                                                    ) : null}
                                                                </button>
                                                            )) : customerSearchTerm.trim() ? null : (
                                                                <div style={{ padding:'8px 10px', fontSize:13, color:'#5c6567' }}>No customers found</div>
                                                            )}
                                                            {customerSearchTerm.trim() && (
                                                                <button
                                                                    type="button"
                                                                    onMouseDown={e => {
                                                                        e.preventDefault();
                                                                        setFormData({ ...formData, customerName: customerSearchTerm.trim(), customerId: '' });
                                                                        setAllocations([]);
                                                                        setCustomerSearchTerm('');
                                                                        setShowCustomerDropdown(false);
                                                                    }}
                                                                    style={{ width:'100%', textAlign:'left', padding:'8px 10px', fontSize:13, color:'#146b60', background:'transparent', border:'none', borderTop:'1px solid #e4ddd1', cursor:'pointer', fontFamily:'inherit', fontWeight:600 }}
                                                                    onMouseEnter={e => { e.currentTarget.style.background = '#eef7f6'; }}
                                                                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                                                                >
                                                                    + Add New Customer "{customerSearchTerm.trim()}"
                                                                </button>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                                {formData.customerName && (() => {
                                                    const cust = customers.find((c: any) => c.name === formData.customerName);
                                                    const bal = cust?.walletBalance || 0;
                                                    return bal > 0 ? (
                                                        <p style={{ fontSize:11, fontWeight:700, color:'#146b60', marginTop:6, display:'flex', alignItems:'center', gap:6, background:'#d3ece9', padding:'4px 8px', borderRadius:6 }}>
                                                            <Wallet size={12} style={{color:'#0f544c'}} /> Wallet Balance: {currency}{bal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                        </p>
                                                    ) : null;
                                                })()}
                                            </div>

                                            {formData.customerName && customers.find(c => c.name === formData.customerName)?.subAccounts?.length > 0 && (
                                                <div>
                                                    <div style={{ fontSize:10, fontWeight:600, color:'#5c6567', marginBottom:4, display:'flex', alignItems:'center', gap:4 }}>
                                                        <Building2 size={11} style={{color:'#1f8577'}} /> Credit Sub-Account
                                                    </div>
                                                    <select
                                                        style={{ width:'100%', height:34, padding:'0 8px', border:'1.4px solid #a6d9d3', borderRadius:7, fontSize:12, fontWeight:600, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none' }}
                                                        value={formData.subAccountName}
                                                        disabled={editMode}
                                                        onChange={e => setFormData({ ...formData, subAccountName: e.target.value })}
                                                    >
                                                        <option value="Main">Main Account</option>
                                                        {customers.find(c => c.name === formData.customerName)?.subAccounts.map((sa: any) => (
                                                            <option key={sa.id || sa.name} value={sa.name}>{sa.name}</option>
                                                        ))}
                                                    </select>
                                                    <p style={{ fontSize:10, color:'#5c6567', marginTop:3 }}>Choose which sub-account to credit this payment to.</p>
                                                </div>
                                            )}

                                            <div>
                                                <div style={{ fontSize:10, fontWeight:600, color:'#5c6567', marginBottom:4 }}>Payment Date</div>
                                                <input type="date" style={{ width:'100%', height:34, padding:'0 8px', border:'1.4px solid #e4ddd1', borderRadius:7, fontSize:12, fontWeight:500, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none' }} value={formData.date} disabled={editMode} onChange={e => setFormData({ ...formData, date: e.target.value })} />
                                            </div>

                                            <div>
                                                <div style={{ fontSize:10, fontWeight:600, color:'#5c6567', marginBottom:4 }}>Payment Account</div>
                                                <select
                                                    style={{ width:'100%', height:34, padding:'0 8px', border:'1.4px solid #e4ddd1', borderRadius:7, fontSize:12, fontWeight:500, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none' }}
                                                    value={formData.accountId}
                                                    disabled={editMode}
                                                    onChange={e => {
                                                        const accId = e.target.value;
                                                        const defAcc = DEFAULT_ACCOUNTS.find(a => a.id === accId);
                                                        const bankAcc = bankAccounts.find(a => a.id === accId);
                                                        let method = 'Bank';
                                                        if (accId === 'wallet') method = 'Wallet';
                                                        else if (defAcc?.name.includes('Cash')) method = 'Cash';
                                                        else if (defAcc?.name.includes('Mobile') || bankAcc?.name.toLowerCase().includes('mobile')) method = 'Mobile Money';
                                                        setFormData({ ...formData, accountId: accId, paymentMethod: method });
                                                    }}
                                                >
                                                    <optgroup label="Default Accounts">
                                                         {getPaymentAccountOptions(coaAccounts).map(opt => (
                                                            <option key={opt.id} value={opt.id}>{opt.name} ({opt.code})</option>
                                                        ))}
                                                    </optgroup>
                                                    {bankAccounts.length > 0 && (
                                                        <optgroup label="Specific Bank Accounts">
                                                             {bankAccounts.filter(a => a.status === 'Active' && !['11110', '11100', '11120', '11210', '11220', '11230', '11240'].includes(a.id)).map(acc => (
                                                                <option key={acc.id} value={acc.id}>{acc.name} - {acc.bankName}</option>
                                                            ))}
                                                        </optgroup>
                                                    )}
                                                </select>
                                            </div>

                                            {formData.customerName && !editMode && (() => {
                                                const cust = customers.find((c: any) => c.name === formData.customerName);
                                                const bal = cust?.walletBalance || 0;
                                                return bal > 0 ? (
                                                    <div style={{ padding:'8px 10px', background:'linear-gradient(135deg,#eef7f6,#d3ece9)', border:'1px solid #a6d9d3', borderRadius:8 }}>
                                                        <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
                                                            <input
                                                                type="checkbox"
                                                                style={{ width:14, height:14, accentColor:'#146b60' }}
                                                                checked={formData.paymentMethod === 'Wallet'}
                                                                onChange={e => {
                                                                    if (e.target.checked) {
                                                                        setFormData({ ...formData, paymentMethod: 'Wallet', accountId: 'wallet' });
                                                                    } else {
                                                                        setFormData({ ...formData, paymentMethod: 'Cash', accountId: '1000' });
                                                                    }
                                                                }}
                                                            />
                                                            <div style={{ flex:1 }}>
                                                                <p style={{ fontSize:11, fontWeight:600, color:'#0b3e39' }}>Pay from Wallet</p>
                                                                <p style={{ fontSize:10, color:'#146b60' }}>{currency}{bal.toLocaleString(undefined, { minimumFractionDigits: 2 })} available</p>
                                                            </div>
                                                            {formData.paymentMethod === 'Wallet' && (
                                                                <span style={{ fontSize:9, fontWeight:600, color:'#0f544c', background:'#a6d9d3', padding:'2px 6px', borderRadius:4 }}>Active</span>
                                                            )}
                                                        </label>
                                                    </div>
                                                ) : null;
                                            })()}

                                            <div>
                                                <div style={{ fontSize:10, fontWeight:600, color:'#146b60', marginBottom:4 }}>Amount Received</div>
                                                <div style={{ display:'flex', alignItems:'center', border:'1.4px solid #a6d9d3', borderRadius:7, height:36, background:'#FEFDFB' }}>
                                                    <span style={{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, color:'#146b60', marginLeft:8, fontSize:14 }}>{currency}</span>
                                                    <input
                                                        type="number"
                                                        style={{ border:'none', outline:'none', fontFamily:"'JetBrains Mono',monospace", fontSize:14, fontWeight:700, width:'100%', color:'#146b60', background:'transparent', padding:'0 8px' }}
                                                        value={formData.amount || ''}
                                                        disabled={editMode}
                                                        onChange={e => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                                                        placeholder="0.00"
                                                    />
                                                </div>
                                                <button
                                                    onClick={handleAutoAllocate}
                                                    disabled={editMode || !formData.amount || (availableInvoices.length === 0 && availableOrders.length === 0)}
                                                    style={{ width:'100%', marginTop:6, height:28, border:'1px solid #e4ddd1', borderRadius:6, background:'#FEFDFB', color:'#5c6567', fontSize:10, fontWeight:600, cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}
                                                >
                                                    <BarChart3 size={12} /> Auto-Allocate
                                                </button>
                                            </div>

                                            {excessAmount > 0.01 && (
                                                <div style={{ padding:'10px', background:'#eef7f6', border:'1px solid #a6d9d3', borderRadius:8 }}>
                                                    <div style={{ fontSize:10, fontWeight:600, color:'#0b3e39', marginBottom:6, display:'flex', alignItems:'center', gap:4 }}>
                                                        <AlertTriangle size={12} /> Excess: {currency}{excessAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                    </div>
                                                    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                                                        <button
                                                            onClick={() => setFormData({ ...formData, excessHandling: 'Change' })}
                                                            disabled={editMode}
                                                            style={{ width:'100%', height:28, borderRadius:6, fontSize:10, fontWeight:600, border:formData.excessHandling === 'Change' ? '1px solid #a6d9d3' : '1px solid #146b60', background:formData.excessHandling === 'Change' ? '#FEFDFB' : '#146b60', color:formData.excessHandling === 'Change' ? '#146b60' : '#fff', cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}
                                                        >
                                                            <Undo2 size={11} /> Give Change
                                                        </button>
                                                        <button
                                                            disabled={editMode || !formData.customerName}
                                                            onClick={() => setFormData({ ...formData, excessHandling: 'Wallet' })}
                                                            style={{ width:'100%', height:28, borderRadius:6, fontSize:10, fontWeight:600, border:formData.excessHandling === 'Wallet' ? '1px solid #a6d9d3' : '1px solid #146b60', background:formData.excessHandling === 'Wallet' ? '#FEFDFB' : '#146b60', color:formData.excessHandling === 'Wallet' ? '#146b60' : '#fff', cursor:'pointer', fontFamily:'inherit', display:'flex', alignItems:'center', justifyContent:'center', gap:4 }}
                                                        >
                                                            <Wallet size={11} /> To Wallet
                                                        </button>
                                                    </div>
                                                </div>
                                            )}

                                            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                                                <div style={{ fontSize:10, fontWeight:600, color:'#5c6567' }}>Reference & Notes</div>
                                                <input type="text" style={{ width:'100%', height:34, padding:'0 8px', border:'1.4px solid #e4ddd1', borderRadius:7, fontSize:12, fontWeight:500, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none' }} placeholder="Reference / Cheque #" value={formData.reference} onChange={e => setFormData({ ...formData, reference: e.target.value })} />
                                                <textarea style={{ width:'100%', padding:'6px 8px', border:'1.4px solid #e4ddd1', borderRadius:7, fontSize:12, fontWeight:500, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none', resize:'none' }} placeholder="Narration..." value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })} rows={2} />
                                            </div>
                                        </div>

                                        <button
                                            onClick={handleSave}
                                            disabled={isSubmitting}
                                            style={{
                                                width:'100%', marginTop:12, padding:'10px 0', borderRadius:8, border:'none',
                                                fontFamily:"'Inter',sans-serif", fontSize:13, fontWeight:600, cursor: isSubmitting ? 'default' : 'pointer',
                                                background: isSubmitting ? '#d3ece9' : 'linear-gradient(155deg,#1f8577,#0f544c)',
                                                color: isSubmitting ? '#5c6567' : '#fff',
                                                boxShadow: isSubmitting ? 'none' : '0 6px 16px -6px rgba(15,84,76,.55)',
                                                display:'flex', alignItems:'center', justifyContent:'center', gap:4
                                            }}
                                        >
                                            {isSubmitting ? (
                                                <><Loader2 size={14} className="animate-spin" /> Processing...</>
                                            ) : (
                                                <><PaymentIcon size={14} /> Confirm & Post Payment</>
                                            )}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { modalOpenedRef.current = false; setIsModalOpen(false); }}
                                            style={{ width:'100%', padding:'9px 0', borderRadius:8, border:'1px solid #e4ddd1', background:'#FEFDFB', color:'#5c6567', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}
                                        >
                                            Cancel
                                        </button>
                                    </div>

                                    <div style={{ flex:1, background:'#FEFDFB', padding:'14px 18px', overflowY:'auto' }}>
                                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
                                            <h3 style={{ fontSize:12.5, fontWeight:700, color:'#23282A', margin:0 }}>Document Allocations</h3>
                                            <span style={{ fontSize:10, fontWeight:600, color:'#5c6567', background:'#eef7f6', padding:'3px 8px', borderRadius:4 }}>{availableInvoices.length + availableOrders.length} unpaid</span>
                                        </div>

                                        <div style={{ border:'1px solid #e4ddd1', borderRadius:8, overflow:'hidden' }}>
                                            <table style={{ width:'100%', textAlign:'left', fontSize:12, borderCollapse:'collapse' }}>
                                                <thead>
                                                    <tr style={{ background:'#eef7f6' }}>
                                                        <th style={{ padding:'8px 12px', fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.06em' }}>Doc #</th>
                                                        <th style={{ padding:'8px 12px', fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.06em' }}>Type</th>
                                                        <th style={{ padding:'8px 12px', fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.06em' }}>Date</th>
                                                        <th style={{ padding:'8px 12px', fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.06em', textAlign:'right' }}>Total</th>
                                                        <th style={{ padding:'8px 12px', fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.06em', textAlign:'right' }}>Balance</th>
                                                        <th style={{ padding:'8px 12px', fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.06em', textAlign:'right', width:110 }}>Allocate</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {availableInvoices.map(inv => {
                                                        const due = inv.totalAmount - (inv.paidAmount || 0);
                                                        const alloc = allocations.find(a => a.invoiceId === inv.id);
                                                        return (
                                                            <tr key={`inv-${inv.id}`} style={{ borderTop:'1px solid #e4ddd1' }}>
                                                                <td style={{ padding:'7px 12px' }}>
                                                                    <div style={{ fontWeight:600, color:'#1f8577', fontSize:12 }}>#{inv.id}</div>
                                                                    {inv.subAccountName && <div style={{ fontSize:9, color:'#5c6567' }}>{inv.subAccountName}</div>}
                                                                </td>
                                                                <td style={{ padding:'7px 12px' }}>
                                                                    <span style={{ fontSize:9, fontWeight:700, color:'#1f8577', background:'#eef7f6', padding:'2px 6px', borderRadius:3, textTransform:'uppercase' }}>Invoice</span>
                                                                 </td>
                                                                 <td style={{ padding:'7px 12px', color:'#5c6567', fontSize:12 }}>{new Date(inv.date).toLocaleDateString()}</td>
                                                                 <td style={{ padding:'7px 12px', textAlign:'right', color:'#5c6567', fontFamily:"'JetBrains Mono',monospace", fontSize:12 }}>{currency}{(inv.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                                                 <td style={{ padding:'7px 12px', textAlign:'right', fontWeight:600, color:'#d99a3f', fontFamily:"'JetBrains Mono',monospace", fontSize:12 }}>{currency}{due.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                                                 <td style={{ padding:'7px 12px', textAlign:'right' }}>
                                                                     <input
                                                                        type="number"
                                                                        style={{ width:80, padding:'4px 6px', borderRadius:6, border:'1.2px solid #e4ddd1', textAlign:'right', fontWeight:600, color:'#146b60', fontFamily:"'JetBrains Mono',monospace", fontSize:12, background:'#FEFDFB', outline:'none' }}
                                                                        value={alloc?.amount || ''}
                                                                        disabled={editMode}
                                                                        onChange={e => {
                                                                            const val = parseFloat(e.target.value) || 0;
                                                                            setAllocations(prev => {
                                                                                const filtered = prev.filter(a => a.invoiceId !== inv.id);
                                                                                return [...filtered, { invoiceId: inv.id, amount: val }];
                                                                            });
                                                                        }}
                                                                        placeholder="0.00"
                                                                    />
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                    {availableOrders.map(order => {
                                                        const due = getOrderOutstanding(order);
                                                        const alloc = allocations.find(a => a.orderId === order.id);
                                                        return (
                                                            <tr key={`ord-${order.id}`} style={{ borderTop:'1px solid #e4ddd1' }}>
                                                                <td style={{ padding:'7px 12px' }}>
                                                                    <div style={{ fontWeight:600, color:'#b97e2b', fontSize:12 }}>#{order.orderNumber || order.id}</div>
                                                                </td>
                                                                <td style={{ padding:'7px 12px' }}>
                                                                    <span style={{ fontSize:9, fontWeight:700, color:'#b97e2b', background:'#fbead0', padding:'2px 6px', borderRadius:3, textTransform:'uppercase' }}>Order</span>
                                                                 </td>
                                                                 <td style={{ padding:'7px 12px', color:'#5c6567', fontSize:12 }}>{new Date(order.orderDate || order.date).toLocaleDateString()}</td>
                                                                 <td style={{ padding:'7px 12px', textAlign:'right', color:'#5c6567', fontFamily:"'JetBrains Mono',monospace", fontSize:12 }}>{currency}{(order.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                                                 <td style={{ padding:'7px 12px', textAlign:'right', fontWeight:600, color:'#d99a3f', fontFamily:"'JetBrains Mono',monospace", fontSize:12 }}>{currency}{due.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                                                 <td style={{ padding:'7px 12px', textAlign:'right' }}>
                                                                     <input
                                                                        type="number"
                                                                        style={{ width:80, padding:'4px 6px', borderRadius:6, border:'1.2px solid #e4ddd1', textAlign:'right', fontWeight:600, color:'#b97e2b', fontFamily:"'JetBrains Mono',monospace", fontSize:12, background:'#FEFDFB', outline:'none' }}
                                                                        value={alloc?.amount || ''}
                                                                        disabled={editMode}
                                                                        onChange={e => {
                                                                            const val = parseFloat(e.target.value) || 0;
                                                                            setAllocations(prev => {
                                                                                const filtered = prev.filter(a => a.orderId !== order.id);
                                                                                return [...filtered, { invoiceId: '', orderId: order.id, amount: val }];
                                                                            });
                                                                        }}
                                                                        placeholder="0.00"
                                                                    />
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                    {availableInvoices.length === 0 && availableOrders.length === 0 && (
                                                        <tr><td colSpan={6} style={{ padding:'28px 12px', textAlign:'center', color:'#5c6567', fontStyle:'italic' }}>No outstanding invoices or orders for this account context.</td></tr>
                                                    )}
                                                </tbody>
                                            </table>
                                        </div>

                                        {allocations.length > 0 && (
                                            <div style={{ marginTop:6, display:'flex', alignItems:'center', justifyContent:'flex-end', gap:8, fontSize:12 }}>
                                                <span style={{ color:'#5c6567', fontWeight:500 }}>Allocated: <span style={{ fontWeight:700, color:'#23282A', fontFamily:"'JetBrains Mono',monospace" }}>{currency}{allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></span>
                                                {excessAmount > 0.01 && (
                                                    <span style={{ color:'#146b60', fontWeight:500 }}>Excess: <span style={{ fontWeight:700, fontFamily:"'JetBrains Mono',monospace" }}>{currency}{excessAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></span>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="flex gap-6 flex-1 min-h-0 overflow-hidden relative">
                        <div className={`bg-[#FEFDFB] backdrop-blur-xl rounded-2xl shadow-sm border border-[#e4ddd1] flex flex-col min-h-0 flex-1 overflow-hidden transition-all duration-300 ${selectedPayment ? 'mr-[450px]' : ''}`}>
                            <div className="p-3 border-b border-[#e4ddd1] bg-[#FEFDFB] space-y-3">
                                <div className="flex flex-wrap gap-2 items-center justify-between">
                                    <div className="relative w-full max-w-md"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5c6567]" size={14} /><input ref={searchInputRef} type="text" placeholder="Search payments, customer, reference, invoice...  ( / )" className="w-full pl-9 pr-3 py-1.5 border border-[#e4ddd1] rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-[#1f8577] bg-[#FEFDFB] font-normal" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} /></div>
                                    <div className="flex items-center gap-2">
                                        <button onClick={() => setShowListFilters(v => !v)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${showListFilters || hasActiveListFilters ? 'bg-[#eef7f6] border-[#a6d9d3] text-[#0f544c]' : 'bg-[#FEFDFB] border-[#e4ddd1] text-[#5c6567] hover:bg-[#eef7f6]'}`} title="Advanced filters">
                                            <SlidersHorizontal size={13} /> Filters{hasActiveListFilters && <span className="ml-1 bg-[#1f8577] text-white text-[9px] font-black rounded-full px-1.5 py-0.5">•</span>}
                                        </button>
                                        <button onClick={() => { setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border bg-[#FEFDFB] border-[#e4ddd1] text-[#5c6567] hover:bg-[#eef7f6] transition-all" title="Toggle sort direction">
                                            <ArrowUpDown size={13} /> {sortDir === 'asc' ? 'Asc' : 'Desc'}
                                        </button>
                                        <button onClick={handleExportFilteredCsv} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border bg-[#FEFDFB] border-[#e4ddd1] text-[#5c6567] hover:bg-[#eef7f6] transition-all" title={selectedIds.length > 0 ? `Export ${selectedIds.length} selected` : 'Export filtered results'}>
                                            <Download size={13} /> Export{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
                                        </button>
                                    </div>
                                </div>
                                {/* Summary strip */}
                                <div className="flex flex-wrap gap-2 text-[11px]">
                                    <span className="px-2.5 py-1 rounded-lg bg-[#eef7f6] border border-[#d3ece9] font-bold text-[#0f544c] finance-nums">Received: {currency}{(paymentSummary.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} ({paymentSummary.count})</span>
                                    <span className="px-2.5 py-1 rounded-lg bg-[#FEFDFB] border border-[#e4ddd1] font-bold text-[#23282A] finance-nums">Allocated: {currency}{(paymentSummary.totalAllocated || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                    <span className="px-2.5 py-1 rounded-lg bg-[#fbead0]/60 border border-[#eec27a] font-bold text-[#b97e2b] finance-nums">Unallocated: {currency}{(paymentSummary.totalUnallocated || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                    <span className="px-2.5 py-1 rounded-lg bg-[#FEFDFB] border border-[#e4ddd1] font-semibold text-[#5c6567]">{paymentSummary.byAllocation.allocated} allocated · {paymentSummary.byAllocation.partial} partial · {paymentSummary.byAllocation.unallocated} unallocated</span>
                                </div>
                                {showListFilters && (
                                    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 pt-1">
                                        <label className="flex flex-col gap-1 text-[10px] font-bold text-[#5c6567] uppercase">Method
                                            <select value={methodFilter} onChange={e => setMethodFilter(e.target.value)} className="border border-[#e4ddd1] rounded-lg text-xs font-semibold text-[#23282A] bg-[#FEFDFB] px-2 py-1.5 normal-case">
                                                <option value="all">All methods</option>
                                                {methodOptions.map(m => <option key={m} value={m}>{m}</option>)}
                                            </select>
                                        </label>
                                        <label className="flex flex-col gap-1 text-[10px] font-bold text-[#5c6567] uppercase">Status
                                            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="border border-[#e4ddd1] rounded-lg text-xs font-semibold text-[#23282A] bg-[#FEFDFB] px-2 py-1.5 normal-case">
                                                <option value="all">All statuses</option>
                                                {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
                                            </select>
                                        </label>
                                        <label className="flex flex-col gap-1 text-[10px] font-bold text-[#5c6567] uppercase">Allocation
                                            <select value={allocationFilter} onChange={e => setAllocationFilter(e.target.value as 'all' | AllocationStatus)} className="border border-[#e4ddd1] rounded-lg text-xs font-semibold text-[#23282A] bg-[#FEFDFB] px-2 py-1.5 normal-case">
                                                <option value="all">All</option>
                                                <option value="allocated">Allocated</option>
                                                <option value="partial">Partially allocated</option>
                                                <option value="unallocated">Unallocated</option>
                                            </select>
                                        </label>
                                        <label className="flex flex-col gap-1 text-[10px] font-bold text-[#5c6567] uppercase">From
                                            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="border border-[#e4ddd1] rounded-lg text-xs text-[#23282A] bg-[#FEFDFB] px-2 py-1.5" />
                                        </label>
                                        <label className="flex flex-col gap-1 text-[10px] font-bold text-[#5c6567] uppercase">To
                                            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="border border-[#e4ddd1] rounded-lg text-xs text-[#23282A] bg-[#FEFDFB] px-2 py-1.5" />
                                        </label>
                                        <label className="flex flex-col gap-1 text-[10px] font-bold text-[#5c6567] uppercase">Amount
                                            <span className="flex gap-1">
                                                <input type="number" placeholder="Min" value={minAmount} onChange={e => setMinAmount(e.target.value)} className="w-full border border-[#e4ddd1] rounded-lg text-xs text-[#23282A] bg-[#FEFDFB] px-2 py-1.5" />
                                                <input type="number" placeholder="Max" value={maxAmount} onChange={e => setMaxAmount(e.target.value)} className="w-full border border-[#e4ddd1] rounded-lg text-xs text-[#23282A] bg-[#FEFDFB] px-2 py-1.5" />
                                            </span>
                                        </label>
                                        <label className="flex flex-col gap-1 text-[10px] font-bold text-[#5c6567] uppercase">Invoice #
                                            <span className="flex gap-1">
                                                <input type="text" placeholder="INV-…" value={invoiceRefFilter} onChange={e => setInvoiceRefFilter(e.target.value)} className="w-full border border-[#e4ddd1] rounded-lg text-xs text-[#23282A] bg-[#FEFDFB] px-2 py-1.5" />
                                                {hasActiveListFilters && <button onClick={clearListFilters} className="shrink-0 px-2 py-1.5 rounded-lg text-[11px] font-bold border border-[#e4ddd1] text-[#b5493f] hover:bg-[#fef2f2] normal-case">Clear</button>}
                                            </span>
                                        </label>
                                    </div>
                                )}
                                {selectedIds.length > 0 && (
                                    <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-[#0b3e39] text-white text-xs font-semibold">
                                        <span>{selectedIds.length} selected</span>
                                        <button onClick={handleExportFilteredCsv} className="px-2.5 py-1 rounded-lg bg-white/15 hover:bg-white/25 font-bold flex items-center gap-1"><Download size={12} /> Export selected</button>
                                        <button onClick={handleBatchVoidSelected} className="px-2.5 py-1 rounded-lg bg-[#b5493f] hover:bg-[#93372f] font-bold flex items-center gap-1"><Trash2 size={12} /> Void selected</button>
                                        <button onClick={() => setSelectedIds([])} className="px-2.5 py-1 rounded-lg bg-white/15 hover:bg-white/25 font-bold flex items-center gap-1"><X size={12} /> Clear</button>
                                    </div>
                                )}
                            </div>
                            <div className="flex-1 overflow-y-auto custom-scrollbar">
                                <table className="w-full text-left text-[13px]">
<thead className="bg-[#eef7f6]/80 backdrop-blur text-[#5c6567] sticky top-0 z-10 shadow-sm">
                                        <tr>
                                            <th className="table-header w-8"><input type="checkbox" checked={filteredPayments.length > 0 && filteredPayments.every(p => selectedIds.includes(p.id))} onChange={toggleSelectAllVisible} className="accent-[#1f8577] w-3.5 h-3.5" title="Select visible page" /></th>
                                            <th className="table-header w-8"></th>
                                            <th className="table-header"><button onClick={() => { setSortBy('date'); setSortDir(d => (sortBy === 'date' && d === 'desc' ? 'asc' : 'desc')); }} className="flex items-center gap-1 hover:text-[#0f544c]">Date {sortBy === 'date' && (sortDir === 'asc' ? '↑' : '↓')}</button></th>
                                            <th className="table-header">Payment #</th>
                                            <th className="table-header"><button onClick={() => { setSortBy('customerName'); setSortDir(d => (sortBy === 'customerName' && d === 'desc' ? 'asc' : 'desc')); }} className="flex items-center gap-1 hover:text-[#0f544c]">Customer {sortBy === 'customerName' && (sortDir === 'asc' ? '↑' : '↓')}</button></th>
                                            <th className="table-header">Method</th>
                                            <th className="table-header"><button onClick={() => { setSortBy('status'); setSortDir(d => (sortBy === 'status' && d === 'desc' ? 'asc' : 'desc')); }} className="flex items-center gap-1 hover:text-[#0f544c]">Status {sortBy === 'status' && (sortDir === 'asc' ? '↑' : '↓')}</button></th>
                                            <th className="table-header">Allocation</th>
                                            <th className="table-header text-right"><button onClick={() => { setSortBy('amount'); setSortDir(d => (sortBy === 'amount' && d === 'desc' ? 'asc' : 'desc')); }} className="flex items-center gap-1 hover:text-[#0f544c] ml-auto">Amount {sortBy === 'amount' && (sortDir === 'asc' ? '↑' : '↓')}</button></th>
                                            <th className="table-header text-right"><button onClick={() => { setSortBy('allocated'); setSortDir(d => (sortBy === 'allocated' && d === 'desc' ? 'asc' : 'desc')); }} className="flex items-center gap-1 hover:text-[#0f544c] ml-auto">Allocated {sortBy === 'allocated' && (sortDir === 'asc' ? '↑' : '↓')}</button></th>
                                            <th className="table-header text-right">Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[#e4ddd1]/50 font-normal">
                                        {filteredPayments.map(payment => {
                                            const allocated = getAllocatedTotal(payment as never);
                                            const unallocated = getUnallocatedTotal(payment as never);
                                            const allocStatus = getAllocationStatus(payment as never);
                                            const methodKey = getPaymentMethodKey(payment as never);
                                            const invoiceRefs = getPaymentInvoiceRefs(payment as never);
                                            const isSelected = selectedPayment?.id === payment.id;
                                            const isChecked = selectedIds.includes(payment.id);
                                            const isExpanded = expandedId === payment.id;
                                            return (
                                                <React.Fragment key={payment.id}>
                                                <tr
                                                    id={`pmt-${payment.id}`}
                                                    className={`transition-colors cursor-pointer group ${isSelected ? 'bg-[#eef7f6]/60 border-l-4 border-l-[#1f8577]' : 'hover:bg-[#eef7f6]/40 border-l-4 border-l-transparent'} ${isChecked ? 'bg-[#eef7f6]/50' : ''}`}
                                                    onClick={() => setSelectedPayment(payment)}
                                                    onContextMenu={(e) => handleContextMenu(e, payment.id)}
                                                    onMouseEnter={(e) => handleMouseEnter(payment.id, e)}
                                                    onMouseMove={handleMouseMove}
                                                    onMouseLeave={handleMouseLeave}
                                                >
                                                    <td className="table-body-cell" onClick={e => e.stopPropagation()}><input type="checkbox" checked={isChecked} onChange={() => toggleSelectOne(payment.id)} className="accent-[#1f8577] w-3.5 h-3.5" /></td>
                                                    <td className="table-body-cell" onClick={e => e.stopPropagation()}>
                                                        <button onClick={() => setExpandedId(isExpanded ? null : payment.id)} className="p-1 text-[#5c6567] hover:text-[#0f544c] rounded transition-colors" title={isExpanded ? 'Collapse details' : 'Expand details'}>
                                                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                        </button>
                                                    </td>
                                                    <td className="table-body-cell text-[#5c6567] font-normal whitespace-nowrap"><div className="flex items-center gap-2"><Calendar size={12} /> {payment.date ? new Date(payment.date).toLocaleDateString() : '—'}</div></td>
                                                    <td className="table-body-cell"><span className="font-mono text-[10px] font-bold text-[#5c6567] tracking-tight">
                                                        <TransactionRefLink
                                                            type={isProcurement ? 'supplier-payment' : 'payment'}
                                                            id={payment.id}
                                                            number={payment.receiptNumber || payment.reference || payment.id}
                                                            label={payment.id}
                                                        />
                                                    </span></td>
                                                    <td className="table-body-cell font-bold text-[#23282A]">
                                                        <button onClick={(e) => { e.stopPropagation(); navigate('/sales-flow/customers', { state: { customerId: (payment as CustomerPayment).customerId } }); }} className="hover:text-[#1f8577] hover:underline text-left" title="Open customer">
                                                            {payment.customerName}
                                                        </button>
                                                        {invoiceRefs.length > 0 && <div className="text-[10px] font-semibold text-[#1f8577] truncate max-w-[180px]" title={invoiceRefs.join(', ')}>→ {invoiceRefs.slice(0, 3).join(', ')}{invoiceRefs.length > 3 ? ` +${invoiceRefs.length - 3}` : ''}</div>}
                                                    </td>
                                                    <td className="table-body-cell">
                                                        <span className="inline-flex items-center gap-1.5 bg-[#eef7f6] text-[#5c6567] px-2 py-1 rounded text-[11px] border border-[#e4ddd1] font-semibold" title={DEFAULT_ACCOUNTS.find(a => a.id === payment.accountId)?.name || methodKey}>
                                                            <PaymentMethodIcon method={methodKey} size={13} />{methodKey}
                                                        </span>
                                                    </td>
                                                    <td className="table-body-cell font-normal"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold flex w-fit items-center gap-1 border ${payment.status === 'Cleared' ? 'bg-[#eef7f6] text-[#0f544c] border-[#d3ece9]' : payment.status === 'Pending' ? 'bg-[#fbead0] text-[#b97e2b] border-[#eec27a]' : 'bg-[#fef2f2] text-[#b5493f] border-[#fcd5d0]'}`}>{payment.status}</span></td>
                                                    <td className="table-body-cell"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold flex w-fit items-center gap-1 border ${ALLOCATION_BADGE[allocStatus].className}`}>{ALLOCATION_BADGE[allocStatus].label}{allocStatus !== 'allocated' && unallocated > 0 ? ` · ${currency}${unallocated.toLocaleString(undefined, { maximumFractionDigits: 0 })} left` : ''}</span></td>
                                                    <td className="table-body-cell text-right font-bold text-[#23282A] finance-nums whitespace-nowrap">{currency}{(payment.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                                    <td className="table-body-cell text-right font-bold text-[#0b3e39] finance-nums whitespace-nowrap">{currency}{allocated.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                                    <td className="table-body-cell text-right" onClick={e => e.stopPropagation()}>
                                                        <div className="flex justify-end gap-1 items-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handlePreviewReceipt(payment);
                                                                }}
                                                                className="p-1.5 text-[#5c6567] hover:text-[#23282A] bg-[#eef7f6] hover:bg-[#FEFDFB] border border-transparent hover:border-[#e4ddd1] rounded transition-all"
                                                                title="View Receipt"
                                                            >
                                                                <Eye size={14} />
                                                            </button>
                                                            <button
                                                                onClick={async (e) => {
                                                                    e.stopPropagation();
                                                                    if (payment.customerId) {
                                                                        handlePreviewStatement(payment.customerId, payment.customerName);
                                                                    } else {
                                                                        notify("Cannot generate statement: No customer ID linked", "warning");
                                                                    }
                                                                }}
                                                                 className="p-1.5 text-[#5c6567] hover:text-[#0f544c] bg-[#eef7f6] hover:bg-[#FEFDFB] border border-transparent hover:border-[#a6d9d3] rounded transition-all"
                                                                 title="View Customer Statement"
                                                            >
                                                                <FileBarChart size={14} />
                                                            </button>
                                                            <button onClick={(e) => { e.stopPropagation(); handleContextMenu(e, payment.id); }} className="p-1.5 text-[#5c6567] hover:text-[#23282A] rounded-lg transition-colors"><MoreVertical size={14} /></button>
                                                        </div>
                                                    </td>
                                                </tr>
                                                {isExpanded && (
                                                    <tr className="bg-[#eef7f6]/40">
                                                        <td colSpan={10} className="px-6 py-3">
                                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-[12px]">
                                                                <div><p className="text-[10px] font-bold text-[#5c6567] uppercase mb-0.5">Invoices</p><p className="font-semibold text-[#23282A]">{invoiceRefs.length > 0 ? invoiceRefs.join(', ') : '— unallocated —'}</p></div>
                                                                <div><p className="text-[10px] font-bold text-[#5c6567] uppercase mb-0.5">Reference</p><p className="font-semibold text-[#23282A]">{payment.reference || 'N/A'}</p></div>
                                                                <div><p className="text-[10px] font-bold text-[#5c6567] uppercase mb-0.5">Unallocated</p><p className="font-bold text-[#b97e2b] finance-nums">{currency}{unallocated.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p></div>
                                                                <div><p className="text-[10px] font-bold text-[#5c6567] uppercase mb-0.5">Reconciliation</p><p className="font-semibold text-[#23282A]">{payment.reconciled ? '✓ Reconciled' : '○ Unreconciled'}</p></div>
                                                                <div><p className="text-[10px] font-bold text-[#5c6567] uppercase mb-0.5">Account</p><p className="font-semibold text-[#23282A]">{DEFAULT_ACCOUNTS.find(a => a.id === payment.accountId)?.name || methodKey}</p></div>
                                                                <div><p className="text-[10px] font-bold text-[#5c6567] uppercase mb-0.5">Recorded by</p><p className="font-semibold text-[#23282A]">{(payment as CustomerPayment).createdBy || (payment as CustomerPayment).created_by || '—'}</p></div>
                                                                <div><p className="text-[10px] font-bold text-[#5c6567] uppercase mb-0.5">Recorded at</p><p className="font-semibold text-[#23282A]">{(payment as CustomerPayment).createdAt || (payment as CustomerPayment).created_at ? new Date(String((payment as CustomerPayment).createdAt || (payment as CustomerPayment).created_at)).toLocaleString() : '—'}</p></div>
                                                                <div className="flex items-end gap-2">
                                                                    <button onClick={() => setSelectedPayment(payment)} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-[#1f8577] text-white hover:bg-[#146b60]">Full details</button>
                                                                    <button onClick={() => handlePreviewReceipt(payment)} className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold border border-[#e4ddd1] bg-[#FEFDFB] text-[#5c6567] hover:bg-[#eef7f6]">Receipt</button>
                                                                </div>
                                                            </div>
                                                            {payment.notes && <p className="mt-2 text-[12px] italic text-[#5c6567]">“{payment.notes}”</p>}
                                                        </td>
                                                    </tr>
                                                )}
                                                </React.Fragment>
                                            );
                                        })}
                                        {filteredPayments.length === 0 && (
                                            <tr>
                                                <td colSpan={10} className="p-10 text-center">
                                                    <p className="text-sm font-semibold text-[#23282A]">No payments match these filters</p>
                                                    <p className="text-xs text-[#5c6567] mt-1">Try widening the date range or clearing the search.</p>
                                                    {hasActiveListFilters && <button onClick={clearListFilters} className="mt-3 px-3 py-1.5 rounded-xl text-xs font-bold border border-[#e4ddd1] text-[#0f544c] hover:bg-[#eef7f6]">Clear all filters</button>}
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                            {/* Pagination footer */}
                            <div className="px-3 py-2 border-t border-[#e4ddd1] bg-[#FEFDFB] flex flex-wrap items-center justify-between gap-2 text-xs text-[#5c6567]">
                                <span className="font-semibold">Showing {filteredPayments.length} of {pagedPayments.total} payments · Page {pagedPayments.page} of {pagedPayments.totalPages}</span>
                                <div className="flex items-center gap-2">
                                    <select value={listPageSize} onChange={e => setListPageSize(Number(e.target.value))} className="border border-[#e4ddd1] rounded-lg text-xs font-semibold px-2 py-1 bg-[#FEFDFB]">
                                        {PAYMENTS_PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n} / page</option>)}
                                    </select>
                                    <button onClick={() => setListPage(p => Math.max(1, p - 1))} disabled={pagedPayments.page <= 1} className="px-3 py-1 rounded-lg border border-[#e4ddd1] font-bold disabled:opacity-40 hover:bg-[#eef7f6]">Previous</button>
                                    <button onClick={() => setListPage(p => Math.min(pagedPayments.totalPages, p + 1))} disabled={pagedPayments.page >= pagedPayments.totalPages} className="px-3 py-1 rounded-lg border border-[#e4ddd1] font-bold disabled:opacity-40 hover:bg-[#eef7f6]">Next</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </>
            ) : (
                <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                    <div className="flex flex-col md:flex-row gap-4 mb-6 shrink-0">
                        <div className="relative flex-1 max-w-md">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5c6567]" size={16} />
                            <input
                                type="text"
                                placeholder="Search supplier payments..."
                                className="w-full pl-10 pr-4 py-2 border border-[#e4ddd1] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#1f8577]"
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="bg-[#FEFDFB] backdrop-blur-xl rounded-2xl shadow-sm border border-[#e4ddd1] flex flex-col min-h-0 flex-1 overflow-hidden">
                        <div className="flex-1 overflow-y-auto custom-scrollbar">
                            <table className="w-full text-left text-[13px]">
                                <thead className="bg-[#eef7f6]/80 backdrop-blur text-[#5c6567] sticky top-0 z-10 shadow-sm">
                                    <tr>
                                        <th className="table-header">Date</th>
                                        <th className="table-header">Payment #</th>
                                        <th className="table-header">Supplier</th>
                                        <th className="table-header">Account</th>
                                        <th className="table-header">Status</th>
                                        <th className="table-header text-right">Amount</th>
                                        <th className="table-header text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[#e4ddd1]/50">
                                    {supplierPayments
                                        .filter(p =>
                                            (suppliers.find(s => s.id === p.supplierId)?.name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                                            p.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
                                            p.reference?.toLowerCase().includes(searchTerm.toLowerCase())
                                        )
                                        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                                        .map(payment => (
                                            <tr
                                                key={payment.id}
                                                id={`spmt-${payment.id}`}
                                                className="hover:bg-[#eef7f6]/40 transition-colors cursor-pointer group"
                                                onClick={() => setSelectedSupplierPayment(payment)}
                                                onMouseEnter={(e) => handleMouseEnter(payment.id, e)}
                                                onMouseMove={handleMouseMove}
                                                onMouseLeave={handleMouseLeave}
                                            >
                                                <td className="table-body-cell text-[#5c6567]"><Calendar size={12} className="inline mr-2" /> {new Date(payment.date).toLocaleDateString()}</td>
                                                <td className="table-body-cell font-mono text-[10px] font-bold text-[#5c6567]">
                                                    <TransactionRefLink
                                                        type="supplier-payment"
                                                        id={payment.id}
                                                        number={payment.reference || payment.id}
                                                        label={payment.id}
                                                    />
                                                </td>
                                                <td className="table-body-cell font-bold text-[#23282A]">{suppliers.find(s => s.id === payment.supplierId)?.name || 'Unknown Supplier'}</td>
                                                <td className="table-body-cell">
                                                    <span className="bg-[#eef7f6] text-[#5c6567] px-2 py-1 rounded text-[11px] border border-[#e4ddd1]">
                                                        {DEFAULT_ACCOUNTS.find(a => a.id === payment.accountId)?.name || payment.paymentMethod}
                                                    </span>
                                                </td>
                                                <td className="table-body-cell">
                                                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${payment.status === 'Cleared' ? 'bg-[#eef7f6] text-[#0f544c] border border-[#d3ece9]' :
                                                        payment.status === 'Voided' ? 'bg-[#fef2f2] text-[#b5493f] border border-[#fcd5d0]' : 'bg-[#fbead0] text-[#b97e2b] border border-[#eec27a]'
                                                        }`}>
                                                        {payment.status}
                                                    </span>
                                                </td>
                                                <td className="table-body-cell text-right font-bold text-[#23282A] finance-nums">{currency}{(payment.amount || 0).toLocaleString()}</td>
                                                <td className="table-body-cell text-right">
                                                    <button
                                                        onClick={async (e) => {
                                                            e.stopPropagation();
                                                            const supplierName = suppliers.find(s => s.id === payment.supplierId)?.name || 'Unknown Supplier';
                                                            try {
                                                                // Verification-QR hardening: ensure the voucher's
                                                                // permanent token first (normal save path).
                                                                let tokened: any = payment;
                                                                if (payment?.id && !(payment as any).verificationToken && getDocumentVerificationToken) {
                                                                    try {
                                                                        const token = await getDocumentVerificationToken('supplierPayments', String(payment.id));
                                                                        if (token) tokened = { ...(payment as any), verificationToken: token };
                                                                    } catch { /* offline-safe */ }
                                                                }
                                                                const supplierDoc = buildSupplierPaymentDoc(tokened, supplierName);
                                                                const parsed = SupplierPaymentSchema.safeParse(supplierDoc);
                                                                if (!parsed.success) {
                                                                    const message = parsed.error.issues[0]?.message || 'Invalid supplier voucher payload';
                                                                    throw new Error(message);
                                                                }
                                                                setPreviewState({
                                                                    isOpen: true,
                                                                    type: 'SUPPLIER_PAYMENT',
                                                                    data: parsed.data
                                                                });
                                                            } catch (previewError) {
                                                                logger.error('Supplier voucher preview failed:', previewError);
                                                                notify('Failed to generate supplier voucher preview', 'error');
                                                            }
                                                        }}
                                                        className="p-1.5 text-[#5c6567] hover:text-[#1f8577] rounded-lg transition-colors mr-1"
                                                        title="View Voucher"
                                                    >
                                                        <Eye size={14} />
                                                    </button>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            void copyVerificationLink('supplier_payment', 'supplierPayments', payment.id, (payment as any).paymentNumber || payment.id);
                                                        }}
                                                        className="p-1.5 text-[#5c6567] hover:text-[#1f8577] rounded-lg transition-colors mr-1"
                                                        title="Copy Verification Link"
                                                    >
                                                        <Link2 size={14} />
                                                    </button>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            void openVerificationLink('supplier_payment', 'supplierPayments', payment.id, (payment as any).paymentNumber || payment.id);
                                                        }}
                                                        className="p-1.5 text-[#5c6567] hover:text-[#1f8577] rounded-lg transition-colors mr-1"
                                                        title="View Verification"
                                                    >
                                                        <ExternalLink size={14} />
                                                    </button>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            if (confirm("Void this supplier payment?")) voidSupplierPayment(payment.id);
                                                        }}
                                                        className="p-1.5 text-[#5c6567] hover:text-[#b5493f] rounded-lg transition-colors"
                                                    >
                                                        <Trash2 size={14} />
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    {supplierPayments.length === 0 && (
                                        <tr>
                                            <td colSpan={7} className="p-20 text-center text-[#e4ddd1] italic">No supplier payments recorded yet.</td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {isSupplierModalOpen && (
                <div style={{
                    position:'fixed', inset:0, zIndex:9999,
                    display:'flex', alignItems:'center', justifyContent:'center',
                    background:'rgba(15,23,42,.6)',
                    padding:'40px 20px', fontFamily:"'Inter','DM Sans',sans-serif", fontSize:13.5, color:'#23282A',
                }}>
                    <div style={{
                        width:620, maxWidth:'100%', maxHeight:'92vh',
                        background:'#FEFDFB', borderRadius:14,
                        boxShadow:'0 30px 70px -20px rgba(0,0,0,.55), 0 8px 24px -8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04)',
                        display:'flex', flexDirection:'column', overflow:'hidden', position:'relative'
                    }}>
                        <div style={{
                            position:'absolute', top:0, left:0, right:0, height:4,
                            background:'linear-gradient(90deg,#146b60,#3fa294 40%,#d99a3f 100%)'
                        }} />
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'22px 28px 18px', borderBottom:'1px solid #e4ddd1' }}>
                            <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                                <div style={{
                                    width:40, height:40, borderRadius:10,
                                    background:'linear-gradient(155deg,#1f8577,#0f544c)',
                                    display:'flex', alignItems:'center', justifyContent:'center',
                                    boxShadow:'0 4px 10px -3px rgba(15,84,76,.6)', flexShrink:0
                                }}>
                                    <PaymentIcon size={19} color="#fff" />
                                </div>
                                <div>
                                    <h1 style={{ fontFamily:"'DM Serif Display','Georgia',serif", fontWeight:400, fontSize:22, margin:0, color:'#0b3e39', letterSpacing:0.2 }}>Record Supplier Payment</h1>
                                </div>
                            </div>
                            <button onClick={() => setIsSupplierModalOpen(false)} style={{
                                width:32, height:32, borderRadius:8,
                                border:'1px solid #e4ddd1', background:'#FEFDFB', color:'#5c6567',
                                display:'flex', alignItems:'center', justifyContent:'center',
                                cursor:'pointer', transition:'all .15s ease'
                            }}
                                onMouseEnter={e => { e.currentTarget.style.background = '#eef7f6'; e.currentTarget.style.color = '#0f544c'; e.currentTarget.style.borderColor = '#a6d9d3'; }}
                                onMouseLeave={e => { e.currentTarget.style.background = '#FEFDFB'; e.currentTarget.style.color = '#5c6567'; e.currentTarget.style.borderColor = '#e4ddd1'; }}
                            ><X size={15} /></button>
                        </div>
                        <div style={{ padding:'20px 28px', overflowY:'auto', display:'flex', flexDirection:'column', gap:16 }}>
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
                                <div>
                                    <div style={{ fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Supplier</div>
                                    <select
                                        style={{ width:'100%', height:38, padding:'0 10px', border:'1.4px solid #e4ddd1', borderRadius:8, fontSize:13, fontWeight:500, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none' }}
                                        value={supplierFormData.supplierId}
                                        onChange={e => {
                                            setSupplierFormData({
                                                ...supplierFormData,
                                                supplierId: e.target.value,
                                                amount: 0
                                            });
                                            setSupplierAllocations([]);
                                        }}
                                    >
                                        <option value="">-- Select Supplier --</option>
                                        {suppliers && suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <div style={{ fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Date</div>
                                    <input
                                        type="date"
                                        style={{ width:'100%', height:38, padding:'0 10px', border:'1.4px solid #e4ddd1', borderRadius:8, fontSize:13, fontWeight:500, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none' }}
                                        value={supplierFormData.date}
                                        onChange={e => setSupplierFormData({ ...supplierFormData, date: e.target.value })}
                                    />
                                </div>
                                <div>
                                    <div style={{ fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Amount Paid</div>
                                    <div style={{ display:'flex', alignItems:'center', border:'1.4px solid #e4ddd1', borderRadius:8, padding:'0 10px', height:38, background:'#FEFDFB' }}>
                                        <span style={{ fontFamily:"'JetBrains Mono',monospace", fontWeight:600, color:'#5c6567', marginRight:6, fontSize:14 }}>{currency}</span>
                                        <input
                                            type="number"
                                            style={{ border:'none', outline:'none', fontFamily:"'JetBrains Mono',monospace", fontSize:14, fontWeight:600, width:'100%', color:'#23282A', background:'transparent' }}
                                            value={supplierFormData.amount || ''}
                                            onChange={e => setSupplierFormData({ ...supplierFormData, amount: parseFloat(e.target.value) || 0 })}
                                        />
                                    </div>
                                </div>
                                <div>
                                    <div style={{ fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Payment Account</div>
                                    <select
                                        style={{ width:'100%', height:38, padding:'0 10px', border:'1.4px solid #e4ddd1', borderRadius:8, fontSize:13, fontWeight:500, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none' }}
                                        value={supplierFormData.accountId}
                                        onChange={e => {
                                            const accId = e.target.value;
                                            const defAcc = DEFAULT_ACCOUNTS.find(a => a.id === accId);
                                            const bankAcc = bankAccounts.find(a => a.id === accId);
                                            let method = 'Bank Transfer';
                                            if (defAcc?.name.includes('Cash')) method = 'Cash';
                                            else if (defAcc?.name.includes('Mobile') || bankAcc?.name.toLowerCase().includes('mobile')) method = 'Mobile Money';
                                            setSupplierFormData({ ...supplierFormData, accountId: accId, paymentMethod: method });
                                        }}
                                    >
                                        <optgroup label="Default Accounts">
                                             {getPaymentAccountOptions(coaAccounts).map(opt => (
                                                <option key={opt.id} value={opt.id}>{opt.name} ({opt.code})</option>
                                            ))}
                                        </optgroup>
                                        {bankAccounts.length > 0 && (
                                            <optgroup label="Specific Bank Accounts">
                                                 {bankAccounts.filter(a => a.status === 'Active' && !['11110', '11100', '11120', '11210', '11220', '11230', '11240'].includes(a.id)).map(acc => (
                                                    <option key={acc.id} value={acc.id}>{acc.name} - {acc.bankName}</option>
                                                ))}
                                            </optgroup>
                                        )}
                                    </select>
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Reference / Transaction ID</div>
                                <input
                                    type="text"
                                    style={{ width:'100%', height:38, padding:'0 10px', border:'1.4px solid #e4ddd1', borderRadius:8, fontSize:13, fontWeight:500, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none' }}
                                    value={supplierFormData.reference}
                                    onChange={e => setSupplierFormData({ ...supplierFormData, reference: e.target.value })}
                                    placeholder="e.g. Bank Ref, Check #"
                                />
                            </div>
                            <div>
                                <div style={{ fontSize:10, fontWeight:700, color:'#5c6567', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:4 }}>Notes</div>
                                <textarea
                                    style={{ width:'100%', padding:'8px 10px', border:'1.4px solid #e4ddd1', borderRadius:8, fontSize:13, fontWeight:500, background:'#FEFDFB', color:'#23282A', fontFamily:'inherit', outline:'none', resize:'vertical' }}
                                    value={supplierFormData.notes}
                                    onChange={e => setSupplierFormData({ ...supplierFormData, notes: e.target.value })}
                                    rows={2}
                                />
                            </div>

                            <div>
                                <h3 style={{ fontSize:12.5, fontWeight:700, color:'#23282A', display:'flex', alignItems:'center', gap:6, margin:'0 0 8px' }}>
                                    <FileText size={14} style={{ color:'#1f8577' }} /> Bill Allocations
                                </h3>
                                <div style={{ border:'1px solid #e4ddd1', borderRadius:10, overflow:'hidden', background:'#eef7f6' }}>
                                    <table style={{ width:'100%', textAlign:'left', fontSize:12, borderCollapse:'collapse' }}>
                                        <thead>
                                            <tr style={{ background:'#d3ece9', color:'#5c6567' }}>
                                                <th style={{ padding:'8px 14px', fontWeight:700, fontSize:10, textTransform:'uppercase', letterSpacing:'0.06em' }}>Bill #</th>
                                                <th style={{ padding:'8px 14px', fontWeight:700, fontSize:10, textTransform:'uppercase', letterSpacing:'0.06em' }}>Balance</th>
                                                <th style={{ padding:'8px 14px', fontWeight:700, fontSize:10, textTransform:'uppercase', letterSpacing:'0.06em', textAlign:'right' }}>Allocate</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {purchases
                                                .filter(p => p.supplierId === supplierFormData.supplierId && p.paymentStatus !== 'Paid')
                                                .map(bill => {
                                                    const currentAllocation = supplierAllocations.find(a => a.purchaseId === bill.id)?.amount || 0;
                                                    const due = (bill.total || 0) - (bill.paidAmount || 0);
                                                    return (
                                                        <tr key={bill.id} style={{ borderTop:'1px solid #e4ddd1' }}>
                                                            <td style={{ padding:'8px 14px', fontWeight:600, color:'#23282A' }}>{bill.id}</td>
                                                            <td style={{ padding:'8px 14px', color:'#5c6567' }}>{currency}{due.toLocaleString()}</td>
                                                            <td style={{ padding:'8px 14px', textAlign:'right' }}>
                                                                <input
                                                                    type="number"
                                                                    style={{ width:80, padding:'4px 6px', textAlign:'right', border:'1.2px solid #e4ddd1', borderRadius:6, fontWeight:600, background:'#FEFDFB', color:'#23282A', fontFamily:"'JetBrains Mono',monospace", fontSize:12, outline:'none' }}
                                                                    value={currentAllocation || ''}
                                                                    onChange={e => {
                                                                        const val = parseFloat(e.target.value) || 0;
                                                                        setSupplierAllocations(prev => {
                                                                            const filtered = prev.filter(a => a.purchaseId !== bill.id);
                                                                            if (val > 0) return [...filtered, { purchaseId: bill.id, amount: val } as unknown as PurchaseAllocation];
                                                                            return filtered;
                                                                        });
                                                                    }}
                                                                />
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            {purchases.filter(p => p.supplierId === supplierFormData.supplierId && p.paymentStatus !== 'Paid').length === 0 && (
                                                <tr>
                                                    <td colSpan={3} style={{ padding:'24px 14px', textAlign:'center', color:'#5c6567', fontStyle:'italic' }}>No outstanding bills for this supplier</td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>

                        <div style={{ display:'flex', gap:8, padding:'14px 28px 20px', borderTop:'1px solid #e4ddd1' }}>
                            <button
                                onClick={() => setIsSupplierModalOpen(false)}
                                style={{ flex:1, padding:'10px 0', borderRadius:8, border:'1px solid #e4ddd1', background:'#FEFDFB', color:'#5c6567', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'inherit' }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={async () => {
                                    if (!supplierFormData.supplierId || !supplierFormData.amount) {
                                        notify("Please fill in supplier and amount", "error");
                                        return;
                                    }
                                    const totalAllocated = supplierAllocations.reduce((sum, a) => sum + a.amount, 0);
                                    if (totalAllocated > supplierFormData.amount) {
                                        notify(`Over-allocation: Total allocated (${totalAllocated}) exceeds payment amount (${supplierFormData.amount})`, "error");
                                        return;
                                    }
                                    const dateError = validateDateInFY(supplierFormData.date || '');
                                    if (dateError) {
                                        notify(dateError, "error");
                                        return;
                                    }
                                    const payment: SupplierPayment = {
                                        ...supplierFormData as SupplierPayment,
                                        id: supplierEditMode ? currentSupplierPaymentId! : generateNextId('spay', supplierPayments, companyConfig),
                                        reconciled: false,
                                        status: 'Cleared',
                                        allocations: supplierAllocations
                                    };
                                    if (supplierEditMode) await updateSupplierPayment(payment);
                                    else await recordSupplierPayment(payment);
                                    setIsSupplierModalOpen(false);
                                    setSupplierAllocations([]);
                                    setSupplierFormData({ date: getDefaultDate(), supplierId: '', amount: 0, paymentMethod: 'Bank Transfer', accountId: '1000', reference: '', notes: '', status: 'Cleared', reconciled: false });
                                    notify("Supplier payment recorded", "success");
                                }}
                                style={{ flex:2, padding:'10px 0', borderRadius:8, border:'none', background:'linear-gradient(155deg,#1f8577,#0f544c)', color:'#fff', fontSize:14, fontWeight:600, cursor:'pointer', fontFamily:'inherit', boxShadow:'0 6px 16px -6px rgba(15,84,76,.55)' }}
                            >
                                {supplierEditMode ? 'Update Payment' : 'Post Payment to Ledger'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <CustomerPaymentDetailPanel
                payment={selectedPayment}
                onClose={() => setSelectedPayment(null)}
                onDelete={(id) => {
                    if (confirm("Are you sure you want to void this payment? This action cannot be undone.")) {
                        deleteCustomerPayment(id).catch(() => {});
                        setSelectedPayment(null);
                    }
                }}
                onPurge={(id) => {
                    if (confirm("Permanently delete this voided payment?\n\nThis removes the record completely and cannot be undone.")) {
                        permanentlyDeleteCustomerPayment(id)
                            .then(() => notify("Voided payment deleted permanently.", "info"))
                            .catch(() => {});
                        setSelectedPayment(null);
                    }
                }}
                onEdit={(p) => {
                    setFormData({
                        date: p.date,
                        customerName: p.customerName,
                        subAccountName: p.subAccountName || 'Main',
                        amount: p.amount,
                        paymentMethod: p.paymentMethod,
                         accountId: p.accountId || (p.paymentMethod === 'Cash' ? '11110' : (p.paymentMethod === 'Mobile Money' ? ACCOUNT_IDS.MOBILE_MONEY : '11210')),
                        reference: p.reference || '',
                        notes: p.notes || '',
                        bankCharges: p.bankCharges || 0,
                        status: p.status,
                        reconciled: p.reconciled,
                        excessHandling: p.excessHandling || 'Change'
                    });
                    setAllocations(p.allocations);
                    setEditMode(true);
                    setCurrentId(p.id);
                    setIsModalOpen(true);
                    setSelectedPayment(null);
                }}
                onPreview={handlePreviewReceipt}
                onStatement={(cid, cname) => handlePreviewStatement(cid, cname)}
            />
            <SupplierDetailPanel
                payment={selectedSupplierPayment}
                onClose={() => setSelectedSupplierPayment(null)}
                onVoid={(id) => {
                    voidSupplierPayment(id);
                    setSelectedSupplierPayment(null);
                }}
            />

            {/* Payment Successful Modal — shown before PDF preview */}
            {successModal.open && successModal.payment && (
                <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setSuccessModal({ open: false, payment: null })}>
                    <div
                        className="bg-[#FEFDFB] rounded-2xl shadow-2xl border border-[#e4ddd1] w-full max-w-[420px] overflow-hidden animate-in zoom-in-95 duration-200"
                        onClick={e => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="payment-success-title"
                    >
                        <div className="h-1 w-full" style={{ background: 'linear-gradient(90deg, #1f8577, #3fa294 50%, #d99a3f 100%)' }} />
                        <div className="p-6 sm:p-7 text-center">
                            <div className="w-14 h-14 rounded-full bg-[#eef7f6] border border-[#d3ece9] flex items-center justify-center mx-auto mb-4">
                                <div className="w-10 h-10 rounded-full bg-[#1f8577] flex items-center justify-center">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                                </div>
                            </div>
                            <h2 id="payment-success-title" className="text-[18px] font-bold text-[#0b3e39] tracking-tight">Payment Successful</h2>
                            <p className="text-[12px] text-[#5c6567] mt-1">Receipt <span className="font-mono font-bold text-[#23282A]">{successModal.payment.id}</span> has been created</p>

                            <div className="mt-5 bg-[#eef7f6]/60 border border-[#e4ddd1] rounded-xl p-4 text-left space-y-2.5">
                                <div className="flex justify-between items-center text-[12px]">
                                    <span className="text-[#5c6567] font-semibold">Customer</span>
                                    <span className="font-bold text-[#23282A] truncate max-w-[180px]">{successModal.payment.customerName}</span>
                                </div>
                                <div className="flex justify-between items-center text-[12px]">
                                    <span className="text-[#5c6567] font-semibold">Amount</span>
                                    <span className="font-bold text-[#0f544c] finance-nums">{currency}{(successModal.payment.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                                </div>
                                <div className="flex justify-between items-center text-[12px]">
                                    <span className="text-[#5c6567] font-semibold">Method</span>
                                    <span className="font-medium text-[#23282A]">{successModal.payment.paymentMethod}</span>
                                </div>
                                {successModal.payment.reference && (
                                    <div className="flex justify-between items-center text-[12px]">
                                        <span className="text-[#5c6567] font-semibold">Reference</span>
                                        <span className="font-mono text-[#23282A] truncate max-w-[180px]">{successModal.payment.reference}</span>
                                    </div>
                                )}
                                <div className="flex justify-between items-center text-[11px] pt-2 border-t border-[#e4ddd1]">
                                    <span className="text-[#5c6567]">{new Date(successModal.payment.date).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
                                    <span className="px-2 py-0.5 rounded-full bg-[#eef7f6] border border-[#d3ece9] text-[10px] font-bold text-[#0f544c] uppercase">{successModal.payment.status || 'Cleared'}</span>
                                </div>
                            </div>

                            <div className="mt-6 flex flex-col sm:flex-row gap-2">
                                <button
                                    onClick={async () => {
                                        const p = successModal.payment!;
                                        setSuccessModal({ open: false, payment: null });
                                        await handlePreviewReceipt(p);
                                    }}
                                    className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold text-white shadow-sm hover:brightness-110 active:scale-[0.98] transition-all"
                                    style={{ background: 'linear-gradient(155deg, #1f8577, #0f544c)' }}
                                >
                                    <Printer size={16} /> View Receipt
                                </button>
                                <button
                                    onClick={() => setSuccessModal({ open: false, payment: null })}
                                    className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-bold bg-white border border-[#e4ddd1] text-[#5c6567] hover:bg-[#eef7f6] hover:border-[#d3ece9] active:scale-[0.98] transition-all"
                                >
                                    Done
                                </button>
                            </div>
                            <button
                                onClick={() => {
                                    setSuccessModal({ open: false, payment: null });
                                    resetForm();
                                    setIsModalOpen(true);
                                }}
                                className="mt-3 text-[12px] font-semibold text-[#1f8577] hover:text-[#0f544c] hover:underline"
                            >
                                + Create another payment
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <PreviewModal
                isOpen={previewState.isOpen}
                onClose={() => setPreviewState(prev => ({ ...prev, isOpen: false }))}
                type={previewState.type}
                data={previewState.data}
            />

            <ClientModal
                isOpen={isClientModalOpen}
                onClose={() => setIsClientModalOpen(false)}
                onSave={async (customer) => {
                    const credentials = await addCustomer(customer);
                    setFormData(prev => ({ ...prev, customerName: customer.name, customerId: customer.id }));
                    setIsClientModalOpen(false);
                    setCustomerSearchTerm('');
                    notify('Customer created successfully', 'success');
                    return credentials;
                }}
            />

        </div>
    );
};

export default Payments;
