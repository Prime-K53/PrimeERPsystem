/**
 * recurringBillingScope.ts
 *
 * Account-scope decisions for RECURRING billing.
 *
 * A recurring subscription bills exactly ONE account on every run, so the
 * account is part of the subscription's identity:
 *
 *   * the generated invoice must carry the subscription's stable branch id, so
 *     a branch subscription can never be billed to (or appear under) Main;
 *   * two subscriptions of the same customer on the same day are DIFFERENT runs
 *     when they belong to different accounts — a parent run must not suppress a
 *     branch run (this is the isolation guarantee);
 *   * when the branch cannot be identified unambiguously, the run is REFUSED and
 *     skipped rather than guessed. Nothing is silently reclassified.
 *
 * Extracted from `SalesContext.runRecurringBilling` so the decision is
 * testable without mounting React.
 */

import {
  resolveAccountScope,
  validateAccountScope,
  scopeIdentity,
  type AccountScope,
} from './customerAccountScope';

type AnyRec = Record<string, any>;

export interface RecurringScopeResolution {
  /** false → the run must be skipped (nothing is written). */
  ok: boolean;
  /** Canonical scope of the subscription (always present, even for Main). */
  scope: AccountScope | null;
  /** Canonical key used to compare runs ('main' | 'id:<branchId>' | 'name:<slug>'). */
  scopeKey: string;
  /** Display label: 'Main' or the branch name. */
  subAccountName: string;
  /** STABLE branch id: '' for Main, otherwise the branch's id. */
  subAccountId: string;
  /** Machine-readable refusal reason. */
  reason?: string;
  /** Human-readable explanation (safe to log; never contains customer data). */
  message?: string;
}

const firstDefined = (...values: unknown[]) => values.find((v) => v !== undefined && v !== null);

/**
 * Resolve the account a recurring subscription bills.
 *
 * @param subscription the `recurringInvoices` row
 * @param customers    the customer list (used to prove branch ownership)
 */
export function resolveRecurringSubscriptionScope(
  subscription: AnyRec | null | undefined,
  customers: AnyRec[] | null | undefined,
): RecurringScopeResolution {
  const sub = subscription || {};
  const list = Array.isArray(customers) ? customers : [];
  const customerId = String(firstDefined(sub.customerId, sub.customer_id, sub.customerID) ?? '').trim();
  const customerName = String(firstDefined(sub.customerName, sub.customer_name) ?? '').trim();

  // Identify the customer by its STABLE id. Falling back to the display name is
  // only safe when no customer with that id exists at all; if a record with that
  // id exists we must use it (or refuse) — matching by name could pick another
  // customer's branch list.
  const byId = list.find((c) => String(c?.id ?? '') === customerId);
  const byName = !byId && customerName
    ? list.find((c) => String(c?.name ?? '').trim().toLowerCase() === customerName.toLowerCase())
    : null;
  const customer = byId || byName;
  const customerMatchesId = Boolean(customer) && String(customer?.id ?? '') === customerId;

  if (!customer || !customerMatchesId) {
    return {
      ok: false,
      scope: null,
      scopeKey: 'unresolved',
      subAccountName: '',
      subAccountId: '',
      reason: 'customer-not-identified',
      message:
        'The subscribed customer could not be identified by its stable customer id, so the recurring run was skipped.',
    };
  }

  const branchTag = firstDefined(sub.subAccountId, sub.sub_account_id, sub.subAccountName, sub.sub_account_name, sub.subAccount);
  const scope = resolveAccountScope(customerId, branchTag ?? null, customer as any);

  if (!scope.isMain) {
    const check = validateAccountScope(scope, customer as any);
    if (!check.ok || !scope.branchId) {
      return {
        ok: false,
        scope: null,
        scopeKey: scopeIdentity(scope),
        subAccountName: '',
        subAccountId: '',
        reason: check.reason || 'branch-not-identifiable',
        message:
          `The subscribed branch '${String(branchTag ?? '')}' cannot be identified for this customer ` +
          `(${check.reason || 'no stable branch id'}), so the recurring run was skipped instead of being billed to Main.`,
      };
    }
  }

  return {
    ok: true,
    scope,
    scopeKey: scopeIdentity(scope),
    subAccountName: scope.isMain ? 'Main' : scope.branchLabel,
    subAccountId: scope.isMain ? '' : (scope.branchId || ''),
  };
}

/**
 * Has a run for this subscription's ACCOUNT and period already been invoiced?
 *
 * Two branches of one customer — even two branches with an IDENTICAL display
 * name — are separate accounts and must each get their own invoice.
 */
export function hasRecurringRunForPeriod(
  existingInvoices: AnyRec[] | null | undefined,
  options: {
    subscription: AnyRec | null | undefined;
    customer: AnyRec | null | undefined;
    customerName: string;
    dateKey: string;
    /** Only invoices created by a recurring run are considered. */
    matchesRunId?: (invoice: AnyRec) => boolean;
  },
): boolean {
  const invoices = Array.isArray(existingInvoices) ? existingInvoices : [];
  const sub = options.subscription || {};
  const customerId = String(firstDefined(sub.customerId, sub.customer_id) ?? '').trim();
  const branchTag = firstDefined(sub.subAccountId, sub.sub_account_id, sub.subAccountName, sub.sub_account_name);
  const wantedKey = scopeIdentity(
    resolveAccountScope(customerId, branchTag ?? null, (options.customer || null) as any),
  );

  return invoices.some((invoice) => {
    if (!invoice) return false;
    if (String(invoice.customerName ?? '') !== options.customerName) return false;
    if (!String(invoice.date ?? '').startsWith(options.dateKey)) return false;
    if (options.matchesRunId && !options.matchesRunId(invoice)) return false;
    const invoiceBranch = firstDefined(invoice.subAccountId, invoice.sub_account_id, invoice.subAccountName, invoice.sub_account_name);
    const actualKey = scopeIdentity(
      resolveAccountScope(
        String(invoice.customerId || customerId || ''),
        invoiceBranch ?? null,
        (options.customer || null) as any,
      ),
    );
    return actualKey === wantedKey;
  });
}