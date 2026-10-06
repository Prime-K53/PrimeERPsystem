import React from 'react';
import {
  Users, Building2, Landmark, UserCog,
  FileText, Wallet, Scale, Coins
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
      label: 'Banking',
      description: 'Manage bank accounts, record transfers, and reconcile with bank statements.',
      path: '/accounts/banking',
      icon: <Wallet />,
      color: 'bg-cyan-50 text-cyan-500'
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
      subtitle="Complete financial management - payroll, assets, loans, and equity."
      options={options}
      accentColor="#d99a3f"
    />
  );
};

export default FinanceHub;
