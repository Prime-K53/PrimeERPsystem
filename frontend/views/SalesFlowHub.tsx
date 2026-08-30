import React, { useState, useEffect } from 'react';
import { FileText, FileCheck, Banknote as PaymentIcon, RefreshCw, Printer, Target, CheckSquare, ArrowLeftRight, Award } from 'lucide-react';
import GenericHub, { HubTheme } from './GenericHub';
import { useSalesOrderStore } from '../stores/salesOrderStore';
import { useSalesStore } from '../stores/salesStore';
import { useFinanceStore } from '../stores/financeStore';
import { dbService } from '../services/db';

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

  const salesOrderStore = useSalesOrderStore();
  const salesStore = useSalesStore();
  const financeStore = useFinanceStore();

  useEffect(() => {
    const fetchCounts = async () => {
      const [
        quotations,
        salesOrders,
        invoices,
        jobOrders,
        salesExchanges,
        referralRewards,
      ] = await Promise.all([
        dbService.getAll('quotations'),
        Promise.resolve(salesOrderStore.salesOrders),
        Promise.resolve(financeStore.invoices),
        Promise.resolve(salesStore.jobOrders),
        Promise.resolve(salesStore.salesExchanges),
        dbService.getAll('referralRewards'),
      ]);

      const pendingQuotations = (quotations as any[]).filter((q: any) =>
        q.status === 'Sent' || q.status === 'Draft'
      ).length;
      const pendingOrders = (salesOrders as any[]).filter((o: any) =>
        o.status === 'Pending' || o.status === 'Processing'
      ).length;
      const unpaidInvoices = (invoices as any[]).filter((i: any) =>
        i.status !== 'Paid' && i.status !== 'Cancelled' && i.status !== 'Void'
      ).length;
      const activeSubscriptions = (salesOrders as any[]).filter((o: any) =>
        o.status === 'Active' || o.status === 'Draft'
      ).length;
      const pendingExchanges = (salesExchanges as any[]).filter((e: any) =>
        e.status !== 'Completed' && e.status !== 'Rejected'
      ).length;
      const pendingJobTickets = (jobOrders as any[]).filter((j: any) =>
        j.status !== 'Completed' && j.status !== 'Cancelled'
      ).length;
      const pendingRewards = (referralRewards as any[]).filter((r: any) =>
        r.status === 'pending' || r.status === 'Pending'
      ).length;

      setCounts({
        Quotations: pendingQuotations,
        Orders: pendingOrders,
        'Billing / Invoices': unpaidInvoices,
        Subscriptions: activeSubscriptions,
        'Sales Exchanges': pendingExchanges,
        'Job Tickets': pendingJobTickets,
        'Referral Rewards': pendingRewards,
      });
    };

    fetchCounts();
  }, [salesOrderStore.salesOrders, salesStore.jobOrders, salesStore.salesExchanges, financeStore.invoices]);

  const badge = (label: string) => counts[label] || 0;

  const options = [
    {
      label: 'Quotations',
      description: 'Generate professional estimates and track customer approval status.',
      path: '/sales-flow/quotations',
      icon: FileText,
    },
    {
      label: 'Orders',
      description: 'Manage customer orders, track fulfillment status, and handle bulk operations.',
      path: '/sales-flow/orders',
      icon: CheckSquare,
    },
    {
      label: 'Billing / Invoices',
      description: 'Official invoicing, credit notes, and payment status tracking.',
      path: '/sales-flow/invoices',
      icon: FileCheck,
    },
    {
      label: 'Payment Management',
      description: 'Record and track payments received from your customers.',
      path: '/sales-flow/payments',
      icon: PaymentIcon,
    },
    {
      label: 'Subscriptions',
      description: 'Manage recurring billing, membership tiers, and automated renewals.',
      path: '/sales-flow/subscriptions',
      icon: RefreshCw,
    },
    {
      label: 'Sales Exchanges',
      description: 'Manage print replacements, exchange requests, and reprint job tracking.',
      path: '/sales-flow/exchanges',
      icon: ArrowLeftRight,
    },
    {
      label: 'Job Tickets',
      description: 'Manage print jobs, photocopy orders, and production tracking.',
      path: '/sales-flow/job-tickets',
      icon: Printer,
    },
    {
      label: 'Referral Rewards',
      description: 'Review referral bonuses, track pending rewards, and manage payout status.',
      path: '/sales-flow/referral-rewards',
      icon: Award,
    },
    {
      label: 'Lead Board',
      description: 'Track leads by stage, follow-up dates, and estimated deal value.',
      path: '/sales-flow/leads',
      icon: Target,
    },
  ];

  return (
    <GenericHub
      title="Sales Flow"
      subtitle="Optimize your revenue generation, customer billing, and retail operations."
      options={options}
      accentColor="#2eb12e"
      theme={salesTheme}
    />
  );
};

export default SalesFlowHub;
