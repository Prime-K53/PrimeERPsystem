# ENTERPRISE-WIDE REVENUE ACCOUNTING ENGINE AUDIT REPORT
## PrimeBooks-ERP - Revenue Source Matrix & Accounting Architecture

**Date:** September 6, 2026  
**Status:** AUDIT COMPLETE - FIXES IN PROGRESS  
**Scope:** ALL revenue-generating modules

---

## 1. REVENUE SOURCE MATRIX

| Source | Revenue Account | Payment Account | AR? | Inventory? | COGS? | Cancellation? | Module |
|--------|---------------|-----------------|-----|------------|-------|----------------|--------|
| **POS** | Product Sales (41100) | Cash/Bank | Optional | Yes | Yes | Required | `index.cjs:postSaleLedgerEntries` |
| **Sales Invoice** | Product Sales (41100) | AR | Yes | If goods | If goods | Required | `index.cjs:postSaleLedgerEntries` |
| **Examination** | Service/Exam Revenue | Cash/Bank/AR | Yes | No | No | Required | `examinationService.cjs:postInvoiceLedger` |
| **Service Income** | Service Income (41200) | Cash/Bank/AR | Optional | No | No | Required | `financeService.cjs:createIncome` |
| **Other Income** | Other Income (42000) | Cash/Bank | No | No | No | Required | `financeService.cjs:createIncome` |
| **Interest Income** | Interest Income (42100) | Cash/Bank | No | No | No | Required | `financeService.cjs:createIncome` |
| **Customer Payment** | N/A | Cash/Bank | Reduces AR | No | No | Required | `paymentAllocationService.cjs` |
| **Expenses** | N/A | Cash/Bank | No | No | No | Required | `financeService.cjs:createExpense` |
| **Transfers** | N/A | N/A | No | No | No | Required | `financeService.cjs:createTransfer` |

---

## 2. ARCHITECTURE ANALYSIS

### 2.1 Canonical Accounting Engine

**Location:** `backend/services/financeService.cjs`

The `FinanceService` class is the primary canonical accounting engine:

```javascript
// Key methods:
- createExpense()    // DR Expense / CR Cash/Bank
- createIncome()    // DR Cash/Bank / CR Income
- createTransfer()  // DR ToAccount / CR FromAccount
- saveLedgerEntry() // Core ledger posting
- reverseLedgerEntriesByReference() // Reversal support
```

### 2.2 Account Resolution

**Location:** `backend/services/financeService.cjs:135-154`

```javascript
async _resolveDefaultAccountId(kind, hint, companyId = null) {
  // ISSUE: Silent fallback to hardcoded account codes
  if (kind === 'cash') return '11110';   // Cash Drawer
  if (kind === 'income') return '41100'; // Product Sales
  return '51200';                         // Cost of Goods Sold
}
```

**CRITICAL ISSUE:** This function has silent fallback behavior. If account resolution fails, it returns hardcoded account codes instead of failing explicitly.

---

## 3. MODULE-BY-MODULE AUDIT

### 3.1 POS / Sales (`backend/index.cjs:495-562`)

**Function:** `postSaleLedgerEntries()`

**Accounting:**
```javascript
// DR Trade Debtors / CR Revenue (Product Sales)
await finance.saveLedgerEntry({
  account_id: arAccount.id,
  entry_type: 'debit',
  amount: totalAmount,
  ...
});

// CR Revenue
await finance.saveLedgerEntry({
  account_id: revenueAccount.id,
  entry_type: 'credit',
  ...
});

// DR COGS / CR Inventory (if applicable)
await finance.saveLedgerEntry({
  account_id: cogsAccount.id,
  entry_type: 'debit',
  ...
});
```

**Issues Found:**
1. Uses string matching for account resolution: `a.code === '11310' || a.name.toLowerCase().includes('accounts receivable')`
2. Uses hardcoded account codes as fallbacks
3. Does NOT have explicit failure when accounts can't be resolved

**Severity:** HIGH

### 3.2 Examination (`backend/services/examinationService.cjs:580-610`)

**Function:** `postInvoiceLedger()`

