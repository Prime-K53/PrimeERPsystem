import React, { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    X, CheckCircle, Clock, DollarSign, Printer, Edit2, Download,
    FileText, ArrowRight, History, Trash2,
    AlertTriangle, Plus, CreditCard, FileCheck as PaymentIcon,
    ChevronRight, Send, ExternalLink, TrendingUp, BarChart3, Zap, Lock, RefreshCw, Ban, Truck, Eye, Percent, User, Wallet, Package,
    ChevronDown, ChevronUp, Info, Copy, FileText as CreditNoteIcon, Mail, MessageSquare, TruckIcon, Link2, EyeOff, PlusCircle,
    Layers3, Coins, TrendingUp as TrendingUpIcon, ArrowDownRight, ArrowUpRight, Ruler, Scale
} from 'lucide-react';
import { Invoice, CustomerPayment, InvoiceAllocation } from '../../../types';
import { useAuth } from '../../../context/AuthContext';
import { useFinance } from '../../../context/FinanceContext';
import { useSales } from '../../../context/SalesContext';
import { useExamination } from '../../../context/ExaminationContext';
import { useInventoryStore } from '../../../stores/inventoryStore';
import { useDocumentPreview } from '../../../hooks/useDocumentPreview';
import TransactionPricingInsights from './TransactionPricingInsights';
import AIDocumentSummarizer from '../../../components/ai/AIDocumentSummarizer';
import { enrichInvoiceWithBatchPricing, findMatchingExaminationBatch } from '../../../utils/examinationInvoicePricing';
import { currencyService } from '../../../services/currencyService';

interface InvoiceDetailsProps {
    invoice: Invoice;
    onClose: () => void;
    onEdit: (inv: Invoice) => void;
    onAction: (inv: Invoice, action: string) => void;
    /**
     * True when this panel is showing a genuine recurring invoice (opened from
     * the Subscriptions tab). This is decided by the caller rather than by
     * peeking at `invoice.frequency`: the order form stores a default
     * `frequency: 'Monthly'` on REGULAR invoices too, which made the preview
     * wrongly render a Recurring Invoice document.
     */
    isSubscription?: boolean;
}

