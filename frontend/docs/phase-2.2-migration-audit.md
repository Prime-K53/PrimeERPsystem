# Phase 2.2 Account-ID Migration Audit

## Ledger Write Audit Summary

**Total ledger writes identified:** 59 direct `ledgerStore.put()` calls in `transactionService.ts`

---

## Posting Path Migration Table

| # | Posting Path | Function | Debit Source | Credit Source | Current Format | Target Format | Status |
|---|-------------|----------|--------------|---------------|----------------|---------------|--------|
| 1 | POS Sale Tax (paid) | processSale:725 | gl.cashDrawerAccount | vatConfig.outputTaxAccount | legacy code | account.id | NEEDS FIX |
| 2 | POS Sale Tax (AR) | processSale:741 | gl.accountsReceivable | vatConfig.outputTaxAccount | legacy code | account.id | NEEDS FIX |
| 3 | POS Market Adj (paid) | processSale:765 | gl.cashDrawerAccount | vatConfig.marketAdjAcct | legacy code | account.id | NEEDS FIX |
| 4 | POS Market Adj (AR) | processSale:781 | gl.accountsReceivable | vatConfig.marketAdjAcct | legacy code | account.id | NEEDS FIX |
| 5 | POS Margin Income | processSale:808 | gl.cashDrawerAccount | marginAccount | legacy code | account.id | NEEDS FIX |
| 6 | POS Rounding (paid) | processSale:844 | gl.cashDrawerAccount | roundingAccount | legacy code | account.id | NEEDS FIX |
| 7 | POS Rounding (AR) | processSale:865 | gl.accountsReceivable | roundingAccount | legacy code | account.id | NEEDS FIX |
| 8 | POS Revenue (paid) | processSale:887 | gl.cashDrawerAccount | revenueAccountId | legacy code | account.id | NEEDS FIX |
| 9 | POS Revenue (AR) | processSale:903 | gl.accountsReceivable | revenueAccountId | legacy code | account.id | NEEDS FIX |
| 10 | POS COGS | processSale:925 | gl.defaultCOGSAccount | gl.defaultInventoryAccount | legacy code | account.id | NEEDS FIX |
| 11 | POS Payment retention | processSale:959 | targetDebitAccount | gl.cashDrawerAccount | legacy code | account.id | NEEDS FIX |
| 12 | POS Auto-transfer | processSale:975 | gl.bankAccount | gl.cashDrawerAccount | legacy code | account.id | NEEDS FIX |
| 13 | POS Wallet deposit | processSale:1008 | gl.customerDepositAccount | gl.cashDrawerAccount | legacy code | account.id | NEEDS FIX |
| 14 | Invoice COGS | processInvoice:2051 | gl.defaultCOGSAccount | gl.defaultInventoryAccount | legacy code | account.id | NEEDS FIX |
| 15 | Invoice AR | processInvoice:2074 | gl.accountsReceivable | revenueAccountId | legacy code | account.id | NEEDS FIX |
| 16 | Invoice Payable | processInvoice:2142 | gl.accountsPayable | gl.bankAccount | legacy code | account.id | NEEDS FIX |
| 17 | Purchase COGS | processPurchaseOrder:2362 | gl.defaultCOGSAccount | gl.defaultInventoryAccount | legacy code | account.id | NEEDS FIX |
| 18 | Purchase AP | processPurchaseOrder:2386 | gl.accountsPayable | gl.bankAccount | legacy code | account.id | NEEDS FIX |
| 19 | Purchase AR | processPurchaseOrder:2518 | gl.accountsReceivable | gl.bankAccount | legacy code | account.id | NEEDS FIX |
| 20 | Customer Deposit | addCustomerPayment:2706 | gl.bankAccount | gl.customerDepositAccount | legacy code | account.id | NEEDS FIX |
| 21 | Customer Deposit AR | addCustomerPayment:2719 | gl.accountsReceivable | gl.customerDepositAccount | legacy code | account.id | NEEDS FIX |
| 22 | Customer Payment AR | addCustomerPayment:2737 | gl.cashDrawerAccount | gl.accountsReceivable | legacy code | account.id | NEEDS FIX |
| 23 | Invoice Reversal | voidInvoice:2912 | gl.accountsReceivable | revenueAccountId | legacy code | account.id | NEEDS FIX |
| 24 | Payment Reversal | voidCustomerPayment:3133 | gl.accountsReceivable | gl.cashDrawerAccount | legacy code | account.id | NEEDS FIX |
| 25 | Payment Reversal wallet | voidCustomerPayment:3199 | gl.customerDepositAccount | gl.accountsReceivable | legacy code | account.id | NEEDS FIX |
| 26 | PO Reversal | cancelPurchaseOrder:3331 | gl.accountsPayable | gl.bankAccount | legacy code | account.id | NEEDS FIX |
| 27 | COGS Reversal | voidInvoice:3400 | gl.defaultInventoryAccount | gl.defaultCOGSAccount | legacy code | account.id | NEEDS FIX |
| 28 | Expense Entry | addExpense:3455 | expenseAccount | gl.cashDrawerAccount | legacy code | account.id | NEEDS FIX |
| 29 | Expense Approval | approveExpense:3491 | expenseAccount | gl.cashDrawerAccount | legacy code | account.id | NEEDS FIX |
| 30 | Late Fee | applyLateFeeToInvoice:3611 | gl.accountsReceivable | gl.otherIncomeAccount | legacy code | account.id | NEEDS FIX |
| 31 | GRN Inventory | processGoodsReceipt:3662 | gl.defaultInventoryAccount | gl.accountsPayable | legacy code | account.id | NEEDS FIX |
| 32 | GRN Variance | processGoodsReceipt:3721 | gl.accountsReceivable \| gl.accountsPayable | gl.defaultInventoryAccount | legacy code | account.id | NEEDS FIX |
| 33 | PO Receipt | processGoodsReceipt:3847 | gl.defaultInventoryAccount | gl.accountsPayable | legacy code | account.id | NEEDS FIX |
| 34 | PO Inventory | processGoodsReceipt:3886 | gl.defaultInventoryAccount | gl.accountsPayable | legacy code | account.id | NEEDS FIX |
| 35 | PO Variance | processGoodsReceipt:3912 | gl.accountsReceivable | gl.defaultInventoryAccount | legacy code | account.id | NEEDS FIX |
| 36 | Bank transaction | processGoodsReceipt:3982 | gl.bankAccount | various | legacy code | account.id | NEEDS FIX |
| 37 | AP Entry | processPurchaseOrder:4124 | various | gl.accountsPayable | legacy code | account.id | NEEDS FIX |
| 38 | Journal reversal | _reverseJournal:4177 | gl.accountsReceivable | various | legacy code | account.id | NEEDS FIX |
| 39 | Manual journal | _reverseJournal:4264 | various | various | legacy code | account.id | NEEDS FIX |
| 40 | Journal lines | createJournalLines:4326 | various | various | legacy code | account.id | NEEDS FIX |
| 41 | Journal entry | createJournalEntry:4434 | various | various | legacy code | account.id | NEEDS FIX |
| 42 | Invoice COGS (2) | convertQuotationToInvoice:4524 | gl.defaultCOGSAccount | gl.defaultInventoryAccount | legacy code | account.id | NEEDS FIX |
| 43 | Invoice Revenue | convertQuotationToInvoice:4582 | gl.accountsReceivable | revenueAccountId | legacy code | account.id | NEEDS FIX |
| 44 | Invoice Entry | convertQuotationToInvoice:4620 | gl.accountsReceivable | gl.bankAccount | legacy code | account.id | NEEDS FIX |
| 45 | Order Payment | recordOrderPayment:4725 | gl.cashDrawerAccount | gl.accountsReceivable | legacy code | account.id | NEEDS FIX |
| 46 | Work Order COGS | completeWorkOrder:4842 | gl.defaultCOGSAccount | gl.defaultInventoryAccount | legacy code | account.id | NEEDS FIX |
| 47 | Work Order Revenue | completeWorkOrder:4896 | gl.accountsReceivable | revenueAccountId | legacy code | account.id | NEEDS FIX |
| 48 | Work Order reversal | cancelWorkOrder:4973 | gl.defaultInventoryAccount | gl.defaultCOGSAccount | legacy code | account.id | NEEDS FIX |
| 49 | Journal entry | createJournalEntry:5116 | various | various | legacy code | account.id | NEEDS FIX |
| 50 | Supplier Payment | recordSupplierPayment:5187 | gl.accountsPayable | gl.bankAccount | legacy code | account.id | NEEDS FIX |
| 51 | Journal reversal | voidSupplierPayment:5279 | gl.bankAccount | gl.accountsPayable | legacy code | account.id | NEEDS FIX |
| 52 | Purchase COGS (2) | processPurchaseOrder:1308 | gl.defaultInventoryAccount | gl.defaultCOGSAccount | legacy code | account.id | NEEDS FIX |
| 53 | Tax adjustment | processInvoice:1389 | vatConfig.outputTaxAccount | targetCreditAccount | legacy code | account.id | NEEDS FIX |
| 54 | Market adjustment | processInvoice:1406 | vatConfig.marketAdjAcct | targetCreditAccount | legacy code | account.id | NEEDS FIX |
| 55 | Revenue return | processCreditNote:1424 | gl.accountsReceivable | revenueAccountId | legacy code | account.id | NEEDS FIX |
| 56 | Refund reversal | processRefund:1625 | gl.cashDrawerAccount | gl.accountsReceivable | legacy code | account.id | NEEDS FIX |
| 57 | Refund AP | processRefund:1693 | gl.accountsPayable | gl.cashDrawerAccount | legacy code | account.id | NEEDS FIX |
| 58 | processSale:1315 | _executeDeductInventory | gl.defaultInventoryAccount | gl.defaultCOGSAccount | legacy code | account.id | NEEDS FIX |
| 59 | processSale:3444 | _executeDeductInventory | gl.defaultCOGSAccount | gl.defaultInventoryAccount | legacy code | account.id | NEEDS FIX |