**Accounting:**
```javascript
const arAccount = allAccounts.find(
  (a) => /receivable/i.test(String(a.data?.name || a.name || ''))
  || String(a.data?.code || a.code || '') === '11310'
);
const revenueAccount = allAccounts.find(
  (a) => /revenue/i.test(String(a.data?.name || a.name || ''))
  || String(a.data?.code || a.code || '') === '41100'
);
```

**Issues Found:**
1. Uses loose regex matching: `/revenue/i` could match "Other Revenue"
2. Uses regex `/receivable/i` which is very loose
3. Falls back to account code '41100' silently

**Severity:** HIGH

### 3.3 FinanceService Income (`backend/services/financeService.cjs:902-971`)

**Function:** `createIncome()`

**Accounting:**
```javascript
// DR Cash/Bank / CR Income
await this.saveLedgerEntry({
  account_id: incomeAcctId,
  entry_type: 'credit',
  ...
});
```

**Issues Found:**
1. Uses `_resolveDefaultAccountId()` which has silent fallback
2. If `account_id` not provided, uses fallback to '41100' (Product Sales)

**Severity:** MEDIUM

### 3.4 Customer Payments (`backend/services/paymentAllocationService.cjs`)

**Function:** `allocatePayment()`

**Accounting:**
- Does NOT directly post to ledger
- Reduces AR based on payment allocation
- AR reduction handled via invoice status update

**Issues Found:** None - follows proper architecture

**Severity:** NONE

### 3.5 Referrals (`backend/services/referralService.cjs:1418, 1492`)

**Functions:** Direct INSERT into ledger_entries

**Accounting:**
```javascript
await runRun(`INSERT INTO ledger_entries ...`);
```

**Issues Found:**
1. Uses direct INSERT instead of `FinanceService.saveLedgerEntry()`
2. Not using canonical account IDs

**Severity:** MEDIUM

---

## 4. SILENT FALLBACK ANALYSIS

### 4.1 Current Defect Root Cause

The observed defect:
```
Cash Drawer          -K1,672
National Bank         K7,000
Trade Debtors        K7,000
Inventory           -K2,172
Product Sales       K7,000
Interest Income     K4,828  ← WRONG!
COGS                K2,172
```

**Root Cause:** `postSaleLedgerEntries()` likely resolved Interest Income instead of Product Sales due to:
1. Loose string matching: `a.name.toLowerCase().includes('sales')` could match Interest Income's name if it contains "sales"
2. Fallback to hardcoded '41100' if resolution fails

### 4.2 Silent Fallback Locations

| Function | Fallback Account | Issue |
|---------|-----------------|-------|
| `_resolveDefaultAccountId` | '41100' | Returns hardcoded code instead of failing |
| `postSaleLedgerEntries` | '11310', '41100', '51200' | Uses string matching |
| `postInvoiceLedger` | '41100' | Uses regex + hardcoded fallback |

---

## 5. NON-POSTING ACCOUNT VALIDATION

### 5.1 Accounts with `allow_posting = false`

| Account | Name | Type | Should NOT Receive Transactions |
|---------|------|------|-------------------------------|
| 10000 | Assets | ASSET | Yes |
| 11000 | Current Assets | ASSET | Yes |
| 11100 | Cash in Hand | ASSET | Yes |
| 11200 | Bank Accounts | ASSET | Yes |
| 11300 | Accounts Receivable | ASSET | Yes |
| 11400 | Inventory | ASSET | Yes |
| 20000 | Liabilities | LIABILITY | Yes |
| 21000 | Current Liabilities | LIABILITY | Yes |
| 21100 | Accounts Payable | LIABILITY | Yes |
| 21200 | Tax Payable | LIABILITY | Yes |
| 30000 | Equity | EQUITY | Yes |
| 40000 | Income | INCOME | Yes |
| 41000 | Sales | INCOME | Yes |
| 42000 | Other Income | INCOME | Yes |
| 50000 | Expenses | EXPENSE | Yes |
| 51000 | Cost of Sales | EXPENSE | Yes |
| 52000 | Operating Expenses | EXPENSE | Yes |
| 54000 | Other Expenses | EXPENSE | Yes |

### 5.2 Posting Accounts (Allowed)

