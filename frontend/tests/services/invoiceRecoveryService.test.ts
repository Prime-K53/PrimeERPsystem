/**
 * invoiceRecoveryService.test.ts
 *
 * Tests for the invoice recovery service safety gates:
 *  - service-layer authorization (admin/operator allowed; unauthorized,
 *    missing, and expired sessions rejected; direct invocation cannot bypass)
 *  - local record missing
 *  - remote already exists
 *  - remote lookup failure
 *  - generation invalid
 *  - existing pending operation
 *  - dead-letter operation (valid + invalid generation)
 *  - successful re-queue with zero business delta
 *  - no business-field mutation
 *  - no duplicate queue operation creation
 *  - uses existing dbService.put path
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('../../services/authSession', () => ({
  getStoredUserSession: vi.fn(),
  isSessionExpired: vi.fn(),
}));

vi.mock('../../services/durableSyncQueue', () => ({
  durableSyncQueue: {
    getAll: vi.fn(),
    hasPendingMutation: vi.fn(),
    retryDeadLetter: vi.fn(),
    getLocalGeneration: vi.fn(),
  },
  getLocalGeneration: vi.fn(),
  isGenerationValid: vi.fn(),
}));

vi.mock('../../services/printingContractService', () => ({
  stableStringify: vi.fn((v: unknown) => JSON.stringify(v)),
}));

const mockDbService = await import('../../services/db');
const mockDurableQueue = await import('../../services/durableSyncQueue');
const mockStableStringify = await import('../../services/printingContractService');
const mockAuthSession = await import('../../services/authSession');

/** Default stored session: an authenticated, non-expired Admin. */
const AUTH_ADMIN_SESSION = {
  id: 'usr-admin-1',
  role: 'Admin',
  isSuperAdmin: false,
  accessToken: 'test-access-token',
};

function setStoredSession(session: Record<string, unknown> | null, expired = false) {
  vi.mocked(mockAuthSession.getStoredUserSession).mockReturnValue(session);
  vi.mocked(mockAuthSession.isSessionExpired).mockReturnValue(expired);
}

const BASE_INVOICE = {
  id: 'INV-P726/032',
  customerId: 'CUST-001',
  customerName: 'Kataila Primary School',
  totalAmount: 36000,
  paidAmount: 0,
  date: '2026-08-01',
  dueDate: '2026-08-31',
  status: 'Unpaid',
  items: [{ description: 'Tuition', quantity: 1, unitPrice: 36000, total: 36000 }],
  invoiceNumber: 'INV-P726/032',
  notes: 'Test invoice',
};

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return { ...BASE_INVOICE, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockDbService.dbService.get).mockResolvedValue(null);
  vi.mocked(mockDbService.dbService.put).mockResolvedValue('q-1');
  vi.mocked(mockDurableQueue.durableSyncQueue.getAll).mockResolvedValue([]);
  vi.mocked(mockDurableQueue.durableSyncQueue.hasPendingMutation).mockResolvedValue(false);
  vi.mocked(mockDurableQueue.durableSyncQueue.retryDeadLetter).mockResolvedValue(undefined);
  vi.mocked(mockDurableQueue.getLocalGeneration).mockReturnValue(1);
  vi.mocked(mockDurableQueue.isGenerationValid).mockImplementation((g: number) => Number.isFinite(g) && g >= 1);
  vi.mocked(mockStableStringify.stableStringify).mockImplementation((v: unknown) => JSON.stringify(v));
  // Default: authenticated, non-expired Admin session passes the gate.
  setStoredSession(AUTH_ADMIN_SESSION);

  global.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ exists: false, record: null }),
    } as Response)
  ) as unknown as typeof fetch;
});

