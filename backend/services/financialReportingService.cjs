/**
 * financialReportingService.cjs
 *
 * Authoritative financial reporting. Backed by the Supabase views created in
 * migration 0013_financial_integrity.sql:
 *   - v_trial_balance
 *   - v_trial_balance_balanced
 *   - v_customer_balances
 *   - v_supplier_balances
 *   - v_ar_aging
 *   - v_ap_aging
 *   - v_profit_and_loss
 *   - v_invoice_integrity
 *
 * Audit fixes implemented here (see docs/financial-integrity-audit-2026-09-02.md):
 *   F-01  getAPAging now reads `purchases` (not invoices).
 *   F-06  P&L revenue excludes draft/voided/credit_note statuses and adds
 *         credit notes as negative sales.
 *   F-07  Trial balance filters `reference_type = 'reversal'`.
 *   F-16  Balance sheet derives account balances from the ledger
 *         (chart_of_accounts.data.balance, kept fresh by the COA trigger in
 *         migration 0013).
 *   F-17  P&L COGS / Opex matched by `account.type` (not code-prefix).
 *   F-18  Cash-flow classification uses `account.type`, not code prefix.
 *   F-19  AR / AP aging use `outstanding` (not gross `total`) and accept
 *         a `currency` filter.
 *   F-20  All rounding centralised via `round2` (matches customerLedger.cjs).
 *
 * For deployments where the v_* views are not yet present (e.g. legacy cloud
 * without migration 0013 applied), each method falls back to the legacy
 * in-JS calculation. Both paths are unit-tested.
 */

const repo = require('./supabaseRepository.cjs');

