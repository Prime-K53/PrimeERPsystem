# Financial Flow Data Map

## Complete Transaction Flow

```
Customer
  ↓ (customer_id in data JSONB)
Quotation / Order / Sales Order
  ↓ (quotation_id / order_id / source_request_id)
Invoice (invoices.data JSONB)
  ↓ (reference_type='invoice', reference_id=invoice.id)
Accounts Receivable (ledger_entries debit to 11310)
  ↓ (payment_allocations.payment_id → customer_payments.id)
Payment (customer_payments.data JSONB)
  ↓ (payment_allocation_lines.allocation_id → payment_allocations.id)
Allocation (payment_allocations.data JSONB)
  ↓ (ledger_entries debit/credit to bank/AR)
Bank/Cash (bank_transactions, bank_accounts)
  ↓ (ledger_entries by account_id)
Journal/Ledger (ledger_entries.data JSONB)
  ↓ (chart_of_accounts by id)
COA (chart_of_accounts.data JSONB)
  ↓ (v_trial_balance, v_customer_balances, etc.)
Reports (financialReportingService)
```

## Table Relationships

| Source | Destination | Service | Table | ID Field | Accounting Effect |
|--------|-------------|---------|-------|----------|-------------------|
| Customer | Quotation | portalLifecycle | quotation_requests | customer_id | Creates receivable expectation |
| Quotation | Order | portalLifecycle | quotations → sales_orders | quotation_id/order_id | Converts expectation to order |
| Order | Invoice | examinationService | invoices | (none direct) | DR AR / CR Revenue |
| Invoice | AR | examinationService | ledger_entries | reference_id=invoice.id | DR 11310 / CR 41200 |
| Payment | Invoice | paymentAllocationService | payment_allocations | payment_id/invoice_id | Updates invoice paid_amount |
| Payment | Ledger | paymentAllocationService | ledger_entries | reference_type='payment' | DR Bank / CR AR |
| Bank | Ledger | bankingService | ledger_entries | reference_id=bank_transaction.id | DR/CR per transaction type |

## Test Coverage
- portalLifecycle.test.cjs: 12 tests
- Test categories: input validation, race conditions