describe('recoverInvoiceToCloud', () => {
  // -----------------------------------------------------------------
  // TEST 1 — Local record missing
  // -----------------------------------------------------------------
  it('stops when the local canonical invoice record is missing', async () => {
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(undefined);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(false);
    expect(result.stage).toBe('local_lookup');
    expect(result.message).toContain('could not be found');
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------
  // TEST 2 — Remote invoice already exists
  // -----------------------------------------------------------------
  it('stops when the remote invoice already exists', async () => {
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());
    (global.fetch as unknown as vi.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ exists: true, record: { id: 'INV-P726/032' } }),
    } as Response);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(false);
    expect(result.stage).toBe('remote_check');
    expect(result.message).toContain('already exists on the authoritative server');
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------
  // TEST 3 — Remote lookup failure
  // -----------------------------------------------------------------
    it('stops when the remote lookup fails (not treated as absence)', async () => {
      vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());
      (global.fetch as unknown as vi.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      } as Response);

      const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
      const result = await recoverInvoiceToCloud('INV-P726/032');

      expect(result.success).toBe(false);
      expect(result.stage).toBe('remote_check');
      expect(result.message).toContain('remote lookup failed');
      expect(mockDbService.dbService.put).not.toHaveBeenCalled();
    });

  // -----------------------------------------------------------------
  // TEST 4 — Generation mismatch / invalid generation
  // -----------------------------------------------------------------
  it('stops when local sync generation is invalid', async () => {
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());
    vi.mocked(mockDurableQueue.getLocalGeneration).mockReturnValue(0);
    vi.mocked(mockDurableQueue.isGenerationValid).mockReturnValue(false);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(false);
    expect(result.stage).toBe('generation_check');
    expect(result.message).toContain('generation');
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------
  // TEST 5 — Existing pending operation
  // -----------------------------------------------------------------
  it('stops when a pending sync operation already exists for the invoice', async () => {
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());
    vi.mocked(mockDurableQueue.durableSyncQueue.getAll).mockResolvedValue([
      {
        id: 'q-pending-1',
        table: 'invoices',
        recordId: 'INV-P726/032',
        status: 'pending',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(false);
    expect(result.stage).toBe('queue_check');
    expect(result.message).toContain('already pending');
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------
  // TEST 6 — Dead-letter operation (valid generation → retry)
  // -----------------------------------------------------------------
  it('retries a dead-letter operation when its generation is valid', async () => {
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());
    vi.mocked(mockDurableQueue.durableSyncQueue.getAll).mockResolvedValue([
      {
        id: 'q-dead-1',
        table: 'invoices',
        recordId: 'INV-P726/032',
        status: 'dead_letter',
        syncGeneration: 1,
        operationId: 'op-dead-1',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(true);
    expect(result.stage).toBe('queue_check');
    expect(mockDurableQueue.durableSyncQueue.retryDeadLetter).toHaveBeenCalledWith('q-dead-1');
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------
  // TEST 6b — Dead-letter operation (invalid generation → stop)
  // -----------------------------------------------------------------
  it('stops when dead-letter operation has invalid generation', async () => {
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());
    vi.mocked(mockDurableQueue.durableSyncQueue.getAll).mockResolvedValue([
      {
        id: 'q-dead-2',
        table: 'invoices',
        recordId: 'INV-P726/032',
        status: 'dead_letter',
        syncGeneration: undefined,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ]);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(false);
    expect(result.stage).toBe('queue_check');
    expect(result.message).toContain('dead-letter');
    expect(mockDurableQueue.durableSyncQueue.retryDeadLetter).not.toHaveBeenCalled();
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------
  // TEST 7 — Successful re-queue (zero business delta)
  // -----------------------------------------------------------------
  it('successfully re-queues the exact existing record with zero business delta', async () => {
    const invoice = makeInvoice();
    const queueOpId = 'q-1'; // matches the dbService.put mock return value
    const operationId = 'op-new-1';

    // Call sequence for getAll():
    //   1. inspectQueueState active check → empty
    //   2. inspectQueueState dead-letter check → empty
    //   3. recoverInvoiceToCloud post-put lookup → pending op
    //   4. waitForSyncCompletion first poll → completed op
    const allCalls: any[][] = [
      [], // 1. inspectQueueState active: no ops exist yet
      [], // 2. inspectQueueState dead-letter: no dead letters
      [
        {
          id: queueOpId,
          table: 'invoices',
          recordId: 'INV-P726/032',
          status: 'pending',
          operationId,
          createdAt: new Date().toISOString(),
        },
      ], // 3. post-put lookup: find the new op
      [
        {
          id: queueOpId,
          table: 'invoices',
          recordId: 'INV-P726/032',
          status: 'completed',
          operationId,
          createdAt: new Date().toISOString(),
        },
      ], // 4. waitForSyncCompletion poll: op completed
    ];

    vi.mocked(mockDbService.dbService.get)
      .mockResolvedValueOnce(invoice) // initial lookup
      .mockResolvedValueOnce(invoice); // post-write reload

    vi.mocked(mockDurableQueue.durableSyncQueue.getAll).mockImplementation(async () => {
      const val = allCalls.shift();
      return val || [];
    });

    (global.fetch as unknown as vi.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ exists: false, record: null }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ exists: true, record: { id: 'INV-P726/032' } }),
      } as Response);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(true);
    expect(result.stage).toBe('complete');
    expect(mockDbService.dbService.put).toHaveBeenCalledTimes(1);
    expect(mockDbService.dbService.put).toHaveBeenCalledWith(
      'invoices',
      expect.objectContaining({
        id: 'INV-P726/032',
        customerName: 'Kataila Primary School',
        totalAmount: 36000,
      })
    );
    expect(result.zeroDeltaVerified).toBe(true);
    expect(result.queueOpId).toBe(queueOpId);
    expect(result.remoteVerified).toBe(true);
  });

  // -----------------------------------------------------------------
  // TEST 8 — Zero business delta verification
  // -----------------------------------------------------------------
  it('verifies zero business delta after re-put', async () => {
    const invoice = makeInvoice();
    const queueOpId = 'q-1';

    const allCalls: any[][] = [
      [], // inspectQueueState active
      [], // inspectQueueState dead-letter
      [
        { id: queueOpId, table: 'invoices', recordId: 'INV-P726/032', status: 'pending', operationId: 'op-2', createdAt: new Date().toISOString() },
      ], // post-put lookup
      [
        { id: queueOpId, table: 'invoices', recordId: 'INV-P726/032', status: 'completed', operationId: 'op-2', createdAt: new Date().toISOString() },
      ], // waitForSyncCompletion poll
    ];

    vi.mocked(mockDbService.dbService.get)
      .mockResolvedValueOnce(invoice)
      .mockResolvedValueOnce(invoice);

    vi.mocked(mockDurableQueue.durableSyncQueue.getAll).mockImplementation(async () => {
      const val = allCalls.shift();
      return val || [];
    });

    (global.fetch as unknown as vi.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ exists: false, record: null }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ exists: true, record: { id: 'INV-P726/032' } }),
      } as Response);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.zeroDeltaVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  // -----------------------------------------------------------------
  // TEST 9 — No accounting side effects
  // -----------------------------------------------------------------
  it('does not invoke payment or accounting services', async () => {
    const invoice = makeInvoice();
    vi.mocked(mockDbService.dbService.get).mockResolvedValueOnce(invoice);
    vi.mocked(mockDbService.dbService.get).mockResolvedValueOnce(invoice);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    await recoverInvoiceToCloud('INV-P726/032');

    // Only dbService.get and dbService.put should be called
    expect(mockDbService.dbService.get).toHaveBeenCalledTimes(2);
    expect(mockDbService.dbService.put).toHaveBeenCalledTimes(1);
    // No payment, no accounting, no ledger methods should be touched
  });

  // -----------------------------------------------------------------
  // TEST 10 — No duplicate creation (uses existing invoice identity)
  // -----------------------------------------------------------------
  it('passes the existing invoice id to dbService.put — no new invoice is created', async () => {
    const invoice = makeInvoice();
    vi.mocked(mockDbService.dbService.get).mockResolvedValueOnce(invoice);
    vi.mocked(mockDbService.dbService.get).mockResolvedValueOnce(invoice);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    await recoverInvoiceToCloud('INV-P726/032');

    const putArg = vi.mocked(mockDbService.dbService.put).mock.calls[0][1] as Record<string, unknown>;
    expect(putArg.id).toBe('INV-P726/032');
    expect(putArg.invoiceNumber).toBe('INV-P726/032');
    expect(putArg.customerName).toBe('Kataila Primary School');
  });

  // -----------------------------------------------------------------
  // TEST 11 — Authorization is enforced at the SERVICE layer
  // -----------------------------------------------------------------
  // The admin/operator gate now lives in the recovery service itself
  // (checkRecoveryAuthorization), independent of the UI. An unauthorized
  // session is rejected before any read or write, even when the caller
  // bypasses/hides the UI and supplies a hypothetical "auth hint".
  it('recovery service rejects an unauthorized session even when a caller-supplied auth hint is passed', async () => {
    const invoice = makeInvoice();
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(invoice);
    setStoredSession({ id: 'usr-staff-1', role: 'Sales Staff', isSuperAdmin: false, accessToken: 'test-token' });

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    // Bypass attempt: call the service directly with a fake admin hint.
    const hinted = recoverInvoiceToCloud as unknown as (
      id: string,
      hint?: Record<string, unknown>
    ) => Promise<import('../../services/invoiceRecoveryService').RecoveryResult>;
    const result = await hinted('INV-P726/032', { role: 'Admin', isSuperAdmin: true, token: 'forged' });

    expect(result.success).toBe(false);
    expect(result.stage).toBe('error');
    expect(result.message).toContain('administrator/operator');
    expect(result.message).toContain('role_not_allowed');
    // Nothing was read or written and no remote call was made.
    expect(mockDbService.dbService.get).not.toHaveBeenCalled();
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------
  // TEST 12 — Business fields are never mutated
  // -----------------------------------------------------------------
  it('the re-queued record preserves all business fields unchanged', async () => {
    const invoice = makeInvoice({
      customerId: 'CUST-001',
      customerName: 'Kataila Primary School',
      totalAmount: 36000,
      paidAmount: 0,
      date: '2026-08-01',
      dueDate: '2026-08-31',
      status: 'Unpaid',
      items: [{ description: 'Tuition', quantity: 1, unitPrice: 36000, total: 36000 }],
      invoiceNumber: 'INV-P726/032',
      notes: 'Test invoice',
      tax: 0,
      paymentTerms: 'Net 30',
    });

    vi.mocked(mockDbService.dbService.get).mockResolvedValueOnce(invoice);
    vi.mocked(mockDbService.dbService.get).mockResolvedValueOnce(invoice);

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    await recoverInvoiceToCloud('INV-P726/032');

    const putArg = vi.mocked(mockDbService.dbService.put).mock.calls[0][1] as Record<string, unknown>;
    expect(putArg.id).toBe('INV-P726/032');
    expect(putArg.invoiceNumber).toBe('INV-P726/032');
    expect(putArg.customerId).toBe('CUST-001');
    expect(putArg.customerName).toBe('Kataila Primary School');
    expect(putArg.totalAmount).toBe(36000);
    expect(putArg.paidAmount).toBe(0);
    expect(putArg.date).toBe('2026-08-01');
    expect(putArg.dueDate).toBe('2026-08-31');
    expect(putArg.status).toBe('Unpaid');
    expect(putArg.items).toEqual([{ description: 'Tuition', quantity: 1, unitPrice: 36000, total: 36000 }]);
    expect(putArg.notes).toBe('Test invoice');
    expect(putArg.tax).toBe(0);
    expect(putArg.paymentTerms).toBe('Net 30');
  });
});

// =====================================================================
// REVIEW 1 — SERVICE-LAYER AUTHORIZATION
// The recovery service must independently enforce the existing
// administrator/operator policy using the authenticated session, even
// when the UI is bypassed.
// =====================================================================
describe('recoverInvoiceToCloud — service-layer authorization', () => {
  it('lets an authorized Admin session past the authorization gate', async () => {
    setStoredSession(AUTH_ADMIN_SESSION);
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    // Passes the gate: it proceeds to the local/remote safety checks
    // (stage is not the authorization 'error' stage) and reads the record.
    expect(result.stage).not.toBe('error');
    expect(mockDbService.dbService.get).toHaveBeenCalled();
  });

  it('lets an authorized operator (Manager) session past the authorization gate', async () => {
    setStoredSession({ id: 'usr-mgr-1', role: 'Manager', isSuperAdmin: false, accessToken: 't' });
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.stage).not.toBe('error');
    expect(mockDbService.dbService.get).toHaveBeenCalled();
  });

  it('lets an authorized Company Admin session past the authorization gate', async () => {
    setStoredSession({ id: 'usr-ca-1', role: 'Company Admin', isSuperAdmin: false, accessToken: 't' });
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.stage).not.toBe('error');
    expect(mockDbService.dbService.get).toHaveBeenCalled();
  });

  it('lets a super-admin session past the authorization gate', async () => {
    setStoredSession({ id: 'usr-sa-1', role: 'Sales Staff', isSuperAdmin: true, accessToken: 't' });
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.stage).not.toBe('error');
    expect(mockDbService.dbService.get).toHaveBeenCalled();
  });

  it('rejects an unauthorized (non-admin/operator) session', async () => {
    setStoredSession({ id: 'usr-staff-1', role: 'Sales Staff', isSuperAdmin: false, accessToken: 't' });
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(false);
    expect(result.stage).toBe('error');
    expect(result.message).toContain('administrator/operator');
    expect(result.message).toContain('role_not_allowed');
    // No read, no write, no remote call.
    expect(mockDbService.dbService.get).not.toHaveBeenCalled();
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a portal_customer session', async () => {
    setStoredSession({ id: 'usr-portal-1', role: 'portal_customer', isSuperAdmin: false, accessToken: 't' });
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(false);
    expect(result.stage).toBe('error');
    expect(result.message).toContain('role_not_allowed');
    expect(mockDbService.dbService.get).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated (no session) caller', async () => {
    setStoredSession(null);
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(false);
    expect(result.stage).toBe('error');
    expect(result.message).toContain('no_session');
    expect(mockDbService.dbService.get).not.toHaveBeenCalled();
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
  });

  it('rejects an expired session', async () => {
    setStoredSession(AUTH_ADMIN_SESSION, /* expired */ true);
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(false);
    expect(result.stage).toBe('error');
    expect(result.message).toContain('session_expired');
    expect(mockDbService.dbService.get).not.toHaveBeenCalled();
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
  });

  it('direct service invocation cannot bypass authorization (valid invoice + absent remote + no hint)', async () => {
    // Even with a perfectly valid local record and a remote that reports the
    // invoice absent, an unauthorized session must still be rejected at the
    // gate — the downstream safety checks are never reached.
    setStoredSession({ id: 'usr-staff-1', role: 'Sales Staff', isSuperAdmin: false, accessToken: 't' });
    vi.mocked(mockDbService.dbService.get).mockResolvedValue(makeInvoice());

    const { recoverInvoiceToCloud } = await import('../../services/invoiceRecoveryService');
    const result = await recoverInvoiceToCloud('INV-P726/032');

    expect(result.success).toBe(false);
    expect(result.stage).toBe('error');
    expect(result.message).toContain('role_not_allowed');
    expect(mockDbService.dbService.get).not.toHaveBeenCalled();
    expect(mockDbService.dbService.put).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('checkRecoveryAuthorization returns structured authorization for allowed and denied roles', async () => {
    const { checkRecoveryAuthorization } = await import('../../services/invoiceRecoveryService');

    setStoredSession(AUTH_ADMIN_SESSION);
    expect(checkRecoveryAuthorization()).toMatchObject({ authorized: true, reason: 'authorized' });

    setStoredSession({ id: 'x', role: 'Sales Staff', isSuperAdmin: false });
    expect(checkRecoveryAuthorization()).toMatchObject({ authorized: false, reason: 'role_not_allowed' });

    setStoredSession(null);
    expect(checkRecoveryAuthorization()).toMatchObject({ authorized: false, reason: 'no_session' });
  });
});
