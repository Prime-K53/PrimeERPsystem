import React, { useMemo, useState } from 'react';
import { User, Plus, Minus, ShoppingBag, UserPlus, ChevronRight, X, ReceiptText, Trash2, Tag, Banknote } from 'lucide-react';
import { CartItem, Sale } from '../../../types';
import { useAuth } from '../../../context/AuthContext';
import { useFinance } from '../../../context/FinanceContext';
import { PrintJobCartCard } from '../../../components/printing/PrintJobCartCard';

import { formatNumber, generateNextId } from '../../../utils/helpers';
import { displayPrice } from '../../../services/pricingDisplayService';
import { calculateSaleProfit } from '../../../utils/saleProfit';
import { resolveItemAdjustmentSnapshots, getMarketAdjustmentSnapshots } from '../../../utils/pricingBreakdown';
import {
  getQuickPhotocopyLineDisplay,
  getQuickPhotocopyTotals,
  isQuickPhotocopyItem,
} from '../../../services/quickPhotocopyService';
import { Button } from './Button';
import {
  ACCENT,
  ACCENT_BORDER,
  ACCENT_SOFT,
  NUMERIC_FONT,
  UI_FONT,
  TAP_MIN,
  blurVisible,
  borderWarning,
  controlBase,
  danger,
  focusVisible,
  hairline,
  hairlineStrong,
  ink,
  inkSoft,
  paper,
  radius,
  registerType,
  surface,
  surfaceWarning,
  textWarning,
  type as posType,
} from '../theme';

interface CartSidebarProps {
    cart: CartItem[];
    sales: Sale[];
    selectedCustomerName: string | null;
    selectedSubAccount: string;
    setSelectedSubAccount: (val: string) => void;
    onSelectCustomer: () => void;
    updateQuantity: (id: string, delta: number, isAbsolute?: boolean) => void;
    updatePrice: (id: string, newPrice: number) => void;
    resetPriceOverride: (id: string) => void | Promise<void>;
    removeFromCart: (id: string) => void;
    clearCart: () => void;
    onPark: () => void;
    onReturn: () => void;
    onPay: () => void;
    isBusy?: boolean;
    totals: { subtotal: number, total: number };
    adjustmentSummary?: { adjustmentId: string; adjustmentName: string; totalAmount: number; itemCount: number; }[];
    pricingSummary?: {
        profitMarginTotal: number;
        roundingTotal: number;
    };
    rounding?: {
        enabled: boolean;
        applyRounding: boolean;
        calculatedPrice: number;
        roundedPrice: number;
        difference: number;
        method: string;
        methodLabel?: string;
        methodOptions?: { value: string; label: string }[];
        showOriginalPrice?: boolean;
        manualOverrideAllowed?: boolean;
        onToggle?: (value: boolean) => void;
        onMethodChange?: (value: string) => void;
    };
    manualDiscountPercent?: number;
    onManualDiscountChange?: (value: number) => void;
}

/** Percentages read as typed: `5`, never `5.00`. */
const pctLabel = (value: number) => String(Number(Number(value).toFixed(2)));

