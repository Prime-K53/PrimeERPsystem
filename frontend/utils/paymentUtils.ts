
export type PaymentStatus = 'PARTIALLY PAID' | 'PAID' | 'OVERPAID';

const toAmount = (value: unknown): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

/**
 * Canonical bill/PO total. Creation paths historically wrote either
 * `totalAmount` (new bill) or `total` (merged bill) — never both — so every
 * Paid/Partial comparison must fall back across both fields. Comparing
 * against a single missing field made `paid >= undefined` always false and
 * froze fully paid bills at "Partial".
 */
export const getPurchaseTotal = (purchase: unknown): number => {
    const p = (purchase || {}) as { totalAmount?: unknown; total?: unknown };
    const totalAmount = toAmount(p.totalAmount);
    const total = toAmount(p.total);
    if (totalAmount > 0) return totalAmount;
    if (total > 0) return total;
    return totalAmount || total;
};

/**
 * Derives the bill payment status (Unpaid / Partial / Paid) from paid amount
 * vs canonical total. Workflow states that share the field (Cancelled,
 * unpaid Approved) are preserved; anything contradicted by the amounts is
 * corrected so stale stored statuses self-heal at read time.
 */
export const derivePurchasePaymentStatus = (purchase: unknown): string => {
    const p = (purchase || {}) as { paymentStatus?: unknown; paidAmount?: unknown };
    const stored = String(p.paymentStatus || '').trim();
    if (stored === 'Cancelled') return 'Cancelled';
    const total = getPurchaseTotal(purchase);
    const paid = toAmount(p.paidAmount);
    if (total > 0) {
        if (paid >= total - 0.005) return 'Paid';
        if (paid > 0) return 'Partial';
        return stored === 'Approved' ? 'Approved' : 'Unpaid';
    }
    return stored || 'Unpaid';
};

export interface PaymentCalculation {
    paymentStatus: PaymentStatus;
    invoiceTotal: number;
    amountPaid: number;
    outstandingBalance: number;
    overpaymentAmount: number;
    walletCredit: number;
}

/**
 * Audit and refactor of payment calculation logic to ensure consistency across the application.
 * Follows the specific rules for Partial, Paid, and Overpaid status.
 */
export const calculatePaymentDetails = (invoiceTotal: number, amountPaid: number): PaymentCalculation => {
    // Round to 2 decimal places to avoid floating point issues
    const total = Math.round(invoiceTotal * 100) / 100;
    const paid = Math.round(amountPaid * 100) / 100;

    if (paid < total) {
        return {
            paymentStatus: 'PARTIALLY PAID',
            invoiceTotal: total,
            amountPaid: paid,
            outstandingBalance: Math.round((total - paid) * 100) / 100,
            overpaymentAmount: 0,
            walletCredit: 0
        };
    } else if (paid === total) {
        return {
            paymentStatus: 'PAID',
            invoiceTotal: total,
            amountPaid: paid,
            outstandingBalance: 0,
            overpaymentAmount: 0,
            walletCredit: 0
        };
    } else {
        const overpayment = Math.round((paid - total) * 100) / 100;
        return {
            paymentStatus: 'OVERPAID',
            invoiceTotal: total,
            amountPaid: paid,
            outstandingBalance: 0,
            overpaymentAmount: overpayment,
            walletCredit: overpayment
        };
    }
};

/**
 * Standard utility to generate the payment narrative required for receipts.
 */
export const getPaymentNarrative = (calc: PaymentCalculation, customerName: string, date: string, invoiceNumber: string, currency: string = '$') => {
    const formattedDate = new Date(date).toLocaleDateString();

    if (calc.paymentStatus === 'PARTIALLY PAID') {
        return `This is to acknowledge that Prime ERP has received a payment of ${currency} ${calc.amountPaid.toLocaleString()} from ${customerName} on ${formattedDate}. This payment has been applied toward Invoice ${invoiceNumber}.

Invoice Amount: ${currency} ${calc.invoiceTotal.toLocaleString()}
Amount Paid: ${currency} ${calc.amountPaid.toLocaleString()}
Outstanding Balance: ${currency} ${calc.outstandingBalance.toLocaleString()}

This receipt confirms a partial settlement of the invoice.`;
    }

    return `Receipt acknowledgment for payment of ${currency} ${calc.amountPaid.toLocaleString()} received from ${customerName} on ${formattedDate} for Invoice ${invoiceNumber}.`;
};
