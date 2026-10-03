import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Banknote, CreditCard, Smartphone, Briefcase, X, Wallet, Award, Clock, CheckCircle2, AlertCircle, ArrowLeftRight } from 'lucide-react';
import type { PaymentDetail } from '../../../types';
import { useAuth } from '../../../context/AuthContext';
import { useBankingStore } from '../../../context/BankingContext';
import { DEFAULT_ACCOUNTS, ACCOUNT_IDS } from '../../../constants';
import { currencyService } from '../../../services/currencyService';
import { formatNumber } from '../../../utils/helpers';
import { useModalA11y } from '../../../utils/useModalA11y';
import { formatAmount, formatMoney, formatSignedMoney, getQuickCashPresets } from '../../../utils/posMoney';
import { FOCUS_RING, NUMERIC_FONT, danger, type } from '../theme';

interface PaymentModalProps {
    total: number;
    onComplete: (paymentMethods: PaymentDetail[], excessHandling?: 'Change' | 'Wallet') => void;
    onCancel: () => void;
    customerName: string | null;
    walletBalance: number;
    loyaltyPoints?: number;
    adjustmentSummary?: { adjustmentId: string; adjustmentName: string; totalAmount: number; itemCount: number; }[];
    totalProfitMargin?: number;
    orderNumber: string;
}

