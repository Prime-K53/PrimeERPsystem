/**
 * customerAccountScope.ts — ONE centralized customer-account identity.
 *
 * A financial account scope is: parent customer ID + a normalized branch KEY.
 *
 *   'main'                → the parent (Main) account
 *   'id:<branchId>'       → a specific branch, keyed by its STABLE embedded id
 *   'name:<slug>'         → a LEGACY branch key derived from a display name
 *
 * Rules (mirrored byte-for-byte by backend/services/customerAccountScope.cjs):
 *   1. Display names are NEVER the primary identity. A branch is identified by
 *      its embedded id whenever one exists.
 *   2. Two branches with the same display name are different accounts and must
 *      never collide — a name-only (legacy) record that could belong to either
 *      fails safe and is flagged as ambiguous.
 *   3. A missing scope never means "all accounts". Account-sensitive call sites
 *      must pass an explicit scope; intentional whole-customer aggregation goes
 *      through a separately named API (see customerLedger's consolidated core).
 *   4. Every rule below is pure — no I/O — so the frontend and the backend can
 *      be proven equivalent by feeding both the same fixtures.
 */

export const MAIN_KEY = 'main';

export interface AccountScope {
  customerId: string;
  /** Canonical key: 'main' | 'id:<branchId>' | 'name:<slug>'. */
  branchKey: string;
  isMain: boolean;
  /** Display-only label (never used to match). */
  branchLabel: string;
  /** Stable embedded branch id when known, else null. */
  branchId: string | null;
  /**
   * True when the branch display name is shared by more than one branch of the
   * customer. A legacy name-only record can then never be attributed safely.
   */
  ambiguous?: boolean;
}

export interface ScopeValidation {
  ok: boolean;
  reason?: string;
  /** Present when ok === false because the name is not unique. */
  ambiguous?: boolean;
}

export interface ScopeDisposition {
  matches: boolean;
  ambiguous: boolean;
  reason?: string;
}

type AnyRecord = Record<string, any>;

// ── Normalization primitives ────────────────────────────────────────────────

export function slugBranchName(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isMainBranchValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const s = String(value).trim();
  if (s === '') return true;
  const low = s.toLowerCase();
  return low === 'main' || low === 'main account';
}

export function normalizeBranchKey(value: unknown): string {
  if (isMainBranchValue(value)) return MAIN_KEY;
  const slug = slugBranchName(value);
  return slug ? `name:${slug}` : MAIN_KEY;
}

export function branchKeyLabel(branchKey: string, fallback = 'Main'): string {
  if (!branchKey || branchKey === MAIN_KEY) return 'Main';
  if (branchKey.startsWith('name:')) {
    const slug = branchKey.slice(5);
    if (!slug) return 'Main';
    return slug.split('-').filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  return fallback;
}

function trimId(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return s === '' ? '' : s;
}

function firstDefined(...candidates: unknown[]): unknown {
  for (const c of candidates) {
    if (c !== null && c !== undefined) return c;
  }
  return null;
}

// ── Branch tables (from the parent customer record) ─────────────────────────

/**
 * Embedded branches of a customer. Accepts the modern object shape
 * (`[{ id, name, ... }]`) and the older bare-string shape (`['Exam Centre']`).
 */
export function subAccountEntries(customer: AnyRecord | null | undefined): AnyRecord[] {
  const raw =
    (customer as AnyRecord | null)?.subAccounts ??
    (customer as AnyRecord | null)?.sub_accounts ??
    ((customer as AnyRecord | null)?.data && typeof (customer as AnyRecord).data === 'object'
      ? (customer as AnyRecord).data.subAccounts
      : null);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => (typeof s === 'string' ? { id: null, name: s } : s))
    .filter((s): s is AnyRecord => Boolean(s) && typeof s === 'object');
}

function findSubById(customer: AnyRecord | null | undefined, branchId: unknown): AnyRecord | null {
  const id = trimId(branchId);
  if (!id) return null;
  return subAccountEntries(customer).find((s) => trimId(s.id) === id) || null;
}

function subsByNameSlug(customer: AnyRecord | null | undefined, slug: string): AnyRecord[] {
  if (!slug) return [];
  return subAccountEntries(customer).filter((s) => slugBranchName(s.name ?? s.label) === slug);
}

/**
 * Slugs that appear on more than one embedded branch of this customer.
 * Index-based membership so even two identical entries count as a collision.
 */