| Account | Name | Type | Normal Balance |
|---------|------|------|---------------|
| 11110 | Cash Drawer | ASSET | DEBIT |
| 11210 | National Bank | ASSET | DEBIT |
| 11220 | FDH Bank | ASSET | DEBIT |
| 11230 | NBS Bank | ASSET | DEBIT |
| 11310 | Trade Debtors | ASSET | DEBIT |
| 11410 | Merchandise Inventory | ASSET | DEBIT |
| 21110 | Trade Creditors | LIABILITY | CREDIT |
| 21210 | VAT Payable | LIABILITY | CREDIT |
| 31000 | Capital | EQUITY | CREDIT |
| 32000 | Retained Earnings | EQUITY | CREDIT |
| 33000 | Current Year Earnings | EQUITY | CREDIT |
| 34000 | Drawings | EQUITY | DEBIT |
| 41100 | Product Sales | INCOME | CREDIT |
| 41200 | Service Income | INCOME | CREDIT |
| 42100 | Interest Income | INCOME | CREDIT |
| 42200 | Discount Received | INCOME | CREDIT |
| 51100 | Purchases | EXPENSE | DEBIT |
| 51200 | Cost of Goods Sold | EXPENSE | DEBIT |
| 52100 | Salaries & Wages | EXPENSE | DEBIT |
| ... | ... | ... | ... |

---

## 6. REVENUE POSTING RULES

### 6.1 GROSS PROFIT IS NEVER REVENUE

**RULE:** Gross profit (Revenue - COGS) must NEVER be posted as a separate revenue entry.

**Correct:**
```
Revenue = K7,000 (CR Product Sales)
COGS = K2,172 (DR COGS)
Gross Profit = K4,828 (DERIVED, not posted)
```

**WRONG (Previous Defect):**
```
DR Cash/K4,828
CR Interest Income/K4,828  ← WRONG!
```

### 6.2 REVENUE SOURCE → CANONICAL ACCOUNT MAPPING

| Revenue Source | Canonical Revenue Account | Account ID |
|---------------|-------------------------|------------|
| Product Sales | Product Sales (41100) | Canonical UUID |
| Service Income | Service Income (41200) | Canonical UUID |
| Examination Revenue | Service/Exam Revenue | Canonical UUID |
| Other Income | Other Income (42000) | Canonical UUID |
| Interest Income | Interest Income (42100) | Canonical UUID |

### 6.3 PAYMENT ACCOUNT MAPPING

| Payment Method | Canonical Account | Account ID |
|---------------|------------------|------------|
| Cash | Cash Drawer (11110) | Canonical UUID |
| Bank (National) | National Bank (11210) | Canonical UUID |
| Bank (FDH) | FDH Bank (11220) | Canonical UUID |
| Bank (NBS) | NBS Bank (11230) | Canonical UUID |
| AR Reduction | Trade Debtors (11310) | Canonical UUID |

---

## 7. CANCELLATION / VOID / REVERSAL RULES

### 7.1 Reversal Must Be Idempotent

```
Original Journal
       ↓
Reversal Journal (with reversalOf = original.id)
       ↓
Running twice → Only ONE reversal created
```

### 7.2 Revenue Reversal

**Original:**
```
DR Cash/AR     K7,000
CR Revenue     K7,000
```

**Reversal:**
```
DR Revenue     K7,000
CR Cash/AR    K7,000
```

### 7.3 COGS Reversal

**Original:**
```
DR COGS        K2,172
CR Inventory   K2,172
```

**Reversal:**
```
DR Inventory   K2,172
CR COGS        K2,172
```

### 7.4 Cancellation Status Filters

```javascript
const CLOSED_INVOICE_STATUSES = new Set(['draft', 'cancelled', 'voided']);
const CLOSED_PAYMENT_STATUSES = new Set(['cancelled', 'voided']);
```

---

## 8. CROSS-MODULE DUPLICATION TEST

### 8.1 Order → Invoice → Payment

```
Order Created
    ↓
No revenue (unless accounting model says otherwise)
    ↓
Invoice Posted
    ↓
Revenue recognized ONCE
    ↓
Payment Received
    ↓
AR reduced (no new revenue)
```

### 8.2 POS Sale

```
Sale
    ↓
Revenue recognized ONCE
    ↓
Payment
    ↓
Cash/Bank increased (no new revenue)
```

---

## 9. OFFLINE SYNC REQUIREMENTS

### 9.1 Sync Operation Requirements

