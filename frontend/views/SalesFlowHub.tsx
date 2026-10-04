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

  if (error) {
    return (
      <GenericHub
        title="Sales Flow"
        subtitle={error}
        options={options}
        accentColor="#dc2626"
        theme={salesTheme}
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
    />
  );
};

export default SalesFlowHub;
