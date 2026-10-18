/**
 * examinationPostingService.test.cjs
 *
 * Unit coverage for the authoritative posting boundary that does NOT need a
 * database: input validation, the feature gate, error classification, and the
 * idempotency contract as expressed on the wire.
 */
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';
delete process.env.EXAMINATION_AUTHORITATIVE_POSTING;

jest.mock('axios', () => {
  const instance = { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() };
  instance.create = jest.fn(() => instance);
  return instance;
});

const axios = require('axios');
const posting = require('../../services/examinationPostingService.cjs');

const enable = () => { process.env.EXAMINATION_AUTHORITATIVE_POSTING = 'true'; };
const disable = () => { delete process.env.EXAMINATION_AUTHORITATIVE_POSTING; };

const okRpc = (body) => ({ data: body });

describe('examinationPostingService — gate and validation', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    disable();
  });

  it('refuses to post while the server-authoritative boundary is disabled', async () => {
    await expect(posting.postExaminationInvoice({
      batchId: 'b1', invoiceNumber: 'EXM-001/001', idempotencyKey: 'k1',
      invoiceData: { totalAmount: 8000 }, ledgerData: { amount: 8000 },
    })).rejects.toMatchObject({ code: 'EXAM_POSTING_DISABLED', retryable: false });

    expect(axios.post).not.toHaveBeenCalled();
  });

  it('refuses to void while the boundary is disabled', async () => {
    await expect(posting.voidExaminationInvoice({
      invoiceNumber: 'EXM-001/001', idempotencyKey: 'k1',
    })).rejects.toMatchObject({ code: 'EXAM_POSTING_DISABLED' });
  });

  describe('once enabled', () => {
    beforeEach(enable);

    it('rejects a non-EXM invoice number before calling the database', async () => {
      await expect(posting.postExaminationInvoice({
        batchId: 'b1', invoiceNumber: 'INV-9', idempotencyKey: 'k1',
        invoiceData: {}, ledgerData: {},
      })).rejects.toMatchObject({ code: 'EXAM_POST_INVALID' });
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('requires an idempotency key', async () => {
      await expect(posting.postExaminationInvoice({
        batchId: 'b1', invoiceNumber: 'EXM-001/001', idempotencyKey: '',
        invoiceData: {}, ledgerData: {},
      })).rejects.toMatchObject({ code: 'EXAM_POST_INVALID' });
    });

    it('calls the posting RPC with the caller key and expected version', async () => {
      axios.post.mockResolvedValueOnce(okRpc({
        invoiceNumber: 'EXM-001/001', invoiceId: 'EXM-001/001',
        totalAmount: 8000, status: 'committed', batchVersion: 5, replayed: false,
      }));

      const result = await posting.postExaminationInvoice({
        batchId: 'b1',
        invoiceNumber: 'EXM-001/001',
        idempotencyKey: 'stable-key',
        expectedVersion: 4,
        invoiceData: { totalAmount: 8000 },
        ledgerData: { amount: 8000 },
        businessDate: '2026-03-01',
      });

      const [url, body] = axios.post.mock.calls[0];
      expect(url).toContain('/rest/v1/rpc/post_examination_invoice_atomic');
      expect(body.p_idempotency_key).toBe('stable-key');
      expect(body.p_expected_version).toBe(4);
      expect(body.p_invoice_number).toBe('EXM-001/001');
      expect(result.totalAmount).toBe(8000);
      expect(result.replayed).toBe(false);
    });

    it('reports a replayed retry as replayed rather than a fresh posting', async () => {
      axios.post.mockResolvedValueOnce(okRpc({
        invoiceNumber: 'EXM-001/001', status: 'committed', batchVersion: 5, replayed: true,
      }));

      const result = await posting.postExaminationInvoice({
        batchId: 'b1', invoiceNumber: 'EXM-001/001', idempotencyKey: 'stable-key',
        invoiceData: { totalAmount: 8000 }, ledgerData: { amount: 8000 },
      });

      expect(result.replayed).toBe(true);
    });

    it('surfaces a snapshot mismatch as a terminal, non-retryable rejection', async () => {
      axios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed'), {
        response: { status: 400, data: 'EXAM_POST_SNAPSHOT_MISMATCH: batch p1 was approved at 8000 but the invoice is 999999' },
      }));

      await expect(posting.postExaminationInvoice({
        batchId: 'p1', invoiceNumber: 'EXM-001/001', idempotencyKey: 'k1',
        invoiceData: { totalAmount: 999999 }, ledgerData: { amount: 999999 },
      })).rejects.toMatchObject({ code: 'EXAM_POST_SNAPSHOT_MISMATCH', retryable: false });
    });

    it('surfaces an already-invoiced rejection as terminal', async () => {
      axios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed'), {
        response: { status: 409, data: 'EXAM_POST_ALREADY_INVOICED: batch p1 is already invoiced as EXM-001/001' },
      }));

      await expect(posting.postExaminationInvoice({
        batchId: 'p1', invoiceNumber: 'EXM-001/002', idempotencyKey: 'k1',
        invoiceData: { totalAmount: 8000 }, ledgerData: { amount: 8000 },
      })).rejects.toMatchObject({ code: 'EXAM_POST_ALREADY_INVOICED', retryable: false });
    });

    it('treats a transport failure as retryable', async () => {
      axios.post.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

      await expect(posting.postExaminationInvoice({
        batchId: 'b1', invoiceNumber: 'EXM-001/001', idempotencyKey: 'k1',
        invoiceData: { totalAmount: 8000 }, ledgerData: { amount: 8000 },
      })).rejects.toMatchObject({ code: 'TRANSPORT', retryable: true });
    });

    it('treats an empty RPC result as a failure, never as a committed posting', async () => {
      axios.post.mockResolvedValueOnce({ data: null });

      await expect(posting.postExaminationInvoice({
        batchId: 'b1', invoiceNumber: 'EXM-001/001', idempotencyKey: 'k1',
        invoiceData: { totalAmount: 8000 }, ledgerData: { amount: 8000 },
      })).rejects.toMatchObject({ code: 'EXAM_POSTING_EMPTY_RESULT' });
    });
  });
});