/* ── helpers ─────────────────────────────────────────────────────────────── */

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normStatus(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

const CLOSED_INVOICE_STATUSES = new Set(['draft', 'cancelled', 'voided']);
const CLOSED_PAYMENT_STATUSES = new Set(['cancelled', 'voided']);
const REVERSAL_REFERENCE_TYPE = 'reversal';

/* Best-effort read of a view; returns [] if the view is absent (pre-0013 cloud). */
async function safeViewAll(viewName, filters = {}) {
  try {
    const rows = await repo.getAll(viewName, filters);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    // View missing on a legacy cloud — return empty so the legacy path takes over.
    if (err && /does not exist|relation.*does not exist/i.test(String(err.message || err))) {
      return [];
    }
    throw err;
  }
}

/* ── P&L ─────────────────────────────────────────────────────────────────── */

class FinancialReportingService {
  /**
   * Profit & Loss for a period.
   *
   * Reads the v_profit_and_loss view when present; otherwise falls back to the
   * legacy in-JS computation. Both paths are auditable and agree on the same
   * sign convention:
   *   Revenue:   credit entries to revenue accounts     (+)
   *   COGS:      debit  entries to COGS accounts        (+ cost)
   *   Opex:      debit  entries to expense accounts     (+ cost)
   *   Credit notes: revenue rows whose source invoice has status='credit_note'
   *                contribute negative.
   */
  async getProfitAndLoss(startDate, endDate, currency = 'USD') {
    const cur = String(currency || 'USD').toUpperCase();

    // Path A: view-based (preferred).
    const viewRows = await safeViewAll('v_profit_and_loss');
    if (viewRows.length > 0) {
      const filtered = viewRows.filter((r) => {
        const d = String(r.day || '').slice(0, 10);
        if (d < String(startDate).slice(0, 10)) return false;
        if (d > String(endDate).slice(0, 10)) return false;
        if (cur !== 'ALL' && String(r.currency || 'USD').toUpperCase() !== cur) return false;
        return true;
      });

      let revenue = 0, cogs = 0, opex = 0;
      for (const r of filtered) {
        const t = normStatus(r.account_type);
        const sub = normStatus(r.account_subtype);
        if (t === 'revenue' || t === 'income') {
          revenue += toNum(r.credits) - toNum(r.debits);
        } else if (t === 'cogs' || t === 'cost_of_goods_sold' || sub === 'cogs') {
          cogs += toNum(r.debits) - toNum(r.credits);
        } else if (t === 'expense') {
          opex += toNum(r.debits) - toNum(r.credits);
        }
      }
      revenue = round2(revenue);
      cogs = round2(cogs);
      opex = round2(opex);
      const grossProfit = round2(revenue - cogs);
      const netProfit = round2(grossProfit - opex);
      return {
        period: { startDate, endDate },
        currency: cur,
        revenue,
        costOfGoodsSold: cogs,
        grossProfit,
        grossProfitMargin: revenue > 0 ? round2((grossProfit / revenue) * 100) : 0,
        operatingExpenses: opex,
        netProfit,
        netProfitMargin: revenue > 0 ? round2((netProfit / revenue) * 100) : 0,
        source: 'v_profit_and_loss',
      };
    }

    // Path B: legacy in-JS fallback (pre-0013 cloud).
    const invoices = await repo.getAll('invoices');
    const ledgerEntries = await repo.getAll('ledger_entries');
    const accounts = await repo.getAll('chart_of_accounts');
    const accountType = new Map(accounts.map((a) => [a.id, normStatus(a.type)]));

    // Revenue: invoices where status NOT IN {draft, cancelled, voided}.
    // Credit notes contribute negative.
    let revenue = 0;
    for (const inv of invoices) {
      const s = normStatus(inv.status);
      if (CLOSED_INVOICE_STATUSES.has(s)) continue;
      if (String(inv.currency || 'USD').toUpperCase() !== cur) continue;
      const d = String(inv.date || inv.created_at || '').slice(0, 10);
      if (d < String(startDate).slice(0, 10)) continue;
      if (d > String(endDate).slice(0, 10)) continue;
      const total = toNum(inv.total_amount);
      if (s === 'credit_note') revenue -= total;
      else revenue += total;
    }

    // COGS / Opex from ledger by account.type (NOT code prefix).
    let cogs = 0, opex = 0;
    for (const e of ledgerEntries) {
      if (normStatus(e.reference_type) === REVERSAL_REFERENCE_TYPE) continue;
      if (normStatus(e.entry_type) !== 'debit') continue;
      if (String(e.currency || 'USD').toUpperCase() !== cur) continue;
      const d = String(e.entry_date || '').slice(0, 10);
      if (d < String(startDate).slice(0, 10)) continue;
      if (d > String(endDate).slice(0, 10)) continue;
      const t = accountType.get(e.account_id) || '';
      const amount = toNum(e.amount);
      if (t === 'cogs' || t === 'cost_of_goods_sold') cogs += amount;
      else if (t === 'expense') opex += amount;
    }

    revenue = round2(revenue);
    cogs = round2(cogs);
    opex = round2(opex);
    const grossProfit = round2(revenue - cogs);
    const netProfit = round2(grossProfit - opex);
    return {
      period: { startDate, endDate },
      currency: cur,
      revenue,
      costOfGoodsSold: cogs,
      grossProfit,
      grossProfitMargin: revenue > 0 ? round2((grossProfit / revenue) * 100) : 0,
      operatingExpenses: opex,
      netProfit,
      netProfitMargin: revenue > 0 ? round2((netProfit / revenue) * 100) : 0,
      source: 'legacy_js',
    };
  }

  /* ── Balance Sheet ───────────────────────────────────────────────────── */

  async getBalanceSheet(asOfDate, currency = 'USD') {
    const cur = String(currency || 'USD').toUpperCase();
    const asOf = String(asOfDate || new Date().toISOString().slice(0, 10)).slice(0, 10);

    // Path A: view-based. The COA balance is now authoritatively kept fresh
    // by the trg_coa_recompute_balance trigger in migration 0013.
    const tbRows = await safeViewAll('v_trial_balance');
    if (tbRows.length > 0) {
      const accounts = await repo.getAll('chart_of_accounts');
      const accountCurrency = new Map(accounts.map((a) => [a.id, String(a.currency || a.data?.currency || 'USD').toUpperCase()]));

      const assets = [];
      const liabilities = [];
      const equity = [];
      for (const r of tbRows) {
        const c = accountCurrency.get(r.account_id) || 'USD';
        if (cur !== 'ALL' && c !== cur) continue;
        const t = normStatus(r.account_type);
        const bal = toNum(r.balance);
        const item = {
          id: r.account_id,
          code: r.account_code,
          name: r.account_name,
          type: t,
          balance: round2(bal),
        };
        if (t === 'asset') assets.push(item);
        else if (t === 'liability') liabilities.push(item);
        else if (t === 'equity') equity.push(item);
      }
      const totalAssets = round2(assets.reduce((s, a) => s + a.balance, 0));
      const totalLiabilities = round2(liabilities.reduce((s, a) => s + a.balance, 0));
      const totalEquity = round2(equity.reduce((s, a) => s + a.balance, 0));
      return {
        asOfDate: asOf,
        currency: cur,
        assets: { details: assets, total: totalAssets },
        liabilities: { details: liabilities, total: totalLiabilities },
        equity: { details: equity, total: totalEquity },
        balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
        source: 'v_trial_balance',
      };
    }

    // Path B: legacy fallback. Reads chart_of_accounts.data->>'balance'.
    const accounts = await repo.getAll('chart_of_accounts');
    const assets = accounts.filter((a) => normStatus(a.type) === 'asset' && a.is_active)
      .sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
    const liabilities = accounts.filter((a) => normStatus(a.type) === 'liability' && a.is_active)
      .sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
    const equity = accounts.filter((a) => normStatus(a.type) === 'equity' && a.is_active)
      .sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
    const totalAssets = round2(assets.reduce((s, a) => s + toNum(a.balance), 0));
    const totalLiabilities = round2(liabilities.reduce((s, a) => s + toNum(a.balance), 0));
    const totalEquity = round2(equity.reduce((s, a) => s + toNum(a.balance), 0));
    return {
      asOfDate: asOf,
      currency: cur,
      assets: { details: assets, total: totalAssets },
      liabilities: { details: liabilities, total: totalLiabilities },
      equity: { details: equity, total: totalEquity },
      balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
      source: 'legacy_js',
    };
  }

  /* ── Cash Flow ───────────────────────────────────────────────────────── */

  async getCashFlowStatement(startDate, endDate, currency = 'USD') {
    const cur = String(currency || 'USD').toUpperCase();

    const ledgerEntries = await repo.getAll('ledger_entries');
    const accounts = await repo.getAll('chart_of_accounts');
    const accountType = new Map(accounts.map((a) => [a.id, normStatus(a.type)]));

    const filteredEntries = ledgerEntries.filter((e) => {
      if (normStatus(e.reference_type) === REVERSAL_REFERENCE_TYPE) return false;
      if (cur !== 'ALL' && String(e.currency || 'USD').toUpperCase() !== cur) return false;
      const d = String(e.entry_date || '').slice(0, 10);
      if (d < String(startDate).slice(0, 10)) return false;
      if (d > String(endDate).slice(0, 10)) return false;
      return true;
    });

    // Classification by account.type (NOT code prefix).
    const operatingEntries = filteredEntries.filter((e) => {
      const t = accountType.get(e.account_id) || '';
      return ['asset', 'liability', 'revenue', 'expense', 'cogs', 'cost_of_goods_sold'].includes(t)
        && accountType.get(e.account_id) !== 'equity';
    });
    const investingEntries = filteredEntries.filter((e) => {
      const t = accountType.get(e.account_id) || '';
      return t === 'asset' && !['cash', 'bank', 'receivable', 'accounts_receivable'].includes(normStatus(e.account_subtype || e.account_name));
    });
    const financingEntries = filteredEntries.filter((e) => {
      const t = accountType.get(e.account_id) || '';
      return t === 'equity' || t === 'liability_longterm';
    });

    // Cash on cash side: for asset accounts (cash, bank), debit = inflow, credit = outflow.
    // For liability/equity: credit = inflow, debit = outflow.
    function signed(e) {
      const t = accountType.get(e.account_id) || '';
      const amount = toNum(e.amount);
      if (t === 'asset') {
        return normStatus(e.entry_type) === 'debit' ? amount : -amount;
      }
      return normStatus(e.entry_type) === 'credit' ? amount : -amount;
    }
    const operatingCashFlow = round2(operatingEntries.reduce((s, e) => s + signed(e), 0));
    const investingCashFlow = round2(investingEntries.reduce((s, e) => s + signed(e), 0));
    const financingCashFlow = round2(financingEntries.reduce((s, e) => s + signed(e), 0));
    const netCashFlow = round2(operatingCashFlow + investingCashFlow + financingCashFlow);

    return {
      period: { startDate, endDate },
      currency: cur,
      operatingActivities: { netCashFlow: operatingCashFlow, entries: operatingEntries },
      investingActivities: { netCashFlow: investingCashFlow, entries: investingEntries },
      financingActivities: { netCashFlow: financingCashFlow, entries: financingEntries },
      netCashFlow,
      source: 'account_type',
    };
  }

  /* ── AR Aging (uses view when present) ──────────────────────────────── */

  async getARAging(asOfDate, currency = 'USD') {
    const cur = String(currency || 'USD').toUpperCase();
    const viewRows = await safeViewAll('v_ar_aging');
    if (viewRows.length > 0) {
      return this._bucketAging(viewRows, asOfDate, cur, 'v_ar_aging');
    }

    // Legacy fallback: reads invoices with paid_amount-based outstanding.
    const invoices = await repo.getAll('invoices');
    const unpaid = invoices.filter((i) => {
      const s = normStatus(i.status);
      if (CLOSED_INVOICE_STATUSES.has(s)) return false;
      if (cur !== 'ALL' && String(i.currency || 'USD').toUpperCase() !== cur) return false;
      const total = toNum(i.total_amount);
      const paid = toNum(i.paid_amount);
      return paid < total;
    });
    const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
    const asOf = new Date(asOfDate || new Date().toISOString().slice(0, 10));
    for (const inv of unpaid) {
      const due = new Date(inv.due_date || inv.created_at || '');
      const days = Math.floor((asOf - due) / 86400000);
      const outstanding = toNum(inv.total_amount) - toNum(inv.paid_amount);
      if (days <= 0) buckets.current += outstanding;
      else if (days <= 30) buckets.days1to30 += outstanding;
      else if (days <= 60) buckets.days31to60 += outstanding;
      else if (days <= 90) buckets.days61to90 += outstanding;
      else buckets.over90 += outstanding;
    }
    return {
      asOfDate,
      currency: cur,
      buckets: {
        current: round2(buckets.current),
        days1to30: round2(buckets.days1to30),
        days31to60: round2(buckets.days31to60),
        days61to90: round2(buckets.days61to90),
        over90: round2(buckets.over90),
      },
      total: round2(Object.values(buckets).reduce((s, v) => s + v, 0)),
      source: 'legacy_js',
    };
  }

  /* ── AP Aging — now reads `purchases` (F-01) ─────────────────────────── */

  async getAPAging(asOfDate, currency = 'USD') {
    const cur = String(currency || 'USD').toUpperCase();
    const viewRows = await safeViewAll('v_ap_aging');
    if (viewRows.length > 0) {
      return this._bucketAging(viewRows, asOfDate, cur, 'v_ap_aging');
    }

    // Legacy fallback: reads PURCHASES (not invoices) — fixes F-01.
    const purchases = await repo.getAll('purchases');
    const open = purchases.filter((p) => {
      const s = normStatus(p.status);
      if (CLOSED_INVOICE_STATUSES.has(s)) return false;
      if (cur !== 'ALL' && String(p.currency || 'USD').toUpperCase() !== cur) return false;
      const total = toNum(p.totalAmount != null ? p.totalAmount : p.total_amount);
      const paid = toNum(p.paidAmount != null ? p.paidAmount : p.paid_amount);
      return paid < total;
    });
    const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
    const asOf = new Date(asOfDate || new Date().toISOString().slice(0, 10));
    for (const p of open) {
      const due = new Date(p.dueDate || p.due_date || p.date || p.created_at || '');
      const days = Math.floor((asOf - due) / 86400000);
      const total = toNum(p.totalAmount != null ? p.totalAmount : p.total_amount);
      const paid = toNum(p.paidAmount != null ? p.paidAmount : p.paid_amount);
      const outstanding = total - paid;
      if (days <= 0) buckets.current += outstanding;
      else if (days <= 30) buckets.days1to30 += outstanding;
      else if (days <= 60) buckets.days31to60 += outstanding;
      else if (days <= 90) buckets.days61to90 += outstanding;
      else buckets.over90 += outstanding;
    }
    return {
      asOfDate,
      currency: cur,
      buckets: {
        current: round2(buckets.current),
        days1to30: round2(buckets.days1to30),
        days31to60: round2(buckets.days31to60),
        days61to90: round2(buckets.days61to90),
        over90: round2(buckets.over90),
      },
      total: round2(Object.values(buckets).reduce((s, v) => s + v, 0)),
      source: 'legacy_js_purchases',
    };
  }

  _bucketAging(viewRows, asOfDate, cur, source) {
    const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, over90: 0 };
    for (const r of viewRows) {
      if (cur !== 'ALL' && String(r.currency || 'USD').toUpperCase() !== cur) continue;
      const b = String(r.aging_bucket || 'current');
      const outstanding = toNum(r.outstanding);
      if (b === 'current') buckets.current += outstanding;
      else if (b === 'days_1_30') buckets.days1to30 += outstanding;
      else if (b === 'days_31_60') buckets.days31to60 += outstanding;
      else if (b === 'days_61_90') buckets.days61to90 += outstanding;
      else if (b === 'over_90') buckets.over90 += outstanding;
    }
    return {
      asOfDate,
      currency: cur,
      buckets: {
        current: round2(buckets.current),
        days1to30: round2(buckets.days1to30),
        days31to60: round2(buckets.days31to60),
        days61to90: round2(buckets.days61to90),
        over90: round2(buckets.over90),
      },
      total: round2(Object.values(buckets).reduce((s, v) => s + v, 0)),
      source,
    };
  }

  /* ── Trial Balance — reversals filtered (F-07) ───────────────────────── */

  async getTrialBalance(asOfDate) {
    const viewBalance = await safeViewAll('v_trial_balance_balanced');
    if (viewBalance.length > 0) {
      const v = viewBalance[0] || {};
      return {
        asOfDate,
        totalDebits: round2(toNum(v.total_debits)),
        totalCredits: round2(toNum(v.total_credits)),
        difference: round2(toNum(v.difference)),
        balanced: Boolean(v.is_balanced),
        accounts: await safeViewAll('v_trial_balance'),
        source: 'v_trial_balance',
      };
    }

    // Legacy fallback.
    const accounts = await repo.getAll('chart_of_accounts');
    const entries = await repo.getAll('ledger_entries');
    const balances = new Map();
    for (const entry of entries) {
      if (normStatus(entry.reference_type) === REVERSAL_REFERENCE_TYPE) continue;
      const d = String(entry.entry_date || '').slice(0, 10);
      if (d > String(asOfDate || '').slice(0, 10)) continue;
      const existing = balances.get(entry.account_id) || { debit: 0, credit: 0 };
      if (normStatus(entry.entry_type) === 'debit') existing.debit += toNum(entry.amount);
      else existing.credit += toNum(entry.amount);
      balances.set(entry.account_id, existing);
    }
    const rows = accounts.map((a) => {
      const b = balances.get(a.id) || { debit: 0, credit: 0 };
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        debit: round2(b.debit),
        credit: round2(b.credit),
        balance: round2(b.debit - b.credit),
      };
    });
    const totalDebits = round2(rows.reduce((s, r) => s + r.debit, 0));
    const totalCredits = round2(rows.reduce((s, r) => s + r.credit, 0));
    return {
      asOfDate,
      totalDebits,
      totalCredits,
      difference: round2(totalDebits - totalCredits),
      balanced: Math.abs(totalDebits - totalCredits) < 0.01,
      accounts: rows,
      source: 'legacy_js',
    };
  }

  /* ── Budget vs Actual (unchanged behaviour, uses round2) ─────────────── */

  async getBudgetVsActual(fiscalYear, period) {
    const budgets = await repo.getAll('budgets', { 'data->>fiscal_year': `eq.${fiscalYear}` });
    const invoices = await repo.getAll('invoices');
    const expenses = await repo.getAll('expenses');
    const report = [];
    for (const budget of budgets) {
      const actual = round2(
        invoices
          .filter((i) => i.category === budget.category)
          .filter((i) => !CLOSED_INVOICE_STATUSES.has(normStatus(i.status)))
          .reduce((s, i) => s + toNum(i.total_amount), 0)
        + expenses
          .filter((e) => e.category === budget.category)
          .reduce((s, e) => s + toNum(e.amount), 0)
      );
      const budgeted = toNum(budget.budgeted_amount);
      report.push({
        category: budget.category,
        budgeted: round2(budgeted),
        actual,
        variance: round2(budgeted - actual),
        percentVariance: budgeted > 0 ? round2((actual / budgeted) * 100) : 0,
      });
    }
    return { fiscalYear, period, categories: report };
  }

  /* ── VAT report (unchanged shape) ────────────────────────────────────── */

  async getVATReport(period) {
    const vatService = new (require('./vatManagementService.cjs'))();
    const summary = await vatService.getVATSummary(period);
    const transactions = await vatService.getVATTransactions(period);
    return { period, summary, transactions };
  }

  /* ── Invoice integrity (F-12 verification helper) ───────────────────── */

  async getInvoiceIntegrityReport() {
    const viewRows = await safeViewAll('v_invoice_integrity');
    if (viewRows.length > 0) {
      const mismatches = viewRows.filter((r) => Math.abs(toNum(r.header_total) - toNum(r.sum_line_amounts)) > 0.01);
      return {
        totalInvoices: viewRows.length,
        mismatches: mismatches.length,
        mismatchSample: mismatches.slice(0, 25),
        source: 'v_invoice_integrity',
      };
    }
    return { totalInvoices: 0, mismatches: 0, mismatchSample: [], source: 'no_view' };
  }
}

module.exports = FinancialReportingService;
