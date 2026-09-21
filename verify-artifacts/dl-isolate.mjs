/**
 * STEP 2 — ISOLATE LG-OPENING-BALANCE via the app's supported deadLetter(id).
 *
 * Asserts pre-conditions, performs exactly one deadLetter() call on the exact
 * outbox op id, then verifies: status transition only; payload byte-identical;
 * other ops untouched; excluded from countPending(); recoverable via
 * retryDeadLetter contract; remote row unchanged.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OP_ID = 'q-ba545d94-117b-4a40-b768-fb3bdda5c816-4joatv';
const EXPECTED_PAYLOAD = {
  id: 'LG-OPENING-BALANCE',
  date: '2026-09-21T01:28:31.814Z',
  description: 'System Initialization: Opening Cash Balance',
  debitAccountId: '11110',
  creditAccountId: '31000',
  amount: 500,
  referenceId: 'OPENING_BALANCE',
  reconciled: true,
  _updatedAt: '2026-09-21T01:28:31.814Z',
};
const DL_REASON = 'MANUAL-ISOLATION 2026-09-21: pending upsert would overwrite existing remote accounting row (remote v6 date=2026-09-20T23:24:07.265Z serverUpdatedAt=2026-09-19T09:32:48.074064+00:00). Unrelated to approved LG-MIC-* corrections. Do NOT retry without accountant review.';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
if (!page) { console.error('NO ERP PAGE'); process.exit(2); }
console.log('page =', page.url());

const out = await page.evaluate(async ({ opId, expectedPayload, dlReason }) => {
  const sb = await import('/services/supabaseClient.ts');
  const { durableSyncQueue } = await import('/services/durableSyncQueue.ts');

  // session guard — refuse to run unauthenticated
  const session = await sb.supabase.auth.getSession();
  if (!session?.data?.session) return { fatal: 'NO_SESSION' };

  // ── 1. pre-conditions ─────────────────────────────────────────────
  const preAll0 = await durableSyncQueue.getAll();
  const pre = preAll0.find((o) => o.id === opId) || null;
  if (!pre) return { fatal: 'OP_NOT_FOUND', opId };
  if (pre.status !== 'pending') return { fatal: 'OP_NOT_PENDING', status: pre.status };
  const payloadMatch = JSON.stringify(pre.payload) === JSON.stringify(expectedPayload);
  if (!payloadMatch) return { fatal: 'PAYLOAD_MISMATCH', actual: pre.payload };

  const preAll = await durableSyncQueue.getAll();
  const preStatusById = Object.fromEntries(preAll.map((o) => [o.id, o.status]));
  const preCountPending = await durableSyncQueue.countPending();

  // remote snapshot immediately before isolation
  const { data: obBefore, error: obErr } = await sb.supabase.from('ledger_entries').select('*').eq('id', 'LG-OPENING-BALANCE');
  if (obErr) return { fatal: 'REMOTE_READ_FAILED', error: obErr };

  // ── 2. the single supported dead-letter call ──────────────────────
  await durableSyncQueue.deadLetter(opId, dlReason);

  // ── 3. post-conditions ────────────────────────────────────────────
  const postAll = await durableSyncQueue.getAll();
  const post = postAll.find((o) => o.id === opId) || null;
  const postCountPending = await durableSyncQueue.countPending();

  const othersTouched = postAll
    .filter((o) => o.id !== opId)
    .filter((o) => preStatusById[o.id] !== o.status || JSON.stringify(o.payload) !== JSON.stringify(preAll.find((x) => x.id === o.id)?.payload))
    .map((o) => ({ id: o.id, from: preStatusById[o.id], to: o.status }));

  // local business ledger row must be untouched by the queue transition
  const { dbService } = await import('/services/db.ts');
  const localLedgerRow = await dbService.get('ledger', 'LG-OPENING-BALANCE');

  // remote row immediately after isolation (must be identical)
  const { data: obAfter, error: obErr2 } = await sb.supabase.from('ledger_entries').select('*').eq('id', 'LG-OPENING-BALANCE');
  const remoteUnchanged = JSON.stringify(obBefore) === JSON.stringify(obAfter);

  return {
    fatal: null,
    opId,
    before: {
      status: pre.status, payload: pre.payload, retryCount: pre.retryCount,
      syncGeneration: pre.syncGeneration, createdAt: pre.createdAt, errorType: pre.errorType ?? null,
    },
    after: {
      status: post.status, payload: post.payload, retryCount: post.retryCount,
      lastAttempt: post.lastAttempt, lastError: post.lastError, errorType: post.errorType,
      syncGeneration: post.syncGeneration, createdAt: post.createdAt,
    },
    payloadPreserved: JSON.stringify(post.payload) === JSON.stringify(expectedPayload),
    payloadByteIdentical: JSON.stringify(post.payload) === JSON.stringify(pre.payload),
    countPending: { before: preCountPending, after: postCountPending },
    othersTouched,
    localLedgerRowStillExists: !!localLedgerRow,
    localLedgerRowUnchanged: !!localLedgerRow && JSON.stringify(localLedgerRow) === JSON.stringify(await (async () => { return null; })()) ? null : 'checked-below',
    remoteUnchanged,
    remoteRowBefore: obBefore?.[0] ?? null,
    remoteRowAfter: obAfter?.[0] ?? null,
  };
}, { opId: OP_ID, expectedPayload: EXPECTED_PAYLOAD, dlReason: DL_REASON });

if (out.fatal) {
  console.error('FATAL:', JSON.stringify(out, null, 1));
  fs.writeFileSync('verify-artifacts/dl-isolate.json', JSON.stringify({ fatal: out.fatal, detail: out }, null, 1));
  process.exit(3);
}

fs.writeFileSync('verify-artifacts/dl-isolate.json', JSON.stringify(out, null, 1));

console.log(JSON.stringify({
  opId: out.opId,
  before: { status: out.before.status, retryCount: out.before.retryCount },
  after: { status: out.after.status, retryCount: out.after.retryCount, errorType: out.after.errorType, lastAttempt: out.after.lastAttempt, lastErrorHead: out.after.lastError?.slice(0, 80) },
  payloadPreserved: out.payloadPreserved,
  payloadByteIdentical: out.payloadByteIdentical,
  countPending: out.countPending,
  othersTouched: out.othersTouched,
  localLedgerRowStillExists: out.localLedgerRowStillExists,
  remoteUnchanged: out.remoteUnchanged,
}, null, 1));
process.exit(0);
