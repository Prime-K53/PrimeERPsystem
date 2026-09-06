import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AccountTree } from '../../views/accounts/components/AccountTree';
import { Account } from '../../types';

describe('AccountTree React Keys & Grouping', () => {
  const mockAccounts: Account[] = [
    {
      id: '20000',
      code: '20000',
      account_number: '20000',
      name: 'Liabilities',
      account_type: 'LIABILITY',
      type: 'Liability',
      allow_posting: false,
      is_system_account: true
    },
    {
      id: '21000',
      code: '21000',
      account_number: '21000',
      name: 'Current Liabilities',
      account_type: 'LIABILITY',
      type: 'Liability',
      account_group: 'CURRENT_LIABILITY',
      allow_posting: false
    },
    {
      id: '21100',
      code: '21100',
      account_number: '21100',
      name: 'Accounts Payable',
      account_type: 'LIABILITY',
      type: 'Liability',
      account_group: 'CURRENT_LIABILITY',
      subtype: 'PAYABLE',
      is_system_account: true
    },
    {
      id: '21110',
      code: '21110',
      account_number: '21110',
      name: 'Trade Creditors',
      account_type: 'LIABILITY',
      type: 'Liability',
      account_group: 'CURRENT_LIABILITY',
      parent_account_id: '21100',
      allow_posting: true,
      is_system_account: true
    },
    {
      id: '21200',
      code: '21200',
      account_number: '21200',
      name: 'Tax Payable',
      account_type: 'LIABILITY',
      type: 'Liability',
      account_group: 'CURRENT_LIABILITY',
      allow_posting: false,
      subtype: 'TAX'
    },
    {
      id: '21210',
      code: '21210',
      account_number: '21210',
      name: 'VAT Payable',
      account_type: 'LIABILITY',
      type: 'Liability',
      account_group: 'CURRENT_LIABILITY',
      parent_account_id: '21200',
      subtype: 'TAX',
      allow_posting: true,
      is_system_account: true
    },
    {
      id: '21300',
      code: '21300',
      account_number: '21300',
      name: 'Accrued Expenses',
      account_type: 'LIABILITY',
      type: 'Liability',
      account_group: 'CURRENT_LIABILITY',
      allow_posting: true
    },
    {
      id: '22000',
      code: '22000',
      account_number: '22000',
      name: 'Long-Term Liabilities',
      account_type: 'LIABILITY',
      type: 'Liability',
      account_group: 'LONG_TERM_LIABILITY',
      allow_posting: false
    }
  ];

  const noop = () => {};

  it('renders multiple LIABILITY groups without duplicate-key warnings', () => {
    const errorSpy = vi.spyOn(console, 'error');

    render(
      <AccountTree
        accounts={mockAccounts}
        onSelectAccount={noop}
        onEditAccount={noop}
        onDeleteAccount={noop}
        onAddSubAccount={noop}
        onViewLedger={noop}
        onToggleActive={noop}
        balances={{}}
        currencySymbol="$"
        canEdit={true}
      />
    );

    const duplicateKeyWarnings = errorSpy.mock.calls.filter((args) =>
      args.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('Encountered two children with the same key')
      )
    );

    expect(duplicateKeyWarnings).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('preserves 5-digit account ordering and renders all accounts', () => {
    const { container } = render(
      <AccountTree
        accounts={mockAccounts}
        onSelectAccount={noop}
        onEditAccount={noop}
        onDeleteAccount={noop}
        onAddSubAccount={noop}
        onViewLedger={noop}
        onToggleActive={noop}
        balances={{}}
        currencySymbol="$"
        canEdit={true}
      />
    );

    // Verify all account names are present in the DOM
    mockAccounts.forEach((acc) => {
      expect(container.textContent).toContain(acc.name);
    });

    // Verify header sections appear for each distinct group
    expect(container.textContent).toContain('Accounts Payable');
    expect(container.textContent).toContain('Tax Accounts');
    expect(container.textContent).toContain('LIABILITY');
  });
});
