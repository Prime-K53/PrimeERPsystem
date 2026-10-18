/**
 * accountScopeFilter.ts — account-scope filters for report/list screens.
 *
 * A screen that filters money by a branch DISPLAY NAME merges two identically
 * named branches into one figure. These helpers make the filter operate on the
 * canonical scope key instead ('main' | 'id:<branchId>' | 'name:<slug>'),
 * resolved against the customer's OWN branch list:
 *
 *   * `Main`            → untagged rows only.
 *   * a branch option   → rows tagged with that branch's stable id, plus legacy
 *                         name-only rows whose name is unambiguous for that
 *                         customer.
 *   * a legacy name-only row whose name is shared by several branches resolves to
 *     a `name:` key that matches NO branch option, so it is excluded from every
 *     branch figure instead of being credited to an arbitrary one.
 *
 * Presentation helper for the ERP UI; the authoritative ownership rule lives in
 * `customerAccountScope`.
 */
import { resolveAccountScope, scopeIdentity, subAccountEntries } from './customerAccountScope';

type AnyRec = Record<string, any>;

const branchTagOf = (row: AnyRec | null | undefined) => (
  row?.subAccountId
  ?? row?.sub_account_id
  ?? row?.subAccountName
  ?? row?.sub_account_name
  ?? null
);

/** Canonical scope key of a financial row's account. */
export function rowAccountScopeKey(
  row: AnyRec | null | undefined,
  customerId: string,
  customer?: AnyRec | null,
): string {
  return scopeIdentity(resolveAccountScope(String(row?.customerId || customerId || ''), branchTagOf(row), customer || null));
}

/** True when the row belongs to one of the selected accounts (no selection = all). */
export function rowMatchesScopeKeys(
  row: AnyRec | null | undefined,
  selectedKeys: readonly string[],
  customerId: string,
  customer?: AnyRec | null,
): boolean {
  if (!selectedKeys || selectedKeys.length === 0) return true;
  return selectedKeys.includes(rowAccountScopeKey(row, customerId, customer));
}

/**
 * The selectable accounts of a customer: Main plus every branch.
 * Each option carries its canonical key (the value the filter compares) and the
 * display label. Two branches sharing a display name get DISTINCT keys.
 */
export function accountScopeOptions(customerId: string, customer?: AnyRec | null): Array<{ key: string; label: string }> {
  const options: Array<{ key: string; label: string }> = [{
    key: scopeIdentity(resolveAccountScope(customerId, null, null)),
    label: 'Main',
  }];
  if (!customer) return options;
  for (const sub of subAccountEntries(customer)) {
    const name = String(sub.name ?? sub.label ?? '').trim();
    if (!name) continue;
    const id = String(sub.id ?? '').trim();
    options.push({
      key: scopeIdentity(resolveAccountScope(customerId, id || name, customer)),
      label: name,
    });
  }
  return options;
}