import React, { useEffect, useMemo } from 'react';
import { useVatStore } from '../../stores/vatStore';
import { useAuth } from '../../context/AuthContext';
import { currencyService } from '../../services/currencyService';
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend} from 'recharts';
import { ResponsiveContainer } from '@/components/charts/ResponsiveContainer';

import {
    TrendingUp, TrendingDown, DollarSign, Activity,
    ArrowUpRight, ArrowDownRight, FileText
} from 'lucide-react';
import { format, parseISO, startOfMonth, endOfMonth, eachMonthOfInterval, subMonths } from 'date-fns';

/* Shared Add-Customer chrome — single source of truth for all Finance Hub tabs */
import {
    teal, amber, paper, ink, inkSoft, hairline, danger,
    KpiCards, EmptyState, tableCard, tableHeadRow,
} from '../accounts/components/financeChrome';

export const VatDashboard: React.FC = () => {
    const { transactions, returns, fetchVatData, isLoading } = useVatStore();
    const { companyConfig } = useAuth();
    const currency = currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

    useEffect(() => { fetchVatData(); }, []);

    const stats = useMemo(() => {
        const currentMonth = new Date();
        const start = startOfMonth(currentMonth).toISOString();
        const end = endOfMonth(currentMonth).toISOString();
        const currentTx = transactions.filter(t => t.date >= start && t.date <= end);
        const inputTax = currentTx.filter(t => t.type === 'Input').reduce((sum, t) => sum + t.amount, 0);
        const outputTax = currentTx.filter(t => t.type === 'Output').reduce((sum, t) => sum + t.amount, 0);
        return { inputTax, outputTax, net: outputTax - inputTax, count: currentTx.length };
    }, [transactions]);

    const chartData = useMemo(() => {
        const end = new Date();
        const start = subMonths(end, 6);
        return eachMonthOfInterval({ start, end }).map(date => {
            const monthStart = startOfMonth(date).toISOString();
            const monthEnd = endOfMonth(date).toISOString();
            const monthTx = transactions.filter(t => t.date >= monthStart && t.date <= monthEnd);
            const input = monthTx.filter(t => t.type === 'Input').reduce((sum, t) => sum + t.amount, 0);
            const output = monthTx.filter(t => t.type === 'Output').reduce((sum, t) => sum + t.amount, 0);
            return { name: format(date, 'MMM'), Input: input, Output: output, Net: output - input };
        });
    }, [transactions]);

    const fmtMoney = (n: number) => `${currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <KpiCards items={[
                { label: 'Output tax (sales)', value: fmtMoney(stats.outputTax), icon: ArrowUpRight, color: teal[700], bg: teal[50] },
                { label: 'Input tax (purchases)', value: fmtMoney(stats.inputTax), icon: ArrowDownRight, color: danger, bg: '#fdeeee' },
                { label: stats.net >= 0 ? 'Net payable · To pay' : 'Net payable · Refundable', value: fmtMoney(Math.abs(stats.net)), icon: DollarSign, color: amber[600], bg: amber[100] },
            ]} />

            <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 18 }}>
                <div style={{ ...tableCard, padding: 24 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 700, color: ink, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Activity size={20} style={{ color: inkSoft }} /> VAT liability trend (6 months)
                    </h3>
                    <div style={{ width: '100%', height: 320 }}>
                        <ResponsiveContainer width="100%" height="100%" minHeight={300} minWidth={0}>
                            <BarChart data={chartData}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={hairline} />
                                <XAxis dataKey="name" tick={{ fontSize: 12, fill: inkSoft }} />
                                <YAxis tick={{ fontSize: 12, fill: inkSoft }} />
                                <Tooltip formatter={(value: number) => [`${currency} ${value.toLocaleString()}`, '']} />
                                <Legend />
                                <Bar dataKey="Output" fill={teal[500]} name="Output tax" />
                                <Bar dataKey="Input" fill={danger} name="Input tax" />
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </div>

                <div style={{ ...tableCard, padding: 24 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 700, color: ink, margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <FileText size={20} style={{ color: inkSoft }} /> Recent returns
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        {returns.length === 0 ? (
                            <EmptyState icon={<FileText size={32} />} title="No returns generated yet" hint="Generate a VAT return from Returns & reports." />
                        ) : returns.slice(0, 5).map(ret => (
                            <div key={ret.id} style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                padding: 12, border: `1px solid ${hairline}`, borderRadius: 10,
                                transition: 'background .12s'
                            }}
                                onMouseEnter={e => { e.currentTarget.style.background = teal[50]; }}
                                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                            >
                                <div>
                                    <p style={{ fontWeight: 600, color: ink, margin: 0 }}>{format(parseISO(ret.periodStart), 'MMM yyyy')}</p>
                                    <p style={{ fontSize: 12, color: inkSoft, margin: 0 }}>{ret.status} - {format(parseISO(ret.periodEnd), 'dd MMM')}</p>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                    <p style={{ fontWeight: 700, fontSize: 13, color: ink, margin: 0, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                                        {currency} {ret.netPayable.toLocaleString()}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