export function ambiguousNameSlugs(customer: AnyRecord | null | undefined): Set<string> {
  const groups = new Map<string, Set<number>>();
  subAccountEntries(customer).forEach((s, i) => {
    const slug = slugBranchName(s.name ?? s.label);
    if (!slug) return;
    if (!groups.has(slug)) groups.set(slug, new Set());
    groups.get(slug)!.add(i);
  });
  const out = new Set<string>();
  for (const [slug, idxs] of groups) {
    if (idxs.size > 1) out.add(slug);
  }
  return out;
}

// ── Record projection (identical on both sides) ─────────────────────────────

export interface ScopeRecordProjection {
  customerId: string;
  subAccountName: unknown;
  subAccountId: unknown;
}

/**
 * Canonical projection of any financial row (invoice / payment / order / sale)
 * onto the three fields that decide account identity. Both the frontend and
 * the backend MUST use this so `subAccountId` and `sub_account_id` are always
 * recognized — omitting the stable id silently merged branches.
 */
export function scopeRecord(record: AnyRecord | null | undefined): ScopeRecordProjection {
  const r = (record || {}) as AnyRecord;
  return {
    customerId: String(firstDefined(r.customerId, r.customer_id, r.customerID) ?? ''),
    subAccountName: firstDefined(r.subAccountName, r.sub_account_name, r.subAccount, r.sub_account),
    subAccountId: firstDefined(
      r.subAccountId,
      r.sub_account_id,
      r.subAccountID,
      r.branchId,
      r.branch_id,
    ),
  };
}

// ── Scope resolution ────────────────────────────────────────────────────────

function mainScope(customerId: string): AccountScope {
  return { customerId: customerId, branchKey: MAIN_KEY, isMain: true, branchLabel: 'Main', branchId: null };
}

function branchScopeFromSub(
  customerId: string,
  sub: AnyRecord,
  fallbackLabel: string,
  ambiguous: boolean,
): AccountScope {
  const id = trimId(sub.id);
  const label = String(sub.name ?? sub.label ?? fallbackLabel ?? 'Branch').trim() || 'Branch';
  if (id) {
    return { customerId, branchKey: `id:${id}`, isMain: false, branchLabel: label, branchId: id, ambiguous };
  }
  const slug = slugBranchName(label);
  return {
    customerId,
    branchKey: slug ? `name:${slug}` : MAIN_KEY,
    isMain: !slug,
    branchLabel: label || 'Branch',
    branchId: null,
    ambiguous,
  };
}

/**
 * Resolve a selected branch (passed as a stable id, a raw display name, or an
 * already-normalized `name:` key) into the canonical account scope.
 *
 * Pass the parent `customer` object whenever it is available: without it a
 * display name cannot be promoted to its stable id and same-named branches
 * cannot be detected as ambiguous.
 */
export function resolveAccountScope(
  customerId: string,
  branch?: unknown,
  customer?: AnyRecord | null,
): AccountScope {
  const cid = String(customerId ?? '').trim();
  if (branch === null || branch === undefined) return mainScope(cid);
  const raw = String(branch).trim();
  if (raw === '' || isMainBranchValue(raw)) return mainScope(cid);

  const ambiguousSlugs = ambiguousNameSlugs(customer);

  // Explicit legacy name key.
  if (raw.toLowerCase().startsWith('name:')) {
    const slug = slugBranchName(raw.slice(5));
    if (!slug) return mainScope(cid);
    if (customer) {
      const matches = subsByNameSlug(customer, slug);
      if (matches.length === 1) {
        return branchScopeFromSub(cid, matches[0], raw, ambiguousSlugs.has(slug));
      }
      if (matches.length > 1) {
        return {
          customerId: cid,
          branchKey: `name:${slug}`,
          isMain: false,
          branchLabel: branchKeyLabel(`name:${slug}`),
          branchId: null,
          ambiguous: true,
        };
      }
    }
    return {
      customerId: cid,
      branchKey: `name:${slug}`,
      isMain: false,
      branchLabel: branchKeyLabel(`name:${slug}`),
      branchId: null,
      ambiguous: false,
    };
  }

  // Stable embedded id (any format), or an id-looking value.
  if (customer) {
    const byId = findSubById(customer, raw);
    if (byId) {
      const slug = slugBranchName(byId.name ?? byId.label);
      return branchScopeFromSub(cid, byId, raw, Boolean(slug && ambiguousSlugs.has(slug)));
    }
  }
  if (/^SUB-/i.test(raw)) {
    return { customerId: cid, branchKey: `id:${raw}`, isMain: false, branchLabel: 'Branch', branchId: raw, ambiguous: false };
  }

  // A display name.
  if (customer) {
    const slug = slugBranchName(raw);
    const matches = subsByNameSlug(customer, slug);
    if (matches.length === 1) {
      return branchScopeFromSub(cid, matches[0], raw, ambiguousSlugs.has(slug));
    }
    if (matches.length > 1) {
      return {
        customerId: cid,
        branchKey: `name:${slug}`,
        isMain: false,
        branchLabel: raw,
        branchId: null,
        ambiguous: true,
      };
    }
  }
  const key = normalizeBranchKey(raw);
  return {
    customerId: cid,
    branchKey: key,
    isMain: key === MAIN_KEY,
    branchLabel: key === MAIN_KEY ? 'Main' : raw,
    branchId: null,
    ambiguous: false,
  };
}

