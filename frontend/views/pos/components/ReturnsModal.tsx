import React, { useMemo, useState } from 'react';
import { ArrowLeftRight, Search, CheckCircle, AlertTriangle } from 'lucide-react';
import { PosModal } from './PosModal';
import { Button, Money } from './Button';
import { Sale } from '../../../types';
import { useAuth } from '../../../context/AuthContext';
import { useBankingStore } from '../../../context/BankingContext';
import { formatMoney } from '../../../utils/posMoney';
import {
    FOCUS_RING,
    NUMERIC_FONT,
    borderWarning,
    hairline,
    ink,
    inkSoft,
    radius,
    surfaceWarning,
    teal,
    textWarning,
} from '../theme';

type RefundLine = { itemId: string; qty: number };

export const ReturnsModal: React.FC<{
    sales: Sale[];
    onProcess: (saleId: string, items: RefundLine[], accountId: string) => void;
    onClose: () => void;
}> = ({ sales, onProcess, onClose }) => {
    const { companyConfig, notify } = useAuth();
    const { accounts: bankAccounts } = useBankingStore();
    const currencySymbol = companyConfig?.currencySymbol || '';
    const currencyCode = companyConfig?.currencySymbol || null;

    const [searchTerm, setSearchTerm] = useState('');
    const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
    const [returnItems, setReturnItems] = useState<RefundLine[]>([]);
    const [refundAccountId, setRefundAccountId] = useState('');
    const [confirming, setConfirming] = useState(false);

    /**
     * Accounts come from live banking data. The previous implementation filtered
     * the static DEFAULT_ACCOUNTS constant, so a closed or renamed account could
     * still be selected and receive a refund.
     */
    const cashBankAccounts = useMemo(() => {
        const live = (bankAccounts || []) as any[];
        if (live.length === 0) return [];
        return live.filter(acc => {
            if (acc.status === 'Closed') return false;
            const type = String(acc.accountType || acc.type || '').toUpperCase();
            if (type && !['CASH', 'BANK', 'MOBILE_MONEY', 'MOBILE'].includes(type)) return false;
            return true;
        });
    }, [bankAccounts]);

    // Default to the first live account once they arrive.
    const activeAccountId = refundAccountId || cashBankAccounts[0]?.id || '';
    const activeAccount = cashBankAccounts.find(a => a.id === activeAccountId);

    /**
     * Search returns a ranked LIST. The old implementation used `sales.find(...)`
     * with `includes`, so typing "REC-1" silently refunded whichever of
     * REC-1 / REC-10 / REC-11 happened to be first in the array.
     */
    const results = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        if (!term) return [];
        return (sales || [])
            .map(sale => {
                const id = String(sale.id || '').toLowerCase();
                const receipt = String(sale.receiptNumber || '').toLowerCase();
                const customer = String(sale.customerName || '').toLowerCase();
                let rank = -1;
                if (id === term || receipt === term) rank = 0;
                else if (id.startsWith(term) || receipt.startsWith(term)) rank = 1;
                else if (customer.startsWith(term)) rank = 2;
                else if (id.includes(term) || receipt.includes(term) || customer.includes(term)) rank = 3;
                return { sale, rank };
            })
            .filter(r => r.rank >= 0)
            .sort((a, b) => a.rank - b.rank)
            .slice(0, 25);
    }, [sales, searchTerm]);

    const hasSearched = searchTerm.trim().length > 0;

    const toggleItem = (itemId: string, max: number) => {
        setReturnItems(prev =>
            prev.some(i => i.itemId === itemId)
                ? prev.filter(i => i.itemId !== itemId)
                : [...prev, { itemId, qty: max }]
        );
    };

    /**
     * Clearing the field must NOT deselect the row. The previous handler mapped
     * an unparseable value to 0, and 0 removed the line — so a single stray
     * keystroke silently deleted the selection.
     */
    const updateItemQty = (itemId: string, raw: string, max: number) => {
        const parsed = parseInt(raw, 10);
        if (!Number.isFinite(parsed)) {
            // Unparseable mid-edit: hold the previous value rather than mutating.
            return;
        }
        const clamped = Math.max(0, Math.min(parsed, max));
        setReturnItems(prev => {
            if (clamped === 0) return prev.filter(i => i.itemId !== itemId);
            const exists = prev.some(i => i.itemId === itemId);
            return exists
                ? prev.map(i => (i.itemId === itemId ? { ...i, qty: clamped } : i))
                : [...prev, { itemId, qty: clamped }];
        });
    };

    const refundTotal = useMemo(() => {
        if (!selectedSale) return 0;
        const items = selectedSale.items || [];
        return returnItems.reduce((sum, r) => {
            const line = items.find(i => i.id === r.itemId);
            return sum + (Number(line?.price) || 0) * r.qty;
        }, 0);
    }, [selectedSale, returnItems]);

    const refundUnits = returnItems.reduce((s, r) => s + r.qty, 0);

    const resetAll = () => {
        setSelectedSale(null);
        setReturnItems([]);
        setSearchTerm('');
        setConfirming(false);
    };

    const handleConfirmClick = () => {
        if (!selectedSale || returnItems.length === 0) return;
        if (!activeAccountId) {
            notify('Select the account to refund from', 'error');
            return;
        }
        setConfirming(true);
    };

    const commitRefund = () => {
        if (!selectedSale) return;
        onProcess(selectedSale.id, returnItems, activeAccountId);
    };

    /* ---------------------------------------------------------------- */
    /* Confirmation — an irreversible, ledger-posting refund gets an     */
    /* explicit review step showing the exact amount and destination.   */
    /* ---------------------------------------------------------------- */
    if (confirming && selectedSale) {
        return (
            <PosModal
                open
                onClose={() => setConfirming(false)}
                title="Confirm Refund"
                subtitle={`Sale #${selectedSale.id}`}
                icon={<AlertTriangle size={19} color="#fff" />}
                size="sm"
                footer={
                    <>
                        <Button variant="secondary" onClick={() => setConfirming(false)}>Back</Button>
                        <Button variant="danger" onClick={commitRefund} icon={<CheckCircle size={15} />}>
                            Refund {formatMoney(refundTotal, currencySymbol, currencyCode)}
                        </Button>
                    </>
                }
            >
                <div style={{ padding: '20px 24px' }}>
                    <p style={{ margin: '0 0 16px', fontSize: 13, lineHeight: 1.55, color: inkSoft }}>
                        This posts a refund to the ledger and restocks the returned units. It cannot be undone
                        from the register.
                    </p>

                    <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <Row label="Customer" value={selectedSale.customerName || 'Walk-in'} />
                        <Row label="Units returned" value={String(refundUnits)} />
                        <Row label="Refund from" value={activeAccount?.name || activeAccountId || '—'} />
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, paddingTop: 12, borderTop: `1px solid ${hairline}` }}>
                            <dt style={{ fontSize: 13, fontWeight: 700 }}>Refund total</dt>
                            <dd style={{ margin: 0 }}>
                                <Money value={refundTotal} symbol={currencySymbol} size={16} />
                            </dd>
                        </div>
                    </dl>
                </div>
            </PosModal>
        );
    }

    /* ---------------------------------------------------------------- */

    return (
        <PosModal
            open
            onClose={onClose}
            title="Process Return"
            subtitle={selectedSale ? `Sale #${selectedSale.id} — ${selectedSale.customerName || 'Walk-in'}` : 'Find the sale to refund'}
            icon={<ArrowLeftRight size={19} color="#fff" style={{ transform: 'rotate(180deg)' }} />}
            size="md"
            footer={
                <>
                    {selectedSale ? (
                        <>
                            <Button
                                variant="secondary"
                                onClick={resetAll}
                                srLabel="Clear selection and search for a different sale"
                            >
                                Change sale
                            </Button>
                            <Button
                                variant="danger"
                                onClick={handleConfirmClick}
                                disabled={returnItems.length === 0}
                                srLabel={returnItems.length === 0 ? 'Select at least one item to refund' : 'Review refund'}
                            >
                                {returnItems.length === 0 ? 'Select items' : `Refund ${formatMoney(refundTotal, currencySymbol, currencyCode)}`}
                            </Button>
                        </>
                    ) : (
                        <Button variant="secondary" onClick={onClose}>Close</Button>
                    )}
                </>
            }
        >
            {!selectedSale ? (
                <div style={{ padding: '18px 24px 24px' }}>
                    <label
                        htmlFor="returns-search"
                        style={{ ...fieldLabel, display: 'block', marginBottom: 6 }}
                    >
                        Receipt, sale ID or customer
                    </label>
                    <div style={{ position: 'relative', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
                            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
                            <input
                                id="returns-search"
                                type="search"
                                placeholder="e.g. REC-1234"
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                style={{
                                    width: '100%',
                                    padding: '9px 12px 9px 32px',
                                    border: `1.4px solid ${hairline}`,
                                    borderRadius: radius.md,
                                    fontSize: 13,
                                    color: ink,
                                    background: '#FEFDFB',
                                    outline: 'none',
                                }}
                                onFocus={e => { e.currentTarget.style.boxShadow = FOCUS_RING; }}
                                onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }}
                            />
                        </div>
                    </div>

                    {hasSearched && results.length === 0 && (
                        <p role="status" style={{ margin: '16px 0 0', fontSize: 13, color: inkSoft }}>
                            No sale matches &ldquo;{searchTerm.trim()}&rdquo;.
                        </p>
                    )}

                    {results.length > 0 && (
                        <>
                            <p role="status" style={{ margin: '16px 0 8px', fontSize: 11, color: inkSoft }}>
                                {results.length} match{results.length === 1 ? '' : 'es'} — select the correct sale:
                            </p>
                            <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 320, overflowY: 'auto', border: `1px solid ${hairline}`, borderRadius: radius.md }}>
                                {results.map(({ sale }) => {
                                    const exact = String(sale.id).toLowerCase() === searchTerm.trim().toLowerCase()
                                        || String(sale.receiptNumber || '').toLowerCase() === searchTerm.trim().toLowerCase();
                                    return (
                                        <li key={sale.id} style={{ borderBottom: `1px solid ${hairline}` }}>
                                            <button
                                                type="button"
                                                onClick={() => { setSelectedSale(sale); setReturnItems([]); }}
                                                style={{
                                                    width: '100%',
                                                    textAlign: 'left',
                                                    padding: '11px 14px',
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    alignItems: 'center',
                                                    gap: 12,
                                                    border: 'none',
                                                    cursor: 'pointer',
                                                    background: exact ? teal[50] : 'transparent',
                                                    fontFamily: 'inherit',
                                                    fontSize: 13,
                                                    color: ink,
                                                    flexWrap: 'wrap',
                                                }}
                                                onFocus={e => { e.currentTarget.style.boxShadow = `inset ${FOCUS_RING}`; }}
                                                onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }}
                                            >
                                                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                                    <span style={{ fontWeight: 700 }}>
                                                        {sale.receiptNumber || sale.id}
                                                        {exact && (
                                                            <span style={{ marginLeft: 8, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06', textTransform: 'uppercase', color: teal[600] }}>
                                                                exact
                                                            </span>
                                                        )}
                                                    </span>
                                                    <span style={{ fontSize: 11.5, color: inkSoft }}>
                                                        {sale.customerName || 'Walk-in'} &middot; {new Date(sale.date).toLocaleDateString()}
                                                    </span>
                                                </span>
                                                <Money value={sale.totalAmount ?? 0} symbol={currencySymbol} size={13} />
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    )}
                </div>
            ) : (
                <>
                    <div style={{ padding: '14px 20px', background: teal[50], borderBottom: `1px solid ${hairline}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <span style={{ ...fieldLabel }}>Select items to refund</span>
                        <span style={{ fontSize: 11.5, fontFamily: NUMERIC_FONT, color: inkSoft }}>
                            {refundUnits} unit{refundUnits === 1 ? '' : 's'} selected
                        </span>
                    </div>

                    <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, padding: '14px 20px' }}>
                        {(selectedSale.items || []).map(item => {
                            const selected = returnItems.some(r => r.itemId === item.id);
                            const qty = returnItems.find(r => r.itemId === item.id)?.qty ?? 0;
                            const maxQty = Math.max(0, Number(item.quantity) || 0);
                            return (
                                <div
                                    key={item.id}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: 12,
                                        padding: '11px 13px',
                                        borderRadius: radius.md,
                                        border: `1px solid ${selected ? teal[200] : 'transparent'}`,
                                        background: selected ? teal[50] : 'transparent',
                                        marginBottom: 6,
                                        flexWrap: 'wrap',
                                    }}
                                >
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 11, cursor: 'pointer', flex: 1, minWidth: 180 }}>
                                        <input
                                            type="checkbox"
                                            checked={selected}
                                            onChange={() => toggleItem(item.id, maxQty)}
                                            style={{ width: 17, height: 17, accentColor: teal[600], cursor: 'pointer', flexShrink: 0 }}
                                        />
                                        <span style={{ minWidth: 0 }}>
                                            <span style={{ display: 'block', fontWeight: 700, fontSize: 13 }}>{item.name}</span>
                                            <span style={{ display: 'block', fontSize: 11, color: inkSoft }}>
                                                {formatMoney(Number(item.price) || 0, currencySymbol, currencyCode)} each &middot; {maxQty} sold
                                            </span>
                                        </span>
                                    </label>

                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <label className="sr-only" htmlFor={`qty-${item.id}`} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                                            Quantity to refund for {item.name}
                                        </label>
                                        <input
                                            id={`qty-${item.id}`}
                                            type="number"
                                            min={0}
                                            max={maxQty}
                                            value={selected ? qty : ''}
                                            placeholder="0"
                                            onChange={e => updateItemQty(item.id, e.target.value, maxQty)}
                                            style={{
                                                width: 68,
                                                padding: '5px 7px',
                                                border: `1.2px solid ${hairline}`,
                                                borderRadius: radius.sm,
                                                fontSize: 12,
                                                fontFamily: NUMERIC_FONT,
                                                textAlign: 'center',
                                                color: ink,
                                                background: '#FEFDFB',
                                                outline: 'none',
                                            }}
                                            onFocus={e => { e.currentTarget.style.boxShadow = FOCUS_RING; }}
                                            onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }}
                                        />
                                        <Money value={qty * (Number(item.price) || 0)} symbol={currencySymbol} size={13} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    <div style={{ padding: '14px 20px 16px', borderTop: `1px solid ${hairline}`, background: teal[50], display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        <div style={{ flex: 1, minWidth: 200 }}>
                            <label htmlFor="refund-account" style={{ ...fieldLabel, display: 'block', marginBottom: 5 }}>
                                Pay refund from
                            </label>
                            <select
                                id="refund-account"
                                value={activeAccountId}
                                onChange={e => setRefundAccountId(e.target.value)}
                                style={{
                                    width: '100%',
                                    padding: '8px 10px',
                                    border: `1.4px solid ${hairline}`,
                                    borderRadius: radius.md,
                                    fontSize: 13,
                                    fontWeight: 700,
                                    color: ink,
                                    background: '#FEFDFB',
                                    outline: 'none',
                                }}
                                onFocus={e => { e.currentTarget.style.boxShadow = FOCUS_RING; }}
                                onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }}
                            >
                                {cashBankAccounts.length === 0 ? (
                                    <option value="">No cash or bank account available</option>
                                ) : (
                                    cashBankAccounts.map(acc => (
                                        <option key={acc.id} value={acc.id}>{acc.name}</option>
                                    ))
                                )}
                            </select>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                            <div style={{ ...fieldLabel }}>Refund total</div>
                            <Money value={refundTotal} symbol={currencySymbol} size={18} color={teal[600]} />
                        </div>
                    </div>

                    {cashBankAccounts.length === 0 && (
                        <p
                            role="alert"
                            style={{
                                margin: 0,
                                padding: '10px 20px',
                                fontSize: 12,
                                background: surfaceWarning,
                                borderTop: `1px solid ${borderWarning}`,
                                color: textWarning,
                            }}
                        >
                            No live cash or bank account is available. A refund cannot be posted until one is configured.
                        </p>
                    )}
                </>
            )}
        </PosModal>
    );
};

const fieldLabel = {
    fontSize: 9.5,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.06,
    color: inkSoft,
};

const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <dt style={{ fontSize: 13, color: inkSoft }}>{label}</dt>
        <dd style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{value}</dd>
    </div>
);

export default ReturnsModal;