/** One label/value row of the totals block. */
const SummaryRow: React.FC<{ label: string; value: string; valueColor?: string }> = ({ label, value, valueColor }) => (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '3px 0' }}>
        <span style={{ fontSize: 12.5, color: inkSoft, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span style={{ fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums', fontSize: 13, fontWeight: 600, color: valueColor || ink, whiteSpace: 'nowrap' }}>
            {value}
        </span>
    </div>
);

/**
 * Quantity stepper. The tap area is the full TAP_MIN square while the painted
 * chip stays small, so a dense cart still clears the minimum touch target.
 */
const StepperButton: React.FC<{ label: string; onClick: () => void; children: React.ReactNode }> = ({ label, onClick, children }) => (
    <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        onFocus={focusVisible}
        onBlur={blurVisible}
        style={{ width: TAP_MIN, height: TAP_MIN, display: 'grid', placeItems: 'center', padding: 0, border: 'none', background: 'transparent', borderRadius: radius.md, cursor: 'pointer' }}
    >
        <span
            aria-hidden="true"
            style={{ width: 30, height: 30, borderRadius: radius.sm, background: ACCENT_SOFT, border: `1px solid ${ACCENT_BORDER}`, color: ACCENT, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}
        >
            {children}
        </span>
    </button>
);

export const CartSidebar: React.FC<CartSidebarProps> = ({
    cart, sales, selectedCustomerName, onSelectCustomer, updateQuantity, updatePrice, removeFromCart, clearCart, onPay, isBusy = false, totals, adjustmentSummary, manualDiscountPercent = 0, onManualDiscountChange
}) => {
    const { companyConfig } = useAuth();
    const { invoices } = useFinance();
    const currency = companyConfig.currencySymbol;

    const [showDiscountInput, setShowDiscountInput] = useState(false);
    const nextOrderNumber = useMemo(() => generateNextId('POS', sales, companyConfig), [sales, companyConfig]);

    /**
     * Money in this column always goes through formatNumber, which pins en-US
     * grouping. A browser locale must never be able to render the cart lines
     * and the totals with different separators — they read as one ledger.
     */
    const money = (value: number) => `${currency}${formatNumber(value)}`;

    // `subtotal` is the sum of the line amounts already on screen, i.e. the
    // amount BEFORE the manual discount. It is the only honest "Subtotal" —
    // the previous figure printed cost under this label.
    const subtotal = Number(totals.subtotal) || 0;
    const discountPercent = Number(manualDiscountPercent) || 0;
    const discountAmount = subtotal * (discountPercent / 100);
    const totalDue = subtotal - discountAmount;

    const totalQuantity = useMemo(() => cart.reduce((s, i) => s + i.quantity, 0), [cart]);

    const adjustmentTotal = useMemo(() => {
        if (!adjustmentSummary || adjustmentSummary.length === 0) return 0;
        return adjustmentSummary.reduce((sum, adj) => sum + (Number(adj.totalAmount) || 0), 0);
    }, [adjustmentSummary]);

    // Profit and margin are internal figures. They are a footnote under the
    // total, never an addend in it — presented as a line item they read as a
    // charge the customer is being asked for.
    const totalProfit = useMemo(
        () => calculateSaleProfit(cart, discountAmount),
        [cart, discountAmount]
    );
    const profitMarginPct = totalDue > 0 ? (totalProfit / totalDue) * 100 : 0;

    const customerOutstanding = useMemo(() => {
        if (!selectedCustomerName) return 0;
        return (invoices || [])
            .filter((i: any) => i.customerName === selectedCustomerName && i.status !== 'Paid' && i.status !== 'Draft' && i.status !== 'Cancelled')
            .reduce((acc: number, inv: any) => acc + ((inv.totalAmount || 0) - (inv.paidAmount || 0)), 0);
    }, [selectedCustomerName, invoices]);

    const applyDiscount = (raw: string) => {
        const n = Number(raw);
        onManualDiscountChange?.(Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: paper, color: ink, fontFamily: UI_FONT, fontSize: 13 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${hairline}`, background: surface, flexShrink: 0 }}>
                <span style={{ width: 34, height: 34, borderRadius: radius.md, background: ACCENT_SOFT, border: `1px solid ${ACCENT_BORDER}`, color: ACCENT, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                    <ReceiptText size={16} />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ ...posType.title, fontSize: 17, color: ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Current Order</div>
                    <div style={{ fontSize: 11.5, color: inkSoft, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {cart.length} item{cart.length !== 1 ? 's' : ''} &middot; {totalQuantity} unit{totalQuantity !== 1 ? 's' : ''}
                    </div>
                </div>
                <Button
                    variant="quiet"
                    size="sm"
                    icon={<Trash2 size={13} />}
                    onClick={clearCart}
                    disabled={cart.length === 0}
                    style={{ color: danger, flexShrink: 0 }}
                >
                    Clear
                </Button>
            </div>

            <button
                type="button"
                onClick={onSelectCustomer}
                onFocus={focusVisible}
                onBlur={blurVisible}
                aria-label={selectedCustomerName ? `Customer: ${selectedCustomerName}. Change customer` : 'Add customer'}
                style={{
                    margin: '10px 16px 0',
                    minHeight: TAP_MIN,
                    padding: '8px 10px',
                    border: `1.4px dashed ${ACCENT_BORDER}`,
                    borderRadius: radius.lg,
                    background: ACCENT_SOFT,
                    color: ACCENT,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: UI_FONT,
                    flexShrink: 0,
                }}
            >
                <span style={{ width: 28, height: 28, borderRadius: '50%', background: surface, border: `1px solid ${ACCENT_BORDER}`, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                    {selectedCustomerName ? <User size={13} /> : <UserPlus size={13} />}
                </span>
                <span style={{ minWidth: 0, flex: 1, fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {selectedCustomerName || 'Add customer'}
                </span>
                {selectedCustomerName && customerOutstanding > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 600, color: textWarning, background: surfaceWarning, border: `1px solid ${borderWarning}`, borderRadius: radius.pill, padding: '2px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        Owes {money(customerOutstanding)}
                    </span>
                )}
                <ChevronRight size={14} style={{ flexShrink: 0 }} />
            </button>

            <div className="flex-1 overflow-y-auto custom-scrollbar" style={{ padding: '4px 0 12px' }}>
                {cart.length === 0 ? (
                    <div style={{ padding: '44px 22px', textAlign: 'center', color: inkSoft }}>
                        <ShoppingBag size={36} style={{ opacity: 0.3, margin: '0 auto 12px', display: 'block' }} />
                        <div style={{ fontSize: 13 }}>No items yet</div>
                        <div style={{ fontSize: 12, marginTop: 4 }}>Tap a product or scan a barcode to start this order.</div>
                    </div>
                ) : (
                    <div>
                        {cart.map(item => {
                            if (item.isPrintingJob && item.printingSpec) {
                                return (
                                    <div key={item.id} style={{ padding: '12px 16px', borderBottom: `1px solid ${hairline}`, background: surface }}>
                                        <PrintJobCartCard
                                            spec={item.printingSpec}
                                            currency={currency}
                                            productionRef={item.productionRef || `PJ-${item.id.slice(-5)}`}
                                            onRemove={() => removeFromCart(item.id)}
                                        />
                                    </div>
                                );
                            }
                            return (
                                <CartItemRow
                                    key={item.id}
                                    item={item}
                                    updateQuantity={updateQuantity}
                                    updatePrice={updatePrice}
                                    removeFromCart={removeFromCart}
                                />
                            );
                        })}
                    </div>
                )}
            </div>

            <div style={{ borderTop: `1px solid ${hairline}`, background: surface, boxShadow: '0 -8px 24px -18px rgba(10,46,40,.35)', flexShrink: 0 }}>
                <div style={{ padding: '12px 16px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, ...posType.sectionLabel, color: inkSoft, marginBottom: 8 }}>
                        <span>Order {nextOrderNumber}</span>
                        <span style={{ fontFamily: NUMERIC_FONT, fontSize: 11, letterSpacing: 0, textTransform: 'none' }}>
                            {totalQuantity} unit{totalQuantity !== 1 ? 's' : ''}
                        </span>
                    </div>

                    <SummaryRow label="Subtotal" value={money(subtotal)} />
                    {discountPercent > 0 && (
                        <SummaryRow
                            label={`Discount ${pctLabel(discountPercent)}%`}
                            value={`−${money(discountAmount)}`}
                            valueColor={danger}
                        />
                    )}

                    <div style={{ height: 1, background: hairlineStrong, margin: '8px 0 6px' }} />

                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ fontSize: 15, fontWeight: 600, color: ink }}>Total</span>
                        <span style={{ ...registerType.total, fontFamily: NUMERIC_FONT, color: ink }}>
                            {money(displayPrice(totalDue, undefined, 'pos'))}
                        </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingTop: 7, fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums', fontSize: 11, color: inkSoft }}>
                        <span>Profit {totalProfit >= 0 ? '+' : '−'}{money(Math.abs(totalProfit))}</span>
                        <span aria-hidden="true">&middot;</span>
                        <span>{profitMarginPct.toFixed(1)}% margin</span>
                    </div>

                    {adjustmentTotal !== 0 && (
                        <div style={{ textAlign: 'right', fontSize: 11, color: inkSoft, paddingTop: 2 }}>
                            Includes adjustments {money(adjustmentTotal)}
                        </div>
                    )}
                </div>

                {showDiscountInput && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px 0' }}>
                        <label htmlFor="pos-order-discount" style={{ ...posType.fieldLabel, color: inkSoft, flexShrink: 0 }}>Discount %</label>
                        <input
                            id="pos-order-discount"
                            type="number"
                            min={0}
                            max={100}
                            value={discountPercent}
                            onChange={e => applyDiscount(e.target.value)}
                            onFocus={focusVisible}
                            onBlur={blurVisible}
                            style={{ ...controlBase, fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums', fontWeight: 600, textAlign: 'right', padding: '6px 8px', width: 68, color: danger }}
                        />
                        <Button variant="quiet" size="sm" onClick={() => { applyDiscount('0'); setShowDiscountInput(false); }} style={{ color: inkSoft }}>
                            Remove
                        </Button>
                    </div>
                )}

                <div style={{ display: 'flex', gap: 10, padding: '12px 16px 16px' }}>
                    <Button
                        variant="secondary"
                        size="lg"
                        icon={<Tag size={14} />}
                        onClick={() => setShowDiscountInput(v => !v)}
                        aria-expanded={showDiscountInput}
                        aria-controls="pos-order-discount"
                        style={{ flex: '0 0 auto', minWidth: 104 }}
                    >
                        {discountPercent > 0 ? `${pctLabel(discountPercent)}% off` : 'Discount'}
                    </Button>
                    <Button
                        variant="primary"
                        size="lg"
                        block
                        onClick={onPay}
                        disabled={cart.length === 0 || isBusy}
                        icon={isBusy ? undefined : <Banknote size={16} />}
                        style={{ flex: 1, minHeight: 48, fontSize: 15 }}
                    >
                        {isBusy ? 'Calculating…' : 'Proceed'}
                    </Button>
                </div>
            </div>
        </div>
    );
};

export const CartItemRow: React.FC<{ item: CartItem, updateQuantity: (id: string, delta: number, isAbsolute?: boolean) => void, updatePrice: (id: string, newPrice: number) => void, removeFromCart: (id: string) => void }> = ({ item, updateQuantity, removeFromCart }) => {
    const { companyConfig } = useAuth();
    const currency = companyConfig.currencySymbol;
    const serviceDetails = item.serviceDetails;

    const adjSnapshots = useMemo(() => getMarketAdjustmentSnapshots(resolveItemAdjustmentSnapshots(item)), [item]);
    const adjAmount = useMemo(() => adjSnapshots.reduce((s: number, a: any) => s + (a.calculatedAmount || 0), 0), [adjSnapshots]);
    const hasAdj = adjAmount !== 0;

    const isPrintType = serviceDetails && (item.pages || serviceDetails.pages);
    const isQuickPhotocopy = isQuickPhotocopyItem(item);
    // Quick Photocopy: billing is sheets × pricePerSheet; display is pages.
    // item.price is ALWAYS per-sheet (never divided). item.quantity is sheets.
    const qpTotals = isQuickPhotocopy ? getQuickPhotocopyTotals(item) : null;
    const totalPages = isQuickPhotocopy && qpTotals
      ? qpTotals.totalPages
      : (isPrintType ? (serviceDetails.pages || item.pages || 1) * (serviceDetails.copies || item.quantity || 1) : 0);
    const isPhotocopy = isQuickPhotocopy || item.unit === 'sheet';
    const sheetCount = isQuickPhotocopy && qpTotals
      ? qpTotals.billableSheets
      : (isPhotocopy ? Math.ceil((serviceDetails.pages || item.pages || 1) / 2) * (serviceDetails.copies || item.quantity || 1) : 0);
    // QP per-unit is the stored per-sheet price (never item.price / sheets).
    // Other print services keep their existing per-page derivation untouched.
    const perUnit = isQuickPhotocopy && qpTotals
      ? qpTotals.unitPrice
      : (isPrintType ? (isPhotocopy ? item.price / sheetCount : item.price / totalPages) : 0);
    // Shared compact display: name stays plain, qty shows entered pages
    // ("13 pgs"), rate appears exactly once ("K 150.00/sht").
    const qpDisplay = isQuickPhotocopy ? getQuickPhotocopyLineDisplay(item, currency) : null;

    const lineName = qpDisplay ? qpDisplay.name : (isPrintType ? `${totalPages} pages ${item.name}` : item.name);
    const rateText = qpDisplay
        ? `${qpDisplay.qty} @ ${qpDisplay.rate}`
        : (isPrintType
            ? `@${currency}${formatNumber(perUnit)}/${isPhotocopy ? 'sheet' : 'page'}`
            : `@${currency}${formatNumber(displayPrice(item.price, undefined, 'pos'))}`);

    // Keeps the rate of a plain item aligned with the Quick Photocopy form and
    // holds the columns steady as qty digits grow.
    const quantityWellWidth = TAP_MIN * 2 + 26 + 4;

    return (
        <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', borderBottom: `1px solid ${hairline}`, background: surface, transition: 'background .12s' }}
            onMouseOver={e => { e.currentTarget.style.background = ACCENT_SOFT; }}
            onMouseOut={e => { e.currentTarget.style.background = surface; }}
        >
            {isPrintType ? (
                <span style={{ width: quantityWellWidth, flexShrink: 0 }} />
            ) : (
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2, width: quantityWellWidth, flexShrink: 0 }}>
                    <StepperButton label="Decrease quantity" onClick={() => updateQuantity(item.id, -1)}><Minus size={12} /></StepperButton>
                    <span style={{ minWidth: 26, textAlign: 'center', fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums', fontSize: 14, fontWeight: 700, color: ink }}>
                        {item.quantity}
                    </span>
                    <StepperButton label="Increase quantity" onClick={() => updateQuantity(item.id, 1)}><Plus size={12} /></StepperButton>
                </span>
            )}

            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <span className="truncate" title={lineName} style={{ ...registerType.body, fontWeight: 600, color: ink }}>
                        {lineName}
                    </span>
                    {item.manual_override && <span style={{ fontSize: 9, fontWeight: 700, color: '#2f5fa8', background: '#eaf1fb', padding: '1px 5px', borderRadius: radius.sm, flexShrink: 0 }}>OVR</span>}
                    {hasAdj && <span style={{ fontSize: 9, fontWeight: 700, color: textWarning, background: surfaceWarning, border: `1px solid ${borderWarning}`, padding: '1px 5px', borderRadius: radius.sm, flexShrink: 0 }}>ADJ</span>}
                </div>
                <div style={{ ...registerType.meta, fontFamily: NUMERIC_FONT, color: inkSoft, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {rateText}
                </div>
            </div>

            <span style={{ ...registerType.price, fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums', color: ink, flexShrink: 0 }}>
                {currency}{formatNumber(displayPrice(item.price * item.quantity, undefined, 'pos'))}
            </span>

            <button
                type="button"
                onClick={() => removeFromCart(item.id)}
                title="Remove item"
                aria-label={`Remove ${lineName} from order`}
                onFocus={focusVisible}
                onBlur={blurVisible}
                style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', padding: 0, border: 'none', background: 'transparent', color: inkSoft, borderRadius: radius.sm, cursor: 'pointer', flexShrink: 0 }}
            >
                <X size={14} />
            </button>
        </div>
    );
};