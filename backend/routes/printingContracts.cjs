/**
 * POST /api/printing-contracts/* — Phase 2 §3.1 server-authoritative financial ops.
 * Admin-only ERP (single-company). Calls the atomic Supabase RPCs from 0048
 * with the service-role key; the RPCs enforce linkage/ownership/lifecycle/
 * price/wallet/idempotency/FY atomically with SELECT ... FOR UPDATE.
 * If the RPCs are not deployed, fails closed with 503 (callers fall back to
 * local pending queue and must NOT present local state as cloud-confirmed).
 */
const express = require('express');
const { requireRole } = require('../middleware/auth.cjs');

const router = express.Router();

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  // Lazy require so unit tests without supabase-js still load this route.
  // eslint-disable-next-line global-require
  const { createClient } = require('@supabase/supabase-js');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function callRpc(fn, args) {
  const admin = supabaseAdmin();
  if (!admin) {
    const err = new Error('Cloud database is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY).');
    err.status = 503;
    throw err;
  }
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    const msg = String(error.message || 'rpc failed');
    const err = new Error(msg);
    // Map closure/idempotency to actionable outcomes; nothing is half-written (RPC is atomic).
    err.adjustmentRequired = /CLOSED_PERIOD/i.test(msg);
    err.duplicate = /DUPLICATE/i.test(msg);
    err.insufficient = /INSUFFICIENT/i.test(msg);
    // The RPC re-checks the caller's role at the database boundary (defence in
    // depth behind this route's own requireRole gate). An UNAUTHORIZED refusal
    // from the database is an authorization failure, not a server fault.
    err.unauthorized = /UNAUTHORIZED/i.test(msg);
    err.status = err.unauthorized
      ? 403
      : (/CLOSED_PERIOD|DUPLICATE|INSUFFICIENT|entitlement|closed|not found|belongs|active only|reserved only|invalid price/i.test(msg) ? 409 : 500);
    throw err;
  }
  return data;
}

router.post('/reserve', requireRole('Admin', 'Accountant', 'Editor'), async (req, res) => {
  try {
    const { contractId, itemId, item, price, businessDate } = req.body || {};
    if (!contractId || !itemId) return res.status(400).json({ ok: false, error: 'contractId and itemId are required' });
    const data = await callRpc('reserve_contract_assessment_atomic', {
      p_contract_id: String(contractId),
      p_item_id: String(itemId),
      p_item_data: item || {},
      p_price: Number(price || (item && item.item_price) || 0),
      p_business_date: String(businessDate || new Date().toISOString().slice(0, 10)).slice(0, 10),
    });
    return res.json({ ok: true, accepted: true, result: data });
  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false, accepted: false,
      error: String(e.message || 'reserve failed').slice(0, 300),
      adjustmentRequired: Boolean(e.adjustmentRequired),
      duplicate: Boolean(e.duplicate),
      unauthorized: Boolean(e.unauthorized),
      retryable: false,
    });
  }
});

router.post('/consume', requireRole('Admin', 'Accountant', 'Editor'), async (req, res) => {
  try {
    const { contractId, itemId, idempotencyKey, businessDate } = req.body || {};
    if (!contractId || !itemId) return res.status(400).json({ ok: false, error: 'contractId and itemId are required' });
    const data = await callRpc('consume_contract_assessment_atomic', {
      p_contract_id: String(contractId),
      p_item_id: String(itemId),
      p_idempotency_key: idempotencyKey ? String(idempotencyKey) : null,
      p_business_date: String(businessDate || new Date().toISOString().slice(0, 10)).slice(0, 10),
    });
    return res.json({ ok: true, accepted: true, result: data });
  } catch (e) {
    return res.status(e.status || 500).json({
      ok: false, accepted: false,
      error: String(e.message || 'consume failed').slice(0, 300),
      adjustmentRequired: Boolean(e.adjustmentRequired),
      duplicate: Boolean(e.duplicate),
      unauthorized: Boolean(e.unauthorized),
      retryable: false,
    });
  }
});

router.get('/health', requireRole('Admin', 'Accountant', 'Editor', 'Viewer'), async (_req, res) => {
  const admin = supabaseAdmin();
  if (!admin) return res.status(503).json({ ok: false, rpcDeployed: false, error: 'cloud not configured' });
  try {
    // Probe: RPCs exist (wrong-arg call still proves the function is deployed).
    const { error } = await admin.rpc('reserve_contract_assessment_atomic', {
      p_contract_id: '', p_item_id: '', p_item_data: {}, p_price: -1,
    });
    const deployed = !error || !/function.*does not exist|Could not find/i.test(String(error.message || ''));
    return res.json({ ok: true, rpcDeployed: deployed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

module.exports = router;