Every accounting operation must:
1. Be stored in IndexedDB
2. Pass through Durable Sync Queue
3. Include `syncGeneration`
4. Be posted to `/api/sync/ops`
5. Survive offline → online transition

### 9.2 Idempotency

```javascript
// Operations must be idempotent
cloudSyncStore.applyOp({
  operationId: op.operationId, // Same ID = same result
  table,
  recordId,
  operation,
  payload,
  syncGeneration: op.syncGeneration,
});
```

---

## 10. TEST MATRIX (50 TESTS)

### POS (7 tests)
1. Product sale → Revenue K7,000, COGS K2,172
2. Payment → Cash/Bank increased
3. Inventory → Deducted exactly once
4. Cancellation → Reversal created
5. Payment void → Reversal created
6. No ProfitMargin posting
7. Offline sync → Same result

### Order Form (6 tests)
8. Order creation → No revenue
9. Order conversion → Invoice posted
10. Invoice → Revenue recognized
11. Payment → AR reduced
12. Cancellation → Reversal
13. Duplicate prevention

### Examination (5 tests)
14. Exam fee assessment → Revenue
15. Payment → Cash/Bank
16. Cancellation → Reversal
17. No Interest Income fallback
18. Correct revenue account

### Sales Invoice (5 tests)
19. Invoice → Revenue + AR
20. Payment → AR reduced
21. Cancellation → Reversal
22. No duplicate revenue
23. Correct account resolution

### Service Income (4 tests)
24. Service revenue → Service Income account
25. Payment
26. Cancellation
27. No COGS (no inventory)

### Other Income (4 tests)
28. Other income → Other Income account
29. Payment
30. Cancellation
31. No fallback

### Customer Payment (5 tests)
32. Payment → AR reduction
33. Partial payment → Proportional AR
34. Overpayment → Customer credit
35. Cancellation → AR restoration
36. No revenue creation

### Global Accounting (14 tests)
37. No ProfitMargin posting (ANY module)
38. No gross-profit revenue posting
39. No Interest Income fallback
40. No Other Income fallback
41. No duplicate reversal
42. Canonical account IDs used
43. Balanced journals
44. Trial Balance balanced
45. P&L derived correctly
46. Balance Sheet reconciles
47. Offline sync works
48. Cloud persistence works
49. Sync idempotency works
50. Non-posting accounts rejected

---

## 11. FILES REQUIRING CHANGES

| File | Issue | Priority |
|------|-------|----------|
| `backend/services/financeService.cjs` | Add explicit failure in `_resolveDefaultAccountId` | HIGH |
| `backend/index.cjs` | Fix `postSaleLedgerEntries` to use canonical IDs | HIGH |
| `backend/services/examinationService.cjs` | Fix `postInvoiceLedger` regex matching | HIGH |
| `backend/services/referralService.cjs` | Use `FinanceService` instead of direct INSERT | MEDIUM |
| `frontend/tests/accounting/` | Add 50 comprehensive tests | HIGH |

---

## 12. RECOMMENDED ARCHITECTURE

```
                  ┌──────────────┐
                  │     POS      │
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │ Order Form   │
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │ Examination  │
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │   Invoice    │
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │Service/Other │
                  └──────┬───────┘
                         │
                         ▼
              ┌──────────────────────┐
              │ CANONICAL ACCOUNTING │
              │    ENGINE (Finance)  │
              └──────────┬───────────┘
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
          Revenue       AR       Inventory
             │           │           │
             └───────────┼───────────┘
                         ▼
                    GL / Journal
                         │
                         ▼
                Financial Reports
```

---

## 13. ACCEPTANCE CRITERIA

Before accepting, ALL of the following must be TRUE:

- [ ] No module posts gross profit as revenue
- [ ] No module uses Interest Income as fallback
- [ ] No module uses Other Income as fallback
- [ ] Revenue recognized exactly once per business event
- [ ] All cancellations create immutable reversals
- [ ] All reversals are idempotent
- [ ] Canonical account IDs used everywhere
- [ ] Non-posting accounts rejected explicitly
- [ ] Trial Balance always balanced
- [ ] P&L derives gross profit (Revenue - COGS)
- [ ] Offline sync preserves accounting integrity
- [ ] 50 tests all pass

---

**AUDIT STATUS:** COMPLETE  
**NEXT STEP:** Implement fixes per above analysis