const teal: Record<string, string> = { 50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7', 400: '#3fa294', 500: '#1f8577', 600: '#146b60', 700: '#0f544c', 800: '#0b3e39', 900: '#082e2a' };
const amber: Record<string, string> = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' };
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const danger = '#b5493f';

export const InvoiceDetails: React.FC<InvoiceDetailsProps> = ({ invoice: initialInvoice, onClose, onEdit, onAction, isSubscription = false }) => {
    const { companyConfig, auditLogs, notify, user } = useAuth();
    const { customerPayments = [], invoices = [], deliveryNotes = [], ledger = [], accounts = [], updateCustomerPayment, updateInvoice, addCustomerPayment } = useFinance();
    const { customers = [] } = useSales();
    const { batches = [] } = useExamination();
    const { inventory = [] } = useInventoryStore();

    const { handlePreview } = useDocumentPreview();
    const navigate = useNavigate();

    const canEdit = useMemo(() => user?.role === 'Admin' || user?.role === 'Company Admin' || user?.isSuperAdmin || user?.role === 'Manager', [user]);

    const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
    const [editingItemId, setEditingItemId] = useState<string | null>(null);
    const [editQty, setEditQty] = useState<number>(0);
    const [editPrice, setEditPrice] = useState<number>(0);
    const [itemPopoverId, setItemPopoverId] = useState<string | null>(null);
    const [newComment, setNewComment] = useState('');
    const [comments, setComments] = useState<Array<{ id: string; text: string; author: string; date: string }>>([]);
    const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

    const invoice = useMemo(() =>
        invoices.find(i => i.id === initialInvoice.id) || initialInvoice
        , [invoices, initialInvoice]);

    const isExaminationInvoice = String((invoice as Record<string, unknown>).originModule ?? (invoice as Record<string, unknown>).origin_module ?? '').toLowerCase() === 'examination'
        || String((invoice as Record<string, unknown>).documentTitle ?? (invoice as Record<string, unknown>).document_title ?? '').toLowerCase().includes('examination invoice')
        || String((invoice as Record<string, unknown>).reference ?? '').toUpperCase().startsWith('EXM-BATCH-');
    const matchingExaminationBatch = useMemo(
        () => isExaminationInvoice ? findMatchingExaminationBatch(invoice, batches) : undefined,
        [batches, invoice, isExaminationInvoice]
    );
    const pricingInsightTransaction = useMemo(
        () => (isExaminationInvoice && matchingExaminationBatch)
            ? enrichInvoiceWithBatchPricing(invoice as Invoice & Record<string, unknown>, matchingExaminationBatch)
            : invoice,
        [invoice, isExaminationInvoice, matchingExaminationBatch]
    );
    
    const docTitle = 'Invoice';

    const [activeTab, setActiveTab] = useState<'Overview' | 'Financials' | 'Payments' | 'Comments' | 'Activity'>('Overview');
    const [showAllocationModal, setShowAllocationModal] = useState(false);
    const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

    const isCancelled = invoice.status === 'Cancelled';
    const balanceDue = isCancelled ? 0 : (invoice.totalAmount || 0) - (invoice.paidAmount || 0);
    const totalAmountDisplay = isCancelled ? 0 : (invoice.totalAmount || 0);
    const paidAmountDisplay = isCancelled ? 0 : (invoice.paidAmount || 0);
    const isPaid = balanceDue <= 0.001;

    const hasDeliveryNote = useMemo(() =>
        (deliveryNotes || []).some(dn => dn.invoiceId === invoice.id)
        , [deliveryNotes, invoice.id]);

    const linkedDeliveryNote = useMemo(() =>
        (deliveryNotes || []).find(dn => dn.invoiceId === invoice.id)
        , [deliveryNotes, invoice.id]);

    const customerOutstanding = useMemo(() => {
        if (!invoice.customerId) return 0;
        return (invoices || []).filter(inv =>
            inv.customerId === invoice.customerId &&
            inv.id !== invoice.id &&
            inv.status !== 'Cancelled' &&
            inv.status !== 'Paid'
        ).reduce((sum, inv) => sum + Math.max(0, (inv.totalAmount || 0) - (inv.paidAmount || 0)), 0);
    }, [invoices, invoice.customerId, invoice.id]);

    const quotationRef = useMemo(() => {
        const ref = (invoice as Record<string, unknown>).sourceQuotationId || (invoice as Record<string, unknown>).quotationId;
        return ref ? String(ref) : null;
    }, [invoice]);

    const toggleExpandedItem = useCallback((itemId: string) => {
        setExpandedItems(prev => {
            const next = new Set(prev);
            if (next.has(itemId)) next.delete(itemId);
            else next.add(itemId);
            return next;
        });
    }, []);

    const startEditItem = useCallback((item: any) => {
        setEditingItemId(item.id);
        setEditQty(Number(item.quantity));
        setEditPrice(Number(item.price));
    }, []);

    const cancelEditItem = useCallback(() => {
        setEditingItemId(null);
        setEditQty(0);
        setEditPrice(0);
    }, []);

    const saveEditItem = useCallback(async (item: any) => {
        if (!invoice.id) return;
        const updatedItems = (invoice.items || []).map(it =>
            it.id === item.id ? { ...it, quantity: editQty, price: editPrice } : it
        );
        const updatedInvoice = { ...invoice, items: updatedItems };
        try {
            await updateInvoice(updatedInvoice);
            notify('success', 'Line item updated');
        } catch {
            notify('error', 'Failed to update line item');
        }
        cancelEditItem();
    }, [invoice, editQty, editPrice, updateInvoice, notify, cancelEditItem]);

    const handleAddComment = useCallback(() => {
        if (!newComment.trim()) return;
        const comment = {
            id: `CMT-${Date.now()}`,
            text: newComment.trim(),
            author: user?.name || user?.userRole || 'Staff',
            date: new Date().toISOString()
        };
        setComments(prev => [comment, ...prev]);
        setNewComment('');
    }, [newComment, user]);

    const handleDuplicateInvoice = useCallback(() => {
        navigate('/sales-flow/invoices', { state: { action: 'duplicate', invoice } });
    }, [navigate, invoice]);

    const handleCreateCreditNote = useCallback(() => {
        navigate('/sales-flow/invoices', { state: { action: 'credit_note', invoice } });
    }, [navigate, invoice]);

    const handleEmailInvoice = useCallback(() => {
        if (!invoice.customerId) { notify('warn', 'No customer linked to this invoice'); return; }
        navigate('/sales-flow/invoices', { state: { action: 'email', invoice } });
    }, [navigate, invoice, notify]);

    const handlePrintInvoice = useCallback(() => {
        handlePreview(invoice);
    }, [handlePreview, invoice]);

    const handleStatusOverride = async (newStatus: string) => {
        setIsUpdatingStatus(true);
        try {
            if (newStatus === 'Paid' && !isPaid) {
                const paymentId = `PAY-FORCE-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
                const payment: CustomerPayment = {
                    id: paymentId,
                    date: new Date().toISOString(),
                    customerName: invoice.customerName,
                    amount: balanceDue,
                    paymentMethod: 'Cash',
                    reference: `Manual Override for INV #${invoice.id}`,
                    status: 'Cleared',
                    allocations: [{ paymentId: paymentId, invoiceId: invoice.id, amount: balanceDue }],
                    notes: 'System forced payment override.',
                    reconciled: false
                };
                await addCustomerPayment(payment);
                notify(`Payment record ${paymentId} generated and posted to Ledger.`, "success");
            } else {
                await updateInvoice({ ...invoice, status: newStatus as Invoice['status'] });
                notify(`Invoice status manually updated to ${newStatus}`, "info");
            }
        } finally {
            setIsUpdatingStatus(false);
        }
    };

    const handleAllocateCredit = async (payment: CustomerPayment) => {
        const amountToAllocate = Math.min(payment.creditApplied || 0, balanceDue);
        if (amountToAllocate <= 0) return;
        const newAllocation: InvoiceAllocation = { paymentId: payment.id, invoiceId: invoice.id, amount: amountToAllocate };
        const updatedPayment: CustomerPayment = { ...payment, allocations: [...(payment.allocations || []), newAllocation], creditApplied: (payment.creditApplied || 0) - amountToAllocate };
        try {
            await updateCustomerPayment(updatedPayment);
            notify(`${currency}${amountToAllocate} allocated from Payment #${payment.id}`, 'success');
            setShowAllocationModal(false);
        } catch (err: any) {
            notify(err?.message || 'Credit allocation blocked. Void and re-post payment for financial changes.', 'error');
        }
    };

    const paymentHistory = useMemo(() => {
        return (customerPayments || []).filter(payment =>
            payment.allocations && payment.allocations.some((a: any) => a.invoiceId === invoice.id)
        ).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [customerPayments, invoice.id]);

    const timelineEvents = useMemo(() => {
        const events: Array<{
            id: string;
            date: Date;
            type: 'created' | 'status_change' | 'payment' | 'audit' | 'credit';
            title: string;
            description?: string;
            amount?: number;
            icon: React.ReactNode;
            color: string;
            bgColor: string;
        }> = [];

        events.push({
            id: `created-${invoice.id}`,
            date: new Date(invoice.date),
            type: 'created',
            title: 'Invoice Created',
            description: `Invoice #${invoice.id} issued to ${invoice.customerName || 'Unknown'}`,
            icon: <FileText size={13} />,
            color: '#059669',
            bgColor: '#ecfdf5'
        });

        if (invoice.paidAt) {
            events.push({
                id: `paid-${invoice.id}`,
                date: new Date(invoice.paidAt),
                type: 'status_change',
                title: 'Payment Received — Invoice Paid',
                description: `Full payment of ${currency}${(invoice.totalAmount || 0).toLocaleString()} received`,
                amount: invoice.totalAmount,
                icon: <CheckCircle size={13} />,
                color: '#059669',
                bgColor: '#ecfdf5'
            });
        }

        (paymentHistory || []).forEach(payment => {
            const allocAmount = payment.allocations?.find((a: any) => a.invoiceId === invoice.id)?.amount || 0;
            events.push({
                id: `payment-${payment.id}`,
                date: new Date(payment.date),
                type: 'payment',
                title: `Payment Received — ${payment.paymentMethod || 'Unknown method'}`,
                description: `Ref: ${payment.id} · Status: ${payment.status}`,
                amount: allocAmount,
                icon: <CreditCard size={13} />,
                color: '#2563eb',
                bgColor: '#eff6ff'
            });
        });

        if (invoice.status === 'Cancelled') {
            events.push({
                id: `cancelled-${invoice.id}`,
                date: new Date((invoice as Record<string, unknown>).updatedAt as string || invoice.date),
                type: 'status_change',
                title: 'Invoice Cancelled / Voided',
                description: `Invoice voided after issuance`,
                icon: <Ban size={13} />,
                color: '#dc2626',
                bgColor: '#fef2f2'
            });
        }

        (auditLogs || []).filter(log => log.entityId === invoice.id).forEach(log => {
            events.push({
                id: `audit-${log.id}`,
                date: new Date(log.date),
                type: 'audit',
                title: `${log.action} ${log.entityType || 'Invoice'}`,
                description: log.details,
                icon: log.action === 'CREATE' ? <Plus size={13} /> : log.action === 'UPDATE' ? <Edit2 size={13} /> : <Trash2 size={13} />,
                color: log.action === 'CREATE' ? '#059669' : log.action === 'UPDATE' ? '#2563eb' : log.action === 'VOID' ? '#dc2626' : inkSoft,
                bgColor: log.action === 'CREATE' ? '#ecfdf5' : log.action === 'UPDATE' ? '#eff6ff' : log.action === 'VOID' ? '#fef2f2' : hairline
            });
        });

        return events.sort((a, b) => b.date.getTime() - a.date.getTime());
    }, [invoice, paymentHistory, auditLogs, currency]);

    const availableCredits = useMemo(() => {
        return (customerPayments || []).filter(payment =>
            payment.customerName === invoice.customerName &&
            (payment.creditApplied || 0) > 0.01 &&
            payment.status === 'Cleared'
        );
    }, [customerPayments, invoice.customerName]);

    const totalCustomerOutstanding = useMemo(() => {
        return (invoices || [])
            .filter((inv: any) =>
                inv.customerName === invoice.customerName &&
                !['Paid', 'Cancelled', 'Void', 'Draft'].includes(String(inv.status || ''))
            )
            .reduce((sum: number, inv: any) => {
                const due = Math.max(0, Number(inv.totalAmount || 0) - Number(inv.paidAmount || 0));
                return sum + due;
            }, 0);
    }, [invoices, invoice.customerName]);

    const enrichedInvoice = useMemo(() => ({
        ...invoice,
        totalCustomerOutstanding,
    }), [invoice, totalCustomerOutstanding]);

    return (
        <div className="sales-detail-backdrop" style={{ fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink }}>
            <div className="sales-detail-panel">
                <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, height: 4,
                    background: `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 40%, ${amber[500]} 100%)`
                }} />

                <div className="sales-detail-header">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, flex: 1 }}>
                        <div style={{
                            width: 40, height: 40, borderRadius: 10,
                            background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: `0 4px 10px -3px rgba(15,84,76,.6)`, flexShrink: 0
                        }}>
                            <FileText size={19} color="#fff" />
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <h1 className="sales-detail-title">
                                    {docTitle} #{invoice.id}
                                </h1>
                                <span style={{
                                    padding: '2px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600,
                                    display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                                    background: invoice.status === 'Paid' ? '#ecfdf5' : amber[100],
                                    color: invoice.status === 'Paid' ? '#059669' : '#d97706'
                                }}>
                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: invoice.status === 'Paid' ? '#059669' : '#d97706' }} />
                                    {invoice.status}
                                </span>
                            </div>
                            <p style={{ margin: '2px 0 0', fontSize: 11.5, color: inkSoft, letterSpacing: 0.02, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <button onClick={() => navigate('/sales-flow/customers', { state: { customerId: invoice.customerId } })}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: teal[600], fontWeight: 600, fontSize: 11.5, padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                                    {invoice.customerName}
                                    <ExternalLink size={10} />
                                </button>
                                <span style={{ color: hairline }}>|</span>
                                <span>Ref: {invoice.jobOrderId || 'Retail'}</span>
                            </p>
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                        {!hasDeliveryNote && (
                            <button onClick={() => onAction(invoice, 'generate_dn')}
                                className="hidden sm:flex"
                                style={{ padding: '6px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: teal[500], color: '#fff', fontSize: 11, fontWeight: 600, alignItems: 'center', gap: 6 }}>
                                <Truck size={14} /> <span className="hidden md:inline">Generate delivery note</span>
                            </button>
                        )}
                        <button onClick={() => { onClose(); handlePreview(isSubscription ? 'SUBSCRIPTION' : (isExaminationInvoice ? 'EXAMINATION_INVOICE' : 'INVOICE'), enrichedInvoice); }}
                            style={{ padding: 6, borderRadius: 8, border: `1.4px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', display: 'flex' }}>
                            <Eye size={16} />
                        </button>
                        <button onClick={() => onAction(invoice, 'download_pdf')}
                            style={{ padding: 6, borderRadius: 8, border: `1.4px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', display: 'flex' }}>
                            <Download size={16} />
                        </button>
                        <button onClick={() => window.print()}
                            className="hidden sm:flex"
                            style={{ padding: 6, borderRadius: 8, border: `1.4px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', display: 'flex' }}>
                            <Printer size={16} />
                        </button>
                        <button onClick={() => onEdit(invoice)}
                            style={{ padding: 6, borderRadius: 8, border: `1.4px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', display: 'flex' }}>
                            <Edit2 size={16} />
                        </button>
                        <AIDocumentSummarizer docType="Invoice" data={invoice} label="" color="#8b5cf6" />
                        <button onClick={onClose}
                            style={{ width: 32, height: 32, borderRadius: 8, border: `1px solid ${hairline}`, background: paper, color: inkSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                            <X size={15} />
                        </button>
                    </div>
                </div>

                <div className="sales-stats-row">
                    <div className="sales-stat-item">
                        <p style={{ margin: 0, fontSize: 11, color: inkSoft, fontWeight: 500 }}>Gross billing</p>
                        <p style={{ margin: '2px 0 0', fontSize: 18, fontWeight: 700, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{currency}{totalAmountDisplay.toLocaleString()}</p>
                    </div>
                    <div className="sales-stat-item">
                        <p style={{ margin: 0, fontSize: 11, color: inkSoft, fontWeight: 500 }}>Discount</p>
                        <p style={{ margin: '2px 0 0', fontSize: 18, fontWeight: 700, color: '#dc2626', fontFamily: "'JetBrains Mono', monospace" }}>
                            {invoice.discount ? `${invoice.discountType === 'percentage' ? invoice.discount + '%' : currency + (invoice.discount || 0).toLocaleString()}` : '-'}
                        </p>
                    </div>
                    <div className="sales-stat-item">
                        <p style={{ margin: 0, fontSize: 11, color: inkSoft, fontWeight: 500 }}>Items</p>
                        <p style={{ margin: '2px 0 0', fontSize: 18, fontWeight: 700, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>{invoice.items?.length || 0}</p>
                    </div>
                    <div className="sales-stat-item" style={{ borderRight: 'none' }}>
                        <p style={{ margin: 0, fontSize: 11, color: inkSoft, fontWeight: 500 }}>Net balance</p>
                        <p style={{ margin: '2px 0 0', fontSize: 18, fontWeight: 700, color: (balanceDue || 0) > 0.001 ? danger : hairline, fontFamily: "'JetBrains Mono', monospace" }}>{currency}{(balanceDue || 0).toLocaleString()}</p>
                    </div>
                </div>

                <div className="sales-tabs">
                    {['Overview', 'Financials', 'Payments', 'Comments', 'Activity'].map(tab => (
                        <button key={tab} onClick={() => setActiveTab(tab as 'Overview' | 'Financials' | 'Payments' | 'Comments' | 'Activity')}
                            className={`sales-tab ${activeTab === tab ? 'active' : ''}`}>
                            {tab}
                        </button>
                    ))}
                </div>

                <div className="sales-detail-content" style={{ background: teal[50] }}>
                    {activeTab === 'Overview' && (
                        <div className="space-y-6 animate-in fade-in duration-300">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                <div className="md:col-span-2 space-y-6">
                                    {(invoice as Record<string, unknown>).isConverted && (invoice as Record<string, unknown>).conversionDetails && (
                                        <div style={{ padding: 16, background: paper, borderRadius: 12, border: `1px solid ${hairline}` }}>
                                            <h3 style={{ margin: '0 0 12px', fontSize: 12, color: inkSoft, display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <History size={14} color={teal[600]} /> Conversion History
                                            </h3>
                                            <div style={{ padding: 12, background: teal[50], borderRadius: 8, border: `1px solid ${teal[100]}` }}>
                                                <div style={{ display: 'flex', gap: 10 }}>
                                                    <div style={{ padding: 6, borderRadius: 6, background: paper, color: teal[600] }}>
                                                        <RefreshCw size={14} />
                                                    </div>
                                                    <div>
                                                        <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: ink }}>
                                                            Converted from <span style={{ color: teal[600] }}>{(invoice as any).conversionDetails.sourceType} {(invoice as any).conversionDetails.sourceNumber}</span>
                                                        </p>
                                                        <p style={{ margin: '4px 0 0', fontSize: 11, color: inkSoft, display: 'flex', alignItems: 'center', gap: 12 }}>
                                                            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={11} /> {new Date((invoice as any).conversionDetails.date).toLocaleString()}</span>
                                                            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><User size={11} /> {(invoice as any).conversionDetails.acceptedBy}</span>
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    <div style={{ padding: 16, background: paper, borderRadius: 12, border: `1px solid ${hairline}` }}>
                                        <h3 style={{ margin: '0 0 12px', fontSize: 12, color: inkSoft, display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <History size={14} color={teal[600]} /> System audit trail
                                        </h3>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: teal[50], borderRadius: 8, border: `1px solid ${teal[100]}` }}>
                                                <span style={{ fontSize: 12, color: inkSoft }}>Created on</span>
                                                <span style={{ fontSize: 12, fontWeight: 600, color: ink }}>{new Date(invoice.date).toLocaleString()}</span>
                                            </div>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: teal[50], borderRadius: 8, border: `1px solid ${teal[100]}` }}>
                                                <span style={{ fontSize: 12, color: inkSoft }}>Last modified</span>
                                                <span style={{ fontSize: 12, fontWeight: 600, color: ink }}>{new Date((invoice as Record<string, unknown>).updatedAt as string || invoice.date).toLocaleString()}</span>
                                            </div>
                                        </div>
                                    </div>

                                    {invoice.items && invoice.items.length > 0 && (
                                        <div style={{ borderRadius: 12, border: `1px solid ${hairline}`, overflow: 'hidden', background: paper }}>
                                            <div style={{ padding: '12px 16px', borderBottom: `1px solid ${hairline}`, background: teal[50], display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <h3 style={{ margin: 0, fontSize: 12, color: ink, display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <Package size={14} color={teal[600]} /> Line Items
                                                </h3>
                                                <span style={{ fontSize: 10, fontWeight: 700, background: teal[100], color: teal[600], padding: '2px 8px', borderRadius: 4 }}>
                                                    {invoice.items.length} item{invoice.items.length !== 1 ? 's' : ''}
                                                </span>
                                            </div>
                                            <div style={{ overflowX: 'auto' }}>
                                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                                    <thead>
                                                        <tr style={{ borderBottom: `1px solid ${hairline}`, background: teal[50] }}>
                                                            <th style={{ padding: '10px 8px', textAlign: 'center', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, width: 40 }}>#</th>
                                                            <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>Item / Description</th>
                                                            <th style={{ padding: '10px 8px', textAlign: 'center', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, width: 70 }}>Qty</th>
                                                            <th style={{ padding: '10px 8px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, width: 100 }}>Unit Price</th>
                                                            <th style={{ padding: '10px 8px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, width: 100 }}>Line Total</th>
                                                            <th style={{ padding: '10px 8px', textAlign: 'center', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, width: 90 }}>Actions</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {invoice.items.map((item: any, idx: number) => {
                                                            const lineTotal = item.lineTotalNet != null
                                                                ? Number(item.lineTotalNet)
                                                                : Number(item.quantity || 0) * Number(item.price || 0);
                                                            const hasBom = item.bomBreakdown && item.bomBreakdown.length > 0;
                                                            const hasPricingBreakdown = item.pricingBreakdown || (item.adjustmentSnapshots && item.adjustmentSnapshots.length > 0);
                                                            const invItem = item.productId ? inventory.find((i: any) => i.id === item.productId) : null;
                                                            const stockLevel = invItem ? Number(invItem.stock || 0) : null;
                                                            const reservedLevel = invItem ? Number(invItem.reserved || 0) : null;
                                                            const availableLevel = stockLevel != null && reservedLevel != null ? Math.max(0, stockLevel - reservedLevel) : null;
                                                            const isLowStock = availableLevel !== null && invItem?.minStockLevel != null && availableLevel <= Number(invItem.minStockLevel);
                                                            const isEditing = editingItemId === item.id;
                                                            const isExpanded = expandedItems.has(item.id || `idx-${idx}`);
                                                            const hasDetail = hasBom || hasPricingBreakdown || availableLevel !== null;

                                                            return (
                                                                <React.Fragment key={item.id || idx}>
                                                                    <tr style={{ borderBottom: `1px solid ${hairline}` }}>
                                                                        <td style={{ padding: '10px 8px', textAlign: 'center', fontSize: 11, color: inkSoft, fontWeight: 600 }}>{idx + 1}</td>
                                                                        <td style={{ padding: '10px 16px' }}>
                                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                                                {hasDetail && (
                                                                                    <button onClick={() => toggleExpandedItem(item.id || `idx-${idx}`)}
                                                                                        style={{ padding: 2, border: 'none', background: 'transparent', cursor: 'pointer', color: teal[600], display: 'flex', alignItems: 'center' }}>
                                                                                        {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                                                                                    </button>
                                                                                )}
                                                                                <div>
                                                                                    <p style={{ margin: 0, fontWeight: 600, color: ink, fontSize: 12 }}>{item.name || 'Unnamed item'}</p>
                                                                                    {item.description && <p style={{ margin: '2px 0 0', fontSize: 11, color: inkSoft }}>{item.description}</p>}
                                                                                    {item.type && (
                                                                                        <span style={{ display: 'inline-block', marginTop: 4, padding: '1px 6px', borderRadius: 4, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.04, background: teal[50], color: teal[700] }}>
                                                                                            {item.type}
                                                                                        </span>
                                                                                    )}
                                                                                </div>
                                                                            </div>
                                                                        </td>
                                                                        <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                                                                            {isEditing ? (
                                                                                <input type="number" value={editQty} onChange={e => setEditQty(Number(e.target.value))}
                                                                                    style={{ width: 56, padding: '4px 6px', borderRadius: 6, border: `1.4px solid ${teal[400]}`, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", textAlign: 'center', color: ink, outline: 'none' }} />
                                                                            ) : (
                                                                                <span style={{ fontWeight: 700, color: ink }}>
                                                                                    {item.quantity}{item.unit && <span style={{ fontSize: 10, color: inkSoft, marginLeft: 2 }}>{item.unit}</span>}
                                                                                </span>
                                                                            )}
                                                                        </td>
                                                                        <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                                                                            {isEditing ? (
                                                                                <input type="number" value={editPrice} onChange={e => setEditPrice(Number(e.target.value))}
                                                                                    style={{ width: 80, padding: '4px 6px', borderRadius: 6, border: `1.4px solid ${teal[400]}`, fontSize: 12, fontFamily: "'JetBrains Mono', monospace", textAlign: 'right', color: ink, outline: 'none' }} />
                                                                            ) : (
                                                                                <span style={{ fontWeight: 600, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>
                                                                                    {currency}{Number(item.price || 0).toLocaleString()}
                                                                                </span>
                                                                            )}
                                                                        </td>
                                                                        <td style={{ padding: '10px 8px', textAlign: 'right', fontWeight: 700, color: teal[700], fontFamily: "'JetBrains Mono', monospace" }}>
                                                                            {currency}{lineTotal.toLocaleString()}
                                                                        </td>
                                                                        <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                                                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                                                                {hasPricingBreakdown && (
                                                                                    <button onClick={() => setItemPopoverId(itemPopoverId === (item.id || `idx-${idx}`) ? null : (item.id || `idx-${idx}`))}
                                                                                        title="Pricing breakdown" style={{ padding: 3, border: 'none', background: 'transparent', cursor: 'pointer', color: teal[600], display: 'flex', alignItems: 'center', borderRadius: 4 }}>
                                                                                        <Info size={13} />
                                                                                    </button>
                                                                                )}
                                                                                {availableLevel !== null && (
                                                                                    <span title={`Stock: ${stockLevel} | Reserved: ${reservedLevel} | Available: ${availableLevel}`}
                                                                                        style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 5px', borderRadius: 4, fontSize: 9, fontWeight: 700, background: isLowStock ? '#fef2f2' : '#ecfdf5', color: isLowStock ? '#dc2626' : '#059669' }}>
                                                                                        {isLowStock ? <AlertTriangle size={10} /> : <Package size={10} />} {availableLevel}
                                                                                    </span>
                                                                                )}
                                                                                {canEdit && (
                                                                                    <button onClick={() => isEditing ? saveEditItem(item) : startEditItem(item)}
                                                                                        title={isEditing ? 'Save' : 'Edit item'}
                                                                                        style={{ padding: 3, border: 'none', background: 'transparent', cursor: 'pointer', color: isEditing ? '#059669' : teal[600], display: 'flex', alignItems: 'center', borderRadius: 4 }}>
                                                                                        {isEditing ? <CheckCircle size={13} /> : <Edit2 size={12} />}
                                                                                    </button>
                                                                                )}
                                                                                {isEditing && (
                                                                                    <button onClick={cancelEditItem} title="Cancel"
                                                                                        style={{ padding: 3, border: 'none', background: 'transparent', cursor: 'pointer', color: danger, display: 'flex', alignItems: 'center', borderRadius: 4 }}>
                                                                                        <X size={13} />
                                                                                    </button>
                                                                                )}
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                    {isExpanded && (hasBom || hasPricingBreakdown || availableLevel !== null) && (
                                                                        <tr>
                                                                            <td colSpan={6} style={{ padding: '0 16px 12px 56px', background: teal[50], borderBottom: `1px solid ${hairline}` }}>
                                                                                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                                                                                    {hasBom && item.bomBreakdown && (
                                                                                        <div style={{ flex: '1 1 200px', padding: '10px 12px', background: paper, borderRadius: 8, border: `1px solid ${teal[100]}` }}>
                                                                                            <p style={{ margin: '0 0 8px', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                                                                <Layers3 size={11} color={teal[600]} /> Material Breakdown
                                                                                            </p>
                                                                                            {item.bomBreakdown.map((mat: any, mi: number) => (
                                                                                                <div key={mi} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: `1px solid ${hairline}`, fontSize: 11 }}>
                                                                                                    <span style={{ color: ink, fontWeight: 600 }}>{mat.materialName}</span>
                                                                                                    <span style={{ color: inkSoft }}>{mat.quantity} {mat.unit}</span>
                                                                                                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: ink }}>{currency}{(Number(mat.cost) * Number(mat.quantity)).toLocaleString()}</span>
                                                                                                </div>
                                                                                            ))}
                                                                                        </div>
                                                                                    )}
                                                                                    {hasPricingBreakdown && item.pricingBreakdown && (
                                                                                        <div style={{ flex: '1 1 200px', padding: '10px 12px', background: paper, borderRadius: 8, border: `1px solid ${teal[100]}` }}>
                                                                                            <p style={{ margin: '0 0 8px', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                                                                <Scale size={11} color={teal[600]} /> Pricing Breakdown
                                                                                            </p>
                                                                                            {[
                                                                                                { label: 'Cost Price', value: item.pricingBreakdown.costPrice, color: '#dc2626' },
                                                                                                { label: 'Material', value: item.pricingBreakdown.baseMaterialCost },
                                                                                                { label: 'Adjustments', value: item.pricingBreakdown.adjustmentTotal },
                                                                                                { label: 'Profit', value: item.pricingBreakdown.profitAmount, color: item.pricingBreakdown.profitAmount >= 0 ? '#059669' : '#dc2626' },
                                                                                                { label: 'Selling Price', value: item.pricingBreakdown.sellingPrice, bold: true },
                                                                                            ].map((row, ri) => (
                                                                                                <div key={ri} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: `1px solid ${hairline}`, fontSize: 11 }}>
                                                                                                    <span style={{ color: inkSoft }}>{row.label}</span>
                                                                                                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: row.bold ? 700 : 400, color: row.color || ink }}>
                                                                                                        {currency}{Number(row.value || 0).toLocaleString()}
                                                                                                    </span>
                                                                                                </div>
                                                                                            ))}
                                                                                        </div>
                                                                                    )}
                                                                                    {availableLevel !== null && invItem && (
                                                                                        <div style={{ flex: '1 1 180px', padding: '10px 12px', background: paper, borderRadius: 8, border: `1px solid ${teal[100]}` }}>
                                                                                            <p style={{ margin: '0 0 8px', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06, display: 'flex', alignItems: 'center', gap: 4 }}>
                                                                                                <Package size={11} color={teal[600]} /> Stock Info
                                                                                            </p>
                                                                                            {[
                                                                                                { label: 'On Hand', value: stockLevel },
                                                                                                { label: 'Reserved', value: reservedLevel, color: '#d97706' },
                                                                                                { label: 'Available', value: availableLevel, color: availableLevel <= (invItem.minStockLevel || 0) ? '#dc2626' : '#059669' },
                                                                                                { label: 'Min Level', value: invItem.minStockLevel },
                                                                                            ].map((row, ri) => (
                                                                                                <div key={ri} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: `1px solid ${hairline}`, fontSize: 11 }}>
                                                                                                    <span style={{ color: inkSoft }}>{row.label}</span>
                                                                                                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, color: row.color || ink }}>
                                                                                                        {row.value != null ? row.value : '-'}
                                                                                                    </span>
                                                                                                </div>
                                                                                            ))}
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                            </td>
                                                                        </tr>
                                                                    )}
                                                                </React.Fragment>
                                                            );
                                                        })}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}

                                    {invoice.notes && (
                                        <div style={{ padding: 16, background: paper, borderRadius: 12, border: `1px solid ${hairline}` }}>
                                            <h3 style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>Notes / Terms</h3>
                                            <p style={{ margin: 0, fontSize: 12, color: ink, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{invoice.notes}</p>
                                        </div>
                                    )}
                                </div>

                                <div style={{ padding: 16, background: paper, borderRadius: 12, border: `1px solid ${hairline}` }}>
                                    <h3 style={{ margin: '0 0 12px', fontSize: 11, color: inkSoft, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <Zap size={14} color={amber[500]} /> Quick actions
                                    </h3>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                        <button onClick={() => navigate('/sales-flow/payments', { state: { action: 'create', customer: invoice.customerName, customerId: invoice.customerId, invoiceId: invoice.id } })}
                                            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.4px solid ${teal[200]}`, cursor: 'pointer', background: teal[50], color: teal[700], fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                            <PaymentIcon size={14} /> Record payment
                                        </button>
                                        <button onClick={handleDuplicateInvoice}
                                            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.4px solid ${teal[200]}`, cursor: 'pointer', background: teal[50], color: teal[700], fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                            <Copy size={14} /> Duplicate invoice
                                        </button>
                                        <button onClick={handleCreateCreditNote}
                                            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.4px solid ${teal[200]}`, cursor: 'pointer', background: teal[50], color: teal[700], fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                            <CreditNoteIcon size={14} /> Create credit note
                                        </button>
                                        <button onClick={handleEmailInvoice}
                                            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.4px solid ${teal[200]}`, cursor: 'pointer', background: teal[50], color: teal[700], fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                            <Mail size={14} /> Email invoice
                                        </button>
                                        <button onClick={handlePrintInvoice}
                                            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.4px solid ${teal[200]}`, cursor: 'pointer', background: teal[50], color: teal[700], fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                            <Printer size={14} /> Print / Preview
                                        </button>
                                        {!isSubscription && (
                                            <button onClick={() => onAction(invoice, 'convert_to_recurring')}
                                                style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.4px solid ${teal[200]}`, cursor: 'pointer', background: teal[50], color: teal[700], fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                                                <RefreshCw size={14} /> Convert to recurring
                                            </button>
                                        )}
                                        <button onClick={() => handleStatusOverride('Paid')} disabled={isUpdatingStatus || isPaid}
                                            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#059669', color: '#fff', fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: (isUpdatingStatus || isPaid) ? 0.5 : 1 }}>
                                            {isUpdatingStatus ? <RefreshCw size={12} className="animate-spin" /> : <CheckCircle size={14} />} Force paid
                                        </button>
                                        <button onClick={() => handleStatusOverride('Cancelled')} disabled={isUpdatingStatus || isCancelled}
                                            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1.4px solid ${danger}30`, cursor: 'pointer', background: paper, color: danger, fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, opacity: (isUpdatingStatus || isCancelled) ? 0.5 : 1 }}>
                                            <Ban size={14} /> Void invoice
                                        </button>
                                    </div>
                                    <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: `${amber[100]}80`, border: `1px solid ${amber[300]}`, display: 'flex', gap: 8 }}>
                                        <AlertTriangle size={14} color={amber[500]} style={{ flexShrink: 0, marginTop: 1 }} />
                                        <p style={{ margin: 0, fontSize: 10, color: '#92400e', lineHeight: 1.4 }}>Manual overrides bypass validation but generate full financial logs.</p>
                                    </div>
                                </div>

                                {invoice.customerId && customerOutstanding > 0 && (
                                    <div style={{ padding: 16, background: paper, borderRadius: 12, border: `1px solid ${hairline}` }}>
                                        <h3 style={{ margin: '0 0 8px', fontSize: 11, color: inkSoft, display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <Wallet size={14} color={danger} /> Customer outstanding
                                        </h3>
                                        <p style={{ margin: '0 0 4px', fontSize: 11, color: inkSoft }}>{invoice.customerName} — total unpaid invoices</p>
                                        <p style={{ margin: 0, fontSize: 22, fontWeight: 800, color: danger, fontFamily: "'JetBrains Mono', monospace" }}>
                                            {currency}{customerOutstanding.toLocaleString()}
                                        </p>
                                        <button onClick={() => navigate('/sales-flow/invoices', { state: { customerId: invoice.customerId } })}
                                            style={{ marginTop: 8, width: '100%', padding: '6px 12px', borderRadius: 6, border: `1px solid ${hairline}`, cursor: 'pointer', background: teal[50], color: teal[700], fontWeight: 600, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                            View all invoices <ChevronRight size={12} />
                                        </button>
                                    </div>
                                )}

                                {linkedDeliveryNote && (
                                    <div style={{ padding: 16, background: paper, borderRadius: 12, border: `1px solid ${hairline}` }}>
                                        <h3 style={{ margin: '0 0 8px', fontSize: 11, color: inkSoft, display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <TruckIcon size={14} color={teal[600]} /> Delivery note
                                        </h3>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                            <span style={{ fontSize: 12, fontWeight: 700, color: teal[600] }}>{linkedDeliveryNote.id}</span>
                                            <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: linkedDeliveryNote.status === 'Delivered' ? '#ecfdf5' : linkedDeliveryNote.status === 'Cancelled' ? '#fef2f2' : amber[100], color: linkedDeliveryNote.status === 'Delivered' ? '#059669' : linkedDeliveryNote.status === 'Cancelled' ? '#dc2626' : '#d97706' }}>
                                                {linkedDeliveryNote.status}
                                            </span>
                                        </div>
                                        <p style={{ margin: '0 0 4px', fontSize: 10, color: inkSoft }}>{new Date(linkedDeliveryNote.date).toLocaleDateString()}</p>
                                        <button onClick={() => navigate('/supply-chain/delivery-notes/' + encodeURIComponent(linkedDeliveryNote.id))}
                                            style={{ width: '100%', padding: '6px 12px', borderRadius: 6, border: `1px solid ${teal[200]}`, cursor: 'pointer', background: teal[50], color: teal[700], fontWeight: 600, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                            View delivery note <ExternalLink size={11} />
                                        </button>
                                    </div>
                                )}

                                {quotationRef && (
                                    <div style={{ padding: 16, background: paper, borderRadius: 12, border: `1px solid ${hairline}` }}>
                                        <h3 style={{ margin: '0 0 8px', fontSize: 11, color: inkSoft, display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <FileText size={14} color={teal[600]} /> Source quotation
                                        </h3>
                                        <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 700, color: teal[600] }}>{quotationRef}</p>
                                        <button onClick={() => navigate('/sales-flow/quotations/' + encodeURIComponent(quotationRef))}
                                            style={{ width: '100%', padding: '6px 12px', borderRadius: 6, border: `1px solid ${teal[200]}`, cursor: 'pointer', background: teal[50], color: teal[700], fontWeight: 600, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                            View quotation <ExternalLink size={11} />
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'Financials' && (
                        <div className="space-y-6 animate-in fade-in duration-300">
                            <TransactionPricingInsights transaction={pricingInsightTransaction} currencySymbol={currency} />

                            <div style={{ borderRadius: 12, border: `1px solid ${hairline}`, overflow: 'hidden', background: paper }}>
                                <div style={{ padding: '12px 16px', borderBottom: `1px solid ${hairline}`, background: teal[50], display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <h3 style={{ margin: 0, fontSize: 12, color: ink, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <BarChart3 size={16} color={teal[600]} /> General ledger entries
                                    </h3>
                                    <span style={{ fontSize: 10, fontWeight: 700, background: teal[100], color: teal[600], padding: '2px 8px', borderRadius: 4 }}>Real-time sync</span>
                                </div>
                                <div style={{ overflowX: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                        <thead>
                                            <tr style={{ borderBottom: `1px solid ${hairline}`, background: teal[50] }}>
                                                <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: inkSoft }}>Date</th>
                                                <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: inkSoft }}>Account</th>
                                                <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: inkSoft }}>Description</th>
                                                <th style={{ padding: '8px 16px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: inkSoft }}>Debit</th>
                                                <th style={{ padding: '8px 16px', textAlign: 'right', fontSize: 11, fontWeight: 600, color: inkSoft }}>Credit</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {ledger.filter(entry => entry.reference === invoice.id).length > 0 ? (
                                                ledger.filter(entry => entry.reference === invoice.id).map((entry, idx) => (
                                                    <tr key={idx} style={{ borderBottom: `1px solid ${hairline}` }}>
                                                        <td style={{ padding: '8px 16px', fontWeight: 600, color: ink }}>{new Date(entry.date).toLocaleDateString()}</td>
                                                        <td style={{ padding: '8px 16px', fontWeight: 600, color: teal[600] }}>{entry.accountName}</td>
                                                        <td style={{ padding: '8px 16px', color: inkSoft }}>{entry.description}</td>
                                                        <td style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 600, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>
                                                            {entry.type === 'Debit' ? `${currency}${entry.amount.toLocaleString()}` : '-'}
                                                        </td>
                                                        <td style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 600, color: ink, fontFamily: "'JetBrains Mono', monospace" }}>
                                                            {entry.type === 'Credit' ? `${currency}${entry.amount.toLocaleString()}` : '-'}
                                                        </td>
                                                    </tr>
                                                ))
                                            ) : (
                                                <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: inkSoft, fontStyle: 'italic' }}>No ledger entries found for this invoice.</td></tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'Payments' && (
                        <div className="space-y-6 animate-in fade-in duration-300">
                            <div style={{ borderRadius: 12, border: `1px solid ${hairline}`, overflow: 'hidden', background: paper }}>
                                <div style={{ padding: '12px 16px', borderBottom: `1px solid ${hairline}`, background: teal[50], display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <h3 style={{ margin: 0, fontSize: 12, color: ink, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <CreditCard size={16} color="#059669" /> Payment History
                                    </h3>
                                    <button onClick={() => navigate('/sales-flow/payments', { state: { action: 'create', customer: invoice.customerName, customerId: invoice.customerId, invoiceId: invoice.id } })}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#059669', fontWeight: 600, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                                        New Payment <ArrowRight size={12} />
                                    </button>
                                </div>
                                <div style={{ overflowX: 'auto' }}>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                        <thead>
                                            <tr style={{ borderBottom: `1px solid ${hairline}`, background: teal[50] }}>
                                                <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>Date</th>
                                                <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>Payment #</th>
                                                <th style={{ padding: '8px 16px', textAlign: 'left', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>Method</th>
                                                <th style={{ padding: '8px 16px', textAlign: 'right', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>Allocated</th>
                                                <th style={{ padding: '8px 16px', textAlign: 'center', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {paymentHistory.map(payment => (
                                                <tr key={payment.id} style={{ borderBottom: `1px solid ${hairline}` }}>
                                                    <td style={{ padding: '8px 16px', fontWeight: 600, color: ink }}>{new Date(payment.date).toLocaleDateString()}</td>
                                                    <td style={{ padding: '8px 16px', fontWeight: 600, color: teal[600] }}>{payment.id}</td>
                                                    <td style={{ padding: '8px 16px', fontWeight: 600, color: ink }}>{payment.paymentMethod}</td>
                                                    <td style={{ padding: '8px 16px', textAlign: 'right', fontWeight: 600, color: '#059669', fontFamily: "'JetBrains Mono', monospace" }}>
                                                        {currency}{(payment.allocations?.find(a => a.invoiceId === invoice.id)?.amount || 0).toLocaleString()}
                                                    </td>
                                                    <td style={{ padding: '8px 16px', textAlign: 'center' }}>
                                                        <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: payment.status === 'Cleared' ? '#ecfdf5' : payment.status === 'Bounced' ? '#fef2f2' : amber[100], color: payment.status === 'Cleared' ? '#059669' : payment.status === 'Bounced' ? '#dc2626' : '#d97706' }}>
                                                            {payment.status}
                                                        </span>
                                                    </td>
                                                </tr>
                                            ))}
                                            {paymentHistory.length === 0 && (
                                                <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: inkSoft, fontStyle: 'italic' }}>No payments recorded yet.</td></tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'Comments' && (
                        <div className="space-y-6 animate-in fade-in duration-300">
                            <div style={{ borderRadius: 12, border: `1px solid ${hairline}`, overflow: 'hidden', background: paper }}>
                                <div style={{ padding: '12px 16px', borderBottom: `1px solid ${hairline}`, background: teal[50], display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <h3 style={{ margin: 0, fontSize: 12, color: ink, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <MessageSquare size={16} color={teal[600]} /> Comments & Notes
                                    </h3>
                                    <span style={{ fontSize: 10, fontWeight: 700, background: teal[100], color: teal[600], padding: '2px 8px', borderRadius: 4 }}>
                                        {comments.length}
                                    </span>
                                </div>
                                <div style={{ padding: 16 }}>
                                    {comments.length === 0 && (
                                        <div style={{ padding: 24, textAlign: 'center', color: inkSoft, fontStyle: 'italic', fontSize: 12 }}>
                                            No comments yet. Add the first note below.
                                        </div>
                                    )}
                                    {comments.map(comment => (
                                        <div key={comment.id} style={{ display: 'flex', gap: 12, padding: 12, background: teal[50], borderRadius: 8, border: `1px solid ${teal[100]}`, marginBottom: 8 }}>
                                            <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: teal[200], color: teal[700] }}>
                                                <User size={14} />
                                            </div>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                                    <span style={{ fontSize: 12, fontWeight: 700, color: ink }}>{comment.author}</span>
                                                    <span style={{ fontSize: 11, color: inkSoft }}>{new Date(comment.date).toLocaleString()}</span>
                                                </div>
                                                <p style={{ margin: 0, fontSize: 12, color: ink, lineHeight: 1.5 }}>{comment.text}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div style={{ padding: 16, background: paper, borderRadius: 12, border: `1px solid ${hairline}` }}>
                                <h3 style={{ margin: '0 0 10px', fontSize: 11, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>Add a comment</h3>
                                <textarea
                                    value={newComment}
                                    onChange={e => setNewComment(e.target.value)}
                                    placeholder="Write a note about this invoice..."
                                    rows={3}
                                    style={{ width: '100%', padding: 10, borderRadius: 8, border: `1.4px solid ${hairline}`, fontSize: 12, fontFamily: "'Inter', sans-serif", color: ink, background: paper, resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
                                />
                                <button onClick={handleAddComment} disabled={!newComment.trim()}
                                    style={{ marginTop: 8, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', background: newComment.trim() ? `linear-gradient(155deg, ${teal[500]}, ${teal[700]})` : hairline, color: '#fff', fontWeight: 600, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <PlusCircle size={14} /> Post comment
                                </button>
                            </div>
                        </div>
                    )}

                    {activeTab === 'Activity' && (
                        <div className="space-y-6 animate-in fade-in duration-300">
                            <div style={{ borderRadius: 12, border: `1px solid ${hairline}`, overflow: 'hidden', background: paper }}>
                                <div style={{ padding: '12px 16px', borderBottom: `1px solid ${hairline}`, background: teal[50], display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <h3 style={{ margin: 0, fontSize: 12, color: ink, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <History size={16} color={teal[600]} /> Timeline
                                    </h3>
                                    <span style={{ fontSize: 10, fontWeight: 700, background: teal[100], color: teal[600], padding: '2px 8px', borderRadius: 4 }}>
                                        {timelineEvents.length} event{timelineEvents.length !== 1 ? 's' : ''}
                                    </span>
                                </div>
                                <div style={{ padding: 16, maxHeight: '60vh', overflowY: 'auto' }}>
                                    {timelineEvents.length === 0 ? (
                                        <div style={{ padding: 32, textAlign: 'center', color: inkSoft, fontStyle: 'italic' }}>No timeline events yet.</div>
                                    ) : (
                                        <div style={{ position: 'relative' }}>
                                            <div style={{ position: 'absolute', left: 16, top: 0, bottom: 0, width: 2, background: teal[100], borderRadius: 1 }} />
                                            {timelineEvents.map((event, idx) => (
                                                <div key={event.id} style={{ display: 'flex', gap: 12, padding: '10px 12px', position: 'relative', marginBottom: idx < timelineEvents.length - 1 ? 4 : 0 }}>
                                                    <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, background: event.bgColor, color: event.color, zIndex: 1, position: 'relative', border: `2px solid ${paper}` }}>
                                                        {event.icon}
                                                    </div>
                                                    <div style={{ flex: 1, paddingBottom: idx < timelineEvents.length - 1 ? 12 : 0, borderBottom: idx < timelineEvents.length - 1 ? `1px solid ${hairline}` : 'none' }}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 2 }}>
                                                            <span style={{ fontSize: 12, fontWeight: 700, color: ink }}>{event.title}</span>
                                                            <span style={{ fontSize: 10, color: inkSoft, whiteSpace: 'nowrap', marginLeft: 8 }}>{event.date.toLocaleString()}</span>
                                                        </div>
                                                        {event.description && (
                                                            <p style={{ margin: '0 0 4px', fontSize: 11, color: inkSoft, lineHeight: 1.4 }}>{event.description}</p>
                                                        )}
                                                        {event.amount != null && event.amount > 0 && (
                                                            <span style={{ fontSize: 13, fontWeight: 800, color: event.color, fontFamily: "'JetBrains Mono', monospace" }}>
                                                                {currency}{event.amount.toLocaleString()}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div style={{ borderRadius: 12, border: `1px solid ${hairline}`, overflow: 'hidden', background: paper }}>
                                <div style={{ padding: '12px 16px', borderBottom: `1px solid ${hairline}`, background: teal[50] }}>
                                    <h3 style={{ margin: 0, fontSize: 12, color: ink, display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <History size={16} color={teal[600]} /> Detailed Audit Trail
                                    </h3>
                                </div>
                                <div style={{ padding: 16 }}>
                                    {auditLogs.filter(log => log.entityId === invoice.id).length > 0 ? (
                                        auditLogs.filter(log => log.entityId === invoice.id)
                                            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                                            .map(log => (
                                                <div key={log.id} style={{ display: 'flex', gap: 12, padding: 12, background: teal[50], borderRadius: 8, border: `1px solid ${teal[100]}`, marginBottom: 8 }}>
                                                    <div style={{ width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                                                        background: log.action === 'CREATE' ? '#ecfdf5' : log.action === 'UPDATE' ? '#eff6ff' : log.action === 'VOID' ? '#fef2f2' : hairline,
                                                        color: log.action === 'CREATE' ? '#059669' : log.action === 'UPDATE' ? '#2563eb' : log.action === 'VOID' ? '#dc2626' : inkSoft }}>
                                                        {log.action === 'CREATE' ? <Plus size={13} /> : log.action === 'UPDATE' ? <Edit2 size={13} /> : <Trash2 size={13} />}
                                                    </div>
                                                    <div style={{ flex: 1 }}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                                            <span style={{ fontSize: 12, fontWeight: 700, color: ink, textTransform: 'uppercase' }}>{log.action} {log.entityType}</span>
                                                            <span style={{ fontSize: 11, color: inkSoft }}>{new Date(log.date).toLocaleString()}</span>
                                                        </div>
                                                        <p style={{ margin: 0, fontSize: 12, color: ink, lineHeight: 1.5 }}>{log.details}</p>
                                                        <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
                                                            <span style={{ fontSize: 10, fontWeight: 700, background: hairline, color: inkSoft, padding: '1px 6px', borderRadius: 4, textTransform: 'uppercase' }}>{log.userId}</span>
                                                            <span style={{ fontSize: 10, color: inkSoft, textTransform: 'uppercase' }}>{log.userRole}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))
                                    ) : (
                                        <div style={{ padding: 32, textAlign: 'center', color: inkSoft, fontStyle: 'italic' }}>No activity recorded in the logs.</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                {showAllocationModal && (
                    <div style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15, 23, 42, 0.6)' }}>
                        <div style={{ width: 480, background: paper, borderRadius: 14, boxShadow: '0 30px 70px -20px rgba(0,0,0,.55)', overflow: 'hidden' }}>
                            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${hairline}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <h3 style={{ margin: 0, fontSize: 13, color: ink, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <Wallet size={16} color="#059669" /> Apply Customer Credits
                                </h3>
                                <button onClick={() => setShowAllocationModal(false)} style={{ padding: 4, border: 'none', background: 'transparent', cursor: 'pointer', color: inkSoft }}>
                                    <X size={16} />
                                </button>
                            </div>
                            <div style={{ padding: 16, maxHeight: '50vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {availableCredits.map(payment => (
                                    <div key={payment.id} onClick={() => handleAllocateCredit(payment)}
                                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, border: `1px solid ${hairline}`, borderRadius: 10, cursor: 'pointer', background: paper }}>
                                        <div>
                                            <div style={{ fontWeight: 600, color: ink, fontSize: 12 }}>Payment #{payment.id}</div>
                                            <div style={{ fontSize: 11, color: inkSoft, marginTop: 2 }}>Found: {new Date(payment.date).toLocaleDateString()}</div>
                                        </div>
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{ fontSize: 15, fontWeight: 700, color: '#059669' }}>{currency}{(payment.creditApplied || 0).toLocaleString()}</div>
                                            <div style={{ fontSize: 10, color: inkSoft, textTransform: 'uppercase' }}>Avail. Fund</div>
                                        </div>
                                    </div>
                                ))}
                                {availableCredits.length === 0 && (
                                    <div style={{ padding: 32, textAlign: 'center', color: inkSoft, fontStyle: 'italic' }}>No available credits for this client.</div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                    gap: 10, padding: '16px 28px',
                    borderTop: `1px solid ${hairline}`, background: paper
                }}>
                    <button type="button" onClick={onClose}
                        style={{
                            fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
                            padding: '9px 18px', borderRadius: 9, cursor: 'pointer',
                            background: paper, border: `1.4px solid ${hairline}`, color: inkSoft,
                            display: 'flex', alignItems: 'center', gap: 7, transition: 'all .15s ease'
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                        onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};