export function mainAccountScope(customerId: string): AccountScope {
  return mainScope(String(customerId ?? '').trim());
}

/** Resolve the account scope a stored financial row belongs to. */
export function resolveRecordScope(record: AnyRecord, customer?: AnyRecord | null): AccountScope {
  const p = scopeRecord(record);
  const explicitId = trimId(p.subAccountId);
  const branch = explicitId || p.subAccountName;
  return resolveAccountScope(p.customerId, branch ?? null, customer ?? null);
}

/**
 * Validate that a resolved branch scope really belongs to the parent customer
 * and can be identified unambiguously.
 *
 * Without the customer object a branch cannot be validated, so it fails closed.
 */
export function validateAccountScope(scope: AccountScope | null | undefined, customer?: AnyRecord | null): ScopeValidation {
  if (!scope) return { ok: false, reason: 'missing-scope' };
  if (String(scope.customerId || '').trim() === '') return { ok: false, reason: 'missing-customer-id' };
  if (scope.isMain || scope.branchKey === MAIN_KEY) return { ok: true };
  if (!customer) return { ok: false, reason: 'customer-required-for-branch-validation' };

  const subs = subAccountEntries(customer);
  if (subs.length === 0) return { ok: false, reason: 'customer-has-no-branches' };

  const slug = scopeSlugOf(scope, customer);
  const nameShared = Boolean(slug && ambiguousNameSlugs(customer).has(slug));

  // A scope carrying a stable id is owned as soon as the id is found — the
  // branch is unambiguous even if its display name is shared with a sibling.
  if (scope.branchId && findSubById(customer, scope.branchId)) {
    return nameShared
      ? { ok: true, ambiguous: true, reason: `branch-name-shared-with-sibling:${slug}` }
      : { ok: true };
  }

  if (!slug) return { ok: false, reason: `unresolved-branch:${scope.branchLabel}` };
  const matches = subsByNameSlug(customer, slug);
  if (matches.length === 0) return { ok: false, reason: `branch-not-owned-by-customer:${scope.branchLabel}` };
  if (matches.length > 1) return { ok: false, reason: `ambiguous-branch-name:${slug}`, ambiguous: true };
  return { ok: true };
}

/** Slug of the branch the scope points at (name key, resolved id, or label). */
function scopeSlugOf(scope: AccountScope, customer?: AnyRecord | null): string {
  if (!scope || scope.isMain || scope.branchKey === MAIN_KEY) return '';
  if (String(scope.branchKey).startsWith('name:')) return slugBranchName(String(scope.branchKey).slice(5));
  if (scope.branchId && customer) {
    const sub = findSubById(customer, scope.branchId);
    if (sub) return slugBranchName(sub.name ?? sub.label);
  }
  return slugBranchName(scope.branchLabel);
}

// ── Record ↔ scope matching ─────────────────────────────────────────────────

/**
 * Every account key a record can be addressed by. A record tagged with a
 * stable branch id exposes BOTH its id key and (when a name is present) its
 * name key; an untagged legacy record exposes only 'main'.
 */
export function recordBranchKeys(record: AnyRecord): string[] {
  const p = scopeRecord(record);
  const keys: string[] = [];
  const id = trimId(p.subAccountId);
  if (id) keys.push(`id:${id}`);
  if (!isMainBranchValue(p.subAccountName)) {
    const slug = slugBranchName(p.subAccountName);
    if (slug) keys.push(`name:${slug}`);
  }
  return keys.length > 0 ? keys : [MAIN_KEY];
}