const teal: Record<string, string> = { 50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7', 400: '#3fa294', 500: '#1f8577', 600: '#146b60', 700: '#0f544c', 800: '#0b3e39', 900: '#082e2a' };
const amber: Record<string, string> = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' };
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';

export const PaymentModal: React.FC<PaymentModalProps> = ({
    total,
    onComplete,
    onCancel,
    customerName,
    walletBalance,
    loyaltyPoints = 0,
    adjustmentSummary = [],
    totalProfitMargin = 0,
    orderNumber
}) => {
    const { companyConfig, notify } = useAuth();
    const { accounts: bankAccounts, fetchBankingData } = useBankingStore();
    const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';
    const [splitPayments, setSplitPayments] = useState<PaymentDetail[]>([]);
    const [currentPaymentAmount, setCurrentPaymentAmount] = useState(() => (Number.isFinite(total) ? total.toFixed(2) : ''));
    const [activePaymentMethod, setActivePaymentMethod] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [inlineError, setInlineError] = useState<string | null>(null);
    const submittingRef = useRef(false);

    const r2 = (v: number) => Math.round(v * 100) / 100;
    const pointsConversionRate = 0.10;
    const quickCashPresets = getQuickCashPresets(companyConfig?.currencySymbol);

    const quickCashBtn = (active: boolean): React.CSSProperties => ({
        flex: '1 1 90px',
        textAlign: 'center',
        padding: '8px 10px',
        border: `1.4px solid ${hairline}`,
        borderRadius: 8,
        fontFamily: NUMERIC_FONT,
        fontSize: 12.5,
        color: inkSoft,
        cursor: 'pointer',
        background: active ? '#eef7f6' : paper,
        transition: 'all .12s',
    });

    const handleCancel = useCallback(() => {
        // Guarded so an in-flight commit can never be dismissed out from under
        // its own error reporting.
        if (submittingRef.current) return;
        setActivePaymentMethod(null);
        setInlineError(null);
        onCancel();
    }, [onCancel]);

    // Escape is suppressed while a sale is submitting — see handleCancel.
    const a11yRef = useModalA11y(true, handleCancel, 'Payment', { closeOnEscape: !isSubmitting });

    useEffect(() => {
        fetchBankingData?.();
    }, [fetchBankingData]);

    useEffect(() => {
        if (!bankAccounts || bankAccounts.length === 0) {
            fetchBankingData?.();
        }
    }, [bankAccounts?.length, fetchBankingData]);

    // Re-seed the tender field only when it is empty/zero and the bill total
    // changes — never while the cashier is typing.
    useEffect(() => {
        if (splitPayments.length === 0 && total > 0) {
            setCurrentPaymentAmount(prev => {
                const parsed = parseFloat(prev);
                if (prev === '' || !Number.isFinite(parsed) || parsed === 0) return total.toFixed(2);
                return prev;
            });
        }
    }, [total, splitPayments.length]);

    const typedAmount = useMemo(() => {
        const parsed = parseFloat(currentPaymentAmount);
        return Number.isFinite(parsed) ? parsed : 0;
    }, [currentPaymentAmount]);

    const splitPaid = useMemo(
        () => r2(splitPayments.reduce((sum, p) => sum + p.amount, 0)),
        [splitPayments]
    );

    // Single source of truth: everything is derived from committed splits plus
    // the amount currently in the tender field. No imperative writers.
    const tenderedTotal = useMemo(() => r2(splitPaid + typedAmount), [splitPaid, typedAmount]);
    const changeDue = useMemo(() => Math.max(0, r2(tenderedTotal - total)), [tenderedTotal, total]);
    const effectiveRemainingDue = useMemo(() => Math.max(0, r2(total - tenderedTotal)), [tenderedTotal, total]);

    const canCompleteSale = useMemo(() => {
        if (tenderedTotal <= 0) return false;
        return tenderedTotal >= total - 0.01;
    }, [tenderedTotal, total]);

    const handleComplete = useCallback(async () => {
        if (submittingRef.current) return;
        // Mirrors exactly what will be submitted below — committed splits plus
        // any unmethoded tender in the input (defaulting to Cash).
        const paymentsToSubmit: PaymentDetail[] = [
            ...splitPayments,
            ...(typedAmount > 0 ? [{
                id: `PMT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                method: 'Cash',
                amount: typedAmount,
                accountId: ACCOUNT_IDS.CASH_DRAWER,
                date: new Date().toISOString()
            }] : [])
        ];
        const totalPaid = paymentsToSubmit.reduce((sum, p) => sum + p.amount, 0);

        if (paymentsToSubmit.length === 0) {
            setInlineError("Select a payment method or enter amount received.");
            notify("Select a payment method or enter amount received.", "error");
            return;
        }

        if (totalPaid < total - 0.01) {
            setInlineError("Amount tendered cannot be less than bill total.");
            notify("Amount tendered cannot be less than bill total.", "error");
            return;
        }

        try {
            submittingRef.current = true;
            setIsSubmitting(true);
            setInlineError(null);
            await Promise.resolve(onComplete(paymentsToSubmit, 'Change'));
            setActivePaymentMethod(null);
        } catch (error: any) {
            const message = error?.message || 'Error processing sale';
            setInlineError(message);
            notify(message, 'error');
        } finally {
            submittingRef.current = false;
            setIsSubmitting(false);
        }
    }, [isSubmitting, splitPayments, typedAmount, total, onComplete, notify]);

    const addPaymentMethod = useCallback((accountId: string) => {
        const amountInput = parseFloat(currentPaymentAmount);
        if (isNaN(amountInput) || amountInput <= 0) {
            setInlineError("Please enter a valid positive payment amount.");
            notify("Please enter a valid positive payment amount.", "error");
            return;
        }

        let method: string;
        if (accountId === 'WALLET') {
            if (amountInput > walletBalance) {
                const message = `Insufficient wallet balance. Available: ${currency}${formatNumber(walletBalance)}`;
                setInlineError(message);
                notify(message, "error");
                return;
            }
            method = 'Wallet';
        } else if (accountId === 'LOYALTY') {
            const availableValue = loyaltyPoints * pointsConversionRate;
            if (amountInput > availableValue) {
                const message = `Insufficient loyalty points. Max value: ${currency}${formatNumber(availableValue)}`;
                setInlineError(message);
                notify(message, "error");
                return;
            }
            method = 'Loyalty';
        } else {
            const account = DEFAULT_ACCOUNTS.find(a => a.id === accountId);
            if (!account) return;
            method = accountId === ACCOUNT_IDS.CASH_DRAWER || account.name.includes('Cash') ? 'Cash' :
                (accountId === ACCOUNT_IDS.MOBILE_MONEY || account.name.includes('Mobile') ? 'Mobile Money' : 'Bank Transfer');
        }

        const newSplit: PaymentDetail[] = [...splitPayments, {
            id: `PMT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            method,
            amount: amountInput,
            accountId,
            date: new Date().toISOString()
        }];
        setSplitPayments(newSplit);
        setInlineError(null);
        setActivePaymentMethod(accountId);

        const nextDue = r2(total - newSplit.reduce((sum, p) => sum + p.amount, 0));
        setCurrentPaymentAmount(nextDue > 0.01 ? nextDue.toFixed(2) : '');
    }, [currentPaymentAmount, splitPayments, total, notify, currency, walletBalance, loyaltyPoints]);

    useEffect(() => {
        const handleGlobalKeys = (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !submittingRef.current && canCompleteSale) {
                e.preventDefault();
                handleComplete();
            }
             if (e.altKey) {
                 if (e.key === '1') addPaymentMethod(ACCOUNT_IDS.CASH_DRAWER);
                 if (e.key === '2') addPaymentMethod(ACCOUNT_IDS.BANK);
                 if (e.key === '3') addPaymentMethod(ACCOUNT_IDS.MOBILE_MONEY);
             }
        };
        window.addEventListener('keydown', handleGlobalKeys);
        return () => window.removeEventListener('keydown', handleGlobalKeys);
    }, [canCompleteSale, handleComplete, addPaymentMethod]);

    const normalizedBankAccounts = useMemo(() => {
        return (bankAccounts || []).filter(acc => acc.status !== 'Closed');
    }, [bankAccounts]);

    const resolveBankAccount = (
        tokens: string[],
        options?: { allowBankNameMatch?: boolean; excludeNameTokens?: string[] }
    ) => {
        if (normalizedBankAccounts.length === 0) return undefined;
        const loweredTokens = tokens.map(token => token.toLowerCase());
        const exclude = (options?.excludeNameTokens || []).map(token => token.toLowerCase());

        const byAccountNumber = normalizedBankAccounts.find(acc => {
            const accountNumber = (acc.accountNumber || '').toLowerCase();
            return loweredTokens.some(token => accountNumber.includes(token));
        });
        if (byAccountNumber) return byAccountNumber;

        const byName = normalizedBankAccounts.find(acc => {
            const name = (acc.name || '').toLowerCase();
            return loweredTokens.some(token => name.includes(token));
        });
        if (byName) return byName;

        if (!options?.allowBankNameMatch) return undefined;

        return normalizedBankAccounts.find(acc => {
            const name = (acc.name || '').toLowerCase();
            const bank = (acc.bankName || '').toLowerCase();
            if (exclude.some(token => name.includes(token))) return false;
            return loweredTokens.some(token => bank.includes(token));
        });
    };

    const cashBankAccount = useMemo(
        () => resolveBankAccount(['cash'], { allowBankNameMatch: false }),
        [normalizedBankAccounts]
    );
    const bankBankAccount = useMemo(
        () => resolveBankAccount(['bank'], { allowBankNameMatch: true, excludeNameTokens: ['cash', 'mobile', 'momo'] }),
        [normalizedBankAccounts]
    );
    const mobileBankAccount = useMemo(
        () => resolveBankAccount(['mobile', 'momo', 'money'], { allowBankNameMatch: true, excludeNameTokens: ['cash', 'bank'] }),
        [normalizedBankAccounts]
    );

    const cashBalance = cashBankAccount?.availableBalance ?? cashBankAccount?.balance;
    const bankBalance = bankBankAccount?.availableBalance ?? bankBankAccount?.balance;
    const mobileBalance = mobileBankAccount?.availableBalance ?? mobileBankAccount?.balance;
    const formatBalance = (value?: number) => (value === undefined ? '--' : `${currency}${formatNumber(value)}`);

    const adjustmentTotal = useMemo(() => {
        if (!adjustmentSummary || adjustmentSummary.length === 0) return 0;
        return adjustmentSummary.reduce((sum, adj) => sum + (adj.totalAmount || 0), 0);
    }, [adjustmentSummary]);

    return (
        <div ref={a11yRef} role="dialog" aria-modal="true" aria-label="Payment" style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(15, 23, 42, 0.6)',
            padding: '40px 20px', fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink,
        }}>
            <div style={{
                width: 680, maxWidth: '100%', maxHeight: '92vh',
                background: paper, borderRadius: 14,
                boxShadow: '0 30px 70px -20px rgba(0,0,0,.55), 0 8px 24px -8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04)',
                display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative'
            }}>
                <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0, height: 4,
                    background: `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 40%, ${amber[500]} 100%)`
                }} />

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 28px 18px', borderBottom: `1px solid ${hairline}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <div style={{
                            width: 40, height: 40, borderRadius: 10,
                            background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            boxShadow: `0 4px 10px -3px rgba(15,84,76,.6)`, flexShrink: 0
                        }}>
                            <Wallet size={19} color="#fff" />
                        </div>
                        <div>
                            <h1 style={{ fontFamily: "'Inter','DM Sans',sans-serif", fontWeight: 400, fontSize: 22, margin: 0, color: teal[800], letterSpacing: 0.2 }}>Payment</h1>
                            <p style={{ margin: '2px 0 0', fontSize: 11.5, color: inkSoft, letterSpacing: 0.02 }}>{orderNumber}</p>
                        </div>
                    </div>
                    <button onClick={handleCancel} aria-label={isSubmitting ? undefined : 'Close payment'} disabled={isSubmitting} style={{
                        width: 32, height: 32, borderRadius: 8,
                        border: `1px solid ${hairline}`, background: paper, color: inkSoft,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        cursor: isSubmitting ? 'not-allowed' : 'pointer',
                        opacity: isSubmitting ? 0.45 : 1,
                        transition: 'all .15s ease'
                    }}
                        onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; }}
                        onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
                    ><X size={15} /></button>
                </div>

                <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                    <div style={{ width: 240, background: teal[50], padding: '18px 16px 14px', borderRight: `1px solid ${hairline}`, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 2 }}>Order total</div>
                        <div style={{ padding: '8px 0 12px', borderBottom: `1px dashed ${teal[200]}`, marginBottom: 10 }}>
                            <div style={{ fontSize: 11, color: inkSoft }}>Due</div>
                            <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 22, fontWeight: 700, color: ink, marginTop: 2 }}>
                                {currency}{formatNumber(total || 0)}
                            </div>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', fontSize: 13 }}>
                            <span style={{ color: inkSoft }}>Adjustments</span>
                            {/* Was `+{currency}{amount}` — rendered "+K-50.00" whenever a
                                market adjustment was negative (e.g. a discount). */}
                            <span style={{ ...type.money, fontSize: 13, fontWeight: 600, color: adjustmentTotal < 0 ? danger : ink }}>
                                {formatSignedMoney(adjustmentTotal, currency, companyConfig?.currencySymbol)}
                            </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', fontSize: 13 }}>
                            <span style={{ color: inkSoft }}>Margin</span>
                            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: teal[600] }}>{currency}{formatNumber(totalProfitMargin)}</span>
                        </div>

                        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.08, textTransform: 'uppercase', color: inkSoft, margin: '12px 0 5px' }}>Balances</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: paper, border: `1px solid ${hairline}`, borderRadius: 7, padding: '6px 10px', fontSize: 12.5 }}>
                                <span style={{ color: ink, fontWeight: 600 }}>Cash</span>
                                <span style={{ fontFamily: "'JetBrains Mono',monospace", color: inkSoft }}>{formatBalance(cashBalance)}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: paper, border: `1px solid ${hairline}`, borderRadius: 7, padding: '6px 10px', fontSize: 12.5 }}>
                                <span style={{ color: ink, fontWeight: 600 }}>Bank</span>
                                <span style={{ fontFamily: "'JetBrains Mono',monospace", color: inkSoft }}>{formatBalance(bankBalance)}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: paper, border: `1px solid ${hairline}`, borderRadius: 7, padding: '6px 10px', fontSize: 12.5 }}>
                                <span style={{ color: ink, fontWeight: 600 }}>Mobile</span>
                                <span style={{ fontFamily: "'JetBrains Mono',monospace", color: inkSoft }}>{formatBalance(mobileBalance)}</span>
                            </div>
                        </div>

                        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
                            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.08, textTransform: 'uppercase', color: teal[600] }}>{changeDue > 0 ? 'Change' : 'Remaining'}</div>
                            <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 24, fontWeight: 700, color: teal[600], marginTop: 2 }}>
                                {changeDue > 0 ? currency + formatNumber(changeDue) : currency + formatNumber(effectiveRemainingDue || 0)}
                            </div>
                        </div>
                    </div>

                    <div style={{ flex: 1, padding: '18px 22px 14px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <label htmlFor="pos-tender-amount" style={{ ...type.sectionLabel, color: inkSoft, marginBottom: 6, display: 'block' }}>
                            Amount received
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
                            <div style={{ flex: '1 1 180px', display: 'flex', alignItems: 'center', border: `1.4px solid ${hairline}`, borderRadius: 9, padding: '0 14px', height: 48 }}>
                                <span aria-hidden="true" style={{ ...type.numeric, fontWeight: 600, color: inkSoft, marginRight: 8, fontSize: 17 }}>{currency}</span>
                                {/* Previously had NO label element and NO aria-label — the most
                                    important input in POS announced as "edit text, blank". */}
                                <input
                                    id="pos-tender-amount"
                                    type="text"
                                    inputMode="decimal"
                                    aria-describedby="pos-tender-remaining"
                                    style={{ border: 'none', outline: 'none', fontFamily: NUMERIC_FONT, fontSize: 17, fontWeight: 500, width: '100%', color: ink, background: 'transparent' }}
                                    placeholder="0.00"
                                    value={currentPaymentAmount}
                                    onChange={e => { const val = e.target.value; if (val === '' || /^\d*\.?\d*$/.test(val)) setCurrentPaymentAmount(val); }}
                                    onFocus={e => { e.currentTarget.parentElement!.style.boxShadow = FOCUS_RING; }}
                                    onBlur={e => { e.currentTarget.parentElement!.style.boxShadow = 'none'; }}
                                    autoFocus
                                />
                            </div>
                            <div style={{ textAlign: 'right' }}>
                                <div id="pos-tender-remaining" style={{ ...type.sectionLabel, fontSize: 9, color: inkSoft, letterSpacing: 0.06 }}>
                                    Remaining
                                </div>
                                <div style={{ ...type.money, fontSize: 17, color: teal[600] }}>
                                    {formatMoney(effectiveRemainingDue, currency, companyConfig?.currencySymbol)}
                                </div>
                            </div>
                        </div>

                        <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 6 }}>Payment method</div>
                        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                         {[
                                  { id: ACCOUNT_IDS.CASH_DRAWER, icon: Banknote, label: 'Cash' },
                                  { id: ACCOUNT_IDS.BANK, icon: CreditCard, label: 'Bank' },
                                  { id: ACCOUNT_IDS.MOBILE_MONEY, icon: Smartphone, label: 'Mobile' },
                              ].map(btn => {
                                const isActive = activePaymentMethod === btn.id;
                                const Icon = btn.icon;
                                return (
                                    <button key={btn.id} onClick={() => addPaymentMethod(btn.id)}
                                        style={{
                                            flex: 1, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center',
                                            border: `1.4px solid ${isActive ? teal[400] : hairline}`,
                                            borderRadius: 8, padding: '10px 8px', fontSize: 13, fontWeight: 600,
                                            color: isActive ? teal[600] : ink, cursor: 'pointer',
                                            background: isActive ? teal[50] : paper, transition: 'all .12s',
                                            fontFamily: 'inherit'
                                        }}>
                                        <Icon size={17} /> {btn.label}
                                    </button>
                                );
                            })}
                            {customerName && walletBalance > 0 && (
                                <button onClick={() => addPaymentMethod('WALLET')}
                                    style={{
                                        flex: 1, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center',
                                        border: `1.4px solid ${activePaymentMethod === 'WALLET' ? teal[400] : hairline}`,
                                        borderRadius: 8, padding: '10px 8px', fontSize: 13, fontWeight: 600,
                                        color: activePaymentMethod === 'WALLET' ? teal[600] : ink, cursor: 'pointer',
                                        background: activePaymentMethod === 'WALLET' ? teal[50] : paper, transition: 'all .12s',
                                        fontFamily: 'inherit'
                                    }}>
                                    <Wallet size={17} /> Wallet
                                </button>
                            )}
                            {customerName && loyaltyPoints > 0 && (
                                <button onClick={() => addPaymentMethod('LOYALTY')}
                                    style={{
                                        flex: 1, display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center',
                                        border: `1.4px solid ${activePaymentMethod === 'LOYALTY' ? teal[400] : hairline}`,
                                        borderRadius: 8, padding: '10px 8px', fontSize: 13, fontWeight: 600,
                                        color: activePaymentMethod === 'LOYALTY' ? teal[600] : ink, cursor: 'pointer',
                                        background: activePaymentMethod === 'LOYALTY' ? teal[50] : paper, transition: 'all .12s',
                                        fontFamily: 'inherit'
                                    }}>
                                    <Award size={17} /> Loyalty
                                </button>
                            )}
                        </div>

                        {/* Tender presets were hardcoded to 5,000 / 10,000 regardless of currency,
                which is meaningless for USD/EUR and too small for JPY. */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        onClick={() => setCurrentPaymentAmount(Number.isFinite(total) ? total.toFixed(2) : '')}
                        style={quickCashBtn(false)}
                        onFocus={e => { e.currentTarget.style.boxShadow = FOCUS_RING; }}
                        onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }}
                    >
                        Exact
                    </button>
                    {quickCashPresets.map(amount => (
                        <button
                            key={amount}
                            type="button"
                            onClick={() => setCurrentPaymentAmount(prev => (Number(prev) + amount).toFixed(2))}
                            style={quickCashBtn(false)}
                            onFocus={e => { e.currentTarget.style.boxShadow = FOCUS_RING; }}
                            onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }}
                        >
                            {`+${currency}${formatAmount(amount, companyConfig?.currencySymbol)}`}
                        </button>
                    ))}
                </div>

                        {splitPayments.length > 0 && (
                            <div style={{ marginBottom: 12 }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, marginBottom: 5 }}>Payment Breakdown</div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                    {splitPayments.map((p, i) => (
                                        <div key={i} style={{ background: teal[50], padding: '5px 10px', borderRadius: 7, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, border: `1px solid ${teal[100]}` }}>
                                            <span style={{ fontWeight: 600, color: teal[600] }}>{p.method}</span>
                                            <span style={{ fontFamily: "'JetBrains Mono',monospace", fontWeight: 600, color: ink }}>{currency}{formatNumber(p.amount)}</span>
                                            <button
                                                type="button"
                                                aria-label={`Remove ${p.method} payment of ${currency}${formatNumber(p.amount)}`}
                                                onClick={() => {
                                                    const remainingSplits = splitPayments.filter((_, idx) => idx !== i);
                                                    setSplitPayments(remainingSplits);
                                                    setActivePaymentMethod(null);
                                                    const totalPaid = remainingSplits.reduce((s, x) => s + x.amount, 0);
                                                    const nextDue = r2(total - totalPaid);
                                                    setCurrentPaymentAmount(nextDue > 0.01 ? nextDue.toFixed(2) : '');
                                                }}
                                                style={{ border: 'none', background: 'none', cursor: 'pointer', color: inkSoft, padding: 2, fontSize: 16, lineHeight: 1, borderRadius: 4, display: 'flex' }}
                                                onFocus={e => { e.currentTarget.style.boxShadow = FOCUS_RING; }}
                                                onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }}
                                            >&times;</button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {changeDue > 0 && (
                            <div style={{ background: teal[50], border: `1px solid ${teal[200]}`, borderRadius: 8, padding: '8px 12px', marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 12, fontWeight: 600, color: teal[600] }}>Change due</span>
                                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 17, fontWeight: 700, color: teal[600] }}>{currency}{formatNumber(changeDue)}</span>
                            </div>
                        )}

                        {inlineError && (
                            <div role="alert" style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <AlertCircle size={14} color="#dc2626" />
                                <span style={{ fontSize: 12, fontWeight: 600, color: '#b5493f', flex: 1 }}>{inlineError}</span>
                                <button onClick={() => setInlineError(null)} aria-label="Dismiss error" style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b5493f', padding: 0, fontSize: 14 }}>&times;</button>
                            </div>
                        )}

                        <div style={{ flex: 1 }} />
                        <button onClick={handleComplete} disabled={!canCompleteSale || isSubmitting}
                            style={{
                                width: '100%', border: 'none', borderRadius: 9, padding: '13px 0',
                                fontFamily: "'Inter', sans-serif", fontSize: 14, fontWeight: 600,
                                background: (canCompleteSale && !isSubmitting) ? `linear-gradient(155deg, ${teal[500]}, ${teal[700]})` : teal[50],
                                color: (canCompleteSale && !isSubmitting) ? '#fff' : inkSoft,
                                cursor: (canCompleteSale && !isSubmitting) ? 'pointer' : 'default',
                                boxShadow: (canCompleteSale && !isSubmitting) ? '0 6px 16px -6px rgba(15,84,76,.55)' : 'none',
                                transition: 'all .15s'
                            }}>
                            {isSubmitting ? 'Processing...' : (!canCompleteSale ? 'Awaiting payment' : 'Complete Sale')}
                        </button>
                    </div>
                </div>

                <button
                    type="button"
                    onClick={handleCancel}
                    disabled={isSubmitting}
                    style={{
                        display: 'flex', alignItems: 'center', gap: 5, width: '100%',
                        padding: '11px 24px', borderTop: `1px solid ${hairline}`, border: 'none',
                        borderRadius: 0, background: 'transparent',
                        fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
                        color: inkSoft, cursor: isSubmitting ? 'not-allowed' : 'pointer',
                        opacity: isSubmitting ? 0.5 : 1, textAlign: 'left',
                    }}
                    onFocus={e => { e.currentTarget.style.boxShadow = `inset ${FOCUS_RING}`; }}
                    onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }}
                >
                    &larr; Back to register
                </button>
            </div>
        </div>
    );
};
