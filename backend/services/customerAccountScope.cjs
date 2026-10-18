/**
 * customerAccountScope.cjs — backend mirror of frontend/services/customerAccountScope.ts
 *
 * MUST stay behaviourally identical to the frontend port. See the frontend file
 * for the full rationale; the tests assert parity with shared fixtures.
 */
const MAIN_KEY = 'main';

function slugBranchName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isMainBranchValue(value) {
  if (value === null || value === undefined) return true;
  const s = String(value).trim();
  if (s === '') return true;
  const low = s.toLowerCase();
  return low === 'main' || low === 'main account';
}

function normalizeBranchKey(value) {
  if (isMainBranchValue(value)) return MAIN_KEY;
  const slug = slugBranchName(value);
  return slug ? `name:${slug}` : MAIN_KEY;
}

function branchKeyLabel(branchKey, fallback) {
  if (!branchKey || branchKey === MAIN_KEY) return 'Main';
  if (String(branchKey).startsWith('name:')) {
    const slug = String(branchKey).slice(5);
    if (!slug) return 'Main';
    return slug.split('-').filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  return fallback || 'Main';
}

function trimId(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return s === '' ? '' : s;
}

function firstDefined(...candidates) {
  for (const c of candidates) {
    if (c !== null && c !== undefined) return c;
  }
  return null;
}

function subAccountEntries(customer) {
  if (!customer || typeof customer !== 'object') return [];
  let raw = customer.subAccounts ?? customer.sub_accounts ?? null;
  if (!Array.isArray(raw)) {
    const d = customer.data && typeof customer.data === 'object' ? customer.data : null;
    raw = d ? (d.subAccounts ?? d.sub_accounts ?? null) : null;
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => (typeof s === 'string' ? { id: null, name: s } : s))
    .filter((s) => Boolean(s) && typeof s === 'object');
}

function findSubById(customer, branchId) {
  const id = trimId(branchId);
  if (!id) return null;
  return subAccountEntries(customer).find((s) => trimId(s.id) === id) || null;
}

function subsByNameSlug(customer, slug) {
  if (!slug) return [];
  return subAccountEntries(customer).filter((s) => slugBranchName(s.name ?? s.label) === slug);
}

function ambiguousNameSlugs(customer) {
  const groups = new Map();
  subAccountEntries(customer).forEach((s, i) => {
    const slug = slugBranchName(s.name ?? s.label);
    if (!slug) return;
    if (!groups.has(slug)) groups.set(slug, new Set());
    groups.get(slug).add(i);
  });
  const out = new Set();
  for (const [slug, idxs] of groups) {
    if (idxs.size > 1) out.add(slug);
  }
  return out;
}

/**
 * Canonical projection of a financial row onto the three identity fields.
 * `subAccountId` / `sub_account_id` MUST be recognized here — omitting them
 * silently merged same-named branches on the backend.
 */
function scopeRecord(record) {
  const r = record && typeof record === 'object' ? record : {};
  return {
    customerId: String(firstDefined(r.customerId, r.customer_id, r.customerID) ?? ''),
    subAccountName: firstDefined(r.subAccountName, r.sub_account_name, r.subAccount, r.sub_account),
    subAccountId: firstDefined(r.subAccountId, r.sub_account_id, r.subAccountID, r.branchId, r.branch_id),
  };
}

function mainScope(customerId) {
  return { customerId, branchKey: MAIN_KEY, isMain: true, branchLabel: 'Main', branchId: null };
}

function branchScopeFromSub(customerId, sub, fallbackLabel, ambiguous) {
  const id = trimId(sub.id);
  const label = String(sub.name ?? sub.label ?? fallbackLabel ?? 'Branch').trim() || 'Branch';
  if (id) {
    return { customerId, branchKey: `id:${id}`, isMain: false, branchLabel: label, branchId: id, ambiguous: Boolean(ambiguous) };
  }
  const slug = slugBranchName(label);
  return {
    customerId,
    branchKey: slug ? `name:${slug}` : MAIN_KEY,
    isMain: !slug,
    branchLabel: label || 'Branch',
    branchId: null,
    ambiguous: Boolean(ambiguous),
  };
}

function resolveAccountScope(customerId, branch, customer) {
  const cid = String(customerId ?? '').trim();
  if (branch === null || branch === undefined) return mainScope(cid);
  const raw = String(branch).trim();
  if (raw === '' || isMainBranchValue(raw)) return mainScope(cid);

  const ambiguousSlugs = ambiguousNameSlugs(customer);

  if (raw.toLowerCase().startsWith('name:')) {
    const slug = slugBranchName(raw.slice(5));
    if (!slug) return mainScope(cid);
    if (customer) {
      const matches = subsByNameSlug(customer, slug);
      if (matches.length === 1) return branchScopeFromSub(cid, matches[0], raw, ambiguousSlugs.has(slug));
      if (matches.length > 1) {
        return { customerId: cid, branchKey: `name:${slug}`, isMain: false,
          branchLabel: branchKeyLabel(`name:${slug}`), branchId: null, ambiguous: true };
      }
    }
    return { customerId: cid, branchKey: `name:${slug}`, isMain: false,
      branchLabel: branchKeyLabel(`name:${slug}`), branchId: null, ambiguous: false };
  }

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

  if (customer) {
    const slug = slugBranchName(raw);
    const matches = subsByNameSlug(customer, slug);
    if (matches.length === 1) return branchScopeFromSub(cid, matches[0], raw, ambiguousSlugs.has(slug));
    if (matches.length > 1) {
      return { customerId: cid, branchKey: `name:${slug}`, isMain: false,
        branchLabel: raw, branchId: null, ambiguous: true };
    }
  }
  const key = normalizeBranchKey(raw);
  return { customerId: cid, branchKey: key, isMain: key === MAIN_KEY,
    branchLabel: key === MAIN_KEY ? 'Main' : raw, branchId: null, ambiguous: false };
}

function mainAccountScope(customerId) {
  return mainScope(String(customerId ?? '').trim());
}

function resolveRecordScope(record, customer) {
  const p = scopeRecord(record);
  const explicitId = trimId(p.subAccountId);
  const branch = explicitId || p.subAccountName;
  return resolveAccountScope(p.customerId, branch === undefined ? null : branch, customer || null);
}

function scopeSlugOf(scope, customer) {
  if (!scope || scope.isMain || scope.branchKey === MAIN_KEY) return '';
  if (String(scope.branchKey).startsWith('name:')) return slugBranchName(String(scope.branchKey).slice(5));
  if (scope.branchId && customer) {
    const sub = findSubById(customer, scope.branchId);
    if (sub) return slugBranchName(sub.name ?? sub.label);
  }
  return slugBranchName(scope.branchLabel);
}

function validateAccountScope(scope, customer) {
  if (!scope) return { ok: false, reason: 'missing-scope' };
  if (String(scope.customerId || '').trim() === '') return { ok: false, reason: 'missing-customer-id' };
  if (scope.isMain || scope.branchKey === MAIN_KEY) return { ok: true };
  if (!customer) return { ok: false, reason: 'customer-required-for-branch-validation' };

  const subs = subAccountEntries(customer);
  if (subs.length === 0) return { ok: false, reason: 'customer-has-no-branches' };

  const slug = scopeSlugOf(scope, customer);
  const nameShared = Boolean(slug && ambiguousNameSlugs(customer).has(slug));

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

function recordBranchKeys(record) {
  const p = scopeRecord(record);
  const keys = [];
  const id = trimId(p.subAccountId);
  if (id) keys.push(`id:${id}`);
  if (!isMainBranchValue(p.subAccountName)) {
    const slug = slugBranchName(p.subAccountName);
    if (slug) keys.push(`name:${slug}`);
  }
  return keys.length > 0 ? keys : [MAIN_KEY];
}

function evaluateRecordScope(record, scope, customer) {
  const p = scopeRecord(record);
  if (String(p.customerId ?? '') !== String(scope && scope.customerId != null ? scope.customerId : '')) {
    return { matches: false, ambiguous: false, reason: 'customer-mismatch' };
  }

  if (!scope || scope.isMain || scope.branchKey === MAIN_KEY) {
    return recordBranchKeys(record).includes(MAIN_KEY)
      ? { matches: true, ambiguous: false }
      : { matches: false, ambiguous: false, reason: 'not-a-main-account-record' };
  }

  const recId = trimId(p.subAccountId);
  const scopeId = trimId(scope.branchId);

  if (recId) {
    return recId === scopeId
      ? { matches: true, ambiguous: false }
      : { matches: false, ambiguous: false, reason: 'different-branch-id' };
  }
  if (!scopeId && String(scope.branchKey).startsWith('id:')) {
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

function recordScopeDisposition(record, scope, customer) {
  return evaluateRecordScope(record, scope, customer);
}

function recordMatchesScope(record, scope, customer) {
  return evaluateRecordScope(record, scope, customer).matches;
}

function filterRecordsByScope(records, scope, customer) {
  if (!scope || String(scope.customerId || '').trim() === '') return [];
  return (records || []).filter((r) => recordMatchesScope(r, scope, customer));
}

function collectAmbiguousScopeRecords(records, scope, customer) {
  const out = [];
  if (!scope || scope.isMain || scope.branchKey === MAIN_KEY) return out;
  const slug = scopeSlugOf(scope, customer);
  if (!slug) return out;
  if (!(customer && ambiguousNameSlugs(customer).has(slug))) return out;
  const targetCid = String(scope.customerId ?? '');
  for (const r of records || []) {
    const p = scopeRecord(r);
    if (String(p.customerId ?? '') !== targetCid) continue;
    if (trimId(p.subAccountId)) continue;
    if (!recordBranchKeys(r).includes(`name:${slug}`)) continue;
    out.push({ id: String(r && r.id != null ? r.id : ''), customerId: targetCid, reason: `legacy-record-ambiguous-name:${slug}` });
  }
  return out;
}

function scopeIdentity(scope) {
  return `${String(scope.customerId || '').trim()}::${scope.branchKey || MAIN_KEY}`;
}

function isSameAccountScope(a, b) {
  if (!a || !b) return false;
  return scopeIdentity(a) === scopeIdentity(b);
}

/** Error carrying a stable `.code` for allocation scope violations. */
function scopeViolation(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra && typeof extra === 'object') Object.assign(err, extra);
  return err;
}

/**
 * THE authoritative ownership rule for payment -> invoice allocation.
 * Mirrors the frontend `assertSameAccountOwnership` exactly.
 */
function assertSameAccountOwnership(payment, invoice, customer) {
  const payScope = resolveRecordScope(payment || {}, customer || null);
  const invScope = resolveRecordScope(invoice || {}, customer || null);
  const invoiceId = String(invoice && invoice.id != null ? invoice.id : '');

  if (!String(payScope.customerId || '').trim()) {
    throw scopeViolation('EAMBIGUOUS_SCOPE', 'Cannot allocate: the payment has no resolvable customer account scope.');
  }
  if (!String(invScope.customerId || '').trim()) {
    throw scopeViolation('EAMBIGUOUS_SCOPE', `Cannot allocate: invoice ${invoiceId} has no resolvable customer account scope.`, { invoiceId });
  }
  if (String(invScope.customerId) !== String(payScope.customerId)) {
    throw scopeViolation('ECROSS_ACCOUNT',
      `Cross-account allocation blocked: payment is ${scopeIdentity(payScope)} but invoice ${invoiceId} is ` +
      `${scopeIdentity(invScope)}. A shared business name is not authorization.`,
      { invoiceId, paymentScope: scopeIdentity(payScope), invoiceScope: scopeIdentity(invScope) });
  }
  if (!isSameAccountScope(invScope, payScope)) {
    throw scopeViolation('ECROSS_ACCOUNT',
      `Cross-account allocation blocked: payment is ${scopeIdentity(payScope)} but invoice ${invoiceId} is ` +
      `${scopeIdentity(invScope)}. A shared business name is not authorization.`,
      { invoiceId, paymentScope: scopeIdentity(payScope), invoiceScope: scopeIdentity(invScope) });
  }
  if (!payScope.isMain && !payScope.branchId && payScope.ambiguous) {
    throw scopeViolation('EAMBIGUOUS_SCOPE',
      `Cannot allocate: the payment branch name '${payScope.branchLabel}' is shared by several branches. ` +
      `Tag the payment with its embedded branch id.`,
      { paymentScope: scopeIdentity(payScope) });
  }
  if (!invScope.isMain && !invScope.branchId && invScope.ambiguous) {
    throw scopeViolation('EAMBIGUOUS_SCOPE',
      `Cannot allocate: invoice ${invoiceId} branch name '${invScope.branchLabel}' is shared by several branches. ` +
      `Tag the invoice with its embedded branch id.`,
      { invoiceId, invoiceScope: scopeIdentity(invScope) });
  }
  if (customer) {
    for (const pair of [['payment', payScope], ['invoice', invScope]]) {
      const label = pair[0];
      const scope = pair[1];
      const v = validateAccountScope(scope, customer);
      if (!v.ok) {
        throw scopeViolation(v.ambiguous ? 'EAMBIGUOUS_SCOPE' : 'EINVALID_SCOPE',
          `Cannot allocate: ${label} account scope is invalid (${v.reason}).`,
          label === 'invoice' ? { invoiceId, invoiceScope: scopeIdentity(scope) } : { paymentScope: scopeIdentity(scope) });
      }
    }
    return payScope;
  }
  for (const pair of [['payment', payScope], ['invoice', invScope]]) {
    const label = pair[0];
    const scope = pair[1];
    if (!scope.isMain && !scope.branchId) {
      throw scopeViolation('EAMBIGUOUS_SCOPE',
        `Cannot allocate: ${label} branch '${scope.branchLabel}' is identified by display name only and ` +
        `no parent customer record was supplied to confirm it.`,
        label === 'invoice' ? { invoiceId, invoiceScope: scopeIdentity(scope) } : { paymentScope: scopeIdentity(scope) });
    }
  }
  return payScope;
}

module.exports = {
  MAIN_KEY,
  isMainBranchValue,
  normalizeBranchKey,
  branchKeyLabel,
  slugBranchName,
  subAccountEntries,
  ambiguousNameSlugs,
  scopeRecord,
  resolveAccountScope,
  resolveRecordScope,
  mainAccountScope,
  validateAccountScope,
  recordBranchKeys,
  recordScopeDisposition,
  recordMatchesScope,
  filterRecordsByScope,
  collectAmbiguousScopeRecords,
  scopeIdentity,
  isSameAccountScope,
  assertSameAccountOwnership,
};
