import React from 'react';
import { TrendingUp, RefreshCw, ShieldCheck } from 'lucide-react';
import { ZReport } from '../../../types';
import { PosModal } from './PosModal';
import { Button } from './Button';
import { hairline, teal, type } from '../theme';
import { formatMoney } from '../../../utils/posMoney';
import { normalizeCurrencyCode } from '../../../utils/helpers';

export const RegisterSummaryModal: React.FC<{
    zReportData: ZReport;
    companyName: string;
    currencySymbol: string;
    isClosing: boolean;
    onClose: () => void;
    onConfirm: () => void;
}> = ({ zReportData, companyName, currencySymbol, isClosing, onClose, onConfirm }) => {
    // CompanyConfig exposes only a symbol; normalizeCurrencyCode maps it to ISO.
    const currencyCode = normalizeCurrencyCode(currencySymbol);
    const rows: { label: string; value: number; tone?: 'accent' }[] = [
        { label: 'Gross Sales', value: zReportData.totalSales },
        { label: 'Cash in Drawer', value: zReportData.cashSales, tone: 'accent' },
        { label: 'Card Terminal', value: zReportData.cardSales },
    ];

    return (
        <PosModal
            open
            onClose={onClose}
            title="Register Summary"
            subtitle={companyName}
            icon={<TrendingUp size={19} color="#fff" />}
            size="sm"
            // Never dismissible mid-post: the ledger write must stay observable.
            dismissible={!isClosing}
            footer={
                <>
                    <Button variant="secondary" onClick={onClose} disabled={isClosing}>
                        Cancel
                    </Button>
                    <Button
                        variant="primary"
                        onClick={onConfirm}
                        disabled={isClosing}
                        icon={isClosing ? <RefreshCw size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
                        style={{ borderRadius: 999 }}
                    >
                        {isClosing ? 'Posting to Ledger…' : 'Close Register & Post'}
                    </Button>
                </>
            }
        >
            <div style={{ padding: '20px 24px', overflowY: 'auto' }}>
                <p style={{ margin: '0 0 18px', textAlign: 'center', paddingBottom: 16, borderBottom: `1px solid ${hairline}`, fontSize: 12, fontWeight: 500, color: '#5C6567' }}>
                    Daily Sales Summary
                </p>

                <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {rows.map(row => (
                        <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                            <dt style={{ ...type.body, color: '#5C6567' }}>{row.label}</dt>
                            <dd
                                style={{
                                    ...type.money,
                                    margin: 0,
                                    fontSize: 14,
                                    color: row.tone === 'accent' ? '#0F6E43' : '#1F2427',
                                }}
                            >
                                {formatMoney(row.value, currencySymbol, currencyCode)}
                            </dd>
                        </div>
                    ))}
                </dl>

                <p
                    style={{
                        margin: '22px 0 0',
                        padding: 12,
                        borderRadius: 10,
                        background: teal[50],
                        border: `1px solid ${hairline}`,
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: '#5C6567',
                    }}
                >
                    Closing the register transfers the cash balance to the Main Ledger account.
                </p>
            </div>
        </PosModal>
    );
};

export default RegisterSummaryModal;