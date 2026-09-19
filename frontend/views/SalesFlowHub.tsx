import React, { useState, useEffect } from 'react';
import { FileText, FileCheck, Banknote as PaymentIcon, RefreshCw, Printer, Target, CheckSquare, ArrowLeftRight } from 'lucide-react';
import GenericHub, { HubTheme } from './GenericHub';
import { useSalesOrderStore } from '../stores/salesOrderStore';
import { useSalesStore } from '../stores/salesStore';
import { useFinanceStore } from '../stores/financeStore';import { dbService } from '../services/db';

const salesTheme: HubTheme = {
  primary: '#1f8577',
  primaryDark: '#0f544c',
  primaryLight: '#3fa294',
  background: '#FEFDFB',
  surface: '#FEFDFB',
  border: '#e4ddd1',
  text: '#23282A',
  textMuted: '#5c6567',
  badgeBg: '#dc2626',
};

const SalesFlowHub: React.FC = () => {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const salesOrderStore = useSalesOrderStore();
  const salesStore = useSalesStore();
  const financeStore = useFinanceStore();

  useEffect(() => {
    let cancelled = false;
    const fetchCounts = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const [
          quotations,
          salesOrders,
          invoices,
          jobOrders,
          salesExchanges,
        ] = await Promise.all([
          dbService.getAll('quotations').catch(() => []),
          Promise.resolve(salesOrderStore.salesOrders || []),
          Promise.resolve(financeStore.invoices || []),
          Promise.resolve(salesStore.jobOrders || []),
          Promise.resolve(salesStore.salesExchanges || []),
        ]);

        if (cancelled) return;
        // Bulletproof filters: explicit allow-list, not naive !== checks
        const pendingQuotations = (quotations as any[]).filter((q: any) => {
          const s = String(q.status || '').toLowerCase();
          return s === 'sent' || s === 'draft' || s === 'pending';
        }).length;
        const pendingOrders = (salesOrders as any[]).filter((o: any) => {
          const s = String(o.status || '').toLowerCase();
          return s === 'pending' || s === 'processing' || s === 'confirmed' || s === 'hold';
        }).length;
        // Invoices: only count actionable unpaid, not Draft
        const unpaidInvoices = (invoices as any[]).filter((i: any) => {
          const s = String(i.status || '').toLowerCase();
          return ['unpaid','overdue','partially_paid','partial','sent','pending'].includes(s);
        }).length;
        const activeContracts = (financeStore.assessmentContracts as any[]).filter((c: any) => {
          const s = String(c.status || '').toLowerCase();
          return s === 'active' || s === 'pending_payment' || s === 'draft' || s === 'pending';
        }).length;
        const pendingExchanges = (salesExchanges as any[]).filter((e: any) => {
          const s = String(e.status || '').toLowerCase();
          return !['completed','rejected','cancelled'].includes(s);
        }).length;
        const pendingJobTickets = (jobOrders as any[]).filter((j: any) => {
          const s = String(j.status || '').toLowerCase();
          return !['completed','cancelled','delivered'].includes(s);
        }).length;

        setCounts({
          Quotations: pendingQuotations,
          Orders: pendingOrders,
          'Billing / Invoices': unpaidInvoices,
          'Printing Contracts': activeContracts,
          'Sales Exchanges': pendingExchanges,
          'Job Tickets': pendingJobTickets,
        });
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load counts');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchCounts();
    return () => { cancelled = true; };
  }, [salesOrderStore.salesOrders, salesStore.jobOrders, salesStore.salesExchanges, financeStore.invoices, financeStore.assessmentContracts]);

  const badge = (label: string) => isLoading ? undefined : counts[label] || 0;

  const options = [
    {
      label: 'Quotations',
      description: 'Generate estimates and track approval — overdue highlighted.',
      path: '/sales-flow/quotations',
      icon: FileText,
      badge: badge('Quotations'),
    },
    {
      label: 'Orders',
      description: 'Manage orders, fulfillment and bulk ops — pending + hold.',
      path: '/sales-flow/orders',
      icon: CheckSquare,
      badge: badge('Orders'),
    },
    {
      label: 'Billing / Invoices',
      description: 'Official invoicing, credit notes, payment status — actionable unpaid only.',
      path: '/sales-flow/invoices',
      icon: FileCheck,
      badge: badge('Billing / Invoices'),
    },
    {
      label: 'Payment Management',
      description: 'Record and track payments received from your customers.',
      path: '/sales-flow/payments',
      icon: PaymentIcon,
    },
    {
      label: 'Printing Contracts',
      description: 'Contracts, entitlement, schedules and prepaid balances.',
      path: '/sales-flow/printing-contracts',
      icon: RefreshCw,
      badge: badge('Printing Contracts'),
    },
    {
      label: 'Sales Exchanges',
      description: 'Print replacements, exchange requests, reprint tracking — not Completed/Rejected.',
      path: '/sales-flow/exchanges',
      icon: ArrowLeftRight,
      badge: badge('Sales Exchanges'),
    },
    {
      label: 'Job Tickets',
      description: 'Print jobs, photocopy orders, production — not Completed/Cancelled.',
      path: '/sales-flow/job-tickets',
      icon: Printer,
      badge: badge('Job Tickets'),
    },
    {
      label: 'Lead Board',
      description: 'Leads by stage, follow-up and deal value — funnel start.',
      path: '/sales-flow/leads',
      icon: Target,
    },
  ];

  // Phase 2: Funnel metrics — shows leakage
  const funnel = [
    { label: 'Leads', count: counts['Lead Board'] ?? 0 },
    { label: 'Quotes', count: counts['Quotations'] ?? 0 },
    { label: 'Orders', count: counts['Orders'] ?? 0 },
    { label: 'Invoices', count: counts['Billing / Invoices'] ?? 0 },
  ];
  const totalFunnel = funnel.reduce((s, f) => s + f.count, 0);
  const funnelBar = !isLoading && totalFunnel > 0 ? (
    <div className="w-full bg-white rounded-xl border border-[#e4ddd1] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-bold text-[#23282A]">Revenue Funnel</h3>
        <span className="text-[11px] text-[#5c6567]">{totalFunnel} active</span>
      </div>
      <div className="flex items-stretch gap-1 h-8">
        {funnel.map((s, idx) => {
          const pct = totalFunnel ? Math.max(6, (s.count / totalFunnel) * 100) : 0;
          const colors = ['#8b5cf6','#3b82f6','#1f8577','#d97706'];
          return (
            <div key={s.label} style={{ width: `${pct}%`, background: colors[idx] }} className="flex items-center justify-center rounded-md text-[11px] font-bold text-white transition-all" title={`${s.label}: ${s.count}`}>
              <span className="truncate px-1">{s.label} {s.count}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2 text-[11px] text-[#5c6567]">
        <span>Lead→Quote {funnel[0].count ? Math.round((funnel[1].count / Math.max(1,funnel[0].count))*100):0}%</span>
        <span>•</span>
        <span>Quote→Order {funnel[1].count ? Math.round((funnel[2].count / Math.max(1,funnel[1].count))*100):0}%</span>
        <span>•</span>
        <span>Order→Invoice {funnel[2].count ? Math.round((funnel[3].count / Math.max(1,funnel[2].count))*100):0}%</span>
      </div>
    </div>
  ) : null;

  if (error) {
    return (
      <GenericHub
        title="Sales Flow"
        subtitle={error}
        options={options}
        accentColor="#dc2626"
        theme={salesTheme}
        extraContent={funnelBar}
      />
    );
  }

  return (
    <GenericHub
      title="Sales Flow"
      subtitle={isLoading ? "Loading revenue pipeline..." : "Optimize your revenue generation, customer billing, and retail operations."}
      options={options}
      accentColor="#2eb12e"
      theme={salesTheme}
      extraContent={funnelBar}
    />
  );
};

export default SalesFlowHub;
