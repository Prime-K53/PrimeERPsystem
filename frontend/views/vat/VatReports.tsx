import React, { useState } from 'react';
import { logger } from '@/services/logger';
import { useVatStore } from '../../stores/vatStore';
import { useAuth } from '../../context/AuthContext';
import { format, parseISO, startOfMonth, endOfMonth } from 'date-fns';
import { currencyService } from '../../services/currencyService';
import { FileText, Download, CheckCircle, AlertCircle, Plus, Calendar } from 'lucide-react';
import { VatReturn } from '../../types';
import { ConfirmDialog, ConfirmDialogType } from '../../components/ConfirmDialog';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline,
    labelStyle, selectStyle,
    btnGhostStyle, btnPrimaryStyle,
    tableCard, tableHeadRow, EmptyState,
} from '../accounts/components/financeChrome';

export const VatReports: React.FC = () => {
    const { returns, generateReturn, fileReturn, isLoading } = useVatStore();
    const { companyConfig } = useAuth();
    const currency = currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';
    const [isGenerating, setIsGenerating] = useState(false);
    const [selectedReturn, setSelectedReturn] = useState<VatReturn | null>(null);
    const [period, setPeriod] = useState({ month: new Date().getMonth(), year: new Date().getFullYear() });
    const [confirmState, setConfirmState] = useState<{ open: boolean; title: string; message: string; confirmText?: string; type?: ConfirmDialogType; onConfirm?: () => void }>({ open: false, title: '', message: '' });

    const handleGenerate = async () => {
        setIsGenerating(true);
        try {
            const date = new Date(period.year, period.month, 1);
            await generateReturn(startOfMonth(date).toISOString(), endOfMonth(date).toISOString());
        } catch (error) {
            logger.error("Failed to generate return", error);
        } finally { setIsGenerating(false); }
    };

    const handleFileReturn = async (returnId: string) => {
        setConfirmState({ open: true, title: 'File VAT Return', message: 'Are you sure you want to file this return? This action cannot be undone.', type: 'warning', confirmText: 'File Return', onConfirm: async () => { await fileReturn(returnId); } });
    };

    const handleMarkPaid = async (returnId: string) => {
        const date = prompt('Enter payment date (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
        if (date) { await fileReturn(returnId, date); }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400, fontSize: 22, color: teal[800], margin: 0, letterSpacing: 0.2 }}>VAT returns</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: paper, padding: 8, borderRadius: 12, border: `1.4px solid ${hairline}` }}>
                    <select style={{ ...selectStyle, width: 'auto', border: 'none', padding: '4px 26px 4px 8px' }} value={period.month} onChange={(e) => setPeriod(p => ({ ...p, month: parseInt(e.target.value) }))}>
                        {Array.from({ length: 12 }).map((_, i) => (<option key={i} value={i}>{format(new Date(2024, i, 1), 'MMMM')}</option>))}
                    </select>
                    <select style={{ ...selectStyle, width: 'auto', border: 'none', padding: '4px 26px 4px 8px' }} value={period.year} onChange={(e) => setPeriod(p => ({ ...p, year: parseInt(e.target.value) }))}>
                        {[0, 1, 2].map(i => (<option key={i} value={new Date().getFullYear() - i}>{new Date().getFullYear() - i}</option>))}
                    </select>
                    <button onClick={handleGenerate} disabled={isGenerating}
                        style={{ ...btnPrimaryStyle, opacity: isGenerating ? 0.6 : 1 }}
                        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
                    ><Plus size={16} /> Generate return</button>
                </div>
            </div>

            <div style={tableCard}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={tableHeadRow}>
                            <th style={{ padding: '12px 20px', textAlign: 'left', fontWeight: 700 }}>Period</th>
                            <th style={{ padding: '12px 20px', textAlign: 'right', fontWeight: 700 }}>Total output</th>
                            <th style={{ padding: '12px 20px', textAlign: 'right', fontWeight: 700 }}>Total input</th>
                            <th style={{ padding: '12px 20px', textAlign: 'right', fontWeight: 700 }}>Net payable</th>
                            <th style={{ padding: '12px 20px', textAlign: 'center', fontWeight: 700 }}>Status</th>
                            <th style={{ padding: '12px 20px', textAlign: 'center', fontWeight: 700 }}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {returns.length === 0 ? (
                            <tr><td colSpan={6} style={{ padding: 24 }}>
                                <EmptyState icon={<FileText size={32} />} title="No VAT returns found" hint="Generate one to get started." />
                            </td></tr>
                        ) : returns.map(ret => (
                            <tr key={ret.id} style={{ borderTop: `1px solid ${hairline}`, transition: 'background .12s' }}
                                onMouseEnter={e => { e.currentTarget.style.background = teal[50]; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            >
                                <td style={{ padding: '14px 20px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <Calendar size={16} style={{ color: inkSoft }} />
                                        <span style={{ fontWeight: 600, color: ink }}>{format(parseISO(ret.periodStart), 'MMM yyyy')}</span>
                                    </div>
                                    <div style={{ fontSize: 12, color: inkSoft, marginLeft: 24, marginTop: 2 }}>
                                        {format(parseISO(ret.periodStart), 'dd MMM')} - {format(parseISO(ret.periodEnd), 'dd MMM')}
                                    </div>
                                </td>
                                <td style={{ padding: '14px 20px', textAlign: 'right', color: ink, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{currency} {ret.totalOutputTax.toLocaleString()}</td>
                                <td style={{ padding: '14px 20px', textAlign: 'right', color: ink, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{currency} {ret.totalInputTax.toLocaleString()}</td>
                                <td style={{ padding: '14px 20px', textAlign: 'right', fontWeight: 700, color: ret.netPayable >= 0 ? ink : teal[700], fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                                    {currency} {Math.abs(ret.netPayable).toLocaleString()}{ret.netPayable < 0 && ' (CR)'}
                                </td>
                                <td style={{ padding: '14px 20px', textAlign: 'center' }}>
                                    <span style={{
                                        display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
                                        background: ret.status === 'Paid' ? teal[100] : ret.status === 'Filed' ? '#dbeafe' : amber[100],
                                        color: ret.status === 'Paid' ? teal[800] : ret.status === 'Filed' ? '#1e40af' : '#92400e'
                                    }}>{ret.status}</span>
                                </td>
                                <td style={{ padding: '14px 20px', textAlign: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                                        {ret.status === 'Draft' && <button onClick={() => handleFileReturn(ret.id)} style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: teal[600], fontWeight: 600, fontSize: 13 }} onMouseEnter={e => e.currentTarget.style.background = teal[50]} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>File</button>}
                                        {ret.status === 'Filed' && <button onClick={() => handleMarkPaid(ret.id)} style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: teal[600], fontWeight: 600, fontSize: 13 }} onMouseEnter={e => e.currentTarget.style.background = teal[50]} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>Mark paid</button>}
                                        <button style={{ padding: 7, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', color: inkSoft }} onMouseEnter={e => e.currentTarget.style.background = teal[50]} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}><Download size={16} /></button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <ConfirmDialog
                open={confirmState.open}
                onOpenChange={(open) => !open && setConfirmState(c => ({ ...c, open: false }))}
                onConfirm={() => { confirmState.onConfirm?.(); setConfirmState(c => ({ ...c, open: false })); }}
                onCancel={() => setConfirmState(c => ({ ...c, open: false }))}
                title={confirmState.title}
                message={confirmState.message}
                confirmText={confirmState.confirmText}
                type={confirmState.type || 'warning'}
            />
        </div>
    );
};
