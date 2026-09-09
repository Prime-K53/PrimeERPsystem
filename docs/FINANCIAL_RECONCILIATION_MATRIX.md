# Financial Reconciliation Matrix

## Reconciliation Checks

### 1. Trial Balance
`SUM(ledger_entries debit) = SUM(ledger_entries credit)`
- Status: NOT AUTOMATED
- Note: Requires all transactions to post paired entries

### 2. AR Subledger vs Control
`Customer subledger = AR control account (11310) balance`
- Status: VERIFIED in customerLedger.cjs
- The customerLedger builds from invoices + payments directly

### 3. Customer Balance
`Customer outstanding = Σ invoice totals - Σ valid payment credits`
- Status: VERIFIED in customerLedger.cjs buildLedgerFromRecords

### 4. Invoice Balance
`Invoice outstanding = invoice total - valid allocations`
- Status: VERIFIED in paymentAllocationService.getOutstandingInvoices

### 5. Payment Balance
`Payment remaining = payment amount - allocations`
- Status: VERIFIED in paymentAllocationService allocatePayment

### 6. P&L
Revenue/expenses reconcile to posted ledger entries
- Status: VERIFIED in financialReportingService

### 7. Balance Sheet
Assets = Liabilities + Equity
- Status: NOT AUTOMATED

## Known Divergences
1. BankingService.createTransaction does not post to ledger → bank balances may diverge from AR
2. financeService expense/income ledger failures are silent → income/expense may diverge from ledger
3. postInvoiceLedger hardcodes 11310/41200 → tax is not posted

## Recommendations
1. Add ledger posting to BankingService.createTransaction
2. Make financeService ledger post failures fatal (not silent)
3. Add tax account posting to postInvoiceLedger