---

## Migration Strategy

### Pattern for Each Posting Path

**Before (Legacy):**
```typescript
const gl = getGLConfig();
const entry: LedgerEntry = {
    debitAccountId: gl.cashDrawerAccount,  // "1000"
    creditAccountId: gl.accountsReceivable, // "1100"
    amount: 100,
    ...
};
await ledgerStore.put(entry);
```

**After (Canonical):**
```typescript
const accounts = await loadAccountsFromStore(tx);
const companyConfig = getCompanyConfig();
const companyId = companyConfig?.companyId;
const options = { allowNonPosting: false, companyId };

const debitId = resolveAccountForPosting(gl.cashDrawerAccount, accounts, options);
const creditId = resolveAccountForPosting(gl.accountsReceivable, accounts, options);

const entry: LedgerEntry = {
    debitAccountId: debitId || gl.cashDrawerAccount,
    creditAccountId: creditId || gl.accountsReceivable,
    amount: 100,
    ...
};
await ledgerStore.put(entry);
```

---

## Key Observations

1. **All paths use `getGLConfig()`** - Returns legacy 4-digit codes
2. **VAT config also returns legacy codes** - `vatConfig.outputTaxAccount` is "21201" etc.
3. **Some paths have dynamic account selection** - e.g., `targetDebitAccount` based on payment method
4. **Reversal paths** - These mirror the original entries and need the same resolution
5. **Manual journals** - Already use `postJournalEntry()` which has resolution

