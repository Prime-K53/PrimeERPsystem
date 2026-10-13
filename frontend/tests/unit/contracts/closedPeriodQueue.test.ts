/**
 * closedPeriodQueue.test.ts — §4 operator queue safety.
 * Read-only first: never rewrites dates, never posts adjustments,
 * never re-queues while the period is still closed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const deadLetters: any[] = [];
let closedPeriods: any[] = [];

vi.mock('../../../services/durableSyncQueue', () => ({
  durableSyncQueue: {
    getAll: async (status?: string) =>
      status ? deadLetters.filter((o) => o.status === status) : [...deadLetters],
    retryDeadLetter: async (id: string) => {
      const op = deadLetters.find((o) => o.id === id);
      if (op) op.status = 'pending';
      retryDeadLetterSpy(id);
    },
  },
}));

vi.mock('../../../utils/financialPeriodClosure', () => ({
  loadClosedPeriods: async () => closedPeriods,
  isFinancialPeriodClosed: async (dateIso?: string) => {
    const d = String(dateIso || '').slice(0, 10);
    if (!d) return null;
    return (
      closedPeriods.find(
        (p: any) =>
          (!String(p.from || '').slice(0, 10) || d >= String(p.from).slice(0, 10)) &&
          (!String(p.to || '').slice(0, 10) || d <= String(p.to).slice(0, 10)),
      ) || null
    );
  },
}));

import { adjustmentQueueService } from '../../../services/closedPeriodQueue';

// Declared with hoisted-safe indirection: vi.mock factories are hoisted above
// module-level const declarations.
const retryDeadLetterSpy = vi.fn();
const retryDeadLetter = retryDeadLetterSpy;

const op = (over: any = {}) => ({
  id: 'q-1', operationId: 'op-1', table: 'wallet_transactions', recordId: 'WTX-A-1-CONSUMED',
  operation: 'upsert', status: 'dead_letter',
  payload: { business_date: '2026-03-15', contract_id: 'PC-1', contract_number: 'PC-0001', amount: 100 },
  createdAt: '2026-03-15T10:00:00.000Z', lastAttempt: '2026-03-16T09:00:00.000Z', retryCount: 1,
  lastError: 'wallet_transactions: business date 2026-03-15 falls in a closed financial year — rejected, requires authorized adjustment workflow',
  ...over,
});

beforeEach(() => {
  deadLetters.length = 0;
  closedPeriods = [];
  retryDeadLetter.mockClear();
});

describe('surfaces closed-period rejections read-only (§4)', () => {
  it('lists a rejected contract financial op with date, contract and reason', async () => {
    deadLetters.push(op());
    const q = await adjustmentQueueService.listAdjustmentQueue();
    expect(q).toHaveLength(1);
    expect(q[0].businessDate).toBe('2026-03-15');
    expect(q[0].contractId).toBe('PC-1');
    expect(q[0].contractNumber).toBe('PC-0001');
    expect(q[0].reason).toBe('closed-period');
    expect(q[0].retryEligible).toBe(true); // no periods registered yet
    expect(q[0].requiresFinancialAdjustment).toBe(true);
  });

  it('ignores unrelated tables', async () => {
    deadLetters.push(op({ table: 'products' }));
    expect(await adjustmentQueueService.listAdjustmentQueue()).toHaveLength(0);
  });

  it('blocks retry and explains why while the period is closed', async () => {
    closedPeriods = [{ id: 'FP-1', from: '2026-03-01', to: '2026-03-31', reason: 'March close', closedAt: 'x', closedBy: 'admin' }];
    deadLetters.push(op());
    const [e] = await adjustmentQueueService.listAdjustmentQueue();
    expect(e.retryEligible).toBe(false);
    expect(e.retryBlockedBecause).toMatch(/still inside closed period/i);
  });

  it('never re-queues a still-closed operation', async () => {
    closedPeriods = [{ id: 'FP-1', from: '2026-03-01', to: '2026-03-31', closedAt: 'x', closedBy: 'admin' }];
    deadLetters.push(op());
    const [e] = await adjustmentQueueService.listAdjustmentQueue();
    const res = await adjustmentQueueService.retryAdjustmentEntry(e.queueId);
    expect(res.retried).toBe(false);
    expect(res.reason).toMatch(/still inside closed period/i);
    expect(retryDeadLetter).not.toHaveBeenCalled();
  });

  it('re-queues unchanged once the period is open, preserving the business date', async () => {
    deadLetters.push(op());
    const [e] = await adjustmentQueueService.listAdjustmentQueue();
    const res = await adjustmentQueueService.retryAdjustmentEntry(e.queueId);
    expect(res.retried).toBe(true);
    expect(retryDeadLetter).toHaveBeenCalledWith('q-1');
    // Payload (incl. business_date) untouched by the retry path.
    expect(deadLetters[0].payload.business_date).toBe('2026-03-15');
  });

  it('refuses to synthesize a missing business date', async () => {
    deadLetters.push(op({
      payload: { contract_id: 'PC-2', contract_number: 'PC-0002' },
      lastError: 'wallet_transactions: contract financial op requires an original business transaction date — sync timestamp must not be substituted',
    }));
    const [e] = await adjustmentQueueService.listAdjustmentQueue();
    expect(e.businessDate).toBeNull();
    expect(e.retryEligible).toBe(false);
    expect(e.reason).toBe('closed-period-missing-business-date');
    const res = await adjustmentQueueService.retryAdjustmentEntry(e.queueId);
    expect(res.retried).toBe(false);
    expect(res.reason).toMatch(/no original business transaction date/i);
    expect(retryDeadLetter).not.toHaveBeenCalled();
  });

  it('reports a missing queue entry instead of throwing', async () => {
    const res = await adjustmentQueueService.retryAdjustmentEntry('nope');
    expect(res.retried).toBe(false);
    expect(res.reason).toMatch(/no longer exists/i);
  });
});