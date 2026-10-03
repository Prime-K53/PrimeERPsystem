import React, { useState } from 'react';
import { X, CheckCircle, FileText } from 'lucide-react';
import { Sale } from '../../../types';
import { PosModal } from './PosModal';
import { Button, Money } from './Button';
import { hairline, inkSoft, teal, type } from '../theme';
import { normalizeCurrencyCode } from '../../../utils/helpers';

export const QuickReceiptModal: React.FC<{
    sale: Sale;
    companyName: string;
    currencySymbol: string;
    onClose: () => void;
    onFullReceipt: () => Promise<void> | void;
}> = ({ sale, companyName, currencySymbol, onClose, onFullReceipt }) => {
    const currencyCode = normalizeCurrencyCode(currencySymbol);
    const [busy, setBusy] = useState(false);

    const handleFullReceipt = async () => {
        if (busy) return;
        setBusy(true);
        try {
            await onFullReceipt();
        } finally {
            setBusy(false);
        }
    };

    const rows: { label: string; value: string; accent?: boolean }[] = [
        { label: 'Customer', value: sale.customerName || 'Walk-in' },
        { label: 'Total Amount', value: `${currencySymbol}${(sale.totalAmount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
        { label: 'Paid Amount', value: `${currencySymbol}${(sale.cash_tendered || sale.totalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
        { label: 'Change Due', value: `${currencySymbol}${(sale.change_due || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, accent: true },
    ];

    return (
        <PosModal
            open
            onClose={onClose}
            title="Sale Successful"
            subtitle={`Receipt #${sale.id}`}
            icon={<CheckCircle size={19} color="#fff" />}
            size="sm"
            // The receipt build can fail; keep the dialog up so the error is seen.
            dismissible={!busy}
            footer={
                <>
                    <Button variant="primary" onClick={handleFullReceipt} disabled={busy} icon={<FileText size={15} />}>
                        {busy ? 'Preparing…' : 'Full Receipt'}
                    </Button>
                    <Button variant="secondary" onClick={onClose} disabled={busy}>
                        Done
                    </Button>
                </>
            }
        >
            <div style={{ padding: '18px 24px 8px', overflowY: 'auto' }}>
                <p style={{ margin: '0 0 16px', textAlign: 'center', fontSize: 17, fontWeight: 700, color: '#1F2427', letterSpacing: 0.2 }}>
                    {companyName}
                </p>

                <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {rows.map(row => (
                        <div
                            key={row.label}
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 12,
                                padding: '9px 11px',
                                background: '#FEFDFB',
                                borderRadius: 8,
                                border: `1px solid ${hairline}`,
                            }}
                        >
                            <dt style={{ ...type.body, fontSize: 12, color: inkSoft }}>{row.label}</dt>
                            <dd
                                style={{
                                    ...type.money,
                                    margin: 0,
                                    fontSize: 13.5,
                                    color: row.accent ? teal[600] : '#1F2427',
                                }}
                            >
                                {row.value}
                            </dd>
                        </div>
                    ))}
                </dl>
            </div>
        </PosModal>
    );
};

export default QuickReceiptModal;