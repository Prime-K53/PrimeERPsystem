import React from 'react';
import {
  Users, Building2, Landmark, UserCog, CalendarCheck,
  ChartBar, FileText, Wallet, Scale, Coins, ArrowRightLeft
} from 'lucide-react';
import GenericHub from './GenericHub';

const FinanceHub: React.FC = () => {
  const options = [
    {
      label: 'Payroll Engine',
      description: 'Process employee salaries, deductions, PAYE, and generate payslips.',
      path: '/accounts/payroll',
      icon: <Users />,
      color: 'bg-purple-50 text-purple-500'
    },
    {
      label: 'Fixed Assets',
      description: 'Track asset acquisition, depreciation, and disposal. Motor vehicles, furniture, computers, buildings.',
      path: '/accounts/fixed-assets',
      icon: <Building2 />,
      color: 'bg-amber-50 text-amber-500'
    },
    {
      label: 'Loans & Borrowings',
      description: 'Manage bank loans, other loans, track interest expense and repayment schedules.',
      path: '/accounts/loans',
      icon: <Landmark />,
      color: 'bg-blue-50 text-blue-500'
    },
    {
      label: 'Owner Equity',
      description: 'Track capital contributions, drawings, and owner investment activities.',
      path: '/accounts/owner-equity',
      icon: <UserCog />,
      color: 'bg-emerald-50 text-emerald-500'
    },
    {
      label: 'Year-End Closing',
      description: 'Close income summary accounts and transfer earnings to retained earnings.',
      path: '/accounts/year-end-closing',
      icon: <CalendarCheck />,
      color: 'bg-rose-50 text-rose-500'
    },
    {
      label: 'Chart of Accounts',
      description: 'View and manage the complete chart of accounts. Add, edit, and organize GL accounts.',
      path: '/accounts/chart-of-accounts',
      icon: <ChartBar />,
      color: 'bg-slate-50 text-slate-500'
    },
    {
      label: 'Banking',
      description: 'Manage bank accounts, record transfers, and reconcile with bank statements.',
      path: '/accounts/banking',
      icon: <Wallet />,
      color: 'bg-cyan-50 text-cyan-500'
    },
    {
      label: 'Account Transfers',
      description: 'Record internal transfers between cash, bank, and mobile money accounts.',
      path: '/accounts/transfers',
      icon: <ArrowRightLeft />,
      color: 'bg-teal-50 text-teal-500'
    },
    {
      label: 'VAT Module',
      description: 'Track VAT on sales and purchases, generate returns, and manage VAT payments.',
      path: '/vat',
      icon: <FileText />,
      color: 'bg-indigo-50 text-indigo-500'
    }
  ];

  return (
    <GenericHub
      title="Finance"
      subtitle="Complete financial management - payroll, assets, loans, equity, and year-end processing."
      options={options}
      accentColor="#6366f1"
    />
  );
};

export default FinanceHub;
