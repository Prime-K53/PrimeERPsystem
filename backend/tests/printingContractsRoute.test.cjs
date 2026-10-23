/**
 * printingContractsRoute.test.cjs
 *
 * HTTP-boundary contract for the printing-contract assessment RPCs.
 *
 * This is the half of the authorization story that CAN be executed without a
 * live database: who may reach the RPC at all, what the route forwards to
 * the database, and how the server's machine-readable failure markers are
 * mapped onto HTTP responses.
 *
 * The database-side guarantees (row locks, idempotency replay, transaction
 * rollback, ledger/wallet reconciliation) are proven by
 * printingContractsConcurrency.integration.test.cjs, which needs a disposable
 * PostgreSQL and skips cleanly without one.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
// The route only talks to the cloud when BOTH are present.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test-secret-key';

const mockRpc = jest.fn();

jest.mock(
  '@supabase/supabase-js',
  () => ({
    createClient: () => ({ rpc: (...args) => mockRpc(...args) }),
  }),
  { virtual: true },
);

const express = require('express');
const request = require('supertest');
const { generateToken, verifyToken } = require('../middleware/auth.cjs');
const printingContractsRouter = require('../routes/printingContracts.cjs');

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/printing-contracts', verifyToken, printingContractsRouter);
  return app;
};

const adminToken = () => generateToken({ id: 'u-admin', username: 'admin@prime', role: 'Admin' });
const portalToken = () => generateToken({ id: 'u-portal', username: 'cust@school', role: 'portal_customer' });

const ok = (data) => ({ data, error: null });
const rpcError = (message) => ({ data: null, error: { message } });

describe('printing-contracts route — authorization', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue(ok({ success: true, walletTransactionId: 'WTX-A-1-CONSUMED' }));
  });

  it('refuses an unauthenticated caller before any database call', async () => {
    const res = await request(buildApp()).post('/api/printing-contracts/consume').send({ contractId: 'K-1', itemId: 'A-1' });
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('refuses a portal customer (the only other valid identity) before any database call', async () => {
    const res = await request(buildApp())
      .post('/api/printing-contracts/consume')
      .set('Authorization', `Bearer ${portalToken()}`)
      .send({ contractId: 'K-1', itemId: 'A-1' });
    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('lets the authorized application user reach the RPC', async () => {
    const res = await request(buildApp())
      .post('/api/printing-contracts/consume')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ contractId: 'K-1', itemId: 'A-1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.accepted).toBe(true);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('never forwards a caller-supplied customer, user or role to the database', async () => {
    await request(buildApp())
      .post('/api/printing-contracts/consume')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        contractId: 'K-1',
        itemId: 'A-1',
        // A hostile body must not be able to name another customer.
        customerId: 'CUST-OTHER',
        customer_id: 'CUST-OTHER',
        userId: 'u-other',
        role: 'Admin',
      });
    const [, args] = mockRpc.mock.calls[0];
    expect(Object.keys(args).sort()).toEqual(['p_business_date', 'p_contract_id', 'p_idempotency_key', 'p_item_id']);
    expect(JSON.stringify(args)).not.toMatch(/CUST-OTHER/);
  });

  it('forwards the business date unchanged (no sync-timestamp substitution)', async () => {
    await request(buildApp())
      .post('/api/printing-contracts/consume')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ contractId: 'K-1', itemId: 'A-1', businessDate: '2026-03-15' });
    const [, args] = mockRpc.mock.calls[0];
    expect(args.p_business_date).toBe('2026-03-15');
  });

  it('does not call the database when the identifiers are missing', async () => {
    const res = await request(buildApp())
      .post('/api/printing-contracts/consume')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ itemId: 'A-1' });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('printing-contracts route — server failure markers stay machine-classifiable', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  const consume = (body = { contractId: 'K-1', itemId: 'A-1' }) =>
    request(buildApp())
      .post('/api/printing-contracts/consume')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(body);

  it('DUPLICATE is reported as a duplicate (not a generic failure)', async () => {
    mockRpc.mockResolvedValue(rpcError('DUPLICATE: assessment A-1 already has consumption transaction WTX-A-1-CONSUMED. Nothing written.'));
    const res = await consume();
    expect(res.status).toBe(409);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.adjustmentRequired).toBe(false);
  });

  it('CLOSED_PERIOD is reported as an adjustment, not a duplicate', async () => {
    mockRpc.mockResolvedValue(rpcError('CLOSED_PERIOD: business date 2025-06-15 falls in a closed financial year. Nothing written.'));
    const res = await consume();
    expect(res.status).toBe(409);
    expect(res.body.adjustmentRequired).toBe(true);
    expect(res.body.duplicate).toBe(false);
  });

  it('INSUFFICIENT_WALLET_FUNDS is refused', async () => {
    mockRpc.mockResolvedValue(rpcError('INSUFFICIENT_WALLET_FUNDS: wallet balance 100.00 is below the assessment price 1000.00. Nothing written.'));
    const res = await consume();
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/INSUFFICIENT_WALLET_FUNDS/);
  });

  it('the entitlement, lifecycle, linkage and price markers are refused', async () => {
    for (const message of [
      'entitlement exceeded: contract K-1 allows 1 assessments (1 already scheduled). Nothing written.',
      'contract K-1 is not active (status: suspended) — assessment consumption requires an active contract (active only). Nothing written.',
      'assessment A-1 is consumed — only reserved assessments can be consumed (reserved only). Nothing written.',
      'assessment A-1 does not belong to contract K-1 (it belongs to K-2). Nothing written.',
      'assessment A-1 has an invalid price. Nothing written.',
    ]) {
      mockRpc.mockResolvedValue(rpcError(message));
      // eslint-disable-next-line no-await-in-loop
      const res = await consume();
      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe(message.slice(0, 300));
    }
  });

  it('a database-side UNAUTHORIZED refusal is a 403, not a server fault', async () => {
    // The RPC re-checks the caller role at the database boundary. A refusal
    // there is an authorization failure and must not be reported as a 500.
    mockRpc.mockResolvedValue(
      rpcError('UNAUTHORIZED: role authenticated may not execute the printing-contract assessment RPCs. Nothing written.'),
    );
    const res = await consume();
    expect(res.status).toBe(403);
    expect(res.body.unauthorized).toBe(true);
    expect(res.body.ok).toBe(false);
  });

  it('an unknown server error is a 500, never a silent success', async () => {
    mockRpc.mockResolvedValue(rpcError('connection terminated unexpectedly'));
    const res = await consume();
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.accepted).toBe(false);
  });
});

describe('printing-contracts route — the replay contract', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('a replayed operation is returned as accepted with the ORIGINAL result', async () => {
    // The server returns the original result of an already-performed
    // operation (with replayed: true). The client maps a successful body to
    // "accepted", so a retry must not look like a failure.
    mockRpc.mockResolvedValue(
      ok({
        success: true,
        replayed: true,
        walletTransactionId: 'WTX-A-1-CONSUMED',
        ledgerEntryId: 'LG-WTX-A-1-CONSUMED',
        newBalance: 900000,
        contractId: 'K-1',
        assessmentItemId: 'A-1',
        amount: 100000,
      }),
    );
    const res = await request(buildApp())
      .post('/api/printing-contracts/consume')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ contractId: 'K-1', itemId: 'A-1', idempotencyKey: 'key-1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.accepted).toBe(true);
    expect(res.body.result.replayed).toBe(true);
    expect(res.body.result.walletTransactionId).toBe('WTX-A-1-CONSUMED');
    expect(res.body.result.newBalance).toBe(900000);
  });

  it('forwards the caller idempotency key unchanged', async () => {
    mockRpc.mockResolvedValue(ok({ success: true }));
    await request(buildApp())
      .post('/api/printing-contracts/consume')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ contractId: 'K-1', itemId: 'A-1', idempotencyKey: 'wallet:assessment:A-1:consumed' });
    const [, args] = mockRpc.mock.calls[0];
    expect(args.p_idempotency_key).toBe('wallet:assessment:A-1:consumed');
  });

  it('a null idempotency key is passed as null so the server derives its canonical key', async () => {
    mockRpc.mockResolvedValue(ok({ success: true }));
    await request(buildApp())
      .post('/api/printing-contracts/consume')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ contractId: 'K-1', itemId: 'A-1' });
    const [, args] = mockRpc.mock.calls[0];
    expect(args.p_idempotency_key).toBeNull();
  });
});