---

## Accounts Used in Ledger Writes

| GL Config Key | Legacy Code | Semantic Role |
|---------------|-------------|---------------|
| cashDrawerAccount | 1000 | CASH |
| bankAccount | 1050 | BANK |
| mobileMoneyAccount | 1060 | MOBILE_MONEY |
| accountsReceivable | 1100 | AR |
| defaultInventoryAccount | 1200 | INVENTORY |
| defaultCOGSAccount | 5000 | COGS |
| accountsPayable | 2000 | AP |
| defaultSalesAccount | 4000 | SALES |
| defaultExpenseAccount | 6100 | EXPENSE |
| defaultLaborWagesAccount | 6300 | EXPENSE_SALARIES |
| retainedEarningsAccount | 3000 | RETAINED_EARNINGS |
| customerDepositAccount | 2200 | AP |
| otherIncomeAccount | 4900 | OTHER_INCOME |
| marginIncomeAccount | 4900 | OTHER_INCOME |
| roundingAccount | 4900 | OTHER_INCOME |
| salesReturnAccount | 4100 | SALES |

---

## Implementation Notes

1. **Load accounts once per transaction** - Use `loadAccountsFromStore(tx)` at the start of each transaction function
2. **Resolve all accounts before any `ledgerStore.put()`** - Build the resolved entry object first
3. **Fall back to legacy code if resolution fails** - Preserve backward compatibility: `resolvedId || originalRef`
4. **Company validation** - Pass `companyId` in options to prevent cross-company issues
5. **Non-posting validation** - Most ledger entries should use `allowNonPosting: false`

---

## Phase 2.2 Definition of Done Status

- [ ] All 59 ledger writes have been audited - **YES** (static analysis)
- [ ] All 59 ledger writes resolve accounts before persistence - **NO** (0 migrated)
- [ ] Zero new ledger writes persist legacy codes directly - **NO** (all 59 bypass)
- [ ] `account.id` is the canonical identity for new ledger entries - **PARTIAL** (postJournalEntry only)
- [ ] Legacy ledger entries remain readable - **YES** (dual-resolution in reports)
- [ ] `getGLConfig()` cannot bypass account resolution - **NO** (still used directly)
- [ ] Semantic system-account resolution is centralized - **YES** (in accountResolutionService)
- [ ] Bank accounts resolve to the selected bank account - **NO** (generic 1050)
- [ ] Cash accounts resolve to the selected cash account - **NO** (generic 1000)
- [ ] Non-posting parents cannot receive journal lines - **YES** (via resolveAccountForPosting)
- [ ] Inactive accounts cannot receive new journal lines - **YES** (via resolveAccountForPosting)
- [ ] Cross-company accounts are rejected - **YES** (via resolveAccountForPosting)
- [ ] Financial reports support both historical and new identifiers - **PARTIAL** (needs fix)
- [ ] Offline transactions preserve account IDs - **NOT AUDITED**
- [ ] Sync preserves account IDs - **NOT AUDITED**
- [ ] Opening balances have been audited - **NOT AUDITED**
- [ ] Depreciation has been audited - **NOT AUDITED**
- [ ] No destructive historical migration has been performed - **YES**
- [ ] Regression tests cover account resolution - **YES** (accountResolution.test.ts)
- [ ] Runtime tests remain honestly marked BLOCKED - **YES**
