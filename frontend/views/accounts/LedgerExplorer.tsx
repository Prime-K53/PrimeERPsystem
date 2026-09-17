import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, History, Search, X } from 'lucide-react';
import { useFinance } from '../../context/FinanceContext';
import { useAuth } from '../../context/AuthContext';
import { currencyService } from '../../services/currencyService';

/**
 * General ledger explorer — target of "Audit Ledger Entries" from invoices
 * and "Full Ledger" from financial-report drilldowns.
 * Previously the `/fiscal-reports/ledgers` route did not exist, so those
 * actions fell through to the dashboard. Supports `?query=` (invoice id,
 * reference, description, customer) and `?accountId=` filters.
 */
const LedgerExplorer: React.FC = () => {
    const { ledger = [], accounts = [] } = useFinance();
    const { companyConfig } = useAuth();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();

    const initialQuery = searchParams.get('query') || '';
    const accountIdParam = searchParams.get('accountId') || '';
    const [query, setQuery] = useState(initialQuery);

    useEffect(() => {
        setQuery(searchParams.get('query') || '');
    }, [searchParams]);

    const currency = companyConfig?.currencySymbol || currencyService.getCurrency(currencyService.getBaseCurrency())?.symbol || '$';

    const accountName = (id?: string) => {
        if (!id) return '—';
        const acc: any = (accounts || []).find((a: any) => a.id === id || a.code === id);
        return acc ? `${acc.code || acc.id} · ${acc.name || ''}`.trim() : String(id);
    };

    const filtered = useMemo(() => {
        const q = (query || '').trim().toLowerCase();
        let list: any[] = [...(ledger || [])];
        if (accountIdParam) {
            list = list.filter((e: any) =>
                e.debitAccountId === accountIdParam || e.creditAccountId === accountIdParam ||
                e.debitAccountId === accountIdParam || e.accountId === accountIdParam
            );
        }
        if (q) {
            list = list.filter((e: any) => {
                const hay = [
                    e.id, e.reference, e.referenceId, e.description,
                    e.customerName, e.customerId,
                    e.debitAccountId, e.creditAccountId, e.accountName,
                ].filter(Boolean).map((v: any) => String(v).toLowerCase()).join(' ');
                return hay.includes(q);
            });
        }
        return list.sort((a: any, b: any) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
    }, [ledger, query, accountIdParam]);

    const total = useMemo(() => filtered.reduce((s: number, e: any) => s + (Number(e.amount) || 0), 0), [filtered]);

    return (
        <div className="h-screen flex flex-col bg-[#F4F5F8] font-sans text-[#393A3D]">
            <div className="sticky top-0 z-30 bg-white border-b border-slate-200 shadow-sm">
                <div className="max-w-[1400px] mx-auto px-8 h-16 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <button onClick={() => navigate(-1)} className="p-2 hover:bg-slate-100 rounded-full text-slate-500" title="Back">
                            <ArrowLeft size={18} />
                        </button>
                        <History size={20} className="text-teal-700 shrink-0" />
                        <div className="min-w-0">
                            <h1 className="text-lg font-bold truncate">Audit Ledger Entries</h1>
                            <p className="text-[11px] text-slate-500 truncate">
                                {accountIdParam ? `Account: ${accountName(accountIdParam)}` : 'General ledger'} · {filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="relative">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                value={query}
                                onChange={e => {
                                    const v = e.target.value;
                                    setQuery(v);
                                    const next = new URLSearchParams(searchParams);
                                    if (v.trim()) next.set('query', v.trim());
                                    else next.delete('query');
                                    setSearchParams(next, { replace: true });
                                }}
                                placeholder="Search invoice, reference, customer…"
                                className="pl-9 pr-8 py-2 text-sm border border-slate-200 rounded-xl outline-none focus:border-teal-500 w-72"
                            />
                            {query && (
                                <button onClick={() => { setQuery(''); const next = new URLSearchParams(searchParams); next.delete('query'); setSearchParams(next, { replace: true }); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                                    <X size={14} />
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-[1400px] mx-auto px-8 py-6">
                    {accountIdParam && (
                        <div className="mb-4 inline-flex items-center gap-2 px-3 py-1.5 bg-blue-50 border border-blue-100 text-blue-700 rounded-full text-xs font-bold">
                            Filtered by account {accountName(accountIdParam)}
                            <button onClick={() => { const next = new URLSearchParams(searchParams); next.delete('accountId'); setSearchParams(next, { replace: true }); }} className="hover:text-blue-900"><X size={12} /></button>
                        </div>
                    )}
                    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                        <table className="w-full text-left text-xs border-collapse">
                            <thead className="text-slate-400 font-black uppercase tracking-widest border-b border-slate-100 sticky top-0 bg-white z-10">
                                <tr>
                                    <th className="py-3 px-4">Date</th>
                                    <th className="py-3 px-4">Reference</th>
                                    <th className="py-3 px-4">Narration</th>
                                    <th className="py-3 px-4">Debit account</th>
                                    <th className="py-3 px-4">Credit account</th>
                                    <th className="py-3 px-4 text-right">Amount</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-50">
                                {filtered.map((entry: any) => (
                                    <tr key={entry.id} className="hover:bg-slate-50">
                                        <td className="py-3 px-4 text-slate-400 whitespace-nowrap">{entry.date ? new Date(entry.date).toLocaleDateString() : '—'}</td>
                                        <td className="py-3 px-4 font-mono font-bold text-slate-600 whitespace-nowrap">{entry.referenceId || entry.reference || entry.id}</td>
                                        <td className="py-3 px-4">
                                            <div className="font-bold text-slate-700">{entry.description || '—'}</div>
                                            {entry.customerName && <div className="text-[10px] text-slate-400">{entry.customerName}</div>}
                                        </td>
                                        <td className="py-3 px-4 text-slate-600">{entry.accountName && entry.type ? (entry.type === 'Debit' ? entry.accountName : '—') : accountName(entry.debitAccountId)}</td>
                                        <td className="py-3 px-4 text-slate-600">{entry.accountName && entry.type ? (entry.type === 'Credit' ? entry.accountName : '—') : accountName(entry.creditAccountId)}</td>
                                        <td className="py-3 px-4 text-right font-mono font-bold text-slate-700 whitespace-nowrap">{currency}{Number(entry.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                    </tr>
                                ))}
                                {filtered.length === 0 && (
                                    <tr><td colSpan={6} className="py-16 text-center text-slate-400 italic">No ledger entries found{query ? ` for "${query}"` : ''}.</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                    {filtered.length > 0 && (
                        <div className="mt-4 flex justify-end text-sm font-bold text-slate-700">
                            Total:&nbsp;<span className="font-mono">{currency}{total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default LedgerExplorer;