function evaluateRecordScope(
  record: AnyRecord,
  scope: AccountScope,
  customer?: AnyRecord | null,
): ScopeDisposition {
  const p = scopeRecord(record);
  if (String(p.customerId ?? '') !== String(scope?.customerId ?? '')) {
    return { matches: false, ambiguous: false, reason: 'customer-mismatch' };
  }

  if (!scope || scope.isMain || scope.branchKey === MAIN_KEY) {
    return recordBranchKeys(record).includes(MAIN_KEY)
      ? { matches: true, ambiguous: false }
      : { matches: false, ambiguous: false, reason: 'not-a-main-account-record' };
  }

  const recId = trimId(p.subAccountId);
  const scopeId = trimId(scope.branchId);

  // A record carrying a stable id is attributed strictly by that id.
  if (recId) {
    return recId === scopeId
      ? { matches: true, ambiguous: false }
      : { matches: false, ambiguous: false, reason: 'different-branch-id' };
  }
  // A record with no id can only be a legacy name-only row. It can never be
  // attributed to an id-keyed scope unless the branch name is unique.
  if (!scopeId && scope.branchKey.startsWith('id:')) {
    return { matches: false, ambiguous: false, reason: 'record-has-no-branch-id' };
  }

  const slug = scopeSlugOf(scope, customer);
  if (!slug || !recordBranchKeys(record).includes(`name:${slug}`)) {
    return { matches: false, ambiguous: false, reason: 'name-mismatch' };
  }
  if (customer && ambiguousNameSlugs(customer).has(slug)) {
    return { matches: false, ambiguous: true, reason: `legacy-record-ambiguous-name:${slug}` };
  }
  return { matches: true, ambiguous: false };
}

export function recordScopeDisposition(
  record: AnyRecord,
  scope: AccountScope,
  customer?: AnyRecord | null,
): ScopeDisposition {
  return evaluateRecordScope(record, scope, customer);
}

export function recordMatchesScope(record: AnyRecord, scope: AccountScope, customer?: AnyRecord | null): boolean {
  return evaluateRecordScope(record, scope, customer).matches;
}

export function filterRecordsByScope<T extends AnyRecord>(
  records: T[],
  scope: AccountScope,
  customer?: AnyRecord | null,
): T[] {
  if (!scope || String(scope.customerId || '').trim() === '') return [];
  return (records || []).filter((r) => recordMatchesScope(r, scope, customer));
}

/**
 * Rows that were rejected ONLY because their legacy name is shared by several
 * branches. They are surfaced (never silently assigned to a branch) so the
 * business can tag them with a stable branch id.
 */
export function collectAmbiguousScopeRecords(
  records: AnyRecord[],
  scope: AccountScope,
  customer?: AnyRecord | null,
): Array<{ id: string; customerId: string; reason: string }> {
  const out: Array<{ id: string; customerId: string; reason: string }> = [];
  if (!scope || scope.isMain || scope.branchKey === MAIN_KEY) return out;
  const slug = scopeSlugOf(scope, customer);
  if (!slug) return out;
  if (!(customer && ambiguousNameSlugs(customer).has(slug))) return out;
  const targetCid = String(scope.customerId ?? '');
  for (const r of records || []) {
    const p = scopeRecord(r);
    if (String(p.customerId ?? '') !== targetCid) continue;
    if (trimId(p.subAccountId)) continue; // id-tagged rows are attributable
    if (!recordBranchKeys(r).includes(`name:${slug}`)) continue;
    out.push({
      id: String(r?.id ?? ''),
      customerId: targetCid,
      reason: `legacy-record-ambiguous-name:${slug}`,
    });
  }
  return out;
}

export function scopeIdentity(scope: AccountScope): string {
  return `${String(scope.customerId || '').trim()}::${scope.branchKey || MAIN_KEY}`;
}

/** Two scopes address the same account (used by allocation safeguards). */
export function isSameAccountScope(a: AccountScope | null | undefined, b: AccountScope | null | undefined): boolean {
  if (!a || !b) return false;
  return scopeIdentity(a) === scopeIdentity(b);
}

// ── Authoritative allocation ownership rule ─────────────────────────────────

export interface AccountScopeViolation extends Error {
  code: string;
  paymentScope?: string;
  invoiceScope?: string;
  invoiceId?: string;
}

