import React from 'react';
import { FileText, FileCheck, Banknote as PaymentIcon, RefreshCw, Printer, Target, CheckSquare, ArrowLeftRight } from 'lucide-react';
import GenericHub, { HubTheme } from './GenericHub';

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
  const options = [
    {
      label: 'Quotations',
      description: 'Generate estimates and track approval — overdue highlighted.',
      path: '/sales-flow/quotations',
      icon: FileText,
    },
    {
      label: 'Orders',
      description: 'Manage orders, fulfillment and bulk ops — pending + hold.',
      path: '/sales-flow/orders',
      icon: CheckSquare,
    },
    {
      label: 'Invoices',
      description: 'Official invoicing, credit notes, payment status — actionable unpaid only.',
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
      label: 'Printing Contracts',
      description: 'Contracts, entitlement, schedules and prepaid balances.',
      path: '/sales-flow/printing-contracts',
      icon: RefreshCw,
    },
    {
      label: 'Sales Exchanges',
      description: 'Print replacements, exchange requests, reprint tracking — not Completed/Rejected.',
      path: '/sales-flow/exchanges',
      icon: ArrowLeftRight,
    },
    {
      label: 'Job Tickets',
      description: 'Print jobs, photocopy orders, production — not Completed/Cancelled.',
      path: '/sales-flow/job-tickets',
      icon: Printer,
    },
    {
      label: 'Lead Board',
      description: 'Leads by stage, follow-up and deal value — funnel start.',
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