describe('examinationPostingService — void', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    enable();
  });
  afterEach(disable);

  it('passes only explicitly named deductions', async () => {
    axios.post.mockResolvedValueOnce(okRpc({
      invoiceNumber: 'EXM-001/001', status: 'voided',
      ledgerEntriesReversed: 1, inventoryMovementsReversed: 0, skipped: 0,
      batchClosed: true, replayed: false,
    }));

    const result = await posting.voidExaminationInvoice({
      batchId: 'b1', invoiceNumber: 'EXM-001/001', idempotencyKey: 'v1',
      voidReason: 'Customer cancelled', performedBy: 'user-1',
    });

    const [url, body] = axios.post.mock.calls[0];
    expect(url).toContain('/rest/v1/rpc/void_examination_invoice_atomic');
    // No deduction ids supplied -> the database reverses no stock at all.
    expect(body.p_deduction_ids).toBeNull();
    expect(result.batchClosed).toBe(true);
  });

  it('forwards the supplied deduction ids', async () => {
    axios.post.mockResolvedValueOnce(okRpc({ invoiceNumber: 'EXM-001/001', status: 'voided' }));

    await posting.voidExaminationInvoice({
      invoiceNumber: 'EXM-001/001', idempotencyKey: 'v1',
      deductionIds: ['EXAM-DED-1', 'EXAM-DED-2'],
    });

    expect(axios.post.mock.calls[0][1].p_deduction_ids).toEqual(['EXAM-DED-1', 'EXAM-DED-2']);
  });

  it('refuses to void a non-EXM invoice', async () => {
    await expect(posting.voidExaminationInvoice({
      invoiceNumber: 'INV-9', idempotencyKey: 'v1',
    })).rejects.toMatchObject({ code: 'EXAM_VOID_INVALID' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('surfaces a repeated void as terminal, not as a second reversal', async () => {
    axios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed'), {
      response: { status: 400, data: 'EXAM_VOID_ALREADY_VOID: invoice EXM-001/001 is already voided' },
    }));

    await expect(posting.voidExaminationInvoice({
      invoiceNumber: 'EXM-001/001', idempotencyKey: 'v2',
    })).rejects.toMatchObject({ code: 'EXAM_VOID_ALREADY_VOID', retryable: false });
  });

  it('surfaces a paid invoice as terminal', async () => {
    axios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed'), {
      response: { status: 400, data: 'EXAM_VOID_HAS_PAYMENTS: invoice EXM-001/001 has payments against it' },
    }));

    await expect(posting.voidExaminationInvoice({
      invoiceNumber: 'EXM-001/001', idempotencyKey: 'v3',
    })).rejects.toMatchObject({ code: 'EXAM_VOID_HAS_PAYMENTS', retryable: false });
  });
});