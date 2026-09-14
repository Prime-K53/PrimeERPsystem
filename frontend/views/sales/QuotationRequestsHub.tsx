import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Inbox, FileText, PackageCheck, HandCoins, History, Users, Calendar } from 'lucide-react';
import GenericHub from '../GenericHub';
import QuotationRequests from './QuotationRequests';

const QuotationRequestsHub: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const targetTab = (location.state as any)?.tab;

  if (targetTab) {
    return <QuotationRequests />;
  }

  const options = [
    {
      label: 'Inbox',
      description: 'Review new customer requests, assign staff, and triage submissions.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'inbox' } }),
      icon: Inbox,
    },
    {
      label: 'Quotations',
      description: 'Review official quotations, track versions, signatures, and conversions.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'quotations' } }),
      icon: FileText,
    },
    {
      label: 'Orders',
      description: 'Manage sales orders, track fulfillment status, and advance production milestones.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'orders' } }),
      icon: PackageCheck,
    },
    {
      label: 'Payment Requests',
      description: 'Manage bank-transfer payment intents linked to requests and orders.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'payments' } }),
      icon: HandCoins,
    },
    {
      label: 'Staff Assignments',
      description: 'View and manage requests grouped by assigned salesperson.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'assignments' } }),
      icon: Users,
    },
    {
      label: 'Timeline',
      description: 'View all requests chronologically with status tracking.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'timeline' } }),
      icon: Calendar,
    },
    {
      label: 'History',
      description: 'Audit trail of rejected, cancelled, and converted requests.',
      onClick: () => navigate('/sales-flow/requests', { state: { tab: 'history' } }),
      icon: History,
    },
  ];

  return (
    <GenericHub
      title="Requests"
      subtitle="Review customer requests, issue quotations, and convert accepted quotes into orders."
      options={options}
      accentColor="#146b60"
    />
  );
};

export default QuotationRequestsHub;