function scopeViolation(code: string, message: string, extra: Record<string, unknown> = {}): AccountScopeViolation {
  const err = new Error(message) as AccountScopeViolation;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * THE authoritative ownership rule for payment → invoice allocation.
 *
 * A payment may only settle an invoice of the SAME account: the same parent
 * customer AND the same account (Main, or the exact same branch id). Cross
 * customer, Main↔branch and branch↔sibling-branch are all refused. A shared
 * business name is never authorization.
 *
 * Throws an error carrying `.code`:
 *   ECROSS_ACCOUNT   — the two sides are different accounts
 *   EAMBIGUOUS_SCOPE — a side cannot be identified with certainty
 *   EINVALID_SCOPE   — a branch does not belong to the parent customer
 */
export function assertSameAccountOwnership(
  payment: AnyRecord | null | undefined,
  invoice: AnyRecord | null | undefined,
  customer?: AnyRecord | null,
): AccountScope {
  const payScope = resolveRecordScope(payment || {}, customer ?? null);
  const invScope = resolveRecordScope(invoice || {}, customer ?? null);
  const invoiceId = String((invoice as AnyRecord | null)?.id ?? '');

  if (!String(payScope.customerId || '').trim()) {
    throw scopeViolation('EAMBIGUOUS_SCOPE', 'Cannot allocate: the payment has no resolvable customer account scope.');
  }
  if (!String(invScope.customerId || '').trim()) {
    throw scopeViolation('EAMBIGUOUS_SCOPE', `Cannot allocate: invoice ${invoiceId} has no resolvable customer account scope.`, { invoiceId });
  }

  // Cross-customer is always refused, even when the business names match.
  if (String(invScope.customerId) !== String(payScope.customerId)) {
    throw scopeViolation(
      'ECROSS_ACCOUNT',
      `Cross-account allocation blocked: payment is ${scopeIdentity(payScope)} but invoice ${invoiceId} is ` +
      `${scopeIdentity(invScope)}. A shared business name is not authorization.`,
      { invoiceId, paymentScope: scopeIdentity(payScope), invoiceScope: scopeIdentity(invScope) },
    );
  }

  // Main vs branch, and branch vs sibling branch.
  if (!isSameAccountScope(invScope, payScope)) {
    throw scopeViolation(
      'ECROSS_ACCOUNT',
      `Cross-account allocation blocked: payment is ${scopeIdentity(payScope)} but invoice ${invoiceId} is ` +
      `${scopeIdentity(invScope)}. A shared business name is not authorization.`,
      { invoiceId, paymentScope: scopeIdentity(payScope), invoiceScope: scopeIdentity(invScope) },
    );
  }

  // A name-only scope shared by several same-named branches is not an identity.
  if (!payScope.isMain && !payScope.branchId && payScope.ambiguous) {
    throw scopeViolation(
      'EAMBIGUOUS_SCOPE',
      `Cannot allocate: the payment branch name '${payScope.branchLabel}' is shared by several branches. ` +
      `Tag the payment with its embedded branch id.`,
      { paymentScope: scopeIdentity(payScope) },
    );
  }
  if (!invScope.isMain && !invScope.branchId && invScope.ambiguous) {
    throw scopeViolation(
      'EAMBIGUOUS_SCOPE',
      `Cannot allocate: invoice ${invoiceId} branch name '${invScope.branchLabel}' is shared by several branches. ` +
      `Tag the invoice with its embedded branch id.`,
      { invoiceId, invoiceScope: scopeIdentity(invScope) },
    );
  }

  // Confirm the branch really belongs to the parent customer.
  if (customer) {
    for (const [label, scope] of [['payment', payScope], ['invoice', invScope]] as const) {
      const v = validateAccountScope(scope, customer);
      if (!v.ok) {
        throw scopeViolation(
          v.ambiguous ? 'EAMBIGUOUS_SCOPE' : 'EINVALID_SCOPE',
          `Cannot allocate: ${label} account scope is invalid (${v.reason}).`,
          label === 'invoice' ? { invoiceId, invoiceScope: scopeIdentity(scope) } : { paymentScope: scopeIdentity(scope) },
        );
      }
    }
    return payScope;
  }

  // No customer record to confirm ownership: an id-keyed (or Main) scope is
  // still a stable identity; a name-keyed branch scope is not.
  for (const [label, scope] of [['payment', payScope], ['invoice', invScope]] as const) {
    if (!scope.isMain && !scope.branchId) {
      throw scopeViolation(
        'EAMBIGUOUS_SCOPE',
        `Cannot allocate: ${label} branch '${scope.branchLabel}' is identified by display name only and ` +
        `no parent customer record was supplied to confirm it.`,
        label === 'invoice' ? { invoiceId, invoiceScope: scopeIdentity(scope) } : { paymentScope: scopeIdentity(scope) },
      );
    }
  }
  return payScope;
}
